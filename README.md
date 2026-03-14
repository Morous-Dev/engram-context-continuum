# Engram Context Continuum

**Universal AI session memory substrate.** One install. Every AI coding assistant. Persistent context across sessions, folder renames, and tool switches.

> *In neuroscience, an engram is the physical trace a memory leaves in the brain. EngramCC does the same for AI — a local memory substrate that persists what your AI assistant learned, decided, and did, so the next session picks up exactly where the last one left off.*

---

## The Problem

Every AI coding session starts from zero. The assistant re-reads files it read yesterday, re-learns conventions it already knows, re-asks questions you already answered. Context compaction silently erases the session mid-work. Switch tools and all memory is gone.

EngramCC solves this at the infrastructure level — not by prompting harder, but by building a persistent memory layer that runs underneath any AI assistant.

---

## Quick Install

```bash
npx engram-cc
```

Run it from the project root you want ECC to manage, or pass `--project-dir <path>`.

The setup CLI detects your hardware, prepares a project-local `.engram-cc/` workspace, asks for a shared models directory, and generates assistant hook/MCP snippets under `.engram-cc/assistant-configs/`. No user-home config is modified.

---

## Supported Assistants

| Assistant | Hook support | MCP support |
|---|---|---|
| Claude Code | Full lifecycle hooks | recall / search / recent / graph_query |
| Gemini CLI | Full lifecycle hooks | recall / search / recent / graph_query |
| VS Code Copilot | — | recall / search / recent / graph_query |
| Codex CLI | — | recall / search / recent / graph_query |
| OpenCode | Full lifecycle hooks | recall / search / recent / graph_query |
| Cursor | — | recall / search / recent / graph_query |

---

## How It Works

EngramCC runs as **session middleware** — lifecycle hooks capture what happens during a session, a local SLM synthesizes memory offline at session end, and an MCP server serves pre-digested context to any connected assistant.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Your AI Coding Session                        │
│                                                                   │
│  UserPromptSubmit → PostToolUse → PreCompact → Stop              │
│         │               │              │          │               │
│         └───────────────┴──────────────┴──────────┘              │
│                                 │                                 │
│                         SQLite event DB                           │
│                                 │                                 │
│                     ┌───────────┴───────────┐                    │
│                     │   Local SLM Archivist  │                    │
│                     │  (no API calls, 100%   │                    │
│                     │   offline synthesis)   │                    │
│                     └───────────┬───────────┘                    │
│                                 │                                 │
│              ┌──────────────────┼──────────────────┐             │
│              │                  │                  │             │
│         YAML handoff     Knowledge graph     Vector store        │
│         (hot resume)      (BFS traversal)   (semantic search)    │
│              │                  │                  │             │
│              └──────────────────┴──────────────────┘             │
│                                 │                                 │
│                         MCP server                                │
│                    (recall / search / recent                      │
│                       / graph_query)                              │
└─────────────────────────────────────────────────────────────────┘
         ↑                                         ↓
   SessionStart hook                       Next session
   injects context                         picks up here
