# Engram Context Continuum (EngramCC) — Project Context

Last verified: 2026-03-14
This file is the project-specific companion to AGENTS.md.
Code and migrations win over this file when facts conflict.

## 0. Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (compiled to ESM via tsc) |
| Hooks runtime | Node.js .mjs (ES modules, no compile step) |
| Stop hook runtime | Node.js (compiled TypeScript: `stop.ts` → `build/hooks/stop.js`) |
| Database | SQLite via better-sqlite3 (one .db per project) |
| Full-text search | SQLite FTS5 virtual table |
| Knowledge graph | SQLite tables (graph_nodes + graph_edges + BFS) |
| Vector store | sqlite-vec extension (optional, graceful fallback) |
| SLM Tier 2 | @huggingface/transformers ONNX — hardware-profile-aware embedding specialist (BGE-large/BGE-base/MiniLM) |
| SLM Tier 3 | node-llama-cpp + Llama 3.2 3B / Qwen3.5 4B / Gemma 3 4B GGUF (current verified adversarial score: 11/11 on all three after carry-forward compaction fix) |
| Query Expander | node-llama-cpp + Gemma 3 1B QAT Q4_0 GGUF (FTS5 term expansion, optional) |
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

Supported assistants: Claude Code, Gemini CLI, VS Code Copilot, Codex CLI, OpenCode, Cursor. Codex CLI currently has partial hook coverage plus MCP.

## 2. Priority Order

When facts conflict, use:
1. Runtime code and compiled build output
2. Database schema (src/session/db.ts)
3. README.md
4. This file (PROJECT.md)
5. AGENTS.md

## 3. Runtime Snapshot

- **No auth, no network** — fully local, zero remote calls for core function
- **Project identity** — stable UUID from `.ecc-id` file; falls back to git root commit
  hash; falls back to fresh UUIDv4. Written once, survives renames and moves.
- **Session DB path** — `<projectDir>/.engram-cc/sessions/<uuid>.db`
- **Hook event flow:**
  - `UserPromptSubmit` — captures user intent, stores to DB; then embeds the prompt
    and retrieves semantically relevant past memories from VectorDB (distance < 0.60),
    injecting them as `additionalContext` before the active assistant processes the message
  - `PostToolUse` — captures tool results, file ops, errors; immediately embeds
    significant events (decision/error/task/rule) into VectorDB for within-session
    semantic memory (live continuous indexing); on Edit/Write/Bash/AskUserQuestion,
    also searches VectorDB (cross-session + live) and FTS5 (current session + archive)
    for relevant memories and injects them as additionalContext
  - `PreCompact` — 3-layer compaction recovery: XML snapshot + SLM brief + engram
    retrieval (vector/FTS/graph). Parallel on power/extreme hardware (VRAM ≥ 12 GB).
  - `SessionStart` — tiered injection: full handoff if < 30 min old, headline + MCP
    pointer if cold start. On compact: XML snapshot + SLM brief + retrieved engrams.
  - `Stop` — synthesizes working_context + headline via local SLM, writes handoff
    YAML, updates knowledge graph, bulk-embeds up to 50 high-value events to vector store
- **Adapter setup** — `setup.ts` generates project-local hook + MCP snippets under
  `.engram-cc/assistant-configs/`. No user-home config is mutated.
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
- `src/hooks/assistant-startup.mjs` — Assistant-specific startup capture boundary
- `src/hooks/hook-runner.mjs` — Windows-safe hook launcher for env injection
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
- `src/compression/tier3.ts` — node-llama-cpp GGUF compressor (uses the shared models dir from .engram-cc/config.json)
- `src/compression/types.ts` — Compressor interface (compress, embed, isAvailable)

**Engram retrieval (compaction recovery):**
- `src/session/engram-retrieval.ts` — 4-path retrieval engine: vector, FTS5, graph BFS, anchor facts
- `src/session/compact-brief.ts` — SLM-compressed brief generator for compaction recovery
- `src/session/compact-budget.ts` — Dynamic token budget calculator (scales with compact_count)

**Query expansion (PostToolUse FTS5 enrichment):**
- `src/retrieval/query-expander.ts` — Gemma 3 1B FTS5 query expansion (standalone, not a Compressor)

**Multi-assistant:**
- `src/adapters/types.ts` — AssistantAdapter interface
- `src/adapters/index.ts` — registerAll() orchestrator
- `src/adapters/claude-code.ts` — Claude Code hooks + MCP registration
- `src/adapters/gemini-cli.ts` — Gemini CLI hooks + MCP registration
- `src/adapters/vscode-copilot.ts` — VS Code Copilot MCP registration
- `src/adapters/codex-cli.ts` — Codex CLI partial hook + MCP registration
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
| UserPromptSubmit | userpromptsubmit.mjs | User sends a message |
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
| semantic_search | Vector similarity search over embedded session events (BGE-large/BGE-base/MiniLM per hardware profile) |

## 6. Security Baseline

- No network surface — fully local operation
- No credentials, tokens, or API keys in any config
- DB, YAML, logs, and setup snippets live in `<projectDir>/.engram-cc/`
- Models live in the shared directory configured in `<projectDir>/.engram-cc/config.json`
- `.ecc-id` contains only a UUID — not sensitive
- No PII handling beyond project file paths in event data

## 7. Data Design Rules

