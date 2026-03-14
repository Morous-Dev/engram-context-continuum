import type { ECCIngestEvent } from "../session/ingest-types.js";
import type { SessionEvent } from "../session/extract.js";

export interface CodexPreToolContext {
  assistant: string;
  project_id: string;
  project_dir: string;
  session_id: string;
  timestamp: string;
}

export interface CodexHookTranslation {
  promptEvent: ECCIngestEvent | null;
  preToolEvent: ECCIngestEvent;
}

const COMPACTION_TOOLS = new Set(["Edit", "Write", "Bash", "AskUserQuestion"]);

export function getPromptText(input: Record<string, unknown>): string | null {
  const direct = input.prompt ?? input.message;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const toolInput = input.tool_input;
  if (toolInput && typeof toolInput === "object") {
    for (const value of Object.values(toolInput as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 20) {
        return value.trim();
      }
    }
  }

  return null;
}

function buildPlannedToolEvent(toolName: string, toolInput: Record<string, unknown>): SessionEvent {
  const context = `${toolName} ${JSON.stringify(toolInput)}`.trim().slice(0, 300);
  return {
    type: "tool_use",
    category: "tool",
    data: context,
    priority: 3,
  };
}

export function shouldCodexTriggerCompaction(
  toolName: string,
  eventCount: number,
  compactCount: number,
): boolean {
  if (!COMPACTION_TOOLS.has(toolName)) return false;
  const threshold = 900 + (compactCount * 150);
  return eventCount >= threshold;
}

export function translateCodexPreToolUse(
  input: Record<string, unknown>,
  context: CodexPreToolContext,
): CodexHookTranslation {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "unknown";
  const toolInput = input.tool_input && typeof input.tool_input === "object"
    ? input.tool_input as Record<string, unknown>
    : {};
  const promptText = getPromptText(input);

  const base = {
    assistant: context.assistant,
    project_id: context.project_id,
    project_dir: context.project_dir,
    session_id: context.session_id,
    timestamp: context.timestamp,
  };

  return {
    promptEvent: promptText ? {
      ...base,
      event_type: "user_prompt_submit",
      source_kind: "wrapper",
      confidence: "inferred",
      payload: {
        kind: "user_prompt_submit",
        message: promptText,
        extracted_events: [],
      },
    } : null,
    preToolEvent: {
      ...base,
      event_type: "pre_tool_use",
      source_kind: "native_hook",
      confidence: "exact",
      payload: {
        kind: "pre_tool_use",
        tool_name: toolName,
        tool_input: toolInput,
        tool_result: null,
        tool_output: null,
        // Codex only gives us the pre-tool hook natively. Record the planned tool
        // at low priority rather than speculating on side effects before execution.
        extracted_events: [buildPlannedToolEvent(toolName, toolInput)],
      },
    },
  };
}
