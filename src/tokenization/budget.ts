/**
 * budget.ts — Token budget calculator for session event prioritization.
 *
 * Responsible for: estimating token counts for session events, allocating a
 * token budget across priority tiers (P1/P2/P3), and selecting which events
 * to include in a context injection when the total would exceed the budget.
 *
 * Ported logic from: claude-mem/src/services/context/TokenCalculator.ts
 * (AGPL-3.0 — logic ported, code rewritten from scratch).
 *
 * Depends on: src/session/db.ts (StoredEvent type).
 * Depended on by: src/tokenization/auditor.ts, src/hooks/stop.ts.
 */

import type { StoredEvent } from "../session/db.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Conservative character-to-token estimate.
 * GPT-family models average ~4 chars/token. Claude is similar.
 * Using 4 to stay on the safe side.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Default maximum tokens for a context injection block.
 * Keeps the injected session knowledge well under 2K tokens.
 */
export const DEFAULT_MAX_TOKENS = 1500;

/** Priority tier boundaries. Lower number = higher priority. */
const P1_MAX = 1; // critical: files, tasks, rules
const P2_MAX = 2; // important: cwd, error, decision, env, git
// P3+ = low priority: subagent, skill, role, data, intent, mcp

// ── Types ─────────────────────────────────────────────────────────────────────

/** Token count breakdown for a set of events. */
export interface TokenBudgetResult {
  /** Events selected within the token budget, ordered by priority. */
  selectedEvents: StoredEvent[];
  /** Estimated total tokens of the selected events. */
  estimatedTokens: number;
  /** Number of events dropped due to budget exhaustion. */
  droppedCount: number;
  /** Whether any P1 events were dropped (should not happen). */
  p1Dropped: boolean;
}

// ── Functions ─────────────────────────────────────────────────────────────────

/**
 * Estimate the token count for a single string.
 *
 * @param text - Input string.
 * @returns Estimated token count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate the token count for a single StoredEvent.
 * Includes the type, category, and data fields.
 *
 * @param event - A stored session event.
 * @returns Estimated token count.
 */
export function estimateEventTokens(event: StoredEvent): number {
  const size = (event.type?.length ?? 0) + (event.category?.length ?? 0) + (event.data?.length ?? 0);
  return Math.ceil(size / CHARS_PER_TOKEN);
}

/**
 * Select events within a token budget, prioritizing P1 over P2 over P3+.
 *
 * Algorithm:
 * 1. Separate events into P1, P2, P3+ tiers
 * 2. Always include all P1 events (critical — file, task, rule)
 * 3. Fill remaining budget with P2 events (most recent first)
 * 4. Fill remaining budget with P3+ events (most recent first)
 *
 * @param events    - All session events to consider.
 * @param maxTokens - Maximum token budget (default DEFAULT_MAX_TOKENS).
 * @returns TokenBudgetResult with selected events and metadata.
 */
export function selectEventsWithinBudget(
  events: StoredEvent[],
  maxTokens = DEFAULT_MAX_TOKENS,
): TokenBudgetResult {
  const p1 = events.filter(e => e.priority <= P1_MAX);
  const p2 = events.filter(e => e.priority > P1_MAX && e.priority <= P2_MAX);
  const p3 = events.filter(e => e.priority > P2_MAX);

  const selected: StoredEvent[] = [];
  let usedTokens = 0;
  let p1Dropped = false;

  // Always include P1 events — they are critical context
  for (const ev of p1) {
    const cost = estimateEventTokens(ev);
    if (usedTokens + cost <= maxTokens) {
      selected.push(ev);
      usedTokens += cost;
    } else {
      p1Dropped = true;
    }
  }

  // Fill remaining budget with P2 events (most recent first)
  for (const ev of [...p2].reverse()) {
    const cost = estimateEventTokens(ev);
    if (usedTokens + cost <= maxTokens) {
      selected.push(ev);
      usedTokens += cost;
    }
  }

  // Fill remaining budget with P3+ events (most recent first)
  for (const ev of [...p3].reverse()) {
    const cost = estimateEventTokens(ev);
    if (usedTokens + cost <= maxTokens) {
      selected.push(ev);
      usedTokens += cost;
    }
  }

  // Sort back to chronological order for consistent rendering
  selected.sort((a, b) => a.id - b.id);

  return {
    selectedEvents: selected,
    estimatedTokens: usedTokens,
    droppedCount: events.length - selected.length,
    p1Dropped,
  };
}

/**
 * Calculate total token usage across all events for a session.
 *
 * @param events - All session events.
 * @returns Total estimated token count.
 */
export function calculateTotalTokens(events: StoredEvent[]): number {
  return events.reduce((sum, ev) => sum + estimateEventTokens(ev), 0);
}

/**
 * Calculate the token cost savings percentage of using event-based context
 * instead of injecting raw session data.
 *
 * @param rawContextTokens   - Tokens the raw approach would use.
 * @param budgetedTokens     - Tokens after budget selection.
 * @returns Savings percentage (0–100).
 */
export function calculateSavingsPercent(rawContextTokens: number, budgetedTokens: number): number {
  if (rawContextTokens === 0) return 0;
  return Math.round(((rawContextTokens - budgetedTokens) / rawContextTokens) * 100);
}
