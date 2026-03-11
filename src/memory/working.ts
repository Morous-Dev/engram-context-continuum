/**
 * working.ts — YAML working memory ledger for persistent cross-session context.
 *
 * Responsible for: reading and writing the working memory YAML file that
 * persists user preferences, codebase conventions, and long-term decisions
 * across sessions. This is the "long-term memory" layer — updated by the
 * Stop hook at the end of every session.
 *
 * Depends on: js-yaml, node:fs, node:path, node:os, node:crypto.
 * Depended on by: src/hooks/stop.ts, src/hooks/sessionstart.mjs (via dynamic import).
 */

import yaml from "js-yaml";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { getProjectId } from "../project-id.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Persistent cross-session working memory. Updated on Stop, read on SessionStart. */
export interface WorkingMemory {
  /** ISO-8601 timestamp of last update. */
  last_updated: string;
  /** Stable project UUID from .ecc-id — survives folder renames and moves. */
  project_hash: string;
  /** Absolute path to the project directory. */
  project_dir: string;
  /** User preferences observed over sessions (tools, OS, coding style). */
  user_preferences: string;
  /** Codebase conventions observed (module system, naming, patterns). */
  codebase_conventions: string;
  /** Decisions that have persisted across multiple sessions. */
  persistent_decisions: string[];
  /** File names that have been modified most frequently across sessions. */
  frequently_modified_files: string[];
  /** Most recent session ID — for linking handoff to working memory. */
  last_session_id: string;
}

/** Session data used to update working memory after a session ends. */
export interface SessionUpdateData {
  sessionId: string;
  projectDir: string;
  decisions: string[];
  filesModified: string[];
  userPreferences?: string;
  codebaseConventions?: string;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Get the working memory file path for a given project directory.
 * Path: [projectDir]/.claude/super-context/working.yaml
 * Creates the directory if it doesn't exist.
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns Absolute path to the working memory YAML file.
 */
export function getWorkingMemoryPath(projectDir: string): string {
  const dir = join(projectDir, ".engram-cc");
  mkdirSync(dir, { recursive: true });
  return join(dir, "working.yaml");
}

// ── Read / Write ──────────────────────────────────────────────────────────────

/**
 * Read the working memory YAML for a project.
 * Returns null if the file doesn't exist or cannot be parsed.
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns Parsed WorkingMemory or null if not found / invalid.
 */
export function readWorkingMemory(projectDir: string): WorkingMemory | null {
  const path = getWorkingMemoryPath(projectDir);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = yaml.load(raw) as Partial<WorkingMemory>;
    // Validate the parsed object has required fields
    if (typeof parsed?.project_dir !== "string") return null;
    return parsed as WorkingMemory;
  } catch {
    // Corrupted YAML — treat as empty
    return null;
  }
}

/**
 * Write the working memory YAML for a project.
 * Creates the directory if needed.
 *
 * @param projectDir - Absolute path to the project directory.
 * @param memory     - Working memory object to persist.
 */
export function writeWorkingMemory(projectDir: string, memory: WorkingMemory): void {
  const path = getWorkingMemoryPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml.dump(memory, { lineWidth: 120 }), "utf-8");
}

// ── Merge / Update ────────────────────────────────────────────────────────────

/**
 * Create a default empty working memory record for a project.
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns Default WorkingMemory record.
 */
export function createDefaultWorkingMemory(projectDir: string): WorkingMemory {
  return {
    last_updated: new Date().toISOString(),
    project_hash: getProjectId(projectDir),
    project_dir: projectDir,
    user_preferences: "",
    codebase_conventions: "",
    persistent_decisions: [],
    frequently_modified_files: [],
    last_session_id: "",
  };
}

/**
 * Merge session data into the existing working memory.
 *
 * Strategy:
 * - Decisions: merge, dedup, keep most recent 20
 * - Files modified: merge, count, keep top 20 by frequency
 * - user_preferences / codebase_conventions: prefer non-empty update
 *
 * @param existing - Current working memory (or null for first session).
 * @param update   - Session data from the just-ended session.
 * @returns Updated WorkingMemory ready to be written.
 */
export function mergeWorkingMemory(
  existing: WorkingMemory | null,
  update: SessionUpdateData,
): WorkingMemory {
  const base = existing ?? createDefaultWorkingMemory(update.projectDir);

  // Merge decisions — dedup, keep most recent 20
  const allDecisions = [...new Set([...base.persistent_decisions, ...update.decisions])];
  const mergedDecisions = allDecisions.slice(-20);

  // Merge frequently modified files — count occurrences, keep top 20
  const fileCounts: Record<string, number> = {};
  for (const f of base.frequently_modified_files) fileCounts[f] = (fileCounts[f] ?? 0) + 1;
  for (const f of update.filesModified) fileCounts[f] = (fileCounts[f] ?? 0) + 2; // Weight current session higher
  const topFiles = Object.entries(fileCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([f]) => f);

  return {
    ...base,
    last_updated: new Date().toISOString(),
    last_session_id: update.sessionId,
    persistent_decisions: mergedDecisions,
    frequently_modified_files: topFiles,
    // Only update preferences/conventions if the caller provided non-empty values
    user_preferences: update.userPreferences || base.user_preferences,
    codebase_conventions: update.codebaseConventions || base.codebase_conventions,
  };
}

/**
 * Format working memory as an XML context block for injection into sessionstart.
 *
 * @param memory - Working memory to format.
 * @returns XML string for injection into additionalContext.
 */
export function formatWorkingMemoryForContext(memory: WorkingMemory): string {
  const lines: string[] = [];
  lines.push(`<working_memory project="${memory.project_dir}" updated="${memory.last_updated}">`);

  if (memory.user_preferences) {
    lines.push(`  <user_preferences>${memory.user_preferences}</user_preferences>`);
  }

  if (memory.codebase_conventions) {
    lines.push(`  <codebase_conventions>${memory.codebase_conventions}</codebase_conventions>`);
  }

  if (memory.persistent_decisions.length > 0) {
    lines.push("  <persistent_decisions>");
    for (const d of memory.persistent_decisions.slice(-10)) {
      lines.push(`    - ${d}`);
    }
    lines.push("  </persistent_decisions>");
  }

  if (memory.frequently_modified_files.length > 0) {
    lines.push("  <frequent_files>");
    lines.push(`    ${memory.frequently_modified_files.slice(0, 10).join(", ")}`);
    lines.push("  </frequent_files>");
  }

  lines.push("</working_memory>");
  return lines.join("\n");
}
