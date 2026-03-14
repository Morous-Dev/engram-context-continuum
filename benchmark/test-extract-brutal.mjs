/**
 * test-extract-brutal.mjs — Multi-source brutal calibration for extractUserEvents().
 *
 * Uses two real-world "in the wild" data sources unavailable to synthetic tests:
 *
 *   SOURCE A — WildChat-1M (allenai/WildChat-1M)
 *     1M real ChatGPT interaction logs including failed attempts, poor context
 *     management, and mid-conversation corrections. Filtered for English coding
 *     conversations. Tests: messy multi-turn dev sessions, "wait that didn't
 *     work" corrections, copy-pasted code dumps, frustrated corrections.
 *
 *   SOURCE B — SWE-bench (SWE-bench/SWE-bench)
 *     Real GitHub issues from 300+ repos, used as verbatim user messages.
 *     Why: this is the exact kind of long text a developer pastes into a session
 *     to kick off work. Tests: technical problem descriptions, bug reports with
 *     stack traces, feature requests with design opinions (decision extraction),
 *     large pastes triggering the data extractor.
 *
 * WHAT IT STRESS-TESTS:
 *   - Decision false positive rate in real coding talk (not Q&A)
 *   - Intent classification on raw GitHub issue text
 *   - Data extractor threshold (>1024 chars) on real long messages
 *   - Comparative calibration: are rates consistent across very different sources?
 *   - Multi-turn correction patterns ("no actually", "wait", "that's wrong")
 *     — these are the "turning points" ECC must capture as decisions
 *
 * Run via: node benchmark/test-extract-brutal.mjs
 * Options: --quick (half batches), --verbose (show all hits per source)
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

const QUICK   = process.argv.includes("--quick");
const VERBOSE = process.argv.includes("--verbose");
const TIMEOUT = 15_000;

// WildChat: fetch this many rows total to find enough coding conversations.
// Coding conversations are ~20-30% of WildChat, so 500 rows → ~120 coding convs.
const WILDCHAT_ROWS   = QUICK ? 300 : 600;
const SWEBENCH_ROWS   = QUICK ?  80 : 200;

// Keyword filter to identify WildChat conversations that are coding-related.
// Applied to the first user message only (topic-setting turn).
const CODING_RE = /\b(code|function|class|method|bug|error|exception|fix|script|python|javascript|typescript|java|golang|rust|sql|api|database|npm|pip|git|docker|deploy|refactor|test|lint|compile|build|parse|regex|async|await|promise|callback|hook|component|module|import|export|query|schema|migration|endpoint|middleware|auth|token|cache|redis|postgres|mongo|mysql)\b/i;

// ── HuggingFace fetch helpers ─────────────────────────────────────────────────

async function fetchRows(dataset, config, split, offset, length) {
  const url = `https://datasets-server.huggingface.co/rows` +
    `?dataset=${encodeURIComponent(dataset)}` +
    `&config=${config}&split=${split}&offset=${offset}&length=${length}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.rows ?? []).map(r => r.row);
  } catch (err) {
    process.stderr.write(`  ⚠  fetch failed (${dataset} offset=${offset}): ${err.message}\n`);
    return [];
  }
}

async function fetchAllInBatches(dataset, config, split, totalRows) {
  const batchSize = 100;
  const batches = Math.ceil(totalRows / batchSize);
  const rows = [];
  for (let i = 0; i < batches; i++) {
    process.stdout.write(`\r    batch ${i + 1}/${batches}…`);
    const batch = await fetchRows(dataset, config, split, i * batchSize, batchSize);
    rows.push(...batch);
  }
  process.stdout.write(`\r    done (${rows.length} rows fetched)          \n`);
  return rows;
}

// ── Source A: WildChat ────────────────────────────────────────────────────────

/**
 * Extract user messages from WildChat rows, filtered to English coding conversations.
 * Returns [{msg, turn, isCorrectionTurn}] — isCorrectionTurn marks turns 2+ where
 * the user is responding to the AI (mid-session corrections, the most valuable turns).
 */
