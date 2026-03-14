/**
 * test-scale.mjs — SLM scale & capacity benchmark.
 *
 * Responsible for: testing whether candidate SLMs maintain quality across
 * realistic production input sizes, not just the toy snippets in test-models.mjs.
 *
 * Problem: test-models.mjs uses ~50-100 word inputs. Real ECC synthesis output
 * (buildSynthesisInput) is 500-2500 words. At the context cliff (~3500+ words)
 * the model begins to truncate. This benchmark reveals where quality degrades.
 *
 * Tests:
 *   Each scale tier (S1–S4) runs three quality probes:
 *   Q1 — Conflict resolution: final decision wins under noise
 *   Q2 — Error truthfulness: unresolved error stays open
 *   Q3 — Intent extraction: current task correctly identified
 *   Q4 — No hallucination: model doesn't invent absent facts
 *
 * Scale tiers:
 *   S1 ~150 words  — minimal session
 *   S2 ~600 words  — typical single session
 *   S3 ~1500 words — heavy session (near context ceiling)
 *   S4 ~3500 words — overflow probe (exceeds 4096-token window)
 *
 * Architecture: same subprocess-per-model isolation as test-models.mjs.
 *
 * Run via: node benchmark/test-scale.mjs
 * Depends on: node-llama-cpp
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getBenchmarkModelsDir } from './models-dir.mjs';

const MODELS_DIR = (() => {
  try {
    return getBenchmarkModelsDir();
  } catch (error) {
    console.error(`\n  ${error.message}`);
    process.exit(1);
  }
})();
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
    id:                       'qwen3.5-4b',
    label:                    'Qwen 3.5 4B   (tier3b)',
    file:                     'Qwen3.5-4B-Q4_K_M.gguf',
    noThink:                  true,
    ignoreMemorySafetyChecks: true,
  },
];

// ── Archivist prompt (same as production) ─────────────────────────────────────

function buildPrompt(sessionData) {
  const wordCount = sessionData.split(/\s+/).length;
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
    sessionData,
    `</session_data>`,
    ``,
    `[FOCUS: The CURRENT TASK is the LAST active task above. Report only the FINAL state of each decision.]`,
    ``,
    `Brief:`,
  ].join('\n');
}

// ── Synthetic session data generators ─────────────────────────────────────────

/**
 * Returns a realistic ECC-style synthesis input.
 * Mirrors the structure of buildSynthesisInput() in src/handoff/writer.ts.
 *
 * The SIGNAL facts that tests will probe are stable across all scale tiers —
 * only the surrounding NOISE (extra tasks, decisions, files) grows.
 *
 * Signal facts (must survive in all summaries):
 *   - Final CSS framework decision: Tailwind CSS (not Bootstrap)
 *   - Unresolved error: auth.ts headers error on WebSocket
 *   - Current task: adding authentication middleware to GraphQL context
 *   - Non-fact: "Redis cache" is NOT mentioned anywhere (hallucination probe)
 */
