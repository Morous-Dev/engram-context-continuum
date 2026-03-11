# src/handoff — YAML session handoff writer, reader, and dedup

## What this module is

The cross-session continuity layer. Writes a 15-section YAML handoff file when
a session ends (Stop hook) and reads it back on the next session start. Includes
a transcript JSONL parser and LCS-based similarity dedup to keep the handoff
dense and non-redundant.

## How it works end to end

```
Stop hook
  → dedup.ts:extractTranscriptContext()   ← parse session JSONL, dedup user msgs
  → writer.ts:buildHandoffFromEvents()    ← synthesize 15-section HandoffData
  → writer.ts:writeHandoff()              ← write YAML to ~/.claude/super-context/handoff/

SessionStart hook (startup branch only — not compact/resume)
  → reader.ts:readHandoff()               ← load YAML, reject if > 15 min old
  → reader.ts:formatHandoffForContext()   ← render as XML <previous_session_handoff>
  → inject into additionalContext
```

## Key files

| File | Purpose |
|---|---|
| `writer.ts` | Builds HandoffData from session events + transcript context, writes YAML. |
| `reader.ts` | Reads YAML handoff with 15-min staleness guard, formats as XML. |
| `dedup.ts` | LCS similarity ratio, transcript JSONL parser, message dedup. |

## Handoff file location

```
~/.claude/super-context/handoff/<sha256(projectDir)[:16]>.yaml
```

## Patterns to follow

- Handoff staleness is enforced in `readHandoff()`: if `timestamp` is older than
  `maxAgeMs` (default 15 min), return `null` so stale context is never injected.
- `similarityRatio()` compares only the first 200 chars of each message pair.
  This is a deliberate performance cap — full LCS on long messages is expensive.
- `formatHandoffForContext()` skips empty arrays and empty strings. The XML block
  must be compact; every byte added reduces available context for real work.
- `buildHandoffFromEvents()` derives `current_task` and `last_action` from the
  most recent P1 events. If events are empty, it falls back to transcript context.
- YAML is written with `js-yaml`. Never write it manually with string templates —
  special characters in file paths and decisions will break YAML parsing.

## Known limitations

- Transcript JSONL path is derived from the Stop hook's `transcript_path` field.
  If Claude Code changes this path format, `extractTranscriptContext` will return
  null and the handoff will be built from DB events alone (graceful degradation).
- The 15-min staleness window means multi-hour pauses between sessions lose the
  handoff injection. This is intentional — stale context is worse than no context.
- `dedup.ts` junk filters (`USER_JUNK`, `ASSISTANT_JUNK`) cover common Claude Code
  system messages. New system message patterns may require filter updates.
