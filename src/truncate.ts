/**
 * truncate.ts — Pure string and output truncation utilities.
 *
 * Responsible for: safe string truncation (char-based and byte-based),
 * JSON truncation with binary-search, XML escaping, and smart head+tail
 * truncation for large outputs.
 *
 * Depends on: nothing (pure utility, zero imports).
 * Depended on by: src/session/snapshot.ts, src/handoff/writer.ts,
 *                 src/memory/graph.ts.
 */

// ── String truncation ────────────────────────────────────────────────────────

/**
 * Truncate a string to at most `maxChars` characters, appending "..." when
 * truncation occurs.
 *
 * @param str     - Input string.
 * @param maxChars - Maximum character count (inclusive). Must be >= 3.
 * @returns Original string if short enough; truncated string ending in "..." otherwise.
 */
export function truncateString(str: string, maxChars: number): string {
  if (str.length <= maxChars) return str;
  return str.slice(0, Math.max(0, maxChars - 3)) + "...";
}

// ── Byte-aware smart truncation (head + tail) ────────────────────────────────

/**
 * Smart truncation that keeps the head (60%) and tail (40%) of output.
 * Snaps to line boundaries and handles UTF-8 via Buffer.byteLength.
 *
 * @param raw      - Raw output string.
 * @param maxBytes - Soft cap in bytes. Output below this is returned as-is.
 * @returns Original string if within budget; head + separator + tail otherwise.
 */
export function smartTruncate(raw: string, maxBytes: number): string {
  if (Buffer.byteLength(raw) <= maxBytes) return raw;

  const lines = raw.split("\n");
  const headBudget = Math.floor(maxBytes * 0.6);
  const tailBudget = maxBytes - headBudget;

  const headLines: string[] = [];
  let headBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + 1;
    if (headBytes + lineBytes > headBudget) break;
    headLines.push(line);
    headBytes += lineBytes;
  }

  const tailLines: string[] = [];
  let tailBytes = 0;
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const lineBytes = Buffer.byteLength(lines[i]) + 1;
    if (tailBytes + lineBytes > tailBudget) break;
    tailLines.unshift(lines[i]);
    tailBytes += lineBytes;
  }

  const skippedLines = lines.length - headLines.length - tailLines.length;
  const skippedBytes = Buffer.byteLength(raw) - headBytes - tailBytes;

  const separator =
    `\n\n... [${skippedLines} lines / ${(skippedBytes / 1024).toFixed(1)}KB truncated` +
    ` — showing first ${headLines.length} + last ${tailLines.length} lines] ...\n\n`;

  return headLines.join("\n") + separator + tailLines.join("\n");
}

// ── JSON truncation ──────────────────────────────────────────────────────────

/**
 * Serialize a value to JSON and truncate to `maxBytes`. Result is NOT
 * guaranteed to be valid JSON after truncation — suitable for display only.
 *
 * Uses binary search for a UTF-8-safe slice boundary.
 *
 * @param value    - Any JSON-serializable value.
 * @param maxBytes - Maximum byte length of the result.
 * @param indent   - JSON indentation (default 2). Pass 0 for compact.
 */
export function truncateJSON(
  value: unknown,
  maxBytes: number,
  indent = 2,
): string {
  const serialized = JSON.stringify(value, null, indent) ?? "null";
  if (Buffer.byteLength(serialized) <= maxBytes) return serialized;

  const marker = "... [truncated]";
  const budget = maxBytes - Buffer.byteLength(marker);

  // Binary-search for the right char count to stay within maxBytes
  let lo = 0;
  let hi = serialized.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(serialized.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }

  return serialized.slice(0, lo) + marker;
}

// ── XML / HTML escaping ──────────────────────────────────────────────────────

/**
 * Escape a string for safe embedding in XML/HTML attribute or text node.
 * Replaces the five XML-reserved characters: & < > " '
 *
 * @param str - Input string to escape.
 * @returns XML-safe string.
 */
export function escapeXML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Byte cap ─────────────────────────────────────────────────────────────────

/**
 * Return `str` unchanged if within `maxBytes`, otherwise return a byte-safe
 * slice with "..." appended.
 *
 * @param str      - Input string.
 * @param maxBytes - Hard byte cap.
 */
export function capBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str) <= maxBytes) return str;
  const budget = maxBytes - Buffer.byteLength("...");

  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }

  return str.slice(0, lo) + "...";
}
