/**
 * project-id.ts — Stable project identity resolver.
 *
 * What this file is: a single-responsibility utility that returns a stable
 *   UUID for any project directory, regardless of renames or moves.
 * Responsible for: reading .ecc-id from the project root, falling back to the
 *   git root commit hash, and finally generating a fresh UUIDv4. Always writes
 *   the resolved ID back to .ecc-id so future calls are O(1) file reads.
 * Depends on: node:crypto, node:fs, node:path, node:child_process.
 * Depended on by: src/hooks/stop.ts, src/mcp/server.ts, src/memory/working.ts,
 *   src/memory/graph.ts.
 *
 * Identity resolution order:
 *   1. .ecc-id in project root  — portable, travels with folder/git clone
 *   2. git root commit hash     — zero-config for git projects, same across clones
 *   3. Fresh UUIDv4             — fallback for non-git projects
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { execSync } from "node:child_process";

export interface ECCProjectConfig {
  sharedModelsDir?: string;
}

export function getRuntimeProjectDir(fallback = process.cwd()): string {
  return process.env.ENGRAM_PROJECT_DIR
    || process.env.CLAUDE_PROJECT_DIR
    || fallback;
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Returns true if the string is a valid UUID v4 or a UUID-formatted git hash.
 * Both are 8-4-4-4-12 hex patterns.
 *
 * @param s - String to test.
 */
function isValidId(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ── Git fallback ────────────────────────────────────────────────────────────

/**
 * Attempt to derive a stable UUID from the git root commit hash.
 * The root commit is content-addressed and identical across all clones.
 * Returns null if not in a git repo or git is unavailable.
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns UUID-formatted string derived from root commit, or null.
 */
function getGitRootId(projectDir: string): string | null {
  try {
    const hash = execSync("git rev-list --max-parents=0 HEAD", {
      cwd: projectDir,
      timeout: 3000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!hash || hash.length < 32) return null;

    // Format the 40-char git hash as a UUID (8-4-4-4-12) using first 32 hex chars
    const h = hash.slice(0, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  } catch {
    return null;
  }
}

// ── Main export ─────────────────────────────────────────────────────────────

/**
 * Return the stable project UUID for a given directory.
 *
 * Resolution order:
 *   1. .ecc-id file in project root (fast path — O(1) read)
 *   2. git root commit hash (zero-config for git repos)
 *   3. Fresh UUIDv4 (non-git fallback)
 *
 * Always writes the resolved ID to .ecc-id on first resolution so subsequent
 * calls use the fast path. Silently swallows write failures (read-only FS,
 * permission errors) — the ID is still returned, just not persisted.
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns UUID string (8-4-4-4-12 hex format).
 */
export function getProjectId(projectDir: string): string {
  const idFile = join(projectDir, ".ecc-id");

  // ── Fast path: .ecc-id already exists ──
  if (existsSync(idFile)) {
    try {
      const stored = readFileSync(idFile, "utf-8").trim();
      if (isValidId(stored)) return stored;
      // File exists but content is invalid — fall through to regenerate
    } catch { /* read error — fall through */ }
  }

  // ── Fallback 1: git root commit hash ──
  const gitId = getGitRootId(projectDir);
  if (gitId) {
    try { writeFileSync(idFile, gitId, "utf-8"); } catch { /* non-fatal */ }
    return gitId;
  }

  // ── Fallback 2: fresh UUIDv4 ──
  const freshId = randomUUID();
  try { writeFileSync(idFile, freshId, "utf-8"); } catch { /* non-fatal */ }
  return freshId;
}

// ── DB path helper ──────────────────────────────────────────────────────────

/**
 * Return the project-local EngramCC data directory.
 *
 * Path: <projectDir>/.engram-cc
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns Absolute path to the project's EngramCC data directory.
 */
export function getProjectDataDir(projectDir: string): string {
  const dir = join(projectDir, ".engram-cc");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getProjectConfigPath(projectDir: string): string {
  return join(getProjectDataDir(projectDir), "config.json");
}

export function readProjectConfig(projectDir: string): ECCProjectConfig {
  const path = getProjectConfigPath(projectDir);
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ECCProjectConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function writeProjectConfig(projectDir: string, config: ECCProjectConfig): void {
  const path = getProjectConfigPath(projectDir);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function resolveSharedModelsDir(projectDir: string): string | null {
  const configured = readProjectConfig(projectDir).sharedModelsDir?.trim();
  if (!configured) return null;
  return isAbsolute(configured) ? configured : resolve(projectDir, configured);
}

/**
 * Return the project-local sessions directory.
 *
 * Path: <projectDir>/.engram-cc/sessions
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns Absolute path to the project's session artifacts directory.
 */
export function getProjectSessionsDir(projectDir: string): string {
  const dir = join(getProjectDataDir(projectDir), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Return the configured models directory for this project.
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns Absolute path to the project's shared model directory.
 */
export function getProjectModelsDir(projectDir: string): string {
  const dir = resolveSharedModelsDir(projectDir);
  if (!dir) {
    throw new Error(
      `Shared models directory is not configured for ${projectDir}. Run engramcc --project-dir "${projectDir}" --models-dir <path>.`,
    );
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Return the project-local logs directory.
 *
 * Path: <projectDir>/.engram-cc/logs
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns Absolute path to the project's log directory.
 */
export function getProjectLogsDir(projectDir: string): string {
  const dir = join(getProjectDataDir(projectDir), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Return the per-project SQLite DB path using the stable project UUID.
 * This replaces all SHA256(projectDir)-based path derivations.
 *
 * Path: <projectDir>/.engram-cc/sessions/<uuid>.db
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns Absolute path to the project's SQLite DB file.
 */
export function getProjectDBPath(projectDir: string): string {
  const id  = getProjectId(projectDir);
  const dir = getProjectSessionsDir(projectDir);
  return join(dir, `${id}.db`);
}
