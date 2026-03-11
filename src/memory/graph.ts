/**
 * graph.ts — Semantic memory: SQLite-backed knowledge graph.
 *
 * Responsible for: managing graph_nodes and graph_edges tables in the same
 * SQLite file as the session DB, BFS traversal for neighbor queries, and
 * inserting file/concept/decision nodes from session events. This is the
 * Phase 4 semantic memory layer.
 *
 * Design: opens the SAME SQLite file as SessionDB (WAL mode allows concurrent
 * connections from the same process). Creates graph tables if they don't exist.
 *
 * Depends on: src/session/db-base.ts (loadDatabase, applyWALPragmas),
 *             node:crypto (node ID hashing).
 * Depended on by: src/hooks/stop.ts.
 */

import { loadDatabase, applyWALPragmas } from "../session/db-base.js";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { createHash } from "node:crypto";
import { getProjectId } from "../project-id.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Valid node types in the knowledge graph. */
export type NodeType = "file" | "decision" | "rule" | "concept" | "task" | "error";

/** Valid edge relation types. */
export type RelationType = "modifies" | "imports" | "references" | "blocks" | "resolves" | "relates_to";

/** A graph node row. */
export interface GraphNode {
  id: string;
  project_dir: string;
  type: NodeType;
  label: string;
  properties: string; // JSON
  created_at: string;
  session_id: string;
}

/** A graph edge row. */
export interface GraphEdge {
  id: string;
  project_dir: string;
  from_node: string;
  to_node: string;
  relation: RelationType;
  properties: string; // JSON
  created_at: string;
}

// ── GraphDB ───────────────────────────────────────────────────────────────────

/**
 * GraphDB — manages the semantic knowledge graph for a project.
 *
 * Opens the same SQLite file as SessionDB (by design — single file per project).
 * Creates graph_nodes and graph_edges tables if they don't exist.
 */
export class GraphDB {
  private readonly db: DatabaseInstance;

