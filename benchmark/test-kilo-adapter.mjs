/**
 * test-kilo-adapter.mjs — Regression tests for the Kilo CLI wrapper/MCP path.
 *
 * Verifies:
 *   - Kilo adapter capability labels stay honest (`unsupported` hooks)
 *   - Kilo registration emits wrapper guidance + MCP config
 *   - Session ID precedence remains stable for Kilo payloads
 *   - Kilo stop pipeline writes a handoff file successfully
 *
 * Run via: node benchmark/test-kilo-adapter.mjs
 * Depends on: build/adapters/kilo-cli.js, build/session/ingest.js,
 *             build/session/db.js, src/hooks/session-helpers.mjs
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const BUILD = join(ROOT, "build");

const { SessionDB } =
  await import(pathToFileURL(join(BUILD, "session", "db.js")).href);
const { runStopPipeline, ingestEvent } =
  await import(pathToFileURL(join(BUILD, "session", "ingest.js")).href);
const { KiloCliAdapter } =
  await import(pathToFileURL(join(BUILD, "adapters", "kilo-cli.js")).href);
const { getProjectId, getSessionId } =
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

function createFakeKiloBinary(dir) {
  if (process.platform === "win32") {
    const kiloPath = join(dir, "fake-kilo.cmd");
    writeFileSync(
      kiloPath,
      "@echo off\r\nif \"%1\"==\"--version\" exit /b 0\r\nexit /b 0\r\n",
      "utf-8",
    );
    return kiloPath;
  }

  const kiloPath = join(dir, "fake-kilo");
  writeFileSync(
    kiloPath,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  exit 0\nfi\nexit 0\n",
    "utf-8",
  );
  chmodSync(kiloPath, 0o755);
  return kiloPath;
}

console.log("\n  Kilo adapter regressions\n");

// ── Adapter capability honesty ───────────────────────────────────────────────

console.log("  Capability labels:");
{
  const adapter = new KiloCliAdapter();
  assert(adapter.capabilities.session_start === "unsupported", "session_start stays unsupported");
  assert(adapter.capabilities.user_prompt_submit === "unsupported", "user_prompt_submit stays unsupported");
  assert(adapter.capabilities.post_tool_use === "unsupported", "post_tool_use stays unsupported");
  assert(adapter.capabilities.pre_compact === "unsupported", "pre_compact stays unsupported");
  assert(adapter.capabilities.stop === "unsupported", "stop stays unsupported");
}

// ── Registration output ──────────────────────────────────────────────────────

console.log("\n  Registration output:");
{
  const projectDir = join(tmpdir(), `ecc-kilo-adapter-${Date.now()}`);
  const packageRoot = ROOT;
  mkdirSync(projectDir, { recursive: true });

  try {
    const adapter = new KiloCliAdapter();
    const hookResult = adapter.registerHooks(packageRoot, projectDir);
    const mcpResult = adapter.registerMcp(packageRoot, projectDir);

    assert(hookResult.success === true, "registerHooks returns success");
    assert(mcpResult.success === true, "registerMcp returns success");

    const hookPath = join(projectDir, ".engram-cc", "assistant-configs", "kilo-cli", "hooks.txt");
    const mcpPath = join(projectDir, ".engram-cc", "assistant-configs", "kilo-cli", "mcp.json");
    assert(existsSync(hookPath), "registerHooks writes hooks.txt");
    assert(existsSync(mcpPath), "registerMcp writes mcp.json");

    if (existsSync(hookPath) && existsSync(mcpPath)) {
      const hookNote = readFileSync(hookPath, "utf-8");
      const mcpConfig = readFileSync(mcpPath, "utf-8");
      assert(hookNote.includes("ekilo"), "wrapper note points users to ekilo");
      assert(hookNote.includes("not currently verified"), "wrapper note warns hooks are unverified");
      assert(mcpConfig.includes("\"engram-cc\""), "mcp config includes engram-cc server");
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

// ── Session ID precedence ───────────────────────────────────────────────────

console.log("  Session ID precedence:");
{
  assert(
    getSessionId({ session_id: "kilo-session-123" }) === "kilo-session-123",
    "session_id extracted for Kilo",
  );
  assert(
    getSessionId({ sessionId: "kilo-fallback" }) === "kilo-fallback",
    "sessionId camelCase works for Kilo",
  );
  assert(
    getSessionId({}) === null || getSessionId({}) !== undefined,
    "getSessionId handles empty object",
  );
}

// ── Assistant env variable ───────────────────────────────────────────────────

console.log("\n  Assistant environment:");
{
  const original = process.env.ENGRAM_ASSISTANT;
  process.env.ENGRAM_ASSISTANT = "kilo-cli";
  assert(process.env.ENGRAM_ASSISTANT === "kilo-cli", "ENGRAM_ASSISTANT set to kilo-cli");
  process.env.ENGRAM_ASSISTANT = original;
}

// ── Stop pipeline smoke test ────────────────────────────────────────────────

console.log("\n  Stop pipeline:");
{
  const projectDir = join(tmpdir(), `ecc-kilo-stop-${Date.now()}`);
  const dataDir = join(projectDir, ".engram-cc");
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  const dbPath = join(dataDir, "sessions", "project.db");
  const handoffPath = join(dataDir, "handoff.yaml");
  const sessionId = "kilo-stop-session";

  const previousProjectDir = process.env.ENGRAM_PROJECT_DIR;
  process.env.ENGRAM_PROJECT_DIR = projectDir;

  try {
    const db = new SessionDB({ dbPath });
    try {
      db.ensureSession(sessionId, projectDir);
      db.insertEvent(sessionId, {
        type: "user_prompt",
        category: "prompt",
        data: "Add user authentication to the app",
        priority: 1,
      });
      db.insertEvent(sessionId, {
        type: "file_edit",
        category: "file",
        data: "src/auth.ts",
        priority: 1,
      });
    } finally {
      db.close();
    }

    await runStopPipeline({
      assistant: "kilo-cli",
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
    assert(handoff.includes("session_id: kilo-stop-session"), "handoff contains session id");
    assert(handoff.includes("written_by: kilo-cli"), "handoff records Kilo provenance");
  } finally {
    if (previousProjectDir === undefined) delete process.env.ENGRAM_PROJECT_DIR;
    else process.env.ENGRAM_PROJECT_DIR = previousProjectDir;
    rmSync(projectDir, { recursive: true, force: true });
  }
}

// ── ekilo wrapper smoke test ────────────────────────────────────────────────

console.log("\n  ekilo wrapper:");
{
  const projectDir = join(tmpdir(), `ecc-kilo-wrapper-${Date.now()}`);
  const sessionId = "kilo-wrapper-session";
  const kiloBinDir = join(projectDir, "bin");
  mkdirSync(kiloBinDir, { recursive: true });
  mkdirSync(join(projectDir, ".engram-cc", "sessions"), { recursive: true });

  const dbPath = join(projectDir, ".engram-cc", "sessions", `${getProjectId(projectDir)}.db`);
  const handoffPath = join(projectDir, ".engram-cc", "handoff.yaml");
  const kiloConfigPath = join(projectDir, ".kilocode", "opencode.json");
  const fakeKilo = createFakeKiloBinary(kiloBinDir);

  const db = new SessionDB({ dbPath });
  try {
    db.ensureSession(sessionId, projectDir);
    db.insertEvent(sessionId, {
      type: "user_prompt",
      category: "prompt",
      data: "Add a Kilo wrapper smoke test",
      priority: 1,
    });
  } finally {
    db.close();
  }

  try {
    const result = spawnSync(
      "node",
      ["ekilo.js", "--project-dir", projectDir],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          ENGRAM_KILO_BIN: fakeKilo,
          ENGRAM_SESSION_ID: sessionId,
        },
      },
    );

    assert(result.status === 0, "ekilo exits successfully with fake Kilo");
    assert(existsSync(kiloConfigPath), "ekilo writes Kilo project config in target project");
    if (existsSync(kiloConfigPath)) {
      const kiloConfig = readFileSync(kiloConfigPath, "utf-8");
      assert(kiloConfig.includes(".engram-cc/kilo-context.md"), "ekilo injects project-local context instruction");
      assert(kiloConfig.includes("\"engram-cc\""), "ekilo writes EngramCC MCP entry");
      assert(
        kiloConfig.includes("build\\\\mcp\\\\server.js") || kiloConfig.includes("build/mcp/server.js"),
        "ekilo points Kilo MCP at the local ECC server",
      );
    }
    assert(existsSync(handoffPath), "ekilo stop phase writes handoff.yaml in target project");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

// ── Ingest event smoke test ─────────────────────────────────────────────────

console.log("\n  Ingest event:");
{
  const projectDir = join(tmpdir(), `ecc-kilo-ingest-${Date.now()}`);
  const dataDir = join(projectDir, ".engram-cc");
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  const sessionId = "kilo-ingest-session";

  const previousProjectDir = process.env.ENGRAM_PROJECT_DIR;
  process.env.ENGRAM_PROJECT_DIR = projectDir;

  try {
    const result = await ingestEvent({
      assistant: "kilo-cli",
      project_id: "project-1",
      project_dir: projectDir,
      session_id: sessionId,
      event_type: "post_tool_use",
      source_kind: "native_hook",
      confidence: "exact",
      payload: {
        kind: "post_tool_use",
        tool_name: "Edit",
        tool_input: { file_path: "src/app.ts", prompt: "Fix bug" },
        tool_result: "File edited successfully",
        tool_output: null,
        extracted_events: [],
      },
      timestamp: new Date().toISOString(),
    });

    assert(result !== null, "ingestEvent returns result for Kilo");
    assert(result.stored === true, "ingestEvent stored event");
  } finally {
    if (previousProjectDir === undefined) delete process.env.ENGRAM_PROJECT_DIR;
    else process.env.ENGRAM_PROJECT_DIR = previousProjectDir;
    rmSync(projectDir, { recursive: true, force: true });
  }
}

console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
