# src/hooks — Claude Code hook entry points

## What this module is

Entry points for all five Claude Code lifecycle hooks. Each file is either a
`.mjs` ES module (run by Node.js) or a `.ts` file (run by Bun).

## How it works end to end

```
UserPromptSubmit  → userpromptsubmit.mjs  → SessionDB.insertEvent (prompt + signals)
PostToolUse       → posttooluse.mjs        → SessionDB.insertEvent (tool events)
PreCompact        → precompact.mjs         → SessionDB.upsertResume (XML snapshot)
SessionStart      → sessionstart.mjs       → additionalContext (snapshot + handoff + working mem)
Stop              → stop.ts                → HandoffWriter + GraphDB + WorkingMemory
```

## Key files

| File | Purpose |
|---|---|
| `suppress-stderr.mjs` | Must be FIRST import in every hook. Silences better-sqlite3 stderr. |
| `session-helpers.mjs` | Path resolution and session ID derivation. Shared by all hooks. |
| `session-directive.mjs` | Builds the `<session_knowledge>` XML block from session events. |
| `posttooluse.mjs` | Captures 13+ tool event categories into SQLite. |
| `precompact.mjs` | Builds XML resume snapshot with ghost token auditing. |
| `sessionstart.mjs` | Injects resume + handoff + working memory into context. |
| `userpromptsubmit.mjs` | Captures user prompts and extracts decision/intent signals. |
| `stop.ts` | Full session teardown pipeline. Run by Bun. |

## Patterns to follow

- Every hook wraps its entire body in `try/catch` — hooks must NEVER block sessions.
- Dynamic imports use `pathToFileURL()` for Windows compatibility.
- Import paths from hooks to build: `join(HOOK_DIR, "..", "..", "build", ...)`.
- The stop hook (TypeScript) uses direct imports, not dynamic imports.

## Known limitations

- `precompact.mjs` writes a debug log to `~/.claude/super-context/precompact-debug.log` on failure.
- `sessionstart.mjs` writes a debug log to `~/.claude/super-context/sessionstart-debug.log` on failure.
- The Stop hook's vector store population is stubbed until an embedding model is wired in (Phase 6).