```

### Session Lifecycle

| Hook | When | What it does |
|---|---|---|
| `UserPromptSubmit` | User sends a message | Captures intent and decision signals |
| `PostToolUse` | Any tool completes | Captures file ops, errors, tool results |
| `PreCompact` | Context nears limit | Snapshots session state before erasure |
| `SessionStart` | Session opens | Injects hot handoff or cold summary + MCP pointer |
| `Stop` | Session closes | SLM synthesis → handoff YAML + graph + vector store |

### Tiered Context Injection

EngramCC injects context surgically, not blindly:

- **Hot resume** (< 30 min since last session): full handoff XML injected — complete working context, decisions, modified files, errors
- **Cold start**: one-sentence headline + pointer to MCP `recall` tool — zero token waste on stale context

### Memory Architecture

| Layer | Storage | Contents | Lifespan |
|---|---|---|---|
| Working | YAML | Preferences, conventions, persistent decisions | Cross-session |
| Episodic | SQLite + FTS5 | All session events, full-text searchable | Per-project |
| Semantic | SQLite graph | File/decision knowledge graph, BFS traversal | Per-project |
| Procedural | sqlite-vec | Embedding-indexed high-value events | Per-project |

---

## Local SLM Pipeline

EngramCC synthesizes session memory using local models first — zero external API calls for its own compaction, handoff, and retrieval support.

The setup CLI detects your hardware and selects the best available tier:

| Tier | Model | RAM needed | What it does |
|---|---|---|---|
| 1 | Rule-based | 0 | Always-on heuristic extraction |
| 2 | MiniLM-L6-v2 ONNX | ~400 MB | Embeddings via `@huggingface/transformers` |
| 3 | Llama 3.2 3B Q5_K_M | ~4 GB | Primary local synthesis tier |
| 3b | Qwen3.5 4B Q4_K_M | ~3.5 GB | Alternate synthesis tier, strong multilingual/coding performance |
| 3c | Gemma 3 4B QAT Q4_0 | ~3 GB | Alternate synthesis tier, strong structured reasoning |
| 4 | Ollama / LM Studio / Groq | user-provided | External HTTP provider |

Models are stored in a shared directory chosen during `engramcc` setup and saved in `<projectDir>/.engram-cc/config.json`. Tiers auto-cascade: if no Tier 3 model is available, Tier 2 runs; if Tier 2 is unavailable, Tier 1 runs. Core memory capture is never blocked.

---

## Stable Project Identity

EngramCC tracks projects by a **stable UUID** stored in `.ecc-id` — not by folder path. This means:

- Rename the project folder → same history
- Move it to a different drive → same history
- Re-clone from git → same history (falls back to git root commit hash)

Resolution order: `.ecc-id` file → git root commit hash → fresh UUIDv4 (written once, never regenerated).

---

## Data Locations

```
<projectDir>/.engram-cc/
├── sessions/
│   └── <uuid>.db               ← SQLite DB per project (all memory tiers)
├── assistant-configs/          ← Local hook/MCP snippets per assistant
├── config.json                 ← Project config, including shared models path
├── handoff.yaml                ← Session handoff (hot resume data)
└── working.yaml                ← Cross-session working memory

<chosenModelsRoot>/Engram Context Continuum/models/
└── <model>.gguf                ← Shared GGUF models reused across projects
```

All data is local. No network calls for core operation. No credentials, tokens, or API keys required.

---

## MCP Tools

When connected via MCP, any assistant can query EngramCC directly:

| Tool | Purpose |
|---|---|
| `recall` | Full session context: handoff + working memory |
| `search` | FTS5 full-text search over all session events |
| `recent` | Most recent N events, filterable by category |
| `graph_query` | BFS traversal of the knowledge graph |

---

## Configuration

Override compression tier or external provider in `plugin-config.yaml`:

```yaml
# Force a specific compression tier (default: auto)
compression:
  tier: "tier3b"

  # Tier 4 only
  external:
    provider: "ollama"
    model: "phi4-mini"
    base_url: "http://localhost:11434"