function buildSession(tier) {
  // ── NOISE blocks that grow by tier ────────────────────────────────────────

  const noiseDecisions = {
    S1: '',
    S2: `
- Decided to use React 18 with concurrent features for the frontend
- Chose Prisma over TypeORM for type-safe database access
- Selected PostgreSQL over MySQL for better JSON column support
- Agreed to use Zod for runtime validation throughout the API layer
- Decided on JWT with refresh tokens over session-based auth
- Chose Apollo Client for GraphQL on the frontend`.trim(),
    S3: `
- Decided to use React 18 with concurrent features for the frontend
- Chose Prisma over TypeORM for type-safe database access
- Selected PostgreSQL over MySQL for better JSON column support
- Agreed to use Zod for runtime validation throughout the API layer
- Decided on JWT with refresh tokens over session-based auth
- Chose Apollo Client for GraphQL on the frontend
- Determined that error boundaries should wrap each route-level component
- Settled on using Vitest over Jest for faster unit test execution
- Selected Playwright for end-to-end tests instead of Cypress
- Decided to deploy on Vercel for the frontend, Railway for the API
- Agreed to use GitHub Actions for CI/CD pipeline
- Chose pnpm workspaces for the monorepo package manager
- Decided on semantic versioning and conventional commits for releases
- Selected Sentry for error tracking and Datadog for APM
- Determined that all API responses follow a { data, error, meta } envelope`.trim(),
    S4: `
- Decided to use React 18 with concurrent features for the frontend
- Chose Prisma over TypeORM for type-safe database access
- Selected PostgreSQL over MySQL for better JSON column support
- Agreed to use Zod for runtime validation throughout the API layer
- Decided on JWT with refresh tokens over session-based auth
- Chose Apollo Client for GraphQL on the frontend
- Determined that error boundaries should wrap each route-level component
- Settled on using Vitest over Jest for faster unit test execution
- Selected Playwright for end-to-end tests instead of Cypress
- Decided to deploy on Vercel for the frontend, Railway for the API
- Agreed to use GitHub Actions for CI/CD pipeline
- Chose pnpm workspaces for the monorepo package manager
- Decided on semantic versioning and conventional commits for releases
- Selected Sentry for error tracking and Datadog for APM
- Determined that all API responses follow a { data, error, meta } envelope
- Chose Stripe for payment processing with webhook signature verification
- Decided on per-tenant row-level security in PostgreSQL for multi-tenancy
- Agreed that all timestamps are stored as UTC, displayed in user timezone
- Selected Resend for transactional email, Loops for lifecycle emails
- Decided that file uploads go to Cloudflare R2 with signed URLs
- Chose tRPC as an alternative for internal service calls that don't need GraphQL
- Determined that feature flags use LaunchDarkly, not custom implementation
- Agreed that all monetary values are stored as integer cents, not floats
- Decided to implement soft deletes with deleted_at timestamp, not hard deletes
- Selected OpenTelemetry for distributed tracing across services`.trim(),
  };

  const noiseTasks = {
    S1: '',
    S2: `
Previous tasks completed this session:
- Set up Apollo Server v4 with Express adapter
- Created schema files for User, Product, Order, and Review types
- Implemented User resolver with findById and findByEmail queries
- Fixed TypeScript error: added currentUser to GraphQL Context interface
- Created Product resolver with list, findById, and create mutations
- Created Order resolver with create and findByUserId queries`.trim(),
    S3: `
Previous tasks completed this session:
- Set up Apollo Server v4 with Express adapter
- Created schema files for User, Product, Order, and Review types
- Implemented User resolver with findById and findByEmail queries
- Fixed TypeScript error: added currentUser to GraphQL Context interface
- Created Product resolver with list, findById, and create mutations
- Created Order resolver with create and findByUserId queries
- Added DataLoader for N+1 query prevention on User.orders field
- Wrote unit tests for User resolver using Vitest and mock Prisma client
- Set up database migrations for initial schema with Prisma Migrate
- Configured ESLint and Prettier for the project
- Added Husky pre-commit hooks for lint and typecheck
- Set up GitHub Actions workflow for CI (lint, typecheck, test)
- Implemented paginated product listing with cursor-based pagination
- Added input validation with Zod schemas for all mutation arguments
- Refactored context creation to use dependency injection pattern
- Set up structured JSON logging with Winston for the API server
- Added rate limiting middleware using express-rate-limit`.trim(),
    S4: `
Previous tasks completed this session:
- Set up Apollo Server v4 with Express adapter
- Created schema files for User, Product, Order, and Review types
- Implemented User resolver with findById and findByEmail queries
- Fixed TypeScript error: added currentUser to GraphQL Context interface
- Created Product resolver with list, findById, and create mutations
- Created Order resolver with create and findByUserId queries
- Added DataLoader for N+1 query prevention on User.orders field
- Wrote unit tests for User resolver using Vitest and mock Prisma client
- Set up database migrations for initial schema with Prisma Migrate
- Configured ESLint and Prettier for the project
- Added Husky pre-commit hooks for lint and typecheck
- Set up GitHub Actions workflow for CI (lint, typecheck, test)
- Implemented paginated product listing with cursor-based pagination
- Added input validation with Zod schemas for all mutation arguments
- Refactored context creation to use dependency injection pattern
- Set up structured JSON logging with Winston for the API server
- Added rate limiting middleware using express-rate-limit
- Implemented file upload support using graphql-upload and Cloudflare R2
- Created Review resolver with create, findByProduct, and delete mutations
- Added subscription support for real-time order status updates
- Implemented full-text search on Product using PostgreSQL tsvector
- Added cursor-based pagination to all list queries for consistency
- Set up database seeding script with realistic test data
- Implemented optimistic locking for concurrent order updates
- Added CORS configuration with allowlist for staging and production domains
- Created admin resolvers for user management and order reporting
- Implemented CSV export for order history using streams to avoid memory pressure
- Added Stripe webhook handler for payment confirmation events
- Set up distributed tracing with OpenTelemetry and Jaeger backend
- Wrote integration tests for the auth flow using Playwright
- Added OpenAPI documentation generation from the GraphQL schema
- Set up Redis for caching frequently accessed product catalog data
- Implemented multi-tenant support using row-level security policies
- Created database audit log triggers for user and order mutations
- Added health check endpoint with database connectivity verification`.trim(),
  };

  const noiseErrors = {
    S1: '',
    S2: `
Resolved errors this session:
- TypeError: Cannot read 'id' of undefined in ProductResolver — fixed by adding null check
- ESLint error: 'context' is defined but never used — fixed by prefixing with underscore`.trim(),
    S3: `
Resolved errors this session:
- TypeError: Cannot read 'id' of undefined in ProductResolver — fixed by adding null check
- ESLint error: 'context' is defined but never used — fixed by prefixing with underscore
- Prisma migration conflict: "A migration with the same name already exists" — resolved by resetting dev database
- TypeScript: Property 'dataSource' does not exist on type 'Context' — fixed by extending Context interface
- CORS error: blocked by same-origin policy on localhost:4000 — fixed by configuring allowed origins
- Apollo Server startup error: "Schema must contain uniquely named types" — fixed by removing duplicate type definitions`.trim(),
    S4: `
Resolved errors this session:
- TypeError: Cannot read 'id' of undefined in ProductResolver — fixed by adding null check
- ESLint error: 'context' is defined but never used — fixed by prefixing with underscore
- Prisma migration conflict: "A migration with the same name already exists" — resolved by resetting dev database
- TypeScript: Property 'dataSource' does not exist on type 'Context' — fixed by extending Context interface
- CORS error: blocked by same-origin policy on localhost:4000 — fixed by configuring allowed origins
- Apollo Server startup error: "Schema must contain uniquely named types" — fixed by removing duplicate type definitions
- DataLoader batch function returned wrong number of results — fixed by reindexing results by key
- N+1 query still firing despite DataLoader — fixed by ensuring loader is per-request not per-server
- Stripe webhook 400: "No signatures found matching the expected signature for payload" — fixed by using raw body buffer
- OpenTelemetry span context lost across async boundaries — fixed by using context.with() wrapper
- Prisma: P2002 unique constraint violation on email during seeding — fixed by upsert instead of create
- Rate limiter not applying to WebSocket upgrade requests — workaround: apply at load balancer level`.trim(),
  };

  const noiseFiles = {
    S1: 'src/graphql/schema.ts, src/graphql/resolvers/auth.ts',
    S2: 'src/graphql/schema.ts, src/graphql/resolvers/auth.ts, src/graphql/resolvers/user.ts, src/graphql/resolvers/product.ts, src/graphql/context.ts, src/middleware/rateLimit.ts, src/db/migrations/001_initial.sql',
    S3: 'src/graphql/schema.ts, src/graphql/resolvers/auth.ts, src/graphql/resolvers/user.ts, src/graphql/resolvers/product.ts, src/graphql/resolvers/order.ts, src/graphql/resolvers/review.ts, src/graphql/context.ts, src/middleware/rateLimit.ts, src/middleware/cors.ts, src/db/migrations/001_initial.sql, src/db/migrations/002_add_reviews.sql, src/loaders/userLoader.ts, src/loaders/productLoader.ts, src/validation/schemas.ts, src/logging/logger.ts, tests/unit/userResolver.test.ts, tests/unit/productResolver.test.ts, .eslintrc.json, .prettierrc, .husky/pre-commit',
    S4: 'src/graphql/schema.ts, src/graphql/resolvers/auth.ts, src/graphql/resolvers/user.ts, src/graphql/resolvers/product.ts, src/graphql/resolvers/order.ts, src/graphql/resolvers/review.ts, src/graphql/resolvers/admin.ts, src/graphql/subscriptions/orderStatus.ts, src/graphql/context.ts, src/middleware/rateLimit.ts, src/middleware/cors.ts, src/middleware/rawBody.ts, src/db/migrations/001_initial.sql, src/db/migrations/002_add_reviews.sql, src/db/migrations/003_audit_log.sql, src/db/migrations/004_rls_policies.sql, src/loaders/userLoader.ts, src/loaders/productLoader.ts, src/loaders/orderLoader.ts, src/validation/schemas.ts, src/logging/logger.ts, src/tracing/otel.ts, src/payments/stripeWebhook.ts, src/storage/r2Client.ts, src/search/productSearch.ts, src/export/orderCsv.ts, src/cache/productCache.ts, tests/unit/userResolver.test.ts, tests/unit/productResolver.test.ts, tests/integration/auth.test.ts, tests/e2e/checkout.test.ts, .eslintrc.json, .prettierrc, .husky/pre-commit, .github/workflows/ci.yml, docker-compose.yml, openapi.yaml',
  };

  // ── SIGNAL facts (constant across all tiers) ──────────────────────────────

  const signalCSSConflict = `
CSS framework decisions (chronological):
- Started with Bootstrap 5 for rapid prototyping of the UI components
- Team review flagged Bootstrap as too heavy for the bundle size target
- Switched to Tailwind CSS to reduce bundle size and improve utility-first workflow
- Confirmed final choice: Tailwind CSS is the project-wide styling standard`;

  const signalUnresolvedError = `
Active unresolved error (NOT resolved — still open):
- Error: Cannot read properties of undefined reading 'headers' at extractToken (src/graphql/middleware/auth.ts:12)
  Occurs on WebSocket connections where the HTTP headers object is absent
  Attempted fix: added connectionParams check — error persists after the edit
  Status: STILL FAILING — next session must continue debugging this`;

  const signalCurrentTask = `
Current task: Adding authentication middleware to the GraphQL context
Last action: Writing src/graphql/middleware/auth.ts — extractToken function`;

  // ── Assemble session by tier ───────────────────────────────────────────────

  const sections = [
    signalCurrentTask,
    '',
    noiseTasks[tier] ? `${noiseTasks[tier]}\n` : '',
    signalCSSConflict,
    '',
    noiseDecisions[tier] ? `Additional architectural decisions:\n${noiseDecisions[tier]}\n` : '',
    `Files modified this session:\n${noiseFiles[tier]}`,
    '',
    noiseErrors[tier] ? `${noiseErrors[tier]}\n` : '',
    signalUnresolvedError,
  ].filter(Boolean);

  return sections.join('\n');
}