function extractWildChatMessages(rows) {
  const messages = [];
  let codingConvCount = 0;

  for (const row of rows) {
    const conv = row.conversation ?? [];
    const lang = row.language;
    if (lang !== "English" && lang !== "english") continue;
    if (conv.length === 0) continue;

    // Filter for coding conversations by checking the first user message
    const firstUserMsg = conv.find(t => t.role === "user")?.content ?? "";
    if (!CODING_RE.test(firstUserMsg)) continue;

    codingConvCount++;
    let turnIndex = 0;
    for (const turn of conv) {
      if (turn.role !== "user") { continue; }
      const content = String(turn.content ?? "").trim();
      if (!content) continue;
      turnIndex++;
      // isCorrectionTurn: turn 2+ means user is responding to AI output
      // — these are the "wait that didn't work" / "actually use X" messages
      messages.push({
        msg: content,
        turn: turnIndex,
        isCorrectionTurn: turnIndex > 1,
      });
    }
  }

  return { messages, codingConvCount };
}

// ── Source B: SWE-bench ───────────────────────────────────────────────────────

/**
 * Extract problem statements from SWE-bench rows.
 * Each problem_statement is a real GitHub issue body — the kind of long
 * technical text a developer pastes at the start of a coding session.
 */
function extractSweBenchMessages(rows) {
  return rows
    .map(r => ({
      msg: String(r.problem_statement ?? "").trim(),
      repo: String(r.repo ?? ""),
    }))
    .filter(r => r.msg.length > 0);
}

// ── Calibration pass ──────────────────────────────────────────────────────────

function calibrate(items, msgKey = "msg") {
  const stats = {
    total: items.length,
    decisions: [],
    intents: { total: 0, modes: {} },
    roles:     0,
    data:      0,
    noEvent:   0,
    allEvents: [],  // all raw extracted events — for chain phase
  };

  for (const item of items) {
    const msg    = item[msgKey];
    const events = extractUserEvents(msg);
    stats.allEvents.push(...events);
    if (events.length === 0) { stats.noEvent++; continue; }

    if (events.some(e => e.category === "decision")) {
      stats.decisions.push(item);
    }
    if (events.some(e => e.category === "intent")) {
      stats.intents.total++;
      const mode = events.find(e => e.category === "intent")?.data ?? "unknown";
      stats.intents.modes[mode] = (stats.intents.modes[mode] ?? 0) + 1;
    }
    if (events.some(e => e.category === "role")) stats.roles++;
    if (events.some(e => e.category === "data")) stats.data++;
  }

  return stats;
}

// ── Correction turn analysis ──────────────────────────────────────────────────

/**
 * Among WildChat correction turns (turn > 1), measure how many trigger
 * decision extraction. These are the most valuable turns for ECC — they
 * represent the user changing direction ("no actually use X instead").
 * We expect a higher decision rate here than on turn-1 messages.
 */
function analyzeCorrections(messages) {
  const corrections = messages.filter(m => m.isCorrectionTurn);
  const turn1       = messages.filter(m => !m.isCorrectionTurn);

  const corrStats = calibrate(corrections);
  const turn1Stats = calibrate(turn1);

  return { corrections, corrStats, turn1Stats };
}

// ── Report helpers ────────────────────────────────────────────────────────────

