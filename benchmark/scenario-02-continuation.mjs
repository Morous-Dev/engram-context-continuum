/**
 * scenario-02-continuation.mjs — Hot resume continuation session benchmark.
 *
 * Simulates a session starting within 30 minutes of Scenario 1.
 * The user continues the GraphQL migration but makes a critical
 * DECISION REVERSAL: switches from PostgreSQL to SQLite for local dev.
 * Also introduces a naming inconsistency across resolvers.
 *
 * Hard context elements:
 * - Decision reversal: PostgreSQL → SQLite (must report FINAL state only)
 * - Naming inconsistency: some files use getUser(), some getUserById()
 * - Hot resume injection (handoff age < 30 min)
 * - New unresolved error layered on top of existing open error from S1
 *
 * Assertions:
 * - Final database is SQLite, NOT PostgreSQL (conflict resolution)
 * - Naming inconsistency is flagged
 * - Does NOT say PostgreSQL is the current DB
 * - Does NOT say the WebSocket error from S1 is resolved
 */

import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { seed, ev } from './seed-helpers.mjs';
import { mustContain, mustNotContain } from './assertions.mjs';

const PROJECT_DIR = join(tmpdir(), 'ecc-bench-s02');
const SESSION_ID  = 'bench-s02-' + Date.now();
const BUILD       = join(process.cwd(), 'build');

mkdirSync(PROJECT_DIR, { recursive: true });
mkdirSync(join(PROJECT_DIR, '.engram-cc'), { recursive: true });

// Copy handoff from S1 so hot resume has something to read
// (We simulate this by writing a realistic S1 handoff manually)
import yaml from 'js-yaml';
import { writeFileSync } from 'node:fs';

const s1Handoff = {
  session_id: 'bench-s01-ref',
  timestamp: new Date(Date.now() - 12 * 60 * 1000).toISOString(), // 12 min ago = hot
  project_dir: PROJECT_DIR,
  current_task: 'Add authentication middleware to GraphQL context',
  last_action: 'Edited src/graphql/middleware/auth.ts',
  decisions: [
    'Use Apollo Server v4 for the GraphQL server',
    'Use Prisma as the ORM',
    'Keep PostgreSQL as the database',
    'Schema-first approach: define .graphql files',
    'Prisma schema mirrors existing PostgreSQL tables exactly',
  ],
  files_modified: [
    'src/graphql/schema/user.graphql', 'src/graphql/schema/product.graphql',
    'src/graphql/schema/order.graphql', 'src/graphql/schema/root.graphql',
    'prisma/schema.prisma', 'prisma/migrations/0001_init.sql',
    'src/graphql/resolvers/user.resolver.ts', 'src/graphql/middleware/auth.ts',
  ],
  errors_encountered: [
    "Error: Cannot read properties of undefined reading 'headers' at extractToken (src/graphql/middleware/auth.ts:12) — WebSocket connections",
  ],
  errors_resolved: [],
  working_context: 'Migrating REST API to GraphQL using Apollo Server v4, Prisma ORM, and PostgreSQL. Schema files created, resolvers in progress. Auth middleware has an unresolved WebSocket header error.',
  headline: 'GraphQL migration underway — Apollo + Prisma + PostgreSQL stack set up, auth middleware has open WebSocket error.',
  user_preferences: '',
  codebase_conventions: '',
  open_questions: [],
  blockers: [],
  confidence: 'medium',
};
writeFileSync(
  join(PROJECT_DIR, '.engram-cc', 'handoff.yaml'),
  yaml.dump(s1Handoff),
  'utf-8',
);

// ── Seed events ───────────────────────────────────────────────────────────────
const dbDir  = join(homedir(), '.engram-cc', 'sessions');
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, 'bench-s02.db');
if (existsSync(dbPath)) rmSync(dbPath);

