/**
 * auditor.ts — Ghost token profiler for context window waste detection.
 *
 * Responsible for: analyzing session events to identify "ghost tokens" —
 * context window content that no longer serves a useful purpose. Categories
 * of ghost tokens include: stale file-read events (file was later overwritten),
 * resolved errors (an error followed by a success on the same path), and
 * redundant decisions (same decision captured multiple times).
 *
 * This is used by the Stop hook to prune the event set before writing the
 * handoff, and by the PreCompact hook to optimize the resume snapshot.
 *
 * Depends on: src/session/db.ts (StoredEvent), src/tokenization/budget.ts.
 * Depended on by: src/hooks/stop.ts.
 */

import type { StoredEvent } from "../session/db.js";
import { estimateEventTokens } from "./budget.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Severity of a detected ghost token issue. */
export type GhostSeverity = "high" | "medium" | "low";

/** A detected ghost token in the session events. */
export interface GhostToken {
  /** The event ID that is a ghost. */
  eventId: number;
  /** Why this event is considered a ghost. */
  reason: string;
  /** Severity: high = definitely stale, medium = likely stale, low = possibly stale. */
  severity: GhostSeverity;
  /** Estimated tokens wasted by this ghost. */
  wastedTokens: number;
}

/** Full audit result for a session's events. */
export interface AuditResult {
  /** All detected ghosts. */
  ghosts: GhostToken[];
  /** Total estimated wasted tokens. */
  totalWastedTokens: number;
  /** Percentage of total session tokens that are ghosts. */
  wastePercent: number;
  /** Events after removing high-severity ghosts. */
  cleanedEvents: StoredEvent[];
}

// ── Detectors ─────────────────────────────────────────────────────────────────

/**
 * Detect stale file_read events: a file was read and then later overwritten,
 * making the read event's context no longer accurate.
 *
 * Ghost condition: file_read event for path X exists, AND a later file_write
 * or file_edit event for the same path also exists.
 *
 * @param events - All session events.
 * @returns Array of ghost tokens for stale reads.
 */
function detectStaleReads(events: StoredEvent[]): GhostToken[] {
  const ghosts: GhostToken[] = [];

  // Build a set of paths that were later written/edited
  const overwrittenPaths = new Set<string>();
  for (const ev of events) {
    if (ev.type === "file_write" || ev.type === "file_edit") {
      overwrittenPaths.add(ev.data);
    }
  }

  for (const ev of events) {
    if (ev.type === "file_read" && overwrittenPaths.has(ev.data)) {
      ghosts.push({
        eventId: ev.id,
        reason: `file_read for ${ev.data} superseded by later write/edit`,
        severity: "medium",
        wastedTokens: estimateEventTokens(ev),
      });
    }
  }

  return ghosts;
}

/**
 * Detect duplicate decisions: the same decision text was captured more than once.
 * Only the most recent occurrence is meaningful.
 *
 * @param events - All session events.
 * @returns Array of ghost tokens for duplicate decisions.
 */
function detectDuplicateDecisions(events: StoredEvent[]): GhostToken[] {
  const ghosts: GhostToken[] = [];
  const decisionEvents = events.filter(e => e.category === "decision");

  // Track last occurrence of each decision text
  const lastOccurrence = new Map<string, number>();
  for (const ev of decisionEvents) {
    const key = ev.data.slice(0, 100); // Normalize to first 100 chars
    lastOccurrence.set(key, ev.id);
  }

  // Mark earlier occurrences as ghosts
  for (const ev of decisionEvents) {
    const key = ev.data.slice(0, 100);
    if (lastOccurrence.get(key) !== ev.id) {
      ghosts.push({
        eventId: ev.id,
        reason: `duplicate decision superseded by later occurrence`,
        severity: "low",
        wastedTokens: estimateEventTokens(ev),
      });
    }
  }

  return ghosts;
}

/**
 * Detect redundant cwd events: only the last cwd change matters.
 * All earlier cwd events are ghosts.
 *
 * @param events - All session events.
 * @returns Array of ghost tokens for non-final cwd events.
 */
function detectRedundantCwd(events: StoredEvent[]): GhostToken[] {
  const cwdEvents = events.filter(e => e.category === "cwd");
  if (cwdEvents.length <= 1) return [];

  // All but the last cwd event are ghosts
  return cwdEvents.slice(0, -1).map(ev => ({
    eventId: ev.id,
    reason: "cwd superseded by later directory change",
    severity: "high",
    wastedTokens: estimateEventTokens(ev),
  }));
}

/**
 * Detect resolved errors: an error event followed by a successful operation
 * on the same topic. Heuristic: error events older than 10 events ago are
 * likely resolved (session continued without new errors).
 *
 * @param events - All session events.
 * @returns Array of ghost tokens for likely-resolved errors.
 */
function detectResolvedErrors(events: StoredEvent[]): GhostToken[] {
  const ghosts: GhostToken[] = [];
  const errorEvents = events.filter(e => e.category === "error");

  for (const errorEv of errorEvents) {
    // If there are 10+ events after this error, it was likely resolved
    const errorIndex = events.findIndex(e => e.id === errorEv.id);
    const eventsAfter = events.length - errorIndex - 1;
    if (eventsAfter >= 10) {
      ghosts.push({
        eventId: errorEv.id,
        reason: "error likely resolved (10+ subsequent events with no recurrence)",
        severity: "low",
        wastedTokens: estimateEventTokens(errorEv),
      });
    }
  }

  return ghosts;
}

// ── Main audit function ───────────────────────────────────────────────────────

/**
 * Audit a session's events for ghost tokens and return a cleaned event list.
 *
 * Runs all detectors and aggregates results. The cleanedEvents list removes
 * only high-severity ghosts to preserve potentially-useful context.
 *
 * @param events - All session events to audit.
 * @returns AuditResult with ghosts, waste metrics, and cleaned event list.
 */
export function auditSessionEvents(events: StoredEvent[]): AuditResult {
  const allGhosts: GhostToken[] = [
    ...detectStaleReads(events),
    ...detectDuplicateDecisions(events),
    ...detectRedundantCwd(events),
    ...detectResolvedErrors(events),
  ];

  const totalWastedTokens = allGhosts.reduce((sum, g) => sum + g.wastedTokens, 0);
  const totalTokens = events.reduce((sum, ev) => sum + estimateEventTokens(ev), 0);
  const wastePercent = totalTokens > 0 ? Math.round((totalWastedTokens / totalTokens) * 100) : 0;

  // Remove high-severity ghosts from the cleaned list
  const highSeverityIds = new Set(
    allGhosts.filter(g => g.severity === "high").map(g => g.eventId)
  );
  const cleanedEvents = events.filter(ev => !highSeverityIds.has(ev.id));

  return {
    ghosts: allGhosts,
    totalWastedTokens,
    wastePercent,
    cleanedEvents,
  };
}
