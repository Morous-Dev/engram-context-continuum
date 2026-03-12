#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * sessionstart.mjs — SessionStart hook for super-context session continuity.
 *
 * Responsible for: injecting session knowledge into Claude's context at the
 * start of every session or after a compact event. Also loads the YAML handoff
 * from the previous session (if fresh, within 15 minutes) and the working
 * memory YAML for persistent cross-session preferences.
 *
 * Session lifecycle:
 * - "startup"  → Fresh session. Load handoff (tiered injection) + working memory. Cleanup old data.
 * - "compact"  → Auto-compact triggered. Inject resume snapshot + session guide.
 * - "resume"   → User used --continue. Full history; inject session guide only.
 * - "clear"    → User cleared context. No resume injection.
 *
 * Depends on: suppress-stderr.mjs, session-helpers.mjs, session-directive.mjs,
 *             build/session/db.js, build/handoff/reader.js,
 *             build/memory/working.js (compiled TypeScript).
 * Depended on by: Claude Code SessionStart hook system.
 */

import {
  readStdin, getSessionId, getSessionDBPath,
  getSessionEventsPath, getCleanupFlagPath, getHandoffFilePath,
} from "./session-helpers.mjs";
import {
  writeSessionEventsFile, buildSessionDirective,
  getSessionEvents, getLatestSessionEvents,
} from "./session-directive.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HOOK_DIR, "..", "..");
const BUILD_SESSION = join(PROJECT_ROOT, "build", "session");
const BUILD_HANDOFF = join(PROJECT_ROOT, "build", "handoff");
const BUILD_MEMORY = join(PROJECT_ROOT, "build", "memory");

