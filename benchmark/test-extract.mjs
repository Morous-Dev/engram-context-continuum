/**
 * test-extract.mjs — Unit tests for extractEvents() and extractUserEvents().
 *
 * Covers all 15+ event categories: file, rule, cwd, error, git, task, plan,
 * env, skill, subagent, mcp, decision, worktree, checkpoint, intent, role, data.
 * Pure logic — no DB, no SLM, no file I/O. Runs in <1s.
 *
 * Test strategy:
 *   - Happy path: verify each extractor fires for its target tool
 *   - False-positive: verify noisy real-world output is NOT miscategorised
 *   - False-negative: verify real errors/decisions ARE captured despite noise
 *   - Edge cases: secret sanitisation, JSON response skipping, 300-char truncation
 *   - Resilience: garbage inputs never throw
 *
 * Why this matters: extractEvents() is the entry gate for all data that enters
 * SessionDB. If extraction miscategorises events, every downstream metric
 * (retention, FTS5 quality, snapshot accuracy) is measuring garbage.
 *
 * Run via: node benchmark/test-extract.mjs
 * Depends on: build/session/extract.js
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BUILD = join(process.cwd(), "build", "session");
const { extractEvents, extractUserEvents } = await import(pathToFileURL(join(BUILD, "extract.js")).href);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

function ev(tool_name, tool_input = {}, tool_response = "", tool_output = undefined) {
  return { tool_name, tool_input, tool_response, tool_output };
}

console.log("\n  extractEvents() — PostToolUse categories\n");

// ── File events ───────────────────────────────────────────────────────────────

console.log("  Read tool:");
{
  const events = extractEvents(ev("Read", { file_path: "src/index.ts" }));
  assert(events.length === 1,                       "Read → 1 event");
  assert(events[0].type === "file_read",            "Read → type file_read");
  assert(events[0].category === "file",             "Read → category file");
  assert(events[0].data === "src/index.ts",         "Read → data is file path");
  assert(events[0].priority === 2,                  "Read → priority 2 (reads are context, not actions)");
}

console.log("\n  Read CLAUDE.md (rule file):");
{
  const events = extractEvents(ev("Read", { file_path: "/project/CLAUDE.md" }));
  assert(events.length === 2,                       "CLAUDE.md Read → 2 events (rule + file_read)");
  assert(events.some(e => e.type === "rule"),       "CLAUDE.md Read → emits rule event");
  assert(events.some(e => e.type === "file_read"),  "CLAUDE.md Read → emits file_read event");
  assert(events.find(e => e.type === "rule")?.priority === 1, "rule event priority 1");
}

console.log("\n  .claude/ directory read:");
{
  const events = extractEvents(ev("Read", { file_path: "/project/.claude/settings.json" }));
  assert(events.some(e => e.type === "rule"),       ".claude/ Read → emits rule event");
}

console.log("\n  Edit tool:");
{
  const events = extractEvents(ev("Edit", { file_path: "src/foo.ts" }));
  assert(events.length === 1,                       "Edit → 1 event");
  assert(events[0].type === "file_edit",            "Edit → type file_edit");
}

console.log("\n  Write tool:");
{
  const events = extractEvents(ev("Write", { file_path: "src/new.ts" }));
  assert(events.some(e => e.type === "file_write"),  "Write → file_write event");
  assert(events.some(e => e.type === "checkpoint_create"), "Write → checkpoint_create event");
}

console.log("\n  Glob tool:");
{
  const events = extractEvents(ev("Glob", { pattern: "src/**/*.ts" }));
  assert(events.length === 1,                       "Glob → 1 event");
  assert(events[0].type === "file_glob",            "Glob → type file_glob");
  assert(events[0].data === "src/**/*.ts",          "Glob → data is pattern");
  assert(events[0].priority === 3,                  "Glob → priority 3 (low)");
}

console.log("\n  Grep tool:");
{
  const events = extractEvents(ev("Grep", { pattern: "extractEvents", path: "src/" }));
  assert(events.length === 1,                       "Grep → 1 event");
  assert(events[0].type === "file_search",          "Grep → type file_search");
  assert(events[0].data.includes("extractEvents"),  "Grep → data includes pattern");
}

