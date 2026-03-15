/**
 * kilo-cli.ts — EngramCC adapter for Kilo CLI.
 *
 * What this file is: generates project-local Kilo CLI setup snippets.
 * Responsible for: writing wrapper guidance and MCP examples under
 *   <projectDir>/.engram-cc/assistant-configs/kilo-cli/.
 *   Verified support today is MCP plus the `ekilo` wrapper flow documented in
 *   src/hooks/README.md. Kilo has an open feature request for native lifecycle
 *   hooks, so ECC must not claim hook parity until Kilo ships and documents it.
 * Depends on: src/adapters/detect.ts, src/adapters/local-config.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { isKiloInstalled } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";
import {
  getMcpServerPath,
  writeLocalAdapterArtifact,
} from "./local-config.js";

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
   * Emit a project-local Kilo wrapper note only.
   * Native Kilo lifecycle hooks are not currently verified.
   */
  registerHooks(_packageRoot: string, projectRoot: string): RegistrationResult {
    return writeLocalAdapterArtifact(
      projectRoot,
      "kilo-cli",
      "hooks.txt",
      "Kilo CLI wrapper note",
      [
        "Kilo native lifecycle hooks are not currently verified.",
        "Use MCP for EngramCC memory and the `ekilo` wrapper for session-start/session-stop continuity.",
        "See src/hooks/README.md#kilo-cli-integration for the supported setup.",
      ].join("\n"),
    );
  }

  /**
   * Emit a project-local Kilo MCP snippet.
   */
  registerMcp(packageRoot: string, projectRoot: string): RegistrationResult {
    const mcpServerPath = getMcpServerPath(packageRoot);
    const config = {
      mcp: {
        [MARKER]: {
          type: "local",
          command: ["node", mcpServerPath],
          enabled: true,
        },
      },
    };

    return writeLocalAdapterArtifact(
      projectRoot,
      "kilo-cli",
      "mcp.json",
      "Kilo CLI MCP snippet",
      JSON.stringify(config, null, 2),
    );
  }
}
