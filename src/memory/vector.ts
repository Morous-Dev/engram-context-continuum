/**
 * vector.ts — Procedural memory: sqlite-vec vector store with dimension flexibility.
 *
 * Responsible for: managing the vec_procedures virtual table via the sqlite-vec
 * extension for semantic similarity search over procedural knowledge. Provides
 * explicit availability check so callers can fall back gracefully when sqlite-vec
 * is not installed.
 *
 * Dimension flexibility (Phase 2 enhancement): On construction, reads the stored
 * vec_procedures schema from sqlite_master to determine the actual stored embedding
 * dimension. This ensures search() always uses the correct dimension for whatever
 * is in the table, regardless of the constructor default arg (384). On upsert() with
 * mismatched dimensions (e.g. after upgrading from MiniLM 384-dim to BGE-large 768-dim),
 * the table is automatically dropped and recreated with the new dimension. Old vectors
 * are incompatible across embedding spaces — the Stop hook re-populates on next session end.
 *
 * Windows note: sqlite-vec on Windows requires a pre-built .dll. If the extension fails
 * to load, all operations are no-ops and isAvailable() returns false. Core ECC functionality
 * (FTS5, graph, snapshot) is unaffected — vector search degrades gracefully.
 *
 * Depends on: better-sqlite3, sqlite-vec (optional npm package),
 *             src/session/db-base.ts (loadDatabase, applyWALPragmas).
 * Depended on by: src/hooks/stop.ts, src/hooks/posttooluse.mjs,
 *                 src/hooks/userpromptsubmit.mjs, src/session/engram-retrieval.ts.
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
 *
 * Dimension flexibility: On construction, VectorDB reads the stored schema
 * from sqlite_master. If an existing table is found, its dimensions are used
 * regardless of the constructor arg — this ensures search queries always use
 * the correct dimension for the stored vectors. If the embedding model changes
 * (e.g. MiniLM 384-dim → BGE-large 768-dim), the first upsert() call with
 * mismatched dimensions automatically drops and recreates the table. Old vectors
 * are incompatible across embedding spaces and must be re-generated.
 */
export class VectorDB {
  private readonly db: DatabaseInstance;
  private readonly available: boolean;
  /**
   * Embedding dimensions for this VectorDB instance.
   * Set from stored schema if table exists, otherwise from constructor arg.
   * Mutable to allow recreation when embedding model changes.
   */
  private dimensions: number;

  /**
   * @param dbPath     - Absolute path to the project's SQLite DB file.
   * @param dimensions - Embedding vector dimensions (default 384 for MiniLM-L6).
   *                     If a stored table exists with different dimensions, the
   *                     stored dimensions are used for search compatibility.
   *                     Upsert with mismatched dims triggers table recreation.
   */
  constructor(dbPath: string, dimensions = 384) {
    const Database = loadDatabase();
    this.db = new Database(dbPath, { timeout: 5000 });
    applyWALPragmas(this.db);
    this.dimensions = dimensions;
    this.available = this.tryLoadExtension();
    if (this.available) {
      // Auto-detect stored dimensions so search queries always use the correct
      // dimension for whatever is in the table, regardless of caller's default arg.
      const storedDims = this.getStoredDimensions();
      if (storedDims !== null) {
        this.dimensions = storedDims;
      }
      this.initSchema();
    }
  }

  /**
   * Read the embedding dimension from the existing vec_procedures table schema.
   * Returns null if the table does not yet exist.
   *
   * sqlite-vec stores virtual table creation SQL in sqlite_master.
   * The dimension appears as `float[N]` in the schema.
   *
   * @returns Stored dimension count, or null if no vec_procedures table exists.
   */
  private getStoredDimensions(): number | null {
    try {
      const row = this.db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_procedures'`,
      ).get() as { sql: string } | undefined;
      if (!row?.sql) return null;
      // sqlite-vec schema format: USING vec0(embedding float[N], +id TEXT, ...)
      const match = row.sql.match(/float\[(\d+)\]/);
      if (!match) {
        // Schema exists but dimension cannot be parsed — could be a future sqlite-vec
        // format change. Log and return null (will create new table with constructor dims).
        console.error(
          `[VectorDB] Cannot parse embedding dimension from schema: ${row.sql.slice(0, 120)}`,
        );
        return null;
      }
      return parseInt(match[1]!, 10);
    } catch { return null; }
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
   * Handles embedding model upgrades automatically: if the incoming embedding
   * dimension differs from the stored table schema, the table is dropped and
   * recreated with the new dimension. Existing vectors are discarded (they are
   * incompatible with the new embedding space). The Stop hook will re-populate
   * on the next session end with the new model's vectors.
   *
   * @param id        - Unique identifier for this procedure (content-stable IDs enable
   *                    idempotent upserts — same content always maps to the same slot).
   * @param embedding - Float array of the embedding vector.
   * @param content   - Human-readable content for display.
   * @param metadata  - Arbitrary metadata object.
   */
  upsert(id: string, embedding: number[], content: string, metadata: Record<string, unknown>): void {
    if (!this.available) return;

    if (embedding.length !== this.dimensions) {
      // Dimension mismatch — either a model upgrade or a caller bug.
      // Check the stored schema: if it also has the wrong dims, this is a model
      // upgrade → drop and recreate. If stored dims match this.dimensions but
      // embedding doesn't, something is wrong with the caller — skip silently.
      const storedDims = this.getStoredDimensions();
      if (storedDims !== null && storedDims !== embedding.length) {
        // Embedding model changed (e.g. MiniLM 384 → BGE-large 768).
        // Old vectors are in a different space — useless for the new model.
        // Recreate the table with the new dimension.
        try {
          this.db.exec(`DROP TABLE IF EXISTS vec_procedures`);
          this.dimensions = embedding.length;
          this.initSchema();
          console.error(
            `[VectorDB] Embedding dimension changed ${storedDims}→${embedding.length}. ` +
            `Table recreated. Stop hook will re-populate on next session end.`,
          );
        } catch {
          return; // Recreation failed — skip silently
        }
      } else {
        // Caller passed wrong dimension or stored dims already match request
        return;
      }
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
