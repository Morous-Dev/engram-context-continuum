/**
 * realistic-cycles.mjs — Rich event generators for 160K-token session simulation.
 *
 * Responsible for: generating 60-80 realistic events per compaction cycle,
 * covering all ECC event types (file, error, decision, prompt, task, git,
 * subagent, env, mcp, plan, cwd) with realistic data sizes. Each cycle
 * represents ~80K tokens of real Claude Code conversation.
 *
 * 16 cycles simulate a full project lifecycle:
 *   Cycles 1-3:   Foundation (DB, auth, API)
 *   Cycles 4-6:   Features (WebSocket, frontend, testing)
 *   Cycles 7-9:   Iteration (bugs, performance, payments)
 *   Cycles 10-12: Infrastructure (deploy, security, storage)
 *   Cycles 13-16: Scale (multi-tenant, versioning, caching, launch prep)
 *
 * Anchor facts (8 total):
 *   AF1 — PostgreSQL over MongoDB (cycle 1)
 *   AF2 — JWT auth with refresh tokens (cycle 2)
 *   AF3 — WebSocket memory leak: appears cycle 4, "fixed" cycle 7, REAPPEARS cycle 10
 *   AF4 — utils/ → shared/ rename (cycle 3)
 *   AF5 — Current task = latest cycle's active task (always)
 *   AF6 — Prisma over Mongoose (cycle 1)
 *   AF7 — Redis via Upstash for caching (cycle 9)
 *   AF8 — Cloudflare R2 for file storage (cycle 12)
 *
 * Depends on: benchmark/seed-helpers.mjs
 * Depended on by: benchmark/test-160k-real.mjs
 */

import { ev } from "./seed-helpers.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Create a subagent event (launched or completed).
 * @param {string} prompt - Agent task description.
 * @param {"launched"|"completed"} status
 */
function subagent(prompt, status = "completed") {
  return {
    type: status === "completed" ? "subagent_completed" : "subagent_launched",
    category: "subagent",
    data: `[${status}] ${prompt}`.slice(0, 300),
    priority: status === "completed" ? 2 : 3,
  };
}

/** Create a git operation event. */
function git(op) {
  return { type: "git", category: "git", data: op, priority: 2 };
}

/** Create an environment setup event. */
function env(cmd) {
  return { type: "env", category: "env", data: cmd.slice(0, 300), priority: 2 };
}

/** Create a plan-mode event. */
function plan(type, data) {
  return { type: `plan_${type}`, category: "plan", data: data.slice(0, 300), priority: type === "approved" ? 1 : 2 };
}

/** Create an MCP tool call event. */
function mcp(tool, arg) {
  return { type: "mcp", category: "mcp", data: `${tool}: ${arg}`.slice(0, 300), priority: 3 };
}

/** Create a cwd change event. */
function cwd(path) {
  return { type: "cwd", category: "cwd", data: path, priority: 2 };
}

/** Create a skill invocation event. */
function skill(name) {
  return { type: "skill", category: "skill", data: name, priority: 3 };
}

// ── Cycle generators ──────────────────────────────────────────────────────────

/**
 * Each function returns an array of 60-80 events representing one compaction
 * cycle (~80K tokens of real Claude Code conversation). Events use all
 * category types and have realistic data payloads.
 */

// Cycle 1: Project bootstrap — AF1 (PostgreSQL), AF6 (Prisma)
export function cycle1() {
  return [
    ev.prompt("Initialize the new e-commerce project. We need a database, API layer, and auth system."),
    cwd("/home/user/projects/shopwave"),
    env("npx create-next-app@latest shopwave --typescript --tailwind --app"),
    ev.fileWrite("package.json"),
    ev.fileWrite("tsconfig.json"),
    ev.fileWrite(".env.local"),
    ev.fileRead("package.json"),
    ev.prompt("Start with the database layer. What should we use?"),
    plan("enter", "Planning database architecture"),
    ev.decision("Initially considered MongoDB with Mongoose for flexible schema and rapid prototyping"),
    ev.fileWrite("src/db/mongoose-client.ts"),
    ev.fileWrite("src/models/user.model.ts"),
    ev.fileWrite("src/models/product.model.ts"),
    ev.fileWrite("src/models/order.model.ts"),
    env("npm install mongoose @types/mongoose dotenv"),
    ev.tool("npm run build -- tsc compilation OK"),
    ev.error("Error: Mongoose schema validation is too loose — nested objects silently accept any shape. Product.variants field allows arbitrary JSON without type checking, which will corrupt order data in production"),
    ev.prompt("This schema validation is terrible. Nested objects accept anything. We need strict typing. What are the alternatives?"),
    subagent("Research database alternatives: PostgreSQL vs MySQL vs MongoDB with stricter schema", "completed"),
    ev.decision("CRITICAL DECISION: ABANDON Mongoose/MongoDB entirely. Switch to PostgreSQL with Prisma ORM — type-safe schema, compile-time validation, proper migrations, relational integrity for orders/products"),
    plan("approved", "Switch to PostgreSQL + Prisma"),
    env("npm uninstall mongoose @types/mongoose && npm install prisma @prisma/client"),
    env("npx prisma init --datasource-provider postgresql"),
    ev.fileWrite("prisma/schema.prisma"),
    ev.fileWrite("src/db/prisma-client.ts"),
    ev.fileEdit("src/models/user.model.ts"),
    ev.fileEdit("src/models/product.model.ts"),
    ev.fileEdit("src/models/order.model.ts"),
    ev.fileWrite("prisma/migrations/0001_init/migration.sql"),
    ev.tool("npx prisma migrate dev --name init — Migration applied: 4 tables created (User, Product, Order, OrderItem)"),
    ev.tool("npx prisma generate — Prisma Client generated"),
    ev.resolved("Schema validation issue resolved — Prisma enforces strict types at compile time, nested JSON replaced with proper relational OrderItem table"),
    git("add"),
    git("commit"),
    ev.fileRead("prisma/schema.prisma"),
    ev.fileWrite("src/db/seed.ts"),
    ev.tool("npx prisma db seed — Seeded 10 users, 50 products, 20 orders"),
    ev.fileWrite("src/lib/db-helpers.ts"),
    ev.fileWrite("src/types/database.ts"),
    ev.fileRead("src/db/prisma-client.ts"),
    ev.fileEdit("src/db/prisma-client.ts"),
    ev.fileWrite("src/utils/validators.ts"),
    ev.fileWrite("src/utils/formatters.ts"),
    ev.fileWrite("src/utils/constants.ts"),
    env("npm install zod"),
    ev.fileWrite("src/schemas/user.schema.ts"),
    ev.fileWrite("src/schemas/product.schema.ts"),
    ev.tool("npm run typecheck — 0 errors"),
    git("add"),
    git("commit"),
    git("push"),
    ev.task("Set up PostgreSQL connection pooling and Prisma query logging for development"),
    ev.prompt("Good. The database layer looks solid now. Let's move on to auth next session."),
  ];
}

