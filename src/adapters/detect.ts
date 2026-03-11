/**
 * detect.ts — Utilities for detecting installed AI coding assistants.
 *
 * What this file is: shared detection helpers used by every assistant adapter.
 * Responsible for: checking for binary presence, config directories, and
 *   platform-specific install paths.
 * Depends on: node:child_process, node:fs, node:path, node:os.
 * Depended on by: all adapter files in src/adapters/.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

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

/**
 * Check whether a directory exists at the given path.
 *
 * @param path - Absolute path to check.
 */
export function dirExists(path: string): boolean {
  return existsSync(path);
}

// ── Per-assistant detection ──────────────────────────────────────────────────

/** Returns true if Gemini CLI is installed. */
export function isGeminiInstalled(): boolean {
  return dirExists(join(homedir(), ".gemini")) || commandExists("gemini");
}

/** Returns true if VS Code with Copilot is likely installed. */
export function isVSCodeInstalled(): boolean {
  const vscodeDataDirs = [
    join(homedir(), "AppData", "Roaming", "Code", "User"),    // Windows
    join(homedir(), "Library", "Application Support", "Code", "User"), // macOS
    join(homedir(), ".config", "Code", "User"),                // Linux
    join(homedir(), ".vscode"),                                // fallback
  ];
  return vscodeDataDirs.some(dirExists) || commandExists("code");
}

/** Returns true if Codex CLI is installed. */
export function isCodexInstalled(): boolean {
  return dirExists(join(homedir(), ".codex")) || commandExists("codex");
}

/** Returns true if OpenCode is installed. */
export function isOpenCodeInstalled(): boolean {
  return (
    dirExists(join(homedir(), ".config", "opencode")) ||
    dirExists(join(homedir(), ".opencode")) ||
    commandExists("opencode")
  );
}

/** Returns true if Cursor is installed. */
export function isCursorInstalled(): boolean {
  const cursorDirs = [
    join(homedir(), ".cursor"),
    join(homedir(), "AppData", "Roaming", "Cursor", "User"), // Windows
    join(homedir(), "Library", "Application Support", "Cursor", "User"), // macOS
  ];
  return cursorDirs.some(dirExists) || commandExists("cursor");
}

/**
 * Find the VS Code user data directory for the current platform.
 * Returns null if not found.
 */
export function getVSCodeUserDir(): string | null {
  const candidates = [
    join(homedir(), "AppData", "Roaming", "Code", "User"),
    join(homedir(), "Library", "Application Support", "Code", "User"),
    join(homedir(), ".config", "Code", "User"),
  ];
  return candidates.find(dirExists) ?? null;
}

/**
 * Find the Cursor user data directory for the current platform.
 * Returns null if not found.
 */
export function getCursorUserDir(): string | null {
  const candidates = [
    join(homedir(), ".cursor"),
    join(homedir(), "AppData", "Roaming", "Cursor", "User"),
    join(homedir(), "Library", "Application Support", "Cursor", "User"),
  ];
  return candidates.find(dirExists) ?? null;
}
