# AI Co-Developer Standard

This file defines mandatory behavior for any AI coding assistant working on this project
(Claude Code, Codex CLI, Gemini CLI, Cursor, OpenCode, etc.).
Project-specific rules live in `PROJECT.md`.

If this file conflicts with `PROJECT.md` — `PROJECT.md` wins for project-specific facts.
If this file conflicts with code or migrations — code and migrations win.

---

## 0. First Thing Every Session

1. Check if `PROJECT.md` exists in the repo root.
2. If it **does exist** — read it fully before doing anything else.
3. If it **does not exist** — before writing any code, create it by:
   - Reading the repo structure, key files, and any existing docs
   - Identifying the stack, architecture, active modules, and known patterns
   - Using the `PROJECT.md` template defined in Section 1 of this file
   - Confirming with the user that the generated `PROJECT.md` looks correct
4. Never start coding without `PROJECT.md` present and read.

---

## 1. PROJECT.md Template

When creating `PROJECT.md` for a new project, use this structure:

```
# [Project Name] — Project Context

Last verified: [date]
This file is the project-specific companion to AGENTS.md.
Code and migrations win over this file when facts conflict.

## 0. Stack
| Layer | Technology |
|---|---|
| Frontend | ... |
| Backend | ... |
| Database | ... |
| Hosting | ... |
| Other | ... |

## 1. Project Purpose
One paragraph: what this project is, who uses it, what problem it solves.

## 2. Priority Order
When facts conflict, use:
1. Runtime code and API handlers
2. Database migrations
3. README.md
4. This file (PROJECT.md)
5. AGENTS.md

## 3. Runtime Snapshot
- Auth flow (if applicable)
- Shell/navigation model
- Active modules/routes with status
- Data and tenancy model (if multi-tenant)

## 4. High-Signal Files
List the most important files Claude should read first when
starting work. Group by: core runtime, contexts, data/types,
backend foundation, UI primitives.

## 5. Backend Surface
List all API endpoints or server functions grouped by domain.

## 6. Security Baseline
- Auth pattern for this project
- Any elevated auth requirements
- OAuth flows in use
- CORS policy

## 7. Data Design Rules
Any project-specific data invariants (e.g. integer cents for
financial data, UTC timestamps, soft deletes only).

## 8. Known Mismatches
Document intentional technical debt, non-standard patterns,
or legacy code that exists for a reason. This prevents Claude
from "fixing" things that are deliberate.

## 9. Related Contracts
Other files Claude must read and follow (e.g. CONTRIBUTING.md,
release checklist).
```

---

## 2. Mandatory Delivery Rules

1. Deliver end-to-end by default: backend + UI wiring + data visibility.
2. If backend-only is intentional, explicitly report `BACKEND-ONLY BY DESIGN` and document the follow-up.
3. No silent partial completion claims.
4. No silent sync success when writes fail.
5. Before any completion claim, verify compliance with `PROJECT.md` and any contracts it references.

---

## 3. Security Fundamentals

These apply to every project unless `PROJECT.md` specifies otherwise:

1. Never hardcode secrets or API keys — use environment variables or a vault service.
2. Never commit secrets to git — not in code, not in comments, not in config files.
3. Use separate credentials for dev, staging, and production environments.
4. Validate all input server-side — never trust what the client sends.
5. Add rate limiting on auth and write operations.
6. Set CORS to specific origins, never `*`.
7. Never pass auth tokens in URL query parameters — header-only auth.
8. Apply least privilege to all data access and operations.
9. If unsure whether something is sensitive, treat it as sensitive.

---

## 4. Engineering Principles

1. **Composition over inheritance** — prefer small composable units over deep hierarchies
2. **YAGNI** — build the simplest thing that works; do not over-engineer
3. **Least privilege** — minimum access required for functions, services, and users
4. **Make illegal states unrepresentable** — model data so invalid combinations cannot exist
5. **Code for humans first** — readability and clear intent over cleverness
6. **Immutability where it matters** — avoid accidental mutation in stateful paths
7. **Think in pipelines** — input → transform → output; steps individually testable
8. **Account for abstraction cost** — every abstraction must pay for itself in clarity or reuse
9. **Refactor continuously** — not as an optional cleanup phase
10. **Build for change, not prediction** — designs easy to modify tomorrow
11. **Fighter jet, not passenger jet** — just enough to complete the mission safely; do not build enterprise infrastructure for a simple problem

---

## 5. Delivery Protocol

### A. Start With Contract
Before writing any code, define:
1. Problem statement and user impact
2. Expected behavior and what is out of scope
3. Acceptance criteria (testable)
4. Impacted layers (DB, backend, API, UI, docs)

If requirements are unclear, ask one focused clarifying question before implementing.

### B. Diagnose Before Patching (Bugs)
1. Capture exact repro steps — expected vs actual behavior
2. Write root cause in 1–3 sentences before editing anything
3. Identify blast radius — what adjacent paths could be affected

### C. Plan Minimal Safe Change
1. Choose the smallest change that resolves the root issue
2. Avoid unrelated refactors in the same patch
3. Define rollback path before merging

