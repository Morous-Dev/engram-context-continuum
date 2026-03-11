/**
 * cursor.ts — EngramCC adapter for Cursor.
 *
 * What this file is: registers EngramCC hooks and MCP server with Cursor.
 * Responsible for: writing hook entries to the Cursor user hooks config
 *   and the MCP server entry to the Cursor MCP config. Cursor is a fork of
 *   VS Code and uses identical hook event names and config formats to VS Code
 *   Copilot (PostToolUse, PreCompact, SessionStart, Stop, UserPromptSubmit).
 *
 *   Hook config: ~/.cursor/hooks.json         (cross-platform, Cursor-specific)
 *                %APPDATA%/Cursor/User/hooks.json  (Windows alternative)
 *                ~/Library/Application Support/Cursor/User/hooks.json  (macOS)
 *   MCP config:  same directory / mcp.json
 *
 * Depends on: node:fs, node:path, node:os, src/adapters/detect.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isCursorInstalled, getCursorUserDir } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";

const MARKER = "engram-cc";

interface CursorHookEntry {
  type: string;
  command: string;
}

interface CursorHooksConfig {
  hooks?: Record<string, CursorHookEntry[]>;
  [key: string]: unknown;
}

interface CursorMcp {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  [key: string]: unknown;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; }
  catch { return fallback; }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export class CursorAdapter implements AssistantAdapter {
  readonly name = "Cursor";

  isInstalled(): boolean {
    return isCursorInstalled();
  }

  /**
   * Register hooks in the Cursor user hooks.json.
   * Event names are identical to VS Code Copilot — same scripts are reused.
   * Idempotent — checked via MARKER string in command.
   */
  registerHooks(packageRoot: string): RegistrationResult {
    const userDir = getCursorUserDir();
    if (!userDir) {
      return { success: false, skipped: true, message: "Cursor user directory not found" };
    }

    try {
      mkdirSync(userDir, { recursive: true });
      const hooksPath = join(userDir, "hooks.json");
      const config = readJson<CursorHooksConfig>(hooksPath, {});
      if (!config.hooks) config.hooks = {};

      const hooksDir = join(packageRoot, "src", "hooks").replace(/\\/g, "/");
      const hookDefs: Array<[string, string]> = [
        ["PostToolUse",      `node "${hooksDir}/posttooluse.mjs"`],
        ["PreCompact",       `node "${hooksDir}/precompact.mjs"`],
        ["SessionStart",     `node "${hooksDir}/sessionstart.mjs"`],
        ["UserPromptSubmit", `node "${hooksDir}/userpromptsubmit.mjs"`],
        ["Stop",             `bun run "${hooksDir}/stop.ts"`],
      ];

      let registered = 0;
      for (const [event, command] of hookDefs) {
        if (!config.hooks[event]) config.hooks[event] = [];
        const already = config.hooks[event].some(h => h.command?.includes(MARKER));
        if (!already) {
          config.hooks[event].push({ type: "command", command });
          registered++;
        }
      }

      writeJson(hooksPath, config);
      return {
        success: true,
        skipped: registered === 0,
        message: registered > 0
          ? `Registered ${registered} hooks in ${hooksPath}`
          : `Hooks already registered in ${hooksPath}`,
      };
    } catch (err) {
      return { success: false, skipped: false, message: `Failed: ${String(err)}` };
    }
  }

  /**
   * Register the MCP server in Cursor's mcp.json.
   * Cursor uses the same mcpServers format as Gemini CLI / other tools.
   */
  registerMcp(packageRoot: string): RegistrationResult {
    const userDir = getCursorUserDir();
    if (!userDir) {
      return { success: false, skipped: true, message: "Cursor user directory not found" };
    }

    try {
      mkdirSync(userDir, { recursive: true });
      const mcpPath = join(userDir, "mcp.json");
      const mcp = readJson<CursorMcp>(mcpPath, {});
      if (!mcp.mcpServers) mcp.mcpServers = {};

      if (mcp.mcpServers[MARKER]) {
        return { success: true, skipped: true, message: `MCP already registered in ${mcpPath}` };
      }

      const serverPath = join(packageRoot, "build", "mcp", "server.js").replace(/\\/g, "/");
      mcp.mcpServers[MARKER] = { command: "node", args: [serverPath] };
      writeJson(mcpPath, mcp);
      return { success: true, skipped: false, message: `MCP server registered in ${mcpPath}` };
    } catch (err) {
      return { success: false, skipped: false, message: `Failed: ${String(err)}` };
    }
  }
}
