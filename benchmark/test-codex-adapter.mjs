/**
 * test-codex-adapter.mjs — Regression tests for the Codex transcript bridge.
 *
 * Verifies:
 *   - Codex transcript sync discovers the active session file by project
 *   - user prompts and tool results are captured exactly from transcript items
 *   - apply_patch becomes precise file edit/write events instead of fake tool noise
 *   - incremental sync only returns newly appended transcript records
 *   - stop hook performs a final transcript sync before writing handoff
 *   - compaction trigger thresholds remain stable
 *
 * Run via: node benchmark/test-codex-adapter.mjs
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const BUILD = join(ROOT, "build");

const { syncCodexTranscript, extractApplyPatchEvents, clearCodexTranscriptState } =
  await import(pathToFileURL(join(BUILD, "adapters", "codex-transcript.js")).href);
const { shouldCodexTriggerCompaction } =
  await import(pathToFileURL(join(BUILD, "adapters", "codex-plug.js")).href);
const { ingestEvent, ingestPrompt } =
  await import(pathToFileURL(join(BUILD, "session", "ingest.js")).href);
const { SessionDB } =
  await import(pathToFileURL(join(BUILD, "session", "db.js")).href);
const { getProjectDBPath } =
  await import(pathToFileURL(join(BUILD, "project-id.js")).href);
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

function makeTranscriptFile(baseDir, sessionId, projectDir, lines) {
  const transcriptDir = join(baseDir, "sessions", "2026", "03", "15");
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(
    transcriptDir,
    `rollout-2026-03-15T10-00-00-${sessionId}.jsonl`,
  );
  const sessionMeta = JSON.stringify({
    timestamp: "2026-03-15T02:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      cwd: projectDir,
      cli_version: "0.114.0",
      source: "cli",
    },
  });
  writeFileSync(transcriptPath, [sessionMeta, ...lines].join("\n") + "\n", "utf-8");
  return transcriptPath;
}

function makeShellCall(callId, command, output) {
  return [
    JSON.stringify({
      timestamp: "2026-03-15T02:00:05.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        arguments: JSON.stringify({ command }),
        call_id: callId,
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-15T02:00:06.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    }),
  ];
}

console.log("\n  Codex transcript adapter regressions\n");

// ── Transcript sync ─────────────────────────────────────────────────────────

console.log("  Transcript sync:");
{
  const projectDir = join(tmpdir(), `ecc-codex-transcript-${Date.now()}`);
  const codexHome = join(projectDir, "codex-home");
  const sessionId = "019cf000-1234-7234-9234-123456789abc";

  mkdirSync(join(projectDir, ".engram-cc", "logs"), { recursive: true });

  const transcriptPath = makeTranscriptFile(codexHome, sessionId, projectDir, [
    JSON.stringify({
      timestamp: "2026-03-15T02:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Please fix the auth modal and keep the current draft text intact.",
      },
    }),
    ...makeShellCall(
      "call-shell-1",
      "npm test",
      "Exit code: 0\nWall time: 0.4 seconds\nOutput:\nPASS auth modal tests",
    ),
    JSON.stringify({
      timestamp: "2026-03-15T02:00:07.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        status: "completed",
        call_id: "call-patch-1",
        name: "apply_patch",
        input: [
          "*** Begin Patch",
          "*** Update File: src/auth/modal.ts",
          "@@",
          "-old",
          "+new",
          "*** Add File: src/auth/modal.test.ts",
          "+test",
          "*** End Patch",
        ].join("\n"),
      },
    }),
  ]);

  const previousCodeHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    const synced = await syncCodexTranscript({
      assistant: "codex",
      projectDir,
      projectId: "project-1",
      fallbackSessionId: "pid-123",
      timestamp: "2026-03-15T02:00:08.000Z",
      resetState: true,
    });

    assert(synced.transcriptPath === transcriptPath, "discovers active Codex transcript by project");
    assert(synced.sessionId === sessionId, "uses canonical Codex session id from session_meta");
    assert(synced.promptEvents.length === 1, "captures user_message as prompt event");
    assert(synced.promptEvents[0]?.source_kind === "transcript", "prompt event is marked transcript source");
    assert(synced.toolEvents.length === 2, "captures shell command and apply_patch as tool events");
    assert(
      synced.toolEvents.some(event => event.payload.kind === "post_tool_use" && event.payload.tool_name === "Bash"),
      "normalizes shell_command to Bash",
    );
    assert(
      synced.toolEvents.some(event => event.payload.kind === "post_tool_use" && (event.payload.tool_name === "Edit" || event.payload.tool_name === "Write")),
      "normalizes apply_patch to file edit/write tool",
    );

    const patchEvents = extractApplyPatchEvents([
      "*** Begin Patch",
      "*** Update File: src/auth/modal.ts",
      "*** Add File: src/auth/modal.test.ts",
      "*** End Patch",
    ].join("\n"));
    assert(patchEvents.some(event => event.type === "file_edit"), "apply_patch extracts file_edit events");
    assert(patchEvents.some(event => event.type === "file_write"), "apply_patch extracts file_write events");

    for (const promptEvent of synced.promptEvents) {
      await ingestPrompt(promptEvent);
    }
    for (const toolEvent of synced.toolEvents) {
      await ingestEvent(toolEvent);
    }

    const db = new SessionDB({ dbPath: getProjectDBPath(projectDir) });
    try {
      const events = db.getEvents(sessionId);
      assert(events.some(event => event.type === "user_prompt"), "prompt was stored in session db");
      assert(events.some(event => event.type === "file_edit" && event.data.includes("src/auth/modal.ts")), "apply_patch stored updated file path");
      assert(events.some(event => event.type === "file_write" && event.data.includes("src/auth/modal.test.ts")), "apply_patch stored created file path");
      assert(events.some(event => event.type === "checkpoint_test"), "Bash transcript still extracts checkpoints");
    } finally {
      db.close();
    }

    const nothingNew = await syncCodexTranscript({
      assistant: "codex",
      projectDir,
      projectId: "project-1",
      fallbackSessionId: "pid-123",
      timestamp: "2026-03-15T02:00:09.000Z",
    });
    assert(nothingNew.promptEvents.length === 0 && nothingNew.toolEvents.length === 0, "incremental sync does not replay old transcript lines");

    appendFileSync(
      transcriptPath,
      [
        ...makeShellCall(
          "call-shell-2",
          "npm run build",
          "Exit code: 1\nWall time: 0.5 seconds\nOutput:\nError: build failed",
        ),
      ].join("\n") + "\n",
      "utf-8",
    );

    const appended = await syncCodexTranscript({
      assistant: "codex",
      projectDir,
      projectId: "project-1",
      fallbackSessionId: "pid-123",
      timestamp: "2026-03-15T02:00:10.000Z",
    });
    assert(appended.toolEvents.length === 1, "incremental sync returns only appended tool output");
    assert(
      appended.toolEvents[0]?.payload.kind === "post_tool_use" && appended.toolEvents[0].payload.tool_name === "Bash",
      "appended shell command remains normalized to Bash",
    );
  } finally {
    clearCodexTranscriptState(projectDir);
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    rmSync(projectDir, { recursive: true, force: true });
  }
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

// ── Session start guidance ──────────────────────────────────────────────────

console.log("\n  Session start:");
{
  const projectDir = join(tmpdir(), `ecc-codex-sessionstart-${Date.now()}`);
  const codexHome = join(projectDir, "codex-home");
  mkdirSync(join(projectDir, ".engram-cc", "logs"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  const hookPath = join(ROOT, "src", "hooks", "codex-sessionstart.mjs");

  try {
    const result = spawnSync(
      process.execPath,
      [hookPath],
      {
        input: JSON.stringify({ source: "startup", cwd: projectDir, session_id: "fallback-session" }),
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          ENGRAM_PROJECT_DIR: projectDir,
          ENGRAM_ASSISTANT: "codex",
        },
        encoding: "utf-8",
      },
    );

    assert(result.status === 0, "codex-sessionstart wrapper exits cleanly");

    let payload = null;
    try {
      payload = JSON.parse(result.stdout.trim());
    } catch {
      payload = null;
    }

    const additionalContext = payload?.hookSpecificOutput?.additionalContext ?? "";
    assert(additionalContext.includes('<engram_turn_policy assistant="codex">'), "startup injects Codex turn policy");
    assert(additionalContext.includes("query engram-cc MCP first"), "turn policy steers Codex toward Engram MCP");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

// ── Stop hook end-to-end ────────────────────────────────────────────────────

console.log("\n  Stop hook:");
{
  const projectDir = join(tmpdir(), `ecc-codex-stop-${Date.now()}`);
  const codexHome = join(projectDir, "codex-home");
  const sessionId = "019cf000-5678-7678-a678-abcdefabcdef";
  mkdirSync(join(projectDir, ".engram-cc", "logs"), { recursive: true });

  makeTranscriptFile(codexHome, sessionId, projectDir, [
    JSON.stringify({
      timestamp: "2026-03-15T03:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Document the auth modal bug and keep the draft visible.",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-15T03:00:02.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        status: "completed",
        call_id: "call-patch-stop",
        name: "apply_patch",
        input: [
          "*** Begin Patch",
          "*** Update File: src/auth/modal.ts",
          "@@",
          "-loading=false",
          "+loading=true",
          "*** End Patch",
        ].join("\n"),
      },
    }),
  ]);

  const hookPath = join(BUILD, "hooks", "codex-stop.js");
  const previousCodeHome = process.env.CODEX_HOME;

  try {
    const result = spawnSync(
      process.execPath,
      [hookPath],
      {
        input: JSON.stringify({ cwd: projectDir, session_id: "fallback-session" }),
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          ENGRAM_PROJECT_DIR: projectDir,
          ENGRAM_ASSISTANT: "codex",
        },
        encoding: "utf-8",
      },
    );

    assert(result.status === 0, "codex-stop wrapper exits cleanly");
    const handoffPath = join(projectDir, ".engram-cc", "handoff.yaml");
    assert(existsSync(handoffPath), "stop hook writes handoff.yaml");
    const handoff = readFileSync(handoffPath, "utf-8");
    assert(handoff.includes(`session_id: ${sessionId}`), "stop hook uses canonical transcript session id");
    assert(handoff.includes("written_by: codex"), "stop hook preserves Codex provenance");
    assert(handoff.includes("src/auth/modal.ts"), "stop hook final sync includes transcript-derived file edits");
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    rmSync(projectDir, { recursive: true, force: true });
  }
}

console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
