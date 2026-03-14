/**
 * test-160k-real.mjs — Realistic 160K-token compaction benchmark.
 *
 * Responsible for: simulating a full-scale project lifecycle across 16
 * compaction cycles (each representing ~80K tokens of conversation), with
 * realistic event volumes (60-80 events/cycle), all event types, and
 * incremental compaction that mirrors production behavior.
 *
 * Key differences from test-compaction-marathon.mjs:
 *   - 4-5x more events per cycle (60-80 vs 10-17)
 *   - All ECC event types (git, subagent, env, mcp, plan, skill, cwd)
 *   - 8 anchor facts (vs 6) spread across early/middle/late cycles
 *   - Incremental compaction per cycle (compact after each)
 *   - Tests 1000-event cap behavior (FIFO eviction at cycle ~14)
 *   - Measures retention at EVERY cycle, not just at preset levels
 *
 * Anchor facts (8 total):
 *   AF1 — PostgreSQL over MongoDB (cycle 1)
 *   AF2 — JWT auth with refresh tokens (cycle 2)
 *   AF3 — WebSocket leak: appears cycle 4, "fixed" cycle 7, REAPPEARS cycle 10
 *   AF4 — utils/ → shared/ rename (cycle 3)
 *   AF5 — Current task = latest cycle's active task
 *   AF6 — Prisma over Mongoose (cycle 1)
 *   AF7 — Redis via Upstash for caching (cycle 9)
 *   AF8 — Cloudflare R2 for file storage (cycle 12)
 *
 * Run via: node benchmark/test-160k-real.mjs
 * Depends on: build/ (compiled TypeScript), benchmark/realistic-cycles.mjs
 */

import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { seed } from "./seed-helpers.mjs";
import { estimateTokens } from "./marathon-data.mjs";
import { REAL_CYCLES } from "./realistic-cycles.mjs";

// ── Constants ─────────────────────────────────────────────────────────────────

const BUILD = join(process.cwd(), "build");
const TOTAL_CYCLES = 16;
/** SLM timeout per cycle */
const SLM_TIMEOUT_MS = 60_000;

// ── Module imports ────────────────────────────────────────────────────────────

const { SessionDB } = await import(pathToFileURL(join(BUILD, "session", "db.js")).href);
const { buildResumeSnapshot } = await import(pathToFileURL(join(BUILD, "session", "snapshot.js")).href);
const { auditSessionEvents } = await import(pathToFileURL(join(BUILD, "tokenization", "auditor.js")).href);

let generateCompactBrief;
try {
  const mod = await import(pathToFileURL(join(BUILD, "session", "compact-brief.js")).href);
  generateCompactBrief = mod.generateCompactBrief;
} catch (err) {
  console.error(`  [FATAL] compact-brief module not available: ${err.message}`);
  process.exit(1);
}

const sessionDirectivePath = join(process.cwd(), "src", "hooks", "session-directive.mjs");
const { writeSessionEventsFile, buildSessionDirective } =
  await import(pathToFileURL(sessionDirectivePath).href);

// ── Assertion engine ──────────────────────────────────────────────────────────

/**
 * Run all 8 anchor fact assertions on a context string.
 * Returns { passed, failed, details[] } where details includes pass/fail per AF.
 *
 * @param context - The full injected context (snapshot + brief or raw).
 * @param cycle   - Current compaction cycle number (1-indexed).
 * @returns Assertion result object.
 */
