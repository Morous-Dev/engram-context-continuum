/**
 * marathon-data.mjs — Shared test data for compaction marathon benchmarks.
 *
 * Responsible for: providing the 20 realistic software engineering cycle
 * templates, event generator, and token estimation utility used by both
 * test-compaction-marathon.mjs and test-tier-comparison.mjs.
 *
 * Anchor facts woven into specific cycles:
 *   AF1 — Final DB choice: PostgreSQL (cycle 0: abandons MongoDB)
 *   AF2 — Auth: JWT with refresh tokens (cycle 0)
 *   AF3 — WebSocket memory leak: appears cycle 2, "fixed" cycle 5, REAPPEARS cycle 8
 *   AF4 — Module rename: utils/ → shared/ (cycle 3)
 *   AF5 — Current task: always the last cycle's active task
 *   AF6 — ORM choice: Prisma over Mongoose (cycle 0)
 *
 * Depends on: benchmark/seed-helpers.mjs
 * Depended on by: benchmark/test-compaction-marathon.mjs,
 *                 benchmark/test-tier-comparison.mjs
 */

import { ev } from "./seed-helpers.mjs";

// ── Cycle templates ────────────────────────────────────────────────────────────

/**
 * Each cycle simulates a distinct work segment (~30-90 min of real work).
 * Topics rotate through realistic software engineering activities.
 * Anchor facts are woven into specific cycles.
 */
