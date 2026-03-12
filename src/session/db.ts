/**
 * db.ts — Persistent per-project SQLite database for session events.
 *
 * Responsible for: storing session events, session metadata, resume snapshots,
 * compaction history chain (session_resume_history), and FTS5 full-text search
 * over event data. Extends SQLiteBase with all tables needed for Phases 1 and 2.
 *
 * Depends on: src/session/db-base.ts (SQLiteBase, PreparedStatement),
 *             node:crypto (SHA256 hashing for deduplication).
 * Depended on by: src/hooks/posttooluse.mjs, src/hooks/precompact.mjs,
 *                 src/hooks/sessionstart.mjs, src/hooks/userpromptsubmit.mjs,
 *                 src/hooks/stop.ts, src/memory/graph.ts.
 */

import { SQLiteBase } from "./db-base.js";
import type { PreparedStatement } from "./db-base.js";
import type { SessionEvent } from "./extract.js";
import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A stored event row from the session_events table. */
export interface StoredEvent {
  id: number;
  session_id: string;
  type: string;
  category: string;
  priority: number;
  data: string;
  source_hook: string;
  created_at: string;
  data_hash: string;
}

/** Session metadata row from the session_meta table. */
export interface SessionMeta {
  session_id: string;
  project_dir: string;
  started_at: string;
  last_event_at: string | null;
  event_count: number;
  compact_count: number;
}

/** Resume snapshot row from the session_resume table. */
export interface ResumeRow {
  snapshot: string;
  event_count: number;
  consumed: number;
  slm_brief: string | null;
  /** Retrieved engrams XML block from Engram retrieval pipeline, or null. */
  engram_context: string | null;
}

/** One row in the compaction history chain — one per compaction cycle. */
export interface ResumeHistoryRow {
  /** 1-based compaction cycle number. */
  compact_index: number;
  /** Rule-based XML resume snapshot at this compaction point. */
  snapshot: string;
  /** SLM-synthesized <session_knowledge> XML, or null if SLM was unavailable. */
  slm_brief: string | null;
  /** Number of DB events captured at the time of this compaction. */
  event_count: number;
  /** UTC ISO timestamp of when this compaction snapshot was written. */
  created_at: string;
}

