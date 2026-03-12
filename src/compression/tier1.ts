/**
 * tier1.ts — Rule-based extractive compressor. Zero dependencies, always available.
 *
 * Responsible for: compressing text by scoring sentences and keeping the
 * highest-value ones up to the target character budget. Used directly for
 * tier1, and as the compress() fallback for all higher tiers.
 *
 * Algorithm: score each sentence by position, length, and technical content
 * signal density, then select top-scoring sentences in original order until
 * the target size is reached.
 *
 * Depends on: nothing.
 * Depended on by: all compression tier implementations (as compress fallback).
 */

import type { Compressor, CompressionResult, EmbedResult } from "./types.js";

// ── Sentence scoring ───────────────────────────────────────────────────────────

/** Patterns for filler sentences that should be dropped first. */
const FILLER_RES = [
  /^(ok|okay|sure|yes|no|got it|understood|alright)[.!?]?\s*$/i,
  /^(let me|i will|i'll|i'm going to)\s+(know|check|look|see)/i,
  /^(as (i|we) mentioned|as noted above|as discussed earlier)/i,
  /^(of course|certainly|absolutely|definitely)[.!,]/i,
];

/**
 * Returns true if the sentence is a low-value filler phrase.
 *
 * @param s - The sentence to test.
 */
function isFiller(s: string): boolean {
  if (s.trim().length < 6) return true;
  return FILLER_RES.some(re => re.test(s.trim()));
}

/**
 * Split text into sentences using punctuation boundaries.
 * Preserves multi-line structure by treating newlines as sentence boundaries.
 *
 * @param text - Raw text to split.
 * @returns Array of non-empty sentence strings.
 */
function splitSentences(text: string): string[] {
  // Split on: sentence-ending punct + space, OR newlines
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Score a sentence for importance. Higher = more important to keep.
 *
 * @param sentence - The sentence text.
 * @param index    - Position in the original array (0 = first).
 * @param total    - Total number of sentences.
 * @returns Numeric importance score.
 */
function scoreSentence(sentence: string, index: number, total: number): number {
  let score = 0;

  // Position: first 2 and last sentence are usually important (topic + conclusion)
  if (index < 2) score += 2;
  if (index === total - 1) score += 1;

  // Length: very short is filler; very long is dense with information
  const len = sentence.length;
  if (len > 30 && len <= 150) score += 2;
  else if (len > 150) score += 1;

  // Technical signal words: decisions, file operations, errors, config
  if (/\b(error|failed|warning|crash|exception|fix|resolve)\b/i.test(sentence)) score += 3;
  if (/\b(decision|agreed|chosen|approach|strategy|reason)\b/i.test(sentence)) score += 3;
  if (/\b(file|path|function|class|method|api|schema|config|module)\b/i.test(sentence)) score += 2;
  if (/\b(add|remove|change|update|create|delete|refactor|migrate)\b/i.test(sentence)) score += 1;

  // Quoted items, code references, or paths are high-value
  if (/`[^`]+`/.test(sentence)) score += 2;
  if (/["'][^"']{3,}["']/.test(sentence)) score += 1;

  // Filler penalty
  if (isFiller(sentence)) score -= 8;

  return score;
}

// ── Tier1Compressor ────────────────────────────────────────────────────────────

/**
 * Tier1Compressor — always-available rule-based compressor.
 *
 * compress(): extractive sentence selection up to the target character budget.
 * embed():    not available at this tier — returns empty EmbedResult.
 */
export class Tier1Compressor implements Compressor {
  readonly tier = "tier1" as const;

  isAvailable(): boolean {
    return true;
  }

  /**
   * Compress text by selecting the highest-scoring sentences up to the budget.
   *
   * Steps:
   * 1. If text is already within budget, return it unchanged.
   * 2. Split into sentences and score each one.
   * 3. Select top-scoring sentences (greedy) until target chars are filled.
   * 4. Reconstruct in original document order.
   *
   * @param text     - Text to compress.
   * @param maxRatio - Maximum compression ratio ceiling (default 3.0).
   * @returns CompressionResult with compressed text and metrics.
   */
  async compress(text: string, maxRatio = 3.0, _promptBuilder?: import("./types.js").PromptBuilder): Promise<CompressionResult> {
    const originalChars = text.length;
    const ratio = Math.max(1.1, Math.min(maxRatio, 20));
    const targetChars = Math.floor(originalChars / ratio);

    if (originalChars <= targetChars) {
      return {
        compressed: text,
        originalChars,
        compressedChars: originalChars,
        ratio: 1.0,
        tier: "tier1",
      };
    }

    const sentences = splitSentences(text);

    // If only 1–2 sentences, hard-truncate at the boundary
    if (sentences.length <= 2) {
      const truncated = text.slice(0, targetChars);
      return {
        compressed: truncated,
        originalChars,
        compressedChars: truncated.length,
        ratio: originalChars / Math.max(truncated.length, 1),
        tier: "tier1",
      };
    }

    // Score all sentences
    const scored = sentences.map((s, i) => ({
      s,
      i,
      score: scoreSentence(s, i, sentences.length),
    }));

    // Sort descending by score, then select until target reached
    scored.sort((a, b) => b.score - a.score);

    let chars = 0;
    const selected = new Set<number>();
    for (const { s, i } of scored) {
      if (chars >= targetChars) break;
      selected.add(i);
      chars += s.length + 1; // +1 for the space separator
    }

    // Reconstruct in original order
    const compressed = sentences.filter((_, i) => selected.has(i)).join(" ");

    return {
      compressed,
      originalChars,
      compressedChars: compressed.length,
      ratio: originalChars / Math.max(compressed.length, 1),
      tier: "tier1",
    };
  }

  /**
   * Tier 1 has no embedding model. Returns empty result.
   * Callers that need embeddings should use Tier 2+.
   */
  async embed(_texts: string[]): Promise<EmbedResult> {
    return { embeddings: [], dimensions: 0, tier: "tier1" };
  }
}
