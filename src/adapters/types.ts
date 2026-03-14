/**
 * types.ts — Shared types for AI assistant adapters.
 *
 * What this file is: defines the contract every assistant adapter must implement.
 * Responsible for: the AssistantAdapter interface and RegistrationResult type.
 * Depends on: nothing.
 * Depended on by: all adapter files, src/adapters/index.ts.
 */

// ── Result types ─────────────────────────────────────────────────────────────

/** Result of a hook or MCP registration attempt. */
export interface RegistrationResult {
  /** Whether the registration succeeded or was already in place. */
  success: boolean;
  /** True if registration was skipped (assistant not installed, already registered). */
  skipped: boolean;
  /** Human-readable message for the setup CLI to display. */
  message: string;
}

export type CapabilityTier = "native" | "synthesized" | "unsupported";

export interface AdapterCapabilities {
  session_start: CapabilityTier;
  user_prompt_submit: CapabilityTier;
  post_tool_use: CapabilityTier;
  pre_compact: CapabilityTier;
  stop: CapabilityTier;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandQuote(value: string): string {
  return process.platform === "win32"
    ? `"${value.replace(/"/g, '\\"')}"`
    : shellQuote(value);
}

function parseNodeCommand(command: string): { scriptPath: string; forwardedArgs: string } | null {
  const match = command.match(/^node\s+"([^"]+)"(?:\s+(.*))?$/);
  if (!match) return null;
  return {
    scriptPath: match[1],
    forwardedArgs: match[2] ?? "",
  };
}

function getHookRunnerPath(scriptPath: string): string {
  const normalized = scriptPath.replace(/\\/g, "/");
  return normalized.replace(/\/(?:src|build)\/hooks\/[^/]+$/, "/src/hooks/hook-runner.mjs");
}

export function withAssistantEnv(command: string, assistant: string, projectDir?: string): string {
  if (process.platform === "win32") {
    const parsed = parseNodeCommand(command);
    if (parsed) {
      return [
        "node",
        commandQuote(getHookRunnerPath(parsed.scriptPath)),
        "--assistant",
        commandQuote(assistant),
        projectDir ? `--project-dir ${commandQuote(projectDir)}` : "",
        "--script",
        commandQuote(parsed.scriptPath),
        parsed.forwardedArgs ? `-- ${parsed.forwardedArgs}` : "",
      ].filter(Boolean).join(" ");
    }
  }

  return [
    `ENGRAM_ASSISTANT=${shellQuote(assistant)}`,
    projectDir ? `ENGRAM_PROJECT_DIR=${shellQuote(projectDir)}` : "",
    command,
  ].filter(Boolean).join(" ");
}

// ── Adapter interface ─────────────────────────────────────────────────────────

/**
 * AssistantAdapter — contract every AI assistant adapter must implement.
 *
 * Each adapter is responsible for:
 *   1. Detecting whether the assistant is installed on this machine.
 *   2. Registering EngramCC hooks in the assistant's config file format.
 *   3. Registering the EngramCC MCP server in the assistant's MCP config.
 */
export interface AssistantAdapter {
  /** Display name shown in the setup CLI output. */
  readonly name: string;
  /** ECC lifecycle coverage for this adapter. */
  readonly capabilities: AdapterCapabilities;

  /**
   * Returns true if this assistant appears to be installed on this machine.
   * Used by registerAll() to skip adapters for absent assistants.
   */
  isInstalled(): boolean;

  /**
   * Write hook registrations to the assistant's config file(s).
   * Idempotent — running twice must not create duplicate entries.
   *
   * @param packageRoot - Absolute path to the installed EngramCC package root.
   * @param projectRoot - Absolute path to the target project directory.
   */
  registerHooks(packageRoot: string, projectRoot: string): RegistrationResult;

  /**
   * Write the EngramCC MCP server entry to the assistant's MCP config file(s).
   * Idempotent — running twice must not create duplicate entries.
   *
   * @param packageRoot - Absolute path to the installed EngramCC package root.
   * @param projectRoot - Absolute path to the target project directory.
   */
  registerMcp(packageRoot: string, projectRoot: string): RegistrationResult;
}
