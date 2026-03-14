/**
 * test-codex-adapter.mjs — Regression tests for the Codex adapter bridge.
 *
 * Verifies:
 *   - prompt extraction from Codex pre_tool_use payloads
 *   - Codex translation does not fabricate post-tool outcomes
 *   - compaction trigger stays gated to heavy tools and rising thresholds
 *   - session ID precedence remains stable for Codex hook payloads
 *   - Codex stop pipeline writes a handoff file successfully
 *
 * Run via: node benchmark/test-codex-adapter.mjs
 * Depends on: build/adapters/codex-plug.js, build/session/ingest.js,
 *             build/session/db.js, src/hooks/session-helpers.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const BUILD = join(ROOT, "build");

const { translateCodexPreToolUse, shouldCodexTriggerCompaction } =
  await import(pathToFileURL(join(BUILD, "adapters", "codex-plug.js")).href);
const { SessionDB } =
  await import(pathToFileURL(join(BUILD, "session", "db.js")).href);
const { runStopPipeline } =
  await import(pathToFileURL(join(BUILD, "session", "ingest.js")).href);
const { getSessionId } =
  await import(pathToFileURL(join(ROOT, "src", "hooks", "session-helpers.mjs")).href);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log("\n  Codex adapter regressions\n");

// ── Translation ─────────────────────────────────────────────────────────────

console.log("  Translation:");
{
  const translated = translateCodexPreToolUse(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/app.ts",
        prompt: "Fix the modal bug in the compose panel and keep the current draft text intact.",
      },
    },
    {
      assistant: "codex",
      project_id: "project-1",
      project_dir: "D:/work/project",
      session_id: "session-1",
      timestamp: "2026-03-14T12:00:00.000Z",
    },
  );

  assert(translated.promptEvent !== null, "prompt extracted from tool input");
  assert(translated.promptEvent?.payload.kind === "user_prompt_submit", "prompt event kind is user_prompt_submit");
  assert(translated.preToolEvent.payload.kind === "pre_tool_use", "pre-tool event kind is pre_tool_use");
  assert(translated.preToolEvent.payload.extracted_events.length === 1, "pre-tool event uses explicit low-priority extracted event");
  assert(translated.preToolEvent.payload.extracted_events[0]?.type === "tool_use", "pre-tool event stores tool_use marker only");
  assert(!("postToolEvent" in translated), "translation no longer fabricates post-tool event");
}

// ── Compaction trigger ──────────────────────────────────────────────────────

console.log("\n  Compaction trigger:");
{
  assert(!shouldCodexTriggerCompaction("Read", 1200, 0), "read tool does not trigger compaction");
  assert(!shouldCodexTriggerCompaction("Edit", 899, 0), "edit below threshold does not trigger compaction");
  assert(shouldCodexTriggerCompaction("Edit", 900, 0), "edit at first threshold triggers compaction");
  assert(!shouldCodexTriggerCompaction("Edit", 999, 1), "second compaction threshold rises after first compact");
  assert(shouldCodexTriggerCompaction("Bash", 1050, 1), "heavy tool triggers at raised threshold");
}

// ── Session ID precedence ───────────────────────────────────────────────────

console.log("\n  Session ID precedence:");
{
  assert(
    getSessionId({ transcript_path: "C:/tmp/12345678-1234-1234-1234-123456789abc.jsonl", sessionId: "fallback" }) ===
      "12345678-1234-1234-1234-123456789abc",
    "transcript UUID wins over sessionId",
  );
  assert(
    getSessionId({ sessionId: "camel", session_id: "snake" }) === "camel",
    "camelCase sessionId wins over snake_case",
  );
  assert(
    getSessionId({ session_id: "snake" }) === "snake",
    "snake_case session_id used when camelCase absent",
  );
}

// ── Stop pipeline smoke test ────────────────────────────────────────────────

console.log("\n  Stop pipeline:");
{
  const projectDir = join(tmpdir(), `ecc-codex-stop-${Date.now()}`);
  const dataDir = join(projectDir, ".engram-cc");
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  const dbPath = join(dataDir, "sessions", "project.db");
  const handoffPath = join(dataDir, "handoff.yaml");
  const sessionId = "codex-stop-session";

  const previousProjectDir = process.env.ENGRAM_PROJECT_DIR;
  process.env.ENGRAM_PROJECT_DIR = projectDir;

  try {
    const db = new SessionDB({ dbPath });
    try {
      db.ensureSession(sessionId, projectDir);
      db.insertEvent(sessionId, {
        type: "user_prompt",
        category: "prompt",
        data: "Fix the auth modal bug",
        priority: 1,
      });
      db.insertEvent(sessionId, {
        type: "file_edit",
        category: "file",
        data: "src/modal.ts",
        priority: 1,
      });
    } finally {
      db.close();
    }

    await runStopPipeline({
      assistant: "codex",
      project_id: "project-1",
      project_dir: projectDir,
      session_id: sessionId,
      event_type: "stop",
      source_kind: "native_hook",
      confidence: "exact",
      payload: {
        kind: "stop",
      },
      timestamp: new Date().toISOString(),
    });

    assert(existsSync(handoffPath), "stop pipeline writes handoff.yaml");
    const handoff = readFileSync(handoffPath, "utf-8");
    assert(handoff.includes("session_id: codex-stop-session"), "handoff contains session id");
    assert(handoff.includes("written_by: codex"), "handoff records Codex provenance");
  } finally {
    if (previousProjectDir === undefined) delete process.env.ENGRAM_PROJECT_DIR;
    else process.env.ENGRAM_PROJECT_DIR = previousProjectDir;
    rmSync(projectDir, { recursive: true, force: true });
  }
}

console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
