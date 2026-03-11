/**
 * dedup.ts — String deduplication and transcript context extraction.
 *
 * Responsible for: near-duplicate message detection using LCS-based similarity
 * ratio (ported from Python's difflib.SequenceMatcher), deduplication of
 * message lists, and parsing Claude Code transcript JSONL files to extract
 * user messages, assistant snippets, and file paths.
 *
 * Depends on: node:fs (transcript reading), node:path, node:os.
 * Depended on by: src/hooks/stop.ts, src/handoff/writer.ts.
 *
 * Algorithm note: The similarity ratio is computed as:
 *   2 * lcs_length / (len_a + len_b)
 * This matches Python SequenceMatcher.ratio() behaviour for the comparison
 * of the first 200 characters of each message.
 */

import { readFileSync, existsSync } from "node:fs";

// ── String similarity ─────────────────────────────────────────────────────────

/**
 * Compute the Longest Common Subsequence length of two strings.
 * Used to approximate Python SequenceMatcher.ratio().
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns LCS length.
 */
function lcsLength(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  // Use two-row DP for space efficiency — O(min(la,lb)) space
  if (la === 0 || lb === 0) return 0;

  const short = la <= lb ? a : b;
  const long  = la <= lb ? b : a;
  const ls = short.length;
  const ll = long.length;

  let prev = new Array<number>(ls + 1).fill(0);
  let curr = new Array<number>(ls + 1).fill(0);

  for (let i = 1; i <= ll; i++) {
    for (let j = 1; j <= ls; j++) {
      if (long[i - 1] === short[j - 1]) curr[j] = prev[j - 1] + 1;
      else curr[j] = Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  return prev[ls];
}

/**
 * Compute the similarity ratio between two strings using LCS.
 * Mirrors Python difflib.SequenceMatcher.ratio() on the first 200 chars.
 *
 * Formula: 2 * lcs_length(a[:200], b[:200]) / (len(a[:200]) + len(b[:200]))
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns Ratio from 0.0 (no match) to 1.0 (identical).
 */
export function similarityRatio(a: string, b: string): number {
  const sa = a.slice(0, 200);
  const sb = b.slice(0, 200);
  const total = sa.length + sb.length;
  if (total === 0) return 1.0;
  return (2 * lcsLength(sa, sb)) / total;
}

/**
 * Remove near-duplicate messages from a list using similarity threshold.
 * Preserves order; keeps the first occurrence when a near-duplicate is detected.
 *
 * Ported from Python: handoff_core.py dedup_messages().
 *
 * @param messages  - List of messages to deduplicate.
 * @param threshold - Similarity threshold (default 0.85). Messages with ratio
 *                    >= threshold are considered duplicates.
 * @returns Deduplicated list of messages.
 */
export function dedupMessages(messages: string[], threshold = 0.85): string[] {
  if (messages.length === 0) return messages;

  const result: string[] = [messages[0]];
  for (const msg of messages.slice(1)) {
    const isDuplicate = result.some(kept => similarityRatio(msg, kept) >= threshold);
    if (!isDuplicate) result.push(msg);
  }
  return result;
}

// ── Transcript JSONL parsing ──────────────────────────────────────────────────

/** File paths and shell tokens that indicate a string is NOT a real file path. */
const COMMAND_LIKE_TOKENS = ["&&", "||", "|", ";", "$(", "`"];

function looksLikeRealFilePath(value: string): boolean {
  if (!value || (!value.startsWith("/") && !value.match(/^[A-Za-z]:\\/))) return false;
  if (/[\n\r]/.test(value)) return false;
  if (COMMAND_LIKE_TOKENS.some(t => value.includes(t))) return false;
  return true;
}

function collectTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null && (p as Record<string, unknown>)["type"] === "text")
      .map(p => String((p as Record<string, unknown>)["text"] ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function collectPathsRecursive(obj: unknown, paths: Set<string>): void {
  if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if ((key === "file_path" || key === "path") && typeof value === "string") {
        if (looksLikeRealFilePath(value)) paths.add(value.trim());
      } else {
        collectPathsRecursive(value, paths);
      }
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectPathsRecursive(item, paths);
  }
}

/** Junk patterns to filter from assistant snippets. */
const ASSISTANT_JUNK = [
  "API Error:", "rate_limit", "invalid_request_error",
  "overloaded", "No response requested", "(no content)",
];

/** Junk patterns to filter from user messages. */
const USER_JUNK = ["[Request interrupted by user]"];

/** Result of parsing a transcript JSONL file. */
export interface TranscriptContext {
  /** Recent deduplicated user messages (up to maxUserMessages). */
  user_messages: string[];
  /** Recent assistant text snippets (up to 10). */
  assistant_snippets: string[];
  /** File paths mentioned in tool_use inputs (up to 20). */
  files_touched: string[];
}

/**
 * Parse a Claude Code transcript JSONL and extract compact handoff context.
 *
 * Ported from Python: handoff_core.py extract_context().
 *
 * @param transcriptPath   - Absolute path to the transcript .jsonl file.
 * @param maxUserMessages  - Maximum user messages to include (default 15).
 * @param maxAssistantChars - Maximum characters per assistant snippet (default 800).
 * @param dedupThreshold   - Near-duplicate threshold (default 0.85).
 * @returns TranscriptContext or null if the file doesn't exist or is unreadable.
 */
export function extractTranscriptContext(
  transcriptPath: string,
  maxUserMessages = 15,
  maxAssistantChars = 800,
  dedupThreshold = 0.85,
): TranscriptContext | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  const userMessages: string[] = [];
  const assistantSnippets: string[] = [];
  const filesMentioned = new Set<string>();

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const msgType = obj["type"];

    if (msgType === "user") {
      const message = obj["message"] as Record<string, unknown> | undefined;
      if (message) {
        const content = collectTextFromContent(message["content"]).trim();
        if (content && !USER_JUNK.some(j => content.includes(j))) {
          userMessages.push(content);
        }
      }
    } else if (msgType === "assistant") {
      const message = obj["message"] as Record<string, unknown> | undefined;
      if (message) {
        const contentArr = message["content"];
        if (Array.isArray(contentArr)) {
          for (const part of contentArr) {
            if (typeof part !== "object" || part === null) continue;
            const p = part as Record<string, unknown>;
            if (p["type"] === "text") {
              let text = String(p["text"] ?? "").trim();
              if (text && !ASSISTANT_JUNK.some(j => text.includes(j))) {
                if (text.length > maxAssistantChars) text = text.slice(0, maxAssistantChars) + "...";
                assistantSnippets.push(text);
              }
            }
            if (p["type"] === "tool_use") {
              collectPathsRecursive(p["input"], filesMentioned);
            }
          }
        }
      }
    }
  }

  // Deduplicate and trim user messages
  const recentUser = dedupMessages(
    userMessages.slice(-(maxUserMessages * 2)),
    dedupThreshold,
  ).slice(-maxUserMessages);

  return {
    user_messages: recentUser,
    assistant_snippets: assistantSnippets.slice(-10),
    files_touched: [...filesMentioned].sort().slice(-20),
  };
}
