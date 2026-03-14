/**
 * tier2.ts — @huggingface/transformers ONNX embedding specialist.
 *
 * Responsible for: generating high-quality sentence embeddings using retrieval-
 * optimized ONNX models selected by hardware profile. This is the primary source
 * of vector embeddings for the VectorDB (vec_procedures table). Text compression
 * falls back to Tier 1 (rule-based) — ONNX encoder-only models cannot generate.
 *
 * Model selection by hardware profile (all downloaded on first use via HuggingFace Hub,
 * cached in ~/.cache/huggingface/hub or HF_HOME env var):
 *   extreme / power  → Xenova/bge-large-en-v1.5 (768-dim, 335 M params, ~1.2 GB)
 *                      BEIR avg 54.2. Best ONNX retrieval model. CLS pooling.
 *   standard         → Xenova/bge-base-en-v1.5  (768-dim, 109 M params, ~420 MB)
 *                      BEIR avg 53.2. Balanced quality/cost. CLS pooling.
 *   minimal          → Xenova/all-MiniLM-L6-v2  (384-dim,  23 M params,  ~23 MB)
 *                      CPU-optimised fallback. Mean pooling. Zero download on most machines.
 *
 * BGE v1.5 models are purpose-built for dense passage retrieval (not just similarity).
 * The 768-dim space captures finer semantic distinctions than MiniLM's 384-dim space,
 * improving cosine distance discrimination for cross-session engram retrieval.
 *
 * Depends on: @huggingface/transformers (optional npm package),
 *             src/compression/detect.ts (hardware profile),
 *             src/compression/tier1.ts (compress fallback).
 * Depended on by: src/compression/index.ts, Tier3/Tier4 (embed delegation).
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Compressor, CompressionResult, EmbedResult } from "./types.js";
import { Tier1Compressor } from "./tier1.js";
import { detectHardwareProfile } from "./detect.js";

/** Max input chars per text sent to the model (512 tokens ≈ 2048 chars for all supported models). */
const MAX_INPUT_CHARS = 2048;

// ── Embedding model selection ──────────────────────────────────────────────────

/** Per-model configuration: model ID, output dimensions, and pooling strategy. */
interface EmbedModelConfig {
  /** HuggingFace Hub model ID (Xenova namespace = pre-exported ONNX). */
  id: string;
  /** Output embedding dimensions. */
  dims: number;
  /**
   * Pooling strategy for sentence-level embedding.
   *   "cls"  — use the [CLS] token output (BGE-family convention).
   *   "mean" — average all token outputs (MiniLM/MPNET convention).
   */
  pooling: "mean" | "cls";
}

/**
 * Hardware-profile → embedding model mapping.
 *
 * extreme/power: BGE-large — highest BEIR avg among ONNX retrieval models,
 *   trained specifically to maximise dense retrieval recall.
 * standard: BGE-base — same architecture at 1/3 the size, still 768-dim.
 * minimal: MiniLM-L6 — tiny CPU-friendly model, always locally available
 *   after first session (23 MB download).
 */
const EMBED_MODELS: Readonly<Record<string, EmbedModelConfig>> = {
  extreme:  { id: "Xenova/bge-large-en-v1.5", dims: 768, pooling: "cls"  },
  power:    { id: "Xenova/bge-large-en-v1.5", dims: 768, pooling: "cls"  },
  standard: { id: "Xenova/bge-base-en-v1.5",  dims: 768, pooling: "cls"  },
  minimal:  { id: "Xenova/all-MiniLM-L6-v2",  dims: 384, pooling: "mean" },
};

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
 * Tier2Compressor — hardware-profile-aware ONNX embedding specialist.
 *
 * embed(): selects the optimal retrieval model for the detected hardware profile,
 *   loads it lazily on first call (downloads once, cached in HF_HOME).
 *   extreme/power  → BGE-large-en-v1.5 (768-dim, ~1.2 GB)
 *   standard       → BGE-base-en-v1.5  (768-dim, ~420 MB)
 *   minimal        → all-MiniLM-L6-v2  (384-dim, ~23 MB)
 * compress(): delegates to Tier1Compressor (ONNX encoder-only, no generation).
 *
 * The pipeline is loaded once and cached per process. Failures during
 * load/inference are swallowed and return empty embeddings rather than throwing.
 */
