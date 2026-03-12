#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * posttooluse.mjs — PostToolUse hook for super-context session continuity.
 *
 * Responsible for: capturing session events from tool calls (14+ categories)
 * and storing them in the per-project SessionDB for later resume snapshot
 * building. Also runs lightweight "subconscious retrieval" — on meaningful
 * tool calls, embeds the current context and searches the VectorDB for
 * relevant historical facts, injecting them as additionalContext so Claude
 * sees them on the next turn without spending tokens searching.
 *
 * The SLM is the subconscious brain of the CLI:
 *   - It "listens" to every tool call (captures events)
 *   - On decision-point calls, it "remembers" (vector search)
 *   - It "whispers" relevant context to Claude (additionalContext)
 *   - Claude's conscious mind decides whether to use it or not
 *
 * Performance budget:
 *   - Event capture: ~5ms (SQLite write, always runs)
 *   - Subconscious retrieval: ~100-200ms warm (embedding + vector search, conditional)
 *   - Cold start (first call): ~1-5s (MiniLM model loading via getCompressor)
 *   - Total worst case: ~250ms warm, ~5s cold (acceptable for meaningful tool calls)
 *   - Fast path (routine reads): ~5ms (retrieval skipped)
 *   - Disable retrieval: set ENGRAM_SUBCONSCIOUS=0 to skip (event capture still runs)
 *
 * Depends on: suppress-stderr.mjs, session-helpers.mjs,
 *             build/session/extract.js, build/session/db.js,
 *             build/memory/vector.js, build/compression/index.js (compiled TS).
 * Depended on by: Claude Code PostToolUse hook system.
 */

import { readStdin, getSessionId, getSessionDBPath } from "./session-helpers.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve absolute paths — relative dynamic imports fail when Claude Code
// invokes hooks from a different working directory.
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HOOK_DIR, "..", "..");
const BUILD_SESSION = join(PROJECT_ROOT, "build", "session");
const BUILD_MEMORY = join(PROJECT_ROOT, "build", "memory");
const BUILD_COMPRESS = join(PROJECT_ROOT, "build", "compression");

/** Tool calls that warrant subconscious retrieval — "decision points" where
 *  historical context would help Claude make better choices. */
const RETRIEVAL_TRIGGERS = new Set([
  "AskUserQuestion",  // Claude is asking user something — context helps
  "Edit",             // Modifying code — related decisions matter
  "Write",            // Creating new file — past patterns matter
  "Bash",             // Running commands — error history matters
]);

/** Tool calls that are too routine for retrieval — skip to save latency. */
const RETRIEVAL_SKIP = new Set([
  "Read",             // Just reading — no decision being made
  "Glob",             // File search — routine
  "Grep",             // Content search — routine
  "Skill",            // Skill invocation — internal
  "TaskCreate",       // Task management — internal
  "TaskUpdate",       // Task management — internal
  "TaskList",         // Task management — internal
  "TaskGet",          // Task management — internal
]);

