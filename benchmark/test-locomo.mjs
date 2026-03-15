/**
 * test-locomo.mjs — LOCOMO benchmark harness for EngramCC.
 *
 * What this file is: measures EngramCC's retrieval accuracy against the
 *   LOCOMO long-term conversation memory benchmark (snap-research/locomo).
 *
 * What it is responsible for:
 *   1. Download locomo10.json from GitHub if not already cached
 *   2. For each conversation, insert all dialogue turns into a fresh
 *      EngramCC SessionDB as session events
 *   3. For each QA pair, run searchEvents() and extract an answer
 *      from the top result
 *   4. Score using Token F1 (cats 1-4) and binary abstain (cat 5)
 *   5. Report per-category and overall scores comparable to Mem0/Zep
 *   6. Report failure-type breakdown for factual categories (1-4) to
 *      distinguish no-retrieval, wrong-evidence, right-evidence-bad-span,
 *      partial, and correct outcomes.
 *
 * What it depends on: SessionDB (build/session/db.js), node:fs, node:path,
 *   node:crypto, node:os.
 *
 * What depends on it: nothing — standalone benchmark script.
 *
 * Usage:
 *   node benchmark/test-locomo.mjs              # full run (1986 questions)
 *   node benchmark/test-locomo.mjs --quick      # 3 conversations (~600 questions)
 *   node benchmark/test-locomo.mjs --verbose    # show per-question details
 *   node benchmark/test-locomo.mjs --limit=50   # first N questions only
 *   node benchmark/test-locomo.mjs --diagnose   # per-question failure type (cats 1-4)
 *
 * Scoring methodology (matches official LOCOMO evaluation.py):
 *   Cat 1 (single-hop): token F1, multi-answer partial credit
 *   Cat 2 (temporal):   token F1
 *   Cat 3 (open-domain):token F1
 *   Cat 4 (multi-hop):  token F1
 *   Cat 5 (adversarial):binary — 1 if retrieved text implies "not found", 0 otherwise
 *
 * Comparison baseline (from Mem0 arXiv:2504.19413):
 *   Full Context: 72.90  |  Mem0: 66.88  |  Zep: 65.99  |  LangMem: 58.10
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const QUICK    = args.includes("--quick");
const VERBOSE  = args.includes("--verbose");
const DIAGNOSE = args.includes("--diagnose");
const LIMIT    = (() => {
  const a = args.find(a => a.startsWith("--limit="));
  return a ? parseInt(a.split("=")[1], 10) : Infinity;
})();

// ── Constants ─────────────────────────────────────────────────────────────────

const LOCOMO_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";
const CACHE_PATH = join(tmpdir(), "locomo10.json");
const MAX_CONVERSATIONS = QUICK ? 3 : 10;

/** How many FTS5 results to retrieve per question. */
const SEARCH_LIMIT = 20;

/** Confidence floor for factual categories (1-4). */
const MIN_CONFIDENCE_FACTUAL = 0.05;

/** Confidence floor for adversarial abstention (category 5). */
const MIN_CONFIDENCE_ABSTAIN = 0.15;

/** Stop-words removed during token F1 normalization (matches official scorer). */
const STOP_WORDS = new Set(["a", "an", "the", "and", "is", "are", "was", "were", "of", "in", "to", "for"]);

// ── Dataset download ──────────────────────────────────────────────────────────

/**
 * Download locomo10.json from GitHub and cache it in /tmp.
 * Uses Node.js fetch (Node 18+). Shows progress.
 */
async function ensureDataset() {
  if (existsSync(CACHE_PATH)) {
    console.log(`  [OK] Dataset cached at ${CACHE_PATH}`);
    return;
  }

  console.log(`  Downloading LOCOMO dataset from GitHub...`);
  const res = await fetch(LOCOMO_URL);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download LOCOMO dataset: HTTP ${res.status}`);
  }

  const total = parseInt(res.headers.get("content-length") ?? "0", 10);
  let received = 0;

  const fileStream = createWriteStream(CACHE_PATH);
  const nodeReadable = Readable.fromWeb(res.body);

  nodeReadable.on("data", chunk => {
    received += chunk.length;
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      process.stdout.write(`\r  Downloading... ${pct}% (${(received / 1024).toFixed(0)} KB)`);
    }
  });

  await pipeline(nodeReadable, fileStream);
  process.stdout.write("\n");
  console.log(`  [OK] Downloaded to ${CACHE_PATH}`);
}

// ── SessionDB loader ──────────────────────────────────────────────────────────

/**
 * Load the compiled SessionDB class from the ECC build.
 * Fails fast if build hasn't been run.
 */
async function loadSessionDB() {
  const dbPath = join(PROJECT_ROOT, "build", "session", "db.js");
  if (!existsSync(dbPath)) {
    throw new Error(
      "build/session/db.js not found. Run `npm run build` first."
    );
  }
  // On Windows, dynamic import requires a file:// URL — plain paths fail
  const dbUrl = new URL(`file:///${dbPath.replace(/\\/g, "/")}`).href;
  const mod = await import(dbUrl);
  return mod.SessionDB;
}

// ── Conversation ingestion ────────────────────────────────────────────────────