const SCALE_TIERS = ['S1', 'S2', 'S3', 'S4'];

const TIER_LABELS = {
  S1: '~150 words  (minimal)',
  S2: '~600 words  (typical)',
  S3: '~1500 words (heavy)',
  S4: '~3500 words (overflow probe)',
};

// ── Quality evaluators ────────────────────────────────────────────────────────

/**
 * Q1: Final CSS decision must be Tailwind, not Bootstrap.
 */
function evalConflict(output) {
  const lower = output.toLowerCase();
  const hasTailwind = lower.includes('tailwind');
  const hasBootstrapAsFinal =
    /bootstrap\s+(is|as)\s+(the\s+)?(final|current|chosen|selected|our)/i.test(output) ||
    /finali[sz]ed.{0,30}bootstrap/i.test(output) ||
    /settled.{0,30}bootstrap/i.test(output);
  return hasTailwind && !hasBootstrapAsFinal;
}

/**
 * Q2: Must NOT claim the WebSocket/headers error was resolved.
 */
function evalErrorTruth(output) {
  const claimsFixed =
    /\berror\s+(was\s+)?(now\s+)?(fixed|resolved|solved|corrected)\b/i.test(output) ||
    /\bfixed\s+(the\s+)?(websocket|header|auth)\b/i.test(output) ||
    /\bresolved\s+(the\s+)?(websocket|header|auth)\b/i.test(output) ||
    /\b(websocket|headers?)\s+(is|are|now)\s+(working|resolved|fixed)\b/i.test(output) ||
    /\bsuccessfully\s+(fixed|resolved|patched)\b/i.test(output);
  return !claimsFixed;
}

