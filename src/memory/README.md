# src/memory — Multi-tier memory bank

## What this module is

The persistent cross-session memory layer. Three separate storage abstractions
(working, graph, vector) that all read from or write to the same per-project
SQLite file. Working memory uses YAML files for human-readable cross-session
state; graph and vector live inside the DB.

## How it works end to end

```
Stop hook
  → working.ts:mergeWorkingMemory()       ← merge session decisions + file freq
  → graph.ts:updateGraphFromEvents()      ← upsert file/decision/rule nodes + edges
  → vector.ts:upsert()                    ← stub until Phase 6 embedding wired in

SessionStart hook
  → working.ts:readWorkingMemory()        ← load YAML ledger
  → working.ts:formatWorkingMemoryForContext() ← render as XML block
  → inject into additionalContext
```

## Key files

| File | Purpose |
|---|---|
| `working.ts` | YAML working memory: read, write, merge, format. |
| `graph.ts` | GraphDB: SQLite nodes/edges tables + BFS traversal. |
| `vector.ts` | VectorDB: sqlite-vec procedures table, graceful no-op if unavailable. |

## Schema (inside the per-project SQLite DB)

```sql
graph_nodes  -- id (sha256[:16] of project:type:label), type, label, properties JSON
graph_edges  -- from_node FK, to_node FK, relation, properties JSON
vec_procedures -- sqlite-vec virtual table: embedding float[384], id, content, metadata
```

Working memory lives at `~/.claude/super-context/working/<hash>.yaml` — outside
the DB so users can inspect and edit it.

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

## Known limitations

- sqlite-vec extension loading on Windows has not been verified. If
  `require("sqlite-vec")` fails, all vector operations are silently skipped.
- Vector store population in stop.ts is stubbed (Phase 6): embeddings are not
  yet generated, so `vec_procedures` remains empty until an embedding model is
  wired in.
- `graph.ts` co-modified file edges use `relates_to` relation. Richer edge
  types (calls, imports) require static analysis not yet implemented.
