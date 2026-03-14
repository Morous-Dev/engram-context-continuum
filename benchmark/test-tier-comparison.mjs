/**
 * test-tier-comparison.mjs — Multi-tier SLM compaction benchmark.
 *
 * Responsible for: running the same compaction marathon stress test
 * (4→20 cycles, identical anchor facts and event data) against all three
 * SLM tiers in parallel and producing a side-by-side comparison scorecard.
 * Identifies which tier retains the most anchor facts at each compaction
 * level and which is most token-efficient.
 *
 * Tiers tested:
 *   tier3  — Llama 3.2 3B Q5_K_M  (~2.32 GB)
 *   tier3b — Qwen3.5 4B Q4_K_M    (~2.74 GB)
 *   tier3c — Gemma 3 4B QAT Q4_0  (~2.37 GB)
 *
 * Each tier is tested with the SAME events, SAME compaction level, SAME
 * prompt (buildCompactBriefPrompt). Skips unavailable tiers gracefully.
 *
 * Anchor facts (must survive all levels):
 *   AF1 — PostgreSQL (not MongoDB) as final DB choice
 *   AF2 — JWT with refresh tokens for auth
 *   AF3 — WebSocket memory leak unresolved (reappears at cycle 8)
 *   AF4 — utils/ renamed to shared/
 *   AF5 — Current task from latest cycle
 *   AF6 — Prisma (not Mongoose) as ORM
 *
 * Run via: node benchmark/test-tier-comparison.mjs
 * Depends on: build/ (compiled TypeScript), benchmark/marathon-data.mjs
 */

// OVERSIZE: This benchmark is ~420 lines. The bulk is the per-level output
// loop and the comparison scorecard — no good split boundary exists.

import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { seed } from "./seed-helpers.mjs";
import { generateCycleEvents, estimateTokens } from "./marathon-data.mjs";
import { getBenchmarkModelsDir } from "./models-dir.mjs";

// ── Constants ─────────────────────────────────────────────────────────────────

const BUILD = join(process.cwd(), "build");
const MODELS_DIR = (() => {
  try {
    return getBenchmarkModelsDir();
  } catch (error) {
    console.error(`\n  ${error.message}`);
    process.exit(1);
  }
})();
const COMPACTION_LEVELS = [4, 8, 12, 16, 20];
/** Assertions per level: 7 for levels < 9, 8 for levels >= 9 (AF3 reappearance check) */
const ASSERT_TOTAL = (level) => (level >= 9 ? 8 : 7);
/** Per-tier SLM timeout in ms */
const TIER_TIMEOUT_MS = 60_000;

// ── Module imports ────────────────────────────────────────────────────────────

const { SessionDB } = await import(pathToFileURL(join(BUILD, "session", "db.js")).href);
const { buildResumeSnapshot } = await import(pathToFileURL(join(BUILD, "session", "snapshot.js")).href);
const { auditSessionEvents } = await import(pathToFileURL(join(BUILD, "tokenization", "auditor.js")).href);
const { buildSynthesisInput } = await import(pathToFileURL(join(BUILD, "handoff", "writer.js")).href);
const { calculateCompactBudget } = await import(pathToFileURL(join(BUILD, "session", "compact-budget.js")).href);
const { buildCompactBriefPrompt } = await import(pathToFileURL(join(BUILD, "compression", "schema.js")).href);
const { truncateString } = await import(pathToFileURL(join(BUILD, "truncate.js")).href);
const { Tier3Compressor } = await import(pathToFileURL(join(BUILD, "compression", "tier3.js")).href);
const { Tier3bCompressor } = await import(pathToFileURL(join(BUILD, "compression", "tier3b.js")).href);
const { Tier3cCompressor } = await import(pathToFileURL(join(BUILD, "compression", "tier3c.js")).href);

const sessionDirectivePath = join(process.cwd(), "src", "hooks", "session-directive.mjs");
const { writeSessionEventsFile, buildSessionDirective } =
  await import(pathToFileURL(sessionDirectivePath).href);