  /**
   * @param dbPath - Absolute path to the project's SQLite DB file.
   *                 Must be the same path as used by SessionDB.
   */
  constructor(dbPath: string) {
    const Database = loadDatabase();
    this.db = new Database(dbPath, { timeout: 5000 });
    applyWALPragmas(this.db);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id          TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        type        TEXT NOT NULL,
        label       TEXT NOT NULL,
        properties  TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        session_id  TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_gn_project ON graph_nodes(project_dir);
      CREATE INDEX IF NOT EXISTS idx_gn_type    ON graph_nodes(project_dir, type);
      CREATE INDEX IF NOT EXISTS idx_gn_label   ON graph_nodes(project_dir, label);

      CREATE TABLE IF NOT EXISTS graph_edges (
        id          TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        from_node   TEXT NOT NULL REFERENCES graph_nodes(id),
        to_node     TEXT NOT NULL REFERENCES graph_nodes(id),
        relation    TEXT NOT NULL,
        properties  TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_ge_from ON graph_edges(from_node);
      CREATE INDEX IF NOT EXISTS idx_ge_to   ON graph_edges(to_node);
    `);
  }

  // ── Node operations ──────────────────────────────────────────────────────────

  /**
   * Insert or update a graph node. Idempotent: if a node with the same
   * (project_dir, type, label) already exists, updates its session_id.
   *
   * @param projectDir - Project directory path.
   * @param type       - Node type.
   * @param label      - Human-readable node label (e.g. file path, decision text).
   * @param sessionId  - Session that last touched this node.
   * @param properties - Optional additional properties (JSON-serializable object).
   * @returns The node ID (SHA256[:16] of project_dir + type + label).
   */
  upsertNode(
    projectDir: string,
    type: NodeType,
    label: string,
    sessionId: string,
    properties?: Record<string, unknown>,
  ): string {
    // Use stable project UUID so node IDs survive folder renames
    const projectId = getProjectId(projectDir);
    const id = createHash("sha256")
      .update(`${projectId}:${type}:${label}`)
      .digest("hex")
      .slice(0, 16);

    this.db.prepare(`
      INSERT INTO graph_nodes (id, project_dir, type, label, properties, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id
    `).run(id, projectDir, type, label, JSON.stringify(properties ?? {}), sessionId);

    return id;
  }

  /**
   * Insert a directed edge between two nodes if it doesn't already exist.
   *
   * @param projectDir - Project directory path.
   * @param fromNodeId - Source node ID.
   * @param toNodeId   - Target node ID.
   * @param relation   - Edge relation type.
   * @param properties - Optional edge properties.
   */
  upsertEdge(
    projectDir: string,
    fromNodeId: string,
    toNodeId: string,
    relation: RelationType,
    properties?: Record<string, unknown>,
  ): void {
    const id = createHash("sha256")
      .update(`${fromNodeId}:${relation}:${toNodeId}`)
      .digest("hex")
      .slice(0, 16);

    this.db.prepare(`
      INSERT OR IGNORE INTO graph_edges (id, project_dir, from_node, to_node, relation, properties)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, projectDir, fromNodeId, toNodeId, relation, JSON.stringify(properties ?? {}));
  }

  /**
   * Find a node by project and label (exact match).
   *
   * @param projectDir - Project directory path.
   * @param label      - Node label to search for.
   * @returns GraphNode or null if not found.
   */
  findNode(projectDir: string, label: string): GraphNode | null {
    const row = this.db.prepare(
      `SELECT * FROM graph_nodes WHERE project_dir = ? AND label = ? LIMIT 1`
    ).get(projectDir, label) as GraphNode | undefined;
    return row ?? null;
  }

  /**
   * BFS traversal: get all nodes reachable from a node within `maxDepth` hops.
   *
   * Uses iterative BFS to avoid stack overflow on large graphs.
   *
   * @param startNodeId - Starting node ID.
   * @param maxDepth    - Maximum traversal depth (default 3).
   * @returns Array of reachable GraphNodes (excludes the start node itself).
   */
  getNeighbors(startNodeId: string, maxDepth = 3): GraphNode[] {
    const visited = new Set<string>([startNodeId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: startNodeId, depth: 0 }];
    const results: GraphNode[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      // Get all nodes connected via any edge (in either direction)
      const neighbors = this.db.prepare(`
        SELECT DISTINCT n.*
        FROM graph_nodes n
        JOIN graph_edges e ON (e.from_node = ? AND e.to_node = n.id)
                           OR (e.to_node = ? AND e.from_node = n.id)
        WHERE n.id != ?
      `).all(current.id, current.id, current.id) as GraphNode[];

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.id)) {
          visited.add(neighbor.id);
          results.push(neighbor);
          queue.push({ id: neighbor.id, depth: current.depth + 1 });
        }
      }
    }

    return results;
  }

  /**
   * Get all nodes for a project, optionally filtered by type.
   *
   * @param projectDir - Project directory path.
   * @param type       - Optional node type filter.
   * @param limit      - Maximum results (default 100).
   * @returns Array of GraphNodes.
   */
  getNodes(projectDir: string, type?: NodeType, limit = 100): GraphNode[] {
    if (type) {
      return this.db.prepare(
        `SELECT * FROM graph_nodes WHERE project_dir = ? AND type = ? ORDER BY created_at DESC LIMIT ?`
      ).all(projectDir, type, limit) as GraphNode[];
    }
    return this.db.prepare(
      `SELECT * FROM graph_nodes WHERE project_dir = ? ORDER BY created_at DESC LIMIT ?`
    ).all(projectDir, limit) as GraphNode[];
  }

  /** Close the database connection. */
  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

// ── Session event → graph ─────────────────────────────────────────────────────

/**
 * Update the knowledge graph from a list of session events.
 * Inserts file nodes for all write/edit events and decision nodes for all
 * decision events. Edges between consecutive file writes are added as
 * "relates_to" (same session proximity implies potential relationship).
 *
 * @param graph      - Open GraphDB instance.
 * @param projectDir - Project directory path.
 * @param sessionId  - Session that generated the events.
 * @param events     - Session events to process.
 */
export function updateGraphFromEvents(
  graph: GraphDB,
  projectDir: string,
  sessionId: string,
  events: Array<{ type: string; category: string; data: string }>,
): void {
  const fileNodeIds: string[] = [];

  for (const ev of events) {
    if (ev.category === "file" && (ev.type === "file_write" || ev.type === "file_edit")) {
      const nodeId = graph.upsertNode(projectDir, "file", ev.data, sessionId);
      fileNodeIds.push(nodeId);
    }

    if (ev.category === "decision") {
      graph.upsertNode(projectDir, "decision", ev.data.slice(0, 200), sessionId);
    }

    if (ev.category === "rule" && ev.type === "rule") {
      graph.upsertNode(projectDir, "rule", ev.data, sessionId);
    }

    if (ev.category === "error") {
      graph.upsertNode(projectDir, "error", ev.data.slice(0, 200), sessionId);
    }
  }

  // Link co-modified files with "relates_to" edges (modified in same session)
  // Only link non-adjacent pairs to avoid O(n²) explosion on large sessions
  for (let i = 0; i < Math.min(fileNodeIds.length, 20) - 1; i++) {
    graph.upsertEdge(projectDir, fileNodeIds[i], fileNodeIds[i + 1], "relates_to");
  }
}
