# src/session — Session event capture, DB, and compaction recovery

## What this module is

The episodic memory layer. Captures discrete session events (tool calls, user
prompts, decisions, errors, checkpoints) into a per-project SQLite database.
Provides full-text search (FTS5), resume snapshot building, SLM-compressed
compaction briefs, and Engram retrieval (vector + FTS + graph).

## How it works end to end

```
PostToolUse hook
  → extract.ts:extractEvents(hookInput)       ← pure extraction, no side effects
  → db.ts:SessionDB.insertEvent()             ← SHA256 dedup + FIFO eviction
  → DB: session_events + session_events_fts (FTS5 trigger)

PreCompact hook
  → db.ts:SessionDB.getEvents()               ← read all events for session
  → auditor.ts:auditSessionEvents()           ← prune ghost tokens
  → snapshot.ts:buildResumeSnapshot()         ← priority-budget XML builder
  → compact-budget.ts:calculateCompactBudget()← dynamic token budget by compact_count
  → compact-brief.ts:generateCompactBrief()   ← SLM-compressed <session_knowledge>
  → engram-retrieval.ts:buildRetrievalQuery() ← extract query text + seeds from events
  → engram-retrieval.ts:retrieveEngrams()     ← vector + FTS5 + graph + anchor paths
  → engram-retrieval.ts:formatEngramsForContext() ← <retrieved_engrams> XML
  → db.ts:SessionDB.upsertResume()            ← snapshot + slm_brief + engram_context
  → db.ts:SessionDB.appendResumeHistory()     ← chain row (one per compaction cycle)

SessionStart(compact) hook
  → db.ts:SessionDB.getResume()               ← load snapshot + slm_brief + engram_context
  → inject all three layers into additionalContext
```

## Key files

| File | Purpose |
|---|---|
| `db-base.ts` | SQLiteBase abstract class: WAL setup, lazy loading, lifecycle. |
| `db.ts` | SessionDB: all tables including session_resume_history and engram_context column. |
| `extract.ts` | Pure extractors for 14+ event categories including checkpoint. |
| `snapshot.ts` | XML resume snapshot builder with priority-budget trimming and work_progress section. |
| `compact-budget.ts` | Dynamic compression ratio calculator based on compact_count. |
| `compact-brief.ts` | SLM-compressed brief generator with 30s timeout + chain-aware prior briefs. |
| `engram-retrieval.ts` | 4-path retrieval engine: vector, FTS5, graph BFS, persistent anchor facts. |

## Schema

```sql
session_events        -- raw events (id, session_id, type, category, priority, data, ...)
session_meta          -- per-session metadata (event_count, compact_count, project_dir, ...)
session_resume        -- latest compaction snapshot (snapshot, slm_brief, engram_context, consumed)
session_resume_history-- append-only chain: one row per compaction cycle (for multi-compaction handoff)
session_events_fts    -- FTS5 virtual table over session_events.data (BM25 search)
```

## Event categories

| Category | Examples | Priority |
|----------|----------|----------|
| file | file_read, file_write, file_edit | 1-2 |
| task | task_create, task_update | 1 |
| checkpoint | checkpoint_build, checkpoint_test, checkpoint_commit, checkpoint_create | 1-2 |
| rule | rule path, rule_content | 1 |
| decision | decision, decision_question | 2 |
| error | error_tool, error_bash | 2 |
| cwd | current working directory | 2 |
| env | environment variables | 2 |
| git | git operations | 2 |
| subagent | subagent_launched, subagent_completed | 2 |
| intent | intent mode (investigate/implement/review) | 3 |
| mcp | MCP tool calls | 3 |
| prompt | user prompts | 1-3 |

## Engram retrieval (4 paths)

`engram-retrieval.ts:retrieveEngrams()` runs 4 paths and merges results:

- **Path A** — Vector similarity: cosine distance via sqlite-vec. Cross-session.
  Requires MiniLM embedding. Distance < 0.65 threshold.
- **Path B** — FTS5 keyword: BM25 ranking on session_events_fts. Current session.
  No model needed. OR-joined quoted terms.
- **Path C** — Graph BFS: traverses knowledge graph from decision/error seed nodes.
  Captures structural relationships missed by text search.
- **Path D** — Anchor facts: top 10 decision nodes + 5 error nodes from graph.
  Always included regardless of query — architectural choices must always survive.

Results are deduplicated by normalized content. Multi-source corroboration boosts
confidence by 15%. Confidence threshold: MIN_CONFIDENCE = 0.35. Max output: 25 engrams.

## Compaction brief chain

Each compaction cycle appends to `session_resume_history`. On the next PreCompact,
prior briefs are fetched via `db.getResumeChain()` and passed to `generateCompactBrief()`
as `priorBriefs[]` — making each brief chain-aware. The Stop hook reads this chain
to synthesize the full session arc in the final handoff YAML.

## Patterns to follow

- Event deduplication is SHA256-based: `hash(data)[:16]` checked against last 5 events.
- FIFO eviction: when session reaches 1000 events, evict lowest-priority + oldest.
- Snapshot budget: 4096 bytes max. P1 gets 50%, P2 gets 35%, P3+ gets 15%.
- FTS5 is kept in sync via triggers — never rebuild manually unless recovering from crash.
- `engram_context` column in `session_resume` added via idempotent ALTER TABLE migration.

## Known limitations

- Vector path (Path A) has no data during the first session — populated by Stop hook.
  FTS5 path (Path B) is available immediately within a session.
- The `data_hash` migration check (DROP TABLE if generated column) is for compatibility
  with older context-mode schema. Can be removed once all installs are fresh.
