/**
 * index.ts — Adapter registry and batch registration orchestrator.
 *
 * What this file is: the single entry point for all assistant adapter operations.
 * Responsible for: exporting all adapters, providing registerAll() to run hooks
 *   and MCP registration across every detected assistant in one call.
 * Depends on: all adapter files in src/adapters/.
 * Depended on by: src/cli/setup.ts.
 */

export { ClaudeCodeAdapter }  from "./claude-code.js";
export { GeminiCliAdapter }   from "./gemini-cli.js";
export { VSCodeCopilotAdapter } from "./vscode-copilot.js";
export { CodexCliAdapter }    from "./codex-cli.js";
export { OpenCodeAdapter }    from "./opencode.js";
export { CursorAdapter }      from "./cursor.js";
export type { AssistantAdapter, RegistrationResult } from "./types.js";

import { ClaudeCodeAdapter }    from "./claude-code.js";
import { GeminiCliAdapter }     from "./gemini-cli.js";
import { VSCodeCopilotAdapter } from "./vscode-copilot.js";
import { CodexCliAdapter }      from "./codex-cli.js";
import { OpenCodeAdapter }      from "./opencode.js";
import { CursorAdapter }        from "./cursor.js";
import type { AssistantAdapter } from "./types.js";

/** All supported assistant adapters, in registration priority order. */
const ALL_ADAPTERS: AssistantAdapter[] = [
  new ClaudeCodeAdapter(),
  new GeminiCliAdapter(),
  new VSCodeCopilotAdapter(),
  new CodexCliAdapter(),
  new OpenCodeAdapter(),
  new CursorAdapter(),
];

export interface AdapterResult {
  adapter: string;
  installed: boolean;
  hooks: { success: boolean; skipped: boolean; message: string } | null;
  mcp:   { success: boolean; skipped: boolean; message: string } | null;
}

/**
 * Run hooks and MCP registration for all detected assistants.
 * Skips adapters whose isInstalled() returns false.
 * Never throws — all errors are captured in AdapterResult.
 *
 * @param packageRoot - Absolute path to the installed EngramCC package root.
 * @returns Array of results, one per adapter.
 */
export function registerAll(packageRoot: string): AdapterResult[] {
  return ALL_ADAPTERS.map(adapter => {
    const installed = adapter.isInstalled();
    if (!installed) {
      return { adapter: adapter.name, installed: false, hooks: null, mcp: null };
    }

    const hooks = adapter.registerHooks(packageRoot);
    const mcp   = adapter.registerMcp(packageRoot);
    return { adapter: adapter.name, installed: true, hooks, mcp };
  });
}