let additionalContext = "";

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { extractEvents } = await import(pathToFileURL(join(BUILD_SESSION, "extract.js")).href);
  const { SessionDB } = await import(pathToFileURL(join(BUILD_SESSION, "db.js")).href);

  const dbPath = getSessionDBPath();
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input);

  db.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());

  const events = extractEvents({
    tool_name: input.tool_name,
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_response === "string"
      ? input.tool_response
      : JSON.stringify(input.tool_response ?? ""),
    tool_output: input.tool_output,
  });

  for (const event of events) {
    db.insertEvent(sessionId, event, "PostToolUse");
  }

  // ── Subconscious retrieval ──────────────────────────────────────────────────
  // On meaningful tool calls, search the VectorDB for relevant historical facts.
  // This is the "subconscious brain" — it surfaces memories without Claude asking.
  // Claude sees these as additionalContext and decides whether to use them.
  const toolName = input.tool_name ?? "";
  const subconscDisabled = process.env.ENGRAM_SUBCONSCIOUS === "0";
  const shouldRetrieve = !subconscDisabled && RETRIEVAL_TRIGGERS.has(toolName) && !RETRIEVAL_SKIP.has(toolName);

  if (shouldRetrieve && events.length > 0) {
    try {
      // Build query text from the current tool call's extracted events
      const queryText = events.map(e => e.data).join(" ").slice(0, 1000);

      if (queryText.length > 15) {
        const memories = [];

        // ── Path 1: Vector similarity search (cross-session, populated at stop) ──
        // Searches vec_procedures for semantically similar historical facts.
        // Only has data from previous sessions (vectors are written by stop hook).
        try {
          const { VectorDB } = await import(pathToFileURL(join(BUILD_MEMORY, "vector.js")).href);
          const vectorDB = new VectorDB(dbPath);

          if (vectorDB.isAvailable()) {
            const { getCompressor } = await import(pathToFileURL(join(BUILD_COMPRESS, "index.js")).href);
            const compressor = getCompressor();
            const embedResult = await compressor.embed([queryText]);

            if (embedResult.embeddings.length > 0 && embedResult.dimensions > 0) {
              const results = vectorDB.search(embedResult.embeddings[0], 5);
              for (const r of results) {
                if (r.distance < 0.65) {
                  const meta = r.metadata;
                  memories.push({
                    content: r.content,
                    category: typeof meta.category === "string" ? meta.category : "",
                    confidence: Math.max(0, 1.0 - r.distance),
                    source: "vector",
                  });
                }
              }
            }
          }

          vectorDB.close();
        } catch {
          // Vector search failure is non-fatal — FTS path may still succeed
        }

        // ── Path 2: FTS5 keyword search (current session, available immediately) ──
        // Searches session_events_fts for keyword matches in the current session's
        // events. Available from the first tool call — no dependency on stop hook.
        // This is the primary retrieval path mid-conversation.
        try {
          // Extract distinctive terms for FTS5 query (skip short/common words)
          const terms = queryText.toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length >= 4)
            .slice(0, 6);

          if (terms.length > 0) {
            // Quote terms and OR-join for broader recall. Strip embedded quotes.
            const ftsQuery = terms.map(t => `"${t.replace(/"/g, "")}"`).join(" OR ");
            const ftsResults = db.searchEvents(ftsQuery, 8);

            for (const r of ftsResults) {
              // BM25 rank is negative (more negative = more relevant).
              // Normalize: rank -20 → confidence 1.0, rank 0 → confidence 0.0
              const confidence = Math.min(1.0, Math.abs(r.rank) / 20);
              if (confidence >= 0.35) {
                memories.push({
                  content: r.data,
                  category: r.category,
                  confidence,
                  source: "fts",
                });
              }
            }
          }
        } catch {
          // FTS failure is non-fatal
        }

        // ── Deduplicate and format ──────────────────────────────────────────────
        if (memories.length > 0) {
          // Deduplicate by normalized content, keep highest confidence
          const seen = new Map();
          for (const m of memories) {
            const key = m.content.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
            const existing = seen.get(key);
            if (!existing || m.confidence > existing.confidence) {
              seen.set(key, m);
            }
          }

          // Sort by confidence descending, take top 5
          const top = [...seen.values()]
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 5);

          if (top.length > 0) {
            const lines = [`<subconscious_context source="engram_retrieval" count="${top.length}">`];
            for (const m of top) {
              const conf = m.confidence.toFixed(2);
              const safe = m.content
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
              lines.push(`  <memory category="${m.category}" confidence="${conf}" source="${m.source}">${safe}</memory>`);
            }
            lines.push(`</subconscious_context>`);
            additionalContext = lines.join("\n");
          }
        }
      }
    } catch {
      // Subconscious retrieval failure must NEVER block PostToolUse.
      // If it fails, Claude just doesn't get the extra context — no harm done.
    }
  }

  db.close();
} catch {
  // PostToolUse must never block the session — silent fallback
}

// Output: if we have subconscious context, inject it. Otherwise empty.
if (additionalContext) {
  console.log(JSON.stringify({ additionalContext }));
}
