/**
 * schema.ts — JSON Schema and prompt for grammar-constrained diff-mode output.
 *
 * Responsible for: defining the GBNF-compatible JSON schema that forces the SLM
 * to produce structured handoff data instead of free prose. The schema's enums
 * (IN_PROGRESS/BLOCKED/COMPLETE, UNRESOLVED/RESOLVED/RECURRED) make it impossible
 * for the model to hedge or soften status — it must commit to a discrete state.
 *
 * The prompt is specifically designed for JSON extraction, not prose generation.
 * It's shorter and more directive than the prose prompt because the grammar
 * handles all formatting — the model only needs to fill in values.
 *
 * Depends on: nothing (pure constants).
 * Depended on by: src/compression/tier3.ts, src/compression/tier3b.ts.
 */

// ── JSON Schema for grammar-constrained output ───────────────────────────────

/**
 * GBNF-compatible JSON schema for structured handoff output.
 *
 * Design constraints for small models (2-4B):
 *   - Flat structure where possible (no deep nesting)
 *   - Small enums (3 values max) to avoid constraint thrash
 *   - maxItems on arrays to prevent runaway generation
 *   - No required fields — model fills what it can extract
 *
 * Compatible with node-llama-cpp's createGrammarForJsonSchema().
 */
export const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    current_task: { type: "string" },
    task_status: {
      type: "string",
      enum: ["IN_PROGRESS", "BLOCKED", "COMPLETE"],
    },
    synthesis: { type: "string" },
    decisions: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          decision: { type: "string" },
          status: {
            type: "string",
            enum: ["FINAL", "TENTATIVE", "REVERTED"],
          },
        },
      },
    },
    errors: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          status: {
            type: "string",
            enum: ["UNRESOLVED", "RESOLVED", "RECURRED"],
          },
        },
      },
    },
    next_session: { type: "string" },
  },
} as const;

// ── Diff-mode extraction prompt ──────────────────────────────────────────────

/**
 * Build the diff-mode JSON extraction prompt.
 *
 * Shorter and more directive than the prose prompt because the grammar
 * handles all formatting. The model only needs to decide WHAT facts to
 * extract, not HOW to format them.
 *
 * @param text - Preprocessed session data (noise already stripped).
 * @returns Prompt string for grammar-constrained JSON generation.
 */
export function buildDiffModePrompt(text: string): string {
  return [
    `Extract structured handoff data from this developer session log.`,
    `Fill each JSON field based ONLY on explicit facts in the session data.`,
    ``,
    `RULES:`,
    `1. current_task: The LAST active, incomplete task — not the most-mentioned one.`,
    `2. task_status: IN_PROGRESS unless explicitly blocked or confirmed complete.`,
    `3. decisions: Put each key decision as an object in the decisions array.`,
    `4. errors: Put each error in the errors array with status UNRESOLVED/RESOLVED/RECURRED.`,
    `   Default to UNRESOLVED unless the log explicitly confirms the fix succeeded.`,
    `5. synthesis: 2-3 sentence factual summary of the session's key outcomes.`,
    `6. next_session: What the next engineer should start with.`,
    `7. Do NOT infer or extrapolate — state only facts present in the session data.`,
    ``,
    `<session_data>`,
    text,
    `</session_data>`,
    ``,
    `[FOCUS: current_task is the LAST active task. Default error status to UNRESOLVED.]`,
  ].join("\n");
}
