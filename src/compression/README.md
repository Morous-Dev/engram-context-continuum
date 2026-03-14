# src/compression — AI compression tiers

## What this module is

The inference layer. Provides text compression (for session snapshots) and
sentence embedding generation (for the VectorDB). Five tiers from zero-dependency
rule-based extraction (Tier 1) up to full GGUF model inference and external API
calls (Tiers 3–4). The factory in `index.ts` auto-selects the highest-capability
tier available on the current machine.

Also provides hardware profile detection (`HardwareProfile`) which drives pipeline
execution strategy (sequential vs parallel PreCompact) and embedding model selection
independently of the SLM compression tier.

## How it works end to end

```
Stop hook
  → index.ts:getCompressor()          ← read plugin-config.yaml, detect / resolve tier
  → compressor.embed(eventTexts)      ← generate embeddings (dimension depends on profile)
  → VectorDB.upsert()                 ← store in vec_procedures table

PostToolUse hook (live indexing — every significant event)
  → index.ts:getCompressor()          ← singleton, already warm if PostToolUse ran before
  → compressor.embed(newEventTexts)   ← embed decision/error/task/rule events in real-time
  → VectorDB.upsert()                 ← content-stable IDs, idempotent INSERT OR REPLACE

UserPromptSubmit hook (semantic retrieval — every user message)
  → index.ts:getCompressor()          ← singleton
  → compressor.embed([userPrompt])    ← embed the user's message
  → VectorDB.search()                 ← cosine search for relevant past context
  → additionalContext injection       ← injected before Claude processes the message

PreCompact hook
  → index.ts:getHardwareProfile()     ← detect VRAM (nvidia-smi / rocm-smi / wmic)
  → [power/extreme] Promise.all([slmBriefTask(), engramRetrievalTask()])
  → [standard/minimal] sequential execution
  → compressor.compress(sectionText)  ← SLM brief via tier3+ (tier1/2 return null)
```

## Key files

| File | Purpose |
|---|---|
| `types.ts` | CompressionTier, HardwareProfile, Compressor interface, CompressionResult, EmbedResult. |
| `detect.ts` | RAM/VRAM detection (nvidia-smi, rocm-smi, wmic, Apple Silicon proxy). 4-tier HardwareProfile + tier selection. |
| `tier1.ts` | Rule-based extractive compression. Always available, zero deps. |
| `tier2.ts` | @huggingface/transformers ONNX embedding specialist. Model selected by hardware profile (see Embeddings section). |
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

`getHardwareProfile()` returns `"minimal" | "standard" | "power" | "extreme"`.

| Profile | VRAM condition | Apple Silicon | Effect |
|---------|---------------|---------------|--------|
| `extreme` | VRAM ≥ 24 GB (RTX 4090, A100, H100) | ≥ 36 GB | Parallel PreCompact; BGE-large embedding |
| `power` | VRAM 12–23 GB (RTX 3060 12 GB, 3090, 4080) | ≥ 16 GB | Parallel PreCompact; BGE-large embedding |
| `standard` | VRAM 4–11 GB (RTX 3060 8 GB, 4060) | ≥ 8 GB | Sequential; BGE-base embedding |
| `minimal` | No GPU or VRAM < 4 GB | < 8 GB | Sequential; MiniLM embedding |

`extreme` and `power` share the same BGE-large embedding model. The distinction matters for
PreCompact parallelism (SLM on GPU + retrieval on CPU run concurrently) and future model tiers.

GPU detection priority: nvidia-smi (NVIDIA) → rocm-smi (AMD Linux) → wmic (Windows all-vendor).
All subprocess calls are cached after first invocation — never repeated within a process.

## Embeddings (Tier 2 — hardware-profile-aware specialist models)

Tier 2 selects the embedding model at construction time based on the detected hardware profile.
Tier 3+ delegate their `embed()` calls to Tier 2 (Tier 3 uses own GGUF weights for compress()).

| Profile | Model | Dims | Download | Notes |
|---------|-------|------|----------|-------|
| extreme / power | `Xenova/bge-large-en-v1.5` | 768 | ~1.2 GB | Best ONNX retrieval, BEIR avg 54.2. CLS pooling. |
| standard | `Xenova/bge-base-en-v1.5` | 768 | ~420 MB | Balanced quality/cost, BEIR avg 53.2. CLS pooling. |
| minimal | `Xenova/all-MiniLM-L6-v2` | 384 | ~23 MB | CPU-optimised fallback. Mean pooling. |

BGE models are purpose-built for dense passage retrieval (not just semantic similarity).
The 768-dim space captures finer distinctions than MiniLM's 384-dim for cross-session recall.

Models are downloaded once on first embed() call and cached in `~/.cache/huggingface/hub`
(or `HF_HOME` env var). SLM brief generation (GPU, tier3+) and embedding (CPU, tier2) use
separate compute resources — safe to parallelize on power/extreme hardware.

VectorDB auto-detects stored dimensions on open. If the embedding model changes (e.g. upgrading
from 384-dim to 768-dim), the first upsert() transparently drops and recreates the table. The
Stop hook re-populates with the new model's vectors on next session end.

## Model files (Tier 3 SLM)

Place GGUF files in the shared models directory configured in `<projectDir>/.engram-cc/config.json` before using Tier 3:

| Tier | Filename | Size | Score |
|---|---|---|---|
| 3 | `llama-3.2-3b-instruct-q5_k_m.gguf` | ~2.32 GB | 10/10 |
| 3b | `qwen3.5-4b-instruct-q4_k_m.gguf` | ~2.74 GB | 10/10 |
| 3c | `gemma-3-4b-it-qat-q4_0.gguf` | ~2.37 GB | 10/10 |

Models are NOT downloaded automatically. If the file is absent, the tier
falls back to the next lower tier.

## Patterns to follow

- `getCompressor()` returns a singleton — call it once per process.
- `getHardwareProfile()` returns a singleton — VRAM detection runs once.
- All `compress()` and `embed()` calls are async and must never throw.
  They return a fallback result (Tier 1 compression, empty embeddings) on failure.
- Always check `EmbedResult.dimensions` after calling `embed()` — the actual output
  dimension depends on hardware profile and must be passed to VectorDB accordingly.
- API keys for Tier 4 (Groq, Claude) come from env vars ONLY: `GROQ_API_KEY`,
  `ANTHROPIC_API_KEY`. Never from config files or code.

## Known limitations

- Tier 2 downloads the selected model on first use (23 MB – 1.2 GB). If the machine
  has no internet access, set `HF_OFFLINE=1` and pre-cache the model manually via
  `huggingface-cli download <model-id>`.
- Tier 3 requires MSVC Build Tools on Windows for node-llama-cpp native compilation.
  Install from https://aka.ms/vs/buildtools if `npm install` fails.
- VRAM detection only covers NVIDIA (nvidia-smi) and AMD on Linux (rocm-smi). AMD
  on Windows falls through to wmic (vendor-agnostic bytes query). Intel Arc on Linux
  has no detection — classified as minimal until xpu-smi support is added.
- Tier 4 (Claude provider) always calls the Anthropic API — not the local Claude
  Code model. Use only when explicitly configured and billed API access is intended.