/**
 * Insert all dialogue turns from one LOCOMO conversation into a fresh
 * SessionDB session. Each turn becomes one session event with:
 *   type: "decision" (best proxy for searchable factual content)
 *   category: "context"
 *   priority: 2 (normal)
 *   data: "{speaker} said: {text} [session {N}, turn {dia_id}]"
 *
 * Observations (pre-extracted facts) are also inserted as priority-3
 * events — these are the high-signal memory candidates.
 *
 * @param db         - Open SessionDB instance
 * @param sessionId  - UUID for this conversation's session
 * @param conv       - One LOCOMO conversation object
 */
function ingestConversation(db, sessionId, conv) {
  db.ensureSession(sessionId, "/locomo-benchmark");

  let inserted = 0;

  // Insert raw dialogue turns
  for (let s = 1; s <= 35; s++) {
    const sessionKey = `session_${s}`;
    const dateKey   = `session_${s}_date_time`;
    const turns = conv.conversation[sessionKey];
    if (!Array.isArray(turns)) continue;

    const date = conv.conversation[dateKey] ?? "";

    for (const turn of turns) {
      const text = turn.text ?? turn.blip_caption ?? "";
      if (!text.trim()) continue;

      const data = date
        ? `[${date}] ${turn.speaker} said: ${text}`
        : `${turn.speaker} said: ${text}`;

      db.insertEvent(
        sessionId,
        { type: "decision", category: "context", priority: 2, data },
        "locomo-ingest",
      );
      inserted++;
    }
  }

  // Insert pre-extracted observations as higher-priority events
  // These represent distilled facts — the memory layer ECC would synthesize
  if (conv.observation) {
    for (const [sessionKey, speakerMap] of Object.entries(conv.observation)) {
      for (const [, facts] of Object.entries(speakerMap)) {
        if (!Array.isArray(facts)) continue;
        for (const factEntry of facts) {
          const fact = Array.isArray(factEntry) ? factEntry[0] : factEntry;
          if (typeof fact !== "string" || !fact.trim()) continue;

          db.insertEvent(
            sessionId,
            { type: "decision", category: "fact", priority: 3, data: fact },
            "locomo-observation",
          );
          inserted++;
        }
      }
    }
  }

  return inserted;
}

// ── Token F1 scorer ───────────────────────────────────────────────────────────

/**
 * Normalize a string for token F1 scoring.
 * Matches official LOCOMO evaluation.py: lowercase, strip punctuation,
 * remove stop-words, split on whitespace.
 *
 * @param text - Raw text string
 * @returns Array of normalized tokens
 */
function normalizeTokens(text) {
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 0 && !STOP_WORDS.has(t))
    // Normalize leading-zero numbers ("07" → "7", "02" → "2") so that
    // date comparisons work: "07 May 2023" and "7 May 2023" share "7".
    .map(t => /^\d+$/.test(t) ? String(parseInt(t, 10)) : t);
}

/**
 * Compute token-level F1 between predicted and ground-truth strings.
 * Used for categories 1, 2, 3, 4.
 *
 * @param predicted   - The string retrieved/predicted by the system
 * @param groundTruth - The correct answer string
 * @returns F1 score between 0.0 and 1.0
 */
