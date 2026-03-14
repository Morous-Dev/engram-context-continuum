/**
 * index.ts — Adapter registry and batch registration orchestrator.
 *
 * What this file is: the single entry point for all assistant adapter operations.
 * Responsible for: exporting all adapters, providing registerAll() to emit
 *   project-local setup artifacts across every supported assistant in one call.
 * Depends on: all adapter files in src/adapters/.
 * Depended on by: src/cli/setup.ts.
 */

export { ClaudeCodeAdapter }  from "./claude-code.js";
export { GeminiCliAdapter }   from "./gemini-cli.js";
export { VSCodeCopilotAdapter } from "./vscode-copilot.js";
export { CodexCliAdapter }    from "./codex-cli.js";
export { KiloCliAdapter }     from "./kilo-cli.js";
export { OpenCodeAdapter }    from "./opencode.js";
export { CursorAdapter }      from "./cursor.js";
export type {
  AssistantAdapter,
  RegistrationResult,
  AdapterCapabilities,
  CapabilityTier,
} from "./types.js";

import { ClaudeCodeAdapter }    from "./claude-code.js";
import { GeminiCliAdapter }     from "./gemini-cli.js";
import { VSCodeCopilotAdapter } from "./vscode-copilot.js";
import { CodexCliAdapter }      from "./codex-cli.js";
import { KiloCliAdapter }       from "./kilo-cli.js";
import { OpenCodeAdapter }      from "./opencode.js";
import { CursorAdapter }        from "./cursor.js";
import type { AssistantAdapter } from "./types.js";

/** All supported assistant adapters, in registration priority order. */
const ALL_ADAPTERS: AssistantAdapter[] = [
  new ClaudeCodeAdapter(),
  new GeminiCliAdapter(),
  new VSCodeCopilotAdapter(),
  new CodexCliAdapter(),
  new KiloCliAdapter(),
  new OpenCodeAdapter(),
  new CursorAdapter(),
];

export interface AdapterResult {
  adapter: string;
  installed: boolean;
  capabilities: AssistantAdapter["capabilities"];
  hooks: { success: boolean; skipped: boolean; message: string } | null;
  mcp:   { success: boolean; skipped: boolean; message: string } | null;
}

/**
 * Emit hooks and MCP setup artifacts for all supported assistants.
 * Detection is reported separately, but local snippets are always generated
 * so setup never needs to touch user-profile config outside the repo.
 *
 * @param packageRoot - Absolute path to the installed EngramCC package root.
 * @param projectRoot - Absolute path to the target project directory.
 * @returns Array of results, one per adapter.
 */
export function registerAll(packageRoot: string, projectRoot: string): AdapterResult[] {
  return ALL_ADAPTERS.map(adapter => {
    const installed = adapter.isInstalled();
    const hooks = adapter.registerHooks(packageRoot, projectRoot);
    const mcp   = adapter.registerMcp(packageRoot, projectRoot);
    return { adapter: adapter.name, installed, capabilities: adapter.capabilities, hooks, mcp };
  });
}
