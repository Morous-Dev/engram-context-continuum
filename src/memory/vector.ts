/**
 * vector.ts — Procedural memory: sqlite-vec vector store with graceful fallback.
 *
 * Responsible for: managing the vec_procedures virtual table via the sqlite-vec
 * extension for semantic similarity search over procedural knowledge. Provides
 * explicit availability check so callers can fall back gracefully when sqlite-vec
 * is not installed.
 *
 * Phase 5 note: sqlite-vec on Windows requires testing before production use.
 * If the extension fails to load, all operations are no-ops and isAvailable()
 * returns false. This ensures Phases 1–4 work correctly regardless.
 *
 * TODO: Once sqlite-vec Windows support is confirmed, remove the graceful
 * fallback and make vector search a hard requirement for Phase 5.
 *
 * Depends on: better-sqlite3, sqlite-vec (optional),
 *             src/session/db-base.ts (loadDatabase, applyWALPragmas).
 * Depended on by: src/hooks/stop.ts.
 */

import { loadDatabase, applyWALPragmas } from "../session/db-base.js";
import type { Database as DatabaseInstance } from "better-sqlite3";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A stored procedure embedding record. */
export interface ProcedureRecord {
  id: string;
  embedding: number[];
  content: string;
  metadata: Record<string, unknown>;
}

/** A vector search result. */
export interface VectorSearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Cosine distance (lower = more similar). */
  distance: number;
}

// ── VectorDB ──────────────────────────────────────────────────────────────────

/**
 * VectorDB — manages semantic embeddings for procedural memory.
 *
 * Opens the same SQLite file as SessionDB and GraphDB. Loads the sqlite-vec
 * extension to enable vector operations. Falls back gracefully if the
 * extension is unavailable.
 */
export class VectorDB {
  private readonly db: DatabaseInstance;
  private readonly available: boolean;
  /** Embedding dimensions expected. Must match the model output. */
  private readonly dimensions: number;

  /**
   * @param dbPath     - Absolute path to the project's SQLite DB file.
   * @param dimensions - Embedding vector dimensions (default 384 for MiniLM-L6).
   */
  constructor(dbPath: string, dimensions = 384) {
    const Database = loadDatabase();
    this.db = new Database(dbPath, { timeout: 5000 });
    applyWALPragmas(this.db);
    this.dimensions = dimensions;
    this.available = this.tryLoadExtension();
    if (this.available) this.initSchema();
  }

  /**
   * Try to load the sqlite-vec extension.
   *
   * @returns true if extension loaded successfully, false otherwise.
   *
   * Windows note: sqlite-vec requires a compiled .dll. The npm package
   * provides pre-built binaries but they must be tested for the target machine.
   */
  private tryLoadExtension(): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require("sqlite-vec") as { load: (db: DatabaseInstance) => void };
      sqliteVec.load(this.db);
      return true;
    } catch {
      // sqlite-vec not installed or not compatible — vector search unavailable
      return false;
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_procedures
      USING vec0(
        embedding float[${this.dimensions}],
        +id TEXT,
        +content TEXT,
        +metadata TEXT
      );
    `);
  }

  /**
   * Returns true if sqlite-vec is loaded and vector operations are available.
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Insert or replace a procedure embedding.
   * No-op if sqlite-vec is not available.
   *
   * @param id        - Unique identifier for this procedure.
   * @param embedding - Float array of the embedding vector.
   * @param content   - Human-readable content for display.
   * @param metadata  - Arbitrary metadata object.
   */
  upsert(id: string, embedding: number[], content: string, metadata: Record<string, unknown>): void {
    if (!this.available) return;
    if (embedding.length !== this.dimensions) {
      // Dimension mismatch — skip silently to avoid crashing the Stop hook
      return;
    }

    try {
      // sqlite-vec uses a special serialization for float arrays
      const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);
      this.db.prepare(`
        INSERT OR REPLACE INTO vec_procedures (embedding, id, content, metadata)
        VALUES (?, ?, ?, ?)
      `).run(embeddingBuffer, id, content, JSON.stringify(metadata));
    } catch {
      /* Silent fallback — vector insert failure must not crash the Stop hook */
    }
  }

  /**
   * Search for the nearest neighbors of a query embedding.
   * Returns empty array if sqlite-vec is not available.
   *
   * @param queryEmbedding - Float array of the query vector.
   * @param limit          - Maximum results to return (default 5).
   * @returns Array of VectorSearchResult ordered by cosine distance (ascending).
   */
  search(queryEmbedding: number[], limit = 5): VectorSearchResult[] {
    if (!this.available) return [];
    if (queryEmbedding.length !== this.dimensions) return [];

    try {
      const embeddingBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);
      const rows = this.db.prepare(`
        SELECT id, content, metadata, distance
        FROM vec_procedures
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(embeddingBuffer, limit) as Array<{
        id: string; content: string; metadata: string; distance: number;
      }>;

      return rows.map(row => ({
        id: row.id,
        content: row.content,
        metadata: (() => { try { return JSON.parse(row.metadata) as Record<string, unknown>; } catch { return {}; } })(),
        distance: row.distance,
      }));
    } catch {
      return [];
    }
  }

  /** Close the database connection. */
  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