export class Tier2Compressor implements Compressor {
  readonly tier = "tier2" as const;

  private pipelinePromise: Promise<HFFeaturePipeline | null> | null = null;
  private _available: boolean;
  /** Selected model config based on detected hardware profile. */
  private readonly _modelConfig: EmbedModelConfig;
  private readonly fallback = new Tier1Compressor();

  constructor() {
    // Sync availability check: verify the npm package exists on disk.
    // @huggingface/transformers is ESM-only so require.resolve() fails.
    // Instead, walk up from this file to find node_modules (works whether
    // running from src/ or build/).
    this._available = false;
    this._modelConfig = EMBED_MODELS["minimal"]!; // safe default before profile detection
    try {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      // From build/compression/ or src/compression/ → project root is ../..
      const projectRoot = join(thisDir, "..", "..");
      if (existsSync(join(projectRoot, "node_modules", "@huggingface", "transformers"))) {
        this._available = true;
      }
      // Select embedding model based on hardware profile.
      // detectHardwareProfile() is sync (spawnSync nvidia-smi, cached after first call).
      const profile = detectHardwareProfile();
      this._modelConfig = EMBED_MODELS[profile] ?? EMBED_MODELS["minimal"]!;
    } catch { /* cannot determine — stay with minimal default */ }
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Lazily initialize the HuggingFace feature-extraction pipeline.
   * Downloads the selected model on first call (23 MB – 1.2 GB depending on profile).
   *
   * Model is selected at construction time based on hardware profile:
   *   extreme/power → BGE-large (~1.2 GB, one-time download)
   *   standard      → BGE-base  (~420 MB, one-time download)
   *   minimal       → MiniLM-L6 (~23 MB, already on most machines)
   *
   * @returns The pipeline function, or null if loading failed.
   */
  private getOrLoadPipeline(): Promise<HFFeaturePipeline | null> {
    if (!this.pipelinePromise) {
      const modelId = this._modelConfig.id;
      this.pipelinePromise = (async (): Promise<HFFeaturePipeline | null> => {
        try {
          // Dynamic import — @huggingface/transformers is an optional dependency
          const { pipeline } = await import("@huggingface/transformers");
          const pipe = await pipeline("feature-extraction", modelId, {
            // CPU inference — higher tiers use GPU via node-llama-cpp (tier3+)
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
   * Generate embeddings using the hardware-profile-selected model.
   * Returns empty result if @huggingface/transformers is not installed or
   * if the model fails to load.
   *
   * Dimensions depend on selected model:
   *   extreme/power → 768 (BGE-large-en-v1.5)
   *   standard      → 768 (BGE-base-en-v1.5)
   *   minimal       → 384 (all-MiniLM-L6-v2)
   *
   * @param texts - Strings to embed. Each is truncated to 2048 chars before encoding.
   * @returns EmbedResult with one vector per input text at the model's native dimensions.
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    const { dims, pooling } = this._modelConfig;

    if (texts.length === 0) {
      return { embeddings: [], dimensions: dims, tier: "tier2" };
    }

    const pipe = await this.getOrLoadPipeline();
    if (!pipe) {
      return { embeddings: [], dimensions: dims, tier: "tier2" };
    }

    const embeddings: number[][] = [];

    for (const text of texts) {
      try {
        // Truncate to model limit before encoding (all supported models: 512 tokens ≈ 2048 chars)
        const truncated = text.slice(0, MAX_INPUT_CHARS);
        const output = await pipe(truncated, { pooling, normalize: true });
        embeddings.push(Array.from(output.data));
      } catch {
        // Single text failure — push a zero vector to keep index alignment
        embeddings.push(new Array(dims).fill(0) as number[]);
      }
    }

    return {
      embeddings,
      dimensions: dims,
      tier: "tier2",
    };
  }
}
