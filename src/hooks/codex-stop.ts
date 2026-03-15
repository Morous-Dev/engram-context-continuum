/**
 * codex-stop.ts — Codex-specific stop wrapper with final transcript sync.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearCodexTranscriptState, syncCodexTranscript } from "../adapters/codex-transcript.js";
import { runStopPipeline, ingestEvent, ingestPrompt } from "../session/ingest.js";
import { getProjectId, getRuntimeProjectDir } from "../project-id.js";

const DEBUG_LOG = join(process.env.ENGRAM_PROJECT_DIR ?? process.cwd(), ".engram-cc", "logs", "codex-hook-debug.log");

function logDebug(message: string): void {
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true });
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${message}\n`, "utf-8");
  } catch {
    // Best-effort logging only.
  }
}

function readHookInput(): Promise<string> {
  const cached = process.env.ENGRAM_HOOK_INPUT_JSON;
  if (typeof cached === "string") {
    return Promise.resolve(cached);
  }

  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  let input: {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    cwd?: string;
  } = {};

  try {
    const raw = await readHookInput();
    process.env.ENGRAM_HOOK_INPUT_JSON = raw;
    input = raw.trim() ? JSON.parse(raw) as typeof input : {};
  } catch {
    input = {};
  }

  const projectDir = input.cwd?.trim() || getRuntimeProjectDir();
  const assistant = process.env.ENGRAM_ASSISTANT ?? "codex";
  const fallbackSessionId = input.session_id ?? input.sessionId ?? "";
  const synced = await syncCodexTranscript({
    assistant,
    projectDir,
    projectId: getProjectId(projectDir),
    fallbackSessionId,
    timestamp: new Date().toISOString(),
  });

  for (const promptEvent of synced.promptEvents) {
    await ingestPrompt(promptEvent);
  }
  for (const toolEvent of synced.toolEvents) {
    await ingestEvent(toolEvent);
  }

  const sessionId = synced.sessionId || fallbackSessionId || `stop-${Date.now()}`;

  logDebug(
    `stop fallback_session=${fallbackSessionId || "missing"} transcript=${synced.transcriptPath ?? "missing"} canonical_session=${sessionId}`,
  );

  await runStopPipeline({
    assistant,
    project_id: getProjectId(projectDir),
    project_dir: projectDir,
    session_id: sessionId,
    event_type: "stop",
    source_kind: "native_hook",
    confidence: "exact",
    payload: {
      kind: "stop",
      transcript_path: input.transcript_path ?? synced.transcriptPath ?? undefined,
    },
    timestamp: new Date().toISOString(),
  });

  clearCodexTranscriptState(projectDir);
}

main().catch((err) => {
  logDebug(`stop failed: ${err instanceof Error ? err.message : String(err)}`);
}).finally(() => process.exit(0));