- **Project identity key**: UUID from `.ecc-id` (not a path hash — survives renames)
- **Session DB**: `<projectDir>/.engram-cc/sessions/<uuid>.db`
- **Events file**: `<projectDir>/.engram-cc/sessions/<uuid>-events.md`
- **Cleanup flag**: `<projectDir>/.engram-cc/sessions/<uuid>.cleanup`
- **Handoff YAML**: `<projectDir>/.engram-cc/handoff.yaml`
- **Working memory**: `<projectDir>/.engram-cc/working.yaml`
- **Project config**: `<projectDir>/.engram-cc/config.json`
- **GGUF models**: `<sharedModelsDir>/<model-file>.gguf`
- All timestamps: UTC ISO 8601
- Event dedup: SHA256 hash on (session_id + type + data) — never store duplicates
- FIFO eviction when episodic DB hits capacity
- SLM synthesis: working_context + headline generated at session end; all structured
  fields (files_modified, decisions, errors) remain rule-based with 100% recall

## 8. Hardware Profiles

Detected automatically at startup — cannot be forced via config.

| Profile | VRAM condition | Apple Silicon | Embedding model | Pipeline |
|---------|---------------|---------------|-----------------|----------|
| `minimal` | No GPU / VRAM < 4 GB | < 8 GB | MiniLM-L6 (384-dim) | Sequential |
| `standard` | VRAM 4–11 GB or RAM ≥ 16 GB | 8–15 GB | BGE-base-en-v1.5 (768-dim) | Sequential |
| `power` | VRAM 12–23 GB | 16–35 GB | BGE-large-en-v1.5 (768-dim) | Parallel (SLM+retrieval concurrent) |
| `extreme` | VRAM ≥ 24 GB | ≥ 36 GB | BGE-large-en-v1.5 (768-dim) | Parallel (SLM+retrieval concurrent) |

`power` and `extreme` use the same embedding model. The distinction matters for PreCompact
parallelism (SLM on GPU + retrieval on CPU run concurrently) and future model tiers.

Detection: `nvidia-smi` (NVIDIA), `rocm-smi` (AMD Linux), `wmic` (Windows vendor-agnostic), total RAM proxy (Apple Silicon). All calls are cached after first invocation and time out at 500ms.

Disable subconscious retrieval + live indexing: `ENGRAM_SUBCONSCIOUS=0`

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
- **Event archive for lifetime retention** — Fixed (2026-03-13). Events evicted from
  the 1000-event live buffer are copied to `session_events_archive` (cap 50,000) before
  deletion. Archive eviction removes NEWEST entries to preserve early-session anchors.
  `searchEvents()` queries both `session_events_fts` and `session_events_archive_fts`
  and merges results (archive results scored at 0.85x). PreCompact passes archive events
  to `buildResumeSnapshot()` for `renderKeyTopics()`. Lifetime retention benchmark: 0% →
  100% recall at cycle 100.
- **Adapter portability is improved, not finished** — Shared hook runtime resolution now
  honors `ENGRAM_PROJECT_DIR` / `ENGRAM_SESSION_ID` first, `src/hooks/stop.ts` uses the
  shared runtime project resolver, and Claude-only startup capture moved behind
  `src/hooks/assistant-startup.mjs` with legacy Claude env fallback preserved.
  Windows hook commands now route through `src/hooks/hook-runner.mjs` to avoid
  nested `cmd /C` quoting failures on spaced paths. Remaining portability debt is
  mainly capability parity, not core pathing/extraction: Codex remains partial hooks
  plus MCP, and startup capture is currently Claude-only by design.
- **tier3c (Gemma 3 4B) times out at 12+ compaction cycles** — The 60s SLM timeout fires during
  marathon sessions. Gemma 3 4B is slower than Llama 3.2 3B at this task; at 12–20 cycle inputs
  it exceeds the budget and PreCompact falls back to raw context. Gemma 3 4B is still viable for
  short sessions (< 8 compaction cycles). Llama 3.2 3B is the recommended tier3 model for
  marathon session users.
- **tier3b (Qwen3.5 4B) diff-mode unstable** — Falls back from grammar-constrained JSON to prose
  at 8+ compaction cycles. Output is still correct but unstructured; downstream fields relying on
  strict JSON schema (task_status enum, decisions[].status) may not parse. Prose fallback is safe
  for the working_context field but reduces handoff YAML structure quality.
- **Embedding specialist models** — Implemented (2026-03-13). Tier 2 now selects the
  embedding model based on hardware profile: extreme/power → BGE-large-en-v1.5 (768-dim),
  standard → BGE-base-en-v1.5 (768-dim), minimal → MiniLM-L6-v2 (384-dim). VectorDB
  auto-detects stored dimensions on open and transparently recreates the table on model
  upgrade. Live continuous indexing added to PostToolUse (significant events indexed
  immediately, not just at session end). Semantic retrieval added to UserPromptSubmit
  (every user message triggers cosine search, relevant memories injected as context).

## 10. Related Contracts

- `AGENTS.md` — repository collaboration contract for AI assistants and contributors
- `ADAPTER-AUTHORING.md` — rules for adding new assistant adapters safely
- `src/hooks/README.md` — hook system documentation
- `src/adapters/` — each adapter has inline documentation of its config file format
- `plugin-config.yaml` — compression tier override and external provider config
