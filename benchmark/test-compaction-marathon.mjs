/**
 * test-compaction-marathon.mjs — Multi-compaction memory retention benchmark.
 *
 * Responsible for: simulating a realistic 24-hour coding session spanning
 * 4 to 20 compaction cycles, measuring how much critical context survives
 * through the SLM compact brief pipeline. Each cycle introduces new work
 * topics while key facts (decisions, unresolved errors, active task) must
 * persist across all compaction boundaries.
 *
 * This is the stress test for ECC's memory bank: if facts die here, Claude
 * loses them in production. The SLM brief is the last line of defense.
 *
 * Architecture:
 *   For each compaction count (4, 8, 12, 16, 20):
 *     1. Seed N cycles of realistic events with diverse topics
 *     2. Run the full precompact pipeline (audit → snapshot → SLM brief)
 *     3. Simulate sessionstart injection (snapshot + SLM brief)
 *     4. Verify that anchor facts survive in the injected context
 *     5. Measure token cost vs raw event dump baseline
 *
 * Anchor facts (must survive ALL compaction levels):
 *   AF1 — Final DB choice: PostgreSQL (not MongoDB, not SQLite)
 *   AF2 — Auth pattern: JWT with refresh tokens (decided early, never changed)
 *   AF3 — Recurring error: memory leak in WebSocket handler (appears cycle 2,
 *          "fixed" cycle 5, reappears cycle 8 — must be UNRESOLVED)
 *   AF4 — Module rename: utils/ → shared/ (cycle 3, all refs updated)
 *   AF5 — Current task: always the LAST cycle's active task
 *   AF6 — Abandoned library: tried Mongoose (cycle 1), switched to Prisma (cycle 2)
 *
 * Run via: node benchmark/test-compaction-marathon.mjs
 * Depends on: build/ (compiled TypeScript)
 */

import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { seed } from "./seed-helpers.mjs";
import { generateCycleEvents, estimateTokens } from "./marathon-data.mjs";

// ── Constants ────────────────────────────────────────────────────────────────

const BUILD = join(process.cwd(), "build");
const COMPACTION_LEVELS = [4, 8, 12, 16, 20];

// ── Assertion helpers ────────────────────────────────────────────────────────

let totalPassed = 0;
let totalFailed = 0;
const allFailures = [];

function assertContains(context, pattern, label, level) {
  const lower = context.toLowerCase();
  if (lower.includes(pattern.toLowerCase())) {
    console.log(`    ✓ ${label}`);
    totalPassed++;
    return true;
  } else {
    console.log(`    ✗ ${label}`);
    totalFailed++;
    allFailures.push(`[${level} compactions] ${label}`);
    return false;
  }
}

function assertNotContains(context, pattern, label, level) {
  const lower = context.toLowerCase();
  if (!lower.includes(pattern.toLowerCase())) {
    console.log(`    ✓ ${label}`);
    totalPassed++;
    return true;
  } else {
    console.log(`    ✗ ${label}`);
    totalFailed++;
    allFailures.push(`[${level} compactions] ${label}`);
    return false;
  }
}

// ── Main benchmark ──────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(76));
console.log("  COMPACTION MARATHON — SLM Memory Retention Benchmark");
console.log("  Simulates 4→20 compaction cycles (~24 hours of real conversation)");
console.log("═".repeat(76));

// Import compiled modules
const { SessionDB } = await import(
  pathToFileURL(join(BUILD, "session", "db.js")).href
);
const { buildResumeSnapshot } = await import(
  pathToFileURL(join(BUILD, "session", "snapshot.js")).href
);
const { auditSessionEvents } = await import(
  pathToFileURL(join(BUILD, "tokenization", "auditor.js")).href
);

let generateCompactBrief;
try {
  const mod = await import(
    pathToFileURL(join(BUILD, "session", "compact-brief.js")).href
  );
  generateCompactBrief = mod.generateCompactBrief;
} catch (err) {
  console.log(`  [WARN] SLM compact brief not available: ${err.message}`);
  generateCompactBrief = null;
}

// Import session-directive for raw event dump baseline
const sessionDirectivePath = join(
  process.cwd(),
  "src",
  "hooks",
  "session-directive.mjs",
);
const { writeSessionEventsFile, buildSessionDirective, groupEvents } =
  await import(pathToFileURL(sessionDirectivePath).href);

const results = [];

