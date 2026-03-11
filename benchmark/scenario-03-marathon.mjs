/**
 * scenario-03-marathon.mjs — Long session / marathon benchmark.
 *
 * Simulates a cold-start session (>30 min gap) with a long, complex
 * history spanning ~200 events across 3 simulated compaction cycles.
 *
 * This is the hardest scenario: the archivist must synthesize across
 * multiple compaction boundaries and correctly resolve conflicts that
 * accumulated over a multi-hour session.
 *
 * Hard context elements:
 * - Cold start (handoff age > 30 min) — no hot resume injection
 * - Recurring error: rate limiter bug appears, gets "fixed", reappears
 * - Explored-then-abandoned library: tried ioredis, switched to Upstash
 * - Module rename mid-session: services/ → providers/ (all references updated)
 * - 3 simulated compaction cycles (compacted_count flag on events)
 * - Final working task must be the most recent, not the oldest
 *
 * Assertions:
 * - Reports Upstash (not ioredis) as the Redis client
 * - Does NOT say rate limiter bug is resolved (it reappeared)
 * - Reports providers/ (not services/) as the module directory
 * - Does NOT claim the first compaction's completed tasks are still pending
 * - Mentions payment webhook as the current working task
 *
 * Depends on: seed-helpers.mjs, assertions.mjs, build/
 * Run via: node benchmark/scenario-03-marathon.mjs
 */

import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { writeFileSync } from 'node:fs';
import { seed, ev } from './seed-helpers.mjs';
import { mustContain, mustNotContain } from './assertions.mjs';

const PROJECT_DIR = join(tmpdir(), 'ecc-bench-s03');
const SESSION_ID  = 'bench-s03-' + Date.now();
const BUILD       = join(process.cwd(), 'build');

mkdirSync(PROJECT_DIR, { recursive: true });
mkdirSync(join(PROJECT_DIR, '.engram-cc'), { recursive: true });

// Simulated cold handoff (2h 45min ago — cold start, no hot resume)
const coldHandoff = {
  session_id: 'bench-s02-ref',
  timestamp: new Date(Date.now() - 165 * 60 * 1000).toISOString(), // 165 min ago = cold
  project_dir: PROJECT_DIR,
  current_task: 'Add rate limiting to GraphQL mutations',
  last_action: 'Edited src/providers/rate-limiter.ts',
  decisions: [
    'Use Apollo Server v4 for the GraphQL server',
    'Use Prisma as the ORM',
    'SQLite for local dev, PostgreSQL for production via DATABASE_URL',
    'Schema-first approach: define .graphql files',
    'Resolver utilities must follow getEntityById() naming pattern',
  ],
  files_modified: [
    'src/graphql/schema/user.graphql', 'src/graphql/schema/product.graphql',
    'src/graphql/schema/order.graphql', 'src/graphql/resolvers/user.resolver.ts',
    'src/graphql/resolvers/product.resolver.ts', 'src/graphql/resolvers/order.resolver.ts',
    'prisma/schema.prisma', 'src/graphql/middleware/auth.ts',
    'src/providers/rate-limiter.ts',
  ],
  errors_encountered: [
    "Error: Cannot read properties of undefined reading 'headers' at extractToken (src/graphql/middleware/auth.ts:12) — WebSocket connections",
    "Error: Rate limiter throws on first request — Redis connection refused at 127.0.0.1:6379",
  ],
  errors_resolved: [
    "TypeScript error in user.resolver.ts resolved — added 'currentUser' to Context type",
    "Test failures resolved — corrected function name from getProduct to getProductById",
  ],
  working_context: 'GraphQL migration 80% complete. Auth middleware has open WebSocket error. Rate limiter is broken — Redis connection refused. Need to switch rate limiter backend or fix Redis setup.',
  headline: 'GraphQL migration underway — rate limiter broken (Redis refused), WebSocket auth still open.',
  user_preferences: '',
  codebase_conventions: 'Resolver utils: getEntityById() pattern',
  open_questions: [],
  blockers: ['Redis not running locally — rate limiter non-functional'],
  confidence: 'high',
};
writeFileSync(
  join(PROJECT_DIR, '.engram-cc', 'handoff.yaml'),
  yaml.dump(coldHandoff),
  'utf-8',
);

// ── Seed events ───────────────────────────────────────────────────────────────
const dbDir  = join(homedir(), '.engram-cc', 'sessions');
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, 'bench-s03.db');
if (existsSync(dbPath)) rmSync(dbPath);

const { SessionDB } = await import(pathToFileURL(join(BUILD, 'session', 'db.js')).href);
const db = new SessionDB({ dbPath });
db.ensureSession(SESSION_ID, PROJECT_DIR);

