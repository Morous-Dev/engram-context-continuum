# src/retrieval — SLM-powered query expansion

## What this module is

A lightweight query expansion engine that enriches FTS5 search terms using
Gemma 3 1B QAT (689 MB). This is Gemma 1B's single job — no compression,
no embedding, no classification. Just query expansion.

## How it works end to end

```
PostToolUse fires on Edit/Write/Bash/AskUserQuestion
  → Extract event text from tool call
  → [Path 2: FTS5 keyword search]
    → Base terms: word-split + filter ≥4 chars (always, ~0ms)
    → SLM terms: Gemma 1B generates synonyms + related concepts (~30-80ms warm)
    → Merge: union of base + expanded, deduped, capped at 12 terms
    → OR-join quoted terms → FTS5 BM25 search
```

## Why a separate model

The 3-4B compression models (Llama/Qwen/Gemma 4B) are too slow for the
PostToolUse latency budget (100-200ms). Gemma 1B fits because:

- **Fast**: ~30-80ms warm inference for 20 output tokens
- **Small**: 689 MB VRAM — fits alongside the main compressor model
- **Focused**: short prompt, short output, no grammar constraints needed
- **Deterministic fallback**: if unavailable or times out, word-splitting works

## Key files

| File | Purpose |
|---|---|
| `query-expander.ts` | Singleton Gemma 1B loader + expandQuery() function |

## Model file

| File | Location | Size |
|---|---|---|
| `google_gemma-3-1b-it-qat-Q4_0.gguf` | `<sharedModelsDir>/` | ~689 MB |

The model is downloaded via `engramcc` (or `npx engram-cc`) or manually placed in the models
directory. If absent, FTS5 falls back to plain word-splitting — no degradation
of core functionality.

## Patterns to follow

- `expandQuery()` must never throw — always returns `[]` on failure.
- Hard timeout: 3 seconds via `Promise.race`. Non-negotiable.
- Singleton model loading: `getOrLoadSession()` runs once, cached thereafter.
- The expander is independent from the Compressor interface — no shared state.
- Terms are merged with base word-split terms (union), not replacing them.

## Known limitations

- Cold start on first PostToolUse trigger: ~500ms-2s (model loading).
  Subsequent calls are ~30-80ms. This is within the PostToolUse budget.
- If both the 4B compressor and 1B expander are loaded simultaneously,
  total VRAM usage is ~3.5-4 GB. Fits on standard (4+ GB) and power hardware.
- The model has no grammar constraints — output parsing is best-effort via
  line splitting. Malformed output degrades to fewer expanded terms, not failure.