let additionalContext = "";

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const source = input.source ?? "startup";

  if (source === "compact") {
    // Session was compacted — inject resume snapshot + session knowledge
    const { SessionDB } = await import(pathToFileURL(join(BUILD_SESSION, "db.js")).href);
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);

    const resume = db.getResume(sessionId);
    if (resume && !resume.consumed) {
      db.markResumeConsumed(sessionId);
      // Always inject the structural XML snapshot (cheap, ~1K tokens)
      additionalContext += "\n" + resume.snapshot;

      // Use SLM brief instead of raw event dump when available.
      // SLM brief IS the <session_knowledge> block — already formatted XML.
      // Same information at 3-5x fewer tokens, plus semantic synthesis.
      if (resume.slm_brief) {
        additionalContext += resume.slm_brief;
      } else {
        // Fallback: raw event dump (current behavior)
        const events = getSessionEvents(db, sessionId);
        if (events.length > 0) {
          const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
          additionalContext += buildSessionDirective("compact", eventMeta);
        }
      }

      // Inject retrieved engrams alongside the SLM brief.
      // These are high-fidelity original facts retrieved from VectorDB, FTS, and
      // knowledge graph — they prevent context rot by preserving exact details
      // (variable names, file paths, decision rationale) that compression loses.
      if (resume.engram_context) {
        additionalContext += resume.engram_context;
      }
    } else {
      // No resume row or already consumed — fall back to raw events
      const events = getSessionEvents(db, sessionId);
      if (events.length > 0) {
        const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
        additionalContext += buildSessionDirective("compact", eventMeta);
      }
    }

    db.close();

  } else if (source === "resume") {
    // User used --continue — clear cleanup flag, inject session guide
    try { unlinkSync(getCleanupFlagPath()); } catch { /* no flag */ }

    const { SessionDB } = await import(pathToFileURL(join(BUILD_SESSION, "db.js")).href);
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });

    const events = getLatestSessionEvents(db);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
      additionalContext += buildSessionDirective("resume", eventMeta);
    }

    db.close();

  } else if (source === "startup") {
    // Fresh session — clean slate, load handoff + working memory
    const { SessionDB } = await import(pathToFileURL(join(BUILD_SESSION, "db.js")).href);
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });

    try { unlinkSync(getSessionEventsPath()); } catch { /* no stale file */ }

    // Detect true fresh start vs --continue (which fires startup → resume).
    // If cleanup flag exists, previous session was a true fresh start — wipe data.
    const cleanupFlag = getCleanupFlagPath();
    let previousWasFresh = false;
    try { readFileSync(cleanupFlag); previousWasFresh = true; } catch { /* no flag */ }

    if (previousWasFresh) {
      // Use 1-day window, not 0 — cleanupOldSessions(0) passes '-0 days' to SQLite
      // which resolves to datetime('now'), deleting every session started before right
      // now (i.e. everything). 1 day keeps today's sessions while pruning older ones.
      db.cleanupOldSessions(1);
    } else {
      db.cleanupOldSessions(7);
    }
    // Orphan cleanup: events without matching meta rows
    db.db.exec(`DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)`);

    writeFileSync(cleanupFlag, new Date().toISOString(), "utf-8");

    // Proactively capture CLAUDE.md files — loaded as system context at startup,
    // invisible to PostToolUse hooks. Read from disk so they survive compact/resume.
    const sessionId = getSessionId(input);
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    db.ensureSession(sessionId, projectDir);

    const claudeMdPaths = [
      join(homedir(), ".claude", "CLAUDE.md"),
      join(projectDir, "CLAUDE.md"),
      join(projectDir, ".claude", "CLAUDE.md"),
    ];
    for (const p of claudeMdPaths) {
      try {
        const content = readFileSync(p, "utf-8");
        if (content.trim()) {
          db.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1 }, "SessionStart");
          db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 }, "SessionStart");
        }
      } catch { /* file doesn't exist — skip */ }
    }

    db.close();

    // Inject YAML handoff from the previous session using tiered injection:
    //   hot resume  (< 30 min)  → full handoff XML (maximum context)
    //   cold start  (≥ 30 min)  → headline-only brief (minimal tokens)
    //   no headline available   → full handoff XML as fallback
    // We pass Infinity as maxAgeMs so reader.ts never silently drops the
    // handoff — age gating is handled explicitly below.
    const FULL_INJECTION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
    try {
      const { readHandoff, formatHandoffForContext } = await import(pathToFileURL(join(BUILD_HANDOFF, "reader.js")).href);
      const handoff = readHandoff(projectDir, Infinity);
      if (handoff) {
        const handoffAge = Date.now() - new Date(handoff.timestamp).getTime();
        const isHotResume = handoffAge < FULL_INJECTION_WINDOW_MS;
        const ageMins = Math.round(handoffAge / 60000);

        if (isHotResume) {
          console.error(`[EngramCC:sessionstart] hot resume (${ageMins}min old), injecting full handoff`);
          additionalContext += "\n" + formatHandoffForContext(handoff);
        } else if (handoff.headline) {
          console.error(`[EngramCC:sessionstart] cold start (${ageMins}min old), injecting headline only`);
          additionalContext += `\n<session_brief project="${projectDir}" age="${ageMins}min ago">Last session: ${handoff.headline} — Full context available via the recall MCP tool.</session_brief>`;
        } else {
          console.error(`[EngramCC:sessionstart] cold start, no headline — falling back to full handoff`);
          additionalContext += "\n" + formatHandoffForContext(handoff);
        }
      } else {
        console.error(`[EngramCC:sessionstart] no handoff found`);
      }
    } catch (err) {
      console.error(`[EngramCC:sessionstart] handoff load failed:`, err?.message || err);
    }

    // Inject working memory (long-term preferences and conventions)
    try {
      const { readWorkingMemory, formatWorkingMemoryForContext } = await import(pathToFileURL(join(BUILD_MEMORY, "working.js")).href);
      const workingMem = readWorkingMemory(projectDir);
      if (workingMem) {
        console.error(`[EngramCC:sessionstart] working memory loaded (${workingMem.persistent_decisions?.length ?? 0} decisions, ${workingMem.frequently_modified_files?.length ?? 0} files)`);
        additionalContext += "\n" + formatWorkingMemoryForContext(workingMem);
      } else {
        console.error(`[EngramCC:sessionstart] no working memory found`);
      }
    } catch (err) {
      console.error(`[EngramCC:sessionstart] working memory load failed:`, err?.message || err);
    }
  }
  // "clear" — no action needed

} catch (err) {
  // Session continuity is best-effort — never block session start
  try {
    const { appendFileSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    const { homedir: phomedir } = await import("node:os");
    appendFileSync(
      pjoin(phomedir(), ".engram-cc", "sessionstart-debug.log"),
      `[${new Date().toISOString()}] ${err?.message || err}\n${err?.stack || ""}\n`,
    );
  } catch { /* ignore logging failure */ }
}

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
  },
}));
