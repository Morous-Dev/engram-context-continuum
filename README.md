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

The setup CLI auto-detects which AI assistants are installed, selects the best local SLM for your hardware, downloads it, and registers hooks + MCP with each assistant. No configuration required.

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

EngramCC synthesizes session memory using a local SLM — zero API calls for its own processing.

The setup CLI detects your hardware and selects the best available tier:

| Tier | Model | RAM needed | What it does |
|---|---|---|---|
| 1 | Rule-based | 0 | Always-on heuristic extraction |
| 2 | MiniLM-L6-v2 ONNX | ~400 MB | Embeddings via @huggingface/transformers |
| 3 | Llama 3.2 3B Q5_K_M | ~4 GB | Full synthesis via node-llama-cpp |
| 4 | Ollama / LM Studio / Groq | user-provided | External HTTP provider |

**Why Llama 3.2 3B?** We tested Qwen 2.5 1.5B, Llama 3.2 3B, and Phi-4 Mini 3.8B on three critical tasks: code-aware description, conflict resolution, and intent extraction. Llama 3.2 3B scored 3/3. The other two hallucinated that unresolved errors were fixed — a disqualifier for a memory system.

Models are stored in `~/.engram-cc/models/` and downloaded once. Tiers auto-cascade: if Tier 3 is unavailable, Tier 2 runs; if Tier 2 is unavailable, Tier 1 runs. Core functionality is never blocked.

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
~/.engram-cc/
├── sessions/
│   └── <uuid>.db               ← SQLite DB per project (all memory tiers)
└── models/
    └── <model>.gguf             ← Downloaded GGUF models (shared across projects)

<projectDir>/.engram-cc/
├── handoff.yaml                 ← Session handoff (hot resume data)
└── working.yaml                 ← Cross-session working memory
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
# Force a specific compression tier (default: auto-detect)
compression_tier: 3a

# External provider (Tier 4) config
external_provider:
  url: http://localhost:11434/api/generate
  model: llama3.2
```

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

### Troubleshooting: Tier 3 (node-llama-cpp) not available

Tier 3 requires the Llama 3.2 3B GGUF model (~2.32 GB) in `~/.engram-cc/models/`. If not present, EngramCC falls back to Tier 2 (embeddings) or Tier 1 (rule-based). To enable Tier 3:

```bash
npx engram-cc download-model tier3
```

Requires ~4 GB free RAM at runtime.

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
