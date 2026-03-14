/**
 * test-lifecycle-real.mjs — Unrigged 100-cycle real-data lifecycle test.
 *
 * This is an observation test, not an assertion test.
 *
 * PHILOSOPHY:
 *   The lifetime retention test plants facts at P1 priority and checks if
 *   they survive. That validates ECC's design decisions, not ECC's real
 *   performance. This test does the opposite: feed real conversations through
 *   the full pipeline and observe what ECC actually retains — without
 *   pre-labeling what "should" survive.
 *
 * DATA SOURCES:
 *   - WildChat-1M: real ChatGPT coding conversation logs (messy, multi-turn,
 *     includes "wait that didn't work" and mid-session corrections)
 *   - SWE-bench: real GitHub issue bodies (technical problem descriptions,
 *     feature requests with architecture opinions, bug reports with stack traces)
 *
 * REPETITION:
 *   Conversations are drawn from the pool WITH REPLACEMENT. This is intentional
 *   — real users revisit the same topics. The dedup window should handle natural
 *   repetition without flooding the DB. At cycles 20/40/60/80 we explicitly
 *   re-inject a past conversation to simulate a user saying "let's revisit this."
 *
 * WHAT WE OBSERVE (no planted anchors):
 *   - FTS5 recall rate: at each checkpoint, pick random past conversations and
 *     query FTS5 for their key terms. Did ECC retain them?
 *   - Snapshot composition: what categories dominate after real eviction pressure?
 *   - Dedup effectiveness: do revisited conversations inflate event counts?
 *   - Eviction onset: at which cycle does FIFO start dropping real events?
 *
 * ONLY ASSERTION:
 *   ECC must produce a non-empty valid snapshot after 100 cycles. Everything
 *   else is reported as calibration data.
 *
 * Run via: node benchmark/test-lifecycle-real.mjs
 * Options: --quick (50 cycles), --verbose (show FTS5 hit details)
 * Depends on: build/ (compiled), HuggingFace Datasets Server API
 */

import { join }                         from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir }                        from "node:os";
import { pathToFileURL }                 from "node:url";

const BUILD   = join(process.cwd(), "build");
const QUICK   = process.argv.includes("--quick");
const VERBOSE = process.argv.includes("--verbose");

// ── Config ────────────────────────────────────────────────────────────────────

const TOTAL_CYCLES     = 100;
const CHECKPOINTS      = [25, 50, 75, 100];
const REVISIT_CYCLES   = [20, 40, 60, 80];
const ITEMS_PER_CYCLE  = 20;        // messages drawn per cycle (with replacement)
const RECALL_SAMPLES   = 5;         // past conversations queried at each checkpoint
const FETCH_TIMEOUT    = 15_000;

// WildChat rows to fetch (coding convs ≈ 25%, so 400 rows ≈ 100 coding convs)
const WILDCHAT_FETCH   = QUICK ? 300 : 500;
const SWEBENCH_FETCH   = QUICK ?  60 : 100;

// Coding conversation filter — applied to the first user message
const CODING_RE = /\b(code|function|class|bug|error|exception|fix|script|python|javascript|typescript|java|golang|rust|sql|api|database|npm|pip|git|docker|refactor|async|await|hook|component|module|query|schema|endpoint|middleware|auth|token|cache|redis|postgres|mongo|mysql|error|exception|stack|trace|compile|build|lint|test)\b/i;

// Stop words for key term extraction — broad list to find distinctive terms
const STOP = new Set("the a an is it in on at to for of and or with that this be are was were have has do does can could should would will may might i we you he she they my your our its not no but if when how what which who where from by as use used using also just like more some than then there these those been had into over after before about each every here need want make take back down still any other both few most such able according allow among another based call called change changed different does done each example file files following found get getting given go going got had help holds however include including its keep large later let line list look many method methods might multiple must name named names need needs never next note object objects option options order part parts pass passed path paths place point points possible print property provide put raise raised read remove removed returns run running set sets show shown simple single size specify specific standard start started state states stop string take takes test tests them thing things through true try type types update updated updates value values var version via view write written one two three four five six seven eight nine zero new old good first last long own right same here there from than then when just were been have this that with some what about which also could would should must will their there been about into from with more some what about which also well only just like back down still".split(" "));

// ── Key term extraction ───────────────────────────────────────────────────────

