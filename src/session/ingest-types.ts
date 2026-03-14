import type { SessionEvent } from "./extract.js";

export type ECCEventType =
  | "session_start"
  | "user_prompt_submit"
  | "pre_tool_use"
  | "post_tool_use"
  | "pre_compact"
  | "stop";

export type ECCSourceKind =
  | "native_hook"
  | "wrapper"
  | "transcript"
  | "synthetic";

export type ECCConfidence = "exact" | "inferred";

export interface ECCIngestEvent {
  assistant: string;
  project_id: string;
  project_dir: string;
  session_id: string;
  event_type: ECCEventType;
  source_kind: ECCSourceKind;
  confidence: ECCConfidence;
  payload: ECCEventPayload;
  timestamp: string;
}

export type ECCEventPayload =
  | SessionStartPayload
  | UserPromptPayload
  | ToolUsePayload
  | CompactPayload
  | StopPayload;

export interface SessionStartPayload {
  kind: "session_start";
}

export interface UserPromptPayload {
  kind: "user_prompt_submit";
  message: string;
  extracted_events: SessionEvent[];
}

export interface ToolUsePayload {
  kind: "pre_tool_use" | "post_tool_use";
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_result?: string | null;
  tool_output?: unknown;
  extracted_events: SessionEvent[];
}

export interface CompactPayload {
  kind: "pre_compact";
  compact_count: number;
  hardware_profile: string;
}

export interface StopPayload {
  kind: "stop";
  transcript_path?: string;
}