// ── Cwd ───────────────────────────────────────────────────────────────────────

console.log("\n  Bash cd commands:");
{
  const events1 = extractEvents(ev("Bash", { command: 'cd /project/src' }));
  assert(events1.some(e => e.type === "cwd"),       "Bash cd → cwd event");
  assert(events1.find(e => e.type === "cwd")?.data === "/project/src", "cwd data is path");

  const eventsQuoted = extractEvents(ev("Bash", { command: 'cd "My Project/src"' }));
  assert(eventsQuoted.some(e => e.type === "cwd"),  "Bash cd with quotes → cwd event");
  assert(eventsQuoted.find(e => e.type === "cwd")?.data === "My Project/src", "quoted path stripped");

  const nocd = extractEvents(ev("Bash", { command: "npm run build" }));
  assert(!nocd.some(e => e.type === "cwd"),         "Bash without cd → no cwd event");
}

// ── Error ─────────────────────────────────────────────────────────────────────

console.log("\n  Error detection:");
{
  const byFlag = extractEvents(ev("Read", {}, "some output", { isError: true }));
  assert(byFlag.some(e => e.type === "error_tool"), "isError flag → error_tool event");

  const byExitCode = extractEvents(ev("Bash", { command: "npm run build" }, "Error: exit code 1\nnpm ERR!"));
  assert(byExitCode.some(e => e.type === "error_tool"), "Bash exit code → error_tool event");

  const byLineError = extractEvents(ev("Bash", { command: "node run.js" }, "TypeError: Cannot read properties of null"));
  assert(byLineError.some(e => e.type === "error_tool"), "Bash TypeError → error_tool event");

  // JSON-wrapped responses should NOT be treated as errors
  const jsonWrapped = extractEvents(ev("Bash", { command: "node run.js" }, '{"output":"some data","error":null}'));
  assert(!jsonWrapped.some(e => e.type === "error_tool"), "JSON response not treated as error");

  // Normal success output should NOT trigger error
  const success = extractEvents(ev("Bash", { command: "echo hello" }, "hello world"));
  assert(!success.some(e => e.type === "error_tool"), "Normal bash output not an error");
}

// ── Git ───────────────────────────────────────────────────────────────────────

