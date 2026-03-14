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

export function withAssistantEnv(command: string, assistant: string): string {
  return process.platform === "win32"
    ? `cmd /C "set ENGRAM_ASSISTANT=${assistant} && ${command}"`
    : `ENGRAM_ASSISTANT=${assistant} ${command}`;
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
