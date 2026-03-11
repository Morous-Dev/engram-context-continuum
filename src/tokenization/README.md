# src/tokenization — Token budget calculator and ghost token auditor

## What this module is

The context efficiency layer. Estimates token counts for session events, selects
the highest-value events within a token budget, and audits events for "ghost
tokens" — stale, redundant, or superseded events that waste context space.

## How it works end to end

```
PreCompact hook
  → auditor.ts:auditSessionEvents()       ← detect ghost tokens in full event list
  → AuditResult.cleanedEvents             ← high-severity ghosts removed
  → snapshot.ts:buildResumeSnapshot()     ← receives cleaned events (not raw)

Stop hook
  → auditor.ts:auditSessionEvents()       ← same audit before handoff is built
  → budget.ts:selectEventsWithinBudget()  ← pick best events for snapshot context
```

## Key files

| File | Purpose |
|---|---|
| `budget.ts` | Token estimation, priority-based event selection within a budget. |
| `auditor.ts` | Ghost token detection: stale reads, duplicate decisions, resolved errors. |

## Token model

`CHARS_PER_TOKEN = 4` — a deliberate approximation. Real tokenizers vary by
model and vocabulary. The 4-char estimate is conservative for English + code and
matches the approach used in context-mode and claude-mem.

## Priority budget allocation (selectEventsWithinBudget)

| Priority | Rule |
|---|---|
| P1 (file/task/rule) | Always included — never dropped |
| P2 (cwd/error/decision/env/git) | Fill after P1 |
| P3+ | Fill remaining budget, most-recent-first |

Default budget: **1500 tokens**.

## Ghost token categories (auditSessionEvents)

| Ghost type | Detection rule | Severity |
|---|---|---|
| Stale read | `file_read` event followed by a later `write`/`edit` for same path | high |
| Duplicate decision | Earlier occurrence of a decision already seen later in session | high |
| Redundant cwd | All but the last `cwd` event | low |
| Resolved error | `error` event with 10+ subsequent events (assumed resolved) | medium |

Only **high-severity** ghosts are removed from `cleanedEvents`. Low/medium are
reported in `AuditResult.ghosts` but left in the event stream for the snapshot
builder to use or discard via priority budget.

## Patterns to follow

- `auditSessionEvents()` is pure: it takes events and returns a new array + stats.
  Never mutate the input event list.
- `selectEventsWithinBudget()` always returns all P1 events regardless of budget.
  The budget cap only applies to P2 and P3+.
- `wastePercent` in `AuditResult` is a diagnostic metric, not a trigger. The
  PreCompact hook does not skip snapshotting based on waste percentage.

## Known limitations

- Token estimation is character-count-based, not model-specific. For models with
  very different tokenization (e.g., multilingual or code-heavy sessions), actual
  token usage may differ by 20–30%.
- Ghost detection for stale reads compares file paths as strings. Normalized vs
  non-normalized paths (e.g., trailing slash, backslash on Windows) will miss
  the match. Path normalization is not yet applied.
