# src/hooks — Claude Code hook entry points

## What this module is

Entry points for all five Claude Code lifecycle hooks. Each file is a `.mjs`
ES module run by Node.js. The Stop hook is compiled TypeScript (`stop.ts` →
`build/hooks/stop.js`).

## How it works end to end

```
UserPromptSubmit  → userpromptsubmit.mjs  → SessionDB.insertEvent (prompt + signals)
                                           → [prompt > 20 chars, ENGRAM_SUBCONSCIOUS≠0]
                                             compressor.embed([prompt])
                                             VectorDB.search(queryVector, 5)  distance < 0.60
                                             → additionalContext: <subconscious_context source="semantic_memory">

PostToolUse       → posttooluse.mjs        → SessionDB.insertEvent (tool events)
                                           → [any event with category decision/error/task/rule]
                                             compressor.embed(significantEvents)
                                             VectorDB.upsert(contentStableId, ...)  ← live indexing
                                           → [on Edit/Write/Bash/AskUserQuestion]
                                             Path 1: VectorDB similarity search (cross-session + live)
                                             Path 2: FTS5 keyword search (current session)
                                             → additionalContext: <subconscious_context source="engram_retrieval">

PreCompact        → precompact.mjs         → detect hardware profile
                                           → [power/extreme profile] parallel:
                                               Promise.all([slmBriefTask, engramRetrievalTask])
                                           → [standard/minimal] sequential:
                                               slmBriefTask → engramRetrievalTask
                                           → SessionDB.upsertResume (snapshot + slm_brief + engram_context)
                                           → SessionDB.appendResumeHistory (chain)

SessionStart      → sessionstart.mjs       → [compact] snapshot + SLM brief + engrams → additionalContext
                                           → [startup] handoff (hot/cold) + working memory → additionalContext
                                           → [resume] session directive → additionalContext

Stop              → stop.ts                → HandoffWriter + GraphDB + VectorDB (bulk embed up to 50 events)
```

## Key files

| File | Purpose |
|---|---|
| `suppress-stderr.mjs` | Must be FIRST import in every hook. Silences better-sqlite3 stderr. |
| `session-helpers.mjs` | Path resolution and session ID derivation. Shared by all hooks. |
| `session-directive.mjs` | Builds the `<session_knowledge>` XML block from session events. |
| `posttooluse.mjs` | Event capture + live indexing + subconscious retrieval (vector + FTS5 dual-path). |
| `precompact.mjs` | SLM brief + engram retrieval + XML snapshot. Hardware-profile-aware parallelism. |
| `sessionstart.mjs` | Injects resume + engrams + handoff + working memory into context. |
| `userpromptsubmit.mjs` | Prompt capture + signal extraction + semantic memory retrieval. |
| `stop.ts` | Full session teardown pipeline. Compiled to build/hooks/stop.js. |

## Semantic retrieval (UserPromptSubmit)

On every user message (> 20 chars), userpromptsubmit.mjs:

1. Embeds the user's prompt via the hardware-profile-aware ONNX model
2. Searches `vec_procedures` for semantically relevant past events (distance < 0.60)
3. Injects matching memories as `<subconscious_context source="semantic_memory">` in
   `additionalContext` — Claude sees this before processing the user's message

This is the primary "Jarvis" path: every question the user asks is matched against
the accumulated memory of past decisions, errors, and facts from prior sessions.

**Performance:** ~150–200ms warm (ONNX model loaded by previous PostToolUse);
~1–5s cold start on first message of first session.

## Live continuous indexing (PostToolUse)

On every tool call that produces significant events (category `decision`, `error`,
`task`, or `rule`), posttooluse.mjs immediately embeds those events and upserts them
into VectorDB. This provides within-session semantic memory — subconscious retrieval
(later in the same session) finds these memories, not just memories from past sessions.

- **ID scheme**: `${sessionId}:live:${sha256[:32]}` — content-stable, idempotent
- **Fires on**: any tool call, not just RETRIEVAL_TRIGGERS
- **Complements**: the Stop hook's bulk embedding (which runs at session end)

## Subconscious retrieval (PostToolUse — decision-point calls)

On every Edit/Write/Bash/AskUserQuestion call, posttooluse.mjs runs two retrieval paths:

- **Vector path**: searches `vec_procedures` for semantically similar events (distance < 0.65).
  Covers both cross-session memories (from Stop hook) and within-session live-indexed events.
  Requires ONNX model warm (50–150ms warm after first call).
- **FTS5 path**: searches `session_events_fts` + `session_events_archive_fts` for keyword
  matches. Available immediately from the first tool call. Query terms are enriched by Gemma
  1B query expansion (~30–80ms warm) when the model is available; falls back to plain word-
  splitting if absent (~5ms).

Results are deduplicated by content, ranked by confidence, capped at 5, and injected
as `<subconscious_context source="engram_retrieval">` in `additionalContext`.
Disable both live indexing and retrieval with `ENGRAM_SUBCONSCIOUS=0`.

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
| `<projectDir>/.engram-cc/logs/precompact-debug.log` | precompact.mjs | SLM brief results, engram retrieval stats, hardware profile, errors |
| `<projectDir>/.engram-cc/logs/sessionstart-debug.log` | sessionstart.mjs | Session start errors |
