# Engram Context Continuum (EngramCC) — Project Context

Last verified: 2026-03-12
This file is the project-specific companion to CLAUDE.md.
Code and migrations win over this file when facts conflict.

## 0. Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (compiled to ESM via tsc) |
| Hooks runtime | Node.js .mjs (ES modules, no compile step) |
| Stop hook runtime | Bun (TypeScript native, no compile step) |
| Database | SQLite via better-sqlite3 (one .db per project) |
| Full-text search | SQLite FTS5 virtual table |
| Knowledge graph | SQLite tables (graph_nodes + graph_edges + BFS) |
| Vector store | sqlite-vec extension (optional, graceful fallback) |
| SLM Tier 2 | @huggingface/transformers ONNX — embeddings |
| SLM Tier 3 | node-llama-cpp + Llama 3.2 3B / Qwen3.5 4B / Gemma 3 4B GGUF (all 10/10 adversarial) |
| SLM Tier 4 | External HTTP provider (Ollama / LM Studio / Groq) |
| Memory files | YAML (handoff.yaml, working.yaml in .engram-cc/) |
| Project identity | UUID in .ecc-id (git-root-hash fallback, generated fallback) |
| Install CLI | `engramcc` / `npx engram-cc` (src/cli/setup.ts) |
| MCP server | @modelcontextprotocol/sdk stdio server |

## 1. Project Purpose

EngramCC is the universal AI session memory substrate — a single install that gives
every AI coding assistant on your machine persistent context across sessions, folder
renames, and tool switches. It eliminates context loss, compaction amnesia, and the
token waste of re-orienting an AI every session.

It operates as session middleware: lifecycle hooks capture events while the AI works,
a local SLM synthesizes memory offline at session end, and an MCP server serves the
pre-digested context on demand to any connected assistant.

Supported assistants: Claude Code, Gemini CLI, VS Code Copilot, Codex CLI, OpenCode, Cursor.

## 2. Priority Order

When facts conflict, use:
1. Runtime code and compiled build output
2. Database schema (src/session/db.ts)
3. README.md
4. This file (PROJECT.md)
5. CLAUDE.md

## 3. Runtime Snapshot

- **No auth, no network** — fully local, zero remote calls for core function
- **Project identity** — stable UUID from `.ecc-id` file; falls back to git root commit
  hash; falls back to fresh UUIDv4. Written once, survives renames and moves.
- **Session DB path** — `~/.engram-cc/sessions/<uuid>.db`
- **Hook event flow:**
  - `UserPromptSubmit` — captures user intent, stores to DB
  - `PostToolUse` — captures tool results, file ops, errors + subconscious retrieval:
    on Edit/Write/Bash/AskUserQuestion, searches VectorDB (cross-session) and FTS5
    (current session) for relevant memories and injects them as additionalContext
  - `PreCompact` — 3-layer compaction recovery: XML snapshot + SLM brief + engram
    retrieval (vector/FTS/graph). Parallel on power hardware (VRAM ≥ 12 GB).
  - `SessionStart` — tiered injection: full handoff if < 30 min old, headline + MCP
    pointer if cold start. On compact: XML snapshot + SLM brief + retrieved engrams.
  - `Stop` — synthesizes working_context + headline via local SLM, writes handoff
    YAML, updates knowledge graph, embeds high-value events to vector store
- **Adapter registration** — `setup.ts` detects installed assistants and registers
  hooks + MCP for each. Claude Code has full hook support; other assistants get MCP.
- **SLM pipeline** — used for: compress() in precompact, embed() for vector store,
  working_context and headline synthesis in stop hook. Zero API calls for ECC processing.
- **Tiered injection** (sessionstart.mjs):
  - Hot resume (< 30 min): full handoff XML injected into additionalContext
  - Cold start: `<session_brief>` headline + "Full context via recall MCP tool"

## 4. High-Signal Files

