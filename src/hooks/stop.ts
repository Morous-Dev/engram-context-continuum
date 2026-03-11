/**
 * stop.ts — Stop hook: writes YAML handoff + updates graph and working memory.
 *
 * Responsible for: executing the session teardown pipeline when Claude Code
 * signals a session end. Reads the session DB, parses the transcript JSONL,
 * writes the YAML handoff file for the next session, updates the knowledge
 * graph, and merges session data into the working memory ledger.
 *
 * This hook is run via `bun run src/hooks/stop.ts` — Bun handles TypeScript
 * natively without a separate compile step.
 *
 * Execution contract: this hook MUST always exit 0. Any failure in the
 * handoff pipeline must be swallowed. A failing Stop hook can prevent
 * Claude Code from exiting cleanly.
 *
 * Depends on: src/session/db.ts, src/handoff/dedup.ts, src/handoff/writer.ts,
 *             src/memory/working.ts, src/memory/graph.ts, src/memory/vector.ts,
 *             src/tokenization/auditor.ts, src/compression/index.ts.
 * Depended on by: Claude Code Stop hook system.
 */

import { SessionDB } from "../session/db.js";
import { extractTranscriptContext } from "../handoff/dedup.js";
import { buildHandoffFromEvents, writeHandoff } from "../handoff/writer.js";
import {
  readWorkingMemory, mergeWorkingMemory, writeWorkingMemory,
} from "../memory/working.js";
import { GraphDB, updateGraphFromEvents } from "../memory/graph.js";
import { VectorDB } from "../memory/vector.js";
import { auditSessionEvents } from "../tokenization/auditor.js";
import { getCompressor } from "../compression/index.js";
import { getProjectDBPath } from "../project-id.js";
import { join } from "node:path";

// ── stdin reader ──────────────────────────────────────────────────────────────

/**
 * Read all of stdin as a string.
 *
 * @returns Promise resolving to the full stdin content.
 */
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

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Get the per-project SQLite DB path using stable project UUID.
 * Delegates to getProjectDBPath() — path: ~/.engram-cc/sessions/<uuid>.db
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns Absolute path to the SQLite DB file.
 */
