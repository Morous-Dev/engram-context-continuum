/**
 * codex-cli.ts — EngramCC adapter for Codex CLI (OpenAI).
 *
 * What this file is: generates project-local Codex CLI setup snippets.
 * Responsible for: writing TOML examples under
 *   <projectDir>/.engram-cc/assistant-configs/codex-cli/. Codex uses
 *   snake_case event names in TOML format:
 *     session_start → sessionstart.mjs
 *     pre_tool_use  → codex-pretooluse.mjs (limited data — partial coverage only)
 *     stop          → stop.ts
 *   Note: Codex CLI has fewer native hook events than Claude Code. ECC currently
 *   supports native session_start + stop, plus a partial pre_tool_use bridge.
 *   There is no native UserPromptSubmit, PostToolUse, or PreCompact parity yet.
 * Depends on: src/adapters/detect.ts, src/adapters/local-config.ts.
 * Depended on by: src/adapters/index.ts.
 */

import { join } from "node:path";
import { isCodexInstalled } from "./detect.js";
import type { AssistantAdapter, RegistrationResult } from "./types.js";
import { withAssistantEnv } from "./types.js";
import {
  getBuildHooksDir,
  getMcpServerPath,
  getSrcHooksDir,
  writeLocalAdapterArtifact,
} from "./local-config.js";

const MARKER = "engram-cc";
const HOOKS_START = `# ${MARKER} hooks:start`;
const HOOKS_END = `# ${MARKER} hooks:end`;
const MCP_START = `# ${MARKER} mcp:start`;
const MCP_END = `# ${MARKER} mcp:end`;

/**
 * Build the managed hooks block for Codex.
 *
 * @param hooksDir - Absolute src/hooks path with forward slashes.
 * @param buildDir - Absolute build/hooks path with forward slashes.
 * @param projectRoot - Absolute target project path with native separators.
 * @returns Managed TOML block for ECC hooks.
 */
function buildHooksBlock(hooksDir: string, buildDir: string, projectRoot: string): string {
  return [
    HOOKS_START,
    "[[hooks.session_start]]",
    `command = ${JSON.stringify(withAssistantEnv(`node "${hooksDir}/codex-sessionstart.mjs"`, "codex", projectRoot))}`,
    "",
    "[[hooks.pre_tool_use]]",
    `command = ${JSON.stringify(withAssistantEnv(`node "${hooksDir}/codex-pretooluse.mjs"`, "codex", projectRoot))}`,
    "",
    "[[hooks.stop]]",
    `command = ${JSON.stringify(withAssistantEnv(`node "${buildDir}/codex-stop.js"`, "codex", projectRoot))}`,
    HOOKS_END,
    "",
  ].join("\n");
}

/**
 * Build the managed MCP block for Codex.
 *
 * @param serverPath - Absolute build/mcp/server.js path with forward slashes.
 * @returns Managed TOML block for the ECC MCP server.
 */
function buildMcpBlock(serverPath: string): string {
  return [
    MCP_START,
    `[mcp_servers.${MARKER}]`,
    'command = "node"',
    `args = [${JSON.stringify(serverPath)}]`,
    MCP_END,
    "",
  ].join("\n");
}

export class CodexCliAdapter implements AssistantAdapter {
  readonly name = "Codex CLI";
  readonly capabilities = {
    session_start: "native",
    user_prompt_submit: "synthesized",
    post_tool_use: "unsupported",
    pre_compact: "synthesized",
    stop: "native",
  } as const;

  isInstalled(): boolean {
    return isCodexInstalled();
  }

  /**
   * Emit a project-local Codex hook snippet.
   * Codex events are snake_case; ECC only provides partial hook coverage here.
   */
  registerHooks(packageRoot: string, projectRoot: string): RegistrationResult {
    return writeLocalAdapterArtifact(
      projectRoot,
      "codex-cli",
      "config.hooks.toml",
      "Codex CLI hook snippet",
      buildHooksBlock(getSrcHooksDir(packageRoot), getBuildHooksDir(packageRoot), projectRoot),
    );
  }

  /**
   * Emit a project-local Codex MCP snippet.
   */
  registerMcp(packageRoot: string, projectRoot: string): RegistrationResult {
    return writeLocalAdapterArtifact(
      projectRoot,
      "codex-cli",
      "config.mcp.toml",
      "Codex CLI MCP snippet",
      buildMcpBlock(getMcpServerPath(packageRoot)),
    );
  }
}
