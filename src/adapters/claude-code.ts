/**
 * claude-code.ts — EngramCC adapter for Claude Code.
 *
 * What this file is: generates project-local Claude Code setup snippets.
 * Responsible for: writing hook and MCP examples under
 *   <projectDir>/.engram-cc/assistant-configs/claude-code/. Event names:
 *     PostToolUse      → posttooluse.mjs
 *     PreCompact       → precompact.mjs
 *     SessionStart     → sessionstart.mjs
 *     UserPromptSubmit → userpromptsubmit.mjs
 *     Stop             → stop.ts
 * Depends on: src/adapters/detect.ts, src/adapters/local-config.ts.
 * Depended on by: src/adapters/index.ts.
 */

import type { AssistantAdapter, RegistrationResult } from "./types.js";
import { withAssistantEnv } from "./types.js";
import { commandExists } from "./detect.js";
import {
  getBuildHooksDir,
  getMcpServerPath,
  getSrcHooksDir,
  writeLocalAdapterArtifact,
} from "./local-config.js";

const MARKER = "engram-cc";

export class ClaudeCodeAdapter implements AssistantAdapter {
  readonly name = "Claude Code";
  readonly capabilities = {
    session_start: "native",
    user_prompt_submit: "native",
    post_tool_use: "native",
    pre_compact: "native",
    stop: "native",
  } as const;

  isInstalled(): boolean {
    return commandExists("claude");
  }

  /**
   * Emit a project-local Claude Code hooks snippet.
   */
  registerHooks(packageRoot: string, projectRoot: string): RegistrationResult {
    const hooksDir = getSrcHooksDir(packageRoot);
    const buildDir = getBuildHooksDir(packageRoot);
    const settings = {
      hooks: {
        PostToolUse: [
          { matcher: "", hooks: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/posttooluse.mjs" --marker=${MARKER}`, "claude-code") }] },
        ],
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/precompact.mjs" --marker=${MARKER}`, "claude-code") }] },
        ],
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/sessionstart.mjs" --marker=${MARKER}`, "claude-code") }] },
        ],
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/userpromptsubmit.mjs" --marker=${MARKER}`, "claude-code") }] },
        ],
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: withAssistantEnv(`node "${buildDir}/stop.js" --marker=${MARKER}`, "claude-code") }] },
        ],
      },
    };

    return writeLocalAdapterArtifact(
      projectRoot,
      "claude-code",
      "settings.hooks.json",
      "Claude Code hook snippet",
      JSON.stringify(settings, null, 2),
    );
  }

  /**
   * Emit a project-local Claude Code MCP snippet.
   */
  registerMcp(packageRoot: string, projectRoot: string): RegistrationResult {
    const settings = {
      mcpServers: {
        [MARKER]: { command: "node", args: [getMcpServerPath(packageRoot)] },
      },
    };

    return writeLocalAdapterArtifact(
      projectRoot,
      "claude-code",
      "settings.mcp.json",
      "Claude Code MCP snippet",
      JSON.stringify(settings, null, 2),
    );
  }
}
