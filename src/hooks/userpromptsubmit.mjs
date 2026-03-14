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
  const prompt = input.prompt ?? input.message ?? "";
  const trimmed = String(prompt).trim();

  const isSystemMessage = trimmed.startsWith("<task-notification>")
    || trimmed.startsWith("<system-reminder>")
    || trimmed.startsWith("<context_guidance>")
    || trimmed.startsWith("<tool-result>");

  if (trimmed && !isSystemMessage) {
    const projectDir = getProjectDir();
    const sessionId = getSessionId(input);
    const projectId = getProjectId(projectDir);
    const assistant = process.env.ENGRAM_ASSISTANT ?? "unknown";

    const { ingestPrompt } = await import(pathToFileURL(join(BUILD_SESSION, "ingest.js")).href);
    const result = await ingestPrompt({
      assistant,
      project_id: projectId,
      project_dir: projectDir,
      session_id: sessionId,
      event_type: "user_prompt_submit",
      source_kind: "native_hook",
      confidence: "exact",
      payload: {
        kind: "user_prompt_submit",
        message: prompt,
        extracted_events: [],
      },
      timestamp: new Date().toISOString(),
    });

    additionalContext = result.additionalContext ?? "";
  }
} catch {
  // Hooks must never block the session.
}

if (additionalContext) {
  console.log(JSON.stringify({ additionalContext }));
}
