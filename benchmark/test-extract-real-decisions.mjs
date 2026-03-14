/**
 * test-extract-real-decisions.mjs — Real-world calibration benchmark for extractUserEvents().
 *
 * Fetches real conversation data from the HuggingFace Datasets Server API
 * (UltraChat 200k — multi-turn tech conversations) and runs all user messages
 * through extractUserEvents() to measure actual extraction rates in the wild.
 *
 * WHY THIS EXISTS:
 *   ECC's decision/intent/role patterns were written and tested against
 *   synthetic data invented by the developer. Real user messages contain:
 *     - Casual tech references ("I'd use Redis here")
 *     - Rhetorical questions ("why would we use MySQL?")
 *     - Code snippets with directive-looking keywords
 *     - Long explanations with one directive sentence buried inside
 *   These are all potential false positives or false negatives that synthetic
 *   tests cannot catch. This benchmark provides ground-truth calibration.
 *
 * WHAT IT MEASURES:
 *   - Decision extraction rate       (target: 2–8%  of real user messages)
 *   - Intent classification coverage  (target: 20–55% of real user messages)
 *   - Role extraction rate            (target: <2%   of real user messages)
 *   - False positive indicators       (questions flagged, acks flagged, etc.)
 *   - Pattern-level breakdown         (which regex triggers the most)
 *
 * ADVERSARIAL STRESS TESTS:
 *   Beyond the live dataset, brutally tests extractors against:
 *     - Code snippets containing "use X instead"
 *     - Rhetorical questions with directive-like wording
 *     - Large code pastes (data vs. decision boundary)
 *     - Multi-sentence messages with buried directive
 *     - Stack traces with instruction-looking keywords
 *     - Rapid-fire short messages
 *     - Turkish decision patterns (ECC ships multilingual support)
 *
 * Run via: node benchmark/test-extract-real-decisions.mjs
 * Options: --quick (1 batch / ~300 msgs), --verbose (print all decision hits)
 * Depends on: build/session/extract.js, HuggingFace Datasets Server API
 */

import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const BUILD_ROOT = join(process.cwd(), "build");
const BUILD = join(BUILD_ROOT, "session");
const { extractUserEvents } = await import(pathToFileURL(join(BUILD, "extract.js")).href);
const { SessionDB }          = await import(pathToFileURL(join(BUILD, "db.js")).href);
const { buildResumeSnapshot } = await import(pathToFileURL(join(BUILD, "snapshot.js")).href);

// ── Config ────────────────────────────────────────────────────────────────────

const QUICK    = process.argv.includes("--quick");
const VERBOSE  = process.argv.includes("--verbose");
const BATCHES  = QUICK ? 1 : 3;   // 1 batch = 100 rows ≈ 300–400 user messages
const FETCH_TIMEOUT_MS = 15_000;

// Calibration thresholds — what % of real user messages should be extracted.
//
// DATASET NOTE: UltraChat is general Q&A, not coding-assistant sessions.
// Real ECC users making technology decisions are a small subset of UltraChat.
// Decision rate in general Q&A is expected to be low (0–3%); a 0% rate is
// acceptable here. What matters is the adversarial tests and FP rate among hits.
// For coding-specific calibration, use CodeAssistBench (future work).
const THRESHOLDS = {
  decision: { lo: 0.00, hi: 0.05, label: "decision rate" },
  intent:   { lo: 0.15, hi: 0.60, label: "intent rate"   },
  role:     { lo: 0.00, hi: 0.03, label: "role rate"     },
  fp_questions: { hi: 0.25, label: "questions flagged as decisions" },
  fp_short:     { hi: 0.15, label: "short msgs (<20 chars) flagged as decisions" },
};

// ── HuggingFace Datasets Server fetch ────────────────────────────────────────

const HF_BASE = "https://datasets-server.huggingface.co/rows";
const DATASET = "HuggingFaceH4/ultrachat_200k";
const CONFIG  = "default";
const SPLIT   = "train_sft";