// Cycle 2: Auth system — AF2 (JWT with refresh tokens)
export function cycle2() {
  return [
    ev.prompt("Build the authentication system. We need JWT with refresh tokens for the API."),
    ev.fileRead("prisma/schema.prisma"),
    ev.decision("Auth pattern: JWT access tokens (15min expiry) + refresh tokens (7d expiry) stored in HttpOnly cookies. Stateless access validation, refresh tokens stored in DB for revocation capability"),
    ev.fileEdit("prisma/schema.prisma"),
    ev.tool("npx prisma migrate dev --name add-refresh-tokens — Added RefreshToken table with userId, token, expiresAt, revokedAt columns"),
    env("npm install jsonwebtoken bcryptjs cookie-parser"),
    env("npm install -D @types/jsonwebtoken @types/bcryptjs @types/cookie-parser"),
    ev.fileWrite("src/auth/jwt.ts"),
    ev.fileWrite("src/auth/passwords.ts"),
    ev.fileWrite("src/auth/middleware.ts"),
    ev.fileWrite("src/auth/refresh.ts"),
    ev.fileWrite("src/routes/auth.ts"),
    ev.fileRead("src/auth/jwt.ts"),
    ev.fileEdit("src/auth/jwt.ts"),
    ev.fileWrite("src/routes/auth.test.ts"),
    ev.tool("npm run test -- auth: 8/8 passed (register, login, refresh, logout, expired token, invalid token, revoked refresh, role check)"),
    ev.fileWrite("src/auth/roles.ts"),
    ev.decision("Role-based access: USER, ADMIN, SUPER_ADMIN. Roles stored in JWT claims. Admin routes require role >= ADMIN"),
    ev.fileEdit("src/auth/middleware.ts"),
    ev.fileWrite("src/middleware/require-role.ts"),
    ev.error("Error: refresh token rotation not invalidating the old token — allows replay attacks with stolen refresh tokens"),
    ev.fileRead("src/auth/refresh.ts"),
    ev.fileEdit("src/auth/refresh.ts"),
    ev.tool("Fixed: old refresh token now marked revokedAt=NOW() on rotation. Added family tracking to detect token theft (if a revoked token is reused, entire family is revoked)"),
    ev.resolved("Refresh token rotation security fix — old tokens invalidated on use, token family theft detection added"),
    ev.tool("npm run test -- auth: 10/10 passed (added replay and family revocation tests)"),
    ev.fileWrite("src/auth/rate-limit.ts"),
    ev.fileEdit("src/routes/auth.ts"),
    ev.fileWrite("src/types/auth.ts"),
    subagent("Review auth implementation for OWASP Top 10 compliance", "completed"),
    ev.fileEdit("src/auth/passwords.ts"),
    ev.fileWrite("src/middleware/cors.ts"),
    ev.fileEdit("src/db/prisma-client.ts"),
    ev.fileWrite("src/utils/crypto.ts"),
    git("add"),
    git("commit"),
    ev.fileRead("src/routes/auth.ts"),
    ev.fileEdit("src/routes/auth.ts"),
    ev.tool("npm run build -- OK"),
    git("commit"),
    git("push"),
    ev.task("Add OAuth2 social login (Google, GitHub) as alternative to email/password"),
    ev.prompt("Auth system is solid. JWT with refresh tokens, role-based access, rate limiting. Moving on."),
  ];
}