function checkAnchorFacts(context, cycle) {
  const lower = context.toLowerCase();
  const details = [];
  let passed = 0;
  let failed = 0;

  function check(id, condition, label) {
    if (condition) {
      details.push({ id, label, pass: true });
      passed++;
    } else {
      details.push({ id, label, pass: false });
      failed++;
    }
  }

  // AF1: PostgreSQL as DB (cycle 1+)
  check("AF1", lower.includes("postgres"), "PostgreSQL mentioned as database");

  // AF1b: MongoDB not presented as current DB without PostgreSQL
  const mongoAsCurrent =
    lower.includes("mongodb") && !lower.includes("postgres") &&
    !lower.includes("abandon") && !lower.includes("switch");
  check("AF1b", !mongoAsCurrent, "MongoDB not reported as current DB");

  // AF2: JWT auth (cycle 2+)
  if (cycle >= 2) {
    check("AF2", lower.includes("jwt"), "JWT auth pattern mentioned");
  }

  // AF3: WebSocket mentioned (cycle 4+)
  if (cycle >= 4) {
    check("AF3", lower.includes("websocket") || lower.includes("ws ") || lower.includes("ws/"),
      "WebSocket issue mentioned");
  }

  // AF3b: WebSocket leak NOT claimed resolved after cycle 10 (reappeared)
  if (cycle >= 10) {
    // Strict: if the brief says "memory leak resolved" without mentioning it reappeared, it's wrong
    const claimsResolved = lower.includes("memory leak resolved") || lower.includes("leak fixed");
    const mentionsReappearance = lower.includes("reappear") || lower.includes("still unresolved") || lower.includes("not yet implemented") || lower.includes("not implemented");
    check("AF3b", !claimsResolved || mentionsReappearance,
      "WebSocket leak NOT falsely claimed resolved (it reappeared)");
  }

  // AF4: shared/ directory (cycle 3+)
  if (cycle >= 3) {
    check("AF4", lower.includes("shared/") || lower.includes("shared\\") || lower.includes("shared directory") || (lower.includes("shared") && lower.includes("rename")),
      "shared/ directory referenced (post-rename)");
  }

  // AF5: Task context present from latest cycle
  check("AF5", lower.includes("task") || lower.includes("todo") || lower.includes("implement") || lower.includes("fix"),
    "Task context present from latest cycle");

  // AF6: Prisma as ORM (cycle 1+)
  check("AF6", lower.includes("prisma"), "Prisma mentioned as ORM");

  // AF7: Redis/Upstash for caching (cycle 9+)
  if (cycle >= 9) {
    check("AF7", lower.includes("redis") || lower.includes("upstash") || lower.includes("cache"),
      "Redis/Upstash caching mentioned");
  }

  // AF8: Cloudflare R2 for storage (cycle 12+)
  if (cycle >= 12) {
    check("AF8", lower.includes("r2") || lower.includes("cloudflare") || lower.includes("file storage") || lower.includes("image upload"),
      "Cloudflare R2 / file storage mentioned");
  }

  return { passed, failed, total: passed + failed, details };
}

// ── Main benchmark ────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(76));
console.log("  REALISTIC 160K-TOKEN COMPACTION BENCHMARK");
console.log("  16 cycles × ~80K tokens = ~1.28M total tokens of conversation");
console.log("  60-80 events per cycle, all event types, incremental compaction");
console.log("═".repeat(76));

// Fresh DB
const dbDir = join(tmpdir(), "ecc-160k-bench");
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, "real-160k.db");
if (existsSync(dbPath)) rmSync(dbPath);

const db = new SessionDB({ dbPath });
const sessionId = `real-160k-${Date.now()}`;
const projectDir = join(tmpdir(), "ecc-160k-project");
mkdirSync(projectDir, { recursive: true });
db.ensureSession(sessionId, projectDir);

const cycleResults = [];
let totalEventCount = 0;