// ── Tier registry ─────────────────────────────────────────────────────────────

const ALL_TIERS = [
  { name: "tier3",  compressor: new Tier3Compressor() },
  { name: "tier3b", compressor: new Tier3bCompressor() },
  { name: "tier3c", compressor: new Tier3cCompressor() },
];

// Check availability up front
for (const t of ALL_TIERS) {
  t.available = t.compressor.isAvailable();
}
const availableTiers = ALL_TIERS.filter((t) => t.available);

// ── Brief pipeline ────────────────────────────────────────────────────────────

/**
 * Run the compact brief pipeline with a specific compressor instance.
 * Mirrors generateCompactBrief() in compact-brief.ts but accepts any
 * compressor directly instead of using the getCompressor() singleton.
 *
 * @param compressor   - The SLM compressor to use.
 * @param cleanedEvents - Audited session events.
 * @param compactCount  - Compaction cycle index (for budget calculation).
 * @returns Formatted XML brief string, or null on failure/timeout.
 */
async function runBriefWithTier(compressor, cleanedEvents, compactCount) {
  if (cleanedEvents.length === 0) return null;

  // Group events by category (mirrors compact-brief.ts:extractSynthesisInputs)
  const byCategory = {};
  for (const ev of cleanedEvents) {
    (byCategory[ev.category] ??= []).push(ev);
  }

  const fileEvents     = byCategory["file"]     ?? [];
  const errorEvents    = byCategory["error"]    ?? [];
  const promptEvents   = byCategory["prompt"]   ?? [];
  const decisionEvents = byCategory["decision"] ?? [];

  const filesModified = [
    ...new Set(
      fileEvents
        .filter((e) => e.type === "file_write" || e.type === "file_edit")
        .map((e) => e.data),
    ),
  ];
  // Mirror compact-brief.ts: unresolved errors feed the active errors section,
  // while resolved errors are passed separately for the synthesis prompt.
  const allErrors = errorEvents
    .filter((e) => e.type !== "error_resolved")
    .map((e) => truncateString(e.data, 200));
  const errorsResolved = errorEvents
    .filter((e) => e.type === "error_resolved")
    .map((e) => truncateString(e.data, 200));
  const lastPrompt = promptEvents.at(-1);
  const currentTask = lastPrompt ? truncateString(lastPrompt.data, 300) : "";
  const lastFile = fileEvents.filter((e) => e.type === "file_write" || e.type === "file_edit").at(-1);
  const lastAction = lastFile
    ? `${lastFile.type === "file_write" ? "Wrote" : "Edited"} ${lastFile.data}`
    : "";

  const synthesisInput = buildSynthesisInput(
    promptEvents, decisionEvents, filesModified, allErrors, errorsResolved, currentTask, lastAction,
  );
  if (!synthesisInput.trim()) return null;

  const budget = calculateCompactBudget(cleanedEvents, compactCount);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIER_TIMEOUT_MS);

  try {
    const result = await Promise.race([
      compressor.compress(synthesisInput, budget.compressionRatio, buildCompactBriefPrompt),
      new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error(`${compressor.tier} timed out after ${TIER_TIMEOUT_MS / 1000}s`)),
        );
      }),
    ]);
    clearTimeout(timeout);

    if (result.format === "json" && result.structured) {
      const s = result.structured;
      let block = `\n<session_knowledge source="compact" generator="slm" tier="${compressor.tier}">`;
      if (s.current_task) block += `\n## Current Task [${s.task_status ?? "IN_PROGRESS"}]\n${s.current_task}\n`;
      if (s.synthesis)    block += `\n## Summary\n${s.synthesis}\n`;
      if (s.decisions?.length) {
        block += `\n## Decisions`;
        for (const d of s.decisions) block += `\n- [${d.status}] ${d.topic}: ${d.decision}`;
        block += `\n`;
      }
      if (s.errors?.length) {
        const unresolved = s.errors.filter((e) => e.status !== "RESOLVED");
        if (unresolved.length > 0) {
          block += `\n## Unresolved Errors`;
          for (const e of unresolved) block += `\n- [${e.status}] ${e.description}`;
          block += `\n`;
        }
      }
      if (s.next_session) block += `\n## Next Step\n${s.next_session}\n`;
      block += `\n</session_knowledge>`;
      return block.length > 50 ? block : null;
    } else if (result.compressed?.trim()) {
      const prose = result.compressed.trim();
      const block = `\n<session_knowledge source="compact" generator="slm" tier="${compressor.tier}">\n${prose}\n</session_knowledge>`;
      return block.length > 50 ? block : null;
    }
    return null;
  } catch (err) {
    clearTimeout(timeout);
    console.error(`    [${compressor.tier}] brief failed: ${err.message}`);
    return null;
  }
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

