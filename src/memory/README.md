# src/memory — Multi-tier memory bank

## What this module is

The persistent cross-session memory layer. Three separate storage abstractions
(working, graph, vector) that all read from or write to the same per-project
SQLite file. Working memory uses YAML files for human-readable cross-session
state; graph and vector live inside the DB.

VectorDB is fully active (not stubbed). Embeddings are generated in three places:
1. **Stop hook** — bulk embeds up to 50 high-value events at session end
2. **PostToolUse** — live-indexes every significant event (decision/error/task/rule) in real-time
3. **UserPromptSubmit** — embeds user prompts and retrieves semantically relevant past context

## How it works end to end

```
PostToolUse (live continuous indexing — every significant event)
  → compressor.embed(newEventData)           ← hardware-profile-aware ONNX model
  → VectorDB.upsert(contentStableId, ...)   ← INSERT OR REPLACE, idempotent
  ↑ Available for retrieval in the same session immediately

UserPromptSubmit (semantic retrieval — every user message)
  → compressor.embed([userPrompt])
  → VectorDB.search(queryVector, 5)          ← cosine distance threshold 0.60
  → additionalContext injection              ← before Claude processes the message

Stop hook (bulk embedding — session end)
  → working.ts:mergeWorkingMemory()          ← merge session decisions + file freq
  → graph.ts:updateGraphFromEvents()         ← upsert file/decision/rule nodes + edges
  → compressor.embed(top50Events)            ← high-value events: decision, error, task, rule
  → VectorDB.upsert()                        ← stored for cross-session retrieval

PostToolUse (subconscious retrieval — decision-point calls)
  → compressor.embed([contextText])
  → VectorDB.search(queryVector, 5)          ← cross-session, cosine distance threshold 0.65
  → additionalContext injection

PreCompact (engram retrieval — at compaction boundary)
  → engram-retrieval.ts:retrieveEngrams()    ← vector + FTS5 + graph + anchor facts
  → results stored in session_resume

SessionStart hook (working memory injection)
  → working.ts:readWorkingMemory()           ← load YAML ledger
  → working.ts:formatWorkingMemoryForContext() ← render as XML block
  → inject into additionalContext
```

## Key files

| File | Purpose |
|---|---|
| `working.ts` | YAML working memory: read, write, merge, format. |
| `graph.ts` | GraphDB: SQLite nodes/edges tables + BFS traversal. |
| `vector.ts` | VectorDB: sqlite-vec procedures table with dimension flexibility and graceful fallback. |

## Schema (inside the per-project SQLite DB)

```sql
graph_nodes    -- id (sha256[:16] of project:type:label), type, label, properties JSON
graph_edges    -- from_node FK, to_node FK, relation, properties JSON
vec_procedures -- sqlite-vec virtual table: embedding float[N], id, content, metadata
               -- N = 384 (MiniLM/minimal) or 768 (BGE-large/power + BGE-base/standard)
               -- Dimension auto-detected from schema on VectorDB construction.
               -- Table is recreated automatically on embedding model upgrade.
```

Working memory lives at `[projectDir]/.engram-cc/working.yaml` — outside
the DB so users can inspect and edit it.

## VectorDB dimension flexibility

VectorDB's `dimensions` field is not fixed at construction time. On construction:
1. Reads stored schema from `sqlite_master` (`float[N]` regex on CREATE VIRTUAL TABLE)
2. If table exists: uses stored N (ensures search queries always match stored vectors)
3. If no table: uses constructor arg (default 384 for backward compat)

On `upsert()` with mismatched dimensions (embedding model changed):
1. Detects stored dims ≠ incoming embedding length
2. Drops `vec_procedures` and recreates with new dimension
3. Logs the migration to stderr
4. Stop hook re-populates with the new model's vectors on next session end

This means upgrading from 384-dim MiniLM to 768-dim BGE-large is zero-config —
the first Stop hook run after the upgrade handles the migration automatically.

## Patterns to follow

- `GraphDB` opens the same SQLite file as `SessionDB`. WAL mode allows multiple
  connections from the same process safely.
- `updateGraphFromEvents()` is idempotent: `upsertNode` / `upsertEdge` use
  INSERT OR REPLACE, so running it twice on the same events is safe.
- `mergeWorkingMemory()` deduplicates decisions to 20 entries and keeps the top
  20 files by frequency — lists never grow unbounded.
- `VectorDB.isAvailable()` must be checked before any vector operation. The
  entire sqlite-vec load is wrapped in try/catch; missing extension = silent no-op.
- BFS depth is capped at 3 hops. Increase only if graph query latency allows.
- Live indexing in PostToolUse uses content-stable IDs (`sessionId:live:<sha256[:32]>`).
  Stop hook uses session-event IDs (`sessionId:<ev.id>`). Both namespaces coexist.

## Known limitations

- sqlite-vec extension loading on Windows requires the pre-built sqlite-vec .dll.
  If `require("sqlite-vec")` fails, all vector operations are silently skipped.
  Core ECC functionality (FTS5 search, graph, snapshot) continues unaffected.
- `graph.ts` co-modified file edges use `relates_to` relation. Richer edge
  types (calls, imports) require static analysis not yet implemented.
- Vector search is cross-session from the Stop hook perspective (populated at session
  end). Live indexing via PostToolUse adds within-session vectors, but these are only
  available after the first embed() call (cold start: ~1–5s; warm: ~50–150ms).
