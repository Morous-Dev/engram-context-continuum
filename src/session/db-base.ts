/**
 * db-base.ts — Reusable SQLite infrastructure for the super-context plugin.
 *
 * Responsible for: lazy-loading better-sqlite3, applying WAL pragmas, defining
 * the PreparedStatement interface, providing DB file cleanup helpers, and
 * the SQLiteBase abstract base class.
 *
 * Depends on: better-sqlite3 (runtime), node:module, node:fs, node:os, node:path.
 * Depended on by: src/session/db.ts, src/memory/graph.ts, src/memory/vector.ts.
 *
 * Ported from: context-mode/src/db-base.ts (Elastic-2.0 license).
 * Changes: removed defaultDBPath (PID-based), added getPluginDBPath helper.
 */

import type DatabaseConstructor from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { createRequire } from "node:module";
import { unlinkSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Explicit interface for cached prepared statements that accept varying
 * parameter counts. better-sqlite3's generic Statement collapses under
 * ReturnType to a single-param signature, so we define our own.
 */
export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy loader
// ─────────────────────────────────────────────────────────────────────────────

let _Database: typeof DatabaseConstructor | null = null;

/**
 * Lazy-load better-sqlite3. Only resolves the native module on first call.
 * Allows hooks to start instantly even if the native addon is not yet compiled.
 *
 * @throws If better-sqlite3 cannot be loaded (not installed).
 */
export function loadDatabase(): typeof DatabaseConstructor {
  if (!_Database) {
    const require = createRequire(import.meta.url);
    _Database = require("better-sqlite3") as typeof DatabaseConstructor;
  }
  return _Database;
}

// ─────────────────────────────────────────────────────────────────────────────
// WAL setup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply WAL mode and NORMAL synchronous pragma to a database instance.
 * Must be called immediately after opening a new database connection.
 *
 * WAL mode allows concurrent readers during writes and dramatically faster
 * writes. NORMAL synchronous is safe under WAL without extra fsyncs.
 *
 * @param db - Open better-sqlite3 database instance.
 */
export function applyWALPragmas(db: DatabaseInstance): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
}

// ─────────────────────────────────────────────────────────────────────────────
// DB file helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete all three SQLite files for a given db path (main, WAL, SHM).
 * Silently ignores individual deletion errors so partial cleanup does not abort.
 *
 * @param dbPath - Base SQLite file path.
 */
export function deleteDBFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

/**
 * Safely close a database connection without throwing.
 *
 * @param db - Database instance to close.
 */
export function closeDB(db: DatabaseInstance): void {
  try { db.close(); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SQLiteBase — minimal base class for open/close/cleanup lifecycle.
 *
 * Subclasses call super(dbPath), then implement initSchema() and
 * prepareStatements(). The `db` getter exposes the raw instance to subclasses.
 */
export abstract class SQLiteBase {
  readonly #dbPath: string;
  readonly #db: DatabaseInstance;

  constructor(dbPath: string) {
    const Database = loadDatabase();
    this.#dbPath = dbPath;
    this.#db = new Database(dbPath, { timeout: 5000 });
    applyWALPragmas(this.#db);
    this.initSchema();
    this.prepareStatements();
  }

  /** Called once after WAL pragmas. Subclasses run CREATE TABLE / VIRTUAL TABLE here. */
  protected abstract initSchema(): void;

  /** Called once after schema init. Subclasses compile and cache prepared statements. */
  protected abstract prepareStatements(): void;

  /** Raw database instance — available to subclasses only. */
  protected get db(): DatabaseInstance { return this.#db; }

  /** The file path this database was opened from. */
  get dbPath(): string { return this.#dbPath; }

  /** Close the database connection without deleting files. */
  close(): void { closeDB(this.#db); }

  /**
   * Close the connection and delete all associated DB files (main, WAL, SHM).
   * Call only during session cleanup or test teardown.
   */
  cleanup(): void {
    closeDB(this.#db);
    deleteDBFiles(this.#dbPath);
  }
}
