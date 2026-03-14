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

try {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  const projectDir = getProjectDir();
  const sessionId = getSessionId(input);
  const projectId = getProjectId(projectDir);
  const assistant = process.env.ENGRAM_ASSISTANT ?? "unknown";

  const { prepareCompaction } = await import(pathToFileURL(join(BUILD_SESSION, "ingest.js")).href);
  await prepareCompaction({
    assistant,
    project_id: projectId,
    project_dir: projectDir,
    session_id: sessionId,
    event_type: "pre_compact",
    source_kind: "native_hook",
    confidence: "exact",
    payload: {
      kind: "pre_compact",
      compact_count: 0,
      hardware_profile: "",
    },
    timestamp: new Date().toISOString(),
  });
} catch {
  // Hooks must never block the session.
}

console.log(JSON.stringify({}));
