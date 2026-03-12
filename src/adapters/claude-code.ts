/**
 * claude-code.ts — EngramCC adapter for Claude Code.
 *
 * What this file is: registers EngramCC hooks and MCP server with Claude Code.
 * Responsible for: writing hook entries to ~/.claude/settings.json and the
 *   MCP server entry to ~/.claude/settings.json (Claude Code uses a single
 *   settings file for both hooks and MCP servers). Event names:
 *     PostToolUse      → posttooluse.mjs
 *     PreCompact       → precompact.mjs
 *     SessionStart     → sessionstart.mjs
 *     UserPromptSubmit → userpromptsubmit.mjs
 *     Stop             → stop.ts
 *
 * Config file: ~/.claude/settings.json
 *
 * Depends on: node:fs, node:path, node:os, src/adapters/detect.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { AssistantAdapter, RegistrationResult } from "./types.js";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const MARKER = "engram-cc";

interface HookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
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

export class ClaudeCodeAdapter implements AssistantAdapter {
  readonly name = "Claude Code";

  isInstalled(): boolean {
    // Claude Code is always present when EngramCC runs, because this is how
    // the user got here. We also check the .claude dir as a fallback.
    return existsSync(join(homedir(), ".claude")) || true;
  }

  /**
   * Register hooks in ~/.claude/settings.json.
   * Claude Code uses matcher+hooks array format per event.
   * Idempotent — checked via MARKER string in any hook command.
   */
  registerHooks(packageRoot: string): RegistrationResult {
    try {
      mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
      const settings = readJson<ClaudeSettings>(SETTINGS_PATH, {});
      if (!settings.hooks) settings.hooks = {};

      const hooksDir = join(packageRoot, "src", "hooks").replace(/\\/g, "/");
      const buildDir  = join(packageRoot, "build", "hooks").replace(/\\/g, "/");
      const hookDefs: Array<[string, string]> = [
        ["PostToolUse",      `node "${hooksDir}/posttooluse.mjs"`],
        ["PreCompact",       `node "${hooksDir}/precompact.mjs"`],
        ["SessionStart",     `node "${hooksDir}/sessionstart.mjs"`],
        ["UserPromptSubmit", `node "${hooksDir}/userpromptsubmit.mjs"`],
        ["Stop",             `node "${buildDir}/stop.js"`],
      ];

      let registered = 0;
      for (const [event, command] of hookDefs) {
        if (!settings.hooks[event]) settings.hooks[event] = [];
        const already = settings.hooks[event].some(entry =>
          (entry.hooks ?? []).some(h => h.command?.includes(MARKER)),
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
   * Register the MCP server in ~/.claude/settings.json.
   * Claude Code reads mcpServers from the same settings file as hooks.
   */
  registerMcp(packageRoot: string): RegistrationResult {
    try {
      mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
      const settings = readJson<ClaudeSettings>(SETTINGS_PATH, {});
      if (!settings.mcpServers) settings.mcpServers = {};

      if (settings.mcpServers[MARKER]) {
        return { success: true, skipped: true, message: `MCP already registered in ${SETTINGS_PATH}` };
      }

      const serverPath = join(packageRoot, "build", "mcp", "server.js").replace(/\\/g, "/");
      settings.mcpServers[MARKER] = { command: "node", args: [serverPath] };
      writeJson(SETTINGS_PATH, settings);
      return { success: true, skipped: false, message: `MCP server registered in ${SETTINGS_PATH}` };
    } catch (err) {
      return { success: false, skipped: false, message: `Failed: ${String(err)}` };
    }
  }
}
