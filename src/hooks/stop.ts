/**
 * stop.ts — thin Stop hook wrapper around the normalized ingest pipeline.
 */

import { runStopPipeline } from "../session/ingest.js";
import { getProjectId } from "../project-id.js";

function readStdin(): Promise<string> {
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
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) as typeof input : {};
  } catch {
    input = {};
  }

  const projectDir = input.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
  const assistant = process.env.ENGRAM_ASSISTANT ?? "unknown";
  let sessionId = input.session_id ?? input.sessionId ?? "";

  if (!sessionId && input.transcript_path) {
    const match = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (match) sessionId = match[1];
  }
  if (!sessionId) sessionId = `stop-${Date.now()}`;

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
      transcript_path: input.transcript_path,
    },
    timestamp: new Date().toISOString(),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
