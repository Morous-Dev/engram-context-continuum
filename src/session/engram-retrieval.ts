/**
 * engram-retrieval.ts — Context-aware retrieval engine for compaction recovery.
 *
 * Responsible for: querying the VectorDB (semantic similarity), FTS5 (keyword
 * relevance), and knowledge graph (relational traversal) to retrieve high-fidelity
 * original facts at compaction time. This is the Engram paradigm — store everything,
 * retrieve what's needed, instead of compressing everything into a lossy summary.
 *
 * Architecture:
 *   1. Build a query from recent events (last 2 cycles' prompts + decisions)
 *   2. Run 3 parallel retrieval paths:
 *      a. Vector similarity search (cosine distance via sqlite-vec)
 *      b. FTS5 keyword search (BM25 ranking)
 *      c. Graph traversal (BFS from decision/error seed nodes)
 *   3. Merge, deduplicate, and rank results by source confidence
 *   4. Apply relevance threshold (truth gating) — discard low-confidence results
 *   5. Format as <retrieved_engrams> XML block for injection
 *
 * Trade-off mitigations (per user research):
 *   - Context Rot: originals are retrieved, not summaries — no information loss
 *   - Logic Collapse: graph edges preserve decision→consequence chains
 *   - Recursive Errors: retrieval bypasses the compression chain entirely
 *   - Lost-in-the-Middle: only top-N relevant engrams injected (targeted, not bulk)
 *   - Trust Gating: confidence scores from cosine distance + BM25 rank signal quality
 *
 * Depends on: src/memory/vector.ts (VectorDB),
 *             src/memory/graph.ts (GraphDB),
 *             src/session/db.ts (SessionDB, FTS5 search),
 *             src/compression/tier2.ts (embedding generation via getCompressor).
 * Depended on by: src/hooks/precompact.mjs.
 */

import type { StoredEvent } from "./db.js";
import type { VectorSearchResult } from "../memory/vector.js";
import type { GraphNode } from "../memory/graph.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single retrieved engram with provenance and confidence metadata. */
export interface RetrievedEngram {
  /** Original content text (uncompressed, from source). */
  content: string;
  /** Retrieval source: which engine found this engram. */
  source: "vector" | "fts" | "graph";
  /** Confidence score: 0.0 (low) to 1.0 (high). */
  confidence: number;
  /** Event category if known (decision, error, task, file, rule). */
  category?: string;
  /** Event type if known (e.g. decision, error_runtime, file_write). */
  type?: string;
}