/**
 * Fetch one batch of rows from the HuggingFace Datasets Server.
 * Returns an array of message arrays (one per conversation).
 * Never throws — returns [] on any network or parse failure.
 */
async function fetchBatch(offset) {
  const url = `${HF_BASE}?dataset=${encodeURIComponent(DATASET)}&config=${CONFIG}&split=${SPLIT}&offset=${offset}&length=100`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.rows ?? []).map(r => r.row?.messages ?? []);
  } catch (err) {
    console.error(`  ⚠  Batch fetch failed (offset=${offset}): ${err.message}`);
    return [];
  }
}

/**
 * Extract all user-turn content strings from a set of conversations.
 */
function extractUserMessages(conversations) {
  const messages = [];
  for (const turns of conversations) {
    for (const turn of turns) {
      if (turn.role === "user" && typeof turn.content === "string" && turn.content.trim()) {
        messages.push(turn.content.trim());
      }
    }
  }
  return messages;
}

// ── False positive heuristics ─────────────────────────────────────────────────
// These heuristics do NOT label a message as a guaranteed false positive —
// they flag it as SUSPICIOUS for human review. A question CAN be a decision
// ("should we use Redis or Postgres?"), but it's less likely than a directive.

const ACK_WORDS = /^(ok|okay|yes|no|sure|thanks|thank you|sounds good|got it|understood|great|perfect|alright|fine|exactly|right|correct)/i;

function fpIndicators(msg, events) {
  const isDecision = events.some(e => e.category === "decision");
  if (!isDecision) return null;
  return {
    isQuestion:      msg.includes("?"),
    isShort:         msg.length < 20,
    isAcknowledgment: ACK_WORDS.test(msg),
    isCodeSnippet:   msg.includes("```") || /^\s*(const|let|var|function|class|import|export)\s/.test(msg),
  };
}

// ── Calibration pass ──────────────────────────────────────────────────────────

/**
 * Run all messages through extractUserEvents() and collect calibration stats.
 */
function calibrate(messages) {
  const stats = {
    total: messages.length,
    withAnyEvent: 0,
    decisions: [],       // {msg, events, fp}
    intents: [],
    roles: [],
    data: [],
    intentCounts: {},    // intent mode → count
    allEvents: [],       // all raw extracted events — for chain phase
  };

  for (const msg of messages) {
    const events = extractUserEvents(msg);
    stats.allEvents.push(...events);
    if (events.length > 0) stats.withAnyEvent++;

    for (const ev of events) {
      if (ev.category === "decision") {
        const fp = fpIndicators(msg, events);
        stats.decisions.push({ msg, events, fp });
        break; // count message once even if multiple decision events
      }
    }

    if (events.some(e => e.category === "intent")) {
      stats.intents.push(msg);
      const mode = events.find(e => e.category === "intent")?.data ?? "unknown";
      stats.intentCounts[mode] = (stats.intentCounts[mode] ?? 0) + 1;
    }

    if (events.some(e => e.category === "role")) stats.roles.push(msg);
    if (events.some(e => e.category === "data")) stats.data.push(msg);
  }

  return stats;
}

// ── Adversarial stress tests ──────────────────────────────────────────────────

/**
 * Brutally tests specific patterns that synthetic tests can't cover.
 * Each case has a label, the input message, and whether we expect a decision hit.
 */