console.log("\n  Git operations:");
{
  const ops = [
    ["git commit -m 'feat: add feature'", "commit"],
    ["git push origin main", "push"],
    ["git checkout main", "branch"],
    ["git status", "status"],
    ["git log --oneline", "log"],
    ["git diff HEAD", "diff"],
  ];
  for (const [cmd, expectedOp] of ops) {
    const events = extractEvents(ev("Bash", { command: cmd }));
    assert(events.some(e => e.type === "git" && e.data === expectedOp), `git ${expectedOp} detected`);
  }

  const noGit = extractEvents(ev("Bash", { command: "npm run build" }));
  assert(!noGit.some(e => e.type === "git"), "non-git command → no git event");
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

console.log("\n  Checkpoint detection:");
{
  const buildSuccess = extractEvents(ev("Bash", { command: "npm run build" }, "Build complete"));
  assert(buildSuccess.some(e => e.type === "checkpoint_build"), "npm run build → checkpoint_build");
  assert(buildSuccess.find(e => e.type === "checkpoint_build")?.data.includes("SUCCESS"), "build success detected");

  const buildFail = extractEvents(ev("Bash", { command: "npm run build" }, "Error: build failed"));
  assert(buildFail.find(e => e.type === "checkpoint_build")?.data.includes("FAILED"), "build failure detected");

  const testPass = extractEvents(ev("Bash", { command: "npm test" }, "Tests passed"));
  assert(testPass.some(e => e.type === "checkpoint_test"), "npm test → checkpoint_test");

  const commitEvents = extractEvents(ev("Bash", { command: "git commit -m 'feat: done'" }));
  assert(commitEvents.some(e => e.type === "checkpoint_commit"), "git commit → checkpoint_commit");
  assert(commitEvents.find(e => e.type === "checkpoint_commit")?.data.includes("feat: done"), "commit message captured");

  const writeEvents = extractEvents(ev("Write", { file_path: "src/new-module.ts" }));
  assert(writeEvents.some(e => e.type === "checkpoint_create"), "Write → checkpoint_create");
  assert(writeEvents.find(e => e.type === "checkpoint_create")?.data.includes("src/new-module.ts"), "file path in checkpoint");
}

// ── Task ──────────────────────────────────────────────────────────────────────

console.log("\n  Task tools:");
{
  const create = extractEvents(ev("TaskCreate", { title: "Implement feature X", taskId: "1" }));
  assert(create.some(e => e.type === "task_create"), "TaskCreate → task_create event");

  const update = extractEvents(ev("TaskUpdate", { taskId: "1", status: "completed" }));
  assert(update.some(e => e.type === "task_update"), "TaskUpdate → task_update event");
}

// ── Plan ──────────────────────────────────────────────────────────────────────

console.log("\n  Plan mode:");
{
  const enter = extractEvents(ev("EnterPlanMode"));
  assert(enter.some(e => e.type === "plan_enter"), "EnterPlanMode → plan_enter");

  const exit = extractEvents(ev("ExitPlanMode", {}, "approved"));
  assert(exit.some(e => e.type === "plan_exit"),     "ExitPlanMode → plan_exit");
  assert(exit.some(e => e.type === "plan_approved"), "ExitPlanMode approved → plan_approved");

  const planFile = extractEvents(ev("Write", { file_path: "/project/.claude/plans/my-plan.md" }));
  assert(planFile.some(e => e.type === "plan_file_write"), "Write to .claude/plans/ → plan_file_write");
}

// ── Subagent ──────────────────────────────────────────────────────────────────

console.log("\n  Agent (subagent):");
{
  const launched = extractEvents(ev("Agent", { prompt: "Explore the codebase" }));
  assert(launched.some(e => e.type === "subagent_launched"), "Agent no response → subagent_launched");
  assert(launched[0].priority === 3, "launched subagent priority 3");

  const completed = extractEvents(ev("Agent", { prompt: "Explore the codebase" }, "Found 42 files"));
  assert(completed.some(e => e.type === "subagent_completed"), "Agent with response → subagent_completed");
  assert(completed[0].priority === 2, "completed subagent priority 2");
}

// ── MCP ───────────────────────────────────────────────────────────────────────

console.log("\n  MCP tools:");
{
  const mcp = extractEvents(ev("mcp__supabase__execute_sql", { query: "SELECT * FROM users" }));
  assert(mcp.some(e => e.type === "mcp"),             "mcp__ tool → mcp event");
  assert(mcp[0].data.includes("execute_sql"),          "mcp data includes tool name");
  assert(mcp[0].priority === 3,                        "mcp priority 3");
}

// ── Skill ─────────────────────────────────────────────────────────────────────

console.log("\n  Skill tool:");
{
  const skill = extractEvents(ev("Skill", { skill: "commit" }));
  assert(skill.some(e => e.type === "skill"), "Skill → skill event");
  assert(skill[0].data === "commit",          "skill data is skill name");
}

// ── Decision / AskUserQuestion ────────────────────────────────────────────────

console.log("\n  AskUserQuestion:");
{
  const ask = extractEvents(ev("AskUserQuestion",
    { questions: [{ question: "Should we use SQLite or PostgreSQL?" }] },
    "SQLite for local dev"
  ));
  assert(ask.some(e => e.type === "decision_question"), "AskUserQuestion → decision_question");
  assert(ask[0].data.includes("SQLite"),               "decision data includes answer");
}

// ── Env ───────────────────────────────────────────────────────────────────────

console.log("\n  Environment commands:");
{
  const install = extractEvents(ev("Bash", { command: "npm install" }));
  assert(install.some(e => e.type === "env"), "npm install → env event");

  const exportCmd = extractEvents(ev("Bash", { command: "export API_KEY=secret123" }));
  assert(exportCmd.some(e => e.type === "env"),               "export → env event");
  assert(!exportCmd[0].data.includes("secret123"),            "secret value sanitized in env event");
  assert(exportCmd[0].data.includes("***"),                   "secret replaced with ***");
}

// ── Worktree ──────────────────────────────────────────────────────────────────

console.log("\n  Worktree:");
{
  const wt = extractEvents(ev("EnterWorktree", { name: "feature-branch" }));
  assert(wt.some(e => e.type === "worktree"),           "EnterWorktree → worktree event");
  assert(wt[0].data.includes("feature-branch"),         "worktree name in data");
}

// ── Unknown tool → empty ──────────────────────────────────────────────────────

console.log("\n  Unknown tool:");
{
  const unknown = extractEvents(ev("SomeUnknownTool", { foo: "bar" }));
  assert(unknown.length === 0, "Unknown tool → no events");
}

// ── extractUserEvents() ───────────────────────────────────────────────────────

console.log("\n  extractUserEvents() — UserPromptSubmit categories\n");

console.log("  Decision patterns:");
{
  const d1 = extractUserEvents("don't use Redux, use Zustand instead");
  assert(d1.some(e => e.type === "decision"), "don't use X → decision event");

  const d2 = extractUserEvents("let's switch to SQLite over PostgreSQL");
  assert(d2.some(e => e.type === "decision"), "let's switch to → decision event");

  const noDecision = extractUserEvents("looks good to me");
  assert(!noDecision.some(e => e.type === "decision"), "casual message → no decision event");

  // Long messages should not be extracted (>300 chars)
  const longMessage = "a".repeat(301);
  assert(extractUserEvents(longMessage).filter(e => e.type === "decision").length === 0,
    "message >300 chars → no decision event");
}

console.log("\n  Intent patterns:");
{
  const investigate = extractUserEvents("why is the auth middleware failing?");
  assert(investigate.some(e => e.category === "intent" && e.data === "investigate"), "why → investigate");

  const implement = extractUserEvents("implement the payment webhook handler");
  assert(implement.some(e => e.category === "intent" && e.data === "implement"), "implement → implement");

  const review = extractUserEvents("review this PR and check for issues");
  assert(review.some(e => e.category === "intent" && e.data === "review"), "review → review");
}

console.log("\n  Role patterns:");
{
  const role = extractUserEvents("act as a senior software engineer");
  assert(role.some(e => e.type === "role"), "act as → role event");

  const noRole = extractUserEvents("implement the feature");
  assert(!noRole.some(e => e.type === "role"), "no role directive → no role event");
}

console.log("\n  Data (large paste):");
{
  const large = extractUserEvents("x".repeat(301));
  assert(large.some(e => e.type === "data"), "message >300 chars → data event");

  const small = extractUserEvents("short message");
  assert(!small.some(e => e.type === "data"), "short message → no data event");
}

// ── Error false-positive resistance ──────────────────────────────────────────
// These are the most dangerous failures: miscategorising noise as errors
// pollutes the snapshot's <errors_encountered> section with junk and
// wastes the MAX_ERRORS budget on non-errors.

console.log("\n  Error false-positive resistance (real-world messy output):");
{
  // npm warnings containing 'error' mid-line → NOT an error
  const npmWarn = "npm warn deprecated pkg@1.0\n" +
    "npm warn peer requires errors package\n3 packages updated";
  const evs1 = extractEvents(ev("Bash", { command: "npm install" }, npmWarn));
  assert(!evs1.some(e => e.category === "error"),
    "npm warn lines with 'error' mid-line → NOT captured as error");

  // JSON-wrapped response with 'error' key → NOT an error
  const jsonResp = JSON.stringify({ error: "not found", code: 404, data: null });
  const evs2 = extractEvents(ev("Bash", { command: "curl http://api/status" }, jsonResp));
  assert(!evs2.some(e => e.category === "error"),
    "JSON-wrapped response with error key → NOT captured as error");

  // grep results that happen to match error keywords in source code
  const grepResult = "src/auth.ts:45:  throw new Error('unauthorized')\n" +
    "src/db.ts:12: // Error handling here\nsrc/app.ts:99: catchErrors()";
  const evs3 = extractEvents(ev("Bash", { command: "grep -r Error src/" }, grepResult));
  assert(!evs3.some(e => e.category === "error"),
    "grep output with 'Error' in matched content → NOT an error event");

  // Successful git log that contains 'error' in a commit message
  const gitLog = "abc123 fix: resolve ENOENT error in file watcher\n" +
    "def456 feat: add error boundary component";
  const evs4 = extractEvents(ev("Bash", { command: "git log --oneline" }, gitLog));
  assert(!evs4.some(e => e.category === "error"),
    "git log with 'error' in commit messages → NOT an error event");

  // npm run build output with only warnings (not errors)
  const buildWarn = "warning: found deprecated API usage\nBuilt in 1.2s\n0 errors, 2 warnings";
  const evs5 = extractEvents(ev("Bash", { command: "npm run build" }, buildWarn));
  assert(!evs5.some(e => e.category === "error"),
    "build warnings only (no 'Error:' at line start) → NOT an error event");
}

// ── Error true-positive accuracy ──────────────────────────────────────────────
// These must be captured — missing real errors means the snapshot silently
// drops critical context that Claude needs to know about.

console.log("\n  Error true-positive accuracy (must be captured):");
{
  // TypeScript compile error at line start
  const tsErr = "Error: tsc failed\nsrc/auth.ts(23,5): error TS2345: null not assignable";
  const evs1 = extractEvents(ev("Bash", { command: "npx tsc --noEmit" }, tsErr));
  assert(evs1.some(e => e.category === "error"),
    "tsc with 'Error:' at line start → captured as error");

  // FAIL at line start (Jest format)
  const jestFail = "FAIL src/auth.test.ts\n  ● auth › should validate token\n    Expected: true";
  const evs2 = extractEvents(ev("Bash", { command: "npx jest" }, jestFail));
  assert(evs2.some(e => e.category === "error"), "Jest FAIL output → captured as error");

  // ENOENT at line start
  const enoent = "ENOENT: no such file or directory, open 'config.json'";
  const evs3 = extractEvents(ev("Bash", { command: "node server.js" }, enoent));
  assert(evs3.some(e => e.category === "error"), "ENOENT at line start → captured as error");

  // Production stack trace — TypeError + at lines
  const stack = "TypeError: Cannot read properties of null (reading 'id')\n" +
    "    at getUser (src/auth.ts:45:12)\n    at middleware (src/app.ts:12:5)";
  const evs4 = extractEvents(ev("Bash", { command: "node server.js" }, stack));
  assert(evs4.some(e => e.category === "error"), "stack trace with TypeError → captured as error");
  const errData = evs4.find(e => e.category === "error")?.data ?? "";
  assert(errData.includes("TypeError"),          "error data includes TypeError message");
  assert(errData.length <= 300,                  "error data truncated to ≤300 chars");
}

// ── Decision false-positive resistance ───────────────────────────────────────
// extractUserDecision() must reject conversational messages. The decisions
// section of the snapshot is high-value context — polluting it with small talk
// wastes budget and confuses Claude on resume.

console.log("\n  User decision false-positive resistance:");
{
  const noise = [
    "how does the auth module work?",
    "what is the difference between JWT and sessions?",
    "can you explain the codebase structure?",
    "thanks, that looks good!",
    "ok",
    "yes please",
    "sounds good",
    "that makes sense",
  ];
  for (const msg of noise) {
    const evs = extractUserEvents(msg);
    assert(!evs.some(e => e.category === "decision"),
      `"${msg}" → NOT captured as decision`);
  }

  // Long message (>300 chars) is never a decision — it's an explanation, not a directive.
  // Must be >300 chars AND contain no directive patterns to isolate the length guard.
  const longExplanation = "I was thinking about the database question you raised earlier. " +
    "The performance benchmarks I found online for high-write scenarios show very different " +
    "results depending on the hardware and query patterns being tested. The documentation " +
    "for both options is quite thorough. What factors matter most for your specific workload? " +
    "And how many concurrent writes do you expect per second at peak load?";
  assert(longExplanation.length > 300, `test setup: explanation is >300 chars (got ${longExplanation.length})`);
  const evs = extractUserEvents(longExplanation);
  assert(!evs.some(e => e.category === "decision"),
    "explanation >300 chars → NOT captured as decision");
}

// ── Data truncation — 300 char hard limit ─────────────────────────────────────

console.log("\n  Data truncation (300 char hard limit on all stored data):");
{
  // Very long file path
  const longPath = "src/" + "deeply-nested-folder/".repeat(15) + "component.tsx";
  const evs1 = extractEvents(ev("Read", { file_path: longPath }));
  const fileEv = evs1.find(e => e.type === "file_read");
  assert(fileEv !== undefined,              "long path file_read still emitted");
  assert((fileEv?.data.length ?? 0) <= 300, "long file path truncated to ≤300 chars");

  // Long error response — only first 300 chars stored
  const hugeStack = "TypeError: null\n" + "    at fn (src/file.ts:1)\n".repeat(100);
  const evs2 = extractEvents(ev("Bash", { command: "node app.js" }, hugeStack));
  const errEv = evs2.find(e => e.category === "error");
  assert(errEv !== undefined,               "huge stack trace → error event still emitted");
  assert((errEv?.data.length ?? 0) <= 300,  "error data truncated to ≤300 chars");

  // All events regardless of category have data ≤ 300 chars
  const massiveCmd = "grep -r " + "pattern ".repeat(50) + "src/";
  const evs3 = extractEvents(ev("Bash", { command: massiveCmd }));
  for (const e of evs3) {
    assert(e.data.length <= 300, `event type="${e.type}" data ≤300 chars`);
  }
}

// ── Multi-event tool calls ────────────────────────────────────────────────────

console.log("\n  Multi-event tool calls (single input → multiple events):");
{
  // CLAUDE.md Read → rule + file_read
  const evs1 = extractEvents(ev("Read", { file_path: "CLAUDE.md" }));
  assert(evs1.length === 2, `CLAUDE.md Read → exactly 2 events (got ${evs1.length})`);

  // Write tool → file_write + checkpoint_create
  const evs2 = extractEvents(ev("Write", { file_path: "src/new.ts" }));
  assert(evs2.some(e => e.type === "file_write"),        "Write → file_write");
  assert(evs2.some(e => e.type === "checkpoint_create"), "Write → checkpoint_create");

  // git commit bash → git + checkpoint_commit (both must fire)
  const evs3 = extractEvents(ev("Bash",
    { command: 'git commit -m "feat: auth"' },
    "[main abc1234] feat: auth"));
  assert(evs3.some(e => e.type === "git"),               "git commit → git event");
  assert(evs3.some(e => e.type === "checkpoint_commit"), "git commit → checkpoint_commit event");

  // cd + npm install → cwd + env (both must fire)
  const evs4 = extractEvents(ev("Bash",
    { command: 'cd /app && npm install' },
    "added 200 packages"));
  assert(evs4.some(e => e.type === "cwd"),    "cd+npm → cwd event for cd");
  assert(evs4.some(e => e.category === "env"), "cd+npm → env event for npm install");
}

// ── Garbage input — never throws ─────────────────────────────────────────────
// extractEvents() has a top-level try/catch but individual extractors must
// also handle malformed input. This catches regressions where a new extractor
// forgets to guard against null/undefined.

console.log("\n  Garbage input resilience (never throws):");
{
  const garbageInputs = [
    { tool_name: "",           tool_input: {} },
    { tool_name: "Read",       tool_input: {} },                      // missing file_path
    { tool_name: "Bash",       tool_input: { command: null } },       // null command
    { tool_name: "TaskCreate", tool_input: { subject: null } },       // null subject
    { tool_name: "Grep",       tool_input: { pattern: undefined } },  // undefined pattern
    {},                                                               // completely empty
  ];

  for (const input of garbageInputs) {
    let threw = false;
    let result = [];
    try { result = extractEvents(input); }
    catch { threw = true; }
    assert(!threw, `extractEvents(${JSON.stringify(input)?.slice(0, 50)}) → never throws`);
    assert(Array.isArray(result), "always returns an array");
  }

  // extractUserEvents with edge-case inputs
  const userEdgeCases = [null, undefined, "", 0, []];
  for (const input of userEdgeCases) {
    let threw = false;
    try { extractUserEvents(input); }
    catch { threw = true; }
    assert(!threw, `extractUserEvents(${JSON.stringify(input)}) → never throws`);
  }
}

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n  ${"─".repeat(50)}`);
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
console.log(`  ${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