```

---

## Benchmarks

The numbers below were verified against the current repo state on **March 14, 2026** after the carry-forward compaction fix. They reflect what was actually run, not historical bests.

### Verified Benchmark Runs

| Command | What it measures | Current result |
|---|---|---|
| `npm run build` | TypeScript compile integrity | ✅ PASS |
| `node benchmark/test-session-db.mjs` | Session DB, archive, resume-chain, carry-forward regressions | ✅ **53/53** |
| `npm run test:quality` | End-to-end handoff quality across S1/S2/S3 | ✅ **20/20** |
| `npm run test:brutal:quick` | Real-data extraction calibration (WildChat + SWE-bench) | ✅ PASS |
| `npm run test:lifecycle:quick` | 100-cycle real-data lifecycle / archive retention observation | ✅ PASS |
| `node benchmark/test-adversarial.mjs --model llama3.2-3b` | Hostile SLM inputs A1–A11 | ✅ **11/11** |
| `node benchmark/test-adversarial.mjs --model qwen` | Hostile SLM inputs A1–A11 | ✅ **11/11** |
| `node benchmark/test-adversarial.mjs --model gemma3-4b` | Hostile SLM inputs A1–A11 | ✅ **11/11** |
| `node benchmark/test-tier-comparison.mjs` | Cross-tier compaction retention (4→20 cycles) | ✅ **38/38** on `tier3`, `tier3b`, `tier3c` |
| `node benchmark/test-scale.mjs` | Prompt-length stability | ✅ Llama **16/16** · Qwen **15/16** |
| `node benchmark/test-compaction-marathon.mjs` | Multi-compaction memory retention | ✅ **53/53** |
| `node benchmark/test-diffmode.mjs` | Grammar-constrained JSON output | ✅ PASS for Llama 3.2 3B + Qwen3.5 4B |

### What Those Results Mean

#### Handoff Quality

`npm run test:quality` exercises the full path from session events to next-session context injection.

| Scenario | Assertions | Result |
|---|---|---|
| S1 — Initial session | 6/6 | ✅ |
| S2 — Hot resume | 5/5 | ✅ |
| S3 — Marathon / cold start | 9/9 | ✅ |

**Total: 20/20**

#### Real-Data Retrieval / Retention

`npm run test:brutal:quick` and `npm run test:lifecycle:quick` use public external datasets:
- WildChat-1M coding conversations
- SWE-bench GitHub issue statements

Current verified observations:
- extraction brutal calibration: **PASS**
- adversarial extractor traps: **15/15**
- chain phase `extract → store → search → snapshot`: **PASS**
- lifecycle checkpoints: **100% / 80% / 80% / 100%** FTS5 recall at cycles 25 / 50 / 75 / 100
- cycle 100 recall by source: **WildChat 5/7 (71%)**, **SWE-bench 13/13 (100%)**

The two misses in the lifecycle run were low-signal terms (`nothing`, `creator`), not archive corruption.

#### SLM Adversarial Robustness

The adversarial suite is the hardest accuracy benchmark in the repo: code walls, stack traces, multilingual sessions, flip-flop errors, domain jargon, buried current tasks, and multi-compaction chains.

Current verified scores:

| Model | Score |
|---|---|
| Llama 3.2 3B Q5_K_M | **11/11** |
| Qwen3.5 4B Q4_K_M | **11/11** |
| Gemma 3 4B QAT Q4_0 | **11/11** |

This matters because **A11 used to be the real gap**. It now passes after the deterministic carry-forward state was added to the compaction chain.

#### SLM Scale Stability

`node benchmark/test-scale.mjs` probes prompt growth from 128 to 985 words.

| Model | Result |
|---|---|
| Llama 3.2 3B | **16/16** |
| Qwen3.5 4B | **15/16** |

Current caveat:
- Qwen 4B had **one** miss at S4 (985 words) on the no-hallucination check.

#### Cross-Tier Compaction Retention

`node benchmark/test-tier-comparison.mjs` runs the same 4→20 cycle compaction stress test across all three production GGUF tiers.

| Tier | Result |
|---|---|
| `tier3` — Llama 3.2 3B | **38/38** |
| `tier3b` — Qwen3.5 4B | **38/38** |
| `tier3c` — Gemma 3 4B | **38/38** |

At the time of this README update, the verified token savings vs raw snapshot were:
- `tier3`: **24–26%**
- `tier3b`: **16–23%**
- `tier3c`: **20–28%**

#### Multi-Compaction Marathon

`node benchmark/test-compaction-marathon.mjs` simulates long-running sessions across 4, 8, 12, 16, and 20 compaction cycles.

Current verified result:
- **53/53 assertions passed**
- all anchor facts survived through **20 compaction cycles**

### Important Caveats

- `tier3` still occasionally falls back from grammar-constrained diff-mode to prose in some runs. Correctness stayed green in the verified suites above, but the fallback still exists.
- Qwen 4B is strong overall, but its current scale run is **15/16**, not perfect.
- The old `A11` failure is no longer the current state and should not be cited as a live weakness.
- `benchmark/test-160k-real.mjs` was **not rerun after the carry-forward patch**, so its older numbers are intentionally omitted from the headline claims here.

### Bottom-Line Read

ECC is now strong in the places that matter most for a CLI memory substrate:
- real-data extraction and retention
- end-to-end handoff quality
- chained compaction continuity
- cross-tier SLM robustness

The retrieval layer remains the long-term safety net. The SLM layer is now good enough to carry forward session state across compactions without the old A11 collapse.

---

## Development

```bash
npm run build       # Compile TypeScript → build/
npm run typecheck   # Type check without emit
npm run clean       # Remove build/
npm run setup       # Build + run setup CLI
```

**Runtime requirements:**
- Node.js >= 18 (all hooks, MCP server, setup CLI)

---

## Platform Support

EngramCC runs on **Windows**, **macOS**, and **Linux** (x64 and ARM64).

| Dependency | Type | Platform coverage |
|---|---|---|
| better-sqlite3 | Native C++ addon | Prebuilt binaries for all major platforms + Node versions |
| node-llama-cpp (Tier 3) | Native addon | 13 prebuilt variants: Windows/macOS/Linux × x64/ARM64 × CPU/CUDA/Vulkan/Metal |
| sqlite-vec (Vector store) | Native addon | Prebuilt for Windows x64, macOS x64/ARM64, Linux x64/ARM64 |
| @huggingface/transformers (Tier 2) | Pure JS + WASM | Universal — no native code |
| All other deps | Pure JS | Universal |

### Troubleshooting: `better-sqlite3` build failure

`better-sqlite3` is the only hard dependency that requires native compilation. It ships with prebuilt binaries for common platform + Node version combinations. If the prebuilt doesn't match your setup, npm falls back to compiling from source, which requires:

**Windows:**
```powershell
npm install --global windows-build-tools
# or install Visual Studio Build Tools with "Desktop development with C++"
```

**macOS:**
```bash
xcode-select --install
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt install build-essential python3
```

**Linux (Fedora/RHEL):**
```bash
sudo dnf groupinstall "Development Tools"
```

If `npm install` fails with `gyp ERR!` or `node-pre-gyp` errors, installing the build tools above and re-running `npm install` will fix it.

### Troubleshooting: Local SLM tier not available

The local synthesis tiers require GGUF models in the shared models directory configured for the project. If no supported Tier 3 model is present, EngramCC falls back to Tier 2 (embeddings) or Tier 1 (rule-based).

Examples:

```bash
npx engram-cc download-model tier3
npx engram-cc download-model tier3b
npx engram-cc download-model tier3c
```

Approximate runtime requirements:
- `tier3` Llama 3.2 3B: ~4 GB RAM
- `tier3b` Qwen3.5 4B: ~3.5 GB RAM
- `tier3c` Gemma 3 4B: ~3 GB RAM

### Troubleshooting: Vector store not active

The vector store uses `sqlite-vec`, which is an optional dependency. If it fails to load, EngramCC operates normally without vector search — all other memory tiers (episodic, semantic, working) are unaffected. To verify:

```bash
node -e "require('sqlite-vec')" 2>&1 || echo "sqlite-vec not available — vector search disabled"
```

---

## Project Structure

```
src/
├── hooks/          ← Lifecycle hook entry points (.mjs + .ts)
├── adapters/       ← Per-assistant registration (Claude Code, Gemini CLI, etc.)
├── session/        ← SQLite event capture, schema, FTS5
├── memory/         ← Working YAML, knowledge graph, vector store
├── handoff/        ← Session handoff writer, reader, dedup
├── compression/    ← SLM pipeline: tier selection, ONNX, node-llama-cpp
├── mcp/            ← MCP stdio server
├── tokenization/   ← Token budget auditor
├── project-id.ts   ← Stable project UUID resolution
└── cli/
    ├── setup.ts    ← Install CLI: hardware detection, adapter registration
    └── download-model.ts ← GGUF model downloader
```

---

## License

Elastic License 2.0 — free to use for internal tooling; contact for redistribution or hosted use.
