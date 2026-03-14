#!/usr/bin/env node
import "./suppress-stderr.mjs";

import {
  readStdin,
  getSessionId,
  getProjectDir,
  getProjectId,
} from "./session-helpers.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HOOK_DIR, "..", "..");
const BUILD_SESSION = join(PROJECT_ROOT, "build", "session");

let additionalContext = "";

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const projectDir = getProjectDir();
  const sessionId = getSessionId(input);
  const projectId = getProjectId(projectDir);
  const assistant = process.env.ENGRAM_ASSISTANT ?? "unknown";

  const { ingestEvent } = await import(pathToFileURL(join(BUILD_SESSION, "ingest.js")).href);
  const result = await ingestEvent({
    assistant,
    project_id: projectId,
    project_dir: projectDir,
    session_id: sessionId,
    event_type: "post_tool_use",
    source_kind: "native_hook",
    confidence: "exact",
    payload: {
      kind: "post_tool_use",
      tool_name: input.tool_name ?? "unknown",
      tool_input: input.tool_input ?? {},
      tool_result: typeof input.tool_response === "string"
        ? input.tool_response
        : JSON.stringify(input.tool_response ?? input.tool_output ?? ""),
      tool_output: input.tool_output ?? null,
      extracted_events: [],
    },
    timestamp: new Date().toISOString(),
  });

  additionalContext = result.additionalContext ?? "";
} catch {
  // Hooks must never block the session.
}

if (additionalContext) {
  console.log(JSON.stringify({ additionalContext }));
}