/**
 * Q3: Must identify auth/middleware as the current task.
 */
function evalIntent(output) {
  const lower = output.toLowerCase();
  return lower.includes('auth') || lower.includes('middleware');
}

/**
 * Q4: Must NOT mention Redis (it's NOT in the session data — a hallucination trap).
 * Redis appears in S4 resolved errors (SET UP Redis) to add noise, but the
 * current session task has nothing to do with Redis. A model that mentions
 * "Redis" as an active concern or next step is hallucinating relevance.
 *
 * Note: S4 DOES mention setting up Redis as a resolved item, so a mention of
 * Redis as resolved past work is acceptable. Only flag if it appears as an
 * ongoing or future concern.
 */
function evalNoHallucination(output) {
  // Only flag Redis if presented as current work, next step, or unresolved issue
  const redisAsCurrent =
    /\bredis\b.{0,60}(next|implement|add|setup|configure|debug|fix|current|working)/i.test(output) ||
    /(next|implement|add|setup|configure|debug|fix|current|working).{0,60}\bredis\b/i.test(output);
  return !redisAsCurrent;
}

const QUALITY_CHECKS = [
  { id: 'Q1', name: 'Conflict resolution', eval: evalConflict,        hint: 'Tailwind = final CSS choice' },
  { id: 'Q2', name: 'Error truthfulness',  eval: evalErrorTruth,      hint: 'headers/auth error still open' },
  { id: 'Q3', name: 'Intent extraction',   eval: evalIntent,          hint: 'auth middleware = current task' },
  { id: 'Q4', name: 'No hallucination',    eval: evalNoHallucination, hint: 'must not invent absent concerns' },
];

