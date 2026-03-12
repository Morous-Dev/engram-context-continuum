/**
 * gemini-cli.ts — EngramCC adapter for Gemini CLI.
 *
 * What this file is: registers EngramCC hooks and MCP server with Gemini CLI.
 * Responsible for: writing hook entries to ~/.gemini/settings.json and the
 *   MCP server entry to ~/.gemini/mcp.json. Event name mapping:
 *     AfterTool    → posttooluse.mjs   (fires after every tool execution)
 *     PreCompress  → precompact.mjs    (fires before history compression)
 *     SessionStart → sessionstart.mjs  (fires when a session begins)
 *     SessionEnd   → stop.ts           (fires when a session ends)
 * Depends on: node:fs, node:path, node:os, src/adapters/detect.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isGeminiInstalled } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";

const GEMINI_DIR = join(homedir(), ".gemini");
const SETTINGS_PATH = join(GEMINI_DIR, "settings.json");
const MCP_PATH = join(GEMINI_DIR, "mcp.json");
const MARKER = "engram-cc";

interface GeminiHookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

interface GeminiSettings {
  hooks?: Record<string, GeminiHookEntry[]>;
  [key: string]: unknown;
}

interface GeminiMcp {
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

export class GeminiCliAdapter implements AssistantAdapter {
  readonly name = "Gemini CLI";

  isInstalled(): boolean {
    return isGeminiInstalled();
  }

  /**
   * Register hooks in ~/.gemini/settings.json.
   * Maps Gemini event names to the corresponding EngramCC hook scripts.
   * Idempotent — checked via MARKER string in command.
   */
  registerHooks(packageRoot: string): RegistrationResult {
    try {
      mkdirSync(GEMINI_DIR, { recursive: true });
      const settings = readJson<GeminiSettings>(SETTINGS_PATH, {});
      if (!settings.hooks) settings.hooks = {};

      const hooksDir = join(packageRoot, "src", "hooks").replace(/\\/g, "/");
      const buildDir  = join(packageRoot, "build", "hooks").replace(/\\/g, "/");
      const hookDefs: Array<[string, string]> = [
        ["AfterTool",    `node "${hooksDir}/posttooluse.mjs"`],
        ["PreCompress",  `node "${hooksDir}/precompact.mjs"`],
        ["SessionStart", `node "${hooksDir}/sessionstart.mjs"`],
        ["SessionEnd",   `node "${buildDir}/stop.js"`],
      ];

      let registered = 0;
      for (const [event, command] of hookDefs) {
        if (!settings.hooks[event]) settings.hooks[event] = [];
        const already = settings.hooks[event].some(e =>
          e.hooks?.some(h => h.command?.includes(MARKER)),
        );
        if (!already) {
          settings.hooks[event].push({ matcher: "", hooks: [{ type: "command", command }] });
          registered++;
        }
      }

      writeJson(SETTINGS_PATH, settings);
      return {
        success: true,
        skipped: registered === 0,
        message: registered > 0
          ? `Registered ${registered} hooks in ${SETTINGS_PATH}`
          : `Hooks already registered in ${SETTINGS_PATH}`,
      };
    } catch (err) {
      return { success: false, skipped: false, message: `Failed: ${String(err)}` };
    }
  }

  /**
   * Register the MCP server in ~/.gemini/mcp.json.
   */
  registerMcp(packageRoot: string): RegistrationResult {
    try {
      mkdirSync(GEMINI_DIR, { recursive: true });
      const mcp = readJson<GeminiMcp>(MCP_PATH, {});
      if (!mcp.mcpServers) mcp.mcpServers = {};

      if (mcp.mcpServers[MARKER]) {
        return { success: true, skipped: true, message: `MCP already registered in ${MCP_PATH}` };
      }

      const serverPath = join(packageRoot, "build", "mcp", "server.js").replace(/\\/g, "/");
      mcp.mcpServers[MARKER] = { command: "node", args: [serverPath] };
      writeJson(MCP_PATH, mcp);
      return { success: true, skipped: false, message: `MCP server registered in ${MCP_PATH}` };
    } catch (err) {
      return { success: false, skipped: false, message: `Failed: ${String(err)}` };
    }
  }
}