// Cycle 3: API layer + module rename — AF4 (utils/ → shared/)
export function cycle3() {
  return [
    ev.prompt("Build the core API routes and restructure the utils directory — it's outgrown its name."),
    ev.fileRead("src/utils/validators.ts"),
    ev.fileRead("src/utils/formatters.ts"),
    ev.fileRead("src/utils/constants.ts"),
    ev.decision("RENAME: utils/ → shared/ — directory now contains types, constants, validators, formatters, and helpers. 'utils' is too vague for what it holds"),
    ev.tool("git mv src/utils/ src/shared/"),
    ev.fileEdit("src/routes/auth.ts"),
    ev.fileEdit("src/auth/middleware.ts"),
    ev.fileEdit("src/auth/jwt.ts"),
    ev.fileEdit("src/db/prisma-client.ts"),
    ev.fileEdit("src/schemas/user.schema.ts"),
    ev.fileEdit("src/schemas/product.schema.ts"),
    ev.tool("Updated 12 import paths from src/utils/ to src/shared/"),
    ev.tool("npm run typecheck — 0 errors after import path updates"),
    git("add"),
    git("commit"),
    ev.fileWrite("src/routes/users.ts"),
    ev.fileWrite("src/routes/products.ts"),
    ev.fileWrite("src/routes/orders.ts"),
    ev.fileWrite("src/middleware/validate.ts"),
    ev.fileWrite("src/middleware/error-handler.ts"),
    ev.fileWrite("src/middleware/request-logger.ts"),
    env("npm install express helmet morgan compression"),
    ev.fileWrite("src/server.ts"),
    ev.fileEdit("src/server.ts"),
    ev.fileRead("src/routes/users.ts"),
    ev.fileEdit("src/routes/users.ts"),
    ev.error("Error: Express route handler not catching async errors — unhandled promise rejection crashes the server on invalid product ID query"),
    ev.fileWrite("src/shared/async-handler.ts"),
    ev.fileEdit("src/routes/users.ts"),
    ev.fileEdit("src/routes/products.ts"),
    ev.fileEdit("src/routes/orders.ts"),
    ev.resolved("Async error handling resolved — created asyncHandler wrapper, applied to all route handlers"),
    ev.tool("npm run test -- routes: 15/15 passed (CRUD for users, products, orders + error cases)"),
    ev.fileWrite("src/routes/health.ts"),
    ev.fileWrite("src/shared/logger.ts"),
    ev.fileEdit("src/server.ts"),
    ev.fileWrite("src/types/api.ts"),
    ev.fileWrite("src/types/express.d.ts"),
    subagent("Generate OpenAPI spec from route definitions", "launched"),
    subagent("Generate OpenAPI spec from route definitions", "completed"),
    ev.fileWrite("docs/openapi.yaml"),
    git("add"),
    git("commit"),
    git("push"),
    ev.task("Add pagination middleware for list endpoints (products, orders, users)"),
    ev.prompt("API layer is done. All routes work, error handling is solid, shared/ directory is clean."),
  ];
}