export const CYCLE_TEMPLATES = [
  // Cycle 0: Project bootstrap — AF1 conflict (MongoDB → PostgreSQL), AF2, AF6
  (i) => [
    ev.prompt("Set up the new project. Start with the database layer."),
    ev.decision("Use MongoDB with Mongoose for flexible schema — good for rapid prototyping"),
    ev.fileWrite("src/db/mongoose-client.ts"),
    ev.fileWrite("src/models/user.model.ts"),
    ev.fileWrite("src/models/product.model.ts"),
    ev.tool("npm install mongoose @types/mongoose"),
    ev.error("Error: Mongoose schema validation is too loose — nested objects silently accept any shape"),
    ev.prompt("This schema validation is terrible. What are alternatives?"),
    ev.decision("ABANDON Mongoose/MongoDB. Switch to PostgreSQL with Prisma — type-safe schema, migrations, relations"),
    ev.tool("npm uninstall mongoose && npm install prisma @prisma/client"),
    ev.fileWrite("prisma/schema.prisma"),
    ev.fileWrite("src/db/prisma-client.ts"),
    ev.resolved("Schema validation issue resolved — Prisma enforces strict types at compile time"),
    ev.decision("Auth pattern: JWT with refresh tokens — stateless, scales horizontally"),
    ev.fileWrite("src/auth/jwt.ts"),
    ev.fileWrite("src/auth/middleware.ts"),
    ev.task("Implement JWT auth with refresh token rotation"),
    ev.tool("npm run build -- OK"),
  ],

  // Cycle 1: API layer setup
  (i) => [
    ev.prompt("Build the REST API routes for user management"),
    ev.fileWrite("src/routes/users.ts"),
    ev.fileWrite("src/routes/auth.ts"),
    ev.fileRead("src/auth/middleware.ts"),
    ev.fileEdit("src/routes/users.ts"),
    ev.tool("npm run test -- users: 5/5 passed"),
    ev.decision("Use Express with Zod validation middleware for all routes"),
    ev.fileWrite("src/middleware/validate.ts"),
    ev.task("Add input validation to all API endpoints"),
    ev.tool("npm run build -- OK"),
    ev.fileEdit("src/routes/auth.ts"),
    ev.tool("git commit -m 'feat: add user management routes'"),
  ],

  // Cycle 2: WebSocket feature — AF3 first appearance
  (i) => [
    ev.prompt("Add real-time notifications via WebSocket"),
    ev.fileWrite("src/ws/handler.ts"),
    ev.fileWrite("src/ws/events.ts"),
    ev.fileEdit("src/server.ts"),
    ev.tool("npm install ws @types/ws"),
    ev.task("Implement WebSocket notification system"),
    ev.error("Error: memory leak in WebSocket handler — connections not cleaned up on client disconnect, heap grows 50MB/hour under load test"),
    ev.prompt("Debug the WebSocket memory leak"),
    ev.fileRead("src/ws/handler.ts"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.tool("npm run test -- ws: 3/4 passed, 1 failed (leak test still fails)"),
    ev.prompt("The leak test still fails. Park it for now, move on."),
  ],

  // Cycle 3: Module rename — AF4
  (i) => [
    ev.prompt("Rename the utils/ directory to shared/ — it has more than just utilities now"),
    ev.decision("Rename module directory: utils/ → shared/ — contains types, constants, and helpers"),
    ev.tool("git mv src/utils/ src/shared/"),
    ev.fileEdit("src/routes/users.ts"),
    ev.fileEdit("src/routes/auth.ts"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.fileEdit("src/auth/middleware.ts"),
    ev.fileEdit("src/db/prisma-client.ts"),
    ev.tool("npm run build -- OK after updating all import paths"),
    ev.tool("git commit -m 'refactor: rename utils/ to shared/'"),
    ev.fileWrite("src/shared/logger.ts"),
    ev.task("Set up structured logging across all modules"),
  ],

  // Cycle 4: Testing and CI
  (i) => [
    ev.prompt("Set up the CI pipeline and improve test coverage"),
    ev.fileWrite(".github/workflows/ci.yml"),
    ev.fileWrite("src/routes/__tests__/users.test.ts"),
    ev.fileWrite("src/routes/__tests__/auth.test.ts"),
    ev.tool("npm run test -- 12/14 passed, 2 failed"),
    ev.error("Error: auth refresh token test fails — token rotation not invalidating old refresh token"),
    ev.fileEdit("src/auth/jwt.ts"),
    ev.tool("npm run test -- 14/14 passed"),
    ev.resolved("Refresh token rotation fix — old tokens now invalidated on use"),
    ev.decision("Use Vitest over Jest — faster, native ESM support"),
    ev.task("Migrate test runner from Jest to Vitest"),
  ],

  // Cycle 5: WebSocket "fix" — AF3 temporarily "resolved" (will reappear at cycle 8)
  (i) => [
    ev.prompt("Revisit the WebSocket memory leak from earlier"),
    ev.fileRead("src/ws/handler.ts"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.tool("Added WeakRef for connection tracking and explicit cleanup on 'close' event"),
    ev.tool("npm run test -- ws: 4/4 passed including leak test"),
    ev.resolved("WebSocket memory leak resolved — added WeakRef tracking and explicit cleanup on disconnect"),
    ev.fileWrite("src/ws/reconnect.ts"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.task("Add WebSocket reconnection with exponential backoff"),
    ev.tool("git commit -m 'fix: resolve WebSocket memory leak, add reconnection'"),
  ],

  // Cycle 6: Payment integration
  (i) => [
    ev.prompt("Integrate Stripe for payment processing"),
    ev.fileWrite("src/payments/stripe-client.ts"),
    ev.fileWrite("src/payments/webhook.ts"),
    ev.fileWrite("src/routes/payments.ts"),
    ev.tool("npm install stripe"),
    ev.decision("Use Stripe webhooks with signature verification — raw body middleware"),
    ev.fileWrite("src/middleware/raw-body.ts"),
    ev.error("Error: Stripe webhook signature verification fails — req.body is parsed JSON, not raw buffer"),
    ev.fileEdit("src/middleware/raw-body.ts"),
    ev.resolved("Stripe webhook fix — apply raw body parser BEFORE json middleware on webhook route"),
    ev.task("Add payment receipt email after successful charge"),
  ],

  // Cycle 7: Email and notifications
  (i) => [
    ev.prompt("Set up transactional email for payment receipts and auth flows"),
    ev.fileWrite("src/email/resend-client.ts"),
    ev.fileWrite("src/email/templates/receipt.ts"),
    ev.fileWrite("src/email/templates/welcome.ts"),
    ev.tool("npm install resend"),
    ev.decision("Use Resend for transactional email — simple API, good deliverability, TypeScript SDK"),
    ev.fileEdit("src/routes/auth.ts"),
    ev.fileEdit("src/payments/webhook.ts"),
    ev.task("Add email rate limiting to prevent abuse"),
    ev.tool("git commit -m 'feat: add transactional email via Resend'"),
  ],

  // Cycle 8: WebSocket leak REAPPEARS — AF3 now definitively unresolved
  (i) => [
    ev.prompt("Production alert: WebSocket connections are leaking again under high load"),
    ev.error("Error: WebSocket memory leak REAPPEARED — heap grows 80MB/hour in production, WeakRef cleanup not firing for connections that timeout (no 'close' event emitted on timeout)"),
    ev.fileRead("src/ws/handler.ts"),
    ev.prompt("The WeakRef fix doesn't handle timeout disconnects. What now?"),
    ev.tool("Research: Node.js ws library does NOT emit 'close' on connection timeout"),
    ev.decision("Fix plan: add heartbeat ping/pong — server pings every 30s, terminates non-responders. NOT IMPLEMENTED YET."),
    ev.fileEdit("src/ws/handler.ts"),
    ev.tool("npm run test -- ws: 5/6 passed, 1 failed (timeout cleanup test)"),
    ev.task("Implement WebSocket heartbeat ping/pong for timeout detection"),
  ],

  // Cycle 9: Search feature
  (i) => [
    ev.prompt("Add full-text search for products"),
    ev.fileWrite("src/search/product-search.ts"),
    ev.fileEdit("prisma/schema.prisma"),
    ev.tool("npx prisma migrate dev --name add-search-index"),
    ev.decision("Use PostgreSQL tsvector for full-text search — no external dependency"),
    ev.fileWrite("src/routes/search.ts"),
    ev.task("Add search result pagination and highlighting"),
    ev.tool("git commit -m 'feat: add PostgreSQL full-text product search'"),
  ],

  // Cycle 10: Admin dashboard
  (i) => [
    ev.prompt("Build the admin dashboard API"),
    ev.fileWrite("src/routes/admin/users.ts"),
    ev.fileWrite("src/routes/admin/orders.ts"),
    ev.fileWrite("src/middleware/admin-auth.ts"),
    ev.decision("Admin routes require role=ADMIN in JWT claims — separate middleware"),
    ev.fileEdit("src/auth/jwt.ts"),
    ev.error("Error: admin analytics query takes 12s on 100K orders — full table scan"),
    ev.fileEdit("prisma/schema.prisma"),
    ev.tool("npx prisma migrate dev --name add-order-date-index"),
    ev.resolved("Admin analytics query optimized — added index on orders.created_at, now <200ms"),
    ev.task("Add CSV export for admin order reports"),
  ],

  // Cycle 11: Performance optimization
  (i) => [
    ev.prompt("The product listing API is slow. Profile and optimize."),
    ev.fileRead("src/routes/products.ts"),
    ev.tool("Profiled: N+1 query on product.reviews"),
    ev.decision("Add DataLoader for review counts — batches N+1 into single query per request"),
    ev.fileWrite("src/loaders/review-loader.ts"),
    ev.fileEdit("src/routes/products.ts"),
    ev.tool("npm run test -- products: 8/8 passed, response time: 45ms avg (was 800ms)"),
    ev.task("Add Redis caching for product catalog"),
    ev.tool("git commit -m 'perf: fix N+1 query on product reviews with DataLoader'"),
  ],

  // Cycle 12: Deployment setup
  (i) => [
    ev.prompt("Set up deployment pipeline for staging and production"),
    ev.fileWrite("Dockerfile"),
    ev.fileWrite("docker-compose.yml"),
    ev.fileWrite(".github/workflows/deploy.yml"),
    ev.decision("Deploy API on Railway, frontend on Vercel — both support preview deploys"),
    ev.error("Error: Docker build fails — Prisma binary not compatible with Alpine Linux"),
    ev.fileEdit("Dockerfile"),
    ev.resolved("Docker build fix — switched to node:20-slim (Debian) base image"),
    ev.tool("docker build -t app . -- OK"),
    ev.task("Add health check endpoint for Railway deployment"),
  ],

  // Cycle 13: Security audit
  (i) => [
    ev.prompt("Run a security audit on the codebase"),
    ev.tool("npm audit -- 3 moderate vulnerabilities found"),
    ev.decision("Add rate limiting on auth endpoints — 5 attempts per minute per IP"),
    ev.fileWrite("src/middleware/rate-limit.ts"),
    ev.fileEdit("src/routes/auth.ts"),
    ev.tool("npm audit fix -- resolved 2/3 vulnerabilities"),
    ev.error("Error: remaining npm audit vulnerability in transitive dep — no fix available yet"),
    ev.task("Add CORS allowlist for staging and production domains"),
    ev.fileWrite("src/middleware/cors.ts"),
    ev.tool("git commit -m 'security: add rate limiting and CORS allowlist'"),
  ],

  // Cycle 14: File upload feature
  (i) => [
    ev.prompt("Add file upload support for product images"),
    ev.fileWrite("src/storage/r2-client.ts"),
    ev.fileWrite("src/routes/uploads.ts"),
    ev.tool("npm install @aws-sdk/client-s3 multer"),
    ev.decision("Use Cloudflare R2 for file storage — S3-compatible API, no egress fees"),
    ev.fileWrite("src/middleware/upload.ts"),
    ev.fileEdit("prisma/schema.prisma"),
    ev.tool("npx prisma migrate dev --name add-product-images"),
    ev.task("Add image optimization pipeline before R2 upload"),
    ev.tool("git commit -m 'feat: add product image upload to R2'"),
  ],

  // Cycle 15: Monitoring and observability
  (i) => [
    ev.prompt("Set up monitoring and error tracking"),
    ev.fileWrite("src/monitoring/sentry.ts"),
    ev.fileWrite("src/monitoring/metrics.ts"),
    ev.tool("npm install @sentry/node prom-client"),
    ev.decision("Use Sentry for error tracking, Prometheus for metrics — both have free tiers"),
    ev.fileEdit("src/server.ts"),
    ev.fileWrite("src/routes/metrics.ts"),
    ev.task("Add custom Prometheus metrics for business KPIs"),
    ev.tool("git commit -m 'feat: add Sentry error tracking and Prometheus metrics'"),
  ],

  // Cycle 16: Multi-tenancy
  (i) => [
    ev.prompt("Add multi-tenant support using PostgreSQL row-level security"),
    ev.fileEdit("prisma/schema.prisma"),
    ev.fileWrite("prisma/migrations/add-rls-policies.sql"),
    ev.tool("npx prisma migrate dev --name add-tenant-id"),
    ev.decision("All tables get tenant_id column — RLS policies enforce isolation at DB level"),
    ev.error("Error: RLS policy blocks admin queries — admin role needs BYPASSRLS"),
    ev.fileEdit("src/db/prisma-client.ts"),
    ev.resolved("RLS admin fix — admin queries use a separate Prisma client with BYPASSRLS role"),
    ev.task("Add tenant provisioning API for onboarding"),
  ],

  // Cycle 17: API versioning
  (i) => [
    ev.prompt("We need API versioning before the public launch"),
    ev.decision("Use URL-based versioning: /api/v1/... — simple, explicit, easy to deprecate"),
    ev.fileWrite("src/routes/v1/index.ts"),
    ev.fileEdit("src/server.ts"),
    ev.fileEdit("src/routes/users.ts"),
    ev.fileEdit("src/routes/products.ts"),
    ev.tool("npm run test -- 42/42 passed after route restructure"),
    ev.task("Add API documentation with OpenAPI/Swagger"),
    ev.fileWrite("src/docs/openapi.yaml"),
    ev.tool("git commit -m 'refactor: add API versioning with /api/v1 prefix'"),
  ],

  // Cycle 18: Caching layer
  (i) => [
    ev.prompt("Add a caching layer for frequently accessed data"),
    ev.fileWrite("src/cache/redis-cache.ts"),
    ev.tool("npm install ioredis"),
    ev.decision("Use Redis (via Upstash) for caching — same provider as rate limiter"),
    ev.fileEdit("src/routes/products.ts"),
    ev.fileEdit("src/routes/search.ts"),
    ev.tool("npm run test -- cache: 5/5 passed"),
    ev.task("Add cache invalidation on product updates"),
    ev.tool("git commit -m 'feat: add Redis caching for product catalog'"),
  ],

  // Cycle 19: Final polish — WebSocket leak still open (current task at highest compaction)
  (i) => [
    ev.prompt("Final pre-launch checklist. Fix remaining issues."),
    ev.fileRead("src/ws/handler.ts"),
    ev.prompt("The WebSocket memory leak is still the biggest open issue. What's the status?"),
    ev.error("Error: WebSocket memory leak still UNRESOLVED — heartbeat ping/pong mechanism not yet implemented, heap growth confirmed in staging at 80MB/hour"),
    ev.task("Implement WebSocket heartbeat ping/pong before launch"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.fileWrite("src/ws/heartbeat.ts"),
    ev.tool("npm run test -- ws heartbeat: 2/4 passed, 2 failed (timeout edge cases)"),
    ev.prompt("The heartbeat is partially working. Continue debugging the timeout edge cases."),
  ],
];

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Generate all events for N compaction cycles by rotating through templates.
 * Ensures anchor facts land at their designated cycles regardless of N.
 *
 * @param cycleCount - Number of compaction cycles to simulate.
 * @returns Flat array of all generated events.
 */
export function generateCycleEvents(cycleCount) {
  const allEvents = [];
  for (let i = 0; i < cycleCount; i++) {
    const templateIdx = i % CYCLE_TEMPLATES.length;
    const cycleEvents = CYCLE_TEMPLATES[templateIdx](i);
    allEvents.push(...cycleEvents);
  }
  return allEvents;
}

/**
 * Estimate token count for a string using the 4 chars/token heuristic.
 *
 * @param text - String to estimate.
 * @returns Estimated token count.
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
