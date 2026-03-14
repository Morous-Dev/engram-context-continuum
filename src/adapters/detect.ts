/**
 * detect.ts — Utilities for detecting installed AI coding assistants.
 *
 * What this file is: shared detection helpers used by every assistant adapter.
 * Responsible for: checking for binary presence only. ECC local-only mode
 * does not inspect or mutate user-profile config directories outside the repo.
 * Depends on: node:child_process, node:os.
 * Depended on by: all adapter files in src/adapters/.
 */

import { execSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Check whether a CLI command exists in PATH.
 * Uses `where` on Windows, `which` on Unix.
 *
 * @param cmd - The command name to check (e.g. "gemini", "cursor").
 * @returns true if the command is found.
 */
export function commandExists(cmd: string): boolean {
  try {
    const check = platform() === "win32" ? `where ${cmd}` : `which ${cmd}`;
    execSync(check, { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── Per-assistant detection ──────────────────────────────────────────────────

/** Returns true if Gemini CLI is installed. */
export function isGeminiInstalled(): boolean {
  return commandExists("gemini");
}

/** Returns true if VS Code with Copilot is likely installed. */
export function isVSCodeInstalled(): boolean {
  return commandExists("code");
}

/** Returns true if Codex CLI is installed. */
export function isCodexInstalled(): boolean {
  return commandExists("codex");
}

/** Returns true if Kilo CLI is installed. */
export function isKiloInstalled(): boolean {
  return commandExists("kilo");
}

/** Returns true if OpenCode is installed. */
export function isOpenCodeInstalled(): boolean {
  return commandExists("opencode");
}

/** Returns true if Cursor is installed. */
export function isCursorInstalled(): boolean {
  return commandExists("cursor");
}

/**
 * Find the VS Code user data directory for the current platform.
 * Returns null if not found.
 */
export function getVSCodeUserDir(): string | null {
  return null;
}

/**
 * Find the Cursor user data directory for the current platform.
 * Returns null if not found.
 */
export function getCursorUserDir(): string | null {
  return null;
}