**Project identity:**
- `src/project-id.ts` — getProjectId() and getProjectDBPath(): UUID resolution with
  3-tier fallback (.ecc-id → git root commit → fresh UUID)
- `.ecc-id` — stable project UUID (committed or gitignored per preference)

**Core hooks:**
- `src/hooks/stop.ts` — Stop hook: compressor + handoff + graph + vector pipeline
- `src/hooks/sessionstart.mjs` — SessionStart: tiered context injection
- `src/hooks/posttooluse.mjs` — PostToolUse: event capture
- `src/hooks/precompact.mjs` — PreCompact: 3-layer compaction recovery (XML snapshot + SLM brief + engram retrieval); parallel on power hardware
- `src/hooks/userpromptsubmit.mjs` — UserPromptSubmit: intent capture
- `src/hooks/session-helpers.mjs` — Shared path/ID utilities (uses getProjectId)

**Memory layers:**
- `src/handoff/writer.ts` — HandoffData builder (async, SLM synthesis for working_context)
- `src/handoff/reader.ts` — YAML loader with staleness guard
- `src/memory/working.ts` — Cross-session YAML ledger (preferences, decisions, hot files)
- `src/memory/graph.ts` — SQLite knowledge graph (nodes/edges/BFS)
- `src/memory/vector.ts` — sqlite-vec wrapper with graceful fallback

**SLM / compression:**
- `src/compression/index.ts` — getCompressor() + getHardwareProfile() factories
- `src/compression/detect.ts` — RAM/VRAM detection (nvidia-smi, rocm-smi, wmic); HardwareProfile
- `src/compression/tier3.ts` — node-llama-cpp GGUF compressor (uses .engram-cc/models/)
- `src/compression/types.ts` — Compressor interface (compress, embed, isAvailable)

**Engram retrieval (compaction recovery):**
- `src/session/engram-retrieval.ts` — 4-path retrieval engine: vector, FTS5, graph BFS, anchor facts
- `src/session/compact-brief.ts` — SLM-compressed brief generator for compaction recovery
- `src/session/compact-budget.ts` — Dynamic token budget calculator (scales with compact_count)

**Multi-assistant:**
- `src/adapters/types.ts` — AssistantAdapter interface
- `src/adapters/index.ts` — registerAll() orchestrator
- `src/adapters/claude-code.ts` — Claude Code hooks + MCP registration
- `src/adapters/gemini-cli.ts` — Gemini CLI hooks + MCP registration
- `src/adapters/vscode-copilot.ts` — VS Code Copilot MCP registration
- `src/adapters/codex-cli.ts` — Codex CLI MCP registration
- `src/adapters/opencode.ts` — OpenCode hooks + MCP registration
- `src/adapters/cursor.ts` — Cursor MCP registration

**MCP server:**
- `src/mcp/server.ts` — recall, search, recent, graph_query tools

**Install CLI:**
- `src/cli/setup.ts` — Hardware detection, tier selection, adapter registration, model download
- `src/cli/download-model.ts` — GGUF model downloader (hf CLI + fetch fallback)

## 5. Backend Surface

No HTTP API. Entry points are AI assistant lifecycle hooks:

| Hook | File | Fires when |
|---|---|---|
| UserPromptSubmit | posttooluse.mjs | User sends a message |
| PostToolUse | posttooluse.mjs | Any tool completes |
| PreCompact | precompact.mjs | Context window nears limit |
| SessionStart | sessionstart.mjs | Session opens or resumes |
| Stop | stop.ts | Session closes |

MCP tools (served via stdio to any connected assistant):

| Tool | Purpose |
|---|---|
| recall | Full session context: handoff + working memory |
| search | FTS5 full-text search over all session events |
| recent | Most recent N session events, filterable by category |
| graph_query | BFS traversal of the knowledge graph |
| semantic_search | Vector similarity search over embedded session events (MiniLM) |

## 6. Security Baseline