/**
 * Run all anchor fact assertions on a context string.
 * Returns { passed, failed, failures[] } for the given tier+level.
 *
 * @param context  - Full injected context string to test.
 * @param level    - Compaction level (affects which assertions are active).
 * @param tierName - Tier label for failure messages.
 * @returns Assertion result object.
 */
function claimsRecurringLeakResolved(text) {
  const lower = text.toLowerCase();
  const claimsResolved =
    lower.includes("memory leak resolved") ||
    lower.includes("leak fixed");
  const mentionsReappearance =
    lower.includes("reappear") ||
    lower.includes("still unresolved") ||
    lower.includes("unresolved") ||
    lower.includes("not yet implemented") ||
    lower.includes("not implemented");
  return claimsResolved && !mentionsReappearance;
}

function runAssertions(context, level, tierName, brief) {
  const lower = context.toLowerCase();
  const briefLower = (brief ?? context).toLowerCase();
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(condition, label) {
    if (condition) { passed++; }
    else           { failed++; failures.push(`[${level}c/${tierName}] ${label}`); }
    return condition;
  }

  // AF1: PostgreSQL is the DB
  check(lower.includes("postgres"), "AF1: PostgreSQL mentioned as database");

  // AF1b: MongoDB not presented as current DB without PostgreSQL
  const mongoAsCurrent =
    lower.includes("mongodb") && !lower.includes("postgres") &&
    !lower.includes("abandon") && !lower.includes("switch");
  check(!mongoAsCurrent, "AF1: MongoDB not reported as current DB without PostgreSQL");

  // AF2: JWT auth
  check(lower.includes("jwt"), "AF2: JWT auth pattern mentioned");

  // AF3: WebSocket mentioned (cycle 2+)
  if (level >= 3) {
    check(lower.includes("websocket"), "AF3: WebSocket issue mentioned");
  }

  // AF3: Leak NOT claimed resolved (cycle 9+ — reappeared at cycle 8)
  if (level >= 9) {
    check(!claimsRecurringLeakResolved(briefLower), "AF3: WebSocket leak NOT claimed as resolved (reappeared)");
  }

  // AF4: shared/ directory (cycle 3+)
  if (level >= 4) {
    check(lower.includes("shared"), "AF4: shared/ directory referenced (post-rename)");
  }

  // AF5: Task context present
  check(lower.includes("task"), "AF5: Task context present from latest cycle");

  // AF6: Prisma as ORM
  check(lower.includes("prisma"), "AF6: Prisma mentioned as ORM (final choice over Mongoose)");

  return { passed, failed, failures };
}

// ── Results store ─────────────────────────────────────────────────────────────

/** Per-level, per-tier results. levelData[level][tierName] = { brief, tokens, savings, passed, total } */
const levelData = {};
const allFailures = [];

// ── Main benchmark ────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(76));
console.log("  TIER COMPARISON — SLM Compaction Memory Retention");
console.log("  Same stress test (4→20 cycles) run against tier3 / tier3b / tier3c");
console.log("═".repeat(76));

console.log("\n  Tier availability:");
for (const t of ALL_TIERS) {
  console.log(`    ${t.available ? "✓" : "✗"} ${t.name}${t.available ? "" : " (model file not found — skipped)"}`);
}

