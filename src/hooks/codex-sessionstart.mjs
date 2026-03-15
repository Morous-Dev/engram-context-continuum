#!/usr/bin/env node
import {
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  getProjectDir,
  getProjectId,
  getProjectLogsDir,
  getSessionId,
  readStdin,
} from "./session-helpers.mjs";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HOOK_DIR, "..", "..");
const BUILD_SESSION = join(PROJECT_ROOT, "build", "session");
const BUILD_ADAPTERS = join(PROJECT_ROOT, "build", "adapters");
const DEBUG_LOG = join(getProjectLogsDir(), "codex-hook-debug.log");

function logDebug(message) {
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true });
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${message}\n`, "utf-8");
  } catch {
    // Best-effort logging only.
  }
}

try {
  const raw = await readStdin();
  process.env.ENGRAM_HOOK_INPUT_JSON = raw;
  const input = raw.trim() ? JSON.parse(raw) : {};
  const projectDir = getProjectDir();
  const fallbackSessionId = getSessionId(input);
  const assistant = process.env.ENGRAM_ASSISTANT ?? "codex";

  const { syncCodexTranscript } = await import(pathToFileURL(join(BUILD_ADAPTERS, "codex-transcript.js")).href);
  const { ingestEvent, ingestPrompt } = await import(pathToFileURL(join(BUILD_SESSION, "ingest.js")).href);

  const synced = await syncCodexTranscript({
    assistant,
    projectDir,
    projectId: getProjectId(projectDir),
    fallbackSessionId,
    timestamp: new Date().toISOString(),
    resetState: true,
  });

  if (synced.sessionId) {
    process.env.ENGRAM_SESSION_ID = synced.sessionId;
  }

  for (const promptEvent of synced.promptEvents) {
    await ingestPrompt(promptEvent);
  }
  for (const toolEvent of synced.toolEvents) {
    await ingestEvent(toolEvent);
  }

  logDebug(
    `session_start fallback_session=${fallbackSessionId} transcript=${synced.transcriptPath ?? "missing"} canonical_session=${synced.sessionId}`,
  );
} catch (err) {
  logDebug(`session_start sync failed: ${err?.message ?? String(err)}`);
}

const hookPath = join(dirname(fileURLToPath(import.meta.url)), "sessionstart.mjs");
await import(pathToFileURL(hookPath).href);