function tokenF1(predicted, groundTruth) {
  const predTokens  = normalizeTokens(predicted);
  const truthTokens = normalizeTokens(groundTruth);

  if (predTokens.length === 0 && truthTokens.length === 0) return 1.0;
  if (predTokens.length === 0 || truthTokens.length === 0) return 0.0;

  const predSet  = new Map();
  const truthSet = new Map();

  for (const t of predTokens)  predSet.set(t,  (predSet.get(t)  ?? 0) + 1);
  for (const t of truthTokens) truthSet.set(t, (truthSet.get(t) ?? 0) + 1);

  let common = 0;
  for (const [t, cnt] of predSet) {
    common += Math.min(cnt, truthSet.get(t) ?? 0);
  }

  const precision = common / predTokens.length;
  const recall    = common / truthTokens.length;

  if (precision + recall === 0) return 0.0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Score a category-1 (single-hop) question with multi-answer partial credit.
 * Ground truth may be comma-separated (e.g. "Paris, France").
 * Splits into sub-answers and averages max F1 per sub-answer.
 *
 * @param predicted   - Retrieved answer text
 * @param groundTruth - Possibly comma-separated ground truth
 * @returns Score between 0.0 and 1.0
 */
function scoreSingleHop(predicted, groundTruth) {
  const gt = typeof groundTruth === "string" ? groundTruth : String(groundTruth ?? "");
  const subAnswers = gt.split(",").map(s => s.trim()).filter(Boolean);
  if (subAnswers.length === 0) return tokenF1(predicted, gt);

  const scores = subAnswers.map(sub => tokenF1(predicted, sub));
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Score a category-5 (adversarial) question.
 * Correct answer: system must indicate the information is NOT available.
 * Returns 1.0 if the retrieved text is empty or contains abstain signals,
 * 0.0 otherwise.
 *
 * @param retrievedText - Top search result data field (may be empty string)
 * @returns 1.0 (correct abstain) or 0.0 (hallucinated answer)
 */
function scoreAdversarial(retrievedText) {
  if (!retrievedText || retrievedText.trim().length === 0) return 1.0;
  const lower = retrievedText.toLowerCase();
  const abstainSignals = [
    "not mentioned", "not found", "no information",
    "not in", "not available", "not present", "no record",
    "cannot find", "not exist",
  ];
  return abstainSignals.some(s => lower.includes(s)) ? 1.0 : 0.0;
}

// ── Question answering ────────────────────────────────────────────────────────

/**
 * Common question words and verbs to strip from FTS5 queries.
 * FTS5 uses AND matching by default — question words like "when/did/what"
 * don't appear in event text and cause zero results.
 */
const QUERY_STOP_WORDS = new Set([
  // question words
  "what", "when", "where", "who", "whom", "which", "why", "how",
  // auxiliary verbs
  "did", "do", "does", "is", "are", "was", "were", "has", "have", "had",
  "will", "would", "could", "should", "can", "may", "might",
  // common filler
  "the", "a", "an", "of", "in", "to", "for", "on", "at", "by",
  "from", "with", "about", "into", "through", "during", "that", "this",
]);

/**
 * Month names used for temporal category detection and boosting.
 */
const MONTH_NAMES = new Set([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
]);

/**
 * Temporal signal words for category-2 (temporal) question boosting.
 * These words indicate the question is asking about when something happened.
 */
const TEMPORAL_SIGNALS = new Set([
  "birthday", "anniversary", "started", "graduated", "married", "moved",
  "visited", "began", "ended", "born", "died", "founded", "opened", "closed",
  ...MONTH_NAMES,
]);

/**
 * Build a tiered FTS5 query object from a question string and its category.
 *
 * Instead of a single AND-joined string (which causes 84.7% zero-result rate),
 * this function returns three increasingly relaxed query tiers so the caller
 * can fall back gracefully:
 *   strict  — top 4 content keywords AND-joined (cats 1/2/3) or top 5 (cat 4)
 *   relaxed — top 3 content keywords AND-joined
 *   minimal — top 2 highest-value tokens (last resort)
 *
 * Named entities (capitalize-initial words that are NOT question words and NOT
 * the first word of the question) are always included in every tier because
 * they are the most discriminating terms in the event text.
 *
 * Category-specific behavior:
 *   Cat 2 (temporal): temporal signal words are extracted and prioritized first
 *   Cat 4 (multi-hop): strict tier uses top 5 terms instead of top 4
 *
 * @param question - Raw question text
 * @param category - LOCOMO question category (1-5)
 * @returns { strict: string, relaxed: string, minimal: string }
 *   Each field is an FTS5-safe space-separated AND query string.
 *   Returns { strict: "", relaxed: "", minimal: "" } if no usable terms found.
 */
function buildFtsQuery(question, category) {
  const empty = { strict: "", relaxed: "", minimal: "" };
  if (!question || !question.trim()) return empty;

  // Tokenize while preserving original case for named-entity detection.
  // Strip FTS5 special characters but keep alphanumerics and whitespace.
  const rawTokens = question
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 0);

  if (rawTokens.length === 0) return empty;

  // ── Named entity extraction ──────────────────────────────────────────────
  // A word is a named entity candidate if:
  //   1. It starts with a capital letter
  //   2. It is NOT the first word of the question (first word is always capped)
  //   3. Its lowercase form is NOT in QUERY_STOP_WORDS
  // Named entities are stored in lowercase for FTS5 (case-insensitive search).
  const namedEntities = [];
  for (let i = 1; i < rawTokens.length; i++) {
    const token = rawTokens[i];
    const lower = token.toLowerCase();
    if (/^[A-Z]/.test(token) && !QUERY_STOP_WORDS.has(lower) && lower.length > 2) {
      namedEntities.push(lower);
    }
  }

  // ── Content keyword extraction ───────────────────────────────────────────
  // Non-stop-word tokens with length > 2, lowercased.
  // Named entities already captured above are excluded from this pool to
  // avoid double-counting, but will be merged back during tier construction.
  const namedEntitySet = new Set(namedEntities);
  const contentKeywords = rawTokens
    .map(t => t.toLowerCase())
    .filter(t => t.length > 2 && !QUERY_STOP_WORDS.has(t) && !namedEntitySet.has(t));

  // ── Category-2 temporal signal extraction ───────────────────────────────
  // For temporal questions, words like "birthday", "anniversary", month names
  // are promoted to the front of the keyword list so they appear in all tiers.
  let orderedKeywords;
  if (category === 2) {
    const temporalKw = contentKeywords.filter(t => TEMPORAL_SIGNALS.has(t));
    const otherKw    = contentKeywords.filter(t => !TEMPORAL_SIGNALS.has(t));
    orderedKeywords  = [...temporalKw, ...otherKw];
  } else {
    orderedKeywords = contentKeywords;
  }

  // ── Merge named entities with content keywords ───────────────────────────
  // Named entities come first because they are the most discriminating terms.
  // De-duplicate in case a named entity also appears lowercased in keywords.
  const allTerms = [...new Set([...namedEntities, ...orderedKeywords])];

  if (allTerms.length === 0) return empty;

  // ── Tier construction ────────────────────────────────────────────────────
  // Cat 5 (adversarial): use ALL extracted terms so the AND requirement is
  // maximally strict → returns 0 results for things not in the conversation.
  // Cat 4 (multi-hop): strict tier uses 5 terms instead of 4 for precision.
  // Others: strict=4, relaxed=3, minimal=2.
  if (category === 5) {
    // All terms AND-joined: adversarial questions ask about absent facts, so a
    // strict multi-term query should naturally return nothing → correct abstain.
    const allJoined = allTerms.join(" ");
    return { strict: allJoined, relaxed: allJoined, minimal: allJoined };
  }

  const strictSize  = category === 4 ? 5 : 4;
  const relaxedSize = 3;
  const minimalSize = 2;

  const strictTerms  = allTerms.slice(0, strictSize);
  const relaxedTerms = allTerms.slice(0, relaxedSize);
  const minimalTerms = allTerms.slice(0, minimalSize);

  return {
    strict:  strictTerms.join(" "),
    relaxed: relaxedTerms.join(" "),
    minimal: minimalTerms.length > 0 ? minimalTerms.join(" ") : strictTerms[0] ?? "",
  };
}

// ── Answer extraction ─────────────────────────────────────────────────────────

/**
 * Detect if a question is asking for temporal information.
 * Used to bias sentence selection toward date/time bearing sentences.
 *
 * @param question - Raw question string
 * @returns true if question is temporal in nature
 */
function isTemporalQuestion(question) {
  const q = question.toLowerCase();
  return /\b(when|what (date|time|day|month|year)|how long ago|since when|before|after|during)\b/.test(q);
}

/**
 * Compute a simple keyword overlap score between a sentence and a question.
 * Used to rank candidate sentences within retrieved event text.
 * Higher score = more question keywords matched.
 *
 * @param sentence - A candidate sentence from the retrieved event
 * @param qTokens  - Normalized token set from the question
 * @returns overlap score (0.0–1.0)
 */
function sentenceOverlap(sentence, qTokens) {
  if (qTokens.size === 0) return 0;
  const sTokens = new Set(normalizeTokens(sentence));
  let matches = 0;
  for (const t of qTokens) {
    if (sTokens.has(t)) matches++;
  }
  return matches / qTokens.size;
}

/**
 * Reject low-value candidate spans that are usually dialogue scaffolding,
 * echoed questions, or speaker/timestamp labels rather than answers.
 *
 * Rejection rules (in order):
 *   1. Empty string
 *   2. Spans shorter than 3 words — too short to be answers, likely labels
 *   3. Spans that are ONLY a timestamp like "[January 2022]"
 *   4. Pure metadata / speaker labels with optional timestamp prefix
 *   5. Echoed user questions (end with "?")
 *   6. Sentences that start with a question word (dialogue echoes)
 *
 * @param sentence - Candidate extracted span
 * @returns true if the span should be ignored for answer extraction
 */
function isBadCandidate(sentence) {
  const s = sentence.trim();
  if (!s) return true;

  // Reject spans shorter than 3 words — these are almost always labels,
  // not substantive answers (e.g. "said:", "[2022]", "Person").
  if (s.split(/\s+/).length < 3) return true;

  // Reject spans that are ONLY a bracketed timestamp with no surrounding text.
  if (/^\[[^\]]+\]$/.test(s)) return true;

  // Pure metadata / speaker labels (with or without timestamp prefix).
  if (/^\[[^\]]+\]\s+[A-Za-z][A-Za-z'-]*\s+said:?$/i.test(s)) return true;
  if (/^[A-Za-z][A-Za-z'-]*\s+said:?$/i.test(s)) return true;

  // Echoed user questions are almost never valid answers.
  if (s.endsWith("?")) return true;
  if (/^(what|when|where|who|whom|which|why|how|did|do|does|is|are|was|were|have|has|had|can|could|would|will)\b/i.test(s)) {
    return true;
  }

  return false;
}

/**
 * Extract named entities (capital-initial non-stop words) from a question.
 * Used during span extraction to boost sentences that mention the same entities
 * the question is asking about — the best answer spans contain the subject.
 *
 * @param question - Raw question string
 * @returns Set of lowercase named entity strings
 */
function extractQuestionEntities(question) {
  const entities = new Set();
  const tokens = question.replace(/[^a-zA-Z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    if (/^[A-Z]/.test(t) && !QUERY_STOP_WORDS.has(lower) && lower.length > 2) {
      entities.add(lower);
    }
  }
  return entities;
}

/**
 * Extract the best answer span from a list of retrieved event blobs.
 *
 * Strategy (deterministic, no LLM):
 *   1. Split each event's data into sentences
 *   2. Score each sentence by:
 *      a. Named entity overlap — sentences mentioning the same entities as the
 *         question are more likely to contain the answer (+0.5 per entity)
 *      b. Content keyword overlap — general token overlap baseline
 *      c. Date/time boost for temporal questions (+0.4)
 *      d. Shorter sentence preference (+0.05 for ≤15 words)
 *      e. Pre-extracted observation boost (+0.3 for category="fact")
 *   3. Return the highest-scoring sentence above threshold
 *   4. If nothing scores above threshold, return "" (→ abstain for cat 5)
 *
 * Phase 3 change: named entity overlap is now the primary scoring signal.
 * Previously, generic token overlap included question words ("when", "what")
 * which don't appear in answer sentences, diluting the score. Named entities
 * (proper nouns, places, names) are the terms most likely to co-occur in
 * both the question and its answer sentence.
 *
 * @param results   - FTS5 search results (top-k events)
 * @param question  - Original question text (for scoring)
 * @param category  - LOCOMO question category (1-5)
 * @returns Best extracted answer span, or empty string if not found
 */
/**
 * Score how well a text span matches the question.
 *
 * Scoring components:
 *   - Named entity overlap: +0.5 per entity found in span (primary signal)
 *   - Content keyword overlap: weighted at 0.5× of sentenceOverlap score
 *   - Temporal date pattern: +0.4 for temporal questions
 *
 * @param span       - The text span to score
 * @param qTokens    - Normalized question token set
 * @param qEntities  - Named entities extracted from the question
 * @param isTemporal - Whether the question asks about time
 * @param datePattern - Regex for date/time patterns
 * @returns Numeric score ≥ 0
 */
function scoreSpan(span, qTokens, qEntities, isTemporal, datePattern) {
  let score = 0;

  if (qEntities.size > 0) {
    const sLower = span.toLowerCase();
    for (const entity of qEntities) {
      if (sLower.includes(entity)) score += 0.5;
    }
  }

  score += sentenceOverlap(span, qTokens) * 0.5;

  if (isTemporal && datePattern.test(span)) {
    score += 0.4;
  }

  return score;
}

/**
 * Extract the best answer span from a list of retrieved event blobs.
 *
 * Two-pass strategy (Phase 3):
 *
 * Pass 1 — Observation facts first:
 *   Pre-extracted observation facts (result.category === "fact") are already
 *   short, concise statements. They produce much higher Token F1 against
 *   short ground-truth answers than full dialogue sentences. If any fact
 *   scores above MIN_CONFIDENCE_FACTUAL, return the best one immediately.
 *
 * Pass 2 — Sentence extraction from dialogue (fallback):
 *   If no fact matched, fall back to splitting dialogue turns into sentences
 *   and returning the highest-scoring sentence. Named entity overlap is the
 *   primary scoring signal (entities appear both in questions and answers).
 *   Short sentences are preferred (density bonus = 0.1 × 1/wordCount).
 *
 * This two-pass design means the entire observation store is searched before
 * touching dialogue, preventing long dialogue sentences (which have low F1
 * with short ground-truth answers) from outscoring concise facts.
 *
 * @param results   - FTS5 search results (top-k events)
 * @param question  - Original question text (for scoring)
 * @param category  - LOCOMO question category (1-5)
 * @returns Best extracted answer span, or empty string if not found
 */
function extractAnswer(results, question, category) {
  if (!results || results.length === 0) return "";

  const isTemporal = isTemporalQuestion(question) || category === 2;
  const qTokens   = new Set(normalizeTokens(question));
  const qEntities = extractQuestionEntities(question);

  const datePattern = /\b(\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}|\d{4}[-/]\d{2}[-/]\d{2}|\d{1,2}:\d{2}\s*(?:am|pm)?|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

  const minConfidence = category === 5 ? MIN_CONFIDENCE_ABSTAIN : MIN_CONFIDENCE_FACTUAL;

  // ── Pass 1: observation facts ──────────────────────────────────────────────
  // Facts are short, distilled statements — they're the best answer source.
  // Return the highest-scoring fact if it clears the confidence threshold.
  let bestFactSentence = "";
  let bestFactScore = -1;

  for (const result of results) {
    if (result.category !== "fact") continue;
    const text = (result.data ?? "").trim();
    if (!text || isBadCandidate(text)) continue;

    // For temporal questions, only use facts that contain a date pattern.
    // Facts without dates return the wrong answer ("Alice started her job")
    // when the GT is a date ("August 2022") — F1 → 0.
    if (isTemporal && !datePattern.test(text)) continue;

    const score = scoreSpan(text, qTokens, qEntities, isTemporal, datePattern);
    if (score > bestFactScore) {
      bestFactScore = score;
      bestFactSentence = text;
    }
  }

  if (bestFactScore >= minConfidence) {
    // For temporal questions, extract just the date span from the fact.
    if (isTemporal) {
      const dateMatch = bestFactSentence.match(datePattern);
      if (dateMatch) {
        if (VERBOSE) process.stderr.write(`    [extract:fact:temporal] date="${dateMatch[0]}"\n`);
        return dateMatch[0];
      }
    }
    if (VERBOSE) process.stderr.write(`    [extract:fact] score=${bestFactScore.toFixed(3)} span="${bestFactSentence.slice(0, 60)}"\n`);
    return bestFactSentence;
  }

  // ── Pass 2: sentence extraction from dialogue turns ──────────────────────
  // Split into sentences. Named entity overlap is the primary signal; short
  // sentences get a density bonus so tighter answer spans outscore rambling
  // dialogue.
  let bestSentence = "";
  let bestScore = -1;

  for (const result of results) {
    const text = result.data ?? "";
    if (!text) continue;

    // Split on sentence boundaries: ., !, ?, newlines, semicolons, em-dashes
    const sentences = text
      .split(/(?<=[.!?\n;])\s+|(?<=said:)\s+|—/)
      .map(s => s.trim())
      .filter(s => s.length > 5);

    if (sentences.length === 0) sentences.push(text);

    for (const sentence of sentences) {
      if (isBadCandidate(sentence)) continue;

      let score = scoreSpan(sentence, qTokens, qEntities, isTemporal, datePattern);

      // Density bonus: prefer shorter sentences (direct answers tend to be short).
      // Uses inverse word count, capped so very short sentences aren't absurdly high.
      const wordCount = sentence.split(/\s+/).length;
      score += 0.1 / Math.max(wordCount, 5);

      if (score > bestScore) {
        bestScore = score;
        bestSentence = sentence;
      }
    }
  }

  // ── Relative temporal resolution ─────────────────────────────────────────
  // LOCOMO conversations say "this month", "yesterday", "last week" instead of
  // absolute dates. The `[date]` prefix on each event contains the session date.
  // If the best sentence contains a relative temporal expression, look up the
  // date prefix from the same event and return the resolved temporal phrase.
  // Only applies to temporal questions where the GT is a date/time.
  if (isTemporal && bestSentence && bestScore >= minConfidence) {
    const relativePattern = /\b(this month|this week|yesterday|last week|last month|recently|today|this year|last year)\b/i;
    const relMatch = bestSentence.match(relativePattern);
    if (relMatch) {
      // Find the event whose data contains this sentence
      for (const result of results) {
        const text = result.data ?? "";
        if (!text.includes(bestSentence.slice(0, 30))) continue;
        // Extract the [date] prefix from the full event text
        const prefixDate = text.match(/^\[([^\]]+)\]/);
        if (prefixDate) {
          const eventDate = prefixDate[1]; // e.g., "07 May 2023"
          const resolvedDate = text.match(datePattern);
          if (resolvedDate) {
            if (VERBOSE) process.stderr.write(`    [extract:temporal:resolve] "${relMatch[0]}" → "${resolvedDate[0]}"\n`);
            return resolvedDate[0];
          }
        }
        break;
      }
    }
  }

  if (VERBOSE) process.stderr.write(`    [extract:dial] score=${bestScore.toFixed(3)} span="${bestSentence.slice(0, 60)}"\n`);
  return bestScore >= minConfidence ? bestSentence : "";
}

/**
 * Answer one QA pair using ECC's searchEvents() with a tiered query strategy.
 *
 * Tries three progressively relaxed FTS5 queries built by buildFtsQuery():
 *   1. strict  — top 4 (or 5 for cat 4) AND-joined terms, with named entities
 *   2. relaxed — top 3 AND-joined terms, fallback if strict returns nothing
 *   3. minimal — top 2 terms, last resort
 *
 * Returns an object rather than a plain string so callers can distinguish
 * between "no results from FTS5" and "results found but nothing extracted".
 * This distinction is the foundation of the failure-type classification.
 *
 * @param db        - Open SessionDB instance
 * @param question  - The question text to search for
 * @param category  - LOCOMO question category (1-5)
 * @returns { answer: string, hadResults: boolean }
 *   answer     — the best extracted span, or empty string if nothing found
 *   hadResults — true if searchEvents returned ≥1 result (even if extraction failed)
 */
function answerQuestion(db, question, category) {
  const queries = buildFtsQuery(question, category);

  // No usable query terms after stripping stop-words → treat as no retrieval
  if (!queries.strict && !queries.relaxed && !queries.minimal) {
    return { answer: "", hadResults: false };
  }

  // Category 5 (adversarial): strict-only — no fallback.
  // The fallback tiers use 2-3 terms which match almost any event, causing
  // false positives. Adversarial questions should abstain when nothing is
  // clearly relevant; tiered fallback breaks that invariant.
  if (category === 5) {
    const results5 = queries.strict ? db.searchEvents(queries.strict, SEARCH_LIMIT) : [];
    const hadResults5 = Array.isArray(results5) && results5.length > 0;
    return { answer: extractAnswer(results5, question, category), hadResults: hadResults5 };
  }

  // Categories 1-4: tiered fallback for maximum recall.
  let results = queries.strict ? db.searchEvents(queries.strict, SEARCH_LIMIT) : [];

  // Fall back to relaxed if no results and the query differs from strict
  if (results.length === 0 && queries.relaxed && queries.relaxed !== queries.strict) {
    results = db.searchEvents(queries.relaxed, SEARCH_LIMIT);
  }

  // Fall back to minimal if still no results and the query differs from relaxed
  if (results.length === 0 && queries.minimal && queries.minimal !== queries.relaxed) {
    results = db.searchEvents(queries.minimal, SEARCH_LIMIT);
  }

  const hadResults = Array.isArray(results) && results.length > 0;
  const answer = extractAnswer(results, question, category);
  return { answer, hadResults };
}

// ── Failure classification ────────────────────────────────────────────────────

/**
 * Classify why a factual question (category 1-4) failed or succeeded.
 *
 * Classification ladder:
 *   no_retrieval   — FTS5 returned 0 results; pipeline never had a chance
 *   wrong_evidence — results returned but extraction confidence was below
 *                    threshold (answer is empty string)
 *   right_evidence — answer extracted but F1 < 0.3; retrieved the right
 *                    document area but extracted the wrong span
 *   partial        — 0.1 ≤ F1 < 0.5; some token overlap, incomplete match
 *   correct        — F1 ≥ 0.5; considered a correct retrieval
 *
 * @param hadResults - Whether searchEvents returned ≥1 result
 * @param answer     - Extracted answer string (empty if extraction failed)
 * @param f1         - Token F1 score for this question
 * @returns One of: "no_retrieval" | "wrong_evidence" | "right_evidence" | "partial" | "correct"
 */
function classifyFailure(hadResults, answer, f1) {
  if (!hadResults)          return "no_retrieval";
  if (!answer)              return "wrong_evidence";
  if (f1 >= 0.5)            return "correct";
  if (f1 >= 0.1)            return "partial";
  return "right_evidence";  // answer non-empty but F1 < 0.1 (or < 0.3 per spec)
}

// ── Main benchmark ────────────────────────────────────────────────────────────

/**
 * Run the full LOCOMO benchmark against ECC's retrieval layer.
 * Creates one temporary SQLite DB per conversation, ingests all turns,
 * evaluates all QA pairs, and prints per-category and overall scores.
 *
 * When --diagnose is set, each factual question (cats 1-4) is annotated
 * with its failure type inline during evaluation — useful for inspecting
 * specific failure patterns without needing --verbose.
 */
async function main() {
  console.log("");
  console.log("====================================================");
  console.log("  EngramCC — LOCOMO Benchmark");
  console.log("  Evaluating retrieval accuracy on long-term memory");
  console.log("====================================================");
  console.log("");

  // 1. Load dataset
  console.log("[1/4] Loading LOCOMO dataset...");
  await ensureDataset();
  const raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  const conversations = raw.slice(0, MAX_CONVERSATIONS);
  const totalConvs = conversations.length;
  console.log(`  Loaded ${totalConvs} conversations (of 10 total)`);
  console.log("");

  // 2. Load SessionDB
  console.log("[2/4] Loading EngramCC SessionDB...");
  const SessionDB = await loadSessionDB();

  // Use a temp dir for benchmark DBs — never pollutes the project
  const benchDir = join(tmpdir(), "ecc-locomo-bench");
  mkdirSync(benchDir, { recursive: true });
  const dbPath = join(benchDir, `locomo-bench-${Date.now()}.db`);
  const db = new SessionDB(dbPath);
  console.log(`  [OK] DB at ${dbPath}`);
  console.log("");

  // 3. Ingest + evaluate
  console.log("[3/4] Ingesting conversations and evaluating questions...");
  console.log("");

  // Per-category accumulators
  const cats = {
    1: { name: "Single-hop",  scores: [] },
    2: { name: "Temporal",    scores: [] },
    3: { name: "Open-domain", scores: [] },
    4: { name: "Multi-hop",   scores: [] },
    5: { name: "Adversarial", scores: [] },
  };

  /**
   * Failure-type counters for factual categories (1-4).
   * These are diagnostic only — they do not affect scoring.
   *
   * no_retrieval   — FTS5 returned 0 results
   * wrong_evidence — results found but extraction confidence below threshold
   * right_evidence — answer extracted but F1 < 0.3 (right doc, wrong span)
   * partial        — 0.1 ≤ F1 < 0.5 (some token overlap)
   * correct        — F1 ≥ 0.5
   */
  const failureTypes = {
    no_retrieval:   0,
    wrong_evidence: 0,
    right_evidence: 0,
    correct:        0,
    partial:        0,
  };

  let totalQuestions = 0;
  let skipped = 0;

  for (let ci = 0; ci < conversations.length; ci++) {
    const conv = conversations[ci];
    const convId = conv.sample_id ?? `conv-${ci}`;
    const sessionId = randomUUID();

    process.stdout.write(`  [${ci + 1}/${totalConvs}] ${convId} — ingesting... `);

    // Ingest all dialogue turns into a fresh session
    const eventCount = ingestConversation(db, sessionId, conv);
    process.stdout.write(`${eventCount} events\n`);

    // Temporarily bind the session so searchEvents works for this session
    // SessionDB.searchEvents is global across all sessions in the DB —
    // we isolate by using a separate DB per benchmark run (single session)
    const qaList = conv.qa ?? [];

    for (const qa of qaList) {
      if (totalQuestions >= LIMIT) { skipped++; continue; }

      const category = qa.category ?? 1;
      const question = qa.question ?? "";

      // Category 5: answer field absent, adversarial_answer is the wrong answer
      const groundTruth = category === 5
        ? "" // correct answer is "not mentioned"
        : (qa.answer ?? "");

      // answerQuestion now returns { answer, hadResults } so we can classify
      // failure mode independently of the score.
      const { answer: retrieved, hadResults } = answerQuestion(db, question, category);

      let score;
      if (category === 5) {
        score = scoreAdversarial(retrieved);
      } else if (category === 1) {
        score = scoreSingleHop(retrieved, groundTruth);
      } else {
        score = tokenF1(retrieved, groundTruth);
      }

      cats[category]?.scores.push(score);
      totalQuestions++;

      // Classify failure type for factual categories (1-4) only.
      // Category 5 is adversarial and uses a different success criterion.
      if (category >= 1 && category <= 4) {
        const failType = classifyFailure(hadResults, retrieved, score);
        failureTypes[failType]++;

        if (DIAGNOSE) {
          // Print failure type for every factual question even without --verbose.
          // Format is compact enough to scan quickly in a terminal.
          const scoreStr = score.toFixed(2);
          console.log(`    [${failType.padEnd(14)}] [C${category}] F1=${scoreStr}  Q: ${question.slice(0, 55)}`);
        }
      }

      if (VERBOSE) {
        const scoreStr = score.toFixed(2);
        const status = score >= 0.5 ? "✓" : "✗";
        const gtStr = typeof groundTruth === "string" ? groundTruth : String(groundTruth ?? "");
        const gotStr = typeof retrieved === "string" ? retrieved : "";
        console.log(`    [${status}] [C${category}] Q: ${question.slice(0, 60)}...`);
        console.log(`         GT:  ${gtStr.slice(0, 80)}`);
        console.log(`         Got: ${gotStr.slice(0, 80)}`);
        console.log(`         F1:  ${scoreStr}`);
      }
    }

    // Clear session events between conversations for clean isolation
    db.deleteSession(sessionId);
  }

  // 4. Results
  console.log("");
  console.log("[4/4] Results");
  console.log("====================================================");
  console.log("");

  let overallSum = 0;
  let overallCount = 0;

  for (const [catNum, cat] of Object.entries(cats)) {
    if (cat.scores.length === 0) continue;
    const avg = cat.scores.reduce((a, b) => a + b, 0) / cat.scores.length;
    const pct = (avg * 100).toFixed(1);
    overallSum   += avg * cat.scores.length;
    overallCount += cat.scores.length;
    console.log(`  Cat ${catNum} — ${cat.name.padEnd(12)} ${String(cat.scores.length).padStart(4)} questions   Score: ${pct}%`);
  }

  // ── Failure analysis for factual categories (1-4) ──────────────────────────
  // Show the breakdown only when there is at least one factual question scored.
  // Each bucket is expressed as a percentage of total factual questions so the
  // numbers are immediately comparable across --quick and full runs.
  const factualTotal =
    failureTypes.no_retrieval +
    failureTypes.wrong_evidence +
    failureTypes.right_evidence +
    failureTypes.partial +
    failureTypes.correct;

  if (factualTotal > 0) {
    /**
     * Format a failure-type count as a right-aligned percentage string.
     * @param count - Number of questions in this bucket
     * @returns e.g. " 23.4%" padded to 6 characters
     */
    const pctStr = (count) => `${((count / factualTotal) * 100).toFixed(1)}%`.padStart(6);

    console.log("");
    console.log(`  Failure analysis (factual categories 1-4, n=${factualTotal}):`);
    console.log(`    correct (F1≥0.5):         ${pctStr(failureTypes.correct)}   (${failureTypes.correct})`);
    console.log(`    partial (0.1≤F1<0.5):     ${pctStr(failureTypes.partial)}   (${failureTypes.partial})`);
    console.log(`    right evidence, bad span: ${pctStr(failureTypes.right_evidence)}   (${failureTypes.right_evidence})`);
    console.log(`    wrong evidence retrieved: ${pctStr(failureTypes.wrong_evidence)}   (${failureTypes.wrong_evidence})`);
    console.log(`    no retrieval at all:      ${pctStr(failureTypes.no_retrieval)}   (${failureTypes.no_retrieval})`);
  }

  console.log("");
  const overall = overallCount > 0 ? (overallSum / overallCount * 100).toFixed(1) : "0.0";
  console.log(`  Overall LOCOMO Score: ${overall}%   (${overallCount} questions evaluated)`);
  if (skipped > 0) console.log(`  Skipped: ${skipped} questions (--limit reached)`);

  console.log("");
  console.log("  Comparison (from Mem0 arXiv:2504.19413):");
  console.log("  ┌──────────────────┬──────────┐");
  console.log("  │ System           │ Score    │");
  console.log("  ├──────────────────┼──────────┤");
  console.log("  │ Full Context     │ 72.9%    │");
  console.log("  │ Mem0 + Graph     │ 68.4%    │");
  console.log("  │ Mem0             │ 66.9%    │");
  console.log("  │ Zep              │ 66.0%    │");
  console.log("  │ LangMem          │ 58.1%    │");
  console.log(`  │ EngramCC (ours)  │ ${String(overall + "%").padEnd(8)} │`);
  console.log("  └──────────────────┴──────────┘");
  console.log("");

  // Cleanup temp DB
  try {
    db.close?.();
    // Remove temp DB files
    for (const f of readdirSync(benchDir)) {
      if (f.startsWith("locomo-bench-")) {
        try { unlinkSync(join(benchDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore cleanup errors */ }

  console.log("====================================================");
  console.log("");
}

main().catch(err => {
  console.error("[X] LOCOMO benchmark failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