if (availableTiers.length === 0) {
  console.error(`\n  No SLM tiers available. Install at least one model in the configured shared models directory:\n  ${MODELS_DIR}`);
  process.exit(1);
}

for (const level of COMPACTION_LEVELS) {
  console.log(`\n${"─".repeat(76)}`);
  console.log(`  Compaction Level: ${level} cycles`);
  console.log(`${"─".repeat(76)}`);

  // ── Set up fresh DB ──────────────────────────────────────────────────────
  const dbDir = join(tmpdir(), "ecc-tier-bench");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, `tier-cmp-${level}.db`);
  if (existsSync(dbPath)) rmSync(dbPath);

  const db = new SessionDB({ dbPath });
  const sessionId = `tier-cmp-${level}-${Date.now()}`;
  const projectDir = join(tmpdir(), `ecc-tier-project-${level}`);
  mkdirSync(projectDir, { recursive: true });
  db.ensureSession(sessionId, projectDir);

  // ── Seed events ──────────────────────────────────────────────────────────
  const allEvents = generateCycleEvents(level);
  seed(db, sessionId, allEvents, "PostToolUse");
  console.log(`  Events seeded: ${allEvents.length}`);

  // ── Audit and snapshot (same for all tiers) ──────────────────────────────
  const storedEvents = db.getEvents(sessionId);
  const { cleanedEvents } = auditSessionEvents(storedEvents);
  const snapshot = buildResumeSnapshot(cleanedEvents, { compactCount: level });

  // ── Raw event dump (baseline — same for all tiers) ───────────────────────
  const eventsFilePath = join(projectDir, `events-${level}.md`);
  const eventMeta = writeSessionEventsFile(storedEvents, eventsFilePath);
  const rawDirective = buildSessionDirective("compact", eventMeta);
  const rawContext = `${snapshot}\n${rawDirective}`;
  const rawTokens = estimateTokens(rawContext);

  db.close();

  console.log(`  Raw event dump: ${rawTokens} tokens (${rawDirective.length} bytes)`);

  levelData[level] = { rawTokens, tiers: {} };

  // ── Run each available tier ──────────────────────────────────────────────
  for (const { name, compressor } of availableTiers) {
    console.log(`\n  ── ${name} ──`);

    const brief = await runBriefWithTier(compressor, cleanedEvents, level);
    const fullContext = brief ? `${snapshot}\n${brief}` : rawContext;
    const slmTokens = brief ? estimateTokens(fullContext) : null;
    const savings = slmTokens ? Math.round(((rawTokens - slmTokens) / rawTokens) * 100) : null;

    if (brief) {
      console.log(`  Tokens: ${slmTokens} (${savings}% savings vs raw)`);
    } else {
      console.log(`  Brief: failed/null — using raw context for assertions`);
    }

    const assertions = runAssertions(fullContext, level, name, brief);
    const total = ASSERT_TOTAL(level);

    console.log(`  Anchor facts: ${assertions.passed}/${total}`);
    for (const f of assertions.failures) {
      console.log(`    ✗ ${f.replace(`[${level}c/${name}] `, "")}`);
    }
    allFailures.push(...assertions.failures);

    levelData[level].tiers[name] = {
      brief: brief != null,
      tokens: slmTokens,
      savings,
      passed: assertions.passed,
      total,
      failures: assertions.failures,
    };
  }
}

// ── Dispose models ────────────────────────────────────────────────────────────
for (const { compressor } of availableTiers) {
  if (typeof compressor.dispose === "function") {
    await compressor.dispose().catch(() => {});
  }
}

// ── Comparison scorecard ──────────────────────────────────────────────────────

console.log("\n\n" + "═".repeat(76));
console.log("  TIER COMPARISON SCORECARD");
console.log("═".repeat(76));

// Column widths
const tierNames = availableTiers.map((t) => t.name);
const COL = 18;

// Header row
let header = `\n  ${"Level".padEnd(7)} ${"Raw Tok".padEnd(9)}`;
for (const n of tierNames) header += ` ${n.padEnd(COL)}`;
console.log(header);

