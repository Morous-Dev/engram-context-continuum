# src/session — Session event capture and DB

## What this module is

The episodic memory layer. Captures discrete session events (tool calls, user
prompts, decisions, errors) into a per-project SQLite database. Provides
full-text search (FTS5) and resume snapshot building.

## How it works end to end

```
PostToolUse hook
  → extract.ts:extractEvents(hookInput)       ← pure extraction, no side effects
  → db.ts:SessionDB.insertEvent()             ← SHA256 dedup + FIFO eviction
  → DB: session_events table

PreCompact hook
  → db.ts:SessionDB.getEvents()               ← read all events for session
  → auditor.ts:auditSessionEvents()           ← prune ghost tokens
  → snapshot.ts:buildResumeSnapshot()         ← priority-budget XML builder
  → db.ts:SessionDB.upsertResume()            ← store snapshot for SessionStart

SessionStart hook
  → db.ts:SessionDB.getResume()               ← load stored snapshot
  → inject into additionalContext
```

## Key files

| File | Purpose |
|---|---|
| `db-base.ts` | SQLiteBase abstract class: WAL setup, lazy loading, lifecycle. |
| `db.ts` | SessionDB: all tables (session_events, meta, resume, FTS5). |
| `extract.ts` | Pure extractors for 13+ tool and user message event categories. |
| `snapshot.ts` | XML resume snapshot builder with priority-budget trimming. |

## Schema

```sql
session_events    -- raw captured events (id, session_id, type, category, priority, data, ...)
session_meta      -- per-session metadata (event_count, compact_count, ...)
session_resume    -- latest resume snapshot XML (consumed flag prevents double injection)
session_events_fts -- FTS5 virtual table over session_events.data (BM25 search)
```

## Patterns to follow

- Event deduplication is SHA256-based: `hash(data)[:16]` checked against last 5 events.
- FIFO eviction: when session reaches 1000 events, evict lowest-priority + oldest.
- Snapshot budget: 2048 bytes max. P1 gets 50%, P2 gets 35%, P3+ gets 15%.
- FTS5 is kept in sync via triggers — never rebuild manually unless recovering from crash.

## Known limitations

- The `data_hash` migration check (DROP TABLE if generated column) is for compatibility
  with older context-mode schema. Can be removed once all installs are fresh.
