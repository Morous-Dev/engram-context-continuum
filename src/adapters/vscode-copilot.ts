/**
 * vscode-copilot.ts — EngramCC adapter for VS Code Copilot.
 *
 * What this file is: registers EngramCC hooks and MCP server with VS Code Copilot.
 * Responsible for: writing hook entries to the user-level VS Code hooks config
 *   and the MCP server entry to the user-level mcp.json. VS Code Copilot uses
 *   identical event names to Claude Code (PostToolUse, PreCompact, SessionStart,
 *   Stop, UserPromptSubmit) so the same hook scripts can be reused directly.
 *
 *   Hook config: %APPDATA%/Code/User/hooks.json  (Windows)
 *                ~/Library/Application Support/Code/User/hooks.json  (macOS)
 *                ~/.config/Code/User/hooks.json  (Linux)
 *   MCP config:  same directory / mcp.json
 *
 * Depends on: node:fs, node:path, node:os, src/adapters/detect.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isVSCodeInstalled, getVSCodeUserDir } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";

const MARKER = "engram-cc";

interface VSCodeHookEntry {
  type: string;
  command: string;
}

interface VSCodeHooksConfig {
  hooks?: Record<string, VSCodeHookEntry[]>;
  [key: string]: unknown;
}

interface VSCodeMcp {
  servers?: Record<string, { type: string; command: string; args?: string[] }>;
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

export class VSCodeCopilotAdapter implements AssistantAdapter {
  readonly name = "VS Code Copilot";

  isInstalled(): boolean {
    return isVSCodeInstalled();
  }

  /**
   * Register hooks in the VS Code user hooks.json.
   * VS Code uses identical event names to Claude Code — same scripts, different file.
   */
  registerHooks(packageRoot: string): RegistrationResult {
    const userDir = getVSCodeUserDir();
    if (!userDir) {
      return { success: false, skipped: true, message: "VS Code user directory not found" };
    }

    try {
      mkdirSync(userDir, { recursive: true });
      const hooksPath = join(userDir, "hooks.json");
      const config = readJson<VSCodeHooksConfig>(hooksPath, {});
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
   * Register the MCP server in the VS Code user mcp.json.
   * VS Code 1.99+ uses ~/.vscode/mcp.json for user-level MCP servers.
   */
  registerMcp(packageRoot: string): RegistrationResult {
    const userDir = getVSCodeUserDir();
    if (!userDir) {
      return { success: false, skipped: true, message: "VS Code user directory not found" };
    }

    try {
      mkdirSync(userDir, { recursive: true });
      const mcpPath = join(userDir, "mcp.json");
      const mcp = readJson<VSCodeMcp>(mcpPath, {});
      if (!mcp.servers) mcp.servers = {};

      if (mcp.servers[MARKER]) {
        return { success: true, skipped: true, message: `MCP already registered in ${mcpPath}` };
      }

      const serverPath = join(packageRoot, "build", "mcp", "server.js").replace(/\\/g, "/");
      mcp.servers[MARKER] = { type: "stdio", command: "node", args: [serverPath] };
      writeJson(mcpPath, mcp);
      return { success: true, skipped: false, message: `MCP server registered in ${mcpPath}` };
    } catch (err) {
      return { success: false, skipped: false, message: `Failed: ${String(err)}` };
    }
  }
}