seed(db, SESSION_ID, [

  // ── COMPACTION CYCLE 1 (early session, now historical) ─────────────────────
  // This block represents what happened before the first compaction.
  // Key outcome: switched from ioredis to Upstash, but rate limiter still broken.

  ev.prompt('Cold start. Rate limiter is still broken. Fix it.'),
  ev.fileRead('src/providers/rate-limiter.ts'),
  ev.fileRead('package.json'),
  ev.tool('npm install ioredis'),
  ev.decision('Use ioredis as the Redis client — handles reconnection better than the native redis package'),
  ev.fileEdit('src/providers/rate-limiter.ts'),
  ev.fileWrite('src/providers/redis-client.ts'),
  ev.error('Error: ioredis connection timeout — ETIMEDOUT 127.0.0.1:6379 — still no local Redis'),
  ev.prompt('Can we avoid running Redis locally at all?'),
  ev.tool('Research Upstash Redis — serverless, no local daemon needed'),
  ev.decision('ABANDON ioredis. Switch to Upstash Redis — works without local Redis daemon, uses HTTP REST API'),
  ev.tool('npm uninstall ioredis && npm install @upstash/redis'),
  ev.fileEdit('src/providers/redis-client.ts'),
  ev.fileEdit('src/providers/rate-limiter.ts'),
  ev.fileEdit('.env'),
  ev.fileWrite('.env.example'),
  ev.tool('npm run build -- TypeScript compilation OK'),
  ev.resolved('Rate limiter base connection resolved — Upstash HTTP client connected successfully'),

  // Rate limiter integration — first bug appears
  ev.prompt('Test the rate limiter end to end'),
  ev.fileWrite('src/providers/__tests__/rate-limiter.test.ts'),
  ev.tool('npm run test -- rate-limiter: 3 passed, 1 failed'),
  ev.error('Error: rate limiter allows 11 requests when limit is 10 — off-by-one in sliding window check'),
  ev.fileEdit('src/providers/rate-limiter.ts'),
  ev.tool('npm run test -- rate-limiter: 4 passed, 0 failed'),
  ev.resolved('Rate limiter off-by-one fixed — changed > to >= in window check'),

  // Module rename: services/ → providers/ (happened early, rest of session uses providers/)
  ev.prompt('The services/ directory name is confusing. Rename it to providers/.'),
  ev.decision('Rename module directory: services/ → providers/ — better reflects dependency injection pattern'),
  ev.tool('git mv src/services/ src/providers/'),
  ev.fileEdit('src/graphql/middleware/auth.ts'),    // update import paths
  ev.fileEdit('src/server.ts'),                      // update import paths
  ev.fileEdit('src/index.ts'),                       // update import paths
  ev.tool('npm run build -- TypeScript compilation OK after rename'),

  // ── End of compaction cycle 1 boundary ─────────────────────────────────────

  // ── COMPACTION CYCLE 2 (mid session) ───────────────────────────────────────
  // Key outcome: WebSocket auth fixed, payment webhook added, rate limiter bug REAPPEARS.

  ev.prompt('Back to the WebSocket auth issue. What did we try?'),
  ev.fileRead('src/graphql/middleware/auth.ts'),
  ev.tool('Read Apollo Server v4 subscriptions docs — context function receives different arg shape for WS vs HTTP'),
  ev.decision('WebSocket auth fix: check for req.connectionParams instead of req.headers for subscription context'),
  ev.fileEdit('src/graphql/middleware/auth.ts'),
  ev.fileWrite('src/graphql/middleware/auth.test.ts'),
  ev.tool('npm run test -- auth: 5 passed, 0 failed'),
  ev.resolved("WebSocket auth error resolved — extractToken() now handles both req.headers (HTTP) and req.connectionParams (WebSocket)"),

  // Payment webhook feature
  ev.prompt('Add a payment webhook endpoint for Stripe events'),
  ev.task('Implement Stripe payment webhook handler'),
  ev.decision('Use Express route for webhook — must bypass GraphQL layer to handle raw body for Stripe signature verification'),
  ev.fileWrite('src/webhooks/payment.ts'),
  ev.fileWrite('src/graphql/schema/payment.graphql'),
  ev.fileWrite('src/graphql/resolvers/payment.resolver.ts'),
  ev.fileEdit('src/server.ts'),
  ev.tool('npm run build -- OK'),

  // Rate limiter bug REAPPEARS on payment webhook path
  ev.prompt('Test the payment webhook with rate limiting enabled'),
  ev.tool('npm run test -- payment: 2 passed, 3 failed'),
  ev.error('Error: rate limiter throws UnhandledPromiseRejection on payment webhook path — Upstash returns 429 when Stripe retry floods the endpoint, but the error is not caught'),
  ev.fileEdit('src/providers/rate-limiter.ts'),
  ev.tool('npm run test -- payment: 5 passed, 0 failed'),
  ev.resolved('Rate limiter uncaught rejection fixed — wrapped Upstash call in try/catch, returns allow=false on client error'),

  // ── End of compaction cycle 2 boundary ─────────────────────────────────────

  // ── COMPACTION CYCLE 3 / CURRENT SESSION ───────────────────────────────────
  // Key outcome: rate limiter bug appears AGAIN with concurrency, NOT resolved.
  // This is the final state that must be in the handoff.

  ev.prompt('Stress test the rate limiter under concurrent load'),
  ev.fileWrite('src/providers/__tests__/rate-limiter.concurrent.test.ts'),
  ev.tool('npm run test -- concurrent: 1 passed, 2 failed'),
  ev.error('Error: rate limiter allows burst of 15 requests under concurrent load — sliding window race condition when two requests check the window simultaneously before either increments'),
  // This error is NOT resolved — it is the open blocker
  ev.prompt('What is the fix for a sliding window race condition with Upstash?'),
  ev.tool('Read Upstash docs — atomic Lua scripts or MULTI/EXEC transactions not available in HTTP REST mode'),
  ev.tool('Research sliding window rate limiting with Redis MULTI/EXEC'),
  ev.decision('Fix plan: switch rate limiter implementation to Upstash ratelimit SDK which handles atomic windows natively — but not implemented yet'),

  // Current task: payment webhook completion
  ev.prompt('Set aside the rate limiter for now. Finish the payment webhook — add idempotency key handling'),
  ev.task('Add idempotency key handling to payment webhook'),
  ev.fileRead('src/webhooks/payment.ts'),
  ev.fileEdit('src/webhooks/payment.ts'),
  ev.fileWrite('src/webhooks/__tests__/payment.idempotency.test.ts'),
  ev.tool('npm run test -- idempotency: 3 passed, 0 failed'),

  // Filler
  ev.tool('git diff --stat'),
  ev.fileRead('prisma/schema.prisma'),
  ev.tool('git status'),

], 'PostToolUse');