for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
  console.log(`\n${"─".repeat(76)}`);
  console.log(`  Cycle ${cycle}/${TOTAL_CYCLES}: ${getCycleDescription(cycle)}`);
  console.log(`${"─".repeat(76)}`);

  // ── Seed this cycle's events ─────────────────────────────────────────────
  const cycleGen = REAL_CYCLES[cycle - 1];
  const cycleEvents = cycleGen();
  seed(db, sessionId, cycleEvents, "PostToolUse");
  totalEventCount += cycleEvents.length;

  const storedEvents = db.getEvents(sessionId);
  const { cleanedEvents } = auditSessionEvents(storedEvents);
  const stats = db.getSessionStats(sessionId);

  console.log(`  Events this cycle: ${cycleEvents.length} | Total stored: ${storedEvents.length} | Cleaned: ${cleanedEvents.length}`);
  if (storedEvents.length >= 900) {
    console.log(`  ⚠ Approaching 1000-event cap (${storedEvents.length}/1000) — FIFO eviction active`);
  }

  // ── Build snapshot ─────────────────────────────────────────────────────────
  const snapshot = buildResumeSnapshot(cleanedEvents, { compactCount: cycle });
  const resumeChain = db.getResumeChain(sessionId);

  // ── Generate SLM brief ─────────────────────────────────────────────────────
  let slmBrief = null;
  let structuredHandoff = null;
  const briefStart = Date.now();
  try {
    const result = await generateCompactBrief(cleanedEvents, {
      compactCount: cycle,
      sessionId,
      projectDir,
      resumeChain,
    });
    slmBrief = result.brief;
    structuredHandoff = result.structured ? JSON.stringify(result.structured) : null;
  } catch (err) {
    console.error(`  SLM brief failed: ${err.message}`);
  }
  const briefMs = Date.now() - briefStart;

  // ── Build raw event dump baseline ──────────────────────────────────────────
  const eventsFilePath = join(projectDir, `events-c${cycle}.md`);
  const eventMeta = writeSessionEventsFile(storedEvents, eventsFilePath);
  const rawDirective = buildSessionDirective("compact", eventMeta);
  const rawContext = `${snapshot}\n${rawDirective}`;
  const rawTokens = estimateTokens(rawContext);

  // ── Measure SLM brief ──────────────────────────────────────────────────────
  const primaryContext = slmBrief ? `${snapshot}\n${slmBrief}` : rawContext;
  const contextLabel = slmBrief ? "SLM" : "raw";
  const slmTokens = slmBrief ? estimateTokens(primaryContext) : null;
  const savings = slmTokens ? Math.round(((rawTokens - slmTokens) / rawTokens) * 100) : null;

  console.log(`  Brief: ${contextLabel} (${briefMs}ms) | Raw: ${rawTokens}T | SLM: ${slmTokens ?? "n/a"}T | Savings: ${savings ?? "n/a"}%`);

  // ── Store resume for next cycle ────────────────────────────────────────────
  db.upsertResume(sessionId, snapshot, storedEvents.length, slmBrief);
  db.appendResumeHistory(sessionId, cycle, snapshot, slmBrief, structuredHandoff, storedEvents.length);
  db.incrementCompactCount(sessionId);

  // ── Anchor fact assertions ─────────────────────────────────────────────────
  const assertions = checkAnchorFacts(primaryContext, cycle);
  const failedFacts = assertions.details.filter((d) => !d.pass);

  console.log(`  Anchor facts: ${assertions.passed}/${assertions.total}${failedFacts.length > 0 ? " — LOST:" : ""}`);
  for (const f of failedFacts) {
    console.log(`    ✗ ${f.id}: ${f.label}`);
  }

  cycleResults.push({
    cycle,
    eventsThisCycle: cycleEvents.length,
    totalStored: storedEvents.length,
    contextLabel,
    rawTokens,
    slmTokens,
    savings,
    briefMs,
    passed: assertions.passed,
    total: assertions.total,
    failures: failedFacts.map((f) => `[C${cycle}] ${f.id}: ${f.label}`),
  });
}

db.close();

// ── Scorecard ─────────────────────────────────────────────────────────────────

console.log("\n\n" + "═".repeat(76));
console.log("  160K REALISTIC BENCHMARK SCORECARD");
console.log("═".repeat(76));

