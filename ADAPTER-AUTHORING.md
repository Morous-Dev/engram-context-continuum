# Adapter Authoring

This file defines how to add or extend an AI assistant adapter in Engram Context Continuum without reintroducing assistant-specific drift into the core memory pipeline.

## Goal

Adapters are thin integration layers.

They exist to:
- detect whether an assistant is installed
- generate project-local hook and MCP snippets under `.engram-cc/assistant-configs/`
- translate assistant-specific payloads into normalized ECC ingest events
- declare honest lifecycle capability coverage

They do not exist to fork core memory behavior per assistant.

## Current State

ECC is adapter-oriented, but not fully universal yet.

What is already clean:
- normalized capability contract in `src/adapters/types.ts`
- centralized registry in `src/adapters/index.ts`
- normalized ingest pipeline in `src/session/ingest.ts`
- normalized extraction input contract in `src/session/extract.ts`
- per-assistant wrapper hooks such as `src/hooks/codex-pretooluse.mjs`
- Windows-safe hook command generation via `src/hooks/hook-runner.mjs`

What is still legacy-biased:
- `src/hooks/assistant-startup.mjs` currently contains only Claude-specific startup capture
- hook capability parity is still uneven (Codex still lacks a native compact hook)

So the rule is: new adapters should plug into the normalized adapter surface, not copy Claude-specific assumptions deeper into the system.

## Required Touch Points

For a new CLI assistant, these are the normal files to add or edit:

1. Add one adapter file under `src/adapters/<assistant>.ts`
2. Register it in `src/adapters/index.ts`
3. Declare capability tiers in `src/adapters/types.ts` terms:
   - `native`
   - `transcript`
   - `synthesized`
   - `unsupported`
4. Generate project-local snippets via `src/adapters/local-config.ts`
5. Add wrapper hooks only if the assistant payload shape differs from the generic hook entrypoints
6. Add assistant-specific regression coverage under `benchmark/`
7. Update user-facing docs:
   - `README.md`
   - `PROJECT.md`

## Normal Adapter Shape

An adapter should do only two registration jobs:

- `registerHooks(packageRoot, projectRoot)`
- `registerMcp(packageRoot, projectRoot)`

Those methods should emit local snippet files only. They must not mutate user-home assistant configs.

Use this pattern:
- `src/adapters/claude-code.ts`
- `src/adapters/gemini-cli.ts`
- `src/adapters/codex-cli.ts`

## Capability Rules

Capability labels must be honest.

- `native`
  The assistant exposes a real lifecycle event with enough payload to support ECC directly.
- `transcript`
  The assistant does not expose the lifecycle event as a hook, but it persists an exact transcript
  that ECC can consume without inventing state.
- `synthesized`
  ECC infers the lifecycle event from another assistant event or partial payload.
- `unsupported`
  The assistant does not expose the event with enough fidelity and ECC should not fake it.

Do not mark speculative behavior as `synthesized` if it materially invents state.

Low-fidelity fake events are worse than missing events.

Examples:
- Codex `user_prompt_submit` and `post_tool_use` are `transcript`, not `synthesized`, because ECC reads them from Codex's persisted session JSONL rather than guessing from the pre-tool payload.
- Cursor and VS Code Copilot are MCP-only today, so hook capabilities stay `unsupported`.
- Kilo is `unsupported` for native hooks today; the supported path is MCP plus the `ekilo` wrapper. Do not infer OpenCode-compatible hooks without primary-source proof.

## What You May Touch

These are normal adapter-authoring touch points:

- `src/adapters/*.ts`
- `src/adapters/index.ts`
- `src/adapters/types.ts`
- `src/adapters/local-config.ts`
- assistant-specific hook wrappers under `src/hooks/`
- assistant-specific bridge/policy helpers such as `src/adapters/codex-transcript.ts` and `src/adapters/codex-plug.ts`
- assistant-specific tests under `benchmark/`
- docs that describe support and limitations

## What You Should Not Touch

Do not edit these just to get one new assistant working:

- `src/session/db.ts`
- `src/session/ingest.ts`
- `src/handoff/*`
- `src/memory/*`
- `src/compression/*`
- `src/retrieval/*`
- event archive / carry-forward / compaction logic

Only change those files when you are generalizing ECC for all assistants, not patching one assistant.

## Storage Rules

Adapters must preserve ECC storage policy:

- project-local ECC state under `<project>/.engram-cc/`
- shared GGUF models in the user-chosen shared models directory from `<project>/.engram-cc/config.json`
- no silent writes to the home directory
- no assistant-specific state outside the project except the assistant's own config, and only if the user manually copies a generated snippet there

Setup may generate snippets in:
- `<project>/.engram-cc/assistant-configs/<assistant>/`

It must not auto-patch:
- `C:\Users\<user>\...`
- `~/.config/...`
- global package install locations

## Hook Integration Rules

If the assistant supports native lifecycle hooks, prefer thin wrappers around the normalized ingest pipeline.

Wrapper hooks should:
- parse stdin payload
- resolve project and session identity
- translate into normalized ECC events
- call ingest helpers
- never implement custom memory logic themselves

Good examples:
- `src/hooks/posttooluse.mjs`
- `src/hooks/precompact.mjs`
- `src/hooks/userpromptsubmit.mjs`
- `src/hooks/codex-pretooluse.mjs`

Bad pattern:
- embedding assistant-specific behavior directly into DB schema, handoff synthesis, or retrieval scoring

## Testing Requirements

Every new adapter should add regression tests for the behavior it claims to support.

Minimum checklist:
- installation detection
- snippet generation
- capability labels
- prompt extraction from native payloads
- session ID stability
- project directory resolution
- compaction trigger behavior if synthesized
- stop hook writes handoff correctly if `stop` is supported

Current example:
- `benchmark/test-codex-adapter.mjs`

## Current Portability Debt

These are the exact refactors still needed before ECC can honestly claim "new CLI adapters are routine":

1. Rename or reframe Claude-specific language in shared docs
   - shared hook and injection docs should describe "assistant context", not "Claude context", unless the file is actually Claude-specific

2. Keep extraction naming honest
   - keep assistant-specific read rules constrained (for example Claude-only `CLAUDE.md` rule capture)
   - keep the extractor input contract normalized (`assistant`, `tool_name`, `tool_input`, aliases)

3. Expand assistant-specific startup capture only when justified
   - `src/hooks/assistant-startup.mjs` is the right boundary for assistant-only startup context
   - new assistants should add logic there only for startup-only inputs that hooks cannot observe later

## Safe Workflow For New Adapters

When adding a new assistant:

1. Start with MCP support only if hooks are unclear
2. Add native hooks only when the assistant payloads are verified
3. Mark partial coverage honestly
4. Avoid synthesized events unless they are clearly defensible
5. Add tests before claiming support in the README
6. Update docs and capability labels in the same patch

## Definition Of Done

An adapter is ready to merge when:

- its snippet files generate correctly under `.engram-cc/assistant-configs/`
- capability tiers match reality
- no new home-directory writes were introduced
- no assistant-specific logic leaked into core memory layers
- benchmark coverage exists for the supported lifecycle surface
- `README.md` and `PROJECT.md` describe the adapter honestly

## Blunt Rule

If making one assistant work requires changing core memory behavior, the adapter is probably being implemented in the wrong layer.
