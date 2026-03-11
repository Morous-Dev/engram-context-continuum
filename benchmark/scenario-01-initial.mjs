/**
 * scenario-01-initial.mjs — Initial session benchmark.
 *
 * Simulates the very first session on a new project: a REST-to-GraphQL
 * migration. The user makes foundational architecture decisions, creates
 * core files, hits two errors (resolves one, leaves one open).
 *
 * Hard context elements:
 * - Multiple interdependent architecture decisions made in sequence
 * - One unresolved TypeScript error that must NOT be reported as fixed
 * - 8 files created across different directories
 *
 * Assertions:
 * - Handoff captures GraphQL + Prisma + PostgreSQL as stack decisions
 * - Handoff flags the unresolved TypeScript error
 * - Handoff does NOT claim the TS error was resolved
 * - Handoff captures auth middleware as the last task
 */

import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { seed, ev } from './seed-helpers.mjs';
import { mustContain, mustNotContain } from './assertions.mjs';

const PROJECT_DIR = join(tmpdir(), 'ecc-bench-s01');
const SESSION_ID  = 'bench-s01-' + Date.now();
const BUILD       = join(process.cwd(), 'build');

// ── Setup ─────────────────────────────────────────────────────────────────────
mkdirSync(PROJECT_DIR, { recursive: true });
mkdirSync(join(PROJECT_DIR, '.engram-cc'), { recursive: true });

const { SessionDB } = await import(pathToFileURL(join(BUILD, 'session', 'db.js')).href);
const { getProjectId } = await import(pathToFileURL(join(BUILD, 'project-id.js')).href);
const { homedir } = await import('node:os');
const dbDir  = join(homedir(), '.engram-cc', 'sessions');
mkdirSync(dbDir, { recursive: true });

// Use a bench-specific DB path so we don't pollute the real project DB
const dbPath = join(dbDir, `bench-s01.db`);
if (existsSync(dbPath)) rmSync(dbPath);

const db = new SessionDB({ dbPath });
db.ensureSession(SESSION_ID, PROJECT_DIR);