/** Result of the full retrieval pipeline. */
export interface EngramRetrievalResult {
  /** Retrieved engrams, sorted by confidence descending. */
  engrams: RetrievedEngram[];
  /** Number of vector results before dedup/filtering. */
  vectorHits: number;
  /** Number of FTS results before dedup/filtering. */
  ftsHits: number;
  /** Number of graph nodes before dedup/filtering. */
  graphHits: number;
  /** Total retrieval time in milliseconds. */
  retrievalMs: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum engrams to inject. Prevents attention dilution (lost-in-the-middle).
 * Each engram is ~50-300 chars, so 25 engrams ≈ 2-5K tokens — bounded cost.
 */
const MAX_ENGRAMS = 25;

/** Minimum confidence to include an engram (truth gating threshold). */
const MIN_CONFIDENCE = 0.35;

/** Maximum vector search results to request (pre-filter). */
const VECTOR_SEARCH_LIMIT = 15;

/** Maximum FTS results to request (pre-filter). */
const FTS_SEARCH_LIMIT = 15;

/** Maximum graph traversal depth. */
const GRAPH_MAX_DEPTH = 2;

/** Maximum graph seed nodes to start BFS from. */
const GRAPH_MAX_SEEDS = 5;

// ── Query builder ─────────────────────────────────────────────────────────────

/**
 * Build a retrieval query from recent session events.
 * Extracts the most semantically meaningful content from recent prompts,
 * decisions, errors, and tasks — these are the "retrieval cues" that
 * trigger memory recall (the Engram paradigm).
 *
 * @param events - All session events (cleaned).
 * @returns Object with a combined text query for vector/FTS and seed labels for graph.
 */
export function buildRetrievalQuery(events: StoredEvent[]): {
  /** Combined text for vector embedding and FTS search. */
  queryText: string;
  /** Seed labels for graph BFS (decision/error/task labels). */
  graphSeeds: string[];
  /** Individual FTS query terms extracted from recent events. */
  ftsTerms: string[];
} {
  // Take recent events by category for query construction
  const recentPrompts = events
    .filter(e => e.category === "prompt")
    .slice(-3)
    .map(e => e.data);

  const recentDecisions = events
    .filter(e => e.category === "decision")
    .slice(-5)
    .map(e => e.data);

  const recentErrors = events
    .filter(e => e.category === "error")
    .slice(-3)
    .map(e => e.data);

  const recentTasks = events
    .filter(e => e.category === "task")
    .slice(-2)
    .map(e => e.data);

  // Combined query text for vector similarity
  const queryText = [
    ...recentPrompts,
    ...recentDecisions,
    ...recentErrors,
    ...recentTasks,
  ].join(" ").slice(0, 2000);

  // Graph seeds: decisions and errors are the best BFS starting points
  // because they connect to files, tasks, and other decisions via edges
  const graphSeeds = [...recentDecisions, ...recentErrors].slice(0, GRAPH_MAX_SEEDS);

  // FTS terms: extract distinctive keywords from recent events
  // Strip common words and short tokens for better BM25 precision
  const allText = [...recentPrompts, ...recentDecisions, ...recentTasks].join(" ");
  const ftsTerms = extractKeyTerms(allText);

  return { queryText, graphSeeds, ftsTerms };
}

/**
 * Extract distinctive search terms from text for FTS5 queries.
 * Filters out common English words and short tokens.
 */
function extractKeyTerms(text: string): string[] {
  const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must", "to", "of",
    "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
    "during", "before", "after", "above", "below", "between", "out", "off",
    "over", "under", "again", "further", "then", "once", "here", "there",
    "when", "where", "why", "how", "all", "each", "every", "both", "few",
    "more", "most", "other", "some", "such", "no", "nor", "not", "only",
    "own", "same", "so", "than", "too", "very", "just", "but", "and", "or",
    "this", "that", "these", "those", "it", "its", "we", "our", "you", "your",
    "they", "them", "their", "he", "she", "him", "her", "his", "my", "me",
    "what", "which", "who", "whom", "i", "if",
    "file", "use", "using", "used", "set", "get", "new", "make", "add",
  ]);

  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  // Deduplicate and take top terms by frequency
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([term]) => term);
}

// ── Retrieval pipeline ────────────────────────────────────────────────────────

/**
 * Run the full Engram retrieval pipeline.
 *
 * Queries 3 retrieval backends in parallel (vector, FTS, graph), merges and
 * deduplicates results, applies confidence thresholds, and returns ranked
 * engrams ready for injection.
 *
 * @param queryText    - Combined text query for vector embedding + FTS.
 * @param ftsTerms     - Individual terms for FTS5 BM25 search.
 * @param graphSeeds   - Label strings to seed BFS graph traversal.
 * @param vectorDB     - Open VectorDB instance (or null if unavailable).
 * @param sessionDB    - Open SessionDB instance (for FTS search).
 * @param graphDB      - Open GraphDB instance (or null if unavailable).
 * @param projectDir   - Project directory for graph queries.
 * @param embedFn      - Function to generate embeddings for the query text.
 * @returns RetrievalResult with ranked engrams and statistics.
 */
