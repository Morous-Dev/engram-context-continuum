#!/usr/bin/env node
import "./suppress-stderr.mjs";

import {
  readStdin,
  getSessionId,
  getProjectDir,
  getProjectId,
  getSessionDBPath,
  getProjectLogsDir,
} from "./session-helpers.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HOOK_DIR, "..", "..");
const BUILD_SESSION = join(PROJECT_ROOT, "build", "session");
const BUILD_ADAPTERS = join(PROJECT_ROOT, "build", "adapters");
const DEBUG_LOG = join(getProjectLogsDir(), "codex-hook-debug.log");
const SHOULD_INJECT_COMPACT = process.env.ENGRAM_CODEX_COMPACT_INJECT !== "0";

function logDebug(message) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${message}\n`, "utf-8");
  } catch {
    // Best-effort logging only.
  }
}

const contextBlocks = [];

try {
  const raw = await readStdin();
  process.env.ENGRAM_HOOK_INPUT_JSON = raw;
  const input = raw.trim() ? JSON.parse(raw) : {};
  const projectDir = getProjectDir();
  const fallbackSessionId = getSessionId(input);
  const projectId = getProjectId(projectDir);
  const assistant = process.env.ENGRAM_ASSISTANT ?? "codex";
  const timestamp = new Date().toISOString();

  const { syncCodexTranscript } = await import(pathToFileURL(join(BUILD_ADAPTERS, "codex-transcript.js")).href);
  const { shouldCodexTriggerCompaction } = await import(pathToFileURL(join(BUILD_ADAPTERS, "codex-plug.js")).href);
  const { ingestEvent, ingestPrompt, prepareCompaction } = await import(pathToFileURL(join(BUILD_SESSION, "ingest.js")).href);
  const { SessionDB } = await import(pathToFileURL(join(BUILD_SESSION, "db.js")).href);

  const synced = await syncCodexTranscript({
    assistant,
    projectDir,
    projectId,
    fallbackSessionId,
    timestamp,
  });

  logDebug(
    `pre_tool_use fallback_session=${fallbackSessionId} transcript=${synced.transcriptPath ?? "missing"} prompts=${synced.promptEvents.length} tools=${synced.toolEvents.length}`,
  );

  for (const promptEvent of synced.promptEvents) {
    const promptResult = await ingestPrompt(promptEvent);
    if (promptResult.additionalContext) contextBlocks.push(promptResult.additionalContext);
  }

  for (const toolEvent of synced.toolEvents) {
    const toolResult = await ingestEvent(toolEvent);
    if (toolResult.additionalContext) contextBlocks.push(toolResult.additionalContext);
  }

  const lastCompactionTool = [...synced.toolEvents]
    .reverse()
    .map(event => event.payload.kind === "post_tool_use" ? event.payload.tool_name : "")
    .find(Boolean);

  if (lastCompactionTool) {
    const db = new SessionDB({ dbPath: getSessionDBPath() });
    try {
      db.ensureSession(synced.sessionId, projectDir);
      const stats = db.getSessionStats(synced.sessionId);
      if (shouldCodexTriggerCompaction(lastCompactionTool, stats?.event_count ?? 0, stats?.compact_count ?? 0)) {
        const compaction = await prepareCompaction({
          assistant,
          project_id: projectId,
          project_dir: projectDir,
          session_id: synced.sessionId,
          event_type: "pre_compact",
          source_kind: "synthetic",
          confidence: "inferred",
          payload: {
            kind: "pre_compact",
            compact_count: (stats?.compact_count ?? 0) + 1,
            hardware_profile: "",
          },
          timestamp: new Date().toISOString(),
        });

        if (SHOULD_INJECT_COMPACT) {
          // Mirror sessionstart.mjs (source=compact) behavior: inject the
          // compacted snapshot + brief back into Codex so it can continue with a
          // small, updated state instead of relying on full prior context.
          const pieces = [
            compaction.snapshot || "",
            compaction.slm_brief || "",
            compaction.engram_context || "",
          ].filter(Boolean);
          if (pieces.length > 0) {
            contextBlocks.push(pieces.join(""));
            logDebug(`compaction injection blocks=${pieces.length} chars=${pieces.join("").length}`);
          }
        }
        logDebug(`prepared compaction for session=${synced.sessionId} tool=${lastCompactionTool}`);
      }
    } finally {
      db.close();
    }
  }
} catch (err) {
  logDebug(`pre_tool_use failed: ${err?.message ?? String(err)}`);
}

if (contextBlocks.length > 0) {
  console.log(JSON.stringify({ additionalContext: [...new Set(contextBlocks)].join("\n") }));
}