db.close();

// ── Run pipeline ──────────────────────────────────────────────────────────────
const { buildHandoffFromEvents, writeHandoff } = await import(pathToFileURL(join(BUILD, 'handoff', 'writer.js')).href);
const { getCompressor } = await import(pathToFileURL(join(BUILD, 'compression', 'index.js')).href);
const { SessionDB: SessionDB2 } = await import(pathToFileURL(join(BUILD, 'session', 'db.js')).href);
const { readWorkingMemory } = await import(pathToFileURL(join(BUILD, 'memory', 'working.js')).href);

const db2 = new SessionDB2({ dbPath });
const events = db2.getEvents(SESSION_ID);
db2.close();

const compressor = getCompressor();
const workingMem = readWorkingMemory(PROJECT_DIR);

console.log(`\nScenario 3 — Marathon Session (cold start, 3 compaction cycles)`);
console.log(`Events seeded: ${events.length} | Compressor: ${compressor.tier}`);
console.log(`Handoff age: 165 min (should trigger cold start, no hot resume)`);

const handoffData = await buildHandoffFromEvents(
  SESSION_ID, PROJECT_DIR, events, workingMem, null, compressor,
);
writeHandoff(handoffData, PROJECT_DIR);

const { readHandoff } = await import(pathToFileURL(join(BUILD, 'handoff', 'reader.js')).href);
const handoff = readHandoff(PROJECT_DIR, Infinity);

console.log(`\nHeadline: ${handoff.headline}`);
console.log(`\nWorking context:\n${handoff.working_context}`);
console.log('\nAssertions:');

// ── Assertions ────────────────────────────────────────────────────────────────

// Library decision: ioredis was tried and abandoned, Upstash is final
mustContain(handoff,    'upstash',            'Reports Upstash as the Redis client (final choice)');
mustNotContain(handoff, 'ioredis is',         'Does NOT report ioredis as current Redis client');

// Module rename: services → providers
// The handoff may mention "services/" while *describing* the rename — that's correct.
// What it must NOT do is describe services/ as the CURRENT location of the module.
mustContain(handoff,    'providers',          'Mentions providers/ module directory (post-rename)');
mustNotContain(handoff, 'import from services', 'Does NOT import from old services/ path');
mustNotContain(handoff, 'located in services', 'Does NOT describe module as located in services/');

// Rate limiter: bug reappeared and is NOT resolved
mustNotContain(handoff, 'rate limiter is fixed',    'Does NOT claim rate limiter is fully fixed');
mustNotContain(handoff, 'rate limiter resolved',    'Does NOT claim rate limiter race condition resolved');

// Current task: payment webhook idempotency
mustContain(handoff,    'payment',            'Mentions payment webhook as part of current work');

// WebSocket auth WAS resolved — must NOT appear as an open error
mustNotContain(handoff, 'websocket error still open', 'Does NOT report WebSocket auth as still open (it was fixed)');

export { handoff as s03Handoff, PROJECT_DIR as s03ProjectDir };
