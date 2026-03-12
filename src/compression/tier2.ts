/**
 * tier2.ts — @huggingface/transformers ONNX compressor.
 *
 * Responsible for: generating 384-dimensional sentence embeddings using
 * Xenova/all-MiniLM-L6-v2 via @huggingface/transformers. This is the
 * primary source of vector embeddings for the VectorDB (vec_procedures table).
 * Text compression falls back to Tier 1 (rule-based) — the small ONNX model
 * is not suitable for generation.
 *
 * Model: Xenova/all-MiniLM-L6-v2
 *   - ~23 MB ONNX model, downloaded on first use via HuggingFace Hub
 *   - Cached in ~/.cache/huggingface/hub (or HF_HOME env var)
 *   - 384-dimensional embeddings, matches VectorDB default dimensions
 *
 * Depends on: @huggingface/transformers (optional npm package),
 *             src/compression/tier1.ts (compress fallback).
 * Depended on by: src/compression/index.ts, Tier3/Tier4 (embed delegation).
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Compressor, CompressionResult, EmbedResult } from "./types.js";
import { Tier1Compressor } from "./tier1.js";

/** HuggingFace model ID for sentence embeddings. */
const EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** Max input chars per text sent to the model (model max is 512 tokens ≈ 2048 chars). */
const MAX_INPUT_CHARS = 2048;

// ── Internal types for @huggingface/transformers pipeline output ───────────────

interface HFTensor {
  data: Float32Array;
}

type HFFeaturePipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean },
) => Promise<HFTensor>;

// ── Tier2Compressor ────────────────────────────────────────────────────────────

/**
 * Tier2Compressor — ONNX-based sentence embedding with rule-based compression.
 *
 * embed(): loads Xenova/all-MiniLM-L6-v2 on first call (lazy, downloads once).
 * compress(): delegates to Tier1Compressor (ONNX model is encoder-only).
 *
 * The pipeline is loaded once and cached. All subsequent embed() calls reuse
 * the same pipeline instance. Failures during load/inference are swallowed
 * and return empty embeddings rather than throwing.
 */
export class Tier2Compressor implements Compressor {
  readonly tier = "tier2" as const;

  private pipelinePromise: Promise<HFFeaturePipeline | null> | null = null;
  private _available: boolean;
  private readonly fallback = new Tier1Compressor();

  constructor() {
    // Sync availability check: verify the npm package exists on disk.
    // @huggingface/transformers is ESM-only so require.resolve() fails.
    // Instead, walk up from this file to find node_modules (works whether
    // running from src/ or build/).
    this._available = false;
    try {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      // From build/compression/ or src/compression/ → project root is ../..
      const projectRoot = join(thisDir, "..", "..");
      if (existsSync(join(projectRoot, "node_modules", "@huggingface", "transformers"))) {
        this._available = true;
      }
    } catch { /* cannot determine — assume unavailable */ }
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Lazily initialize the HuggingFace feature-extraction pipeline.
   * Downloads Xenova/all-MiniLM-L6-v2 on first call (~23 MB).
   *
   * @returns The pipeline function, or null if loading failed.
   */
  private getOrLoadPipeline(): Promise<HFFeaturePipeline | null> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async (): Promise<HFFeaturePipeline | null> => {
        try {
          // Dynamic import — @huggingface/transformers is an optional dependency
          const { pipeline } = await import("@huggingface/transformers");
          const pipe = await pipeline("feature-extraction", EMBED_MODEL_ID, {
            // CPU inference — no GPU setup required at this tier
            device: "cpu",
            dtype: "fp32",
          }) as unknown as HFFeaturePipeline;
          this._available = true;
          return pipe;
        } catch {
          // Package not installed, model download failed, or ONNX runtime error
          return null;
        }
      })();
    }
    return this.pipelinePromise;
  }

  /**
   * Compress text via Tier 1 rule-based extraction.
   * Tier 2 is encoder-only and cannot generate new text.
   *
   * @param text     - Text to compress.
   * @param maxRatio - Compression ratio target.
   */
  async compress(text: string, maxRatio = 3.0, _promptBuilder?: import("./types.js").PromptBuilder): Promise<CompressionResult> {
    return this.fallback.compress(text, maxRatio);
  }

  /**
   * Generate 384-dimensional embeddings using all-MiniLM-L6-v2.
   * Returns empty result if @huggingface/transformers is not installed or
   * if the model fails to load.
   *
   * @param texts - Strings to embed. Each is truncated to 2048 chars before encoding.
   * @returns EmbedResult with one 384-dim vector per input text.
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { embeddings: [], dimensions: 384, tier: "tier2" };
    }

    const pipe = await this.getOrLoadPipeline();
    if (!pipe) {
      return { embeddings: [], dimensions: 384, tier: "tier2" };
    }

    const embeddings: number[][] = [];

    for (const text of texts) {
      try {
        // Truncate to model limit before encoding
        const truncated = text.slice(0, MAX_INPUT_CHARS);
        const output = await pipe(truncated, { pooling: "mean", normalize: true });
        embeddings.push(Array.from(output.data));
      } catch {
        // Single text failure — push a zero vector to keep index alignment
        embeddings.push(new Array(384).fill(0) as number[]);
      }
    }

    return {
      embeddings,
      dimensions: 384,
      tier: "tier2",
    };
  }
}