- No network surface — fully local operation
- No credentials, tokens, or API keys in any config
- DB and YAML files live in `~/.engram-cc/` — local user only
- `.ecc-id` contains only a UUID — not sensitive
- No PII handling beyond project file paths in event data

## 7. Data Design Rules

- **Project identity key**: UUID from `.ecc-id` (not a path hash — survives renames)
- **Session DB**: `~/.engram-cc/sessions/<uuid>.db`
- **Events file**: `~/.engram-cc/sessions/<uuid>-events.md`
- **Cleanup flag**: `~/.engram-cc/sessions/<uuid>.cleanup`
- **Handoff YAML**: `<projectDir>/.engram-cc/handoff.yaml`
- **Working memory**: `<projectDir>/.engram-cc/working.yaml`
- **GGUF models**: `~/.engram-cc/models/<model-file>.gguf`
- All timestamps: UTC ISO 8601
- Event dedup: SHA256 hash on (session_id + type + data) — never store duplicates
- FIFO eviction when episodic DB hits capacity
- SLM synthesis: working_context + headline generated at session end; all structured
  fields (files_modified, decisions, errors) remain rule-based with 100% recall

## 8. Hardware Profiles

Detected automatically at startup — cannot be forced via config.

| Profile | Condition | Pipeline behavior |
|---------|-----------|-------------------|
| `minimal` | No GPU / VRAM < 4 GB | Sequential PreCompact, single model |
| `standard` | VRAM 4–11 GB or RAM ≥ 16 GB | Sequential PreCompact, GPU-assisted |
| `power` | VRAM ≥ 12 GB or Apple Silicon ≥ 16 GB | Parallel PreCompact (SLM + retrieval concurrent) |

Detection: `nvidia-smi` (NVIDIA), `rocm-smi` (AMD Linux), `wmic` (Windows vendor-agnostic), total RAM proxy (Apple Silicon). All calls are cached after first invocation and time out at 500ms.

Disable subconscious retrieval (PostToolUse): `ENGRAM_SUBCONSCIOUS=0`

## 9. Known Mismatches / Technical Debt

- **All hooks run via Node** — stop.ts is compiled to build/hooks/stop.js and run via
  Node like every other hook. Previously used Bun for TS-native execution, but Bun
  does not support the better-sqlite3 native addon, which silently broke the knowledge
  graph and vector store in every stop hook invocation.
- **headline field is optional in HandoffData** — backward compat: old YAML files
  written before this field existed are still valid. Reader handles missing field.
- **graph_nodes/graph_edges store project_dir as a column** — used for display and
  cross-session queries within the per-project DB. Column is kept even though the DB
  itself is already project-scoped (UUID filename) — it's useful for the MCP server
  which opens DBs read-only and benefits from the filter.
- **node-llama-cpp on Windows requires MSVC build tools** — setup CLI warns but does
  not install. Users on Windows without build tools fall back to tier2 or tier1.
- **sqlite-vec is optional** — vector search degrades gracefully to no-op if the
  extension is not available. Core functionality unaffected.
- **Multi-compaction session handoff** — Fixed (2026-03-12). The stop hook now reads
  the full compaction chain from `session_resume_history` (one row per cycle, append
  model) and passes it into `buildHandoffFromEvents()`. `buildSynthesisInput()` accepts
  `priorCompactionBriefs[]` and prepends them before the tail events so the SLM
  synthesizes the full session arc. `precompact.mjs` writes to both `session_resume`
  (current-snapshot for sessionstart injection) and `session_resume_history` (chain for
  stop hook). SLM briefs are chain-aware from cycle 2 onward — each brief receives
  prior briefs as context. Benchmark: A11 in test-adversarial.mjs validates
  multi-compaction synthesis quality.

## 10. Related Contracts

- `CLAUDE.md` — universal co-developer standard (this project follows it)
- `src/hooks/README.md` — hook system documentation
- `src/adapters/` — each adapter has inline documentation of its config file format
- `plugin-config.yaml` — compression tier override and external provider config
