import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionEvent } from "../session/extract.js";
import type { ECCIngestEvent } from "../session/ingest-types.js";

const CODEX_SESSION_ID_RE = /^[a-f0-9-]{36}$/i;
const STATE_FILE = "codex-transcript-state.json";
const SKIP_TOOL_NAMES = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "request_user_input",
  "update_plan",
  "view_image",
]);
const SKIP_TOOL_PREFIXES = ["mcp__engram-cc__"];

interface CodexTranscriptState {
  sessionId: string;
  transcriptPath: string;
  offset: number;
  remainder: string;
  pendingCalls: Record<string, PendingToolCall>;
}

interface PendingToolCall {
  name: string;
  input: string;
  timestamp: string;
}

interface TranscriptFileMatch {
  sessionId: string;
  transcriptPath: string;
}

interface SyncOptions {
  assistant: string;
  projectDir: string;
  projectId: string;
  fallbackSessionId: string;
  timestamp: string;
  resetState?: boolean;
}

export interface SyncCodexTranscriptResult {
  sessionId: string;
  transcriptPath: string | null;
  promptEvents: ECCIngestEvent[];
  toolEvents: ECCIngestEvent[];
  notes: string[];
}

interface TranscriptRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

function normalizePathForCompare(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameProjectDir(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function getCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function getCodexSessionsRoot(): string {
  return join(getCodexHome(), "sessions");
}

function getStatePath(projectDir: string): string {
  const logsDir = join(projectDir, ".engram-cc", "logs");
  mkdirSync(logsDir, { recursive: true });
  return join(logsDir, STATE_FILE);
}

function loadState(projectDir: string): CodexTranscriptState | null {
  const statePath = getStatePath(projectDir);
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<CodexTranscriptState>;
    if (
      typeof parsed.sessionId === "string" &&
      typeof parsed.transcriptPath === "string" &&
      typeof parsed.offset === "number" &&
      typeof parsed.remainder === "string" &&
      parsed.pendingCalls &&
      typeof parsed.pendingCalls === "object"
    ) {
      return {
        sessionId: parsed.sessionId,
        transcriptPath: parsed.transcriptPath,
        offset: parsed.offset,
        remainder: parsed.remainder,
        pendingCalls: parsed.pendingCalls as Record<string, PendingToolCall>,
      };
    }
  } catch {
    // Ignore corrupt state.
  }
  return null;
}

function saveState(projectDir: string, state: CodexTranscriptState): void {
  writeFileSync(getStatePath(projectDir), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function clearCodexTranscriptState(projectDir: string): void {
  try {
    rmSync(getStatePath(projectDir), { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function collectJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  return files.sort((left, right) => {
    try {
      return statSync(right).mtimeMs - statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function readPrefix(filePath: string, maxBytes = 8192): string {
  const fd = openSync(filePath, "r");
  try {
    const size = Math.min(fstatSync(fd).size, maxBytes);
    if (size <= 0) return "";
    const buffer = Buffer.alloc(size);
    const bytes = readSync(fd, buffer, 0, size, 0);
    return buffer.toString("utf-8", 0, bytes);
  } finally {
    closeSync(fd);
  }
}

function readFirstLine(filePath: string): string {
  const prefix = readPrefix(filePath);
  const [line = ""] = prefix.split(/\r?\n/, 1);
  return line;
}

function parseSessionMeta(filePath: string): TranscriptFileMatch | null {
  try {
    const line = readFirstLine(filePath);
    if (!line) return null;
    const record = JSON.parse(line) as TranscriptRecord;
    if (record.type !== "session_meta") return null;
    const payload = record.payload ?? {};
    const sessionId = typeof payload.id === "string" ? payload.id : "";
    if (!CODEX_SESSION_ID_RE.test(sessionId)) return null;
    return {
      sessionId,
      transcriptPath: filePath,
    };
  } catch {
    return null;
  }
}

function readSessionMetaProjectDir(filePath: string): string {
  try {
    const line = readFirstLine(filePath);
    if (!line) return "";
    const record = JSON.parse(line) as TranscriptRecord;
    if (record.type !== "session_meta") return "";
    const payload = record.payload ?? {};
    return typeof payload.cwd === "string" ? payload.cwd : "";
  } catch {
    return "";
  }
}

function findTranscriptBySessionId(sessionId: string): TranscriptFileMatch | null {
  if (!CODEX_SESSION_ID_RE.test(sessionId)) return null;
  const files = collectJsonlFiles(getCodexSessionsRoot());
  const exactName = `${sessionId}.jsonl`;
  const match = files.find((filePath) => basename(filePath).endsWith(exactName));
  if (!match) return null;
  return parseSessionMeta(match);
}

function findLatestTranscriptForProject(projectDir: string): TranscriptFileMatch | null {
  const files = collectJsonlFiles(getCodexSessionsRoot());
  for (const filePath of files) {
    const transcriptProjectDir = readSessionMetaProjectDir(filePath);
    if (!transcriptProjectDir || !sameProjectDir(transcriptProjectDir, projectDir)) continue;
    const meta = parseSessionMeta(filePath);
    if (meta) return meta;
  }
  return null;
}

function resolveTranscript(
  projectDir: string,
  fallbackSessionId: string,
  existing: CodexTranscriptState | null,
  resetState: boolean,
): TranscriptFileMatch | null {
  if (!resetState && existing?.transcriptPath && existsSync(existing.transcriptPath)) {
    const meta = parseSessionMeta(existing.transcriptPath);
    if (meta && sameProjectDir(readSessionMetaProjectDir(existing.transcriptPath), projectDir)) {
      return meta;
    }
  }

  const bySessionId = findTranscriptBySessionId(fallbackSessionId);
  if (bySessionId && sameProjectDir(readSessionMetaProjectDir(bySessionId.transcriptPath), projectDir)) {
    return bySessionId;
  }

  return findLatestTranscriptForProject(projectDir);
}

function readAppendedChunk(filePath: string, offset: number): { chunk: string; nextOffset: number } {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const safeOffset = size < offset ? 0 : offset;
    const length = Math.max(0, size - safeOffset);
    if (length === 0) {
      return { chunk: "", nextOffset: size };
    }
    const buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, safeOffset);
    return {
      chunk: buffer.toString("utf-8", 0, bytes),
      nextOffset: safeOffset + bytes,
    };
  } finally {
    closeSync(fd);
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function shouldSkipTool(name: string): boolean {
  if (!name) return true;
  if (SKIP_TOOL_NAMES.has(name)) return true;
  return SKIP_TOOL_PREFIXES.some(prefix => name.startsWith(prefix));
}

export function extractApplyPatchEvents(patch: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  const lines = patch.split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith("*** Add File: ")) {
      events.push({
        type: "file_write",
        category: "file",
        data: line.slice("*** Add File: ".length).trim(),
        priority: 1,
      });
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      events.push({
        type: "file_edit",
        category: "file",
        data: line.slice("*** Update File: ".length).trim(),
        priority: 1,
      });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      events.push({
        type: "file_edit",
        category: "file",
        data: line.slice("*** Delete File: ".length).trim(),
        priority: 1,
      });
    }
  }

  return events;
}

function buildPromptEvent(
  message: string,
  timestamp: string,
  opts: SyncOptions,
  sessionId: string,
): ECCIngestEvent | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  return {
    assistant: opts.assistant,
    project_id: opts.projectId,
    project_dir: opts.projectDir,
    session_id: sessionId,
    event_type: "user_prompt_submit",
    source_kind: "transcript",
    confidence: "exact",
    payload: {
      kind: "user_prompt_submit",
      message: trimmed,
      extracted_events: [],
    },
    timestamp,
  };
}

function buildToolEvent(
  name: string,
  inputText: string,
  toolResult: string | null,
  timestamp: string,
  opts: SyncOptions,
  sessionId: string,
): ECCIngestEvent | null {
  if (shouldSkipTool(name)) return null;

  if (name === "shell_command") {
    const args = parseJsonObject(inputText);
    const command = typeof args.command === "string" ? args.command : "";
    const exitCodeMatch = (toolResult ?? "").match(/Exit code:\s*(-?\d+)/i);
    const exitCode = exitCodeMatch ? Number.parseInt(exitCodeMatch[1] ?? "0", 10) : 0;
    return {
      assistant: opts.assistant,
      project_id: opts.projectId,
      project_dir: opts.projectDir,
      session_id: sessionId,
      event_type: "post_tool_use",
      source_kind: "transcript",
      confidence: "exact",
      payload: {
        kind: "post_tool_use",
        tool_name: "Bash",
        tool_input: command ? { command } : {},
        tool_result: toolResult,
        tool_output: { isError: Number.isFinite(exitCode) && exitCode !== 0 },
        extracted_events: [],
      },
      timestamp,
    };
  }

  if (name === "apply_patch") {
    const extractedEvents = extractApplyPatchEvents(inputText);
    if (extractedEvents.length === 0) return null;
    const onlyWrites = extractedEvents.every(event => event.type === "file_write");
    return {
      assistant: opts.assistant,
      project_id: opts.projectId,
      project_dir: opts.projectDir,
      session_id: sessionId,
      event_type: "post_tool_use",
      source_kind: "transcript",
      confidence: "exact",
      payload: {
        kind: "post_tool_use",
        tool_name: onlyWrites ? "Write" : "Edit",
        tool_input: { files: extractedEvents.map(event => event.data) },
        tool_result: toolResult,
        tool_output: { isError: false },
        extracted_events: extractedEvents,
      },
      timestamp,
    };
  }

  const parsedInput = parseJsonObject(inputText);
  return {
    assistant: opts.assistant,
    project_id: opts.projectId,
    project_dir: opts.projectDir,
    session_id: sessionId,
    event_type: "post_tool_use",
    source_kind: "transcript",
    confidence: "exact",
    payload: {
      kind: "post_tool_use",
      tool_name: name,
      tool_input: parsedInput,
      tool_result: toolResult,
      tool_output: null,
      extracted_events: [],
    },
    timestamp,
  };
}

function ensureState(
  projectDir: string,
  fallbackSessionId: string,
  existing: CodexTranscriptState | null,
  resetState: boolean,
): { state: CodexTranscriptState | null; notes: string[] } {
  const notes: string[] = [];
  const match = resolveTranscript(projectDir, fallbackSessionId, existing, resetState);
  if (!match) {
    notes.push("codex transcript not found");
    return { state: null, notes };
  }

  const nextState: CodexTranscriptState = (
    !resetState &&
    existing &&
    existing.transcriptPath === match.transcriptPath &&
    existing.sessionId === match.sessionId
  ) ? existing : {
    sessionId: match.sessionId,
    transcriptPath: match.transcriptPath,
    offset: 0,
    remainder: "",
    pendingCalls: {},
  };

  notes.push(`using transcript ${match.transcriptPath}`);
  return { state: nextState, notes };
}

export async function syncCodexTranscript(opts: SyncOptions): Promise<SyncCodexTranscriptResult> {
  const existing = loadState(opts.projectDir);
  const { state, notes } = ensureState(
    opts.projectDir,
    opts.fallbackSessionId,
    existing,
    opts.resetState === true,
  );

  if (!state) {
    return {
      sessionId: opts.fallbackSessionId,
      transcriptPath: null,
      promptEvents: [],
      toolEvents: [],
      notes,
    };
  }

  const { chunk, nextOffset } = readAppendedChunk(state.transcriptPath, state.offset);
  state.offset = nextOffset;

  const combined = state.remainder + chunk;
  const lines = combined.split(/\r?\n/);
  state.remainder = combined.endsWith("\n") || combined.endsWith("\r") ? "" : (lines.pop() ?? "");

  const promptEvents: ECCIngestEvent[] = [];
  const toolEvents: ECCIngestEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: TranscriptRecord;
    try {
      record = JSON.parse(trimmed) as TranscriptRecord;
    } catch {
      continue;
    }

    const timestamp = typeof record.timestamp === "string" ? record.timestamp : opts.timestamp;
    const payload = record.payload ?? {};

    if (record.type === "session_meta") {
      if (typeof payload.id === "string" && CODEX_SESSION_ID_RE.test(payload.id)) {
        state.sessionId = payload.id;
      }
      continue;
    }

    if (record.type === "event_msg" && payload.type === "user_message") {
      const promptEvent = buildPromptEvent(
        typeof payload.message === "string" ? payload.message : "",
        timestamp,
        opts,
        state.sessionId || opts.fallbackSessionId,
      );
      if (promptEvent) promptEvents.push(promptEvent);
      continue;
    }

    if (record.type !== "response_item") continue;

    if (payload.type === "function_call") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const name = typeof payload.name === "string" ? payload.name : "";
      if (!callId || !name) continue;
      state.pendingCalls[callId] = {
        name,
        input: typeof payload.arguments === "string" ? payload.arguments : "",
        timestamp,
      };
      continue;
    }

    if (payload.type === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const pending = callId ? state.pendingCalls[callId] : undefined;
      if (!pending) continue;
      delete state.pendingCalls[callId];
      const toolEvent = buildToolEvent(
        pending.name,
        pending.input,
        typeof payload.output === "string" ? payload.output : "",
        timestamp,
        opts,
        state.sessionId || opts.fallbackSessionId,
      );
      if (toolEvent) toolEvents.push(toolEvent);
      continue;
    }

    if (payload.type === "custom_tool_call" && payload.status === "completed") {
      const name = typeof payload.name === "string" ? payload.name : "";
      const input = typeof payload.input === "string" ? payload.input : "";
      const toolEvent = buildToolEvent(
        name,
        input,
        "completed",
        timestamp,
        opts,
        state.sessionId || opts.fallbackSessionId,
      );
      if (toolEvent) toolEvents.push(toolEvent);
    }
  }

  saveState(opts.projectDir, state);

  return {
    sessionId: state.sessionId || opts.fallbackSessionId,
    transcriptPath: state.transcriptPath,
    promptEvents,
    toolEvents,
    notes,
  };
}
