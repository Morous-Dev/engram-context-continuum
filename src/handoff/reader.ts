/**
 * reader.ts — YAML session handoff reader with time-window guard.
 *
 * Responsible for: loading the handoff YAML for a project, enforcing a
 * maximum-age guard (default 15 minutes) to prevent stale handoffs from
 * being injected, and formatting the handoff data as an XML context block
 * for injection into Claude's context via the SessionStart hook.
 *
 * Depends on: js-yaml, node:fs, node:path, node:crypto,
 *             src/handoff/writer.ts (HandoffData, getHandoffPath).
 * Depended on by: src/hooks/sessionstart.mjs (via dynamic import).
 */

import yaml from "js-yaml";
import { readFileSync, existsSync } from "node:fs";
import type { HandoffData } from "./writer.js";
import { getHandoffPath } from "./writer.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default maximum age of a handoff before it's considered stale (milliseconds). */
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Load the handoff YAML for a project.
 *
 * Returns null if:
 * - The handoff file doesn't exist (first session, no prior Stop hook)
 * - The handoff is older than maxAgeMs (stale — user started a genuinely new session)
 * - The YAML is corrupted or cannot be parsed
 *
 * The 15-minute time window prevents loading a handoff from a session that
 * ended hours or days ago. The user would not expect a stale handoff injection.
 *
 * @param projectDir - Absolute path to the project directory.
 * @param maxAgeMs   - Maximum handoff age in milliseconds (default 15 min).
 * @returns Parsed HandoffData or null if not available / stale.
 */
export function readHandoff(projectDir: string, maxAgeMs = DEFAULT_MAX_AGE_MS): HandoffData | null {
  const handoffPath = getHandoffPath(projectDir);
  if (!existsSync(handoffPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(handoffPath, "utf-8");
  } catch {
    return null;
  }

  let data: Partial<HandoffData>;
  try {
    data = yaml.load(raw) as Partial<HandoffData>;
  } catch {
    // Corrupted YAML — treat as no handoff
    return null;
  }

  // Validate required fields
  if (typeof data?.session_id !== "string" || typeof data?.timestamp !== "string") return null;

  // Time-window guard: reject handoffs older than maxAgeMs
  const handoffAge = Date.now() - new Date(data.timestamp).getTime();
  if (handoffAge > maxAgeMs) return null;

  return data as HandoffData;
}

// ── Format for context injection ──────────────────────────────────────────────

/**
 * Format a HandoffData object as an XML context block for injection into
 * Claude's context via the SessionStart hook.
 *
 * Only includes non-empty sections to minimize token usage.
 * Critical sections (current_task, next_steps, decisions, files_modified) are
 * always included if non-empty. Low-priority sections (preferences, conventions)
 * are included only if present.
 *
 * @param handoff - Parsed handoff data.
 * @returns XML string suitable for inclusion in SessionStart additionalContext.
 */
export function formatHandoffForContext(handoff: HandoffData): string {
  const lines: string[] = [];
  lines.push(`<previous_session_handoff session="${handoff.session_id}" timestamp="${handoff.timestamp}" confidence="${handoff.confidence}">`);

  if (handoff.current_task) {
    lines.push("  <current_task>");
    lines.push(`    ${handoff.current_task}`);
    lines.push("  </current_task>");
  }

  if (handoff.last_action) {
    lines.push(`  <last_action>${handoff.last_action}</last_action>`);
  }

  if (handoff.next_steps.length > 0) {
    lines.push("  <next_steps>");
    for (const step of handoff.next_steps) lines.push(`    - ${step}`);
    lines.push("  </next_steps>");
  }

  if (handoff.decisions.length > 0) {
    lines.push("  <decisions>");
    for (const d of handoff.decisions) lines.push(`    - ${d}`);
    lines.push("  </decisions>");
  }

  if (handoff.files_modified.length > 0) {
    lines.push("  <files_modified>");
    lines.push(`    ${handoff.files_modified.join(", ")}`);
    lines.push("  </files_modified>");
  }

  if (handoff.errors_encountered.length > 0) {
    lines.push("  <errors_encountered>");
    for (const e of handoff.errors_encountered) lines.push(`    - ${e}`);
    lines.push("  </errors_encountered>");
  }

  if (handoff.blockers.length > 0) {
    lines.push("  <blockers>");
    for (const b of handoff.blockers) lines.push(`    - ${b}`);
    lines.push("  </blockers>");
  }

  if (handoff.open_questions.length > 0) {
    lines.push("  <open_questions>");
    for (const q of handoff.open_questions) lines.push(`    - ${q}`);
    lines.push("  </open_questions>");
  }

  if (handoff.working_context) {
    lines.push(`  <working_context>${handoff.working_context}</working_context>`);
  }

  if (handoff.user_preferences) {
    lines.push(`  <user_preferences>${handoff.user_preferences}</user_preferences>`);
  }

  if (handoff.codebase_conventions) {
    lines.push(`  <codebase_conventions>${handoff.codebase_conventions}</codebase_conventions>`);
  }

  lines.push("</previous_session_handoff>");
  return lines.join("\n");
}