function getDBPath(projectDir: string): string {
  return getProjectDBPath(projectDir);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── 1. Read hook input from stdin ──
  let sessionId = "";
  let transcriptPath = "";
  let projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();

  try {
    const raw = await readStdin();
    if (raw.trim()) {
      const input = JSON.parse(raw) as {
        session_id?: string;
        sessionId?: string;
        transcript_path?: string;
        cwd?: string;
      };
      sessionId = input.session_id ?? input.sessionId ?? "";
      transcriptPath = input.transcript_path ?? "";
      if (input.cwd) projectDir = input.cwd;
    }
  } catch {
    // stdin parse failure — continue with env fallbacks
  }

  // Derive session ID from transcript path if not provided directly
  if (!sessionId && transcriptPath) {
    const match = transcriptPath.match(/([a-f0-9-]{36})\.jsonl$/);
    if (match) sessionId = match[1];
  }
  if (!sessionId) sessionId = `stop-${Date.now()}`;

  // ── 2. Open SessionDB and read events ──
  const dbPath = getDBPath(projectDir);
  let db: SessionDB | null = null;
  let events: ReturnType<SessionDB["getEvents"]> = [];

  try {
    db = new SessionDB({ dbPath });
    events = db.getEvents(sessionId);
  } catch {
    // DB unavailable — continue without events (handoff still writes from transcript)
  }

  // ── 3. Audit events — remove high-severity ghost tokens ──
  let cleanedEvents = events;
  try {
    const audit = auditSessionEvents(events);
    cleanedEvents = audit.cleanedEvents;
  } catch { /* audit failure — use original events */ }

  // ── 4. Parse transcript JSONL ──
  let transcriptContext = null;
  try {
    transcriptContext = extractTranscriptContext(transcriptPath);
  } catch { /* transcript unavailable — handoff will use DB events only */ }

  // ── 5. Read working memory ──
  let workingMem = null;
  try {
    workingMem = readWorkingMemory(projectDir);
  } catch { /* working memory unreadable — will create fresh */ }

  // ── 6. Build and write YAML handoff ──
  // getCompressor() is called here so the same singleton is reused in step 8.
  const compressor = getCompressor();
  console.error(`[EngramCC:stop] session=${sessionId}, events=${cleanedEvents.length}, compressor=${compressor.tier}`);
  try {
    const handoffData = await buildHandoffFromEvents(
      sessionId,
      projectDir,
      cleanedEvents,
      workingMem,
      transcriptContext,
      compressor,
    );
    console.error(`[EngramCC:stop] handoff built: headline=${(handoffData.headline ?? "").slice(0, 80)}`);
    writeHandoff(handoffData, projectDir);
    console.error(`[EngramCC:stop] handoff written to ${projectDir}/.engram-cc/handoff.yaml`);
  } catch (err) {
    console.error(`[EngramCC:stop] handoff write failed:`, err);
  }

  // ── 7. Update knowledge graph ──
  let graphDB: GraphDB | null = null;
  try {
    graphDB = new GraphDB(dbPath);
    updateGraphFromEvents(graphDB, projectDir, sessionId, cleanedEvents);
    console.error(`[EngramCC:stop] knowledge graph updated`);
  } catch (err) {
    console.error(`[EngramCC:stop] graph update failed:`, err);
  } finally {
    try { graphDB?.close(); } catch { /* ignore */ }
  }

  // ── 8. Vector store: embed significant events and populate vec_procedures ──
  let vectorDB: VectorDB | null = null;
  try {
    vectorDB = new VectorDB(dbPath);
    console.error(`[EngramCC:stop] vector store available=${vectorDB.isAvailable()}`);
    if (vectorDB.isAvailable()) {
      // Select high-value events for embedding: decisions and P1 task/rule events
      const embedTargets = cleanedEvents.filter(
        e => e.category === "decision" || (e.priority === 1 && (e.category === "task" || e.category === "rule")),
      ).slice(-30); // Cap at 30 to keep embedding time bounded

      if (embedTargets.length > 0) {
        // Reuses the compressor singleton already initialised in step 6.
        const result = await compressor.embed(embedTargets.map(e => e.data));
        if (result.embeddings.length === result.embeddings.length && result.dimensions > 0) {
          for (let i = 0; i < result.embeddings.length; i++) {
            const ev = embedTargets[i];
            const embedding = result.embeddings[i];
            if (ev && embedding) {
              vectorDB.upsert(
                `${sessionId}:${ev.id}`,
                embedding,
                ev.data,
                { session_id: sessionId, category: ev.category, type: ev.type },
              );
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[EngramCC:stop] vector store failed:`, err);
  } finally {
    try { vectorDB?.close(); } catch { /* ignore */ }
  }

  // ── 9. Merge session data into working memory ──
  try {
    const filesModified = cleanedEvents
      .filter(e => e.type === "file_write" || e.type === "file_edit")
      .map(e => e.data);
    const decisions = cleanedEvents
      .filter(e => e.category === "decision")
      .map(e => e.data.slice(0, 200));

    const updated = mergeWorkingMemory(workingMem, {
      sessionId,
      projectDir,
      decisions,
      filesModified,
    });
    writeWorkingMemory(projectDir, updated);
    console.error(`[EngramCC:stop] working memory updated: ${decisions.length} decisions, ${filesModified.length} files`);
  } catch (err) {
    console.error(`[EngramCC:stop] working memory failed:`, err);
  }

  // ── 10. Close DB ──
  try { db?.close(); } catch { /* ignore */ }
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Wrap in try/catch — Stop hook must always exit 0
main().catch(() => {}).finally(() => process.exit(0));
