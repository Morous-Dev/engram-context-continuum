/**
 * compact-budget.ts — Dynamic budget calculator for SLM compact briefs.
 *
 * Responsible for: calculating how many tokens the SLM brief should use
 * based on the session's compaction history and current event volume.
 * The brief must be small but dense — leaving maximum room for the user's
 * continued work after compaction.
 *
 * Depends on: src/tokenization/budget.ts (estimateEventTokens).
 * Depended on by: src/session/compact-brief.ts.
 */

import type { StoredEvent } from "./db.js";
import { estimateEventTokens } from "../tokenization/budget.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Budget calculation result for the SLM compact brief. */
export interface CompactBudget {
  /** Target token count for the SLM brief. */
  briefTokenBudget: number;
  /** Compression ratio to request from the SLM. */
  compressionRatio: number;
  /** Total estimated tokens across all input events. */
  totalEventTokens: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Base brief budget by compaction cycle count. */
const BUDGET_BY_COMPACT_COUNT: Record<number, number> = {
  1: 1500,  // First compaction — session is young, less to compress
  2: 2500,  // Second/third — more history, need denser summary
  3: 2500,
};

/** Budget for sessions with 4+ compactions. */
const HIGH_COMPACT_BUDGET = 3500;

/** Minimum compression ratio — never go below this. */
const MIN_COMPRESSION_RATIO = 3.0;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Calculate the token budget and compression ratio for an SLM compact brief.
 *
 * Budget scales with compact_count:
 *   compact_count 1   → ~1500 tokens (session is young)
 *   compact_count 2-3 → ~2500 tokens (more history)
 *   compact_count 4+  → ~3500 tokens (long session, aggressive compression)
 *
 * Compression ratio is dynamic: max(3.0, totalEventTokens / briefTokenBudget).
 * If events are small, ratio stays at the floor. If events are large, ratio
 * increases to ensure the brief fits within budget.
 *
 * @param events       - Session events to be compressed.
 * @param compactCount - Number of compactions so far (including this one).
 * @returns CompactBudget with token budget and compression ratio.
 */
export function calculateCompactBudget(
  events: StoredEvent[],
  compactCount: number,
): CompactBudget {
  const totalEventTokens = events.reduce(
    (sum, ev) => sum + estimateEventTokens(ev),
    0,
  );

  const briefTokenBudget =
    BUDGET_BY_COMPACT_COUNT[compactCount] ?? HIGH_COMPACT_BUDGET;

  // Dynamic ratio: ensure brief fits within budget, with a floor of 3.0x
  const dynamicRatio = totalEventTokens > 0
    ? totalEventTokens / briefTokenBudget
    : MIN_COMPRESSION_RATIO;

  const compressionRatio = Math.max(MIN_COMPRESSION_RATIO, dynamicRatio);

  return {
    briefTokenBudget,
    compressionRatio,
    totalEventTokens,
  };
}