### D. Implement End-to-End (Default)
For user-facing changes, completion must include:
1. Data/schema layer (if needed)
2. Backend logic and error handling
3. API contract handling (`res.ok`, payload error shape)
4. UI trigger wiring and state updates
5. UI states: `loading`, `empty`, `success`, `error`
6. Auth/role checks for protected flows

If backend-only, mark `BACKEND-ONLY BY DESIGN` and document follow-up.

### E. Evidence-Based Completion
Every non-trivial delivery must report:
1. What was the problem / feature contract
2. Root cause (bugs only)
3. Files changed
4. What changed and why
5. End-to-end wiring check (DB → backend → API → UI → states)
6. Verification gates run and results
7. Docs updated
8. Residual risks
9. Rollback plan

Hard rules:
- No "probably fixed" claims
- No silent failure paths for critical operations
- No completion claims without verification evidence
- No file left undocumented after being touched

---

## 6. Verification Gates Before "Done"

For non-trivial changes, run all relevant gates for the project's stack:
1. Build gate (e.g. `npm run build`)
2. Type/lint gate (e.g. `npm run typecheck`)
3. Test gate (unit/integration/e2e where available)
4. Contract/API gate if the project has one
5. Manual critical-path smoke test from UI action to visible outcome
6. Confirm all touched files meet the documentation standard in Section 7

Do not claim "done" without reporting gate results or explaining why a gate could not run.

---

## 7. Documentation Standards (Mandatory)

Documentation is not optional. Every file, function, and non-obvious logic block must be
documented. This is part of the definition of done — not a separate task.

### File Header (Required on every file)
Every file must have a header block containing:
1. **What this file is** — one sentence describing its purpose
2. **What it is responsible for** — what it owns and manages
3. **What it depends on** — key imports, services, or context it relies on
4. **What depends on it** — who calls or imports this file

### Function and Component Comments (Required)
Every non-trivial function and component must have a comment containing:
1. **What it does** — plain English description
2. **Parameters** — what each argument is and expects
3. **Return value** — what it returns and in what shape
4. **What can go wrong** — known failure modes, edge cases, gotchas

### Non-Obvious Logic (Required)
Any logic that is not immediately obvious must have an inline comment explaining:
1. **Why** this approach was chosen
2. **What invariant is being preserved** if the code is protecting a rule
3. **What was tried and rejected** if the solution is non-standard

### Module README (Required on every module folder)
Every meaningful folder must have a `README.md` containing:
1. What this module/folder is — purpose and scope
2. How it works end to end — data flow from trigger to output
3. Key files — the most important files and what they do
4. Patterns to follow — conventions specific to this module
5. Known limitations or technical debt — what to watch out for

### Comment Quality Rules
- Write for a developer who is new to this file
- Do not restate what the code obviously does
- If a comment adds no information beyond what the code shows, omit it
- Keep comments current — outdated comments are worse than no comments
- Update comments when behavior changes, in the same commit

### When to Apply
- When creating any new file
- When making non-trivial changes to an existing file
- When explicitly asked to document a file or module
- During feature/phase closeout — all touched files must be documented before marking done

---

## 8. Sync and Data Truthfulness

1. Increment sync counters only after verified successful write.
2. Do not swallow per-scope errors — surface them in the API response.
3. Return failure/partial status if any part of a requested operation fails.
4. UI must verify `res.ok` and payload before showing success to the user.
5. No "success with hidden failure" is allowed.

---

## 9. Documentation Sync Rules

If behavior, contracts, security, or process changed — update docs in the same session:
1. `PROJECT.md` — if stack, runtime, or architecture changed
2. `AGENTS.md` — if a universal rule needs updating (rare)
3. `README.md` — if setup, usage, or runbook changed
4. Any roadmap or product doc if direction changed

No "docs later" for contract, security, or data-model changes.

---

## 10. Change Intake for Fast-Moving Requirements

When a request comes from a meeting or same-day decision:
1. Split into: must-have now / can defer / unknowns needing confirmation
2. Keep external contracts stable (API shapes, route IDs, module IDs) unless intentional
3. Prefer additive changes over destructive rewrites
4. Record dropped ideas vs replacements in docs in the same change set

---

## 11. Output Quality Rules

1. Report findings by severity (`P0 / P1 / P2`) when auditing or reviewing.
2. Include concrete file references for important claims.
3. Distinguish new regression vs pre-existing risk.
4. If uncertain, state the uncertainty and what check is needed to resolve it.
5. No claim of "all correct" without passing evidence from required gates.

---

## 12. Production-Readiness Principles

### Logging
1. Log everything that matters — inputs, outputs, errors, and context — not just exceptions
2. Every API endpoint must log: who called it, what was requested, what was returned, and any error that occurred
3. Silent failures are not acceptable — if something goes wrong, there must be a trace of what happened
4. Log at the right level: `error` for failures, `warn` for unexpected but recoverable states, `info` for significant events
5. Never log raw secrets, tokens, or PII — sanitize before logging