/** A single FTS5 search result row. */
export interface FtsSearchResult {
  id: number;
  session_id: string;
  type: string;
  category: string;
  data: string;
  rank: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum events per session before FIFO eviction kicks in. */
const MAX_EVENTS_PER_SESSION = 1000;

/** Number of recent events to check for deduplication. */
const DEDUP_WINDOW = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Statement keys
// ─────────────────────────────────────────────────────────────────────────────

const S = {
  insertEvent: "insertEvent",
  getEvents: "getEvents",
  getEventsByType: "getEventsByType",
  getEventsByPriority: "getEventsByPriority",
  getEventsByTypeAndPriority: "getEventsByTypeAndPriority",
  getEventCount: "getEventCount",
  checkDuplicate: "checkDuplicate",
  evictLowestPriority: "evictLowestPriority",
  updateMetaLastEvent: "updateMetaLastEvent",
  ensureSession: "ensureSession",
  getSessionStats: "getSessionStats",
  incrementCompactCount: "incrementCompactCount",
  upsertResume: "upsertResume",
  getResume: "getResume",
  markResumeConsumed: "markResumeConsumed",
  appendResumeHistory: "appendResumeHistory",
  getResumeChain: "getResumeChain",
  deleteEvents: "deleteEvents",
  deleteMeta: "deleteMeta",
  deleteResume: "deleteResume",
  deleteResumeHistory: "deleteResumeHistory",
  getOldSessions: "getOldSessions",
  ftsSearch: "ftsSearch",
  ftsRebuild: "ftsRebuild",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SessionDB
// ─────────────────────────────────────────────────────────────────────────────

export class SessionDB extends SQLiteBase {
  /**
   * Cached prepared statements. Stored in a Map to avoid the JS private-field
   * inheritance issue where #field declarations in a subclass are not accessible
   * during base-class constructor calls.
   *
   * `declare` ensures TypeScript does NOT emit a field initializer at runtime.
   */
  private declare stmts: Map<string, PreparedStatement>;

  constructor(opts?: { dbPath?: string }) {
    super(opts?.dbPath ?? ":memory:");
  }

  private stmt(key: string): PreparedStatement {
    return this.stmts.get(key)!;
  }

  // ── Schema ──────────────────────────────────────────────────────────────────

  protected initSchema(): void {
    // Migration: drop session_events if data_hash is a generated column
    // (old schema used GENERATED ALWAYS AS — new schema uses explicit INSERT).
    try {
      const colInfo = this.db.pragma("table_xinfo(session_events)") as Array<{ name: string; hidden: number }>;
      const hashCol = colInfo.find((c) => c.name === "data_hash");
      if (hashCol && hashCol.hidden !== 0) {
        this.db.exec("DROP TABLE IF EXISTS session_events");
      }
    } catch { /* table doesn't exist yet */ }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT    NOT NULL,
        type       TEXT    NOT NULL,
        category   TEXT    NOT NULL,
        priority   INTEGER NOT NULL DEFAULT 2,
        data       TEXT    NOT NULL,
        source_hook TEXT   NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (datetime('now')),
        data_hash  TEXT    NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_se_session  ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_se_type     ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_se_priority ON session_events(session_id, priority);

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id   TEXT PRIMARY KEY,
        project_dir  TEXT NOT NULL,
        started_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count  INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT    NOT NULL UNIQUE,
        snapshot   TEXT    NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (datetime('now')),
        consumed   INTEGER NOT NULL DEFAULT 0,
        slm_brief  TEXT
      );
    `);

    // Migration: add slm_brief column to existing session_resume tables
    try {
      this.db.exec(`ALTER TABLE session_resume ADD COLUMN slm_brief TEXT`);
    } catch { /* column already exists */ }

    // Migration: add engram_context column for retrieved engrams from vector/FTS/graph
    try {
      this.db.exec(`ALTER TABLE session_resume ADD COLUMN engram_context TEXT`);
    } catch { /* column already exists */ }

    // Compaction history chain — one row per compaction cycle, append-only.
    // The stop hook reads the full chain to synthesize end-of-session handoffs
    // that cover the entire arc of a long multi-compaction session.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_resume_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT    NOT NULL,
        compact_index INTEGER NOT NULL,
        snapshot      TEXT    NOT NULL,
        slm_brief     TEXT,
        event_count   INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, compact_index)
      );
      CREATE INDEX IF NOT EXISTS idx_srh_session
        ON session_resume_history(session_id, compact_index);
    `);

    // Phase 2: FTS5 full-text search over session event data.
    // content= links FTS5 to session_events for BM25 ranking.
    // Triggers keep it in sync on insert and delete.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts
      USING fts5(
        data,
        type UNINDEXED,
        category UNINDEXED,
        content='session_events',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS sei_fts_ai
      AFTER INSERT ON session_events BEGIN
        INSERT INTO session_events_fts(rowid, data, type, category)
        VALUES (new.id, new.data, new.type, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS sei_fts_ad
      AFTER DELETE ON session_events BEGIN
        INSERT INTO session_events_fts(session_events_fts, rowid, data, type, category)
        VALUES ('delete', old.id, old.data, old.type, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS sei_fts_au
      AFTER UPDATE ON session_events BEGIN
        INSERT INTO session_events_fts(session_events_fts, rowid, data, type, category)
        VALUES ('delete', old.id, old.data, old.type, old.category);
        INSERT INTO session_events_fts(rowid, data, type, category)
        VALUES (new.id, new.data, new.type, new.category);
      END;
    `);
  }

  // ── Prepared statements ──────────────────────────────────────────────────────

  protected prepareStatements(): void {
    this.stmts = new Map<string, PreparedStatement>();
    const p = (key: string, sql: string) => {
      this.stmts.set(key, this.db.prepare(sql) as PreparedStatement);
    };

    p(S.insertEvent,
      `INSERT INTO session_events (session_id, type, category, priority, data, source_hook, data_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`);

    p(S.getEvents,
      `SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`);

    p(S.getEventsByType,
      `SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`);

    p(S.getEventsByPriority,
      `SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`);

    p(S.getEventsByTypeAndPriority,
      `SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`);

    p(S.getEventCount,
      `SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?`);

    p(S.checkDuplicate,
      `SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`);

    p(S.evictLowestPriority,
      `DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`);

    p(S.updateMetaLastEvent,
      `UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`);

    p(S.ensureSession,
      `INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)`);

    p(S.getSessionStats,
      `SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`);

    p(S.incrementCompactCount,
      `UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?`);

    p(S.upsertResume,
      `INSERT INTO session_resume (session_id, snapshot, event_count, slm_brief, engram_context)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         slm_brief = excluded.slm_brief,
         engram_context = excluded.engram_context,
         created_at = datetime('now'),
         consumed = 0`);

    p(S.getResume,
      `SELECT snapshot, event_count, consumed, slm_brief, engram_context FROM session_resume WHERE session_id = ?`);

    p(S.markResumeConsumed,
      `UPDATE session_resume SET consumed = 1 WHERE session_id = ?`);

    p(S.appendResumeHistory,
      `INSERT INTO session_resume_history
         (session_id, compact_index, snapshot, slm_brief, event_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, compact_index) DO UPDATE SET
         snapshot    = excluded.snapshot,
         slm_brief   = excluded.slm_brief,
         event_count = excluded.event_count,
         created_at  = datetime('now')`);

    p(S.getResumeChain,
      `SELECT compact_index, snapshot, slm_brief, event_count, created_at
       FROM session_resume_history
       WHERE session_id = ?
       ORDER BY compact_index ASC`);

    p(S.deleteEvents,        `DELETE FROM session_events         WHERE session_id = ?`);
    p(S.deleteMeta,          `DELETE FROM session_meta           WHERE session_id = ?`);
    p(S.deleteResume,        `DELETE FROM session_resume         WHERE session_id = ?`);
    p(S.deleteResumeHistory, `DELETE FROM session_resume_history WHERE session_id = ?`);

    p(S.getOldSessions,
      `SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')`);

    // FTS5 search — returns rows ranked by BM25 relevance
    p(S.ftsSearch,
      `SELECT e.id, e.session_id, e.type, e.category, e.data,
              session_events_fts.rank AS rank
       FROM session_events_fts
       JOIN session_events e ON session_events_fts.rowid = e.id
       WHERE session_events_fts MATCH ?
       ORDER BY rank
       LIMIT ?`);

    // FTS5 rebuild — re-syncs the virtual table from session_events content
    p(S.ftsRebuild,
      `INSERT INTO session_events_fts(session_events_fts) VALUES('rebuild')`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Events
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Insert a session event with SHA256 deduplication and FIFO eviction.
   *
   * Deduplication: skips if the same type + data_hash appears in the last
   * DEDUP_WINDOW events for this session. Prevents storing identical events
   * from repeated tool calls.
   *
   * Eviction: if session exceeds MAX_EVENTS_PER_SESSION, evicts the
   * lowest-priority (then oldest) event to make room.
   *
   * @param sessionId  - Session UUID.
   * @param event      - Event to insert.
   * @param sourceHook - Hook that generated this event (for provenance).
   */
  insertEvent(sessionId: string, event: SessionEvent, sourceHook = "PostToolUse"): void {
    const dataHash = createHash("sha256")
      .update(event.data)
      .digest("hex")
      .slice(0, 16)
      .toUpperCase();

    // Atomic: dedup check + eviction + insert in one transaction
    this.db.transaction(() => {
      const dup = this.stmt(S.checkDuplicate).get(sessionId, DEDUP_WINDOW, event.type, dataHash);
      if (dup) return;

      const countRow = this.stmt(S.getEventCount).get(sessionId) as { cnt: number };
      if (countRow.cnt >= MAX_EVENTS_PER_SESSION) {
        this.stmt(S.evictLowestPriority).run(sessionId);
      }

      this.stmt(S.insertEvent).run(
        sessionId, event.type, event.category, event.priority,
        event.data, sourceHook, dataHash,
      );

      this.stmt(S.updateMetaLastEvent).run(sessionId);
    })();
  }

  /**
   * Retrieve events for a session with optional filtering.
   *
   * @param sessionId - Session UUID.
   * @param opts      - Optional filter: type, minPriority, limit.
   * @returns Array of stored events in chronological order.
   */
  getEvents(sessionId: string, opts?: { type?: string; minPriority?: number; limit?: number }): StoredEvent[] {
    const limit = opts?.limit ?? 1000;
    const { type, minPriority } = opts ?? {};

    if (type && minPriority !== undefined)
      return this.stmt(S.getEventsByTypeAndPriority).all(sessionId, type, minPriority, limit) as StoredEvent[];
    if (type)
      return this.stmt(S.getEventsByType).all(sessionId, type, limit) as StoredEvent[];
    if (minPriority !== undefined)
      return this.stmt(S.getEventsByPriority).all(sessionId, minPriority, limit) as StoredEvent[];
    return this.stmt(S.getEvents).all(sessionId, limit) as StoredEvent[];
  }

  /** Get the total event count for a session. */
  getEventCount(sessionId: string): number {
    return (this.stmt(S.getEventCount).get(sessionId) as { cnt: number }).cnt;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FTS5 search
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Full-text search over session event data using FTS5 BM25 ranking.
   *
   * @param query - FTS5 query string (supports phrase, prefix, boolean operators).
   * @param limit - Maximum results to return (default 20).
   * @returns Array of matching events ranked by relevance (best match first).
   */
  searchEvents(query: string, limit = 20): FtsSearchResult[] {
    return this.stmt(S.ftsSearch).all(query, limit) as FtsSearchResult[];
  }

  /**
   * Rebuild the FTS5 index from the session_events content table.
   * Only needed after bulk deletes or if the index gets out of sync.
   */
  rebuildFts(): void {
    this.stmt(S.ftsRebuild).run();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Meta
  // ═══════════════════════════════════════════════════════════════════════════

  /** Ensure a session metadata entry exists. Idempotent (INSERT OR IGNORE). */
  ensureSession(sessionId: string, projectDir: string): void {
    this.stmt(S.ensureSession).run(sessionId, projectDir);
  }

  /** Get session statistics / metadata. */
  getSessionStats(sessionId: string): SessionMeta | null {
    return (this.stmt(S.getSessionStats).get(sessionId) as SessionMeta | undefined) ?? null;
  }

  /** Increment the compact_count for a session (tracks snapshot rebuilds). */
  incrementCompactCount(sessionId: string): void {
    this.stmt(S.incrementCompactCount).run(sessionId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Resume
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Upsert a resume snapshot for a session. Resets consumed flag on update.
   * Used by sessionstart.mjs for immediate post-compaction context injection.
   * This remains an overwrite — sessionstart only needs the latest snapshot.
   */
  upsertResume(sessionId: string, snapshot: string, eventCount?: number, slmBrief?: string | null, engramContext?: string | null): void {
    this.stmt(S.upsertResume).run(sessionId, snapshot, eventCount ?? 0, slmBrief ?? null, engramContext ?? null);
  }

  /** Retrieve the resume snapshot for a session. */
  getResume(sessionId: string): ResumeRow | null {
    return (this.stmt(S.getResume).get(sessionId) as ResumeRow | undefined) ?? null;
  }

  /** Mark the resume snapshot as consumed (already injected into conversation). */
  markResumeConsumed(sessionId: string): void {
    this.stmt(S.markResumeConsumed).run(sessionId);
  }

  /**
   * Append one compaction cycle's data to the history chain.
   * Called by precompact.mjs on every compaction — one row per cycle, never overwritten.
   * The stop hook reads the full chain via getResumeChain() to synthesize end-of-session
   * handoffs that cover the entire arc of a long multi-compaction session.
   *
   * @param sessionId    - Session UUID.
   * @param compactIndex - 1-based compaction cycle number.
   * @param snapshot     - Rule-based XML resume snapshot at this compaction point.
   * @param slmBrief     - SLM-synthesized <session_knowledge> XML, or null.
   * @param eventCount   - Total DB events at the time of this compaction.
   */
  appendResumeHistory(
    sessionId: string,
    compactIndex: number,
    snapshot: string,
    slmBrief: string | null,
    eventCount: number,
  ): void {
    this.stmt(S.appendResumeHistory).run(sessionId, compactIndex, snapshot, slmBrief, eventCount);
  }

  /**
   * Return all compaction snapshots for a session in chronological order.
   * Returns an empty array if the session never compacted or the history table
   * is empty (short sessions, sessions from before this feature was deployed).
   *
   * @param sessionId - Session UUID.
   * @returns Array of ResumeHistoryRow ordered by compact_index ASC.
   */
  getResumeChain(sessionId: string): ResumeHistoryRow[] {
    return this.stmt(S.getResumeChain).all(sessionId) as ResumeHistoryRow[];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /** Delete all data for a session (events, meta, resume, resume history). */
  deleteSession(sessionId: string): void {
    this.db.transaction(() => {
      this.stmt(S.deleteEvents).run(sessionId);
      this.stmt(S.deleteResume).run(sessionId);
      this.stmt(S.deleteResumeHistory).run(sessionId);
      this.stmt(S.deleteMeta).run(sessionId);
    })();
  }

  /**
   * Remove sessions older than maxAgeDays.
   *
   * Non-positive or non-finite values are rejected as a safe no-op — passing 0
   * would produce datetime('now', '-0 days') = now, deleting every session ever
   * created. Math.floor prevents fractional-day string injection into the SQL.
   *
   * @param maxAgeDays - Sessions older than this are deleted (default 7, must be > 0).
   * @returns Count of sessions deleted, or 0 if maxAgeDays is invalid.
   */
  cleanupOldSessions(maxAgeDays = 7): number {
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return 0;
    const oldSessions = this.stmt(S.getOldSessions).all(`-${Math.floor(maxAgeDays)}`) as Array<{ session_id: string }>;
    for (const { session_id } of oldSessions) this.deleteSession(session_id);
    return oldSessions.length;
  }
}
