# src/compression — AI compression tiers

## What this module is

The inference layer. Provides text compression (for session snapshots) and
sentence embedding generation (for the VectorDB). Five tiers from zero-dependency
rule-based extraction (Tier 1) up to full GGUF model inference and external API
calls (Tiers 3–4). The factory in `index.ts` auto-selects the highest-capability
tier available on the current machine.

Also provides hardware profile detection (`HardwareProfile`) which drives pipeline
execution strategy (sequential vs parallel PreCompact) independently of tier selection.

## How it works end to end

```
Stop hook
  → index.ts:getCompressor()          ← read plugin-config.yaml, detect / resolve tier
  → compressor.embed(eventTexts)      ← generate 384-dim embeddings (MiniLM via tier2)
  → VectorDB.upsert()                 ← store in vec_procedures table

PreCompact hook
  → index.ts:getHardwareProfile()     ← detect VRAM (nvidia-smi / rocm-smi / wmic)
  → [power profile] Promise.all([slmBriefTask(), engramRetrievalTask()])
  → [other profiles] sequential execution
  → compressor.compress(sectionText)  ← SLM brief via tier3+ (tier1/2 return null)
```

## Key files

| File | Purpose |
|---|---|
| `types.ts` | CompressionTier, HardwareProfile, Compressor interface, CompressionResult, EmbedResult. |
| `detect.ts` | RAM/VRAM detection (nvidia-smi, rocm-smi, wmic, Apple Silicon proxy). HardwareProfile + tier selection. |
| `tier1.ts` | Rule-based extractive compression. Always available, zero deps. |
| `tier2.ts` | @huggingface/transformers + Xenova/all-MiniLM-L6-v2 (384-dim embeddings). |
| `tier3.ts` | node-llama-cpp + Llama 3.2 3B Q5_K_M GGUF. 10/10 adversarial. |
| `tier3b.ts` | node-llama-cpp + Qwen3.5 4B Q4_K_M GGUF. 10/10 adversarial, strong multilingual. |
| `tier3c.ts` | node-llama-cpp + Gemma 3 4B QAT Q4_0 GGUF. 10/10 adversarial, IFEval 90.2%. |
| `tier4.ts` | External HTTP providers: Ollama, LM Studio, Groq, Claude API. |
| `schema.ts` | HANDOFF_SCHEMA (GBNF JSON grammar) + prompt builders for diff-mode and compact-brief. |
| `index.ts` | Factory: getCompressor() + getHardwareProfile() singletons. |

## Tier selection

`getCompressor()` in `index.ts` is the only public entry point.

```
plugin-config.yaml compression.tier = "auto"
  → detectSystemTier() reads RAM + VRAM (nvidia-smi cached, 500ms timeout)
  → selects highest supported tier
  → walks fallback chain if model file / npm package missing:
     tier3 → tier3b → tier3c → tier2 → tier1

plugin-config.yaml compression.tier = "tier4"
  → Tier4Compressor is returned unconditionally (availability checked per-call)
```

## Hardware profile selection

`getHardwareProfile()` returns `"minimal" | "standard" | "power"`.

| Profile | Condition | Effect |
|---------|-----------|--------|
| `power` | VRAM ≥ 12 GB or Apple Silicon ≥ 16 GB | Parallel PreCompact pipeline |
| `standard` | VRAM 4–11 GB or RAM ≥ 16 GB | Sequential pipeline, GPU-assisted |
| `minimal` | Everything else | Sequential pipeline, CPU only |

GPU detection priority: nvidia-smi (NVIDIA) → rocm-smi (AMD Linux) → wmic (Windows all-vendor).
All subprocess calls are cached after first invocation — never repeated within a process.

## Model files (Tier 3)

Place GGUF files in `~/.engram-cc/models/` before using Tier 3:

| Tier | Filename | Size | Score |
|---|---|---|---|
| 3 | `llama-3.2-3b-instruct-q5_k_m.gguf` | ~2.32 GB | 10/10 |
| 3b | `qwen3.5-4b-instruct-q4_k_m.gguf` | ~2.74 GB | 10/10 |
| 3c | `gemma-3-4b-it-qat-q4_0.gguf` | ~2.37 GB | 10/10 |

Models are NOT downloaded automatically. If the file is absent, the tier
falls back to the next lower tier.

## Embeddings

All embedding output is 384-dimensional (matching VectorDB's `vec_procedures`
default). The embedding model is always `Xenova/all-MiniLM-L6-v2` — loaded by
Tier 2, delegated to by Tiers 3 and 4 (except Ollama which has a native endpoint).

GGUF models use Tier 2 (CPU ONNX) for embedding and their own GGUF weights for
compress(). This means SLM brief generation (GPU) and embedding (CPU) use separate
compute resources — safe to parallelize on power hardware.

## Patterns to follow

- `getCompressor()` returns a singleton — call it once per process.
- `getHardwareProfile()` returns a singleton — VRAM detection runs once.
- All `compress()` and `embed()` calls are async and must never throw.
  They return a fallback result (Tier 1 compression, empty embeddings) on failure.
- API keys for Tier 4 (Groq, Claude) come from env vars ONLY: `GROQ_API_KEY`,
  `ANTHROPIC_API_KEY`. Never from config files or code.

## Known limitations

- Tier 2 downloads `all-MiniLM-L6-v2` (~23 MB) on first use. If the machine
  has no internet access, set `HF_OFFLINE=1` and pre-cache the model manually.
- Tier 3 requires MSVC Build Tools on Windows for node-llama-cpp native compilation.
  Install from https://aka.ms/vs/buildtools if `npm install` fails.
- VRAM detection only covers NVIDIA (nvidia-smi) and AMD on Linux (rocm-smi). AMD
  on Windows falls through to wmic (vendor-agnostic bytes query). Intel Arc on Linux
  has no detection — classified as minimal until xpu-smi support is added.
- Tier 4 (Claude provider) always calls the Anthropic API — not the local Claude
  Code model. Use only when explicitly configured and billed API access is intended.
