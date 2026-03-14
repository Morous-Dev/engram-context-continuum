import type { ECCIngestEvent } from "../session/ingest-types.js";

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
  postToolEvent: ECCIngestEvent;
}

function getPromptText(input: Record<string, unknown>): string | null {
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
        extracted_events: [],
      },
    },
    postToolEvent: {
      ...base,
      event_type: "post_tool_use",
      source_kind: "wrapper",
      confidence: "inferred",
      payload: {
        kind: "post_tool_use",
        tool_name: toolName,
        tool_input: toolInput,
        tool_result: null,
        tool_output: null,
        extracted_events: [],
      },
    },
  };
}
