/**
 * test-hook-portability.mjs — Regression tests for assistant-agnostic hook runtime helpers.
 *
 * Verifies:
 *   - shared project-dir resolution honors ENGRAM_PROJECT_DIR first
 *   - shared session-id resolution honors ENGRAM_SESSION_ID when hook input lacks one
 *   - Claude-only startup files are not injected for non-Claude assistants
 *
 * Run via: node benchmark/test-hook-portability.mjs
 * Depends on: src/hooks/session-helpers.mjs, src/hooks/assistant-startup.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const { getProjectDir, getSessionId } =
  await import(pathToFileURL(join(ROOT, "src", "hooks", "session-helpers.mjs")).href);
const { captureAssistantStartupContext } =
  await import(pathToFileURL(join(ROOT, "src", "hooks", "assistant-startup.mjs")).href);
const hookRunnerPath = join(ROOT, "src", "hooks", "hook-runner.mjs");

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

function withEnv(pairs, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(pairs)) {
    previous.set(key, process.env[key]);
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

console.log("\n  Hook portability regressions\n");

console.log("  Runtime project resolution:");
withEnv({
  ENGRAM_PROJECT_DIR: "D:/ecc-project",
  GEMINI_PROJECT_DIR: "D:/gemini-project",
  CLAUDE_PROJECT_DIR: "D:/claude-project",
}, () => {
  assert(getProjectDir() === "D:/ecc-project", "ENGRAM_PROJECT_DIR wins over assistant-native envs");
});
withEnv({
  ENGRAM_PROJECT_DIR: null,
  GEMINI_PROJECT_DIR: "D:/gemini-project",
  CLAUDE_PROJECT_DIR: null,
}, () => {
  assert(getProjectDir() === "D:/gemini-project", "assistant-native project env used when shared env absent");
});

console.log("\n  Runtime session resolution:");
withEnv({
  ENGRAM_SESSION_ID: "shared-session",
  GEMINI_SESSION_ID: "gemini-session",
  CLAUDE_SESSION_ID: "claude-session",
}, () => {
  assert(getSessionId({}) === "shared-session", "ENGRAM_SESSION_ID wins when hook payload lacks a session id");
  assert(getSessionId({ sessionId: "payload-session" }) === "payload-session", "payload session id still wins over env");
});

console.log("\n  Assistant-specific startup capture:");
{
  const projectDir = join(tmpdir(), `ecc-startup-${Date.now()}`);
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  writeFileSync(join(projectDir, "CLAUDE.md"), "# root rules\n", "utf-8");
  writeFileSync(join(projectDir, ".claude", "CLAUDE.md"), "# nested rules\n", "utf-8");

  try {
    const claudeEvents = [];
    const geminiEvents = [];
    const codexEvents = [];
    const makeDb = bucket => ({
      insertEvent(sessionId, event, source, provenance) {
        bucket.push({ sessionId, event, source, provenance });
      },
    });

    const claudeInserted = captureAssistantStartupContext({
      assistant: "claude-code",
      projectDir,
      sessionId: "session-1",
      db: makeDb(claudeEvents),
    });
    assert(claudeInserted === 4, "Claude startup capture injects both CLAUDE.md files");
    assert(claudeEvents.every(e => e.provenance.sourceAssistant === "claude-code"), "Claude startup capture records Claude provenance");

    const geminiInserted = captureAssistantStartupContext({
      assistant: "gemini-cli",
      projectDir,
      sessionId: "session-2",
      db: makeDb(geminiEvents),
    });
    assert(geminiInserted === 0 && geminiEvents.length === 0, "Gemini startup capture ignores Claude-only rule files");

    const codexInserted = captureAssistantStartupContext({
      assistant: "codex",
      projectDir,
      sessionId: "session-3",
      db: makeDb(codexEvents),
    });
    assert(codexInserted === 0 && codexEvents.length === 0, "Codex startup capture ignores Claude-only rule files");

    const legacyClaudeEvents = [];
    withEnv({
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_SESSION_ID: "legacy-session",
    }, () => {
      const inserted = captureAssistantStartupContext({
        assistant: "unknown",
        projectDir,
        sessionId: "session-4",
        db: makeDb(legacyClaudeEvents),
      });
      assert(inserted === 4, "legacy Claude runtime env still captures CLAUDE.md without ENGRAM_ASSISTANT");
    });

    const mixedEnvEvents = [];
    withEnv({
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_SESSION_ID: "legacy-session",
    }, () => {
      const inserted = captureAssistantStartupContext({
        assistant: "gemini-cli",
        projectDir,
        sessionId: "session-5",
        db: makeDb(mixedEnvEvents),
      });
      assert(inserted === 0 && mixedEnvEvents.length === 0, "non-Claude assistant ignores stale Claude env vars");
    });
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

console.log("\n  Hook runner:");
{
  const projectDir = join(tmpdir(), `ecc-hook-runner-${Date.now()}`);
  const scriptPath = join(projectDir, "print-env.mjs");

  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    scriptPath,
    "console.log(JSON.stringify({ assistant: process.env.ENGRAM_ASSISTANT, projectDir: process.env.ENGRAM_PROJECT_DIR, argv: process.argv.slice(2) }));\n",
    "utf-8",
  );

  try {
    const run = spawnSync(
      process.execPath,
      [
        hookRunnerPath,
        "--assistant",
        "codex",
        "--project-dir",
        projectDir,
        "--script",
        scriptPath,
        "--",
        "--marker=engram-cc",
      ],
      {
        cwd: ROOT,
        encoding: "utf-8",
      },
    );

    assert(run.status === 0, "hook runner exits cleanly");
    const payload = JSON.parse(run.stdout.trim());
    assert(payload.assistant === "codex", "hook runner injects ENGRAM_ASSISTANT");
    assert(payload.projectDir === projectDir, "hook runner injects ENGRAM_PROJECT_DIR");
    assert(Array.isArray(payload.argv) && payload.argv.includes("--marker=engram-cc"), "hook runner forwards hook args");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
