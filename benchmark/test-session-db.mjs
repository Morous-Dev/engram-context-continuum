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

  db.appendResumeHistory(sid, 1, "<snapshot>cycle1</snapshot>", "brief1", 10);
  db.appendResumeHistory(sid, 2, "<snapshot>cycle2</snapshot>", "brief2", 20);
  db.appendResumeHistory(sid, 3, "<snapshot>cycle3</snapshot>", null,     30);

  const chain = db.getResumeChain(sid);
  assert(chain.length === 3,                     "chain has 3 entries");
  assert(chain[0].compact_index === 1,           "chain[0] is cycle 1");
  assert(chain[1].compact_index === 2,           "chain[1] is cycle 2");
  assert(chain[2].compact_index === 3,           "chain[2] is cycle 3");
  assert(chain[0].slm_brief === "brief1",        "chain[0] slm_brief correct");
  assert(chain[2].slm_brief === null,            "chain[2] slm_brief null when SLM unavailable");
  assert(chain[1].event_count === 20,            "chain[1] event_count correct");

  // Upsert (same compact_index) should overwrite, not duplicate
  db.appendResumeHistory(sid, 2, "<snapshot>cycle2-updated</snapshot>", "brief2-updated", 25);
  const chain2 = db.getResumeChain(sid);
  assert(chain2.length === 3,                        "chain still has 3 entries after upsert");
  assert(chain2[1].slm_brief === "brief2-updated",   "upsert overwrites slm_brief");
  assert(chain2[1].event_count === 25,               "upsert overwrites event_count");

  // deleteSession cleans up history
  db.deleteSession(sid);
  assert(db.getResumeChain(sid).length === 0,    "history deleted with session");

  db.close();
}

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n  ${"─".repeat(50)}`);
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
console.log(`  ${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