// ── Single-model worker (subprocess mode) ─────────────────────────────────────

/**
 * Run all scale × quality tests for a single model.
 * Called when this script is spawned with --model-id <id>.
 * Outputs a JSON array (one entry per tier) to stdout.
 */
async function runSingleModel(modelId) {
  const modelDef = MODELS.find(m => m.id === modelId);
  if (!modelDef) { process.stderr.write(`Unknown model: ${modelId}\n`); process.exit(1); }

  const modelPath = join(MODELS_DIR, modelDef.file);

  let llamaCpp;
  try {
    llamaCpp = await import('node-llama-cpp');
  } catch {
    const fail = SCALE_TIERS.map(tier => ({ tier, failed: true, reason: 'node-llama-cpp not available', checks: [] }));
    process.stdout.write(JSON.stringify(fail) + '\n');
    return;
  }

  let llama, model, ctx, session;
  let loadError = null;
  let mode = 'unknown';

  const ctxOpts = { contextSize: 4096, ...(modelDef.ignoreMemorySafetyChecks ? { ignoreMemorySafetyChecks: true } : {}) };

  try {
    llama   = await llamaCpp.getLlama();
    model   = await llama.loadModel({ modelPath });
    ctx     = await model.createContext(ctxOpts);
    session = new llamaCpp.LlamaChatSession({ contextSequence: ctx.getSequence() });
    mode    = 'GPU (4096 ctx)';
    process.stderr.write(`  Mode: GPU inference (4096 ctx)\n`);
  } catch (gpuErr) {
    loadError = gpuErr;
    const msg = String(gpuErr instanceof Error ? gpuErr.message : gpuErr).toLowerCase();
    try { await ctx?.dispose(); } catch { /* ignore */ }
    try { await model?.dispose(); } catch { /* ignore */ }
    try { await llama?.dispose(); } catch { /* ignore */ }
    ctx = model = llama = session = null;

    if (msg.includes('vram') || msg.includes('too large') || msg.includes('out of memory')) {
      process.stderr.write(`  GPU failed — falling back to CPU\n`);
      try {
        llama   = await llamaCpp.getLlama({ gpu: false });
        model   = await llama.loadModel({ modelPath });
        ctx     = await model.createContext({ contextSize: 4096 });
        session = new llamaCpp.LlamaChatSession({ contextSequence: ctx.getSequence() });
        mode    = 'CPU (4096 ctx)';
        process.stderr.write(`  Mode: CPU inference (4096 ctx)\n`);
        loadError = null;
      } catch (cpuErr) {
        loadError = cpuErr;
      }
    }
  }

  if (!session) {
    const msg = loadError instanceof Error ? loadError.message : String(loadError);
    const fail = SCALE_TIERS.map(tier => ({ tier, failed: true, reason: msg, checks: [] }));
    process.stdout.write(JSON.stringify(fail) + '\n');
    try { await ctx?.dispose(); } catch { /* ignore */ }
    try { await model?.dispose(); } catch { /* ignore */ }
    try { await llama?.dispose(); } catch { /* ignore */ }
    return;
  }

  const tierResults = [];

  for (const tier of SCALE_TIERS) {
    const input     = buildSession(tier);
    const wordCount = input.split(/\s+/).length;
    const rawPrompt = buildPrompt(input);
    const prompt    = modelDef.noThink ? `/no_think\n\n${rawPrompt}` : rawPrompt;

    // maxTokens: allow up to 500 output tokens (matches production cap)
    const maxTokens = 500;

    process.stderr.write(`  [${tier}] ${wordCount} words — prompting...\n`);

    const t0 = Date.now();
    let output = '';
    let inferError = null;
    try {
      output = (await session.prompt(prompt, {
        maxTokens,
        temperature: 0.1,     // near-greedy — maximizes faithfulness while allowing richer outputs than temperature=0
        topK: 1,
        repeatPenalty: 1.05,
      })).trim();
    } catch (err) {
      output = '';
      inferError = err.message;
    }
    const ms = Date.now() - t0;

    const checks = QUALITY_CHECKS.map(q => ({
      id:     q.id,
      name:   q.name,
      passed: inferError ? false : q.eval(output),
      hint:   q.hint,
    }));

    tierResults.push({
      tier,
      wordCount,
      mode,
      ms,
      output: output.slice(0, 400),
      outputLen: output.length,
      inferError,
      checks,
    });

    process.stderr.write(`  [${tier}] done in ${ms}ms — ${checks.filter(c => c.passed).length}/${checks.length} passed\n`);
  }

  try { await ctx.dispose(); } catch { /* ignore */ }
  try { await model.dispose(); } catch { /* ignore */ }
  try { await llama.dispose(); } catch { /* ignore */ }

  process.stdout.write(JSON.stringify(tierResults) + '\n');
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const modelIdArg = process.argv.indexOf('--model-id');
if (modelIdArg !== -1) {
  await runSingleModel(process.argv[modelIdArg + 1]);
  process.exit(0);
}

// Print input word counts upfront so the user knows what we're testing
console.log('\n' + '═'.repeat(72));
console.log('  SLM SCALE & CAPACITY BENCHMARK — Engram Context Continuum');
console.log('═'.repeat(72));
for (const tier of SCALE_TIERS) {
  const session   = buildSession(tier);
  const wordCount = session.split(/\s+/).length;
  console.log(`  ${tier}: ${wordCount} words — ${TIER_LABELS[tier]}`);
}
console.log('  (Each model runs in an isolated subprocess for CUDA VRAM isolation)');

const allResults = [];

for (const m of MODELS) {
  const modelPath = join(MODELS_DIR, m.file);
  if (!existsSync(modelPath)) {
    console.log(`\n  [SKIP] ${m.label} — model file not found: ${m.file}`);
    allResults.push({ model: m, tierResults: null });
    continue;
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`  Testing: ${m.label}`);

  const proc = spawnSync(process.execPath, [THIS_FILE, '--model-id', m.id], {
    stdio:    ['ignore', 'pipe', 'inherit'],
    timeout:  30 * 60 * 1000,  // 30 min: 4 tiers × up to ~5 min each on CPU
    encoding: 'utf8',
  });

  let tierResults;
  if (proc.error || proc.status !== 0) {
    tierResults = SCALE_TIERS.map(tier => ({ tier, failed: true, reason: proc.error?.message ?? 'exit ' + proc.status, checks: [] }));
  } else {
    try {
      tierResults = JSON.parse(proc.stdout.trim().split('\n').pop());
    } catch {
      tierResults = SCALE_TIERS.map(tier => ({ tier, failed: true, reason: 'JSON parse error', checks: [] }));
    }
  }

  allResults.push({ model: m, tierResults });

  // Per-tier detail
  for (const tr of tierResults) {
    const session   = buildSession(tr.tier);
    const wordCount = session.split(/\s+/).length;
    const total     = tr.failed ? 0 : tr.checks.filter(c => c.passed).length;
    const icon      = tr.failed ? '!' : (total === QUALITY_CHECKS.length ? '✓' : (total >= 2 ? '~' : '✗'));

    console.log(`\n  ${icon} ${tr.tier} (${wordCount} words, ${tr.ms ?? '—'}ms${tr.mode ? ', ' + tr.mode : ''})`);
    if (tr.failed) {
      console.log(`    FAILED: ${tr.reason}`);
    } else {
      for (const c of tr.checks) {
        console.log(`    ${c.passed ? '✓' : '✗'} ${c.id} ${c.name.padEnd(24)} — ${c.hint}`);
      }
      if (tr.output) {
        console.log(`    Output: ${tr.output.replace(/\n/g, ' ')}${tr.outputLen > 400 ? '...' : ''}`);
      }
    }
  }
}

// ── Scorecard ──────────────────────────────────────────────────────────────────

console.log('\n\n' + '═'.repeat(72));
console.log('  SCALE SCORECARD  (Q1=Conflict  Q2=ErrorTruth  Q3=Intent  Q4=NoHalluc)');
console.log('═'.repeat(72));

const modelColW = 22;
const headerCols = SCALE_TIERS.map(t => t.padStart(6)).join('  ');
console.log(`\n  ${'Model'.padEnd(modelColW)}  ${headerCols}`);
console.log(`  ${'-'.repeat(modelColW)}  ${SCALE_TIERS.map(() => '------').join('  ')}`);

for (const { model, tierResults } of allResults) {
  if (!tierResults) {
    console.log(`  ${model.label.padEnd(modelColW)}  SKIP`);
    continue;
  }

  const cols = tierResults.map(tr => {
    if (tr.failed) return ' FAIL ';
    const score = tr.checks.filter(c => c.passed).length;
    const checks = tr.checks.map(c => c.passed ? '✓' : '✗').join('');
    return `${checks}`;
  });

  console.log(`  ${model.label.padEnd(modelColW)}  ${cols.map(c => c.padStart(6)).join('  ')}`);
}

console.log('');
console.log('  ✓✓✓✓ = all 4 checks passed   ✗ = at least one failed   FAIL = load/inference error');
console.log('  Q1=Conflict Q2=ErrorTruth Q3=Intent Q4=NoHallucination');
console.log('═'.repeat(72));
console.log('');