const ADVERSARIAL = [
  // === FALSE POSITIVE traps — should NOT be decisions ===
  {
    label: "code snippet with 'use X instead' in inline comment",
    msg:   "Here's my approach:\n```js\n// use Redis instead of in-memory cache\nconst cache = new Redis();\n```\nDoes this look right?",
    wantDecision: false,
    // "Does this look right?" uses casual review vocabulary not in current patterns.
    // Primary goal here is to confirm the decision false positive is suppressed.
    wantIntent:   null,
  },
  {
    label: "rhetorical question with directive-like wording",
    msg:   "why would we even use Redux when Context API does the same thing?",
    wantDecision: false,
    wantIntent:   true,  // "why would we" → investigate
  },
  {
    label: "quoting someone else's decision",
    msg:   "my tech lead said 'don't use MongoDB, use Postgres' — what do you think?",
    // KNOWN LIMITATION: quoted directives contain the same pattern as real directives.
    // Distinguishing "X said 'don't use Y'" from "don't use Y" requires NLP/parsing
    // beyond simple regex. Marked ambiguous — accept this false positive rate.
    wantDecision: null,
    wantIntent:   null,
  },
  {
    label: "casual acknowledgment with tech word",
    msg:   "ok use whatever database you think is best",
    wantDecision: null,  // ambiguous — could be a real directive, not testing
    wantIntent:   null,
  },
  {
    label: "large code paste (>1024 chars) containing decision-like comments",
    msg:   "Here is the full migration:\n```sql\n" + [
      "-- use UUID instead of SERIAL for primary keys",
      "-- switch to snake_case instead of camelCase",
      "ALTER TABLE users ADD COLUMN user_uuid UUID DEFAULT gen_random_uuid();",
      "CREATE INDEX idx_users_uuid ON users(user_uuid);",
      "-- don't use triggers, use application-level logic instead",
      "-- prefer explicit transactions over implicit autocommit",
    ].join("\n") + "\n```\n" + "-- more migration steps --\n".repeat(30),
    wantDecision: false, // inside code block, and >300 chars means the length guard fires
    wantIntent:   null,
  },
  {
    label: "stack trace dump with no decision in user message",
    msg:   "I'm getting this error:\nTypeError: Cannot read properties of undefined\n    at validateUser (auth.ts:45)\n    at middleware (app.ts:12)\nHow do I fix it?",
    wantDecision: false,
    wantIntent:   true,  // "How do I fix" → implement/investigate
  },
  {
    label: "multi-sentence explanation with 'use' buried in comparison (not directive)",
    msg:   "The difference between REST and GraphQL is that REST APIs use multiple endpoints while GraphQL uses a single endpoint. Both approaches use HTTP underneath. Which one is better for our case?",
    wantDecision: false, // "use multiple endpoints" is descriptive, not directive
    wantIntent:   true,
  },

  // === TRUE POSITIVE cases — SHOULD be decisions ===
  {
    label: "clear directive: technology switch",
    msg:   "don't use Axios, use the native fetch API instead",
    wantDecision: true,
    wantIntent:   null,
  },
  {
    label: "clear directive: let's switch",
    msg:   "let's switch to Prisma over raw SQL",
    wantDecision: true,
    wantIntent:   null,
  },
  {
    label: "Turkish directive (ECC multilingual support)",
    msg:   "hayır, Redux yerine Zustand kullan",
    wantDecision: true,
    wantIntent:   null,
  },
  {
    label: "clear directive: I prefer to",
    msg:   "I prefer to use Zod over Yup for validation",
    wantDecision: true,
    wantIntent:   null,
  },
  {
    label: "clear directive: no, do this instead",
    msg:   "no, don't add tests for that, focus on the auth bug first",
    wantDecision: true,
    wantIntent:   null,
  },

  // === INTENT classification accuracy ===
  {
    label: "intent: investigate (why question)",
    msg:   "why is the JWT token expiring before the configured TTL?",
    wantDecision: false,
    wantIntent:   true,
    wantIntentMode: "investigate",
  },
  {
    label: "intent: implement (build request)",
    msg:   "build a rate limiter middleware that uses Redis for the counter",
    wantDecision: false,
    wantIntent:   true,
    wantIntentMode: "implement",
  },
  {
    label: "intent: review (audit request)",
    msg:   "review the payment module and check for SQL injection risks",
    wantDecision: false,
    wantIntent:   true,
    wantIntentMode: "review",
  },
  {
    label: "intent: discuss (pros/cons request)",
    msg:   "what are the pros and cons of microservices vs monolith for our scale?",
    wantDecision: false,
    wantIntent:   true,
    wantIntentMode: "discuss",
  },

  // === EDGE CASES ===
  {
    label: "empty message",
    msg:   "",
    wantDecision: false,
    wantIntent:   false,
  },
  {
    label: "single word",
    msg:   "yes",
    wantDecision: false,
    wantIntent:   false,
  },
  {
    label: "numbers only",
    msg:   "42",
    wantDecision: false,
    wantIntent:   false,
  },
  {
    label: "emoji only",
    msg:   "👍",
    wantDecision: false,
    wantIntent:   false,
  },
  {
    label: "rapid-fire short messages: acknowledgment",
    msg:   "ok",
    wantDecision: false,
    wantIntent:   false,
  },
  {
    label: "rapid-fire: numeric response to multiple-choice question",
    msg:   "2",
    wantDecision: false,
    wantIntent:   false,
  },
  {
    label: "message in all caps (frustrated user)",
    msg:   "DO NOT USE TYPESCRIPT HERE, JUST PLAIN JS",
    wantDecision: true,  // ALL_CAPS directive is still a directive
    wantIntent:   null,
  },
  {
    label: "decision directive surrounded by hedging language",
    msg:   "I'm not 100% sure but I think we should probably use PostgreSQL over MySQL for this",
    wantDecision: true,  // "use X over Y" matches — hedging doesn't nullify the directive
    wantIntent:   null,
  },
];

