/**
 * opencode.ts — EngramCC adapter for OpenCode.
 *
 * What this file is: registers EngramCC hooks and MCP server with OpenCode.
 * Responsible for: writing hook entries to ~/.config/opencode/config.json (or
 *   ~/.opencode/config.json) and the MCP server entry to the same file.
 *   OpenCode uses camelCase event names and a JSON config format.
 *   Event name mapping:
 *     afterToolUse   → posttooluse.mjs   (fires after every tool call)
 *     beforeCompress → precompact.mjs    (fires before context compression)
 *     sessionStart   → sessionstart.mjs  (fires when session begins)
 *     sessionEnd     → stop.ts           (fires when session ends)
 *
 * Config file: ~/.config/opencode/config.json  (preferred)
 *              ~/.opencode/config.json          (fallback)
 *
 * Depends on: node:fs, node:path, node:os, src/adapters/detect.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isOpenCodeInstalled } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";

const MARKER = "engram-cc";

/**
 * Resolve the OpenCode config directory.
 * Prefers ~/.config/opencode (XDG), falls back to ~/.opencode.
 * Creates the preferred location if neither exists.
 */
function getOpenCodeDir(): string {
  const xdg = join(homedir(), ".config", "opencode");
  const fallback = join(homedir(), ".opencode");
  if (existsSync(xdg)) return xdg;
  if (existsSync(fallback)) return fallback;
  return xdg; // default to XDG; mkdirSync will create it
}

interface OpenCodeHookEntry {
  type: string;
  command: string;
}

interface OpenCodeConfig {
  hooks?: Record<string, OpenCodeHookEntry[]>;
  mcp?: Record<string, { command: string; args?: string[] }>;
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

export class OpenCodeAdapter implements AssistantAdapter {
  readonly name = "OpenCode";

  isInstalled(): boolean {
    return isOpenCodeInstalled();
  }

  /**
   * Register hooks in OpenCode's config.json.
   * OpenCode uses camelCase event names with a JSON array format.
   * Idempotent — checked via MARKER string in command.
   */
  registerHooks(packageRoot: string): RegistrationResult {
    try {
      const dir = getOpenCodeDir();
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "config.json");
      const config = readJson<OpenCodeConfig>(configPath, {});
      if (!config.hooks) config.hooks = {};

      const hooksDir = join(packageRoot, "src", "hooks").replace(/\\/g, "/");
      const buildDir  = join(packageRoot, "build", "hooks").replace(/\\/g, "/");
      const hookDefs: Array<[string, string]> = [
        ["afterToolUse",   `node "${hooksDir}/posttooluse.mjs"`],
        ["beforeCompress", `node "${hooksDir}/precompact.mjs"`],
        ["sessionStart",   `node "${hooksDir}/sessionstart.mjs"`],
        ["sessionEnd",     `node "${buildDir}/stop.js"`],
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

      writeJson(configPath, config);
      return {
        success: true,
        skipped: registered === 0,
        message: registered > 0
          ? `Registered ${registered} hooks in ${configPath}`
          : `Hooks already registered in ${configPath}`,
      };
    } catch (err) {
      return { success: false, skipped: false, message: `Failed: ${String(err)}` };
    }
  }

  /**
   * Register the MCP server in OpenCode's config.json.
   * OpenCode uses an inline `mcp` key in config.json (not a separate file).
   */
  registerMcp(packageRoot: string): RegistrationResult {
    try {
      const dir = getOpenCodeDir();
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "config.json");
      const config = readJson<OpenCodeConfig>(configPath, {});
      if (!config.mcp) config.mcp = {};

      if (config.mcp[MARKER]) {
        return { success: true, skipped: true, message: `MCP already registered in ${configPath}` };
      }

      const serverPath = join(packageRoot, "build", "mcp", "server.js").replace(/\\/g, "/");
      config.mcp[MARKER] = { command: "node", args: [serverPath] };
      writeJson(configPath, config);
      return { success: true, skipped: false, message: `MCP server registered in ${configPath}` };
    } catch (err) {
      return { success: false, skipped: false, message: `Failed: ${String(err)}` };
    }
  }
}