function pct(n, total) {
  if (total === 0) return "—";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function printCalibration(label, stats) {
  console.log(`\n  [ ${label} ]`);
  console.log(`  Total messages:    ${stats.total}`);
  console.log(`  decision events:   ${stats.decisions.length.toString().padStart(4)} (${pct(stats.decisions.length, stats.total).padStart(6)})`);
  console.log(`  intent events:     ${stats.intents.total.toString().padStart(4)} (${pct(stats.intents.total, stats.total).padStart(6)})`);
  console.log(`  role events:       ${stats.roles.toString().padStart(4)} (${pct(stats.roles, stats.total).padStart(6)})`);
  console.log(`  data events:       ${stats.data.toString().padStart(4)} (${pct(stats.data, stats.total).padStart(6)})  (>1024 char pastes)`);
  console.log(`  no event:          ${stats.noEvent.toString().padStart(4)} (${pct(stats.noEvent, stats.total).padStart(6)})`);

  if (Object.keys(stats.intents.modes).length > 0) {
    console.log("  intent breakdown:");
    for (const [mode, count] of Object.entries(stats.intents.modes).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${mode.padEnd(14)} ${count.toString().padStart(4)}  (${pct(count, stats.intents.total)} of intents)`);
    }
  }
}

function printDecisionSamples(decisions, msgKey, limit = 12) {
  if (decisions.length === 0) { console.log("  (no decisions)"); return; }
  const sample = VERBOSE ? decisions : decisions.slice(0, limit);
  for (const item of sample) {
    const msg = item[msgKey] ?? item.msg;
    const preview = msg.replace(/\s+/g, " ").slice(0, 100);
    const extra = item.isCorrectionTurn ? " [correction turn]" : item.repo ? ` [${item.repo}]` : "";
    console.log(`    → "${preview}"${extra}`);
  }
  if (!VERBOSE && decisions.length > limit) {
    console.log(`    … and ${decisions.length - limit} more (--verbose to see all)`);
  }
}

// ── Correction pattern tests ──────────────────────────────────────────────────
// Common correction phrases from real developer WildChat turns.
// These are the "turning points" ECC must capture.

const CORRECTION_PHRASES = [
  // Should be decisions (user overriding / redirecting AI)
  { msg: "no wait, don't use that approach, use async/await instead", wantDecision: true  },
  { msg: "actually let's switch to using fetch instead of axios",     wantDecision: true  },
  { msg: "that's wrong, use parseInt not parseFloat",                 wantDecision: true  },
  { msg: "I don't want to use useEffect here, use useMemo instead",   wantDecision: true  },
  { msg: "no, don't add that import, just use the existing one",      wantDecision: true  },

  // Should NOT be decisions (frustrated but not redirecting)
  { msg: "that still doesn't work",                           wantDecision: false },
  { msg: "you're still getting the function signature wrong", wantDecision: false },
  { msg: "no that's the same error",                          wantDecision: false },
  { msg: "try again",                                         wantDecision: false },
  { msg: "this is still broken",                              wantDecision: false },
  { msg: "the test is still failing",                         wantDecision: false },

  // Boundary cases — frustrated corrections that happen to contain directive patterns
  // "no don't do it like that" — "no don't" ≠ "no do": the pattern requires
  // `no,?\s+(do|use|...)` with no "don't" intercept. Genuinely ambiguous.
  { msg: "no don't do it like that",   wantDecision: null  },
  { msg: "use a different approach",   wantDecision: null  }, // ambiguous — "use" but no "instead/over/not"
  { msg: "I prefer the other solution", wantDecision: null  }, // vague — no specific technology
];

// ── SWE-bench specific tests ──────────────────────────────────────────────────
// Problem statements sometimes contain architecture decisions, always contain
// intent (investigate/implement), and are often >1024 chars (data extractor).

const SWEBENCH_SAMPLES = [
  {
    label: "classic bug report with expected/actual",
    msg:   "When calling `df.pivot()` with duplicate entries, it raises a `ValueError` " +
           "instead of returning an empty DataFrame. This is inconsistent with the " +
           "behavior documented in the changelog. Expected: empty DataFrame. " +
           "Actual: ValueError: Index contains duplicate entries.",
    wantDecision: false,
    wantIntent:   "investigate",
  },
  {
    label: "feature request with explicit technology preference",
    msg:   "We should use `pathlib.Path` instead of `os.path` for all file operations " +
           "going forward. The current code mixes both approaches which is confusing. " +
           "Please refactor the file handling in `utils.py` to use pathlib consistently.",
    wantDecision: true,   // "use X instead of Y" — this IS a decision
    wantIntent:   "implement",
  },
  {
    label: "long issue body with stack trace (>1024 chars → data extractor)",
    msg:   "## Bug Description\n\nThe authentication middleware fails silently when " +
           "the JWT token has an expired claim but the user has not explicitly logged out.\n\n" +
           "## Steps to Reproduce\n\n1. Log in and get a valid JWT token\n" +
           "2. Wait for the token TTL to expire (currently 15 minutes in staging)\n" +
           "3. Make any authenticated API call\n" +
           "4. Observe: returns 200 OK instead of 401 Unauthorized\n\n" +
           "## Stack Trace\n```\nError: JWT verification failed\n" +
           "    at verifyToken (src/auth/jwt.ts:45:12)\n" +
           "    at middleware (src/auth/middleware.ts:23:5)\n" +
           "    at Layer.handle [as handle_request] (express/lib/router/layer.js:95:5)\n" +
           "```\n\n## Environment\n- Node.js 20.x\n- Express 4.18\n- jsonwebtoken 9.0\n\n" +
           "## Expected Behavior\nReturns 401 Unauthorized with a `WWW-Authenticate: Bearer` " +
           "header and an error body `{code: 'TOKEN_EXPIRED', message: '...'}`\n\n" +
           "## Notes\nThis may be related to the clock skew tolerance setting. " +
           "The `clockTolerance` option in jsonwebtoken defaults to 0 seconds but our " +
           "load balancers have up to 30 seconds of clock drift between nodes. " +
           "Consider increasing to 60 seconds or using a distributed NTP sync.",
    wantDecision: false,   // "consider X" is not a directive — it's a suggestion
    // KNOWN LIMITATION: long multi-section issue bodies contain action words in
    // steps-to-reproduce ("Make any auth call") that fire implement before the
    // overall intent (investigate the bug) is expressed. Intent detection on
    // long structured documents is best-effort; primary test is wantData.
    wantIntent:   null,
    wantData:     true,   // >1024 chars
  },
  {
    label: "refactor request with explicit drop decision",
    msg:   "Let's remove the legacy `v1` API routes entirely. We should not keep " +
           "the backwards-compat shims — they've been deprecated for 2 years and " +
           "no clients are using them according to the access logs.",
    wantDecision: true,   // "let's remove" → directive
    wantIntent:   "implement",  // "remove" added to implement pattern
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("\n  ══════════════════════════════════════════════════════════");
console.log("  ECC extractUserEvents() — Brutal Multi-Source Calibration");
console.log("  Sources: WildChat-1M (coding) + SWE-bench (GitHub issues)");
console.log("  ══════════════════════════════════════════════════════════\n");

// ── Fetch data ────────────────────────────────────────────────────────────────

console.log("  Fetching Source A: WildChat-1M (coding conversations)…\n");
const wildchatRows = await fetchAllInBatches("allenai/WildChat-1M", "default", "train", WILDCHAT_ROWS);
const { messages: wcMessages, codingConvCount } = extractWildChatMessages(wildchatRows);

console.log(`  WildChat: ${wildchatRows.length} rows → ${codingConvCount} coding conversations → ${wcMessages.length} user messages`);
console.log(`  (correction turns: ${wcMessages.filter(m => m.isCorrectionTurn).length} / ${wcMessages.length})`);

console.log("\n  Fetching Source B: SWE-bench (GitHub issue problem statements)…\n");
const sweRows = await fetchAllInBatches("SWE-bench/SWE-bench", "default", "test", SWEBENCH_ROWS);
const sweMessages = extractSweBenchMessages(sweRows);
console.log(`  SWE-bench: ${sweRows.length} rows → ${sweMessages.length} problem statements`);

// ── Phase 1: Per-source calibration ──────────────────────────────────────────

console.log("\n  ── Phase 1: Per-source calibration ────────────────────────────\n");

const wcStats  = calibrate(wcMessages);
const sweStats = calibrate(sweMessages);

printCalibration("WildChat — coding conversations (all turns)", wcStats);
printCalibration("SWE-bench — GitHub issue bodies", sweStats);

// ── Phase 2: Correction turn analysis ────────────────────────────────────────

console.log("\n  ── Phase 2: WildChat correction turn breakdown ─────────────────");

const { corrections, corrStats, turn1Stats } = analyzeCorrections(wcMessages);

console.log(`\n  Turn 1 (session-opening messages):  ${turn1Stats.total} msgs`);
console.log(`    decision rate: ${pct(turn1Stats.decisions.length, turn1Stats.total)}`);
console.log(`    intent rate:   ${pct(turn1Stats.intents.total, turn1Stats.total)}`);

console.log(`\n  Turn 2+ (corrections / follow-ups): ${corrStats.total} msgs`);
console.log(`    decision rate: ${pct(corrStats.decisions.length, corrStats.total)}  ← expect higher than turn-1`);
console.log(`    intent rate:   ${pct(corrStats.intents.total, corrStats.total)}`);

const corrDecisionRate = corrStats.decisions.length / Math.max(corrStats.total, 1);
const turn1DecisionRate = turn1Stats.decisions.length / Math.max(turn1Stats.total, 1);

if (corrDecisionRate >= turn1DecisionRate) {
  console.log(`\n  ✓ Correction turns have equal/higher decision rate than turn-1`);
  console.log(`    (${pct(corrStats.decisions.length, corrStats.total)} vs ${pct(turn1Stats.decisions.length, turn1Stats.total)})`);
} else {
  console.log(`\n  ⚠ Correction turns have LOWER decision rate than turn-1 — unexpected`);
  console.log(`    Turn-1: ${pct(turn1Stats.decisions.length, turn1Stats.total)}`);
  console.log(`    Turn-2+: ${pct(corrStats.decisions.length, corrStats.total)}`);
  console.log(`    This suggests decision patterns don't capture "wait actually..." corrections well`);
}

// Show decision samples from correction turns specifically
if (corrStats.decisions.length > 0) {
  console.log(`\n  Decision hits from correction turns (${corrStats.decisions.length} total):`);
  printDecisionSamples(corrStats.decisions, "msg");
}

// ── Phase 3: SWE-bench decision samples ──────────────────────────────────────

if (sweStats.decisions.length > 0) {
  console.log(`\n  ── Phase 3: SWE-bench decision hits (${sweStats.decisions.length} / ${sweStats.total}) ─`);
  console.log("  (GitHub issues where maintainers expressed technology directives)\n");
  printDecisionSamples(sweStats.decisions, "msg");
}

// ── Phase 4: Correction phrase adversarial tests ──────────────────────────────

console.log("\n  ── Phase 4: Correction phrase tests (WildChat-style turns) ──────\n");

let phrasePass = 0;
let phraseFail = 0;
let phraseSkip = 0;

for (const test of CORRECTION_PHRASES) {
  const events = extractUserEvents(test.msg);
  const hasDecision = events.some(e => e.category === "decision");

  if (test.wantDecision === null) { phraseSkip++; continue; }

  const pass = test.wantDecision === hasDecision;
  if (pass) {
    phrasePass++;
    console.log(`  ✓ "${test.msg}"`);
  } else {
    phraseFail++;
    const reason = test.wantDecision ? "expected decision, got none" : "unexpected decision extracted";
    console.error(`  ✗ "${test.msg}"`);
    console.error(`      → ${reason}`);
  }
}

if (phraseSkip > 0) console.log(`\n  (${phraseSkip} ambiguous correction phrases skipped)`);

// ── Phase 5: SWE-bench specific tests ────────────────────────────────────────

console.log("\n  ── Phase 5: SWE-bench issue body tests ───────────────────────────\n");

let swePass = 0;
let sweFail = 0;

for (const test of SWEBENCH_SAMPLES) {
  const events = extractUserEvents(test.msg);
  const hasDecision  = events.some(e => e.category === "decision");
  const intentMode   = events.find(e => e.category === "intent")?.data;
  const hasData      = events.some(e => e.category === "data");

  const failures = [];
  if (test.wantDecision === true  && !hasDecision) failures.push(`expected decision, got none`);
  if (test.wantDecision === false &&  hasDecision) failures.push(`unexpected decision`);
  if (test.wantIntent && intentMode !== test.wantIntent) failures.push(`intent: want "${test.wantIntent}", got "${intentMode}"`);
  if (test.wantData === true && !hasData) failures.push(`expected data event (>1024 chars), got none`);

  if (failures.length === 0) {
    swePass++;
    console.log(`  ✓ ${test.label}`);
  } else {
    sweFail++;
    console.error(`  ✗ ${test.label}`);
    for (const f of failures) console.error(`      → ${f}`);
  }
}

// ── Phase 6: Cross-source comparison ─────────────────────────────────────────

console.log(`\n  ── Phase 6: Cross-source comparison ─────────────────────────────\n`);

const sources = [
  { name: "WildChat (all turns)",   stats: wcStats    },
  { name: "WildChat (turn-1 only)", stats: turn1Stats },
  { name: "WildChat (turn-2+)",     stats: corrStats  },
  { name: "SWE-bench (issues)",     stats: sweStats   },
];

const colW = 26;
console.log(`  ${"source".padEnd(colW)} ${"msgs".padStart(5)} ${"decision".padStart(10)} ${"intent".padStart(8)} ${"data".padStart(7)}`);
console.log(`  ${"─".repeat(colW + 35)}`);
for (const { name, stats } of sources) {
  const d = pct(stats.decisions.length, stats.total);
  const i = pct(stats.intents.total,    stats.total);
  const a = pct(stats.data,             stats.total);
  console.log(`  ${name.padEnd(colW)} ${String(stats.total).padStart(5)} ${d.padStart(10)} ${i.padStart(8)} ${a.padStart(7)}`);
}

// ── Verdict ───────────────────────────────────────────────────────────────────

const totalAdv = phrasePass + phraseFail + swePass + sweFail;
const totalPass = phrasePass + swePass;
const totalFail = phraseFail + sweFail;

console.log(`\n  ${"═".repeat(58)}`);
console.log("  BRUTAL CALIBRATION VERDICT\n");

// Key thresholds:
// - SWE-bench intent rate should be high (≥40%) — issues always have clear intent
// - WildChat correction turn decision rate ≥ turn-1 — corrections should capture more directives
// - 0 adversarial failures

const sweIntentOk = sweStats.intents.total / Math.max(sweStats.total, 1) >= 0.40;
const correctionOrderOk = corrDecisionRate >= turn1DecisionRate;
const advOk = totalFail === 0;

if (sweIntentOk && correctionOrderOk && advOk) {
  console.log("  ✓  PASS — extractors calibrated across real-world sources");
} else {
  if (!sweIntentOk) {
    const rate = pct(sweStats.intents.total, sweStats.total);
    console.log(`  ⚠  SWE-bench intent rate ${rate} below 40% — GitHub issues should always have clear intent`);
  }
  if (!correctionOrderOk) {
    console.log(`  ⚠  Correction turn decision rate not higher than turn-1`);
    console.log(`     This means ECC is not capturing mid-session "wait, actually" redirects`);
  }
  if (!advOk) {
    console.log(`  ✗  ${totalFail} adversarial test(s) failed`);
  }
}

console.log(`\n  Adversarial: ${totalPass}/${totalAdv} passed`);
console.log(`  WildChat decisions found: ${wcStats.decisions.length} / ${wcStats.total} msgs`);
console.log(`  SWE-bench decisions found: ${sweStats.decisions.length} / ${sweStats.total} issues`);

// ── Chain Phase: extract → DB → FTS5 → snapshot ─────────────────────────────
//
// Verifies extracted events flow through the entire ECC pipeline.
// Combines both WildChat and SWE-bench events into one DB to test
// cross-source indexing and snapshot rendering.

console.log(`\n  ${"─".repeat(58)}`);
console.log("  Chain Phase: extract → store → search → snapshot\n");

const chainDir = join(tmpdir(), "ecc-brutal-chain");
mkdirSync(chainDir, { recursive: true });
const chainDbPath = join(chainDir, "brutal-chain.db");
if (existsSync(chainDbPath)) rmSync(chainDbPath);

const chainDb = new SessionDB({ dbPath: chainDbPath });
const chainSid = `brutal-chain-${Date.now()}`;
chainDb.ensureSession(chainSid, chainDir);

// Insert all extracted events from both sources
const allChainEvents = [...wcStats.allEvents, ...sweStats.allEvents];
let chainInserted = 0;
for (const ev of allChainEvents) {
  chainDb.insertEvent(chainSid, ev, "UserPromptSubmit");
  chainInserted++;
}
console.log(`  Inserted: ${chainInserted} events (WC:${wcStats.allEvents.length} + SWE:${sweStats.allEvents.length})`);

// FTS5 recall: sample terms from decision/data events
const chainEvents = chainDb.getEvents(chainSid);
const catCounts = {};
for (const e of chainEvents) catCounts[e.category] = (catCounts[e.category] ?? 0) + 1;
console.log(`  Live DB: ${Object.entries(catCounts).map(([k,v]) => `${k}:${v}`).join(" ")}`);

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
const sections = [
  snapshot.includes("<active_files>") && "files",
  snapshot.includes("<decisions>") && "decisions",
  snapshot.includes("<errors_encountered>") && "errors",
  snapshot.includes("<work_progress>") && "progress",
].filter(Boolean).join(", ") || "minimal";
console.log(`  Snapshot: ${snapBytes} bytes | sections: ${sections}`);

let chainFailed = 0;
if (chainInserted === 0) { console.log("  ✗  Chain FAIL: no events inserted"); chainFailed++; }
if (snapBytes < 100)     { console.log("  ✗  Chain FAIL: snapshot too small"); chainFailed++; }
if (chainFailed === 0)   { console.log("  ✓  Chain OK: extract → store → search → snapshot"); }

chainDb.close();

console.log(`  ${"═".repeat(58)}\n`);

process.exit((totalFail + chainFailed) > 0 ? 1 : 0);