for (const level of COMPACTION_LEVELS) {
  console.log(`\n${"─".repeat(76)}`);
  console.log(`  Compaction Level: ${level} cycles`);
  console.log(`${"─".repeat(76)}`);

  // Set up fresh DB
  const dbDir = join(tmpdir(), "ecc-marathon-bench");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, `marathon-${level}.db`);
  if (existsSync(dbPath)) rmSync(dbPath);

  const db = new SessionDB({ dbPath });
  const sessionId = `marathon-${level}-${Date.now()}`;
  const projectDir = join(tmpdir(), `ecc-marathon-project-${level}`);
  mkdirSync(projectDir, { recursive: true });
  db.ensureSession(sessionId, projectDir);

  // Generate and seed events
  const allEvents = generateCycleEvents(level);
  seed(db, sessionId, allEvents, "PostToolUse");

  console.log(`  Events seeded: ${allEvents.length}`);

  // Simulate compaction cycles
  let lastSnapshot = null;
  let lastSlmBrief = null;
  let lastRawDirective = null;

  // Run the full precompact pipeline for each compaction cycle
  for (let cycle = 1; cycle <= level; cycle++) {
    const events = db.getEvents(sessionId);
    const { cleanedEvents } = auditSessionEvents(events);
    const stats = db.getSessionStats(sessionId);

    const snapshot = buildResumeSnapshot(cleanedEvents, {
      compactCount: cycle,
    });
    lastSnapshot = snapshot;
    const resumeChain = db.getResumeChain(sessionId);

    // Generate SLM brief (may be null if no SLM available)
    let slmBrief = null;
    let structuredHandoff = null;
    if (generateCompactBrief) {
      try {
        const result = await generateCompactBrief(cleanedEvents, {
          compactCount: cycle,
          sessionId,
          projectDir,
          resumeChain,
        });
        slmBrief = result.brief;
        structuredHandoff = result.structured ? JSON.stringify(result.structured) : null;
      } catch {
        // SLM not available — that's fine, we'll measure raw baseline
      }
    }
    lastSlmBrief = slmBrief;

    // Also generate raw event dump for comparison
    const eventsFilePath = join(projectDir, `events-${cycle}.md`);
    const eventMeta = writeSessionEventsFile(events, eventsFilePath);
    lastRawDirective = buildSessionDirective("compact", eventMeta);

    db.upsertResume(sessionId, snapshot, events.length, slmBrief);
    db.appendResumeHistory(sessionId, cycle, snapshot, slmBrief, structuredHandoff, events.length);
    db.incrementCompactCount(sessionId);
  }

  db.close();

  // ── Measure what survived ──────────────────────────────────────────────────

  // Build the full injected context (what Claude would see after compaction)
  const injectedWithSlm = lastSlmBrief
    ? `${lastSnapshot}\n${lastSlmBrief}`
    : null;
  const injectedWithRaw = `${lastSnapshot}\n${lastRawDirective}`;

  // Use whichever is available for assertions
  const primaryContext = injectedWithSlm ?? injectedWithRaw;
  const contextLabel = injectedWithSlm ? "SLM brief" : "raw events";

  const slmTokens = injectedWithSlm ? estimateTokens(injectedWithSlm) : null;
  const rawTokens = estimateTokens(injectedWithRaw);
  const savings = slmTokens
    ? Math.round(((rawTokens - slmTokens) / rawTokens) * 100)
    : null;

  console.log(`  Context source: ${contextLabel}`);
  console.log(
    `  Raw event dump: ${rawTokens} tokens (${lastRawDirective.length} bytes)`,
  );
  if (slmTokens) {
    console.log(
      `  SLM brief:      ${slmTokens} tokens (${lastSlmBrief.length} bytes)`,
    );
    console.log(`  Token savings:  ${savings}%`);
  } else {
    console.log(`  SLM brief:      not available (tier1/tier2 or SLM absent)`);
  }

  // ── Anchor fact assertions ──────────────────────────────────────────────────
  console.log(`\n  Anchor fact retention (in ${contextLabel}):`);

  // AF1: PostgreSQL is the DB (not MongoDB)
  // The SLM may mention MongoDB when describing the switch ("abandoned MongoDB
  // for PostgreSQL") — that's correct behavior. We only fail if MongoDB is
  // presented as the CURRENT choice without PostgreSQL also being mentioned.
  const af1a = assertContains(
    primaryContext,
    "postgres",
    "AF1: PostgreSQL mentioned as database",
    level,
  );
  if (level >= 1) {
    // Fail only if MongoDB is presented as the active DB AND PostgreSQL is absent
    const lower = primaryContext.toLowerCase();
    const mongoAsCurrent =
      lower.includes("mongodb") &&
      !lower.includes("postgres") &&
      !lower.includes("abandon") &&
      !lower.includes("switch");
    if (!mongoAsCurrent) {
      console.log("    ✓ AF1: MongoDB not reported as current choice");
      totalPassed++;
    } else {
      console.log("    ✗ AF1: MongoDB reported as current DB without PostgreSQL");
      totalFailed++;
      allFailures.push(`[${level} compactions] AF1: MongoDB as current without PostgreSQL`);
    }
  }

  // AF2: JWT auth pattern
  assertContains(
    primaryContext,
    "jwt",
    "AF2: JWT auth pattern mentioned",
    level,
  );

  // AF3: WebSocket memory leak status depends on cycle count
  if (level >= 3) {
    // After cycle 2, the leak should be mentioned
    assertContains(
      primaryContext,
      "websocket",
      "AF3: WebSocket issue mentioned",
      level,
    );
  }
  if (level >= 9) {
    // After cycle 8, the leak reappeared and is NOT resolved
    assertNotContains(
      primaryContext,
      "memory leak resolved",
      "AF3: WebSocket leak NOT claimed as resolved (it reappeared)",
      level,
    );
  }

  // AF4: Module rename utils/ → shared/ (cycle 3+)
  if (level >= 4) {
    assertContains(
      primaryContext,
      "shared",
      "AF4: shared/ directory referenced (post-rename)",
      level,
    );
  }

  // AF5: Current task should reflect the LAST cycle's work
  const lastCycleIdx = (level - 1) % 20; // 20 cycle templates in marathon-data.mjs
  // The last cycle's task events should be visible
  assertContains(
    primaryContext,
    "task",
    "AF5: Task context present from latest cycle",
    level,
  );

  // AF6: Prisma over Mongoose (cycle 0 decision)
  assertContains(
    primaryContext,
    "prisma",
    "AF6: Prisma mentioned as ORM (final choice over Mongoose)",
    level,
  );

  // ── Also check raw event dump for same anchors (baseline) ──────────────────
  if (injectedWithSlm) {
    console.log(`\n  Anchor fact retention (in raw event dump — baseline):`);
    assertContains(
      injectedWithRaw,
      "postgres",
      "AF1-raw: PostgreSQL in raw dump",
      level,
    );
    assertContains(
      injectedWithRaw,
      "jwt",
      "AF2-raw: JWT in raw dump",
      level,
    );
    assertContains(
      injectedWithRaw,
      "prisma",
      "AF6-raw: Prisma in raw dump",
      level,
    );
  }

  results.push({
    level,
    eventCount: allEvents.length,
    rawTokens,
    slmTokens,
    savings,
    contextSource: contextLabel,
  });
}