let divider = `  ${"─".repeat(7)} ${"─".repeat(9)}`;
for (const n of tierNames) divider += ` ${"─".repeat(COL)}`;
console.log(divider);

// Data rows
for (const level of COMPACTION_LEVELS) {
  const { rawTokens, tiers } = levelData[level];
  let row = `  ${String(level).padEnd(7)} ${String(rawTokens).padEnd(9)}`;

  for (const n of tierNames) {
    const t = tiers[n];
    if (!t) {
      row += ` ${"N/A (unavailable)".padEnd(COL)}`;
    } else if (!t.brief) {
      row += ` ${"failed/null".padEnd(COL)}`;
    } else {
      const cell = `${t.tokens}T ${t.passed}/${t.total} ${t.savings}%`;
      row += ` ${cell.padEnd(COL)}`;
    }
  }
  console.log(row);
}

// ── Winner per level ──────────────────────────────────────────────────────────

console.log(`\n  Winner per compaction level:`);
console.log(`  (primary: most anchor facts retained; tiebreak: fewest tokens)\n`);

for (const level of COMPACTION_LEVELS) {
  const { tiers } = levelData[level];
  const candidates = tierNames
    .map((n) => ({ name: n, ...tiers[n] }))
    .filter((t) => t.brief);

  if (candidates.length === 0) {
    console.log(`  ${String(level).padEnd(5)} cycles: no tier produced a brief`);
    continue;
  }

  // Sort: most passed first, then fewest tokens
  candidates.sort((a, b) => {
    if (b.passed !== a.passed) return b.passed - a.passed;
    return (a.tokens ?? Infinity) - (b.tokens ?? Infinity);
  });

  const winner = candidates[0];
  const others = candidates.slice(1).map((c) => `${c.name}: ${c.passed}/${c.total}`).join(", ");
  const othersStr = others ? `  (others: ${others})` : "";

  const isTie = candidates.length > 1 && candidates[1].passed === winner.passed;
  const label = isTie ? `TIE — ${candidates.map((c) => c.name).join("/")}` : winner.name;
  const detail = isTie
    ? `${winner.passed}/${winner.total} facts, fewest tokens: ${winner.tokens}`
    : `${winner.passed}/${winner.total} facts, ${winner.tokens} tokens (${winner.savings}% savings)`;

  console.log(`  ${String(level).padEnd(5)} cycles: ${label.padEnd(10)} — ${detail}`);
}

// ── All failures ──────────────────────────────────────────────────────────────

if (allFailures.length > 0) {
  console.log(`\n  All failed assertions:`);
  for (const f of allFailures) console.log(`    - ${f}`);
}

// ── Overall winner ────────────────────────────────────────────────────────────

console.log(`\n  Overall score (sum across all levels):`);
const totals = {};
for (const n of tierNames) {
  totals[n] = { passed: 0, total: 0, levels: 0 };
}
for (const level of COMPACTION_LEVELS) {
  const { tiers } = levelData[level];
  for (const n of tierNames) {
    const t = tiers[n];
    if (t) {
      totals[n].passed += t.passed;
      totals[n].total  += t.total;
      totals[n].levels += 1;
    }
  }
}
const sorted = tierNames
  .filter((n) => totals[n].levels > 0)
  .sort((a, b) => totals[b].passed - totals[a].passed);

for (const n of sorted) {
  const { passed, total, levels } = totals[n];
  const pct = Math.round((passed / total) * 100);
  console.log(`    ${n.padEnd(8)}: ${passed}/${total} (${pct}%) across ${levels} levels`);
}

console.log("\n" + "═".repeat(76) + "\n");

// Dispose compressor instances before exit — releases VRAM/RAM held by node-llama-cpp.
// process.exit() would terminate without giving the GPU driver a chance to clean up.
for (const { compressor } of ALL_TIERS) {
  try { await compressor.dispose(); } catch { /* ignore — disposal is best-effort */ }
}

const anyFailed = allFailures.length > 0;
process.exit(anyFailed ? 1 : 0);