### Defensive Coding
1. Assume users will do the unexpected — emojis in text fields, double-submits, empty submissions, SQL injection attempts, and inputs that are 10x the expected size
2. Validate all inputs at the boundary — type, length, format, and range — before any processing
3. Protect all forms and mutation endpoints against double-submission (loading states, disabled buttons, idempotency keys where needed)
4. Test the unhappy path explicitly — what happens when the API is down, the DB is slow, the user has no data, the session expires mid-flow

### Technical Debt
1. Taking a shortcut is acceptable when speed is the priority — hiding a shortcut is not
2. Every intentional shortcut must be logged explicitly with a `// TODO:` comment that explains: what the shortcut is, why it was taken, and what the proper solution looks like
3. Do not refactor and ship debt in the same patch — keep them separate so debt is visible
4. If a quickly-built feature survives and users adopt it, refactor it properly before building on top of it

### Naming
1. Never use vague names like `data`, `handler`, `doStuff`, `temp`, `info`, or `result` — every variable, function, and file must have a name that describes exactly what it is
2. If you cannot name something clearly, stop — it usually means the logic is not well understood yet; clarify the logic first, then name it
3. Use names that reveal intent: `validatedUserInput` not `input`, `unpaidInvoices` not `invoices`, `sendPaymentReminderEmail` not `sendEmail`
4. Consistent naming across the codebase matters — if the pattern is `handleX` for event handlers, follow it everywhere

### Production Parity
1. Do not assume local behavior matches production — local is a controlled environment that hides latency, scale, and concurrency problems
2. Test with realistic data volumes — a feature that works with 10 rows may break with 10,000
3. Deploy early and often — big-bang releases hide integration problems; small frequent deploys surface them immediately
4. Always define behavior for: empty states, loading states, error states, and timeout states — not just the happy path

---

## 13. Pre-Commit Hygiene

1. Do not commit customer or PII data exports (`*.csv`, `*.xlsx`, raw snapshots) unless explicitly approved.
2. If uncertain whether data is sensitive, treat it as sensitive and keep it out.
3. Keep `.env` and all local secret-bearing files out of git.
4. Check for untracked data artifacts before every push.

---

## 14. TypeScript Rules

These apply to every TypeScript file, every session, without exception.

1. **`any` is forbidden.** Use `unknown`, generics, or union types. If a value is unknown at compile time, use `unknown` and add a runtime type guard before use. Never use `any` as a shortcut.
2. **Never cast, always guard.** Type assertions (`as`) are lies to the compiler. Replace with `typeof`, `instanceof`, `in`, or custom type guard functions. The only exception: `as const`.
3. **Exhaust every branch.** Every `switch` on a discriminated union must end with `assertNever`. No silent fallthrough. If a new variant is added to a union, every unhandled switch must become a compile error.
4. **Schemas derive from domain — never redefine.** Every Zod schema, DTO, and tool definition must derive its enum values from the domain source. Hardcoded enum subsets silently reject valid domain states and corrupt financial data.
5. **`tsc --noEmit` is the final judge.** No task is complete until the compiler passes clean. `@ts-ignore` requires a written justification comment. `@ts-expect-error` without comment is a P1 finding.

---

## 15. React Discipline

1. **No data fetching in `useEffect`.** Use TanStack Query. Manual fetch-in-effect causes race conditions, ignores caching, and leaks memory. No exceptions.
2. **Sacred Three-Tier Split.** Every component belongs to exactly one tier: Tier 3 sources state (TanStack Query / Zustand), Tier 2 maps domain types to UI props, Tier 1 renders pixels. A component spanning tiers is a God Component — split it.
3. **No Syncing Store.** TanStack Query owns server state. Zustand owns UI intent. Never copy query data into Zustand via `useEffect`. Two sources of truth means both are lying.
4. **Every effect has a cleanup.** Every subscription, listener, and AbortController must be cleaned up on unmount. Unmounting without cleanup is abandonment.

---

## 16. File Size Limits

These are hard limits, not guidelines. Exceeding them is a signal to split, not to ask permission.

| Unit | Warning | Hard Limit |
|---|---|---|
| Any file | 400 lines | 500 lines |
| Function / method | 40 lines | 80 lines |
| React component | 150 lines | 200 lines |
| React hook | 80 lines | 120 lines |

If a file must exceed its limit for a legitimate reason, add a `// OVERSIZE:` comment explaining why and what the split plan is.

---

## 17. Commit Standards

Every commit follows the Conventional Commits specification — no exceptions.

Format: `type(scope): description` — lowercase, imperative mood, under 72 characters, no trailing period.

Valid types: `feat` · `fix` · `chore` · `docs` · `refactor` · `test` · `style` · `perf` · `ci`

One commit = one logical change. If the message needs "and" to describe it, it is two commits.

Examples:
- `feat(ar-dashboard): add overdue invoice filter`
- `fix(qbo-sync): handle empty response from invoices endpoint`
- `chore(deps): update supabase-js to 2.39.0`
