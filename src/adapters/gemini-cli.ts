/**
 * gemini-cli.ts — EngramCC adapter for Gemini CLI.
 *
 * What this file is: generates project-local Gemini CLI setup snippets.
 * Responsible for: writing hook and MCP examples under
 *   <projectDir>/.engram-cc/assistant-configs/gemini-cli/. Event name mapping:
 *     AfterTool    → posttooluse.mjs   (fires after every tool execution)
 *     PreCompress  → precompact.mjs    (fires before history compression)
 *     SessionStart → sessionstart.mjs  (fires when a session begins)
 *     SessionEnd   → stop.ts           (fires when a session ends)
 * Depends on: src/adapters/detect.ts, src/adapters/local-config.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { isGeminiInstalled } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";
import { withAssistantEnv } from "./types.js";
import {
  getBuildHooksDir,
  getMcpServerPath,
  getSrcHooksDir,
  writeLocalAdapterArtifact,
} from "./local-config.js";

const MARKER = "engram-cc";

export class GeminiCliAdapter implements AssistantAdapter {
  readonly name = "Gemini CLI";
  readonly capabilities = {
    session_start: "native",
    user_prompt_submit: "native",
    post_tool_use: "native",
    pre_compact: "native",
    stop: "native",
  } as const;

  isInstalled(): boolean {
    return isGeminiInstalled();
  }

  /**
   * Emit a project-local Gemini hook snippet.
   */
  registerHooks(packageRoot: string, projectRoot: string): RegistrationResult {
    const hooksDir = getSrcHooksDir(packageRoot);
    const buildDir = getBuildHooksDir(packageRoot);
    const settings = {
      hooks: {
        AfterTool: [
          { matcher: "*", hooks: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/posttooluse.mjs" --marker=${MARKER}`, "gemini-cli") }] },
        ],
        BeforeAgent: [
          { matcher: "*", hooks: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/userpromptsubmit.mjs" --marker=${MARKER}`, "gemini-cli") }] },
        ],
        PreCompress: [
          { matcher: "", hooks: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/precompact.mjs" --marker=${MARKER}`, "gemini-cli") }] },
        ],
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/sessionstart.mjs" --marker=${MARKER}`, "gemini-cli") }] },
        ],
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: withAssistantEnv(`node "${buildDir}/stop.js" --marker=${MARKER}`, "gemini-cli") }] },
        ],
      },
    };

    return writeLocalAdapterArtifact(
      projectRoot,
      "gemini-cli",
      "settings.hooks.json",
      "Gemini CLI hook snippet",
      JSON.stringify(settings, null, 2),
    );
  }

  /**
   * Emit a project-local Gemini MCP snippet.
   */
  registerMcp(packageRoot: string, projectRoot: string): RegistrationResult {
    const mcp = {
      mcpServers: {
        [MARKER]: { command: "node", args: [getMcpServerPath(packageRoot)] },
      },
    };

    return writeLocalAdapterArtifact(
      projectRoot,
      "gemini-cli",
      "mcp.json",
      "Gemini CLI MCP snippet",
      JSON.stringify(mcp, null, 2),
    );
  }
}
