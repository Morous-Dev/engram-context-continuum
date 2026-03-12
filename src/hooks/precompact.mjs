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
const BUILD_COMPRESS = join(PROJECT_ROOT, "build", "compression");
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

    const compactIndex = (stats?.compact_count ?? 0) + 1;
    const projectDir   = stats?.project_dir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

    // Collect SLM briefs from prior compaction cycles so the current brief
    // is chain-aware — it knows what happened in earlier cycles, not just this one.
    const priorBriefs = db.getResumeChain(sessionId)
      .map(row => row.slm_brief)
      .filter(Boolean);

    // Detect hardware profile once — drives parallel vs sequential execution below.
    const { getHardwareProfile } = await import(pathToFileURL(join(BUILD_COMPRESS, "index.js")).href);
    const hwProfile = getHardwareProfile();

    // ── SLM brief task (async, returns null on failure) ──────────────────────
    // Generates a dense SLM-compressed brief for budget-aware compaction recovery.
    // Replaces the verbose raw event dump with a dense SLM brief in sessionstart.
    const slmBriefTask = async () => {
      try {
        const { generateCompactBrief } = await import(
          pathToFileURL(join(BUILD_SESSION, "compact-brief.js")).href
        );
        const brief = await generateCompactBrief(cleanedEvents, {
          compactCount: compactIndex,
          sessionId,
          projectDir,
          priorBriefs,
        });
        if (brief) {
          appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] SLM brief generated (${brief.length} bytes)\n`);
        }
        return brief;
      } catch (slmErr) {
        appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] SLM brief failed: ${slmErr.message}\n`);
        return null;
      }
    };

    // ── Engram retrieval task (async, returns null on failure) ───────────────
    // Queries vector, FTS, and graph for high-fidelity original facts.
    // SLM brief handles "what was I just doing" (working memory).
    // Engram retrieval handles "what key decisions and facts persist" (long-term memory).
    // Embedding path uses MiniLM ONNX (CPU); SLM brief uses GGUF (GPU) — no contention.
    const engramRetrievalTask = async () => {
      try {
        const BUILD_MEMORY = join(PROJECT_ROOT, "build", "memory");

        const { buildRetrievalQuery, retrieveEngrams, formatEngramsForContext } = await import(
          pathToFileURL(join(BUILD_SESSION, "engram-retrieval.js")).href
        );
        const { VectorDB } = await import(pathToFileURL(join(BUILD_MEMORY, "vector.js")).href);
        const { GraphDB } = await import(pathToFileURL(join(BUILD_MEMORY, "graph.js")).href);
        const { getCompressor } = await import(pathToFileURL(join(BUILD_COMPRESS, "index.js")).href);

        const { queryText, ftsTerms, graphSeeds } = buildRetrievalQuery(cleanedEvents);

        if (queryText.length <= 20) return null;

        const vectorDB = new VectorDB(dbPath);
        let graphDB = null;
        try { graphDB = new GraphDB(dbPath); } catch { /* graph unavailable */ }

        const compressor = getCompressor();
        const embedFn = async (texts) => compressor.embed(texts);

        const result = await retrieveEngrams(
          queryText, ftsTerms, graphSeeds,
          vectorDB, db, graphDB, projectDir, embedFn,
        );

        let context = null;
        if (result.engrams.length > 0) {
          context = formatEngramsForContext(result);
          appendFileSync(DEBUG_LOG,
            `[${new Date().toISOString()}] Engram retrieval: ${result.engrams.length} engrams ` +
            `(vec:${result.vectorHits} fts:${result.ftsHits} graph:${result.graphHits}) in ${result.retrievalMs}ms\n`
          );
        }

        try { vectorDB.close(); } catch { /* ignore */ }
        try { graphDB?.close(); } catch { /* ignore */ }

        return context;
      } catch (engramErr) {
        appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] Engram retrieval failed: ${engramErr.message}\n`);
        return null;
      }
    };

    // ── Execute: parallel on power hardware, sequential elsewhere ────────────
    let slmBrief = null;
    let engramContext = null;

    if (hwProfile === "power") {
      // Power profile: SLM brief (GPU) and engram retrieval (CPU) use different
      // compute resources — safe to run concurrently. Cuts PreCompact latency
      // by the longer of the two tasks instead of their sum.
      appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] PreCompact: parallel mode (${hwProfile})\n`);
      [slmBrief, engramContext] = await Promise.all([slmBriefTask(), engramRetrievalTask()]);
    } else {
      // Standard/minimal: sequential to avoid resource contention on CPU-only machines
      appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] PreCompact: sequential mode (${hwProfile})\n`);
      slmBrief = await slmBriefTask();
      engramContext = await engramRetrievalTask();
    }

    // Write to the current-snapshot table (sessionstart.mjs reads this for
    // immediate post-compaction injection — overwrite model is correct here).
    db.upsertResume(sessionId, snapshot, allEvents.length, slmBrief, engramContext);

    // Also append to the history chain (one row per cycle, never overwritten).
    // The stop hook reads the full chain to synthesize the end-of-session handoff
    // across the entire arc of a long multi-compaction session.
    db.appendResumeHistory(sessionId, compactIndex, snapshot, slmBrief, allEvents.length);

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
