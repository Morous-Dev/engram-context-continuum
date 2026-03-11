/**
 * test-adversarial.mjs — Real-world adversarial SLM benchmark.
 *
 * Responsible for: stress-testing candidate SLMs against realistic, hostile
 * inputs that mimic actual developer sessions. Passes only when the model
 * demonstrates production-grade faithfulness across all content types.
 *
 * Philosophy: if test-models.mjs is the driving test and test-scale.mjs is the
 * highway test, this is the obstacle course. Inputs are deliberately designed
 * to trip up small models: dominant noise, conflicting signals, code walls,
 * math, foreign language, and nothing-resolved sessions.
 *
 * Tests:
 *   A1 — Code wall:         session dominated by raw code; must summarize work, not copy code
 *   A2 — Stack trace dump:  20-line trace; must identify error, not echo the trace
 *   A3 — Pasted article:    RFC/blog pasted as context; must summarize work, not the article
 *   A4 — Math / algorithm:  Big-O, recurrences, pseudocode; must capture the algorithm decision
 *   A5 — Multilingual:      session mixes English with French/Spanish comments & messages
 *   A6 — Nothing resolved:  exploratory session; must NOT invent completion or progress
 *   A7 — Error flip-flop:   error marked resolved, then same error recurs; must report open
 *   A8 — Domain jargon:     finance/options trading session; must not hallucinate domain facts
 *   A9 — Competing tasks:   many tasks, current task is buried at the very end
 *   A10 — Long article + work: 800-word article paste + small actual work; work must win
 *
 * Architecture: same subprocess-per-model isolation as test-models.mjs.
 *
 * Run via: node benchmark/test-adversarial.mjs
 * Depends on: node-llama-cpp
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODELS_DIR = join(homedir(), '.engram-cc', 'models');
const THIS_FILE  = fileURLToPath(import.meta.url);

// ── Models ────────────────────────────────────────────────────────────────────

const MODELS = [
  {
    id:                       'llama3.2-3b',
    label:                    'Llama 3.2 3B  (tier3)',
    file:                     'llama-3.2-3b-instruct-q5_k_m.gguf',
    noThink:                  false,
    ignoreMemorySafetyChecks: false,
  },
  {
    id:                       'qwen3.5-2b',
    label:                    'Qwen 3.5 2B   (tier3b)',
    file:                     'qwen3.5-2b-q5_k_m.gguf',
    noThink:                  true,
    ignoreMemorySafetyChecks: true,
  },
];

// ── Archivist prompt (same as production) ─────────────────────────────────────

/**
 * Preprocess session data — strip code blocks, stack traces, reference docs.
 * Mirrors src/compression/preprocess.ts for benchmark accuracy.
 */
