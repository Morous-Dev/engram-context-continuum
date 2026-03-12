/**
 * codex-cli.ts — EngramCC adapter for Codex CLI (OpenAI).
 *
 * What this file is: registers EngramCC hooks and MCP server with Codex CLI.
 * Responsible for: appending hook entries to ~/.codex/config.toml and the
 *   MCP server entry. Codex uses snake_case event names in TOML format:
 *     session_start → sessionstart.mjs
 *     pre_tool_use  → posttooluse.mjs  (fires before tool, limited data — best available)
 *     stop          → stop.ts
 *   Note: Codex CLI has fewer hook events than Claude Code (no PreCompact,
 *   no UserPromptSubmit). This is a known limitation of the Codex hook system.
 *
 * Config file: ~/.codex/config.toml
 *
 * Depends on: node:fs, node:path, node:os, src/adapters/detect.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isCodexInstalled } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";

const CODEX_DIR = join(homedir(), ".codex");
const CONFIG_PATH = join(CODEX_DIR, "config.toml");
const MARKER = "engram-cc";

/**
 * Minimal TOML writer for the specific hook entry format Codex uses.
 * Avoids a full TOML dependency — only appends known-safe string entries.
 *
 * Why hand-rolled: adding a TOML library dependency for 3 hook entries is
 * disproportionate. The format is simple and well-defined.
 *
 * @param existing - Current config.toml content as a string.
 * @param event    - Codex hook event name (e.g. "session_start").
 * @param command  - Shell command to register.
 * @returns Updated config.toml content with the hook appended.
 */
function appendTomlHook(existing: string, event: string, command: string): string {
  const section = `[[hooks.${event}]]`;
  // Already registered if section exists with our marker command
  if (existing.includes(section) && existing.includes(MARKER)) return existing;
  const entry = `\n${section}\ncommand = ${JSON.stringify(command)}\n`;
  return existing + entry;
}

/**
 * Append an MCP server entry to config.toml (if not already present).
 *
 * @param existing  - Current config.toml content.
 * @param serverPath - Absolute path to build/mcp/server.js.
 */
function appendTomlMcp(existing: string, serverPath: string): string {
  const section = `[mcp_servers.${MARKER}]`;
  if (existing.includes(section)) return existing;
  const entry = `\n${section}\ncommand = "node"\nargs = [${JSON.stringify(serverPath)}]\n`;
  return existing + entry;
}

export class CodexCliAdapter implements AssistantAdapter {
  readonly name = "Codex CLI";

  isInstalled(): boolean {
    return isCodexInstalled();
  }

  /**
   * Append hook entries to ~/.codex/config.toml.
   * Codex events are snake_case; we map them to the nearest EngramCC handler.
   */
  registerHooks(packageRoot: string): RegistrationResult {
    try {
      mkdirSync(CODEX_DIR, { recursive: true });
      const existing = existsSync(CONFIG_PATH)
        ? readFileSync(CONFIG_PATH, "utf-8")
        : "";

      // Check if already registered (any of our entries present)
      if (existing.includes(MARKER)) {
        return { success: true, skipped: true, message: `Hooks already registered in ${CONFIG_PATH}` };
      }

      const hooksDir = join(packageRoot, "src", "hooks").replace(/\\/g, "/");
      const buildDir  = join(packageRoot, "build", "hooks").replace(/\\/g, "/");
      let content = existing;
      content = appendTomlHook(content, "session_start", `node "${hooksDir}/sessionstart.mjs"`);
      content = appendTomlHook(content, "pre_tool_use",  `node "${hooksDir}/posttooluse.mjs"`);
      content = appendTomlHook(content, "stop",          `node "${buildDir}/stop.js"`);

      writeFileSync(CONFIG_PATH, content, "utf-8");
      return { success: true, skipped: false, message: `Registered 3 hooks in ${CONFIG_PATH}` };
    } catch (err) {
      return { success: false, skipped: false, message: `Failed: ${String(err)}` };
    }
  }

  /**
   * Append the MCP server entry to ~/.codex/config.toml.
   */
  registerMcp(packageRoot: string): RegistrationResult {
    try {
      mkdirSync(CODEX_DIR, { recursive: true });
      const existing = existsSync(CONFIG_PATH)
        ? readFileSync(CONFIG_PATH, "utf-8")
        : "";

      const serverPath = join(packageRoot, "build", "mcp", "server.js").replace(/\\/g, "/");
      const updated = appendTomlMcp(existing, serverPath);

      if (updated === existing) {
        return { success: true, skipped: true, message: `MCP already registered in ${CONFIG_PATH}` };
      }

      writeFileSync(CONFIG_PATH, updated, "utf-8");
      return { success: true, skipped: false, message: `MCP server registered in ${CONFIG_PATH}` };
    } catch (err) {
      return { success: false, skipped: false, message: `Failed: ${String(err)}` };
    }
  }
}