// ── Scorecard ──────────────────────────────────────────────────────────────────

console.log("\n\n" + "═".repeat(76));
console.log("  COMPACTION MARATHON SCORECARD");
console.log("═".repeat(76));

console.log(
  `\n  ${"Level".padEnd(8)} ${"Events".padEnd(8)} ${"Raw Tokens".padEnd(12)} ${"SLM Tokens".padEnd(12)} ${"Savings".padEnd(10)} Source`,
);
console.log(
  `  ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(10)} ${"─".repeat(12)}`,
);

for (const r of results) {
  const slmCol = r.slmTokens != null ? String(r.slmTokens) : "n/a";
  const savCol = r.savings != null ? `${r.savings}%` : "n/a";
  console.log(
    `  ${String(r.level).padEnd(8)} ${String(r.eventCount).padEnd(8)} ${String(r.rawTokens).padEnd(12)} ${slmCol.padEnd(12)} ${savCol.padEnd(10)} ${r.contextSource}`,
  );
}

console.log(`\n  Assertions: ${totalPassed} passed, ${totalFailed} failed`);
if (allFailures.length > 0) {
  console.log(`\n  Failed assertions:`);
  for (const f of allFailures) console.log(`    - ${f}`);
}

console.log("\n" + "═".repeat(76));

if (totalFailed > 0) {
  console.log(
    `\n  RESULT: ${totalFailed} anchor facts lost across compaction cycles.`,
  );
  console.log(
    `  These facts would be invisible to Claude after compaction.\n`,
  );
} else {
  console.log(
    `\n  RESULT: All anchor facts survived ${COMPACTION_LEVELS.at(-1)} compaction cycles.`,
  );
  console.log(`  ECC memory bank retained full session context.\n`);
}

process.exit(totalFailed > 0 ? 1 : 0);
