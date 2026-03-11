# src/compression — AI compression tiers

## What this module is

The inference layer. Provides text compression (for session snapshots) and
sentence embedding generation (for the VectorDB). Five tiers from zero-dependency
rule-based extraction (Tier 1) up to full GGUF model inference and external API
calls (Tiers 3–4). The factory in `index.ts` auto-selects the highest-capability
tier available on the current machine.

## How it works end to end

```
Stop hook
  → index.ts:getCompressor()          ← read plugin-config.yaml, detect / resolve tier
  → compressor.embed(eventTexts)      ← generate 384-dim embeddings
  → VectorDB.upsert()                 ← store in vec_procedures table

PreCompact hook (optional, not yet wired)
  → compressor.compress(sectionText)  ← reduce snapshot section size
  → buildResumeSnapshot()             ← use compressed text in XML
```

## Key files

| File | Purpose |
|---|---|
| `types.ts` | CompressionTier, Compressor interface, CompressionResult, EmbedResult. |
| `detect.ts` | RAM/VRAM detection → recommended tier (mirrors install script logic). |
| `tier1.ts` | Rule-based extractive compression. Always available, zero deps. |
| `tier2.ts` | @huggingface/transformers + Xenova/all-MiniLM-L6-v2 (384-dim embeddings). |
| `tier3.ts` | node-llama-cpp + GGUF model compression. Tier3a/b/c share this class. |
| `tier4.ts` | External HTTP providers: Ollama, LM Studio, Groq, Claude API. |
| `index.ts` | Factory: reads config, resolves tier, returns singleton Compressor. |

## Tier selection

`getCompressor()` in `index.ts` is the only public entry point.

```
plugin-config.yaml compression.tier = "auto"
  → detectSystemTier() reads RAM + VRAM
  → selects highest supported tier
  → walks fallback chain if model file / npm package missing:
     tier3c → tier3b → tier3a → tier2 → tier1

plugin-config.yaml compression.tier = "tier4"
  → Tier4Compressor is returned unconditionally (availability checked per-call)
```

## Model files (Tier 3)

Place GGUF files in `~/.claude/super-context/models/` before using Tier 3:

| Tier | Filename | Size |
|---|---|---|
| 3a | `qwen2.5-1.5b-instruct-q8_0.gguf` | ~1.65 GB |
| 3b | `llama-3.2-3b-instruct-q5_k_m.gguf` | ~2.32 GB |
| 3c | `phi-4-mini-instruct-q8_0.gguf` | ~4.08 GB |

Models are NOT downloaded automatically. If the file is absent, the tier
falls back to the next lower tier.

## Embeddings

All embedding output is 384-dimensional (matching VectorDB's `vec_procedures`
default). The embedding model is always `Xenova/all-MiniLM-L6-v2` — loaded by
Tier 2, delegated to by Tiers 3 and 4 (except Ollama which has a native endpoint).

## Patterns to follow

- `getCompressor()` returns a singleton — call it once per process.
- All `compress()` and `embed()` calls are async and must never throw.
  They return a fallback result (Tier 1 compression, empty embeddings) on failure.
- API keys for Tier 4 (Groq, Claude) come from env vars ONLY: `GROQ_API_KEY`,
  `ANTHROPIC_API_KEY`. Never from config files or code.

## Known limitations

- Tier 2 downloads `all-MiniLM-L6-v2` (~23 MB) on first use. If the machine
  has no internet access, set `HF_OFFLINE=1` and pre-cache the model manually.
- Tier 3 requires MSVC Build Tools on Windows for node-llama-cpp native compilation.
  Install from https://aka.ms/vs/buildtools if `bun install` fails.
- Tier 4 (Claude provider) always calls the Anthropic API — not the local Claude
  Code model. Use only when explicitly configured and billed API access is intended.