export async function retrieveEngrams(
  queryText: string,
  ftsTerms: string[],
  graphSeeds: string[],
  vectorDB: { search: (q: number[], limit?: number) => VectorSearchResult[]; isAvailable: () => boolean } | null,
  sessionDB: { searchEvents: (q: string, limit?: number) => Array<{ data: string; type: string; category: string; rank: number }> } | null,
  graphDB: { findNode: (p: string, label: string) => GraphNode | null; getNeighbors: (id: string, depth?: number) => GraphNode[]; getNodes: (p: string, type?: string, limit?: number) => GraphNode[] } | null,
  projectDir: string,
  embedFn: ((texts: string[]) => Promise<{ embeddings: number[][]; dimensions: number }>) | null,
): Promise<EngramRetrievalResult> {
  const start = Date.now();
  const allEngrams: RetrievedEngram[] = [];
  let vectorHits = 0;
  let ftsHits = 0;
  let graphHits = 0;

  // ── Path A: Vector similarity search ────────────────────────────────────────
  if (vectorDB?.isAvailable() && embedFn && queryText.length > 10) {
    try {
      const embedResult = await embedFn([queryText]);
      if (embedResult.embeddings.length > 0 && embedResult.dimensions > 0) {
        const queryEmbedding = embedResult.embeddings[0];
        const results = vectorDB.search(queryEmbedding, VECTOR_SEARCH_LIMIT);
        vectorHits = results.length;

        for (const r of results) {
          // Convert cosine distance to confidence: distance 0 → confidence 1.0,
          // distance 1.0 → confidence 0.0. Cosine distance range is [0, 2].
          const confidence = Math.max(0, 1.0 - r.distance);
          const meta = r.metadata as Record<string, unknown>;
          allEngrams.push({
            content: r.content,
            source: "vector",
            confidence,
            category: typeof meta.category === "string" ? meta.category : undefined,
            type: typeof meta.type === "string" ? meta.type : undefined,
          });
        }
      }
    } catch {
      // Vector search failure is non-fatal — other paths may succeed
    }
  }

  // ── Path B: FTS5 keyword search ─────────────────────────────────────────────
  if (sessionDB && ftsTerms.length > 0) {
    try {
      // Build FTS5 query: OR-join terms for broader recall.
      // Strip any embedded quotes to prevent FTS5 syntax injection.
      const ftsQuery = ftsTerms.map(t => `"${t.replace(/"/g, "")}"`).join(" OR ");
      const results = sessionDB.searchEvents(ftsQuery, FTS_SEARCH_LIMIT);
      ftsHits = results.length;

      for (const r of results) {
        // BM25 rank is negative (more negative = more relevant in FTS5).
        // Normalize to [0, 1]: rank -20 → 1.0, rank 0 → 0.0
        const normalizedRank = Math.min(1.0, Math.abs(r.rank) / 20);
        allEngrams.push({
          content: r.data,
          source: "fts",
          confidence: normalizedRank,
          category: r.category,
          type: r.type,
        });
      }
    } catch {
      // FTS failure is non-fatal
    }
  }

  // ── Path C: Graph traversal ─────────────────────────────────────────────────
  if (graphDB && graphSeeds.length > 0) {
    try {
      const seenLabels = new Set<string>();
      for (const seedLabel of graphSeeds) {
        const node = graphDB.findNode(projectDir, seedLabel.slice(0, 200));
        if (!node) continue;

        const neighbors = graphDB.getNeighbors(node.id, GRAPH_MAX_DEPTH);
        graphHits += neighbors.length;

        for (const n of neighbors) {
          if (seenLabels.has(n.label)) continue;
          seenLabels.add(n.label);

          // Graph nodes get moderate confidence — they're related by structure
          // but may not be directly relevant to the current query
          allEngrams.push({
            content: n.label,
            source: "graph",
            confidence: 0.55,
            category: n.type,
            type: n.type,
          });
        }
      }
    } catch {
      // Graph failure is non-fatal
    }
  }

  // ── Path D: Persistent anchor facts (always-include) ───────────────────────
  // These are high-priority decisions and error nodes from the knowledge graph
  // that should always survive compaction. This is the "anchor file" concept
  // from Gemini's framework — key architectural choices that must persist.
  // No semantic query needed — we pull the most important nodes directly.
  if (graphDB) {
    try {
      const decisionNodes = graphDB.getNodes(projectDir, "decision", 10);
      const errorNodes = graphDB.getNodes(projectDir, "error", 5);

      for (const node of [...decisionNodes, ...errorNodes]) {
        allEngrams.push({
          content: node.label,
          source: "graph",
          confidence: 0.70, // High base confidence — always relevant
          category: node.type,
          type: node.type,
        });
      }
    } catch {
      // Graph query failure is non-fatal
    }
  }

  // ── Merge, deduplicate, rank, filter ────────────────────────────────────────
  const deduped = deduplicateEngrams(allEngrams);
  const filtered = deduped
    .filter(e => e.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_ENGRAMS);

  return {
    engrams: filtered,
    vectorHits,
    ftsHits,
    graphHits,
    retrievalMs: Date.now() - start,
  };
}

