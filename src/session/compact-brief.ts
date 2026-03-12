/**
 * compact-brief.ts — SLM-compressed brief generator for compaction recovery.
 *
 * Responsible for: running the SLM compression pipeline on session events and
 * returning a formatted `<session_knowledge>` XML block that replaces the raw
 * event dump normally injected after compaction. The SLM brief carries the same
 * information at 3-5x fewer tokens, plus semantic synthesis the raw dump cannot
 * provide.
 *
 * Pipeline:
 *   1. Group events by category (reuses writer.ts patterns)
 *   2. Build plain-text synthesis input via buildSynthesisInput()
 *   3. Calculate dynamic compression ratio via compact-budget.ts
 *   4. Run SLM compression with compact-specific prompt (buildCompactBriefPrompt)
 *   5. Format result as <session_knowledge source="compact"> XML
 *   6. Return null on any failure (fallback to raw event dump)
 *
 * Depends on: src/handoff/writer.ts (buildSynthesisInput),
 *             src/compression/index.ts (getCompressor),
 *             src/compression/schema.ts (buildCompactBriefPrompt),
 *             src/session/compact-budget.ts (calculateCompactBudget).
 * Depended on by: src/hooks/precompact.mjs.
 */

import type { StoredEvent } from "./db.js";
import type { StructuredHandoff } from "../compression/types.js";
import { buildSynthesisInput } from "../handoff/writer.js";
import { getCompressor } from "../compression/index.js";
import { buildCompactBriefPrompt } from "../compression/schema.js";
import { calculateCompactBudget } from "./compact-budget.js";
import { truncateString } from "../truncate.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum time (ms) to wait for SLM compression before falling back. */
const SLM_TIMEOUT_MS = 30_000;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Options for generating a compact brief. */
export interface CompactBriefOptions {
  /** Compaction cycle count (including this one). */
  compactCount: number;
  /** Session UUID (for logging). */
  sessionId: string;
  /** Project directory (for logging). */
  projectDir: string;
  /**
   * SLM briefs from earlier compaction cycles, oldest first.
   * When present, the current brief is chain-aware — it synthesizes the full
   * session arc rather than being an isolated snapshot of only the current cycle.
   * Omit or pass empty array for the first compaction of a session.
   */
  priorBriefs?: string[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Group events by category, extracting the data needed for buildSynthesisInput.
 * Mirrors the grouping logic in writer.ts:buildHandoffFromEvents.
 */
function extractSynthesisInputs(events: StoredEvent[]): {
  promptEvents: StoredEvent[];
  decisionEvents: StoredEvent[];
  filesModified: string[];
  allErrors: string[];
  errorsResolved: string[];
  currentTask: string;
  lastAction: string;
} {
  const byCategory: Record<string, StoredEvent[]> = {};
  for (const ev of events) {
    (byCategory[ev.category] ??= []).push(ev);
  }

  const fileEvents = byCategory["file"] ?? [];
  const errorEvents = byCategory["error"] ?? [];
  const promptEvents = byCategory["prompt"] ?? [];
  const decisionEvents = byCategory["decision"] ?? [];

  const filesModified = [
    ...new Set(
      fileEvents
        .filter((e) => e.type === "file_write" || e.type === "file_edit")
        .map((e) => e.data),
    ),
  ];

  const allErrors = errorEvents.map((e) => truncateString(e.data, 200));

  const lastPromptEvent = promptEvents.at(-1);
  const currentTask = lastPromptEvent
    ? truncateString(lastPromptEvent.data, 300)
    : "";

  const lastFile = fileEvents
    .filter((e) => e.type === "file_write" || e.type === "file_edit")
    .at(-1);
  const lastAction = lastFile
    ? `${lastFile.type === "file_write" ? "Wrote" : "Edited"} ${lastFile.data}`
    : "";

  return {
    promptEvents,
    decisionEvents,
    filesModified,
    allErrors,
    errorsResolved: [],
    currentTask,
    lastAction,
  };
}

/**
 * Format a structured SLM result as a <session_knowledge> XML block.
 * Produces a compact, continuation-focused brief.
 */
function formatStructuredBrief(s: StructuredHandoff): string {
  let block = `\n<session_knowledge source="compact" generator="slm">`;
  block += `\n<session_guide>`;

  if (s.current_task) {
    block += `\n## Current Task [${s.task_status ?? "IN_PROGRESS"}]`;
    block += `\n${s.current_task}\n`;
  }

  if (s.synthesis) {
    block += `\n## Session Summary`;
    block += `\n${s.synthesis}\n`;
  }

  if (s.decisions?.length) {
    block += `\n## Key Decisions`;
    for (const d of s.decisions) {
      block += `\n- [${d.status}] ${d.topic}: ${d.decision}`;
    }
    block += `\n`;
  }

  if (s.errors?.length) {
    const unresolved = s.errors.filter((e) => e.status !== "RESOLVED");
    if (unresolved.length > 0) {
      block += `\n## Unresolved Errors`;
      for (const e of unresolved) {
        block += `\n- [${e.status}] ${e.description}`;
      }
      block += `\n`;
    }
  }

  if (s.next_session) {
    block += `\n## Next Step`;
    block += `\n${s.next_session}\n`;
  }

  block += `\n</session_guide>`;
  block += `\n<continue_from>Continue working on the current task. Do NOT ask the user to repeat themselves.`;
  block += ` If the user asks about something from earlier in this session or a previous session,`;
  block += ` use the semantic_search MCP tool to retrieve relevant facts from the memory bank.</continue_from>`;
  block += `\n</session_knowledge>`;
  return block;
}

/**
 * Format a prose SLM result as a <session_knowledge> XML block.
 */
function formatProseBrief(prose: string): string {
  let block = `\n<session_knowledge source="compact" generator="slm">`;
  block += `\n<session_guide>`;
  block += `\n## Session Summary`;
  block += `\n${prose}\n`;
  block += `\n</session_guide>`;
  block += `\n<continue_from>Continue working on the current task. Do NOT ask the user to repeat themselves.`;
  block += ` If the user asks about something from earlier in this session or a previous session,`;
  block += ` use the semantic_search MCP tool to retrieve relevant facts from the memory bank.</continue_from>`;
  block += `\n</session_knowledge>`;
  return block;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate an SLM-compressed brief from session events for compaction recovery.
 *
 * Returns a formatted `<session_knowledge>` XML string on success, or null
 * on any failure (timeout, empty output, SLM unavailable). The caller should
 * fall back to the raw event dump when this returns null.
 *
 * @param events  - Cleaned session events (post-audit).
 * @param options - Compaction context (compact count, session ID, project dir).
 * @returns Formatted XML brief string, or null on failure.
 */
export async function generateCompactBrief(
  events: StoredEvent[],
  options: CompactBriefOptions,
): Promise<string | null> {
  if (events.length === 0) return null;

  // Step 1-2: Build synthesis input from current-cycle events.
  // If prior briefs are present, pass them so the SLM synthesizes the full
  // session arc rather than an isolated snapshot of this cycle alone.
  const inputs = extractSynthesisInputs(events);
  const synthesisInput = buildSynthesisInput(
    inputs.promptEvents,
    inputs.decisionEvents,
    inputs.filesModified,
    inputs.allErrors,
    inputs.errorsResolved,
    inputs.currentTask,
    inputs.lastAction,
    options.priorBriefs,
  );

  if (!synthesisInput.trim()) return null;

  // Step 3: Calculate dynamic compression ratio
  // Preprocessing (code block/stack trace stripping) is handled internally
  // by the compressor's compress() method — no need to call it here.
  const budget = calculateCompactBudget(events, options.compactCount);

  // Step 4: Run SLM compression with timeout
  const compressor = getCompressor();

  // Tier 1 (rule-based) and tier 2 (encoder-only, delegates to tier1) can't
  // synthesize — not worth running for compact brief
  if (compressor.tier === "tier1" || compressor.tier === "tier2") return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLM_TIMEOUT_MS);

  try {
    const result = await Promise.race([
      compressor.compress(synthesisInput, budget.compressionRatio, buildCompactBriefPrompt),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error("SLM compact brief timed out")),
        );
      }),
    ]);

    clearTimeout(timeout);

    // Step 6: Format result as XML
    if (result.format === "json" && result.structured) {
      const brief = formatStructuredBrief(result.structured);
      if (brief.length > 50) return brief;
    } else if (result.compressed.trim()) {
      const brief = formatProseBrief(result.compressed.trim());
      if (brief.length > 50) return brief;
    }

    return null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}