const { SessionDB } = await import(pathToFileURL(join(BUILD, 'session', 'db.js')).href);
const db = new SessionDB({ dbPath });
db.ensureSession(SESSION_ID, PROJECT_DIR);

seed(db, SESSION_ID, [

  // 1. Session picks up from hot handoff
  ev.prompt('Continue from last session — fix the WebSocket auth issue'),
  ev.fileRead('src/graphql/middleware/auth.ts'),
  ev.tool('Read Apollo Server WebSocket docs'),
  ev.fileEdit('src/graphql/middleware/auth.ts'),
  ev.error("Error: Cannot read properties of undefined reading 'headers' — still failing, WebSocket context is different from HTTP context"),
  // Still not resolved — this is the key test

  // 2. Decision reversal: PostgreSQL → SQLite for local dev
  ev.prompt('PostgreSQL setup is too heavy for local dev. Can we use SQLite instead?'),
  ev.decision('Switch from PostgreSQL to SQLite for local development — use DATABASE_URL env var to switch in production'),
  ev.fileEdit('prisma/schema.prisma'),
  ev.tool('npm uninstall pg && npm install better-sqlite3'),
  ev.fileEdit('.env'),
  ev.fileWrite('.env.production'),
  ev.decision('SQLite is now the default dev database. Production still uses PostgreSQL via DATABASE_URL override.'),
  ev.tool('npx prisma migrate dev -- applied to SQLite'),
  ev.fileEdit('src/db/client.ts'),

  // 3. More resolver work with naming inconsistency
  ev.prompt('Build out the product and order resolvers'),
  ev.fileEdit('src/graphql/resolvers/product.resolver.ts'),
  ev.fileEdit('src/graphql/resolvers/order.resolver.ts'),
  ev.fileWrite('src/graphql/resolvers/utils/getUserById.ts'),  // naming style A
  ev.fileWrite('src/graphql/resolvers/utils/getProduct.ts'),   // naming style B (inconsistent)
  ev.fileWrite('src/graphql/resolvers/utils/getOrderById.ts'), // naming style A again
  ev.decision('Resolver utility functions: use getEntityById() pattern (not getEntity())'),
  // Note: decision made AFTER files were created — inconsistency still exists on disk

  // 4. Testing setup
  ev.prompt('Add Jest tests for the resolvers'),
  ev.fileWrite('src/graphql/resolvers/__tests__/user.resolver.test.ts'),
  ev.fileWrite('src/graphql/resolvers/__tests__/product.resolver.test.ts'),
  ev.tool('npm run test -- 4 passed, 2 failed'),
  ev.error("Test failure: getProduct is not a function — naming mismatch with getProductById in resolver utils"),
  ev.fileEdit('src/graphql/resolvers/utils/getProduct.ts'),  // renamed internally but not filename
  ev.tool('npm run test -- 6 passed, 0 failed'),
  ev.resolved('Test failures resolved — corrected function name from getProduct to getProductById'),

  // 5. Filler
  ev.tool('git diff --stat'),
  ev.fileRead('prisma/schema.prisma'),
  ev.tool('npx prisma studio'),

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

console.log(`\nScenario 2 — Continuation Session (hot resume)`);
console.log(`Events seeded: ${events.length} | Compressor: ${compressor.tier}`);
console.log(`Handoff age: 12 min (should trigger hot resume)`);

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
mustContain(handoff,    'sqlite',          'Reports SQLite as the current database (final decision)');
mustNotContain(handoff, 'postgresql is the current', 'Does NOT report PostgreSQL as current DB');
mustContain(handoff,    'getentitybyid',   'Flags the naming convention decision (getEntityById pattern)');
mustNotContain(handoff, 'websocket error resolved',  'Does NOT claim WebSocket auth error was resolved');
mustNotContain(handoff, 'headers error resolved',    'Does NOT hallucinate a fix for the header error');

export { handoff as s02Handoff, PROJECT_DIR as s02ProjectDir };
