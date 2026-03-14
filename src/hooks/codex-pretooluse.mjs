#!/usr/bin/env node
import "./suppress-stderr.mjs";

import {
  readStdin,
  getSessionId,
  getProjectDir,
  getProjectId,
  getSessionDBPath,
} from "./session-helpers.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HOOK_DIR, "..", "..");
const BUILD_SESSION = join(PROJECT_ROOT, "build", "session");
const BUILD_ADAPTERS = join(PROJECT_ROOT, "build", "adapters");

const contextBlocks = [];

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const projectDir = getProjectDir();
  const sessionId = getSessionId(input);
  const projectId = getProjectId(projectDir);
  const assistant = process.env.ENGRAM_ASSISTANT ?? "codex";
  const timestamp = new Date().toISOString();

  const { translateCodexPreToolUse } = await import(pathToFileURL(join(BUILD_ADAPTERS, "codex-plug.js")).href);
  const { ingestEvent, ingestPrompt, prepareCompaction } = await import(pathToFileURL(join(BUILD_SESSION, "ingest.js")).href);
  const { SessionDB } = await import(pathToFileURL(join(BUILD_SESSION, "db.js")).href);

  const translated = translateCodexPreToolUse(input, {
    assistant,
    project_id: projectId,
    project_dir: projectDir,
    session_id: sessionId,
    timestamp,
  });

  if (translated.promptEvent) {
    const promptResult = await ingestPrompt(translated.promptEvent);
    if (promptResult.additionalContext) contextBlocks.push(promptResult.additionalContext);
  }

  const preResult = await ingestEvent(translated.preToolEvent);
  if (preResult.additionalContext) contextBlocks.push(preResult.additionalContext);

  const postResult = await ingestEvent(translated.postToolEvent);
  if (postResult.additionalContext) contextBlocks.push(postResult.additionalContext);

  const db = new SessionDB({ dbPath: getSessionDBPath() });
  try {
    db.ensureSession(sessionId, projectDir);
    const stats = db.getSessionStats(sessionId);
    if ((stats?.event_count ?? 0) >= 800) {
      await prepareCompaction({
        assistant,
        project_id: projectId,
        project_dir: projectDir,
        session_id: sessionId,
        event_type: "pre_compact",
        source_kind: "wrapper",
        confidence: "inferred",
        payload: {
          kind: "pre_compact",
          compact_count: (stats?.compact_count ?? 0) + 1,
          hardware_profile: "",
        },
        timestamp: new Date().toISOString(),
      });
    }
  } finally {
    db.close();
  }
} catch {
  // Hooks must never block the session.
}

if (contextBlocks.length > 0) {
  console.log(JSON.stringify({ additionalContext: contextBlocks.join("\n") }));
}