/**
 * Deduplicate engrams by content similarity.
 * If the same content appears from multiple sources, keep the highest-confidence one
 * and boost its confidence (multi-source corroboration = higher trust).
 */
function deduplicateEngrams(engrams: RetrievedEngram[]): RetrievedEngram[] {
  const byContent = new Map<string, RetrievedEngram>();

  for (const e of engrams) {
    // Normalize for comparison: lowercase, collapse whitespace
    const key = e.content.toLowerCase().replace(/\s+/g, " ").trim();

    const existing = byContent.get(key);
    if (existing) {
      // Multi-source corroboration: boost confidence by 15%
      if (e.confidence > existing.confidence) {
        e.confidence = Math.min(1.0, e.confidence + 0.15);
        byContent.set(key, e);
      } else {
        existing.confidence = Math.min(1.0, existing.confidence + 0.15);
      }
    } else {
      byContent.set(key, e);
    }
  }

  return [...byContent.values()];
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format retrieved engrams as an XML block for injection into Claude's context.
 *
 * The format is designed to:
 *   - Signal high-confidence facts with explicit confidence scores
 *   - Group by category (decisions, errors, tasks, files) for coherent reading
 *   - Be concise: one line per engram, no prose wrapping
 *   - Include source attribution so Claude knows where each fact came from
 *
 * @param result - RetrievalResult from retrieveEngrams().
 * @returns Formatted XML string, or empty string if no engrams.
 */
export function formatEngramsForContext(result: EngramRetrievalResult): string {
  if (result.engrams.length === 0) return "";

  const lines: string[] = [];
  lines.push(`<retrieved_engrams count="${result.engrams.length}" retrieval_ms="${result.retrievalMs}">`);

  // Group by category for coherent reading
  const grouped = new Map<string, RetrievedEngram[]>();
  for (const e of result.engrams) {
    const cat = e.category ?? "other";
    (grouped.get(cat) ?? (grouped.set(cat, []), grouped.get(cat)!)).push(e);
  }

  // Emit in priority order: decisions → errors → tasks → rules → files → other
  const categoryOrder = ["decision", "error", "task", "rule", "file", "concept", "other"];
  for (const cat of categoryOrder) {
    const items = grouped.get(cat);
    if (!items || items.length === 0) continue;

    lines.push(`  <${cat}s>`);
    for (const e of items) {
      const conf = e.confidence.toFixed(2);
      // Escape XML special chars in content
      const safe = e.content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      lines.push(`    <engram confidence="${conf}" source="${e.source}">${safe}</engram>`);
    }
    lines.push(`  </${cat}s>`);
  }

  lines.push(`</retrieved_engrams>`);
  return "\n" + lines.join("\n");
}