function preprocessSessionData(text) {
  let result = text;
  // Strip reference document sections (between --- delimiters, explicitly labelled)
  result = result.replace(
    /(?:reference(?:\s+material)?|pasted?(?:\s+for\s+context)?|background)[^\n]*\n---\n([\s\S]*?)---/gi,
    (_match, body) => {
      const words = body.split(/\s+/).filter(Boolean).length;
      const firstLine = body.trim().split('\n')[0]?.trim().slice(0, 80) ?? '';
      return `[REFERENCE DOCUMENT: ~${words} words${firstLine ? ` — "${firstLine}"` : ''}]`;
    }
  );
  // Strip fenced code blocks → compact placeholder
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, body) => {
    const lines = body.split('\n').filter(l => l.trim()).length;
    const firstMeaningful = body.split('\n').map(l => l.trim())
      .find(l => l && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('*'));
    const hint = firstMeaningful ? ` — ${firstMeaningful.slice(0, 60)}` : '';
    const langTag = lang ? `${lang[0].toUpperCase()}${lang.slice(1)}, ` : '';
    return `[CODE BLOCK: ${langTag}~${lines} lines${hint}]`;
  });
  // Strip stack traces → single-line summary
  result = result.replace(
    /([\w.]+(?:Exception|Error|Traceback|Error:)[^\n]{0,200})\n((?:\s+(?:at |File ")[^\n]+\n){2,})/g,
    (_match, errorLine) => {
      const clean = errorLine.replace(/^[\w.]+\.([\w]+(?:Exception|Error))/, '$1').trim();
      return `[STACK TRACE: ${clean.slice(0, 120)}]\n`;
    }
  );
  return result;
}

/** Production prompt — kept in sync with src/compression/tier3.ts buildCompressionPrompt. */
function buildPrompt(sessionData) {
  const cleaned = preprocessSessionData(sessionData);
  const wordCount = cleaned.split(/\s+/).length;
  const targetWords = Math.floor(wordCount / 3);
  return [
    `You are a senior software engineer writing a precise handoff brief for the next engineer.`,
    `You never claim errors are fixed unless the session log explicitly confirms it.`,
    `Write ${targetWords} words max. Output ONLY prose — no bullet lists, no file lists, no headings.`,
    ``,
    `RULES (mandatory — no exceptions):`,
    `1. Report ONLY the final decision on each topic. If a decision changed, report only the latest version.`,
    `2. Do NOT claim an error was fixed unless the log explicitly confirms the fix succeeded.`,
    `3. If an error appeared fixed then recurred, report it as STILL UNRESOLVED.`,
    `4. The CURRENT TASK is the LAST active, incomplete task mentioned — not the most-mentioned one.`,
    `5. Ignore code blocks marked [CODE BLOCK] — they are implementation noise, not session facts.`,
    `6. Ignore entries marked [REFERENCE DOCUMENT] — they are background material, not decisions.`,
    `7. State only facts present in the session data. Do not infer or extrapolate.`,
    `8. End with what is unfinished and what the next session should start with.`,
    ``,
    `<session_data>`,
    cleaned,
    `</session_data>`,
    ``,
    `[FOCUS: The CURRENT TASK is the LAST active task above. Report only the FINAL state of each decision.]`,
    ``,
    `Brief:`,
  ].join('\n');
}

// ── Adversarial test cases ────────────────────────────────────────────────────

const TESTS = [

  // ── A1: Code wall ───────────────────────────────────────────────────────────
  {
    id: 'A1',
    name: 'Code wall — must summarize work, not copy code',
    input: `
Current task: Implementing LRU Cache with O(1) get and put operations
Last action: Finished implementing and testing LRU Cache class

Work done:
- Designed LRU Cache using HashMap + doubly linked list
- Implemented and all tests passing

Code written this session:

class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.cache = new Map();
    this.head = { key: null, val: null, prev: null, next: null };
    this.tail = { key: null, val: null, prev: null, next: null };
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  _remove(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  _insertFront(node) {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next.prev = node;
    this.head.next = node;
  }

  get(key) {
    if (!this.cache.has(key)) return -1;
    const node = this.cache.get(key);
    this._remove(node);
    this._insertFront(node);
    return node.val;
  }

  put(key, value) {
    if (this.cache.has(key)) {
      this._remove(this.cache.get(key));
    }
    const node = { key, val: value, prev: null, next: null };
    this._insertFront(node);
    this.cache.set(key, node);
    if (this.cache.size > this.capacity) {
      const lru = this.tail.prev;
      this._remove(lru);
      this.cache.delete(lru.key);
    }
  }
}

// Tests
const cache = new LRUCache(2);
cache.put(1, 1);   // cache: {1=1}
cache.put(2, 2);   // cache: {1=1, 2=2}
cache.get(1);      // returns 1, cache: {2=2, 1=1}
cache.put(3, 3);   // evicts key 2, cache: {1=1, 3=3}
cache.get(2);      // returns -1 (not found)
cache.put(4, 4);   // evicts key 1, cache: {4=4, 3=3}
cache.get(1);      // returns -1 (not found)
cache.get(3);      // returns 3
cache.get(4);      // returns 4

Status: COMPLETE — all test cases pass.
`.trim(),
    evaluate(output) {
      const lower = output.toLowerCase();
      // Must mention LRU cache or the data structures used
      const mentionsWork = lower.includes('lru') || (lower.includes('cache') && lower.includes('linked'));
      // Must NOT copy raw code into the brief (no method signatures or node operations)
      const copiedCode =
        /this\.(head|tail|cache|capacity)/.test(output) ||
        /_remove|_insertFront|node\.prev|node\.next/.test(output) ||
        /cache\.put\(\d/.test(output);
      // Must indicate completion
      const mentionsComplete = lower.includes('complet') || lower.includes('implement') || lower.includes('finish') || lower.includes('done');
      return mentionsWork && !copiedCode && mentionsComplete;
    },
    hint: 'Must summarize the LRU Cache implementation without copying code syntax',
  },

  // ── A2: Stack trace dump ────────────────────────────────────────────────────
  {
    id: 'A2',
    name: 'Stack trace dump — identify error without echoing trace',
    input: `
Current task: Fix NullPointerException in payment processing pipeline

Error encountered (UNRESOLVED):
java.lang.NullPointerException: Cannot invoke "com.payments.Order.getCustomer()" because "order" is null
    at com.payments.PaymentProcessor.processOrder(PaymentProcessor.java:142)
    at com.payments.PaymentProcessor.processBatch(PaymentProcessor.java:98)
    at com.payments.BatchJob.run(BatchJob.java:67)
    at org.springframework.scheduling.support.DelegatingErrorHandlingRunnable.run(DelegatingErrorHandlingRunnable.java:54)
    at java.base/java.util.concurrent.Executors$RunnableAdapter.call(Executors.java:539)
    at java.base/java.util.concurrent.FutureTask.run(FutureTask.java:264)
    at java.base/java.util.concurrent.ScheduledThreadPoolExecutor$ScheduledFutureTask.run(ScheduledThreadPoolExecutor.java:304)
    at java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1136)
    at java.base/java.util.concurrent.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:635)
    at java.base/java.lang.Thread.run(Thread.java:840)

What was tried:
- Added null check before getCustomer() call at line 142 — error shifted to line 156 (getItems())
- Root cause appears to be orders saved to DB with null customer reference (data integrity issue)
- Checked 3 recent orders in DB: 2 had null customer_id FK — confirms data integrity problem

Status: Error is NOT resolved. Root cause identified (null FK in orders table) but fix not implemented.
Next step: Add NOT NULL constraint migration and fix the order creation code that allows null customer.
`.trim(),
    evaluate(output) {
      const lower = output.toLowerCase();
      // Must mention NullPointerException or null reference / payment
      const mentionsError = lower.includes('null') && (lower.includes('payment') || lower.includes('order') || lower.includes('customer'));
      // Must NOT claim it was fixed
      const claimsFixed =
        /\berror\s+(was\s+)?(now\s+)?(fixed|resolved|solved)\b/i.test(output) ||
        /\bnullpointer\w*\s+(is\s+)?(now\s+)?(fixed|resolved)\b/i.test(output) ||
        /\bsuccessfully\s+(fixed|resolved|patched)\b/i.test(output) ||
        /\bnull.{0,30}(resolved|fixed|solved)/i.test(output);
      // Must NOT copy raw stack trace lines
      const copiedTrace =
        /at com\.payments\./i.test(output) ||
        /DelegatingErrorHandling/i.test(output) ||
        /ScheduledThreadPoolExecutor/i.test(output) ||
        /java\.base\/java\./i.test(output);
      // Must mention what comes next (constraint or fix)
      const mentionsNext = lower.includes('constraint') || lower.includes('migration') || lower.includes('null check') || lower.includes('next') || lower.includes('customer');
      return mentionsError && !claimsFixed && !copiedTrace && mentionsNext;
    },
    hint: 'Must identify null FK bug without echoing stack trace or claiming it was fixed',
  },

  // ── A3: Pasted article ──────────────────────────────────────────────────────
  {
    id: 'A3',
    name: 'Pasted article — must summarize WORK, not the article',
    input: `
Current task: Implement database connection pooling for the API server
Last action: Configured pg-pool with tuned settings, load tested with k6

Reference material pasted by user (DO NOT SUMMARIZE THIS — summarize the WORK):
---
Understanding PostgreSQL Connection Pooling

Connection pooling is a technique used to maintain a cache of database connections
that can be reused for future requests. Without pooling, each database operation
requires establishing a new TCP connection, completing the authentication handshake,
and tearing down the connection afterward. For high-traffic applications, this
overhead can account for 10-30% of total query latency.

There are three main pooling strategies: connection-per-request (simplest, wasteful),
thread-local pooling (language-runtime dependent), and pool-of-connections (most
common for web servers). PostgreSQL supports up to max_connections simultaneous
connections (default 100). PgBouncer is the most popular external pooler; it
operates in three modes: session, transaction, and statement. Transaction mode is
recommended for most web applications because it releases connections between
transactions, allowing a small pool to serve many concurrent users.

Key metrics to monitor: pool utilization (should stay below 80%), wait queue depth
(spikes indicate undersizing), and connection acquisition latency (p99 should be
<5ms). The recommended starting pool size formula is: N = (core_count * 2) + 1,
where N is the total pool size per application instance. For a 4-core server, that
is 9 connections per instance. If running 3 instances, configure max_connections
to at least 27, plus headroom for migrations and admin tools.
---

Actual work done this session:
- Added pg-pool (node-postgres connection pool) to the Express API server
- Configured pool: max=10, idleTimeoutMillis=30000, connectionTimeoutMillis=2000
- Wrapped all Prisma queries in pool-aware context (Prisma already has its own pool, discovered redundancy)
- Decided: use Prisma's built-in connection pool (connection_limit=5 in DATABASE_URL) instead of pg-pool
- Removed pg-pool package, configured Prisma pool via DATABASE_URL query params
- Load tested with k6: 500 concurrent users, p99 latency 47ms — acceptable
- Unresolved: pool size needs tuning for production (currently 5, may need 10-15 under real load)
`.trim(),
    evaluate(output) {
      const lower = output.toLowerCase();
      // Must mention the actual work (Prisma pool decision)
      const mentionsWork = lower.includes('prisma') && (lower.includes('pool') || lower.includes('connection'));
      // Must mention the key decision (removed pg-pool, using Prisma built-in)
      const mentionsDecision = lower.includes('prisma') && (lower.includes('built-in') || lower.includes('removed') || lower.includes('instead') || lower.includes('connection_limit') || lower.includes('database_url'));
      // Must mention the unresolved item
      const mentionsOpen = lower.includes('production') || lower.includes('tuning') || lower.includes('pool size') || lower.includes('unresolved') || lower.includes('next');
      // Must NOT summarize the article content instead of the work
      const summarizedArticle =
        /pgbouncer/i.test(output) ||
        /session.*transaction.*statement\s+mode/i.test(output) ||
        /core_count/i.test(output) ||
        /N\s*=\s*\(core/i.test(output);
      return mentionsWork && mentionsDecision && mentionsOpen && !summarizedArticle;
    },
    hint: 'Must summarize Prisma pool decision and k6 results, not the pasted article',
  },

  // ── A4: Math / algorithm ────────────────────────────────────────────────────
  {
    id: 'A4',
    name: 'Math / algorithm — capture decision without garbling notation',
    input: `
Current task: Optimize edit distance algorithm for large string comparisons (strings up to 100K chars)
Last action: Implemented Myers diff algorithm, replacing naive Levenshtein DP

Algorithm decisions this session:
- Started with naive Levenshtein DP: O(m*n) time, O(m*n) space — too slow for 100K strings
- Considered Hirschberg's algorithm: O(m*n) time but O(min(m,n)) space — saves memory but same time complexity
- Final decision: Myers diff algorithm — O(N*D) time where N = total length, D = edit distance
  Best case (similar strings): effectively O(N), much faster than O(m*n) in practice
  Space: O(N) with the divide-and-conquer variant
  Chosen because: real session diffs are typically small (D << N), making Myers optimal

Implementation notes:
- Core diagonal traversal: k-diagonal approach, V[k] stores furthest reaching point on diagonal k
- Snake extension: extend each diagonal as far as possible before branching
- Divide & conquer for space: find midpoint of edit path recursively

Mathematical invariant maintained:
  V[k] = max x such that (x, x-k) is reachable from (0,0) in |p| forward steps
  After round p: all diagonals k ∈ {-p..p} with k ≡ p (mod 2) are computed

Performance measured:
- Levenshtein on 10K strings: 847ms
- Myers on 10K strings: 12ms (70x speedup)
- Myers on 100K strings: 180ms — meets the 200ms SLA target

Status: COMPLETE. Myers diff implemented, tested, meets SLA.
`.trim(),
    evaluate(output) {
      const lower = output.toLowerCase();
      // Must mention Myers or the final algorithm choice
      const mentionsAlgo = lower.includes('myers') || lower.includes('diff algorithm');
      // Must mention WHY it was chosen (real diffs are small / D << N / performance)
      const mentionsReason = lower.includes('edit distance') || lower.includes('faster') || lower.includes('speedup') || lower.includes('sla') || lower.includes('optimal') || /o\(n\*?d\)/i.test(output);
      // Must indicate completion
      const mentionsComplete = lower.includes('complet') || lower.includes('implement') || lower.includes('meets') || lower.includes('sla');
      // Must NOT garble the algorithm name (e.g., "Myer", "Mayer", "Diffs", "Divers")
      const garblesAlgo = /\b(mayer|meyers|divers|levenshtien)\b/i.test(output);
      // Must NOT copy the raw math invariant verbatim
      const copiedMath = /V\[k\]\s*=\s*max\s*x\s*such/.test(output);
      return mentionsAlgo && mentionsReason && mentionsComplete && !garblesAlgo && !copiedMath;
    },
    hint: 'Must capture Myers diff choice and the O(N*D) reasoning without garbling notation',
  },

  // ── A5: Multilingual ────────────────────────────────────────────────────────
  {
    id: 'A5',
    name: 'Multilingual — mixed language content, output must be English',
    input: `
Current task: Build French localization system for the e-commerce checkout flow
Last action: Completed translation of error messages, testing in progress

User messages (mixed language — session was in French):
- "Je veux ajouter la traduction française pour tout le checkout"
- "Les messages d'erreur doivent être en français aussi"
- "C'est bon pour les labels, mais les validations ne marchent pas encore"
- "Le bouton 'Confirmer la commande' doit être désactivé pendant le chargement"

Work done this session:
- Set up i18next with French locale (fr-FR) as the first non-English language
- Translated all checkout UI labels: cart summary, shipping form, payment fields
- Translated all Zod validation error messages via i18next-zod integration
- Fixed bug: French locale wasn't loading because the locale file path had a typo (fr.json vs fr-FR.json)
- Translated order confirmation email templates (subject and body)
- Remaining: the "Confirmer la commande" button disable state during async submission is broken
  — spinner shows but button re-enables prematurely, allowing double submission
  — Unresolved. Next session must fix the button state management.

Erreurs résolues:
- Le chemin du fichier de locale (fr.json → fr-FR.json) — résolu
- Les messages de validation Zod maintenant en français — résolu
`.trim(),
    evaluate(output) {
      // Output must be in English (not French)
      const frenchSentence = /\b(est|sont|pour|dans|avec|les|des|une|qui|que|nous|vous)\b/i;
      const looksLikeEnglish =
        /\b(the|was|were|has|have|been|and|for|with|this|that|are|will)\b/i.test(output);
      const isFrench = frenchSentence.test(output) && !looksLikeEnglish;

      const lower = output.toLowerCase();
      // Must mention the i18next/French localization work
      const mentionsWork = lower.includes('french') || lower.includes('locali') || lower.includes('i18n') || lower.includes('translation');
      // Must mention the unresolved double-submission bug
      const mentionsOpen = lower.includes('button') || lower.includes('double') || lower.includes('submit') || lower.includes('spinner') || lower.includes('disable') || lower.includes('confirmer') || lower.includes('next');
      // Must NOT output primarily French text
      return !isFrench && mentionsWork && mentionsOpen;
    },
    hint: 'Must produce English summary mentioning double-submission bug, not French prose',
  },

  // ── A6: Nothing resolved ────────────────────────────────────────────────────
  {
    id: 'A6',
    name: 'Nothing resolved — must NOT invent completion',
    input: `
Current task: Investigate performance regression in the search endpoint (response time went from 80ms to 1200ms after last deployment)

Work attempted this session:
- Pulled staging logs — identified the regression started at 14:32 UTC on deploy d4f7a1
- Ran EXPLAIN ANALYZE on the main search query — query plan looks unchanged (still uses idx_products_name)
- Checked if new indexes were dropped — all indexes present
- Added query timing logs to the search resolver — confirmed DB query is fast (15ms), but total response is 1200ms
- Suspect: the new product enrichment step added in d4f7a1 is calling an external vendor API per result
- Checked vendor API — it has a 200ms p50 latency, returns synchronously, called for each of 6 results = 1200ms
- Tried batching the vendor API calls with Promise.all — vendor API does not support batch requests
- Options considered:
  a) Cache vendor responses in Redis with 5-minute TTL
  b) Move enrichment to a background job and return stale data
  c) Remove vendor enrichment from the search path entirely (degrade gracefully)
- No decision made yet — need input from product team on whether vendor data is required in search results

Session ended without implementing any fix. The regression is understood but unresolved.
`.trim(),
    evaluate(output) {
      const lower = output.toLowerCase();
      // Must mention the performance regression / investigation
      const mentionsIssue = lower.includes('regression') || lower.includes('performance') || lower.includes('1200') || lower.includes('vendor') || lower.includes('search');
      // Must NOT claim anything was fixed or resolved
      const claimsFixed =
        /\b(fixed|resolved|solved|optimized|improved)\b/i.test(output) &&
        /(search|performance|regression|vendor|latency|response)/i.test(output);
      // Must indicate the session ended without a fix / awaiting decision
      const mentionsOpen =
        lower.includes('unresolved') ||
        lower.includes('no decision') ||
        lower.includes('not resolved') ||
        lower.includes('next') ||
        lower.includes('product team') ||
        lower.includes('pending') ||
        lower.includes('options') ||
        lower.includes('without');
      // Must NOT say "performance improved" or "latency reduced" etc.
      const inventedProgress =
        /\b(improved|reduced|fixed|resolved)\b.{0,30}(latency|performance|response|regression)/i.test(output) ||
        /(latency|performance|response|regression).{0,30}\b(improved|reduced|fixed|resolved)\b/i.test(output);
      return mentionsIssue && !claimsFixed && mentionsOpen && !inventedProgress;
    },
    hint: 'Must report investigation only — no fix was implemented, no decision was made',
  },

  // ── A7: Error flip-flop ─────────────────────────────────────────────────────
  {
    id: 'A7',
    name: 'Error flip-flop — error "resolved" then recurs; must report open',
    input: `
Current task: Fix race condition in the WebSocket message ordering system

Timeline of events this session:

09:12 — Identified race condition: messages arriving out of order when two clients send simultaneously
09:34 — Added mutex lock around the message queue push — race condition appeared resolved
09:41 — Error resolved: mutex approach worked in local testing with 2 clients
10:05 — Load test with 50 clients: race condition RECURRED — messages still arrive out of order
10:12 — Root cause updated: the mutex only locks the push, not the sequence number assignment
10:28 — Tried atomic sequence counter using Atomics.add() in SharedArrayBuffer — requires SharedArrayBuffer support
10:45 — SharedArrayBuffer blocked by COOP/COEP headers not set in staging environment
10:58 — Tried alternative: single-threaded message dispatcher (moved to worker thread) — implementation incomplete
11:15 — Session ended: race condition is still unresolved. Mutex approach failed under load.
        Next: either fix COOP/COEP headers to enable SharedArrayBuffer, or complete the worker thread dispatcher.
`.trim(),
    evaluate(output) {
      const lower = output.toLowerCase();
      // Must mention race condition or message ordering
      const mentionsIssue = lower.includes('race') || (lower.includes('message') && lower.includes('order')) || lower.includes('websocket');
      // Must NOT claim the race condition was ultimately resolved.
      // IMPORTANT: use \b word boundaries so "unresolved" does NOT match (resolved).
      // Without \b, "race condition...unresolved" falsely triggers the pattern because
      // "unresolved" contains "resolved" as a substring.
      const claimsResolved =
        /race\s*condition.{0,60}\b(resolved|fixed|solved)\b/i.test(output) ||
        /\b(resolved|fixed|solved)\b.{0,60}race\s*condition/i.test(output) ||
        /mutex.{0,40}\b(resolved|fixed|solved|worked)\b/i.test(output) ||
        /\bsuccessfully\s+(fixed|resolved)\b/i.test(output);
      // Must mention it's still open / what comes next
      const mentionsOpen =
        lower.includes('still') ||
        lower.includes('unresolved') ||
        lower.includes('recurred') ||
        lower.includes('failed') ||
        lower.includes('next') ||
        lower.includes('coop') ||
        lower.includes('worker') ||
        lower.includes('incomplete');
      return mentionsIssue && !claimsResolved && mentionsOpen;
    },
    hint: 'Mutex briefly "worked" then failed; must report race condition as still open',
  },

  // ── A8: Domain jargon ──────────────────────────────────────────────────────
  {
    id: 'A8',
    name: 'Domain jargon — finance session, must not hallucinate domain facts',
    input: `
Current task: Build options Greeks calculator for the trading dashboard
Last action: Implemented Black-Scholes Delta and Gamma, Theta pending

Work done this session:
- Implemented Black-Scholes formula for European call/put pricing
- Added Delta calculation: ∂V/∂S = N(d1) for calls, N(d1) - 1 for puts
- Added Gamma calculation: ∂²V/∂S² = N'(d1) / (S * σ * √T)
- Unit tested against known option prices (AAPL 180C exp Jan 2026: Delta 0.62, Gamma 0.031)

Decisions made:
- Using risk-free rate: 5.25% (current Fed Funds Rate as of session date)
- Volatility source: 30-day realized volatility from market data feed, NOT implied volatility
  Reason: implied vol requires options chain data we don't have in the current data feed

Unresolved:
- Theta (time decay): ∂V/∂t formula requires careful sign convention — not yet implemented
- Vega and Rho: deferred to next session
- No Vanna or Volga (second-order cross-Greeks) — explicitly out of scope
`.trim(),
    evaluate(output) {
      const lower = output.toLowerCase();
      // Must mention Greeks or Black-Scholes work
      const mentionsWork = lower.includes('black-scholes') || lower.includes('delta') || lower.includes('greek') || lower.includes('option');
      // Must mention what's unresolved (theta or vega)
      const mentionsOpen = lower.includes('theta') || lower.includes('vega') || lower.includes('time decay') || lower.includes('next');
      // Must NOT hallucinate Greeks that were explicitly ruled out
      const hallucintatesRuledOut =
        /\b(vanna|volga)\b/i.test(output) &&
        /(implement|add|complet|build|calculat)/i.test(output);
      // Must NOT invent wrong volatility source (must be realized vol, not implied)
      const wrongVolSource =
        /implied\s+vol/i.test(output) &&
        !(lower.includes('not') || lower.includes('instead') || lower.includes('realized'));
      return mentionsWork && mentionsOpen && !hallucintatesRuledOut && !wrongVolSource;
    },
    hint: 'Must mention Theta as pending; must not invent Vanna/Volga or wrong volatility source',
  },

  // ── A9: Competing tasks / buried current task ────────────────────────────────
  {
    id: 'A9',
    name: 'Competing tasks — current task buried at end, must not be missed',
    input: `
Session log — long day with many tasks:

08:00 — Task: Set up new monorepo with Turborepo
  Done: Initialized workspace, configured turbo.json, set up shared tsconfig
09:30 — Task: Migrate authentication service from Express to Fastify
  Done: Rewrote auth routes in Fastify, updated middleware, all tests passing
11:00 — Task: Add OpenAPI spec generation from Fastify schema definitions
  Done: Integrated @fastify/swagger, added schema to all auth routes, spec generates correctly
12:30 — Task: Set up Vitest for unit testing across all packages
  Done: Configured vitest.workspace.ts, added shared setup file, all existing tests migrated
14:00 — Task: Add rate limiting to the public API endpoints
  Done: Integrated @fastify/rate-limit with Redis backend, configured per-route limits
15:30 — Task: Debug memory leak in the event emitter inside the WebSocket handler
  Done: Found that listeners were never removed on client disconnect — fixed with explicit cleanup in the disconnect handler
16:45 — Task: Add structured logging with correlation IDs for distributed tracing
  Done: Integrated Pino logger, added correlationId middleware, propagates through async context
17:30 — Current task (IN PROGRESS, NOT COMPLETE): Implement JWT refresh token rotation
  Status: Partial — access token generation works, refresh token storage in Redis is done,
          but the token rotation endpoint (/auth/refresh) returns 500 when the old token is
          invalidated before the new one is issued. Race condition in token rotation logic.
          This is where the next session must continue.
`.trim(),
    evaluate(output) {
      const lower = output.toLowerCase();
      // Must identify the current incomplete task: JWT refresh token rotation
      const mentionsCurrentTask =
        lower.includes('refresh') && lower.includes('token') ||
        lower.includes('jwt') ||
        lower.includes('token rotation') ||
        lower.includes('/auth/refresh');
      // Must mention the race condition or the 500 error as unresolved
      const mentionsOpen =
        lower.includes('race') ||
        lower.includes('500') ||
        lower.includes('incomplete') ||
        lower.includes('rotation') ||
        (lower.includes('not') && lower.includes('complet'));
      // Should NOT only describe the earlier (completed) tasks as "current"
      const wrongCurrentTask =
        (lower.includes('current') || lower.includes('next')) &&
        (lower.includes('turborepo') || lower.includes('monorepo') || lower.includes('fastify migration') || lower.includes('openapi'));
      return mentionsCurrentTask && mentionsOpen && !wrongCurrentTask;
    },
    hint: 'Must identify JWT refresh token rotation (with 500 error) as the current task',
  },

  // ── A10: Long article + small work ─────────────────────────────────────────
  {
    id: 'A10',
    name: 'Long article + small work — work must dominate the summary',
    input: `
Current task: Add full-text search to product catalog using PostgreSQL tsvector
Last action: Created GIN index on search_vector column, tested with to_tsquery

Reference article pasted for context (summarize the WORK below, not this article):
---
Full-Text Search in PostgreSQL: A Complete Guide

Full-text search (FTS) in PostgreSQL is implemented through two primary data types:
tsvector and tsquery. A tsvector is a sorted list of distinct lexemes (normalized
tokens) from a document, along with their positions. A tsquery contains lexemes to
search for, optionally combined with boolean operators.

The to_tsvector(config, text) function converts text to a tsvector using the
specified text search configuration (e.g., 'english'). Common configurations
include 'english', 'french', 'simple'. The configuration determines which dictionary
is used for stemming: 'english' reduces "running", "runs", "ran" to the lexeme "run".

For performance, PostgreSQL supports two index types for FTS: GiST and GIN.
GiST indexes are faster to build but slower to search. GIN indexes take longer
to build but are significantly faster for lookups, making them the standard choice
for read-heavy FTS workloads. GIN indexes also support partial updates with the
FASTUPDATE storage parameter.

Ranking results uses ts_rank() or ts_rank_cd() (cover density). ts_rank assigns
higher scores to documents where search terms appear more frequently. ts_rank_cd
also considers how close together the terms appear in the document. For product
search where term proximity matters (e.g., "red shoes" should rank higher than
documents with "red" and "shoes" far apart), ts_rank_cd is preferred.

Phrase search uses the <-> distance operator: 'red <-> shoes' matches documents
where "red" is immediately followed by "shoes". The <N> variant allows N words
between terms. Prefix search uses :* — 'graph:*' matches "graphql", "graphic", etc.
---

Actual work done this session:
- Added search_vector column (type tsvector) to the products table via migration
- Created trigger: automatically updates search_vector on INSERT/UPDATE using
  to_tsvector('english', name || ' ' || description || ' ' || category)
- Created GIN index on search_vector (migration: 20260312_add_fts_gin_index)
- Added search resolver in GraphQL: accepts query string, uses to_tsquery with prefix (:*)
- Tested: "graph" query returns GraphQL books and Graphic novels — prefix search working
- Tested: "running shoes" returns ranked results with ts_rank_cd — proximity ranking working
- Performance: 50ms for 100K product catalog (was 3200ms with ILIKE %query%)
- Unresolved: synonyms not handled (e.g., "sneaker" does not find "running shoes" — needs custom dictionary)
`.trim(),
    evaluate(output) {
      const lower = output.toLowerCase();
      // Must mention the actual work: tsvector, GIN index, or the search implementation
      const mentionsWork =
        lower.includes('tsvector') ||
        lower.includes('gin') ||
        lower.includes('full-text') ||
        lower.includes('full text') ||
        lower.includes('search_vector') ||
        (lower.includes('search') && lower.includes('postgres'));
      // Must mention the performance improvement or the test results
      const mentionsResult =
        lower.includes('50ms') || lower.includes('3200ms') || lower.includes('64x') ||
        lower.includes('performance') || lower.includes('prefix') || lower.includes('rank');
      // Must mention what's unresolved (synonyms)
      const mentionsOpen =
        lower.includes('synonym') || lower.includes('sneaker') || lower.includes('custom dictionary') ||
        lower.includes('unresolved') || lower.includes('next');
      // Must NOT summarize the article instead of the work
      const summarizedArticle =
        /ts_rank.{0,30}(assigns|scores|frequency)/i.test(output) ||
        /gist.{0,30}(faster to build|slower to search)/i.test(output) ||
        /cover\s+density/i.test(output) ||
        /fastupdate\s+storage/i.test(output);
      return mentionsWork && mentionsResult && mentionsOpen && !summarizedArticle;
    },
    hint: 'Must summarize the GIN index + GraphQL search work; not the pasted FTS article',
  },

];

// ── Single-model worker (subprocess mode) ─────────────────────────────────────

async function runSingleModel(modelId) {
  const modelDef = MODELS.find(m => m.id === modelId);
  if (!modelDef) { process.stderr.write(`Unknown model: ${modelId}\n`); process.exit(1); }

  const modelPath = join(MODELS_DIR, modelDef.file);

  let llamaCpp;
  try {
    llamaCpp = await import('node-llama-cpp');
  } catch {
    const fail = TESTS.map(() => ({ passed: false, output: '[node-llama-cpp not available]', ms: 0 }));
    process.stdout.write(JSON.stringify(fail) + '\n');
    return;
  }

  let llama, model;
  let loadError = null;

  // ctxOpts used for every per-test context creation
  const ctxOpts = { contextSize: 4096, ...(modelDef.ignoreMemorySafetyChecks ? { ignoreMemorySafetyChecks: true } : {}) };

  // Load model once; contexts are created fresh per test (see loop below)
  try {
    llama = await llamaCpp.getLlama();
    model = await llama.loadModel({ modelPath });
    process.stderr.write(`  Mode: GPU inference (4096 ctx per test)\n`);
  } catch (gpuErr) {
    loadError = gpuErr;
    const msg = String(gpuErr instanceof Error ? gpuErr.message : gpuErr).toLowerCase();
    try { await model?.dispose(); } catch { /* ignore */ }
    try { await llama?.dispose(); } catch { /* ignore */ }
    model = llama = null;

    if (msg.includes('vram') || msg.includes('too large') || msg.includes('out of memory')) {
      try {
        llama = await llamaCpp.getLlama({ gpu: false });
        model = await llama.loadModel({ modelPath });
        process.stderr.write(`  Mode: CPU inference (4096 ctx per test)\n`);
        loadError = null;
      } catch (cpuErr) { loadError = cpuErr; }
    }
  }

  if (!model) {
    const msg = loadError instanceof Error ? loadError.message : String(loadError);
    const fail = TESTS.map(() => ({ passed: false, output: `[load failed: ${msg}]`, ms: 0 }));
    process.stdout.write(JSON.stringify(fail) + '\n');
    try { await ctx?.dispose(); } catch { /* ignore */ }
    try { await model?.dispose(); } catch { /* ignore */ }
    try { await llama?.dispose(); } catch { /* ignore */ }
    return;
  }

  // Dispose the initial context+session — each test gets its own fresh context so
  // accumulated conversation history from large adversarial prompts doesn't OOM.
  try { await ctx?.dispose(); } catch { /* ignore */ }
  // ctx and session are not declared at this scope (fresh per-test); nothing to null.

  const results = [];
  for (const test of TESTS) {
    // Fresh context per test: adversarial prompts are large (code walls, articles, stack
    // traces). Reusing one session accumulates history until the 4096-token window fills
    // and Node's heap OOMs. A fresh context per test also matches production behaviour
    // where each session compression is an independent single-prompt call.
    let testCtx, testSession;
    try {
      testCtx     = await model.createContext(ctxOpts);
      testSession = new llamaCpp.LlamaChatSession({ contextSequence: testCtx.getSequence() });
    } catch (ctxErr) {
      results.push({ passed: false, output: `[context create failed: ${ctxErr.message}]`, ms: 0 });
      continue;
    }

    const rawPrompt = buildPrompt(test.input);
    const prompt    = modelDef.noThink ? `/no_think\n\n${rawPrompt}` : rawPrompt;
    const wordCount = test.input.split(/\s+/).length;
    const targetTokens = Math.ceil(wordCount / 3 * 1.5);
    const maxTokens = Math.max(150, Math.min(targetTokens, 500));

    const t0 = Date.now();
    let output = '';
    try {
      output = (await testSession.prompt(prompt, {
        maxTokens,
        temperature: 0.1,     // near-greedy — maximizes faithfulness while allowing richer outputs than temperature=0
        topK: 1,
        repeatPenalty: 1.05,
      })).trim();
    } catch (err) {
      output = `[inference error: ${err.message}]`;
    }
    const ms = Date.now() - t0;

    try { await testCtx.dispose(); } catch { /* ignore */ }

    process.stderr.write(`  ${test.id}: ${ms}ms — ${test.evaluate(output) ? 'PASS' : 'FAIL'}\n`);
    results.push({ passed: test.evaluate(output), output, ms });
  }

  try { await model.dispose(); } catch { /* ignore */ }
  try { await llama.dispose(); } catch { /* ignore */ }

  process.stdout.write(JSON.stringify(results) + '\n');
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const modelIdArg = process.argv.indexOf('--model-id');
if (modelIdArg !== -1) {
  await runSingleModel(process.argv[modelIdArg + 1]);
  process.exit(0);
}

console.log('\n' + '═'.repeat(72));
console.log('  SLM ADVERSARIAL BENCHMARK — Engram Context Continuum');
console.log('═'.repeat(72));
console.log('  10 real-world hostile scenarios — code walls, traces, math,');
console.log('  multilingual, nothing-resolved, flip-flop errors, domain jargon');
console.log('  (Each model runs in an isolated subprocess for CUDA VRAM isolation)');

const allResults = [];

for (const m of MODELS) {
  const modelPath = join(MODELS_DIR, m.file);
  if (!existsSync(modelPath)) {
    console.log(`\n  [SKIP] ${m.label} — model file not found: ${m.file}`);
    allResults.push({ model: m, results: null });
    continue;
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`  Testing: ${m.label}`);

  const proc = spawnSync(process.execPath, [THIS_FILE, '--model-id', m.id], {
    stdio:    ['ignore', 'pipe', 'inherit'],
    timeout:  30 * 60 * 1000,
    encoding: 'utf8',
  });

  let results;
  if (proc.error || proc.status !== 0) {
    results = TESTS.map(() => ({ passed: false, output: `[subprocess failed: ${proc.error?.message ?? 'exit ' + proc.status}]`, ms: 0 }));
  } else {
    try {
      results = JSON.parse(proc.stdout.trim().split('\n').pop());
    } catch {
      results = TESTS.map(() => ({ passed: false, output: '[JSON parse error]', ms: 0 }));
    }
  }

  allResults.push({ model: m, results });

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const r = results[i];
    const icon = r.passed ? '✓' : '✗';
    console.log(`\n  ${icon} ${t.id}: ${t.name} (${r.ms}ms)`);
    console.log(`    Hint: ${t.hint}`);
    console.log(`    Output: ${r.output.slice(0, 220).replace(/\n/g, ' ')}${r.output.length > 220 ? '...' : ''}`);
  }
}

// ── Scorecard ──────────────────────────────────────────────────────────────────

console.log('\n\n' + '═'.repeat(72));
console.log('  ADVERSARIAL SCORECARD');
console.log('═'.repeat(72));
console.log('');

const colW = 24;
const testCols = TESTS.map(t => t.id).join('  ');
console.log(`  ${'Model'.padEnd(colW)}  ${testCols}  Total`);
console.log(`  ${'-'.repeat(colW)}  ${TESTS.map(t => '--').join('  ')}  -----`);

for (const { model, results } of allResults) {
  if (!results) {
    console.log(`  ${model.label.padEnd(colW)}  SKIP`);
    continue;
  }
  const icons  = results.map(r => r.passed ? '✓' : '✗');
  const total  = results.filter(r => r.passed).length;
  console.log(`  ${model.label.padEnd(colW)}  ${icons.join('   ')}  ${total}/${TESTS.length}`);
}

console.log('');
console.log('  Tests: A1=CodeWall A2=StackTrace A3=PastedArticle A4=Math');
console.log('         A5=Multilingual A6=NothingResolved A7=ErrorFlipFlop');
console.log('         A8=DomainJargon A9=BuriedTask A10=ArticleNoise');
console.log('═'.repeat(72));
console.log('');
