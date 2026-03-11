#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * precompact.mjs — PreCompact hook for super-context session continuity.
 *
 * Responsible for: building a priority-sorted XML resume snapshot (<2KB) from
 * all captured session events, and storing it in the DB for injection after
 * compaction fires. Also triggers the ghost token auditor to prune stale events.
 *
 * Triggered when Claude Code is about to compact the conversation (at ~80% of
 * the context window by default per plugin-config.yaml).
 *
 * Depends on: suppress-stderr.mjs, session-helpers.mjs,
 *             build/session/snapshot.js, build/session/db.js,
 *             build/tokenization/auditor.js (compiled TypeScript).
 * Depended on by: Claude Code PreCompact hook system.
 */

import { readStdin, getSessionId, getSessionDBPath } from "./session-helpers.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HOOK_DIR, "..", "..");
const BUILD_SESSION = join(PROJECT_ROOT, "build", "session");
const BUILD_TOKEN = join(PROJECT_ROOT, "build", "tokenization");
const DEBUG_LOG = join(homedir(), ".claude", "super-context", "precompact-debug.log");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { buildResumeSnapshot } = await import(pathToFileURL(join(BUILD_SESSION, "snapshot.js")).href);
  const { SessionDB } = await import(pathToFileURL(join(BUILD_SESSION, "db.js")).href);
  const { auditSessionEvents } = await import(pathToFileURL(join(BUILD_TOKEN, "auditor.js")).href);

  const dbPath = getSessionDBPath();
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input);

  const allEvents = db.getEvents(sessionId);

  if (allEvents.length > 0) {
    // Run the ghost token auditor to get a cleaner event set for the snapshot.
    // High-severity ghosts (stale reads superseded by writes, redundant cwds)
    // are removed; medium/low ghosts are kept for safety.
    const { cleanedEvents } = auditSessionEvents(allEvents);

    const stats = db.getSessionStats(sessionId);
    const snapshot = buildResumeSnapshot(cleanedEvents, {
      compactCount: (stats?.compact_count ?? 0) + 1,
    });

    db.upsertResume(sessionId, snapshot, allEvents.length);
    db.incrementCompactCount(sessionId);
  }

  db.close();
} catch (err) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${err.message}\n`);
  } catch { /* silent fallback */ }
}

// PreCompact must output an empty JSON object — Claude Code requirement
console.log(JSON.stringify({}));
