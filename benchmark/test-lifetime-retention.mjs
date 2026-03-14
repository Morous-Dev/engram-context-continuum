/**
 * test-lifetime-retention.mjs — Lifetime retention stress test (real-data pipeline).
 *
 * Responsible for: validating that facts captured in the earliest compaction
 * cycles survive through 25, 50, 75, and 100 total cycles — where each cycle
 * represents ~80K–160K tokens of real conversation.
 *
 * DATA PIPELINE (same as test-lifecycle-real.mjs):
 *   WildChat-1M + SWE-bench → extractUserEvents() → synthesizeToolEvents()
 *   → SessionDB (FIFO cap 1000) → FTS5 + snapshot retention check
 *
 * DYNAMIC ANCHORS (replaces synthetic AF1-AF8):
 *   After cycles 1–ANCHOR_CYCLES, we collect the most-frequently-occurring
 *   distinctive terms from events actually stored in the DB. These become
 *   the anchor terms — facts ECC really captured. We then measure whether
 *   those terms survive in FTS5 and the snapshot XML at each later checkpoint.
 *
 * This makes the retention number honest end-to-end:
 *   real extraction accuracy × real eviction × real snapshot rendering
 *
 * Checkpoints: [25, 50, 75, 100] cycles.
 *
 * Run via: node benchmark/test-lifetime-retention.mjs
 * Depends on: build/ (compiled TypeScript), HuggingFace Datasets Server API
 */

import { join }                         from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir }                        from "node:os";
import { pathToFileURL }                 from "node:url";

const BUILD = join(process.cwd(), "build");

// ── Config ────────────────────────────────────────────────────────────────────

const TOTAL_CYCLES      = 100;
const CHECKPOINTS       = [25, 50, 75, 100];
/** Cycles used to build dynamic anchors — must complete before first checkpoint. */
const ANCHOR_CYCLES     = 5;
/** How many anchor terms to track. */
const ANCHOR_COUNT      = 10;
const ITEMS_PER_CYCLE   = 20;
const FETCH_TIMEOUT     = 15_000;
const WILDCHAT_FETCH    = 500;
const SWEBENCH_FETCH    = 100;

// Coding conversation filter
const CODING_RE = /\b(code|function|class|bug|error|exception|fix|script|python|javascript|typescript|java|golang|rust|sql|api|database|npm|pip|git|docker|refactor|async|await|hook|component|module|query|schema|endpoint|middleware|auth|token|cache|redis|postgres|mongo|mysql|error|exception|stack|trace|compile|build|lint|test)\b/i;

// Stop words for key-term extraction — includes generic English AND ECC internal vocabulary
// (intent modes like "implement"/"investigate", checkpoint terms like "build"/"success")
const STOP = new Set("the a an is it in on at to for of and or with that this be are was were have has do does can could should would will may might i we you he she they my your our its not no but if when how what which who where from by as use used using also just like more some than then there these those been had into over after before about each every here need want make take back down still any other both few most such able according allow among another based call called change changed different does done each example file files following found get getting given go going got had help holds however include including its keep large later let line list look many method methods might multiple must name named names need needs never next note object objects option options order part parts pass passed path paths place point points possible print property provide put raise raised read remove removed returns run running set sets show shown simple single size specify specific standard start started state states stop string take takes test tests them thing things through true try type types update updated updates value values var version via view write written one two three four five six seven eight nine zero new old good first last long own right same here there from than then when just were been have this that with some what about which also could would should must will their there been about into from with more some what about which also well only just like back down still please check within comments hidden implement investigate review discuss build success failed passed error function class import return const would should could".split(" "));

// ── Key-term extraction ───────────────────────────────────────────────────────

