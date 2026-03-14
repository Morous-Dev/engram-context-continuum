/**
 * kilo-cli.ts — EngramCC adapter for Kilo CLI.
 *
 * What this file is: generates project-local Kilo CLI setup snippets.
 * Responsible for: writing a local MCP example under
 *   <projectDir>/.engram-cc/assistant-configs/kilo-cli/. Hook registration is
 *   intentionally left disabled until Kilo's hook model is verified separately.
 * Depends on: src/adapters/detect.ts, src/adapters/local-config.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { isKiloInstalled } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";
import { getMcpServerPath, writeLocalAdapterArtifact } from "./local-config.js";

const MARKER = "engram-cc";

export class KiloCliAdapter implements AssistantAdapter {
  readonly name = "Kilo CLI";
  readonly capabilities = {
    session_start: "unsupported",
    user_prompt_submit: "unsupported",
    post_tool_use: "unsupported",
    pre_compact: "unsupported",
    stop: "unsupported",
  } as const;

  isInstalled(): boolean {
    return isKiloInstalled();
  }

  /**
   * Hook registration is intentionally deferred. Emit a local note only.
   */
  registerHooks(_packageRoot: string, projectRoot: string): RegistrationResult {
    return writeLocalAdapterArtifact(
      projectRoot,
      "kilo-cli",
      "hooks.txt",
      "Kilo CLI hook note",
      "Hooks are not registered for Kilo CLI. The hook/runtime contract is still unverified.",
    );
  }

  /**
   * Emit a project-local Kilo MCP snippet.
   */
  registerMcp(packageRoot: string, projectRoot: string): RegistrationResult {
    const config = {
      mcpServers: {
        [MARKER]: { command: "node", args: [getMcpServerPath(packageRoot)] },
      },
    };

    return writeLocalAdapterArtifact(
      projectRoot,
      "kilo-cli",
      "mcp_settings.json",
      "Kilo CLI MCP snippet",
      JSON.stringify(config, null, 2),
    );
  }
}