/**
 * Extract the most distinctive terms from a message for FTS5 recall queries.
 * Uses word length as a proxy for distinctiveness — longer words are rarer
 * and more likely to uniquely identify a conversation.
 */
function keyTerms(msg) {
  const tokens = (msg.match(/\b[a-zA-Z][a-zA-Z0-9]{3,}\b/g) ?? [])
    .filter(t => !STOP.has(t.toLowerCase()))
    .filter(t => t.length >= 5);

  // Deduplicate, sort by length (longer = more distinctive), take top 4
  return [...new Set(tokens.map(t => t.toLowerCase()))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
}

// ── HuggingFace fetch ─────────────────────────────────────────────────────────

async function fetchBatch(dataset, config, split, offset, length) {
  const url = `https://datasets-server.huggingface.co/rows` +
    `?dataset=${encodeURIComponent(dataset)}&config=${config}` +
    `&split=${split}&offset=${offset}&length=${length}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).rows?.map(r => r.row) ?? [];
  } catch (err) {
    process.stderr.write(`  ⚠  fetch failed (offset=${offset}): ${err.message}\n`);
    return [];
  }
}

async function fetchAll(dataset, config, split, total) {
  const rows = [];
  const batches = Math.ceil(total / 100);
  for (let i = 0; i < batches; i++) {
    process.stdout.write(`\r    ${dataset.split("/")[1]} batch ${i + 1}/${batches}…`);
    rows.push(...await fetchBatch(dataset, config, split, i * 100, 100));
  }
  process.stdout.write(`\r    done (${rows.length} rows)                    \n`);
  return rows;
}

// ── PostToolUse event synthesis ───────────────────────────────────────────────
//
// extractUserEvents() only produces intent/data/role — never file/checkpoint/error.
// Those come from the PostToolUse hook (file edits, bash runs, tool errors).
// Without them the snapshot stays empty: no active_files, no work_progress, no errors.
//
// Fix: synthesize plausible PostToolUse events from the real message content.
// Not invented — derived from what the message implies:
//   - SWE-bench has an actual `patch` field → exact files changed (most grounded)
//   - WildChat messages mention file paths and error types in plain text → extract them
//   - Intent mode (from extractUserEvents) determines which tool events make sense

/** Extract file paths mentioned anywhere in a message. */
function extractFilePaths(msg) {
  const matches = msg.match(
    /\b[\w/.\-]+\.(py|js|ts|tsx|jsx|java|go|rs|rb|cpp|c|h|sql|yaml|yml|json|md|sh)\b/gi
  ) ?? [];
  return [...new Set(matches)].slice(0, 4);
}

/** Extract error type names mentioned in a message. */
function extractErrorMentions(msg) {
  const matches = msg.match(
    /\b(TypeError|ValueError|AttributeError|RuntimeError|ImportError|KeyError|IndexError|NameError|OSError|IOError|SyntaxError|AssertionError|Exception|Error)\b[^\n.]{0,80}/g
  ) ?? [];
  return matches.map(m => m.trim()).slice(0, 2);
}

/** Extract changed file paths from a unified diff patch (SWE-bench `patch` field). */
function extractPatchFiles(patch) {
  const matches = patch.match(/^(?:---|\+\+\+) [ab]\/(.*)/gm) ?? [];
  return [...new Set(
    matches.map(m => m.replace(/^(?:---|\+\+\+) [ab]\//, "").trim())
  )].filter(f => !f.startsWith("/dev/null")).slice(0, 4);
}

/**
 * Synthesize PostToolUse-style session events from real message content.
 *
 * These events represent what ECC would have captured from the tool calls
 * that naturally accompany the conversation — file edits when implementing,
 * error events when debugging, build checkpoints when testing.
 *
 * Derivation rules (not invented, derived from content):
 *   implement → file_edit for each mentioned/patched file + checkpoint_build
 *   investigate → file_read for each mentioned file + error_tool if error mentioned
 *   review → file_read + checkpoint_test
 *   discuss → file_read if any file mentioned
 *   any → error_tool if error type explicitly mentioned in message
 *
 * @param {string}   msg         - Source message text
 * @param {Array}    userEvents  - Already-extracted user events (for intent mode)
 * @param {object}   meta        - Optional metadata: { patch, repo } from SWE-bench
 */
function synthesizeToolEvents(msg, userEvents, meta = {}) {
  const events     = [];
  const intentMode = userEvents.find(e => e.category === "intent")?.data;
  const errors     = extractErrorMentions(msg);

  // SWE-bench: use actual patch files if available (most grounded)
  // WildChat: extract file paths from message text
  const patchFiles = meta.patch ? extractPatchFiles(meta.patch) : [];
  const textFiles  = extractFilePaths(msg);
  const files      = patchFiles.length > 0 ? patchFiles : textFiles;

  // Fallback file path — repo-derived for SWE-bench, generic for WildChat
  const fallbackFile = meta.repo
    ? `${meta.repo.split("/")[1] ?? "src"}/main.py`
    : "src/main.ts";

  switch (intentMode) {
    case "implement": {
      // File edits — use real files from patch/message, fallback if none
      const editTargets = files.length > 0 ? files : [fallbackFile];
      for (const f of editTargets.slice(0, 3)) {
        events.push({ type: "file_edit", category: "file", priority: 1, data: f });
      }
      // Build checkpoint — implementing implies a build/test run followed
      const buildOk = errors.length === 0; // if errors mentioned, build likely failed
      events.push({
        type: "checkpoint_build", category: "checkpoint", priority: 1,
        data: `build: ${buildOk ? "SUCCESS" : "FAILED"} — npm run build`,
      });
      break;
    }
    case "investigate": {
      const readTargets = files.length > 0 ? files : [fallbackFile];
      for (const f of readTargets.slice(0, 2)) {
        events.push({ type: "file_read", category: "file", priority: 2, data: f });
      }
      if (errors.length > 0) {
        events.push({ type: "error_tool", category: "error", priority: 2, data: errors[0] });
      }
      break;
    }
    case "review": {
      const readTargets = files.length > 0 ? files : [fallbackFile];
      for (const f of readTargets.slice(0, 2)) {
        events.push({ type: "file_read", category: "file", priority: 2, data: f });
      }
      events.push({
        type: "checkpoint_test", category: "checkpoint", priority: 1,
        data: "test run: PASSED — npm test",
      });
      break;
    }
    case "discuss": {
      if (files.length > 0) {
        events.push({ type: "file_read", category: "file", priority: 1, data: files[0] });
      }
      break;
    }
  }

  // Always add error_tool if explicit error type mentioned (regardless of intent)
  if (errors.length > 0 && intentMode !== "investigate") {
    events.push({ type: "error_tool", category: "error", priority: 2, data: errors[0] });
  }

  return events;
}

// ── Pool construction ─────────────────────────────────────────────────────────

/**
 * A pool item represents one real conversation turn plus its implied tool events:
 *   - sourceMsg:  the original message text
 *   - userEvents: from extractUserEvents() — intent, data, role
 *   - toolEvents: synthesized from content — file, checkpoint, error
 *   - allEvents:  combined (what gets inserted into the DB)
 *   - terms:      key terms for FTS5 recall testing
 *   - source:     "wildchat" or "swebench"
 */
function buildPool(extractFn, wildchatRows, sweRows) {
  const pool = [];

  // WildChat: extract user turns from coding conversations only
  for (const row of wildchatRows) {
    if (row.language !== "English" && row.language !== "english") continue;
    const conv = row.conversation ?? [];
    const firstUser = conv.find(t => t.role === "user")?.content ?? "";
    if (!CODING_RE.test(firstUser)) continue;

    for (const turn of conv) {
      if (turn.role !== "user") continue;
      const msg = String(turn.content ?? "").trim();
      if (!msg || msg.length < 20) continue;

      const userEvents = extractFn(msg);
      const toolEvents = synthesizeToolEvents(msg, userEvents);
      const allEvents  = [...userEvents, ...toolEvents];
      const terms      = keyTerms(msg);
      if (terms.length === 0) continue;

      pool.push({ sourceMsg: msg, userEvents, toolEvents, allEvents, terms, source: "wildchat" });
    }
  }

  // SWE-bench: each problem statement + patch data as a pool item
  for (const row of sweRows) {
    const msg = String(row.problem_statement ?? "").trim();
    if (!msg || msg.length < 50) continue;

    const meta       = { patch: row.patch ?? "", repo: row.repo ?? "" };
    const userEvents = extractFn(msg);
    const toolEvents = synthesizeToolEvents(msg, userEvents, meta);
    const allEvents  = [...userEvents, ...toolEvents];
    const terms      = keyTerms(msg);
    if (terms.length === 0) continue;

    pool.push({ sourceMsg: msg, userEvents, toolEvents, allEvents, terms, source: "swebench", meta });
  }

  return pool;
}

// ── FTS5 recall check ─────────────────────────────────────────────────────────

/**
 * Query FTS5 for a pool item's key terms and check if any hit.
 * Returns {found, term, hitCount, hitCategory}.
 * "found" means at least one term matched at least one live event.
 */
function checkRecall(db, item) {
  for (const term of item.terms) {
    try {
      const hits = db.searchEvents(term, 10);
      if (hits.length > 0) {
        // Attribution: determine if the hit comes from live, archive, or both
        let source = "live";
        try {
          const liveHit = db.db.prepare(
            `SELECT 1 FROM session_events WHERE data LIKE ? LIMIT 1`
          ).get(`%${term}%`);
          const archiveHit = db.db.prepare(
            `SELECT 1 FROM session_events_archive WHERE data LIKE ? LIMIT 1`
          ).get(`%${term}%`);
          if (liveHit && archiveHit) source = "both";
          else if (archiveHit)       source = "archive";
          else                       source = "live";
        } catch { /* archive table may not exist */ }

        return {
          found:       true,
          term,
          hitCount:    hits.length,
          hitCategory: hits[0].category,
          source,
        };
      }
    } catch { /* FTS5 query error — term had special chars */ }
  }
  return { found: false, term: item.terms[0] ?? "?", hitCount: 0, hitCategory: null, source: "none" };
}

// ── Snapshot analyzer ─────────────────────────────────────────────────────────

/**
 * Build snapshot and extract simple section-level metrics.
 * No pass/fail — just measures what's in the XML.
 */
function analyzeSnapshot(buildFn, events, compactCount) {
  const xml = buildFn(events, { compactCount });
  const sections = {
    active_files:       (xml.match(/<file /g)        ?? []).length,
    decisions:          (xml.match(/<decision>/g)     ?? []).length,
    errors:             (xml.match(/<error>/g)        ?? []).length,
    work_progress:      (xml.match(/<checkpoint>/g)   ?? []).length,
    tasks_pending:      (xml.match(/^  - /mg)         ?? []).length,
    bytes:              Buffer.byteLength(xml),
    hasTaskState:       xml.includes("<task_state>"),
    hasActiveFiles:     xml.includes("<active_files>"),
    hasDecisions:       xml.includes("<decisions>"),
    hasErrors:          xml.includes("<errors_encountered>"),
    hasWorkProgress:    xml.includes("<work_progress>"),
  };
  return { xml, sections };
}

// ── Random picker ─────────────────────────────────────────────────────────────

function pickRandom(arr, n, rng) {
  const result = [];
  for (let i = 0; i < n && arr.length > 0; i++) {
    result.push(arr[Math.floor(rng() * arr.length)]);
  }
  return result;
}

// Simple seeded PRNG for reproducible results
function makePrng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("\n  ══════════════════════════════════════════════════════════════");
console.log(`  ECC Lifecycle Test — ${TOTAL_CYCLES} cycles, real-world data, unrigged`);
console.log("  Sources: WildChat-1M (coding) + SWE-bench (GitHub issues)");
console.log("  ══════════════════════════════════════════════════════════════\n");

// ── Load modules ──────────────────────────────────────────────────────────────

const { SessionDB }          = await import(pathToFileURL(join(BUILD, "session", "db.js")).href);
const { buildResumeSnapshot } = await import(pathToFileURL(join(BUILD, "session", "snapshot.js")).href);
const { extractUserEvents }  = await import(pathToFileURL(join(BUILD, "session", "extract.js")).href);

// ── DB setup ──────────────────────────────────────────────────────────────────

const dbDir = join(tmpdir(), "ecc-lifecycle-real-bench");
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, "lifecycle.db");
if (existsSync(dbPath)) rmSync(dbPath);

const db        = new SessionDB({ dbPath });
const sessionId = `real-lifecycle-${Date.now()}`;
const projectDir = dbDir;
db.ensureSession(sessionId, projectDir);

// ── Fetch data ────────────────────────────────────────────────────────────────

console.log("  Phase 1: Fetching real conversation data…\n");

const wildchatRows = await fetchAll("allenai/WildChat-1M",  "default", "train", WILDCHAT_FETCH);
const sweRows      = await fetchAll("SWE-bench/SWE-bench",  "default", "test",  SWEBENCH_FETCH);

const pool = buildPool(extractUserEvents, wildchatRows, sweRows);

const wcItems  = pool.filter(p => p.source === "wildchat");
const sweItems = pool.filter(p => p.source === "swebench");

console.log(`\n  Pool built:`);
console.log(`    WildChat items: ${wcItems.length}  (from ${wildchatRows.length} rows)`);
console.log(`    SWE-bench items: ${sweItems.length}  (from ${sweRows.length} rows)`);
console.log(`    Total pool size: ${pool.length}`);
const totalUserEv = pool.reduce((s, p) => s + p.userEvents.length, 0);
const totalToolEv = pool.reduce((s, p) => s + p.toolEvents.length, 0);
console.log(`    User events (intent/data/role):              ${totalUserEv}`);
console.log(`    Tool events (file/checkpoint/error synth'd): ${totalToolEv}`);
console.log(`    Total events in pool: ${totalUserEv + totalToolEv}`);
console.log(`    Avg events per item: ${((totalUserEv + totalToolEv) / Math.max(pool.length, 1)).toFixed(2)}`);

if (pool.length < 20) {
  console.error("\n  ✗  Pool too small to run test (API may be unavailable). Exiting.");
  process.exit(1);
}

// ── Cycle loop ────────────────────────────────────────────────────────────────

console.log(`\n  Phase 2: Running ${TOTAL_CYCLES} cycles…\n`);

const rng = makePrng(0xDEADBEEF);

// Track which pool items were used and when — for recall testing
const usedHistory = [];   // [{cycle, item}]
const recallLog   = [];   // [{checkpoint, item, found, term, hitCount, honest}]

// Track the most recent cycle each item was inserted — used to filter
// out recently re-inserted items from recall sampling.  Without this,
// FTS5 recall is inflated: a "hit" might just mean the item was re-drawn
// from the pool recently, not that it survived eviction.
const lastInsertedCycle = new Map();  // item → cycle number
const MIN_RECALL_AGE = 10;  // must not have been re-inserted within this many cycles

// Snapshot and event count tracking across cycles
const cycleMetrics = [];  // [{cycle, eventCount, evictionFired}]

let totalInserted = 0;
let revisitCount  = 0;

for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
  const isCheckpoint = CHECKPOINTS.includes(cycle);
  const isRevisit    = REVISIT_CYCLES.includes(cycle);

  // Draw items for this cycle (with replacement)
  const drawn = pickRandom(pool, ITEMS_PER_CYCLE, rng);

  // If this is a revisit cycle, replace one draw with a random past item
  if (isRevisit && usedHistory.length > 0) {
    const past = usedHistory[Math.floor(rng() * usedHistory.length)];
    drawn[0] = past.item;
    revisitCount++;
  }

  // Insert all events from drawn items (user events + synthesized tool events)
  let insertedThisCycle = 0;
  for (const item of drawn) {
    for (const event of item.allEvents) {
      db.insertEvent(sessionId, event, "UserPromptSubmit");
      insertedThisCycle++;
    }
    usedHistory.push({ cycle, item });
    lastInsertedCycle.set(item, cycle);
  }
  totalInserted += insertedThisCycle;

  // Track DB state
  const stats       = db.getSessionStats(sessionId);
  const eventCount  = stats?.event_count ?? 0;
  const prevCount   = cycleMetrics.length > 0 ? cycleMetrics[cycleMetrics.length - 1].eventCount : 0;
  const evictionFired = eventCount < prevCount + insertedThisCycle;

  cycleMetrics.push({ cycle, eventCount, evictionFired, insertedThisCycle });

  if (!isCheckpoint) continue;

  // ── Checkpoint ──────────────────────────────────────────────────────────────

  console.log(`  ── Checkpoint: cycle ${cycle} ─────────────────────────────────`);
  console.log(`  DB event count: ${eventCount} | Total inserted: ${totalInserted}`);

  // Count how many cycles triggered eviction
  const evictionsSoFar = cycleMetrics.filter(m => m.evictionFired).length;
  const firstEviction  = cycleMetrics.find(m => m.evictionFired)?.cycle ?? "none yet";
  console.log(`  Evictions so far: ${evictionsSoFar} cycles | First at cycle: ${firstEviction}`);

  // FTS5 recall — honest sampling: only test items that have NOT been
  // re-inserted within the last MIN_RECALL_AGE cycles.  If an item was
  // re-drawn recently, a FTS5 hit proves nothing about retention.
  const eligible = usedHistory.filter(h => {
    const lastCyc = lastInsertedCycle.get(h.item) ?? h.cycle;
    return (cycle - lastCyc) >= MIN_RECALL_AGE;
  });

  const sampleItems = [];
  if (eligible.length > 0) {
    const eq = Math.max(1, Math.floor(eligible.length / RECALL_SAMPLES));
    for (let i = 0; i < RECALL_SAMPLES && i < eligible.length; i++) {
      const idx = Math.min(Math.floor(i * eq + rng() * eq), eligible.length - 1);
      sampleItems.push(eligible[idx].item);
    }
  }

  let recalled = 0;
  for (const item of sampleItems) {
    const result = checkRecall(db, item);
    recallLog.push({ checkpoint: cycle, item, ...result, honest: true });
    if (result.found) recalled++;
    if (VERBOSE) {
      const preview = item.sourceMsg.replace(/\s+/g, " ").slice(0, 60);
      const age     = cycle - (lastInsertedCycle.get(item) ?? 0);
      const srcTag  = result.found ? ` src=${result.source}` : "";
      const status  = result.found ? `✓ [${result.term}/${result.hitCategory}]` : `✗ [${result.term}]`;
      console.log(`    ${status} age=${age}${srcTag} "${preview}"`);
    }
  }

  const sampleCount = sampleItems.length;
  const recallPct   = sampleCount > 0 ? ((recalled / sampleCount) * 100).toFixed(0) : "—";
  console.log(`  FTS5 recall: ${recalled}/${sampleCount} (${recallPct}%) — honest (not re-inserted in ${MIN_RECALL_AGE}+ cycles)`);

  // Source attribution — where did the recalls come from?
  const cpRecalls = recallLog.filter(r => r.checkpoint === cycle && r.found);
  const fromLive    = cpRecalls.filter(r => r.source === "live").length;
  const fromArchive = cpRecalls.filter(r => r.source === "archive").length;
  const fromBoth    = cpRecalls.filter(r => r.source === "both").length;
  if (cpRecalls.length > 0) {
    console.log(`  FTS5 source: live=${fromLive} archive=${fromArchive} both=${fromBoth}`);
  }

  if (eligible.length < RECALL_SAMPLES) {
    console.log(`  ⚠  Only ${eligible.length} eligible items (most were recently re-inserted)`);
  }

  // Archive stats
  try {
    const archiveRow = db.db.prepare(
      "SELECT COUNT(*) AS cnt FROM session_events_archive WHERE session_id = ?"
    ).get(sessionId);
    console.log(`  Archive: ${archiveRow?.cnt ?? 0} events preserved`);
  } catch { /* archive table may not exist */ }

  // Snapshot analysis
  const liveEvents       = db.getEvents(sessionId);
  const compactCount     = cycleMetrics.filter(m => m.evictionFired).length;
  const { xml, sections } = analyzeSnapshot(buildResumeSnapshot, liveEvents, compactCount);

  const categoryCounts = {};
  for (const e of liveEvents) categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;
  const catSummary = Object.entries(categoryCounts).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`  Snapshot: ${sections.bytes} bytes | active_files:${sections.active_files} decisions:${sections.decisions} progress:${sections.work_progress}`);
  console.log(`  Sections: ${[sections.hasActiveFiles && "files", sections.hasDecisions && "decisions", sections.hasErrors && "errors", sections.hasWorkProgress && "progress", sections.hasTaskState && "tasks"].filter(Boolean).join(" ") || "minimal"}`);
  console.log(`  Live DB categories: ${catSummary}`);
  console.log();

  db.incrementCompactCount(sessionId);
}

// ── Final analysis ────────────────────────────────────────────────────────────

console.log("  ── Final analysis ────────────────────────────────────────────────\n");

// Recall rate by checkpoint
console.log("  FTS5 recall by checkpoint:");
for (const cp of CHECKPOINTS) {
  const entries  = recallLog.filter(r => r.checkpoint === cp);
  const found    = entries.filter(r => r.found).length;
  const total    = entries.length;
  const bar      = "█".repeat(found) + "░".repeat(total - found);
  console.log(`    cycle ${String(cp).padStart(3)}: ${bar}  ${found}/${total} (${total === 0 ? "—" : ((found / total) * 100).toFixed(0) + "%"})`);
}

// Recall rate by source
const wcRecall  = recallLog.filter(r => r.item.source === "wildchat");
const sweRecall = recallLog.filter(r => r.item.source === "swebench");
const wcFound   = wcRecall.filter(r => r.found).length;
const sweFound  = sweRecall.filter(r => r.found).length;

console.log(`\n  Recall by source:`);
console.log(`    WildChat:  ${wcFound}/${wcRecall.length}  (${wcRecall.length === 0 ? "—" : ((wcFound / wcRecall.length) * 100).toFixed(0) + "%"})`);
console.log(`    SWE-bench: ${sweFound}/${sweRecall.length}  (${sweRecall.length === 0 ? "—" : ((sweFound / sweRecall.length) * 100).toFixed(0) + "%"})`);

// Eviction profile
const firstEviction = cycleMetrics.find(m => m.evictionFired)?.cycle;
const totalEvictions = cycleMetrics.filter(m => m.evictionFired).length;
console.log(`\n  Eviction profile:`);
console.log(`    First eviction at cycle: ${firstEviction ?? "never"}`);
console.log(`    Total cycles with eviction: ${totalEvictions} / ${TOTAL_CYCLES}`);
console.log(`    Total events inserted: ${totalInserted}`);
console.log(`    Final DB event count: ${cycleMetrics[cycleMetrics.length - 1]?.eventCount ?? "?"}`);

// Revisit dedup
const revisitItems = usedHistory.filter((_, i, arr) =>
  arr.slice(0, i).some(prev => prev.item === arr[i].item));
console.log(`\n  Revisit/dedup behavior:`);
console.log(`    Explicit revisit cycles: ${revisitCount}`);
console.log(`    Natural repetitions (same item drawn multiple times): ${revisitItems.length}`);

// Final snapshot
const finalEvents     = db.getEvents(sessionId);
const { xml: finalXml, sections: finalSections } =
  analyzeSnapshot(buildResumeSnapshot, finalEvents, totalEvictions);

console.log(`\n  Final snapshot (cycle ${TOTAL_CYCLES}):`);
console.log(`    Size: ${finalSections.bytes} bytes`);
console.log(`    Active files: ${finalSections.active_files}`);
console.log(`    Decisions: ${finalSections.decisions}`);
console.log(`    Work progress entries: ${finalSections.work_progress}`);
console.log(`    Categories in live DB: ${[...new Set(finalEvents.map(e => e.category))].join(", ")}`);

// Missed recalls — what terms consistently failed?
const missedTerms = recallLog.filter(r => !r.found).map(r => r.term);
const termFreq = {};
for (const t of missedTerms) termFreq[t] = (termFreq[t] ?? 0) + 1;
const topMissed = Object.entries(termFreq).sort((a, b) => b[1] - a[1]).slice(0, 5);
if (topMissed.length > 0) {
  console.log(`\n  Terms that failed recall most often (evicted or never extracted):`);
  for (const [term, count] of topMissed) {
    console.log(`    "${term}" — missed ${count}x`);
  }
}

// ── Single assertion ──────────────────────────────────────────────────────────

console.log(`\n  ${"═".repeat(62)}`);
const snapshotValid = finalXml.includes("<session_resume") && finalXml.includes("</session_resume>");
if (snapshotValid) {
  console.log(`  ✓  PASS — ECC produced a valid snapshot after ${TOTAL_CYCLES} real-data cycles`);
} else {
  console.error(`  ✗  FAIL — snapshot invalid after ${TOTAL_CYCLES} cycles`);
}
console.log(`\n  This is an observation test. The numbers above describe ECC's`);
console.log(`  real retention behaviour — not whether it passed designed checks.`);
console.log(`  ${"═".repeat(62)}\n`);

process.exit(snapshotValid ? 0 : 1);
