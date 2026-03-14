/**
 * vscode-copilot.ts — EngramCC adapter for VS Code Copilot.
 *
 * What this file is: generates project-local VS Code Copilot setup snippets.
 * Responsible for: writing hook and MCP examples under
 *   <projectDir>/.engram-cc/assistant-configs/vscode-copilot/. VS Code Copilot uses
 *   identical event names to Claude Code (PostToolUse, PreCompact, SessionStart,
 *   Stop, UserPromptSubmit) so the same hook scripts can be reused directly.
 * Depends on: src/adapters/detect.ts, src/adapters/local-config.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { isVSCodeInstalled } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";
import { getMcpServerPath, writeLocalAdapterArtifact } from "./local-config.js";

const MARKER = "engram-cc";

export class VSCodeCopilotAdapter implements AssistantAdapter {
  readonly name = "VS Code Copilot";
  readonly capabilities = {
    session_start: "unsupported",
    user_prompt_submit: "unsupported",
    post_tool_use: "unsupported",
    pre_compact: "unsupported",
    stop: "unsupported",
  } as const;

  isInstalled(): boolean {
    return isVSCodeInstalled();
  }

  /**
   * VS Code remains MCP-read-only. Emit a local note rather than touching user config.
   */
  registerHooks(_packageRoot: string, projectRoot: string): RegistrationResult {
    return writeLocalAdapterArtifact(
      projectRoot,
      "vscode-copilot",
      "hooks.txt",
      "VS Code Copilot hook note",
      "Hooks are not supported for VS Code Copilot in ECC local-only mode. Use the MCP snippet only.",
    );
  }

  /**
   * Emit a project-local VS Code MCP snippet.
   */
  registerMcp(packageRoot: string, projectRoot: string): RegistrationResult {
    const mcp = {
      servers: {
        [MARKER]: { type: "stdio", command: "node", args: [getMcpServerPath(packageRoot)] },
      },
    };

    return writeLocalAdapterArtifact(
      projectRoot,
      "vscode-copilot",
      "mcp.json",
      "VS Code Copilot MCP snippet",
      JSON.stringify(mcp, null, 2),
    );
  }
}
