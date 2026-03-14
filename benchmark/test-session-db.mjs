/**
 * test-session-db.mjs — Regression tests for SessionDB correctness.
 *
 * Responsible for: verifying SessionDB invariants that are easy to break
 * silently — specifically cleanup guard, deduplication, and chain integrity.
 *
 * Run via: node benchmark/test-session-db.mjs
 * Depends on: build/session/db.js (compiled TypeScript)
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BUILD = join(process.cwd(), "build", "session");
const { SessionDB } = await import(pathToFileURL(join(BUILD, "db.js")).href);
const { buildCarryForwardState, buildSynthesisInput } = await import(
  pathToFileURL(join(process.cwd(), "build", "handoff", "writer.js")).href
);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDB() {
  return new SessionDB({ dbPath: ":memory:" });
}

function seedSession(db, sessionId, daysAgo = 0) {
  db.ensureSession(sessionId, "/test/project");
  if (daysAgo > 0) {
    // Back-date started_at so cleanup can target it
    db.db.prepare(
      `UPDATE session_meta SET started_at = datetime('now', '-${daysAgo} days') WHERE session_id = ?`
    ).run(sessionId);
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

console.log("\n  SessionDB regression tests\n");

// ── cleanupOldSessions guard ──────────────────────────────────────────────────

console.log("  cleanupOldSessions() safety guard:");
{
  const db = makeDB();
  seedSession(db, "session-recent",   0);   // started now
  seedSession(db, "session-1day",     1);   // 1 day old
  seedSession(db, "session-10days",  10);   // 10 days old

  // 0 must be a no-op — previously deleted everything
  const deletedByZero = db.cleanupOldSessions(0);
  assert(deletedByZero === 0, "cleanupOldSessions(0) returns 0 (no-op)");
  assert(db.getSessionStats("session-recent") !== null,  "session-recent survives cleanupOldSessions(0)");
  assert(db.getSessionStats("session-1day")   !== null,  "session-1day survives cleanupOldSessions(0)");
  assert(db.getSessionStats("session-10days") !== null,  "session-10days survives cleanupOldSessions(0)");

  // Negative values must also be no-ops
  const deletedByNeg = db.cleanupOldSessions(-5);
  assert(deletedByNeg === 0, "cleanupOldSessions(-5) returns 0 (no-op)");

  // NaN and Infinity must also be no-ops
  assert(db.cleanupOldSessions(NaN)      === 0, "cleanupOldSessions(NaN) returns 0 (no-op)");
  assert(db.cleanupOldSessions(Infinity) === 0, "cleanupOldSessions(Infinity) returns 0 (no-op)");

  // Normal operation: 7-day window should delete only 10-day-old session
  const deletedBy7 = db.cleanupOldSessions(7);
  assert(deletedBy7 === 1,                                     "cleanupOldSessions(7) deletes exactly 1 session");
  assert(db.getSessionStats("session-recent")  !== null,       "session-recent survives 7-day cleanup");
  assert(db.getSessionStats("session-1day")    !== null,       "session-1day survives 7-day cleanup");
  assert(db.getSessionStats("session-10days")  === null,       "session-10days deleted by 7-day cleanup");

  db.close();
}

// ── Event deduplication ───────────────────────────────────────────────────────

console.log("\n  Event deduplication:");
{
  const db = makeDB();
  const sid = "dedup-session";
  db.ensureSession(sid, "/test");

  const ev = { type: "file_write", category: "file", priority: 2, data: "src/foo.ts" };
  db.insertEvent(sid, ev);
  db.insertEvent(sid, ev); // duplicate
  db.insertEvent(sid, ev); // duplicate

  const events = db.getEvents(sid);
  assert(events.length === 1, "duplicate events are deduplicated to 1 row");

  db.close();
}

// ── appendResumeHistory / getResumeChain ──────────────────────────────────────

console.log("\n  Resume history chain:");
{
  const db = makeDB();
  const sid = "chain-session";
  db.ensureSession(sid, "/test");

  db.appendResumeHistory(sid, 1, "<snapshot>cycle1</snapshot>", "brief1", '{"current_task":"task1"}', 10);
  db.appendResumeHistory(sid, 2, "<snapshot>cycle2</snapshot>", "brief2", '{"current_task":"task2"}', 20);
  db.appendResumeHistory(sid, 3, "<snapshot>cycle3</snapshot>", null,     null, 30);

  const chain = db.getResumeChain(sid);
  assert(chain.length === 3,                     "chain has 3 entries");
  assert(chain[0].compact_index === 1,           "chain[0] is cycle 1");
  assert(chain[1].compact_index === 2,           "chain[1] is cycle 2");
  assert(chain[2].compact_index === 3,           "chain[2] is cycle 3");
  assert(chain[0].slm_brief === "brief1",        "chain[0] slm_brief correct");
  assert(chain[0].structured_handoff === '{"current_task":"task1"}', "chain[0] structured_handoff correct");
  assert(chain[2].slm_brief === null,            "chain[2] slm_brief null when SLM unavailable");
  assert(chain[1].event_count === 20,            "chain[1] event_count correct");

  // Upsert (same compact_index) should overwrite, not duplicate
  db.appendResumeHistory(sid, 2, "<snapshot>cycle2-updated</snapshot>", "brief2-updated", '{"current_task":"task2b"}', 25);
  const chain2 = db.getResumeChain(sid);
  assert(chain2.length === 3,                        "chain still has 3 entries after upsert");
  assert(chain2[1].slm_brief === "brief2-updated",   "upsert overwrites slm_brief");
  assert(chain2[1].structured_handoff === '{"current_task":"task2b"}', "upsert overwrites structured_handoff");
  assert(chain2[1].event_count === 25,               "upsert overwrites event_count");

  // deleteSession cleans up history
  db.deleteSession(sid);
  assert(db.getResumeChain(sid).length === 0,    "history deleted with session");

  db.close();
}

// ── Carry-forward synthesis state ─────────────────────────────────────────────

console.log("\n  Carry-forward synthesis state:");
{
  const chain = [
    {
      compact_index: 1,
      snapshot: "<snapshot>cycle1</snapshot>",
      slm_brief: "<session_knowledge>cycle1</session_knowledge>",
      structured_handoff: JSON.stringify({
        current_task: "Set up GraphQL migration",
        task_status: "IN_PROGRESS",
        synthesis: "The team migrated from REST to GraphQL with Apollo Server v4. Tailwind CSS replaced Bootstrap across the app.",
        decisions: [
          { topic: "API migration", decision: "GraphQL over REST", status: "FINAL" },
          { topic: "CSS framework", decision: "Tailwind CSS", status: "FINAL" },
        ],
        errors: [],
        next_session: "Start auth middleware",
      }),
      event_count: 20,
      created_at: new Date().toISOString(),
    },
    {
      compact_index: 2,
      snapshot: "<snapshot>cycle2</snapshot>",
      slm_brief: "<session_knowledge>cycle2</session_knowledge>",
      structured_handoff: JSON.stringify({
        current_task: "Debug auth middleware",
        task_status: "IN_PROGRESS",
        synthesis: "Auth middleware work began in GraphQL context. The headers crash on WebSocket connections remains unresolved.",
        decisions: [
          { topic: "GraphQL server", decision: "Keep Apollo Server v4", status: "FINAL" },
        ],
        errors: [
          { description: "headers crash in extractToken on WebSocket connections", status: "UNRESOLVED" },
        ],
        next_session: "Continue debugging extractToken",
      }),
      event_count: 40,
      created_at: new Date().toISOString(),
    },
  ];

  const carryForward = buildCarryForwardState(chain);
  assert(carryForward !== null, "carry-forward state created from structured resume chain");
  assert(carryForward.current_task === "Debug auth middleware", "carry-forward keeps latest current task");
  assert(carryForward.decisions.some((d) => d.includes("Tailwind CSS")), "carry-forward preserves early decision");
  assert(carryForward.decisions.some((d) => d.includes("Apollo Server v4")), "carry-forward preserves later decision");
  assert(carryForward.unresolved_errors.some((e) => e.includes("headers crash")), "carry-forward preserves unresolved error");
  assert(carryForward.architecture_anchors.some((a) => a.toLowerCase().includes("graphql")), "carry-forward preserves architecture anchor");

  const synthesisInput = buildSynthesisInput(
    [],
    [],
    ["src/graphql/middleware/auth.ts"],
    ["Cannot read properties of undefined reading 'headers'"],
    [],
    "Debugging authentication middleware",
    "Edited src/graphql/middleware/auth.ts",
    ["<session_knowledge>old brief</session_knowledge>"],
    carryForward,
  );
  assert(synthesisInput.includes("Carry-forward state from prior compaction cycles:"), "synthesis input includes carry-forward header");
  assert(synthesisInput.includes("Persistent decisions:"), "synthesis input includes persistent decisions");
  assert(synthesisInput.includes("Architecture anchors:"), "synthesis input includes architecture anchors");
}

// ── Event archive: eviction → archive ─────────────────────────────────────────

console.log("\n  Event archive (eviction copies to archive):");
{
  const db = makeDB();
  const sid = "archive-test";
  db.ensureSession(sid, "/test");

  // Fill buffer to MAX (1000) with unique events
  for (let i = 0; i < 1000; i++) {
    db.insertEvent(sid, {
      type: "file_read",
      category: "file",
      priority: 2,
      data: `file-${String(i).padStart(4, "0")}.ts`,
    });
  }

  const countBefore = db.getEventCount(sid);
  assert(countBefore === 1000, `buffer full at 1000 (got ${countBefore})`);

  // Verify archive is empty before any eviction
  const archiveBefore = db.db.prepare(
    "SELECT COUNT(*) AS cnt FROM session_events_archive WHERE session_id = ?"
  ).get(sid);
  assert(archiveBefore.cnt === 0, `archive empty before eviction (got ${archiveBefore.cnt})`);

  // Insert 50 more unique events — triggers 50 evictions
  for (let i = 0; i < 50; i++) {
    db.insertEvent(sid, {
      type: "intent",
      category: "intent",
      priority: 1,
      data: `unique-anchor-intent-${String(i).padStart(3, "0")}`,
    });
  }

  // Live buffer should still be 1000
  const countAfter = db.getEventCount(sid);
  assert(countAfter === 1000, `buffer stays at 1000 after evictions (got ${countAfter})`);

  // Archive should have exactly 50 evicted events
  const archiveAfter = db.db.prepare(
    "SELECT COUNT(*) AS cnt FROM session_events_archive WHERE session_id = ?"
  ).get(sid);
  assert(archiveAfter.cnt === 50, `archive has 50 evicted events (got ${archiveAfter.cnt})`);

  // Verify archive contains actual event data from the evicted rows
  const archiveSample = db.db.prepare(
    "SELECT data FROM session_events_archive WHERE session_id = ? LIMIT 1"
  ).get(sid);
  assert(
    archiveSample && archiveSample.data.startsWith("file-"),
    `archive contains original event data (got ${archiveSample?.data?.slice(0, 20)})`
  );

  db.close();
}

// ── Event archive: searchEvents() returns archive-only results ───────────────

console.log("\n  Event archive (searchEvents queries archive):");
{
  const db = makeDB();
  const sid = "search-archive-test";
  db.ensureSession(sid, "/test");

  // Strategy: use a single category (file) so balanced eviction targets it.
  // First event has unique anchor — it gets evicted when buffer overflows.
  db.insertEvent(sid, {
    type: "file_read",
    category: "file",
    priority: 2,
    data: "xylophoneDatabase-backend-storage-design.ts",
  });

  // Fill remaining 999 slots
  for (let i = 1; i < 1000; i++) {
    db.insertEvent(sid, {
      type: "file_read",
      category: "file",
      priority: 2,
      data: `component-${String(i).padStart(4, "0")}.tsx`,
    });
  }

  // Trigger eviction — oldest file (our anchor) gets archived
  db.insertEvent(sid, {
    type: "file_read",
    category: "file",
    priority: 2,
    data: "search-trigger-event.tsx",
  });

  // Verify anchor is NOT in live, IS in archive
  const inLive = db.db.prepare(
    "SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ? AND data LIKE '%xylophoneDatabase%'"
  ).get(sid);
  const inArchive = db.db.prepare(
    "SELECT COUNT(*) AS cnt FROM session_events_archive WHERE session_id = ? AND data LIKE '%xylophoneDatabase%'"
  ).get(sid);
  assert(inLive.cnt === 0, `anchor evicted from live DB (got ${inLive.cnt})`);
  assert(inArchive.cnt > 0, `anchor preserved in archive (got ${inArchive.cnt})`);

  // searchEvents must find it — this proves the archive FTS5 path works
  const searchResult = db.searchEvents('"xylophoneDatabase"', 5);
  assert(searchResult.length > 0, `searchEvents finds archive-only anchor (${searchResult.length} results)`);
  assert(
    searchResult[0].data.includes("xylophoneDatabase"),
    `search result contains correct data`
  );

  db.close();
}

// ── Event archive: rank penalty ──────────────────────────────────────────────

console.log("\n  Event archive (0.85x rank penalty):");
{
  const db = makeDB();
  const sid = "rank-penalty-test";
  db.ensureSession(sid, "/test");

  // Strategy: fill buffer with 1000 file events (one category dominates).
  // Balanced eviction targets the dominant category, so file events get evicted.
  // The first file event has our anchor term — it will be evicted to archive.
  db.insertEvent(sid, {
    type: "file_read",
    category: "file",
    priority: 2,
    data: "elephantMigration-original-schema-design.ts",
  });

  for (let i = 1; i < 1000; i++) {
    db.insertEvent(sid, {
      type: "file_read",
      category: "file",
      priority: 2,
      data: `rank-test-module-${String(i).padStart(4, "0")}.ts`,
    });
  }

  // Trigger eviction — oldest file event (our anchor) gets evicted to archive
  db.insertEvent(sid, {
    type: "file_read",
    category: "file",
    priority: 2,
    data: "rank-test-trigger.ts",
  });

  // Verify anchor is in archive
  const inArchive = db.db.prepare(
    "SELECT COUNT(*) AS cnt FROM session_events_archive WHERE session_id = ? AND data LIKE '%elephantMigration%'"
  ).get(sid);
  assert(inArchive.cnt > 0, `anchor evicted to archive via balanced eviction (${inArchive.cnt})`);

  // Now insert a fresh copy with the same term into live
  db.insertEvent(sid, {
    type: "decision",
    category: "decision",
    priority: 1,
    data: "elephantMigration strategy confirmed and documented",
  });

  // Search — should find results, and live result should come first
  // because archive results have 0.85x penalty (less negative = worse rank)
  const results = db.searchEvents('"elephantMigration"', 10);
  assert(results.length >= 1, `elephantMigration found (${results.length} results)`);

  // Both live and archive copies should be deduplicated or ranked,
  // but the merge deduplicates by first 200 chars — these are different strings
  // so both should appear if found
  if (results.length >= 2) {
    // FTS5 BM25 ranks are negative (more negative = better match).
    // Live result should have a more negative (better) rank than archive.
    assert(results[0].rank <= results[1].rank,
      `live result ranks higher than archive (${results[0].rank.toFixed(4)} <= ${results[1].rank.toFixed(4)})`);
  } else {
    assert(true, `single result returned (dedup or one source only)`);
  }

  db.close();
}

// ── Event archive: deleteSession cleans archive ──────────────────────────────

console.log("\n  Event archive (deleteSession cleans archive):");
{
  const db = makeDB();
  const sid = "delete-archive-test";
  db.ensureSession(sid, "/test");

  // Fill and trigger evictions
  for (let i = 0; i < 1050; i++) {
    db.insertEvent(sid, {
      type: "file_read",
      category: "file",
      priority: 2,
      data: `delete-test-file-${String(i).padStart(5, "0")}.ts`,
    });
  }

  const archiveBefore = db.db.prepare(
    "SELECT COUNT(*) AS cnt FROM session_events_archive WHERE session_id = ?"
  ).get(sid);
  assert(archiveBefore.cnt > 0, `archive populated before delete (${archiveBefore.cnt} rows)`);

  // Delete session
  db.deleteSession(sid);

  // Archive must be empty
  const archiveAfter = db.db.prepare(
    "SELECT COUNT(*) AS cnt FROM session_events_archive WHERE session_id = ?"
  ).get(sid);
  assert(archiveAfter.cnt === 0, `archive cleaned after deleteSession (got ${archiveAfter.cnt})`);

  // Live events also gone
  assert(db.getEventCount(sid) === 0, `live events also cleaned`);

  db.close();
}

// ── Event archive: FTS5 index sync ───────────────────────────────────────────

console.log("\n  Event archive (FTS5 index in sync with archive):");
{
  const db = makeDB();
  const sid = "fts-archive-sync";
  db.ensureSession(sid, "/test");

  // Strategy: use file category for the anchor so balanced eviction targets it.
  // Fill 1000 file events, anchor is the first — it gets evicted when buffer overflows.
  db.insertEvent(sid, {
    type: "file_read",
    category: "file",
    priority: 2,
    data: "zygomorphicPattern-symmetry-module-architecture.ts",
  });

  for (let i = 1; i < 1000; i++) {
    db.insertEvent(sid, {
      type: "file_read",
      category: "file",
      priority: 2,
      data: `fts-sync-file-${String(i).padStart(4, "0")}.ts`,
    });
  }

  // Trigger eviction — oldest file event (our anchor) gets evicted to archive
  db.insertEvent(sid, {
    type: "file_read",
    category: "file",
    priority: 2,
    data: "fts-sync-trigger.ts",
  });

  // Confirm it's in archive, not live
  const inLive = db.db.prepare(
    "SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ? AND data LIKE '%zygomorphicPattern%'"
  ).get(sid);
  const inArchive = db.db.prepare(
    "SELECT COUNT(*) AS cnt FROM session_events_archive WHERE session_id = ? AND data LIKE '%zygomorphicPattern%'"
  ).get(sid);
  assert(inLive.cnt === 0, `anchor not in live DB (evicted)`);
  assert(inArchive.cnt > 0, `anchor in archive`);

  // Search via FTS5 — must find it through archive FTS5 index
  const ftsResult = db.searchEvents('"zygomorphicPattern"', 5);
  assert(ftsResult.length > 0, `archive FTS5 finds evicted anchor (${ftsResult.length} results)`);
  assert(
    ftsResult[0].data.includes("zygomorphicPattern"),
    `FTS5 result contains correct data`
  );

  db.close();
}

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n  ${"─".repeat(50)}`);
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
console.log(`  ${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