// ── Seed events — initial session, ~80 events ─────────────────────────────────
seed(db, SESSION_ID, [

  // 1. Project setup and goal setting
  ev.prompt('We need to migrate this Express REST API to GraphQL. Start fresh.'),
  ev.task('REST to GraphQL migration — initial setup'),
  ev.fileRead('src/routes/users.ts'),
  ev.fileRead('src/routes/products.ts'),
  ev.fileRead('src/routes/orders.ts'),
  ev.tool('Read package.json — current deps: express, pg, bcrypt'),

  // 2. Architecture decisions (foundational)
  ev.prompt('What stack should we use for the GraphQL layer?'),
  ev.decision('Use Apollo Server v4 for the GraphQL server — better TypeScript support than graphql-yoga'),
  ev.decision('Use Prisma as the ORM — replaces raw pg queries, type-safe schema'),
  ev.decision('Keep PostgreSQL as the database — no migration needed, just new access layer'),
  ev.decision('Schema-first approach: define .graphql files, generate resolvers from them'),

  // 3. Initial file creation
  ev.prompt('Set up the GraphQL schema files'),
  ev.fileWrite('src/graphql/schema/user.graphql'),
  ev.fileWrite('src/graphql/schema/product.graphql'),
  ev.fileWrite('src/graphql/schema/order.graphql'),
  ev.fileWrite('src/graphql/schema/root.graphql'),
  ev.fileRead('src/graphql/schema/root.graphql'),
  ev.tool('npm install @apollo/server graphql graphql-tag'),

  // 4. Prisma setup
  ev.prompt('Set up Prisma schema and connect to Postgres'),
  ev.fileWrite('prisma/schema.prisma'),
  ev.tool('npx prisma init -- output to prisma/'),
  ev.decision('Prisma schema mirrors existing PostgreSQL tables exactly — no renames'),
  ev.fileWrite('prisma/migrations/0001_init.sql'),
  ev.tool('npx prisma generate -- generated Prisma client'),

  // 5. Resolver setup — first error
  ev.prompt('Create the User resolver'),
  ev.fileWrite('src/graphql/resolvers/user.resolver.ts'),
  ev.error("TypeScript error: Property 'user' does not exist on type 'Context'. Did you mean 'currentUser'? (src/graphql/resolvers/user.resolver.ts:34)"),
  ev.fileRead('src/graphql/context.ts'),
  ev.prompt('Fix the context type error'),
  ev.fileEdit('src/graphql/context.ts'),
  ev.fileEdit('src/graphql/resolvers/user.resolver.ts'),
  ev.resolved("TypeScript error in user.resolver.ts resolved — added 'currentUser' to Context type"),

  // 6. More resolvers
  ev.fileWrite('src/graphql/resolvers/product.resolver.ts'),
  ev.fileWrite('src/graphql/resolvers/order.resolver.ts'),
  ev.fileWrite('src/graphql/resolvers/index.ts'),

  // 7. Server wiring
  ev.prompt('Wire up Apollo Server with Express'),
  ev.fileWrite('src/server.ts'),
  ev.fileEdit('src/index.ts'),
  ev.tool('npm run build -- TypeScript compilation'),

  // 8. Auth middleware — new unresolved error (must NOT be reported as resolved)
  ev.prompt('Add authentication middleware to GraphQL context'),
  ev.fileWrite('src/graphql/middleware/auth.ts'),
  ev.error("Error: Cannot read properties of undefined reading 'headers' at extractToken (src/graphql/middleware/auth.ts:12) — happens only when WebSocket connections are used"),
  ev.tool('Read Apollo docs for WebSocket context handling'),
  ev.fileEdit('src/graphql/middleware/auth.ts'),
  ev.error("Error: Cannot read properties of undefined reading 'headers' at extractToken (src/graphql/middleware/auth.ts:12) — still failing on WebSocket connections after fix attempt"),
  // Note: error is NOT resolved — must appear in handoff as open

  // 9. Filler tool use (realistic noise)
  ev.tool('git status'),
  ev.tool('git add -p'),
  ev.fileRead('src/graphql/schema/root.graphql'),
  ev.fileRead('prisma/schema.prisma'),
  ev.tool('npx prisma studio -- opened Prisma Studio at localhost:5555'),

], 'PostToolUse');

db.close();

// ── Run stop hook pipeline directly ───────────────────────────────────────────
const { buildHandoffFromEvents, writeHandoff } = await import(pathToFileURL(join(BUILD, 'handoff', 'writer.js')).href);
const { getCompressor } = await import(pathToFileURL(join(BUILD, 'compression', 'index.js')).href);
const { SessionDB: SessionDB2 } = await import(pathToFileURL(join(BUILD, 'session', 'db.js')).href);

const db2 = new SessionDB2({ dbPath });
const events = db2.getEvents(SESSION_ID);
db2.close();

const compressor = getCompressor();
console.log(`\nScenario 1 — Initial Session`);
console.log(`Events seeded: ${events.length} | Compressor: ${compressor.tier}`);

const handoffData = await buildHandoffFromEvents(
  SESSION_ID, PROJECT_DIR, events, null, null, compressor,
);
writeHandoff(handoffData, PROJECT_DIR);

// ── Load and display ───────────────────────────────────────────────────────────
const { readHandoff } = await import(pathToFileURL(join(BUILD, 'handoff', 'reader.js')).href);
const handoff = readHandoff(PROJECT_DIR, Infinity);

console.log(`\nHeadline: ${handoff.headline}`);
console.log(`\nWorking context:\n${handoff.working_context}`);
console.log('\nAssertions:');

// ── Assertions ────────────────────────────────────────────────────────────────
mustContain(handoff, 'graphql',     'Mentions GraphQL as the tech stack');
mustContain(handoff, 'prisma',      'Mentions Prisma ORM');
mustContain(handoff, 'postgresql',  'Mentions PostgreSQL as the database');
mustContain(handoff, 'apollo',      'Mentions Apollo Server');
mustNotContain(handoff, 'resolved the websocket', 'Does NOT claim WebSocket auth error was resolved');
mustNotContain(handoff, 'fixed the header',       'Does NOT hallucinate a fix for the header error');

export { handoff as s01Handoff, PROJECT_DIR as s01ProjectDir, dbPath as s01DbPath };
