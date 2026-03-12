# src/hooks — Claude Code hook entry points

## What this module is

Entry points for all five Claude Code lifecycle hooks. Each file is a `.mjs`
ES module run by Node.js. The Stop hook is compiled TypeScript (`stop.ts` →
`build/hooks/stop.js`).

## How it works end to end

```
UserPromptSubmit  → userpromptsubmit.mjs  → SessionDB.insertEvent (prompt + signals)

PostToolUse       → posttooluse.mjs        → SessionDB.insertEvent (tool events)
                                           → [on Edit/Write/Bash/AskUserQuestion]
                                             Path 1: VectorDB similarity search (cross-session)
                                             Path 2: FTS5 keyword search (current session)
                                             → additionalContext: <subconscious_context>

PreCompact        → precompact.mjs         → detect hardware profile
                                           → [power profile] parallel:
                                               Promise.all([slmBriefTask, engramRetrievalTask])
                                           → [standard/minimal] sequential:
                                               slmBriefTask → engramRetrievalTask
                                           → SessionDB.upsertResume (snapshot + slm_brief + engram_context)
                                           → SessionDB.appendResumeHistory (chain)

SessionStart      → sessionstart.mjs       → [compact] snapshot + SLM brief + engrams → additionalContext
                                           → [startup] handoff (hot/cold) + working memory → additionalContext
                                           → [resume] session directive → additionalContext

Stop              → stop.ts                → HandoffWriter + GraphDB + VectorDB (embed events)
```

## Key files

| File | Purpose |
|---|---|
| `suppress-stderr.mjs` | Must be FIRST import in every hook. Silences better-sqlite3 stderr. |
| `session-helpers.mjs` | Path resolution and session ID derivation. Shared by all hooks. |
| `session-directive.mjs` | Builds the `<session_knowledge>` XML block from session events. |
| `posttooluse.mjs` | Event capture + subconscious retrieval (vector + FTS5 dual-path). |
| `precompact.mjs` | SLM brief + engram retrieval + XML snapshot. Hardware-profile-aware parallelism. |
| `sessionstart.mjs` | Injects resume + engrams + handoff + working memory into context. |
| `userpromptsubmit.mjs` | Captures user prompts and extracts decision/intent signals. |
| `stop.ts` | Full session teardown pipeline. Compiled to build/hooks/stop.js. |

## Subconscious retrieval (PostToolUse)

On every Edit/Write/Bash/AskUserQuestion call, posttooluse.mjs runs two retrieval paths:

- **Vector path**: searches `vec_procedures` for semantically similar events from
  previous sessions. Requires MiniLM model warm (100-200ms warm, 1-5s cold start).
  Data is populated by the Stop hook — empty during the first session.
- **FTS5 path**: searches `session_events_fts` for keyword matches in the current
  session's events. Available immediately from the first tool call. No model needed (~5ms).

Results are deduplicated by content, ranked by confidence, capped at 5, and injected
as `<subconscious_context>` in `additionalContext`. Disable with `ENGRAM_SUBCONSCIOUS=0`.

## Compaction recovery (PreCompact → SessionStart)

PreCompact writes three layers to `session_resume`:

1. `snapshot` — rule-based XML (files, tasks, decisions, errors, checkpoints)
2. `slm_brief` — SLM-compressed `<session_knowledge>` block (replaces raw event dump)
3. `engram_context` — `<retrieved_engrams>` from vector/FTS/graph retrieval

SessionStart(compact) injects all three in sequence. Falls back to raw event dump
if `slm_brief` is null (tier1/tier2 compressors or SLM timeout).

On `power` hardware (VRAM ≥ 12 GB), `slmBriefTask` and `engramRetrievalTask` run
concurrently via `Promise.all()` — they use separate compute (GGUF on GPU vs MiniLM
on CPU) so there is no contention.

## Patterns to follow

- Every hook wraps its entire body in `try/catch` — hooks must NEVER block sessions.
- Dynamic imports use `pathToFileURL()` for Windows compatibility.
- Import paths from hooks to build: `join(HOOK_DIR, "..", "..", "build", ...)`.
- The stop hook (TypeScript) uses direct imports, not dynamic imports.
- Failure in any sub-task (SLM brief, engram retrieval, subconscious) is always
  swallowed silently — the session continues without the extra context.

## Debug logs

| Log file | Written by | Contains |
|----------|-----------|---------|
| `~/.claude/super-context/precompact-debug.log` | precompact.mjs | SLM brief results, engram retrieval stats, hardware profile, errors |
| `~/.engram-cc/sessionstart-debug.log` | sessionstart.mjs | Session start errors |