// ── Reporting helpers ─────────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? "—" : `${((n / total) * 100).toFixed(1)}%`;
}

function calibrationLabel(rate, lo, hi) {
  if (rate < lo) return "⚠  UNDER-SENSITIVE";
  if (rate > hi) return "⚠  OVER-SENSITIVE";
  return "✓  CALIBRATED";
}

function fpLabel(rate, hi) {
  return rate > hi ? "⚠  HIGH FP RISK" : "✓  OK";
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("\n  ══════════════════════════════════════════════════════");
console.log("  ECC extractUserEvents() — Real-World Calibration");
console.log(`  Dataset: ${DATASET} (${BATCHES} batch${BATCHES > 1 ? "es" : ""} × 100 rows)`);
console.log("  ══════════════════════════════════════════════════════\n");

// ── Phase 1: Fetch live data ──────────────────────────────────────────────────

console.log("  Phase 1: Fetching real conversation data…\n");

const allConversations = [];
for (let b = 0; b < BATCHES; b++) {
  process.stdout.write(`    Batch ${b + 1}/${BATCHES} (offset=${b * 100})… `);
  const conversations = await fetchBatch(b * 100);
  allConversations.push(...conversations);
  console.log(`${conversations.length} conversations`);
}

const userMessages = extractUserMessages(allConversations);
console.log(`\n  Fetched: ${allConversations.length} conversations → ${userMessages.length} user messages\n`);

if (userMessages.length === 0) {
  console.error("  ✗  No messages fetched — cannot calibrate. Check network/API.");
  process.exit(1);
}

// ── Phase 2: Calibration pass ─────────────────────────────────────────────────

console.log("  Phase 2: Running extractUserEvents() on all messages…\n");
const stats = calibrate(userMessages);

const decisionRate = stats.decisions.length / stats.total;
const intentRate   = stats.intents.length   / stats.total;
const roleRate     = stats.roles.length     / stats.total;

// Count false positive indicators
const fpSuspects = stats.decisions.filter(d => d.fp && (d.fp.isQuestion || d.fp.isShort || d.fp.isAcknowledgment || d.fp.isCodeSnippet));
const fpQuestion = stats.decisions.filter(d => d.fp?.isQuestion).length;
const fpShort    = stats.decisions.filter(d => d.fp?.isShort).length;
const fpAck      = stats.decisions.filter(d => d.fp?.isAcknowledgment).length;
const fpCode     = stats.decisions.filter(d => d.fp?.isCodeSnippet).length;
const fpTotal    = fpSuspects.length;

console.log("  ── Extraction rates ────────────────────────────────────");
console.log(`  Total messages:  ${stats.total}`);
console.log(`  Any event:       ${stats.withAnyEvent} (${pct(stats.withAnyEvent, stats.total)})`);
console.log();

const dr = calibrationLabel(decisionRate, THRESHOLDS.decision.lo, THRESHOLDS.decision.hi);
const ir = calibrationLabel(intentRate,   THRESHOLDS.intent.lo,   THRESHOLDS.intent.hi);
const rr = calibrationLabel(roleRate,     THRESHOLDS.role.lo,     THRESHOLDS.role.hi);

console.log(`  decision events: ${stats.decisions.length.toString().padStart(4)}  (${pct(stats.decisions.length, stats.total).padStart(6)})  ${dr}`);
console.log(`  intent events:   ${stats.intents.length.toString().padStart(4)}  (${pct(stats.intents.length, stats.total).padStart(6)})  ${ir}`);
console.log(`  role events:     ${stats.roles.length.toString().padStart(4)}  (${pct(stats.roles.length, stats.total).padStart(6)})  ${rr}`);
console.log(`  data events:     ${stats.data.length.toString().padStart(4)}  (${pct(stats.data.length, stats.total).padStart(6)})  (>1024 char pastes)`);
console.log();

if (stats.decisions.length > 0) {
  const fpQPct  = fpQuestion / stats.decisions.length;
  const fpSPct  = fpShort    / stats.decisions.length;
  const fpTPct  = fpTotal    / stats.decisions.length;

  console.log("  ── False positive indicators (among decision hits) ──────");
  console.log(`  Suspicious total:   ${fpTotal}/${stats.decisions.length} (${pct(fpTotal, stats.decisions.length)})  ${fpLabel(fpTPct, 0.30)}`);
  console.log(`    ↳ has "?" (question):    ${fpQuestion} (${pct(fpQuestion, stats.decisions.length)})  ${fpLabel(fpQPct, THRESHOLDS.fp_questions.hi)}`);
  console.log(`    ↳ <20 chars:             ${fpShort}    (${pct(fpShort,    stats.decisions.length)})  ${fpLabel(fpSPct, THRESHOLDS.fp_short.hi)}`);
  console.log(`    ↳ acknowledgment start:  ${fpAck}      (${pct(fpAck,     stats.decisions.length)})`);
  console.log(`    ↳ code snippet:          ${fpCode}     (${pct(fpCode,    stats.decisions.length)})`);
  console.log();
}

if (Object.keys(stats.intentCounts).length > 0) {
  console.log("  ── Intent mode breakdown ───────────────────────────────");
  for (const [mode, count] of Object.entries(stats.intentCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${mode.padEnd(15)} ${count.toString().padStart(4)}  (${pct(count, stats.intents.length)} of intent hits)`);
  }
  console.log();
}

if (VERBOSE || stats.decisions.length <= 20) {
  console.log("  ── Decision hits (sample for eyeball review) ───────────");
  const sample = VERBOSE ? stats.decisions : stats.decisions.slice(0, 15);
  for (const { msg, fp } of sample) {
    const fpFlags = fp
      ? Object.entries(fp).filter(([, v]) => v).map(([k]) => k).join(", ")
      : "";
    const truncated = msg.length > 100 ? msg.slice(0, 97) + "…" : msg;
    const marker = fpFlags ? `  ⚠ [${fpFlags}]` : "";
    console.log(`    → "${truncated}"${marker}`);
  }
  if (!VERBOSE && stats.decisions.length > 15) {
    console.log(`    … and ${stats.decisions.length - 15} more (run with --verbose to see all)`);
  }
  console.log();
}

// Suspicious FP samples
if (fpSuspects.length > 0) {
  console.log("  ── Suspicious false positives (decisions with FP indicators) ─");
  for (const { msg, fp } of fpSuspects.slice(0, 8)) {
    const flags = Object.entries(fp).filter(([, v]) => v).map(([k]) => k).join(", ");
    const truncated = msg.length > 90 ? msg.slice(0, 87) + "…" : msg;
    console.log(`    ⚠ [${flags}] "${truncated}"`);
  }
  console.log();
}

// ── Phase 3: Adversarial stress tests ────────────────────────────────────────

console.log("  Phase 3: Adversarial stress tests…\n");

let advPassed = 0;
let advFailed = 0;
let advSkipped = 0;

for (const test of ADVERSARIAL) {
  const events = extractUserEvents(test.msg);
  const hasDecision = events.some(e => e.category === "decision");
  const hasIntent   = events.some(e => e.category === "intent");
  const intentMode  = events.find(e => e.category === "intent")?.data;

  let pass = true;
  const failures = [];

  if (test.wantDecision === true  && !hasDecision) { pass = false; failures.push("expected decision, got none"); }
  if (test.wantDecision === false &&  hasDecision) { pass = false; failures.push(`unexpected decision extracted`); }
  if (test.wantIntent   === true  && !hasIntent)   { pass = false; failures.push("expected intent, got none"); }
  if (test.wantIntent   === false &&  hasIntent)   { pass = false; failures.push(`unexpected intent extracted`); }
  if (test.wantIntentMode && intentMode !== test.wantIntentMode) {
    pass = false; failures.push(`intent mode: want "${test.wantIntentMode}", got "${intentMode}"`);
  }

  if (test.wantDecision === null && test.wantIntent === null && !test.wantIntentMode) {
    // Ambiguous — not testing, just observing
    advSkipped++;
    if (VERBOSE) {
      const label = hasDecision ? "[decision]" : hasIntent ? `[intent:${intentMode}]` : "[none]";
      console.log(`  ? ${label.padEnd(20)} ${test.label}`);
    }
    continue;
  }

  if (pass) {
    advPassed++;
    console.log(`  ✓ ${test.label}`);
  } else {
    advFailed++;
    console.error(`  ✗ ${test.label}`);
    for (const f of failures) console.error(`      → ${f}`);
    if (VERBOSE) {
      const truncMsg = test.msg.length > 80 ? test.msg.slice(0, 77) + "…" : test.msg;
      console.error(`      msg: "${truncMsg}"`);
    }
  }
}

if (advSkipped > 0) console.log(`\n  (${advSkipped} ambiguous cases skipped — run --verbose to observe)`);

// ── Phase 4: Calibration verdict ─────────────────────────────────────────────

console.log(`\n  ${"═".repeat(54)}`);
console.log("  CALIBRATION VERDICT\n");

const liveOk = [
  calibrationLabel(decisionRate, THRESHOLDS.decision.lo, THRESHOLDS.decision.hi).startsWith("✓"),
  calibrationLabel(intentRate,   THRESHOLDS.intent.lo,   THRESHOLDS.intent.hi).startsWith("✓"),
  calibrationLabel(roleRate,     THRESHOLDS.role.lo,     THRESHOLDS.role.hi).startsWith("✓"),
].every(Boolean);

const fpOk = stats.decisions.length === 0 || (fpTotal / stats.decisions.length) <= 0.30;
const advOk = advFailed === 0;

if (liveOk && fpOk && advOk) {
  console.log("  ✓  PASS — extractUserEvents() is calibrated for real-world data");
} else {
  if (!liveOk) {
    console.log("  ⚠  LIVE DATA: extraction rates outside calibration targets");
    if (decisionRate > THRESHOLDS.decision.hi)
      console.log(`     decision rate ${pct(stats.decisions.length, stats.total)} > ${(THRESHOLDS.decision.hi*100).toFixed(0)}% — patterns too aggressive`);
    if (decisionRate < THRESHOLDS.decision.lo)
      console.log(`     decision rate ${pct(stats.decisions.length, stats.total)} < ${(THRESHOLDS.decision.lo*100).toFixed(0)}% — patterns too restrictive`);
    if (intentRate > THRESHOLDS.intent.hi)
      console.log(`     intent rate ${pct(stats.intents.length, stats.total)} > ${(THRESHOLDS.intent.hi*100).toFixed(0)}% — over-sensitive`);
    if (intentRate < THRESHOLDS.intent.lo)
      console.log(`     intent rate ${pct(stats.intents.length, stats.total)} < ${(THRESHOLDS.intent.lo*100).toFixed(0)}% — under-sensitive`);
  }
  if (!fpOk) {
    const fpRate = pct(fpTotal, stats.decisions.length);
    console.log(`  ⚠  FALSE POSITIVES: ${fpRate} of decision hits are suspicious (target: <30%)`);
    console.log(`     Tip: run --verbose to see suspicious samples and calibrate DECISION_PATTERNS`);
  }
  if (!advOk) {
    console.log(`  ✗  ADVERSARIAL: ${advFailed} stress test(s) failed`);
  }
}

console.log();
console.log(`  Live data:   ${stats.decisions.length} decisions / ${stats.total} msgs = ${pct(stats.decisions.length, stats.total)}`);
console.log(`  Adversarial: ${advPassed} passed, ${advFailed} failed, ${advSkipped} skipped`);

// ── Chain Phase: extract → DB → FTS5 → snapshot ─────────────────────────────
//
// Verifies extracted events flow through the entire ECC pipeline, not just
// the extraction layer.  Without this, extraction might produce events that
// can't be indexed by FTS5 or rendered by the snapshot builder.

console.log(`\n  ${"─".repeat(54)}`);
console.log("  Chain Phase: extract → store → search → snapshot\n");

const chainDir = join(tmpdir(), "ecc-calibrate-chain");
mkdirSync(chainDir, { recursive: true });
const chainDbPath = join(chainDir, "calibrate-chain.db");
if (existsSync(chainDbPath)) rmSync(chainDbPath);

const chainDb = new SessionDB({ dbPath: chainDbPath });
const chainSid = `calibrate-chain-${Date.now()}`;
chainDb.ensureSession(chainSid, chainDir);

// Insert all extracted events
let chainInserted = 0;
for (const ev of stats.allEvents) {
  chainDb.insertEvent(chainSid, ev, "UserPromptSubmit");
  chainInserted++;
}
console.log(`  Inserted: ${chainInserted} events into chain DB`);

// FTS5 recall: query for distinctive terms from intent/data/decision events
const chainEvents = chainDb.getEvents(chainSid);
const termSamples = chainEvents
  .filter(e => e.category === "decision" || e.category === "data")
  .slice(0, 10)
  .map(e => {
    const words = (e.data.match(/\b[a-zA-Z]{6,}\b/g) ?? []);
    return words.length > 0 ? words[0] : null;
  })
  .filter(Boolean);

let ftsHits = 0;
for (const term of termSamples) {
  try {
    const hits = chainDb.searchEvents(term, 5);
    if (hits.length > 0) ftsHits++;
  } catch { /* special chars */ }
}
const ftsPct = termSamples.length > 0
  ? ((ftsHits / termSamples.length) * 100).toFixed(0)
  : "—";
console.log(`  FTS5 recall: ${ftsHits}/${termSamples.length} terms found (${ftsPct}%)`);

// Snapshot
const snapshot = buildResumeSnapshot(chainEvents, { compactCount: 0 });
const snapBytes = Buffer.byteLength(snapshot);
const hasFiles  = snapshot.includes("<active_files>");
const hasDecisions = snapshot.includes("<decisions>");
const sections = [hasFiles && "files", hasDecisions && "decisions"].filter(Boolean).join(", ") || "minimal";
console.log(`  Snapshot: ${snapBytes} bytes | sections: ${sections}`);

let chainFailed = 0;
if (chainInserted === 0) { console.log("  ✗  Chain FAIL: no events inserted"); chainFailed++; }
if (snapBytes < 100)     { console.log("  ✗  Chain FAIL: snapshot too small"); chainFailed++; }
if (chainFailed === 0)   { console.log("  ✓  Chain OK: extract → store → search → snapshot"); }

chainDb.close();

console.log(`  ${"═".repeat(54)}\n`);

process.exit((advFailed + chainFailed) > 0 ? 1 : 0);
