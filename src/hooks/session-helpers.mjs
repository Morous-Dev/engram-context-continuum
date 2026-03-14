/**
 * session-helpers.mjs — Shared session path and ID resolution utilities.
 *
 * Responsible for: deriving session IDs from hook inputs, computing per-project
 * SQLite DB paths, session events file paths, cleanup flag paths, handoff YAML
 * paths, and working memory YAML paths. All ECC artifacts stay inside the
 * current project under .engram-cc/.
 *
 * Depends on: node:crypto (SHA256 hashing), node:path, node:fs, node:os.
 * Depended on by: all .mjs hooks in this directory.
 *
 * Adapted from: context-mode/hooks/session-helpers.mjs (Elastic-2.0).
 * Changes: replaced "context-mode" dir with "engram-cc"; added
 * getHandoffPath() and getWorkingMemoryPath() helpers.
 */

import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

// ── Project identity ──────────────────────────────────────────────────────────

/**
 * Return the stable project UUID for a directory.
 * Resolution order:
 *   1. .ecc-id file in project root
 *   2. git root commit hash (formatted as UUID)
 *   3. Fresh UUIDv4
 * Always writes back to .ecc-id so subsequent calls are a simple file read.
 *
 * Mirrors src/project-id.ts — kept in sync manually (mjs hooks cannot import
 * compiled TypeScript directly without a build step).
 *
 * @param {string} projectDir - Absolute path to the project directory.
 * @returns {string} UUID string.
 */
export function getProjectId(projectDir) {
  const idFile = join(projectDir, ".ecc-id");

  // Fast path: .ecc-id already exists
  if (existsSync(idFile)) {
    try {
      const stored = readFileSync(idFile, "utf-8").trim();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored)) {
        return stored;
      }
    } catch { /* fall through */ }
  }

  // Fallback 1: git root commit hash
  try {
    const hash = execSync("git rev-list --max-parents=0 HEAD", {
      cwd: projectDir, timeout: 3000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (hash && hash.length >= 32) {
      const h = hash.slice(0, 32);
      const gitId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      try { writeFileSync(idFile, gitId, "utf-8"); } catch { /* non-fatal */ }
      return gitId;
    }
  } catch { /* not a git repo */ }

  // Fallback 2: fresh UUID
  const freshId = randomUUID();
  try { writeFileSync(idFile, freshId, "utf-8"); } catch { /* non-fatal */ }
  return freshId;
}

export function getProjectDataDir(opts = CLAUDE_OPTS) {
  const dir = join(getProjectDir(opts), ".engram-cc");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getProjectSessionsDir(opts = CLAUDE_OPTS) {
  const dir = join(getProjectDataDir(opts), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getProjectLogsDir(opts = CLAUDE_OPTS) {
  const dir = join(getProjectDataDir(opts), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Platform options ──────────────────────────────────────────────────────────

/** Claude Code platform defaults. */
const CLAUDE_OPTS = {
  configDir: ".claude",
  projectDirEnv: "CLAUDE_PROJECT_DIR",
  sessionIdEnv: "CLAUDE_SESSION_ID",
};

// ── stdin helper ──────────────────────────────────────────────────────────────

/**
 * Read all of stdin as a string (event-based, cross-platform safe).
 *
 * @returns Promise resolving to the full stdin content as a UTF-8 string.
 */
export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

// ── Project directory ─────────────────────────────────────────────────────────

/**
 * Get the project directory for the current session.
 * Uses the platform-specific env var, falls back to cwd.
 *
 * @param opts - Platform options (defaults to Claude Code).
 * @returns Absolute path to the project directory.
 */
export function getProjectDir(opts = CLAUDE_OPTS) {
  return process.env[opts.projectDirEnv] || process.cwd();
}

// ── Session ID ────────────────────────────────────────────────────────────────

/**
 * Derive session ID from hook input.
 * Priority: transcript_path UUID > sessionId (camelCase) > session_id >
 *           env var > ppid fallback.
 *
 * @param input - Raw hook input object from stdin.
 * @param opts  - Platform options.
 * @returns Session ID string.
 */
export function getSessionId(input, opts = CLAUDE_OPTS) {
  if (input.transcript_path) {
    const match = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (match) return match[1];
  }
  if (input.sessionId) return input.sessionId;
  if (input.session_id) return input.session_id;
  if (opts.sessionIdEnv && process.env[opts.sessionIdEnv]) return process.env[opts.sessionIdEnv];
  return `pid-${process.ppid}`;
}

// ── DB path ───────────────────────────────────────────────────────────────────

/**
 * Return the per-project session DB path using stable project UUID.
 * Path: <projectDir>/.engram-cc/sessions/<uuid>.db
 *
 * @param opts - Platform options.
 * @returns Absolute path to the SQLite DB file.
 */
export function getSessionDBPath(opts = CLAUDE_OPTS) {
  const projectDir = getProjectDir(opts);
  const id  = getProjectId(projectDir);
  const dir = getProjectSessionsDir(opts);
  return join(dir, `${id}.db`);
}

// ── Session events file ───────────────────────────────────────────────────────

/**
 * Return the per-project session events markdown file path.
 * Path: <projectDir>/.engram-cc/sessions/<uuid>-events.md
 *
 * @param opts - Platform options.
 * @returns Absolute path to the session events markdown file.
 */
export function getSessionEventsPath(opts = CLAUDE_OPTS) {
  const projectDir = getProjectDir(opts);
  const id  = getProjectId(projectDir);
  const dir = getProjectSessionsDir(opts);
  return join(dir, `${id}-events.md`);
}

// ── Cleanup flag ──────────────────────────────────────────────────────────────

/**
 * Return the per-project cleanup flag file path.
 * Path: <projectDir>/.engram-cc/sessions/<uuid>.cleanup
 *
 * @param opts - Platform options.
 * @returns Absolute path to the cleanup flag file.
 */
export function getCleanupFlagPath(opts = CLAUDE_OPTS) {
  const projectDir = getProjectDir(opts);
  const id  = getProjectId(projectDir);
  const dir = getProjectSessionsDir(opts);
  return join(dir, `${id}.cleanup`);
}

// ── Handoff path ──────────────────────────────────────────────────────────────

/**
 * Return the per-project handoff YAML file path.
 * Path: <projectDir>/.engram-cc/handoff.yaml
 *
 * @param opts - Platform options.
 * @returns Absolute path to the handoff YAML file.
 */
export function getHandoffFilePath(opts = CLAUDE_OPTS) {
  const projectDir = getProjectDir(opts);
  const dir = join(projectDir, ".engram-cc");
  mkdirSync(dir, { recursive: true });
  return join(dir, "handoff.yaml");
}

// ── Working memory path ───────────────────────────────────────────────────────

/**
 * Return the per-project working memory YAML file path.
 * Path: <projectDir>/.engram-cc/working.yaml
 *
 * @param opts - Platform options.
 * @returns Absolute path to the working memory YAML file.
 */
export function getWorkingMemoryFilePath(opts = CLAUDE_OPTS) {
  const projectDir = getProjectDir(opts);
  const dir = join(projectDir, ".engram-cc");
  mkdirSync(dir, { recursive: true });
  return join(dir, "working.yaml");
}