/** Extract distinctive terms from raw text (same heuristic as lifecycle test). */
function keyTerms(msg) {
  const tokens = (msg.match(/\b[a-zA-Z][a-zA-Z0-9]{3,}\b/g) ?? [])
    .filter(t => !STOP.has(t.toLowerCase()))
    .filter(t => t.length >= 5);
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

/** Extract changed file paths from a unified diff patch. */
function extractPatchFiles(patch) {
  const matches = patch.match(/^(?:---|\+\+\+) [ab]\/(.*)/gm) ?? [];
  return [...new Set(
    matches.map(m => m.replace(/^(?:---|\+\+\+) [ab]\//, "").trim())
  )].filter(f => !f.startsWith("/dev/null")).slice(0, 4);
}

/**
 * Synthesize PostToolUse-style session events from real message content.
 * Derives events from what the message implies — not invented.
 */
function synthesizeToolEvents(msg, userEvents, meta = {}) {
  const events     = [];
  const intentMode = userEvents.find(e => e.category === "intent")?.data;
  const errors     = extractErrorMentions(msg);

  const patchFiles = meta.patch ? extractPatchFiles(meta.patch) : [];
  const textFiles  = extractFilePaths(msg);
  const files      = patchFiles.length > 0 ? patchFiles : textFiles;

  const fallbackFile = meta.repo
    ? `${meta.repo.split("/")[1] ?? "src"}/main.py`
    : "src/main.ts";

  switch (intentMode) {
    case "implement": {
      const editTargets = files.length > 0 ? files : [fallbackFile];
      for (const f of editTargets.slice(0, 3)) {
        events.push({ type: "file_edit", category: "file", priority: 1, data: f });
      }
      events.push({
        type: "checkpoint_build", category: "checkpoint", priority: 1,
        data: `build: ${errors.length === 0 ? "SUCCESS" : "FAILED"} — npm run build`,
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

  if (errors.length > 0 && intentMode !== "investigate") {
    events.push({ type: "error_tool", category: "error", priority: 2, data: errors[0] });
  }

  return events;
}

// ── Pool construction ─────────────────────────────────────────────────────────

function buildPool(extractFn, wildchatRows, sweRows) {
  const pool = [];

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

// ── Dynamic anchor collection ─────────────────────────────────────────────────

/**
 * After early cycles, scan stored events and extract the most distinctive
 * domain-specific terms. These become the anchor set.
 *
 * Category filtering: only file, decision, data, and error events are mined.
 * Intent events just say "implement"/"investigate" (ECC vocabulary, not domain).
 * Checkpoint events say "build: SUCCESS" (structural, not semantic).
 * Role events say "act as senior engineer" (persona, not domain).
 *
 * Why frequency? High-frequency terms in domain events are the ones ECC
 * actually captured from real conversations. If they can't be recalled at
 * cycle 100, they were evicted — a real retention gap.
 *
 * @param {object} db        - SessionDB instance
 * @param {string} sessionId - Session to scan
 * @param {number} limit     - Max anchor terms to collect
 * @returns {Array<{term, count, category}>}
 */
const ANCHOR_CATEGORIES = new Set(["file", "decision", "data", "error"]);

function collectAnchorTerms(db, sessionId, limit) {
  const events = db.getEvents(sessionId);
  const freq = {};

  for (const e of events) {
    // Only mine domain-bearing categories
    if (!ANCHOR_CATEGORIES.has(e.category)) continue;

    const text = String(e.data ?? "");
    const tokens = (text.match(/\b[a-zA-Z][a-zA-Z0-9]{4,}\b/g) ?? [])
      .filter(t => !STOP.has(t.toLowerCase()));
    for (const t of tokens) {
      const lower = t.toLowerCase();
      freq[lower] = (freq[lower] ?? 0) + 1;
    }
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

// ── Anchor retention check ────────────────────────────────────────────────────

/**
 * Check how many anchor terms are still retrievable via FTS5 and present in
 * the snapshot XML at a given checkpoint.
 *
 * @param {object}   db          - SessionDB instance
 * @param {string}   snapshot    - XML snapshot string
 * @param {Array}    anchors     - [{term, count}] from collectAnchorTerms()
 * @returns {{ fts5: {hits,total,details}, snap: {hits,total,details} }}
 */
function checkAnchorRetention(db, snapshot, anchors) {
  const lowerSnap = snapshot.toLowerCase();
  const ftsDetails  = [];
  const snapDetails = [];
  let ftsHits = 0, snapHits = 0;

  for (const { term, count } of anchors) {
    // FTS5 check — searchEvents queries both live + archive
    let ftsFound = false;
    let ftsSource = "none";   // "live" | "archive" | "both" | "none"
    try {
      const hits = db.searchEvents(`"${term}"`, 5);
      ftsFound = hits.length > 0;

      // Attribution: determine if hits come from live, archive, or both
      if (ftsFound) {
        const liveHit = db.db.prepare(
          `SELECT 1 FROM session_events WHERE data LIKE ? LIMIT 1`
        ).get(`%${term}%`);
        const archiveHit = db.db.prepare(
          `SELECT 1 FROM session_events_archive WHERE data LIKE ? LIMIT 1`
        ).get(`%${term}%`);
        if (liveHit && archiveHit) ftsSource = "both";
        else if (archiveHit)       ftsSource = "archive";
        else                       ftsSource = "live";
      }
    } catch { /* special chars in term — skip */ }
    ftsDetails.push({ term, found: ftsFound, plantCount: count, source: ftsSource });
    if (ftsFound) ftsHits++;

    // Snapshot check — is the term present anywhere in the rendered XML?
    const snapFound = lowerSnap.includes(term.toLowerCase());
    snapDetails.push({ term, found: snapFound });
    if (snapFound) snapHits++;
  }

  return {
    fts5: { hits: ftsHits, total: anchors.length, details: ftsDetails },
    snap: { hits: snapHits, total: anchors.length, details: snapDetails },
  };
}

// ── FTS5 signal quality check ─────────────────────────────────────────────────

/**
 * For each anchor term, determine if FTS5 hits are signal (decision/file events
 * mentioning the term semantically) vs noise (stack traces / connection strings
 * that incidentally contain the term).
 */
function checkFTS5Quality(db, anchors) {
  let totalSignal = 0, totalNoise = 0;

  for (const { term } of anchors) {
    let results;
    try { results = db.searchEvents(`"${term}"`, 10); } catch { continue; }

    for (const r of results) {
      const isStackNoise = (r.category === "error" || r.category === "tool") &&
        (r.data.includes("ECONNREFUSED") || r.data.includes("at ") ||
         r.data.includes("node_modules") || r.data.includes("Stack:") ||
         r.data.includes("://"));
      if (isStackNoise) totalNoise++;
      else totalSignal++;
    }
  }

  return { signal: totalSignal, noise: totalNoise };
}

// ── Simple seeded PRNG ────────────────────────────────────────────────────────

function makePrng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
}

function pickRandom(arr, n, rng) {
  const result = [];
  for (let i = 0; i < n && arr.length > 0; i++) {
    result.push(arr[Math.floor(rng() * arr.length)]);
  }
  return result;
}

// ── Token estimator (simple: 4 chars ≈ 1 token) ──────────────────────────────
function estimateTokens(text) { return Math.ceil(text.length / 4); }

// ── Header ────────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(76));
console.log("  LIFETIME RETENTION STRESS TEST — REAL DATA PIPELINE");
console.log(`  ${TOTAL_CYCLES} cycles × ~80K tokens ≈ ${(TOTAL_CYCLES * 80 / 1000).toFixed(1)}M total tokens`);
console.log(`  Data: WildChat-1M (coding) + SWE-bench (GitHub issues)`);
console.log(`  Anchors: dynamic — collected from first ${ANCHOR_CYCLES} cycles, then ISOLATED (no re-insertion)`);
console.log(`  Checkpoints: ${CHECKPOINTS.join(", ")} cycles`);
console.log("═".repeat(76));

// ── Load modules ──────────────────────────────────────────────────────────────

const { SessionDB }          = await import(pathToFileURL(join(BUILD, "session", "db.js")).href);
const { buildResumeSnapshot } = await import(pathToFileURL(join(BUILD, "session", "snapshot.js")).href);
const { extractUserEvents }  = await import(pathToFileURL(join(BUILD, "session", "extract.js")).href);

// ── DB setup ──────────────────────────────────────────────────────────────────

const dbDir = join(tmpdir(), "ecc-lifetime-real-bench");
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, "lifetime-real.db");
if (existsSync(dbPath)) rmSync(dbPath);

const db        = new SessionDB({ dbPath });
const sessionId = `lifetime-real-${Date.now()}`;
const projectDir = dbDir;
db.ensureSession(sessionId, projectDir);

// ── Fetch real data ───────────────────────────────────────────────────────────

console.log("\n  Phase 1: Fetching real conversation data…\n");

const wildchatRows = await fetchAll("allenai/WildChat-1M",  "default", "train", WILDCHAT_FETCH);
const sweRows      = await fetchAll("SWE-bench/SWE-bench",  "default", "test",  SWEBENCH_FETCH);
const pool         = buildPool(extractUserEvents, wildchatRows, sweRows);

const wcCount  = pool.filter(p => p.source === "wildchat").length;
const sweCount = pool.filter(p => p.source === "swebench").length;
console.log(`\n  Pool: ${pool.length} items  (WildChat: ${wcCount} | SWE-bench: ${sweCount})`);
console.log(`  Total events in pool: ${pool.reduce((s, p) => s + p.allEvents.length, 0)}`);

if (pool.length < 20) {
  console.error("\n  ✗  Pool too small — API may be unavailable. Exiting.");
  process.exit(1);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

console.log(`\n  Phase 2: Running ${TOTAL_CYCLES} cycles…`);
console.log(`  (Anchors collected after cycle ${ANCHOR_CYCLES})\n`);

const rng = makePrng(0xDEADBEEF);

let anchors          = null;  // populated after ANCHOR_CYCLES
let totalInserted    = 0;
let totalSeeded      = 0;     // events placed (before FIFO)
const checkpointResults = [];
const cycleMetrics   = [];

for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
  const drawn = pickRandom(pool, ITEMS_PER_CYCLE, rng);

  let insertedThisCycle = 0;
  for (const item of drawn) {
    for (const event of item.allEvents) {
      db.insertEvent(sessionId, event, "UserPromptSubmit");
      insertedThisCycle++;
    }
  }
  totalInserted += insertedThisCycle;
  totalSeeded   += insertedThisCycle;

  const stats      = db.getSessionStats(sessionId);
  const eventCount = stats?.event_count ?? 0;
  const prevCount  = cycleMetrics.length > 0 ? cycleMetrics[cycleMetrics.length - 1].eventCount : 0;
  const evictionFired = eventCount < prevCount + insertedThisCycle;
  cycleMetrics.push({ cycle, eventCount, evictionFired });

  // Progress dot every 10 cycles
  if (cycle % 10 === 0) {
    process.stdout.write(`  [Cycle ${String(cycle).padStart(3)}/${TOTAL_CYCLES}] stored=${eventCount}` +
      (evictionFired ? " ⚠ FIFO active" : "") + "\n");
  }

  // Collect dynamic anchors immediately after ANCHOR_CYCLES, then ISOLATE
  // them by removing anchor-bearing items from the pool.  This prevents
  // anchor terms from being re-inserted in later cycles — so retention
  // at cycle 100 proves the terms survived eviction, not that they were
  // recently re-added.  Without this isolation the test is rigged.
  if (cycle === ANCHOR_CYCLES && anchors === null) {
    anchors = collectAnchorTerms(db, sessionId, ANCHOR_COUNT);
    const anchorSet = new Set(anchors.map(a => a.term));

    // Remove pool items whose events contain any anchor term
    const beforeSize = pool.length;
    for (let i = pool.length - 1; i >= 0; i--) {
      const itemTerms = pool[i].allEvents
        .flatMap(e => (String(e.data ?? "").match(/\b[a-zA-Z][a-zA-Z0-9]{4,}\b/g) ?? []))
        .map(t => t.toLowerCase());
      if (itemTerms.some(t => anchorSet.has(t))) {
        pool.splice(i, 1);
      }
    }

    console.log(`\n  ── Anchor terms collected from cycles 1-${ANCHOR_CYCLES} ──`);
    for (const a of anchors) {
      console.log(`    "${a.term}" (seen ${a.count}x in stored events)`);
    }
    console.log(`  Pool isolation: ${beforeSize} → ${pool.length} items (${beforeSize - pool.length} anchor-bearing items removed)`);
    if (pool.length < 10) {
      console.error("  ✗  Pool too small after isolation — need more diverse data. Exiting.");
      process.exit(1);
    }
    console.log();
  }

  db.incrementCompactCount(sessionId);

  // ── Checkpoint ────────────────────────────────────────────────────────────

  if (!CHECKPOINTS.includes(cycle)) continue;

  const storedEvents   = db.getEvents(sessionId);
  // Fetch archive events so renderKeyTopics() can surface domain vocabulary
  // from events evicted from the 1000-event FIFO buffer.
  // getArchiveEvents() returns rows ORDER BY id ASC — oldest-first, which
  // renderKeyTopics() relies on when slicing to ARCHIVE_HISTORY_LIMIT.
  const archiveEvents  = db.getArchiveEvents(sessionId);
  const snapshot       = buildResumeSnapshot(storedEvents, { compactCount: cycle, archiveEvents });
  const snapshotBytes  = Buffer.byteLength(snapshot);
  const snapshotTokens = estimateTokens(snapshot);
  const evictedSoFar   = Math.max(0, totalSeeded - storedEvents.length);

  console.log("\n" + "─".repeat(76));
  console.log(`  ── CHECKPOINT: Cycle ${cycle} ──`);
  console.log(`  Events: ${totalSeeded} seeded | ${storedEvents.length} stored | ${evictedSoFar} evicted`);
  console.log(`  Snapshot: ${snapshotBytes} bytes (~${snapshotTokens} tokens)`);

  const retention = checkAnchorRetention(db, snapshot, anchors);

  // FTS5 results with source attribution
  console.log("\n  FTS5 anchor retention:");
  let archiveOnlyHits = 0;
  let liveOnlyHits = 0;
  let bothHits = 0;
  for (const d of retention.fts5.details) {
    const srcTag = d.found ? ` [${d.source}]` : "";
    console.log(`    ${d.found ? "✓" : "✗"} "${d.term}" (planted ${d.plantCount}x)${srcTag}`);
    if (d.source === "archive") archiveOnlyHits++;
    else if (d.source === "live") liveOnlyHits++;
    else if (d.source === "both") bothHits++;
  }
  const ftsPct = retention.fts5.total > 0
    ? Math.round((retention.fts5.hits / retention.fts5.total) * 100)
    : 100;
  console.log(`  → FTS5: ${retention.fts5.hits}/${retention.fts5.total} (${ftsPct}%)`);
  console.log(`  → Source: live=${liveOnlyHits} archive=${archiveOnlyHits} both=${bothHits}`);

  // Snapshot results
  console.log("\n  Snapshot anchor retention:");
  for (const d of retention.snap.details) {
    console.log(`    ${d.found ? "✓" : "✗"} "${d.term}" in snapshot XML`);
  }
  const snapPct = retention.snap.total > 0
    ? Math.round((retention.snap.hits / retention.snap.total) * 100)
    : 100;
  console.log(`  → Snapshot: ${retention.snap.hits}/${retention.snap.total} (${snapPct}%)`);

  // FTS5 signal quality (after FIFO starts evicting, verify remaining hits are not noise)
  if (cycle >= 25) {
    const quality = checkFTS5Quality(db, anchors);
    const total   = quality.signal + quality.noise;
    const ratio   = total > 0 ? Math.round((quality.signal / total) * 100) : 100;
    console.log(`\n  FTS5 signal quality: ${quality.signal} signal / ${quality.noise} noise (${ratio}% clean)`);
  }

  // Category breakdown
  const catCounts = {};
  for (const e of storedEvents) catCounts[e.category] = (catCounts[e.category] ?? 0) + 1;
  console.log(`  Live DB: ${Object.entries(catCounts).map(([k, v]) => `${k}:${v}`).join(" ")}`);

  // Archive stats — how many events are preserved in the archive
  const archiveRow = db.db.prepare(
    "SELECT COUNT(*) AS cnt FROM session_events_archive WHERE session_id = ?"
  ).get(sessionId);
  const archiveCount = archiveRow?.cnt ?? 0;
  console.log(`  Archive DB: ${archiveCount} events preserved`);

  const combinedHits  = retention.fts5.hits + retention.snap.hits;
  const combinedTotal = retention.fts5.total + retention.snap.total;
  const combinedPct   = combinedTotal > 0 ? Math.round((combinedHits / combinedTotal) * 100) : 100;

  const lostFts5 = retention.fts5.details.filter(d => !d.found).map(d => `fts:${d.term}`);
  const lostSnap = retention.snap.details.filter(d => !d.found).map(d => `snap:${d.term}`);

  checkpointResults.push({
    cycle,
    totalSeeded,
    stored:        storedEvents.length,
    evicted:       evictedSoFar,
    snapshotBytes,
    snapshotTokens,
    snapPassed:    retention.snap.hits,
    snapTotal:     retention.snap.total,
    snapPct,
    ftsPassed:     retention.fts5.hits,
    ftsTotal:      retention.fts5.total,
    ftsPct,
    combinedHits,
    combinedTotal,
    combinedPct,
    lostFacts:     [...lostFts5, ...lostSnap],
  });
}

db.close();

// ── Summary scorecard ─────────────────────────────────────────────────────────

console.log("\n\n" + "═".repeat(76));
console.log("  LIFETIME RETENTION SCORECARD");
console.log("═".repeat(76));

console.log(
  `\n  ${"Cycle".padEnd(7)} ${"Stored".padEnd(8)} ${"Evicted".padEnd(9)} ${"Snap".padEnd(12)} ${"FTS5".padEnd(12)} ${"Combined".padEnd(10)} ${"Snap KB"}`
);
console.log(
  `  ${"-".repeat(7)} ${"-".repeat(8)} ${"-".repeat(9)} ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(10)} ${"-".repeat(9)}`
);

for (const r of checkpointResults) {
  const snapKB = (r.snapshotBytes / 1024).toFixed(1);
  console.log(
    `  ${String(r.cycle).padEnd(7)} ${String(r.stored).padEnd(8)} ${String(r.evicted).padEnd(9)} ` +
    `${`${r.snapPassed}/${r.snapTotal}(${r.snapPct}%)`.padEnd(12)} ` +
    `${`${r.ftsPassed}/${r.ftsTotal}(${r.ftsPct}%)`.padEnd(12)} ` +
    `${`${r.combinedHits}/${r.combinedTotal}(${r.combinedPct}%)`.padEnd(10)} ` +
    `${snapKB}KB`
  );
}

// Retention trend bar chart
console.log("\n  Retention trend (FTS5 + snapshot combined):");
for (const r of checkpointResults) {
  const bars   = Math.round(r.combinedPct / 10);
  const bar    = "█".repeat(bars) + "░".repeat(10 - bars);
  const lostStr = r.lostFacts.length > 0 ? `  LOST: ${r.lostFacts.join(", ")}` : "";
  console.log(`  C${String(r.cycle).padStart(3)}: ${bar} ${r.combinedPct}%${lostStr}`);
}

// FIFO eviction analysis
console.log("\n  FIFO eviction analysis:");
for (const r of checkpointResults) {
  const pct = r.totalSeeded > 0 ? Math.round((r.evicted / r.totalSeeded) * 100) : 0;
  console.log(
    `  C${String(r.cycle).padStart(3)}: ${r.evicted} events evicted ` +
    `(${pct}% of ${r.totalSeeded} total) — ${r.stored}/1000 remain`
  );
}

// Anchor summary
console.log(`\n  Dynamic anchor terms (collected from cycles 1-${ANCHOR_CYCLES}):`);
if (anchors) {
  for (const { term, count } of anchors) {
    console.log(`    "${term}" — ${count} occurrences in early-cycle events`);
  }
}

// Overall verdict
const finalResult = checkpointResults[checkpointResults.length - 1];
const anyDegrades = checkpointResults.length >= 2 &&
  finalResult.combinedPct < checkpointResults[0].combinedPct - 20;

console.log("\n  ── Verdict ──");
if (finalResult.combinedPct >= 80) {
  console.log(`  EXCELLENT: ${finalResult.combinedPct}% retention at cycle ${TOTAL_CYCLES} — ECC maintains long-term memory`);
} else if (finalResult.combinedPct >= 60) {
  console.log(`  GOOD: ${finalResult.combinedPct}% retention — some degradation but key facts survive`);
} else if (finalResult.combinedPct >= 40) {
  console.log(`  WARNING: ${finalResult.combinedPct}% retention — significant fact loss; SLM brief chain needed`);
} else {
  console.log(`  CRITICAL: ${finalResult.combinedPct}% retention — system cannot maintain long-term memory without SLM`);
}

if (anyDegrades) {
  const drop = checkpointResults[0].combinedPct - finalResult.combinedPct;
  console.log(`  DEGRADATION: ${drop}pp drop from cycle ${checkpointResults[0].cycle} → ${TOTAL_CYCLES}`);
}

const totalEvictions = cycleMetrics.filter(m => m.evictionFired).length;
const firstEviction  = cycleMetrics.find(m => m.evictionFired)?.cycle ?? "never";
console.log(`\n  Total events seeded: ${totalSeeded} across ${TOTAL_CYCLES} cycles`);
console.log(`  Avg events/cycle: ~${Math.round(totalSeeded / TOTAL_CYCLES)}`);
console.log(`  First eviction at cycle: ${firstEviction} | Total eviction cycles: ${totalEvictions}`);

console.log("\n" + "═".repeat(76) + "\n");

// Exit: fail only if final combined retention drops below 40%
process.exit(finalResult.combinedPct < 40 ? 1 : 0);