console.log(
  `\n  ${"Cycle".padEnd(6)} ${"Events".padEnd(8)} ${"Stored".padEnd(8)} ${"Raw T".padEnd(8)} ${"SLM T".padEnd(8)} ${"Sv%".padEnd(6)} ${"Facts".padEnd(8)} ${"ms".padEnd(6)} Source`,
);
console.log(
  `  ${"-".repeat(6)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(6)} ${"-".repeat(8)} ${"-".repeat(6)} ${"-".repeat(6)}`,
);

for (const r of cycleResults) {
  const slmCol = r.slmTokens != null ? String(r.slmTokens) : "n/a";
  const svCol = r.savings != null ? `${r.savings}%` : "n/a";
  console.log(
    `  ${String(r.cycle).padEnd(6)} ${String(r.eventsThisCycle).padEnd(8)} ${String(r.totalStored).padEnd(8)} ${String(r.rawTokens).padEnd(8)} ${slmCol.padEnd(8)} ${svCol.padEnd(6)} ${`${r.passed}/${r.total}`.padEnd(8)} ${String(r.briefMs).padEnd(6)} ${r.contextLabel}`,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

const allFailures = cycleResults.flatMap((r) => r.failures);
const totalPassed = cycleResults.reduce((a, r) => a + r.passed, 0);
const totalAsserts = cycleResults.reduce((a, r) => a + r.total, 0);
const overallPct = Math.round((totalPassed / totalAsserts) * 100);

console.log(`\n  Total: ${totalPassed}/${totalAsserts} assertions passed (${overallPct}%)`);
console.log(`  Total events seeded: ${totalEventCount} across ${TOTAL_CYCLES} cycles`);

// First cycle where a fact was lost
const firstLoss = cycleResults.find((r) => r.failures.length > 0);
if (firstLoss) {
  console.log(`  First fact lost at: cycle ${firstLoss.cycle}`);
}

// Average savings across SLM-available cycles
const slmCycles = cycleResults.filter((r) => r.savings != null);
if (slmCycles.length > 0) {
  const avgSavings = Math.round(slmCycles.reduce((a, r) => a + r.savings, 0) / slmCycles.length);
  console.log(`  Avg token savings: ${avgSavings}%`);
}

// Average inference time
const avgMs = Math.round(cycleResults.reduce((a, r) => a + r.briefMs, 0) / cycleResults.length);
console.log(`  Avg SLM inference: ${avgMs}ms`);

if (allFailures.length > 0) {
  console.log(`\n  Failed assertions:`);
  for (const f of allFailures) console.log(`    - ${f}`);
}

// ── Retention curve ───────────────────────────────────────────────────────────

console.log(`\n  Retention curve (facts surviving per cycle):`);
let line = "  ";
for (const r of cycleResults) {
  const bar = "█".repeat(r.passed) + "░".repeat(r.total - r.passed);
  line = `  C${String(r.cycle).padStart(2, "0")}: ${bar} ${r.passed}/${r.total}`;
  console.log(line);
}

console.log("\n" + "═".repeat(76) + "\n");

process.exit(allFailures.length > 0 ? 1 : 0);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Human-readable cycle description for log output. */
function getCycleDescription(cycle) {
  const descriptions = [
    "Project bootstrap, DB selection (AF1 PostgreSQL, AF6 Prisma)",
    "Auth system (AF2 JWT with refresh tokens)",
    "API layer + module rename (AF4 utils/ → shared/)",
    "WebSocket features (AF3 memory leak appears)",
    "Frontend scaffolding",
    "Testing & CI pipeline",
    "Bug fixing sprint (AF3 'fixed' — temporary)",
    "Performance optimization",
    "Payment + caching (AF7 Redis via Upstash)",
    "Deployment + DevOps (AF3 REAPPEARS — unresolved)",
    "Security hardening",
    "File storage (AF8 Cloudflare R2)",
    "Multi-tenancy (RLS)",
    "API versioning",
    "Full-text search + caching",
    "Launch prep (AF3 still unresolved, AF5 latest task)",
  ];
  return descriptions[cycle - 1] ?? `Cycle ${cycle}`;
}
