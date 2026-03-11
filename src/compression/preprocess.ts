/**
 * preprocess.ts — Session data preprocessor for SLM compression.
 *
 * Responsible for: stripping high-token, low-signal content from session
 * data before it reaches the SLM. Research shows code blocks, stack traces,
 * and pasted articles dominate attention in 2-4B models and push actual
 * session signal (decisions, current task, errors) into attention blind spots.
 *
 * Technique: replace noise blocks with compact placeholder tokens so the model
 * sees the structure without wasting context on irrelevant content.
 *
 * Sources:
 *   - Context Rot (Chroma Research): models over-emphasize early/late tokens,
 *     neglect middle — large noise blocks push signal into the middle blind spot.
 *   - arxiv 2406.11289: abstractive summarization is more prone to hallucination;
 *     reducing irrelevant tokens reduces confabulation.
 *
 * Depends on: nothing (pure string transformation, no external deps).
 * Depended on by: src/compression/tier3.ts, src/compression/tier3b.ts.
 */

// ── Code block stripping ───────────────────────────────────────────────────────

/**
 * Replace fenced code blocks (```...```) with compact placeholders.
 * Preserves the language tag and first meaningful line as a hint so the
 * model knows WHAT was coded, without seeing all the syntax.
 *
 * Example:
 *   ```typescript
 *   export function buildCompressionPrompt(text: string): string {
 *     ... 50 lines ...
 *   }
 *   ```
 * Becomes:
 *   [CODE BLOCK: TypeScript, ~52 lines — buildCompressionPrompt]
 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang: string, body: string) => {
    const lines = body.split("\n").filter((l: string) => l.trim()).length;
    // Extract a meaningful hint from the first non-blank, non-comment line
    const firstMeaningful = body
      .split("\n")
      .map((l: string) => l.trim())
      .find((l: string) => l && !l.startsWith("//") && !l.startsWith("#") && !l.startsWith("*"));
    const hint = firstMeaningful ? ` — ${firstMeaningful.slice(0, 60)}` : "";
    const langTag = lang ? `${lang[0].toUpperCase()}${lang.slice(1)}, ` : "";
    return `[CODE BLOCK: ${langTag}~${lines} lines${hint}]`;
  });
}

// ── Stack trace stripping ──────────────────────────────────────────────────────

/**
 * Replace multi-line stack traces with a single summary line.
 * Detects Java, Python, Node.js, and .NET trace formats.
 * Preserves the error type and message (the signal) and drops the frames (noise).
 *
 * Example:
 *   java.lang.NullPointerException: Cannot invoke "Order.getCustomer()"
 *       at com.payments.PaymentProcessor.processOrder(PaymentProcessor.java:142)
 *       at com.payments.PaymentProcessor.processBatch(PaymentProcessor.java:98)
 *       ...
 * Becomes:
 *   [STACK TRACE: NullPointerException: Cannot invoke "Order.getCustomer()"]
 */
function stripStackTraces(text: string): string {
  // Pattern: error/exception line followed by ≥2 "at " frame lines
  // Covers Java ("at com."), Node.js ("at Object."), Python ("  File "), .NET ("   at ")
  return text.replace(
    /([\w.]+(?:Exception|Error|Traceback|Error:)[^\n]{0,200})\n((?:\s+(?:at |File ")[^\n]+\n){2,})/g,
    (_match, errorLine: string) => {
      // Extract just the short error type + message from the first line
      const clean = errorLine.replace(/^[\w.]+\.([\w]+(?:Exception|Error))/, "$1").trim();
      return `[STACK TRACE: ${clean.slice(0, 120)}]\n`;
    }
  );
}

// ── Reference document stripping ───────────────────────────────────────────────

/**
 * Replace explicitly labelled reference sections with compact placeholders.
 * Detects common patterns used when users paste documentation into sessions:
 *   - Sections between "---" delimiters that contain no first-person verbs
 *   - Blocks preceded by "Reference:", "Reference material:", "Pasted:", etc.
 *
 * We only strip sections that are clearly reference material (no "we", "I",
 * "tried", "decided") to avoid stripping actual work descriptions.
 */
function stripReferenceDocuments(text: string): string {
  // Pattern: explicit reference label followed by content block between --- delimiters
  return text.replace(
    /(?:reference(?:\s+material)?|pasted?(?:\s+for\s+context)?|background)[^\n]*\n---\n([\s\S]*?)---/gi,
    (_match, body: string) => {
      const words = body.split(/\s+/).filter(Boolean).length;
      // Extract a title-like first line if present
      const firstLine = body.trim().split("\n")[0]?.trim().slice(0, 80) ?? "";
      return `[REFERENCE DOCUMENT: ~${words} words${firstLine ? ` — "${firstLine}"` : ""}]`;
    }
  );
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Preprocess session data before sending to the SLM.
 *
 * Applies in order:
 *   1. Strip reference document sections
 *   2. Strip code blocks → compact placeholders
 *   3. Strip stack traces → single-line summaries
 *
 * The order matters: reference documents may contain code blocks and traces
 * that we want to discard entirely, so reference stripping runs first.
 *
 * @param text - Raw session synthesis input from buildSynthesisInput().
 * @returns Preprocessed text with noise replaced by compact placeholders.
 */
export function preprocessSessionData(text: string): string {
  let result = text;
  result = stripReferenceDocuments(result);
  result = stripCodeBlocks(result);
  result = stripStackTraces(result);
  return result;
}
