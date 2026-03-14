/**
 * opencode.ts — EngramCC adapter for OpenCode.
 *
 * What this file is: generates project-local OpenCode setup snippets.
 * Responsible for: writing hook and MCP examples under
 *   <projectDir>/.engram-cc/assistant-configs/opencode/.
 *   OpenCode uses camelCase event names and a JSON config format.
 *   Event name mapping:
 *     afterToolUse   → posttooluse.mjs   (fires after every tool call)
 *     beforeCompress → precompact.mjs    (fires before context compression)
 *     sessionStart   → sessionstart.mjs  (fires when session begins)
 *     sessionEnd     → stop.ts           (fires when session ends)
 *
 * Depends on: src/adapters/detect.ts, src/adapters/local-config.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { isOpenCodeInstalled } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";
import { withAssistantEnv } from "./types.js";
import {
  getBuildHooksDir,
  getMcpServerPath,
  getSrcHooksDir,
  writeLocalAdapterArtifact,
} from "./local-config.js";

const MARKER = "engram-cc";

export class OpenCodeAdapter implements AssistantAdapter {
  readonly name = "OpenCode";
  readonly capabilities = {
    session_start: "native",
    user_prompt_submit: "native",
    post_tool_use: "native",
    pre_compact: "native",
    stop: "native",
  } as const;

  isInstalled(): boolean {
    return isOpenCodeInstalled();
  }

  /**
   * Emit a project-local OpenCode hook snippet.
   */
  registerHooks(packageRoot: string, projectRoot: string): RegistrationResult {
    const hooksDir = getSrcHooksDir(packageRoot);
    const buildDir = getBuildHooksDir(packageRoot);
    const config = {
      hooks: {
        afterToolUse: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/posttooluse.mjs" --marker=${MARKER}`, "opencode", projectRoot) }],
        beforeCompress: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/precompact.mjs" --marker=${MARKER}`, "opencode", projectRoot) }],
        sessionStart: [{ type: "command", command: withAssistantEnv(`node "${hooksDir}/sessionstart.mjs" --marker=${MARKER}`, "opencode", projectRoot) }],
        sessionEnd: [{ type: "command", command: withAssistantEnv(`node "${buildDir}/stop.js" --marker=${MARKER}`, "opencode", projectRoot) }],
      },
    };

    return writeLocalAdapterArtifact(
      projectRoot,
      "opencode",
      "config.hooks.json",
      "OpenCode hook snippet",
      JSON.stringify(config, null, 2),
    );
  }

  /**
   * Emit a project-local OpenCode MCP snippet.
   */
  registerMcp(packageRoot: string, projectRoot: string): RegistrationResult {
    const config = {
      mcp: {
        [MARKER]: { command: "node", args: [getMcpServerPath(packageRoot)] },
      },
    };

    return writeLocalAdapterArtifact(
      projectRoot,
      "opencode",
      "config.mcp.json",
      "OpenCode MCP snippet",
      JSON.stringify(config, null, 2),
    );
  }
}