// Cycle 4: WebSocket real-time features — AF3 first appearance
export function cycle4() {
  return [
    ev.prompt("Add real-time notifications via WebSocket for order status updates and admin alerts."),
    ev.fileRead("src/server.ts"),
    plan("enter", "Planning WebSocket architecture: ws vs Socket.IO vs Server-Sent Events"),
    ev.decision("Use raw ws library over Socket.IO — lighter, no polling fallback needed, we control the protocol. SSE rejected because we need bidirectional (admin can push alerts)"),
    plan("approved", "WebSocket with ws library, custom event protocol"),
    env("npm install ws @types/ws"),
    ev.fileWrite("src/ws/server.ts"),
    ev.fileWrite("src/ws/handler.ts"),
    ev.fileWrite("src/ws/events.ts"),
    ev.fileWrite("src/ws/auth.ts"),
    ev.fileWrite("src/ws/types.ts"),
    ev.fileEdit("src/server.ts"),
    ev.fileRead("src/auth/jwt.ts"),
    ev.fileEdit("src/ws/auth.ts"),
    ev.fileWrite("src/ws/rooms.ts"),
    ev.fileWrite("src/ws/broadcast.ts"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.fileWrite("src/routes/notifications.ts"),
    ev.tool("npm run test -- ws: 6/8 passed, 2 failed (connection cleanup tests)"),
    ev.error("CRITICAL: Memory leak in WebSocket handler — connections not cleaned up on client disconnect. Under load test: heap grows 50MB/hour, connection map grows unbounded. Server will OOM in production within 3 hours under 100 concurrent connections"),
    ev.prompt("The WebSocket handler is leaking memory badly. Connections aren't being cleaned up on disconnect."),
    ev.fileRead("src/ws/handler.ts"),
    ev.fileRead("src/ws/rooms.ts"),
    subagent("Research Node.js ws library memory leak patterns and connection cleanup best practices", "completed"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.fileEdit("src/ws/rooms.ts"),
    ev.tool("Added explicit cleanup on 'close' and 'error' events. Connection map now uses WeakRef."),
    ev.tool("npm run test -- ws: 7/8 passed, 1 failed (leak test under sustained load still fails)"),
    ev.prompt("The leak test still fails under sustained load. Park this for now — we'll revisit after more features are in."),
    ev.fileWrite("src/ws/connection-pool.ts"),
    ev.fileEdit("src/ws/server.ts"),
    ev.fileWrite("src/ws/__tests__/handler.test.ts"),
    git("add"),
    git("commit"),
    ev.task("Fix WebSocket memory leak under sustained load — connection cleanup incomplete"),
    ev.prompt("WebSocket is functional but has a known memory leak. Parking it for now."),
  ];
}

// Cycle 5: Frontend scaffolding
export function cycle5() {
  return [
    ev.prompt("Set up the React frontend with component architecture and routing."),
    ev.fileRead("package.json"),
    ev.fileRead("tsconfig.json"),
    env("npm install @tanstack/react-query zustand react-hook-form @hookform/resolvers"),
    ev.fileWrite("src/app/layout.tsx"),
    ev.fileWrite("src/app/page.tsx"),
    ev.fileWrite("src/app/products/page.tsx"),
    ev.fileWrite("src/app/products/[id]/page.tsx"),
    ev.fileWrite("src/app/cart/page.tsx"),
    ev.fileWrite("src/app/auth/login/page.tsx"),
    ev.fileWrite("src/app/auth/register/page.tsx"),
    ev.fileWrite("src/app/admin/layout.tsx"),
    ev.fileWrite("src/app/admin/dashboard/page.tsx"),
    ev.fileWrite("src/components/ui/button.tsx"),
    ev.fileWrite("src/components/ui/input.tsx"),
    ev.fileWrite("src/components/ui/card.tsx"),
    ev.fileWrite("src/components/ui/dialog.tsx"),
    ev.fileWrite("src/components/layout/header.tsx"),
    ev.fileWrite("src/components/layout/footer.tsx"),
    ev.fileWrite("src/components/layout/sidebar.tsx"),
    ev.fileWrite("src/components/products/product-card.tsx"),
    ev.fileWrite("src/components/products/product-grid.tsx"),
    ev.fileWrite("src/components/cart/cart-drawer.tsx"),
    ev.decision("State management: TanStack Query for server state, Zustand for UI state (cart, modals). No Redux — overkill for this scale"),
    ev.fileWrite("src/hooks/use-products.ts"),
    ev.fileWrite("src/hooks/use-auth.ts"),
    ev.fileWrite("src/hooks/use-cart.ts"),
    ev.fileWrite("src/stores/cart-store.ts"),
    ev.fileWrite("src/stores/ui-store.ts"),
    ev.fileWrite("src/lib/api-client.ts"),
    ev.fileEdit("src/lib/api-client.ts"),
    ev.error("Error: TanStack Query cache not invalidating on mutation — cart shows stale product count after adding item"),
    ev.fileEdit("src/hooks/use-cart.ts"),
    ev.resolved("Fixed: added queryClient.invalidateQueries(['cart']) in mutation onSuccess callback"),
    ev.tool("npm run build -- OK, 0 type errors"),
    ev.fileWrite("src/styles/globals.css"),
    ev.fileEdit("src/app/layout.tsx"),
    git("add"),
    git("commit"),
    git("push"),
    ev.task("Add product filtering and sorting to the product grid"),
    ev.prompt("Frontend scaffolding is done. Component architecture is clean, state management is set up."),
  ];
}

// Cycle 6: Testing & CI
export function cycle6() {
  return [
    ev.prompt("Set up comprehensive testing and CI pipeline. We need unit, integration, and e2e coverage."),
    ev.decision("Test stack: Vitest for unit/integration (fast, native ESM), Playwright for e2e. Jest rejected — slow startup, ESM config pain"),
    env("npm install -D vitest @testing-library/react @testing-library/jest-dom playwright @playwright/test"),
    ev.fileWrite("vitest.config.ts"),
    ev.fileWrite("playwright.config.ts"),
    ev.fileWrite("src/routes/__tests__/users.test.ts"),
    ev.fileWrite("src/routes/__tests__/products.test.ts"),
    ev.fileWrite("src/routes/__tests__/orders.test.ts"),
    ev.fileWrite("src/routes/__tests__/auth.test.ts"),
    ev.fileWrite("src/auth/__tests__/jwt.test.ts"),
    ev.fileWrite("src/auth/__tests__/refresh.test.ts"),
    ev.fileWrite("src/components/__tests__/product-card.test.tsx"),
    ev.fileWrite("src/components/__tests__/cart-drawer.test.tsx"),
    ev.fileWrite("src/hooks/__tests__/use-auth.test.ts"),
    ev.fileWrite("e2e/auth.spec.ts"),
    ev.fileWrite("e2e/products.spec.ts"),
    ev.fileWrite("e2e/checkout.spec.ts"),
    ev.tool("npm run test -- 42/45 passed, 3 failed"),
    ev.error("Error: 3 test failures in order routes — race condition in concurrent order creation: two orders can claim the last item in stock simultaneously"),
    ev.fileRead("src/routes/orders.ts"),
    ev.fileEdit("src/routes/orders.ts"),
    ev.tool("Fixed: added Prisma transaction with SELECT FOR UPDATE on product stock. Concurrent orders now serialized at DB level"),
    ev.resolved("Order race condition resolved — Prisma transaction with row-level locking prevents double-sell"),
    ev.tool("npm run test -- 45/45 passed"),
    ev.fileWrite(".github/workflows/ci.yml"),
    ev.fileWrite(".github/workflows/e2e.yml"),
    ev.fileEdit(".github/workflows/ci.yml"),
    ev.tool("GitHub Actions: CI pipeline runs lint, typecheck, unit tests, integration tests on every PR"),
    git("add"),
    git("commit"),
    git("push"),
    mcp("github", "Created PR #12: Add CI/CD pipeline"),
    ev.fileWrite("src/test/setup.ts"),
    ev.fileWrite("src/test/fixtures.ts"),
    ev.fileWrite("src/test/helpers.ts"),
    ev.tool("npx playwright install chromium"),
    ev.tool("npx playwright test -- 6/6 e2e tests passed"),
    ev.task("Add test coverage reporting and enforce 80% minimum in CI"),
    ev.prompt("Testing infrastructure is solid. 45 unit/integration + 6 e2e tests passing. CI runs on every PR."),
  ];
}

// Cycle 7: Bug fixing sprint — AF3 "fix" (temporary)
export function cycle7() {
  return [
    ev.prompt("Bug fixing sprint. Multiple issues reported from internal testing."),
    ev.error("Bug #1: Product search returns deleted products — soft delete filter missing from search query"),
    ev.fileRead("src/routes/products.ts"),
    ev.fileEdit("src/routes/products.ts"),
    ev.resolved("Bug #1 fixed: added WHERE deletedAt IS NULL to all product queries"),
    ev.error("Bug #2: Order total calculation wrong for items with quantity > 1 — multiplying by 1 instead of quantity"),
    ev.fileRead("src/routes/orders.ts"),
    ev.fileEdit("src/routes/orders.ts"),
    ev.resolved("Bug #2 fixed: order total now correctly sums price × quantity for each OrderItem"),
    ev.prompt("Now let's revisit the WebSocket memory leak from cycle 4."),
    ev.fileRead("src/ws/handler.ts"),
    ev.fileRead("src/ws/connection-pool.ts"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.fileEdit("src/ws/connection-pool.ts"),
    ev.tool("Refactored: replaced WeakRef with explicit Map + periodic cleanup sweep every 60s. Connections removed from map on 'close', 'error', and sweep timeout."),
    ev.tool("npm run test -- ws: 8/8 passed including sustained load leak test"),
    ev.resolved("WebSocket memory leak resolved — replaced WeakRef with explicit connection tracking map + periodic cleanup sweep. Heap stable at 120MB over 4-hour load test"),
    ev.error("Bug #3: Admin dashboard shows wrong revenue — counting refunded orders in total"),
    ev.fileRead("src/routes/admin/analytics.ts"),
    ev.fileEdit("src/routes/admin/analytics.ts"),
    ev.resolved("Bug #3 fixed: revenue query now excludes orders with status=REFUNDED"),
    ev.error("Bug #4: Password reset email sends reset link with HTTP instead of HTTPS in production"),
    ev.fileRead("src/routes/auth.ts"),
    ev.fileEdit("src/routes/auth.ts"),
    ev.resolved("Bug #4 fixed: reset link now uses APP_URL env var instead of hardcoded http://localhost"),
    ev.fileWrite("src/ws/__tests__/leak.test.ts"),
    ev.tool("npm run test -- 53/53 all passed"),
    git("add"),
    git("commit"),
    git("push"),
    mcp("github", "Closed issues #15, #16, #17, #18"),
    ev.task("Monitor WebSocket memory usage in staging for 24 hours to confirm leak fix"),
    ev.prompt("Bug sprint done. 4 bugs fixed including the WebSocket memory leak. All tests passing."),
  ];
}

// Cycle 8: Performance optimization
export function cycle8() {
  return [
    ev.prompt("Product listing is slow. Profile the API and optimize."),
    ev.fileRead("src/routes/products.ts"),
    ev.tool("Profiled with clinic.js: product list endpoint takes 800ms avg. Root cause: N+1 query — each product triggers a separate SQL query for review count and category name"),
    ev.decision("Add DataLoader pattern for review counts and category data — batches N+1 into single queries per request cycle"),
    ev.fileWrite("src/loaders/review-loader.ts"),
    ev.fileWrite("src/loaders/category-loader.ts"),
    ev.fileWrite("src/loaders/index.ts"),
    ev.fileEdit("src/routes/products.ts"),
    ev.tool("npm run test -- products: response time 45ms avg (was 800ms), 94% improvement"),
    ev.prompt("Great improvement. Now let's add database-level optimization."),
    ev.fileEdit("prisma/schema.prisma"),
    ev.tool("npx prisma migrate dev --name add-indexes — Added composite indexes on (categoryId, createdAt), (userId, status) for Order table"),
    ev.fileWrite("src/db/query-logger.ts"),
    ev.fileEdit("src/db/prisma-client.ts"),
    ev.tool("Query logging enabled: slowest query now 12ms (was 340ms before indexes)"),
    ev.prompt("Database is fast. Now let's add response compression and ETags."),
    ev.fileWrite("src/middleware/etag.ts"),
    ev.fileEdit("src/server.ts"),
    ev.fileWrite("src/middleware/cache-control.ts"),
    ev.tool("Added gzip compression (saves 60-70% bandwidth) and ETag support for product endpoints"),
    ev.fileWrite("src/routes/__tests__/performance.test.ts"),
    ev.tool("npm run test -- 56/56 passed, performance test: p99 < 100ms for product list"),
    git("add"),
    git("commit"),
    ev.fileEdit("src/routes/products.ts"),
    ev.fileRead("src/middleware/cache-control.ts"),
    ev.fileEdit("src/middleware/cache-control.ts"),
    git("commit"),
    git("push"),
    ev.task("Add connection pooling configuration and benchmark under concurrent load"),
    ev.prompt("Performance optimization done. Product API: 800ms → 45ms. Database queries all under 15ms."),
  ];
}

// Cycle 9: Payment integration — AF7 (Redis via Upstash)
export function cycle9() {
  return [
    ev.prompt("Integrate Stripe for payments and set up Redis for session/cart caching."),
    env("npm install stripe @stripe/stripe-js ioredis"),
    ev.decision("Payment: Stripe with webhooks + signature verification. Redis: Upstash (serverless Redis) for cart caching and rate limiting — same provider, consistent infra, generous free tier"),
    ev.fileWrite("src/payments/stripe-client.ts"),
    ev.fileWrite("src/payments/webhook.ts"),
    ev.fileWrite("src/payments/checkout.ts"),
    ev.fileWrite("src/routes/payments.ts"),
    ev.fileWrite("src/middleware/raw-body.ts"),
    ev.fileEdit("src/server.ts"),
    ev.error("Error: Stripe webhook signature verification fails — req.body is parsed JSON but Stripe needs the raw buffer for HMAC verification"),
    ev.fileRead("src/middleware/raw-body.ts"),
    ev.fileEdit("src/middleware/raw-body.ts"),
    ev.fileEdit("src/server.ts"),
    ev.resolved("Stripe webhook fix — raw body middleware applied BEFORE json parser on /webhooks/stripe route only"),
    ev.fileWrite("src/cache/redis-client.ts"),
    ev.fileWrite("src/cache/cart-cache.ts"),
    ev.fileWrite("src/cache/rate-limiter.ts"),
    ev.fileEdit("src/stores/cart-store.ts"),
    ev.fileEdit("src/hooks/use-cart.ts"),
    ev.fileRead("src/cache/redis-client.ts"),
    ev.fileEdit("src/cache/redis-client.ts"),
    ev.tool("Redis connection test: connected to Upstash, latency 2ms, cart cache working (TTL: 24h)"),
    ev.fileWrite("src/payments/__tests__/webhook.test.ts"),
    ev.fileWrite("src/payments/__tests__/checkout.test.ts"),
    ev.tool("npm run test -- payments: 8/8 passed, cache: 5/5 passed"),
    ev.fileWrite("src/email/receipt.ts"),
    ev.fileEdit("src/payments/webhook.ts"),
    git("add"),
    git("commit"),
    git("push"),
    ev.task("Add Stripe Connect for marketplace multi-vendor payouts"),
    ev.prompt("Payments and caching done. Stripe webhooks verified, Redis cart caching live via Upstash."),
  ];
}

// Cycle 10: Deployment & DevOps — AF3 REAPPEARS
export function cycle10() {
  return [
    ev.prompt("Set up deployment for staging and production. Also got an alert from staging."),
    ev.fileWrite("Dockerfile"),
    ev.fileWrite("docker-compose.yml"),
    ev.fileWrite("docker-compose.staging.yml"),
    ev.fileWrite(".dockerignore"),
    ev.decision("Deploy: API on Railway (autoscaling, good Prisma support), frontend on Vercel (native Next.js). Both support preview deploys for PRs"),
    ev.fileWrite("railway.toml"),
    ev.fileWrite("vercel.json"),
    ev.error("Error: Docker build fails — Prisma binary target for Alpine Linux not included. Binary is linux-musl-openssl-3.0.x but container expects linux-musl-arm64-openssl-3.0.x"),
    ev.fileEdit("Dockerfile"),
    ev.fileEdit("prisma/schema.prisma"),
    ev.resolved("Docker build fix — switched to node:20-slim (Debian) base image + added binaryTargets in Prisma schema"),
    ev.tool("docker build -t shopwave . — OK, image size 340MB"),
    ev.tool("docker-compose up — all services healthy"),
    ev.prompt("ALERT: Staging is using 2GB RAM and climbing. The WebSocket memory leak is BACK."),
    ev.error("CRITICAL: WebSocket memory leak REAPPEARED in production staging — heap grows 80MB/hour under real traffic. The periodic cleanup sweep from cycle 7 is not firing for connections that timeout WITHOUT sending a close frame. ws library does NOT emit 'close' event on TCP timeout, only on explicit close. The map cleanup sweep runs every 60s but checks isAlive which returns true for zombie connections"),
    ev.fileRead("src/ws/handler.ts"),
    ev.fileRead("src/ws/connection-pool.ts"),
    subagent("Research: How to detect dead WebSocket connections when 'close' event doesn't fire on timeout", "completed"),
    ev.decision("WebSocket fix plan: implement heartbeat ping/pong mechanism — server sends ping every 30s, marks connections that don't pong within 10s as dead, terminates them. This is the ONLY reliable way to detect dead connections. NOT YET IMPLEMENTED — needs careful testing"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.tool("npm run test -- ws: 7/8 passed, 1 failed (timeout detection test — heartbeat not implemented yet)"),
    ev.prompt("The WebSocket leak is back. The heartbeat fix is planned but not implemented yet. Continuing with deployment."),
    ev.fileWrite(".github/workflows/deploy-staging.yml"),
    ev.fileWrite(".github/workflows/deploy-production.yml"),
    ev.fileEdit(".github/workflows/ci.yml"),
    ev.fileWrite("scripts/health-check.sh"),
    git("add"),
    git("commit"),
    git("push"),
    ev.task("URGENT: Implement WebSocket heartbeat ping/pong to fix the recurring memory leak before production launch"),
    ev.prompt("Deployment pipeline is set up but WebSocket leak is still the biggest blocker for launch."),
  ];
}

// Cycle 11: Security hardening
export function cycle11() {
  return [
    ev.prompt("Security audit before launch. Review auth, input validation, and dependencies."),
    skill("senior-qa-auditor"),
    ev.tool("npm audit — 2 moderate, 1 high vulnerability in transitive dependencies"),
    ev.tool("npm audit fix — resolved 2/3, remaining: prototype pollution in lodash.merge (transitive via an old test helper)"),
    ev.fileRead("src/auth/middleware.ts"),
    ev.fileRead("src/middleware/validate.ts"),
    ev.fileRead("src/middleware/cors.ts"),
    ev.decision("Security: add Helmet.js for HTTP headers, tighten CORS to specific origins, add express-rate-limit on all write endpoints (not just auth)"),
    ev.fileEdit("src/server.ts"),
    ev.fileEdit("src/middleware/cors.ts"),
    ev.fileWrite("src/middleware/rate-limit-global.ts"),
    ev.fileEdit("src/routes/auth.ts"),
    ev.fileEdit("src/routes/orders.ts"),
    ev.fileEdit("src/routes/payments.ts"),
    env("npm install helmet express-rate-limit"),
    ev.error("Error: CORS misconfigured — wildcard origin (*) in production env var. Should be specific domains only"),
    ev.fileEdit("src/middleware/cors.ts"),
    ev.resolved("CORS fix — production allowlist: shopwave.com, admin.shopwave.com, staging.shopwave.com"),
    ev.fileRead("src/auth/rate-limit.ts"),
    ev.fileEdit("src/auth/rate-limit.ts"),
    ev.fileWrite("src/middleware/sanitize-input.ts"),
    ev.fileEdit("src/middleware/validate.ts"),
    ev.tool("Security scan (snyk test) — 0 new vulnerabilities in direct dependencies"),
    ev.fileWrite("src/auth/__tests__/security.test.ts"),
    ev.tool("npm run test -- security: 12/12 passed (XSS, SQLI, CSRF, rate limit, CORS, auth bypass attempts)"),
    subagent("Check for hardcoded secrets in codebase", "completed"),
    ev.fileEdit(".env.local"),
    ev.fileWrite(".env.example"),
    git("add"),
    git("commit"),
    git("push"),
    ev.task("Add CSP headers and Subresource Integrity for frontend assets"),
    ev.prompt("Security audit complete. No critical issues. Rate limiting, CORS, Helmet all configured."),
  ];
}

// Cycle 12: File storage — AF8 (Cloudflare R2)
export function cycle12() {
  return [
    ev.prompt("Add product image upload. We need a storage solution for user-uploaded files."),
    subagent("Compare storage options: AWS S3 vs Cloudflare R2 vs Google Cloud Storage for product images", "completed"),
    ev.decision("File storage: Cloudflare R2 — S3-compatible API so we can use the AWS SDK, zero egress fees (critical for an image-heavy e-commerce site), $0.015/GB/month storage"),
    env("npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner multer sharp"),
    ev.fileWrite("src/storage/r2-client.ts"),
    ev.fileWrite("src/storage/upload.ts"),
    ev.fileWrite("src/storage/image-optimizer.ts"),
    ev.fileWrite("src/routes/uploads.ts"),
    ev.fileWrite("src/middleware/upload.ts"),
    ev.fileEdit("prisma/schema.prisma"),
    ev.tool("npx prisma migrate dev --name add-product-images — Added ProductImage table with url, key, width, height, format columns"),
    ev.fileEdit("src/routes/products.ts"),
    ev.fileEdit("src/components/products/product-card.tsx"),
    ev.fileWrite("src/components/uploads/image-upload.tsx"),
    ev.error("Error: sharp image optimization fails on ARM64 Docker — prebuilt binary not available for linux/arm64 platform"),
    ev.fileEdit("Dockerfile"),
    ev.resolved("Sharp fix — added platform-specific install: npm install --os=linux --cpu=x64 sharp"),
    ev.tool("Image optimization pipeline: upload → sharp resize (800x800 max) → WebP conversion → R2 upload. Avg image: 2MB → 120KB"),
    ev.fileWrite("src/storage/__tests__/upload.test.ts"),
    ev.tool("npm run test -- uploads: 6/6 passed (upload, resize, webp convert, presigned URL, delete, size limit)"),
    ev.fileRead("src/storage/r2-client.ts"),
    ev.fileEdit("src/storage/r2-client.ts"),
    git("add"),
    git("commit"),
    git("push"),
    ev.task("Add image CDN caching headers and lazy loading for product grid"),
    ev.prompt("Image uploads working. Cloudflare R2 storage, sharp optimization, WebP conversion. Average image reduced from 2MB to 120KB."),
  ];
}

// Cycle 13: Multi-tenancy
export function cycle13() {
  return [
    ev.prompt("Add multi-tenant support for the marketplace — each vendor gets isolated data."),
    plan("enter", "Multi-tenancy approach: RLS vs schema-per-tenant vs discriminator column"),
    ev.decision("Multi-tenancy: PostgreSQL Row-Level Security (RLS) with tenant_id column on all tables. RLS policies enforce isolation at DB level — application bugs cannot leak cross-tenant data"),
    plan("approved", "RLS-based multi-tenancy"),
    ev.fileEdit("prisma/schema.prisma"),
    ev.fileWrite("prisma/migrations/add_tenant_rls/migration.sql"),
    ev.tool("npx prisma migrate dev --name add-tenant-rls — Added tenant_id to all tables, created RLS policies"),
    ev.fileEdit("src/db/prisma-client.ts"),
    ev.fileEdit("src/auth/middleware.ts"),
    ev.fileWrite("src/middleware/tenant-context.ts"),
    ev.fileWrite("src/routes/admin/tenants.ts"),
    ev.error("Error: RLS policy blocks admin dashboard queries — admin role needs BYPASSRLS or a separate connection without RLS"),
    ev.fileRead("src/db/prisma-client.ts"),
    ev.fileEdit("src/db/prisma-client.ts"),
    ev.resolved("RLS admin fix — created separate Prisma client instance with BYPASSRLS role for admin queries. Regular client uses RLS-enforced role"),
    ev.fileEdit("src/routes/admin/analytics.ts"),
    ev.fileEdit("src/routes/admin/users.ts"),
    ev.fileWrite("src/routes/admin/__tests__/tenant-isolation.test.ts"),
    ev.tool("npm run test -- tenant isolation: 8/8 passed (cross-tenant read blocked, admin bypass works, new tenant provisioning)"),
    ev.fileEdit("src/routes/products.ts"),
    ev.fileEdit("src/routes/orders.ts"),
    git("add"),
    git("commit"),
    git("push"),
    ev.task("Add tenant onboarding flow with Stripe Connect account creation"),
    ev.prompt("Multi-tenancy done. RLS enforced at DB level. Admin bypass working. Tenant isolation verified."),
  ];
}

// Cycle 14: API versioning
export function cycle14() {
  return [
    ev.prompt("Add API versioning before public launch. We need v1 prefix and deprecation headers."),
    ev.decision("API versioning: URL-based with /api/v1/ prefix — simple, explicit, easy to deprecate. Header-based versioning rejected — harder to test and debug, invisible in access logs"),
    ev.fileWrite("src/routes/v1/index.ts"),
    ev.fileEdit("src/server.ts"),
    ev.fileEdit("src/routes/users.ts"),
    ev.fileEdit("src/routes/products.ts"),
    ev.fileEdit("src/routes/orders.ts"),
    ev.fileEdit("src/routes/payments.ts"),
    ev.fileEdit("src/routes/uploads.ts"),
    ev.fileEdit("src/routes/auth.ts"),
    ev.fileEdit("src/routes/notifications.ts"),
    ev.fileEdit("src/routes/health.ts"),
    ev.tool("npm run test -- 67/67 passed after route prefix migration"),
    ev.fileWrite("docs/api-v1.md"),
    ev.fileEdit("docs/openapi.yaml"),
    ev.fileWrite("src/middleware/api-version.ts"),
    ev.fileWrite("src/middleware/deprecation.ts"),
    ev.fileEdit("src/lib/api-client.ts"),
    ev.fileEdit("src/hooks/use-products.ts"),
    ev.fileEdit("src/hooks/use-auth.ts"),
    ev.fileEdit("src/hooks/use-cart.ts"),
    ev.tool("Updated all frontend API calls to use /api/v1/ prefix"),
    ev.tool("npm run build -- OK"),
    ev.tool("npx playwright test -- 6/6 e2e tests passed with new API prefix"),
    git("add"),
    git("commit"),
    git("push"),
    ev.task("Set up API documentation portal with Swagger UI at /api/docs"),
    ev.prompt("API versioning done. All routes under /api/v1/, deprecation headers ready, docs updated."),
  ];
}

// Cycle 15: Full-text search + caching
export function cycle15() {
  return [
    ev.prompt("Add product search with full-text capabilities and cache the results."),
    ev.decision("Search: PostgreSQL tsvector for full-text search — no external dependency (no Elasticsearch needed at our scale), GIN index for fast lookup, ts_rank for relevance scoring"),
    ev.fileEdit("prisma/schema.prisma"),
    ev.tool("npx prisma migrate dev --name add-search-index — Added tsvector column + GIN index on products table"),
    ev.fileWrite("src/search/product-search.ts"),
    ev.fileWrite("src/search/search-utils.ts"),
    ev.fileWrite("src/routes/search.ts"),
    ev.fileEdit("src/server.ts"),
    ev.fileRead("src/cache/redis-client.ts"),
    ev.fileWrite("src/cache/search-cache.ts"),
    ev.fileEdit("src/routes/search.ts"),
    ev.tool("Search cache: Redis with 5min TTL, invalidated on product create/update/delete"),
    ev.fileEdit("src/routes/products.ts"),
    ev.fileWrite("src/search/__tests__/product-search.test.ts"),
    ev.tool("npm run test -- search: 7/7 passed (basic search, fuzzy match, category filter, sort by relevance, pagination, cache hit, cache invalidation)"),
    ev.fileWrite("src/components/search/search-bar.tsx"),
    ev.fileWrite("src/components/search/search-results.tsx"),
    ev.fileWrite("src/hooks/use-search.ts"),
    ev.fileEdit("src/components/layout/header.tsx"),
    ev.error("Error: search cache not invalidating when product is updated via admin — admin route uses BYPASSRLS Prisma client which doesn't trigger the invalidation middleware"),
    ev.fileEdit("src/routes/admin/products.ts"),
    ev.resolved("Fixed: added explicit cache invalidation call in admin product update handler"),
    ev.tool("npm run build -- OK"),
    git("add"),
    git("commit"),
    git("push"),
    ev.task("Add search analytics and popular search terms dashboard"),
    ev.prompt("Search is live. PostgreSQL tsvector with Redis caching. Relevance scoring and pagination working."),
  ];
}

// Cycle 16: Launch prep — AF3 still unresolved, AF5 always latest
export function cycle16() {
  return [
    ev.prompt("Pre-launch checklist. Fix remaining issues and verify everything works end-to-end."),
    ev.fileRead("src/ws/handler.ts"),
    ev.prompt("The WebSocket memory leak is STILL our biggest open issue. The heartbeat ping/pong was planned in cycle 10 but never implemented. What's the status?"),
    ev.error("BLOCKER: WebSocket memory leak STILL UNRESOLVED — heartbeat ping/pong mechanism planned but NOT implemented. Heap growth confirmed in staging at 80MB/hour under 50 concurrent connections. Server crashes with OOM after ~4 hours. This MUST be fixed before launch"),
    ev.fileRead("src/ws/connection-pool.ts"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.fileWrite("src/ws/heartbeat.ts"),
    ev.fileEdit("src/ws/connection-pool.ts"),
    ev.tool("Implemented heartbeat: ping every 30s, connections that don't pong within 10s are terminated and removed from connection map"),
    ev.tool("npm run test -- ws heartbeat: 3/5 passed, 2 failed (edge cases: rapid reconnect during ping, multiple tabs same user)"),
    ev.prompt("Heartbeat is partially working but edge cases still fail. Need to fix rapid reconnect and multi-tab."),
    ev.fileEdit("src/ws/heartbeat.ts"),
    ev.fileEdit("src/ws/handler.ts"),
    ev.tool("npm run test -- ws heartbeat: 4/5 passed, 1 failed (multi-tab: user opens 3 tabs, closes 1, heartbeat kills all)"),
    ev.error("Error: heartbeat bug — when user has multiple tabs open, closing one tab triggers heartbeat failure detection for ALL connections from that user (grouped by userId, should be per-connection)"),
    ev.prompt("The multi-tab heartbeat bug is tricky. Continue debugging but don't block launch on it. We can limit to 1 WS connection per user initially."),
    ev.fileEdit("src/ws/heartbeat.ts"),
    ev.fileWrite("src/ws/connection-limiter.ts"),
    ev.decision("Launch compromise: limit WebSocket to 1 connection per user (latest connection wins). Multi-tab support deferred to v1.1. This avoids the heartbeat multi-tab bug"),
    ev.tool("npm run test -- all: 78/80 passed (2 multi-tab ws tests skipped/deferred)"),
    ev.fileWrite("CHANGELOG.md"),
    ev.fileEdit("package.json"),
    git("add"),
    git("commit"),
    git("push"),
    git("tag"),
    ev.task("LAUNCH PREP: Deploy v1.0 to production. Monitor WebSocket memory with 1-connection-per-user limit. Fix multi-tab in v1.1"),
    ev.prompt("Pre-launch done. WebSocket limited to 1 connection per user as a workaround. Multi-tab heartbeat bug deferred to v1.1. Ready to deploy v1.0."),
  ];
}

// ── Exports ────────────────────────────────────────────────────────────────────

/**
 * All 16 cycle generators, indexed 0-15.
 * Each returns an array of 30-80 events representing one compaction cycle.
 */
export const REAL_CYCLES = [
  cycle1, cycle2, cycle3, cycle4, cycle5, cycle6, cycle7, cycle8,
  cycle9, cycle10, cycle11, cycle12, cycle13, cycle14, cycle15, cycle16,
];
