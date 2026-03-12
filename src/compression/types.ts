/**
 * types.ts — Shared types for the AI compression module.
 *
 * Responsible for: defining the Compressor interface and all supporting types
 * used across all compression tiers. Every tier implements Compressor.
 *
 * Depends on: nothing.
 * Depended on by: all compression tiers, src/compression/index.ts.
 */

// ── Tier identifier ────────────────────────────────────────────────────────────

/**
 * The available compression tiers. Maps directly to plugin-config.yaml values.
 *
 * tier1 = rule-based extractive (always available, zero dependencies)
 * tier2 = @huggingface/transformers ONNX (embeddings + rule-based compress)
 * tier3  = node-llama-cpp + Llama 3.2 3B Q5_K_M (~2.32 GB, ≥4 GB RAM)
 *          Scored 3/3 on conflict resolution, error truthfulness, and intent extraction.
 * tier3b = node-llama-cpp + Qwen 3.5 2B Q5_K_M (~1.44 GB, ≥2 GB RAM)
 *          Scored 3/3 in quality tests. Lighter than tier3 — suitable for machines
 *          with limited GPU VRAM. Falls back to CPU inference automatically.
 *          (SmolLM3 3B was evaluated and rejected: produces empty output due to
 *          chat-template incompatibility with node-llama-cpp LlamaChatSession.)
 * tier4  = external HTTP provider (Ollama / LM Studio / Groq / Claude API)
 */
export type CompressionTier =
  | "tier1"
  | "tier2"
  | "tier3"
  | "tier3b"
  | "tier4";

// ── Structured handoff (diff-mode) ─────────────────────────────────────────────

/**
 * Machine-readable handoff brief produced by grammar-constrained SLM output.
 *
 * Instead of free prose, the SLM fills this schema via GBNF grammar constraints.
 * Enums force conservative status choices — the model cannot soften "UNRESOLVED"
 * into ambiguous phrasing like "may need further investigation."
 *
 * This is the SLM's ANALYSIS — it may differ from rule-based extraction when
 * there are decision conflicts, error flip-flops, or buried current tasks.
 */
export interface StructuredHandoff {
  /** The last active, incomplete task (SLM-identified, not the most-mentioned). */
  current_task: string;
  /** Conservative task status: IN_PROGRESS unless explicitly blocked or confirmed done. */
  task_status: "IN_PROGRESS" | "BLOCKED" | "COMPLETE";
  /** 2-3 sentence factual synthesis of session outcomes. */
  synthesis: string;
  /** Key decisions with explicit final/reverted status. */
  decisions: Array<{
    topic: string;
    decision: string;
    status: "FINAL" | "TENTATIVE" | "REVERTED";
  }>;
  /** Errors with conservative status: UNRESOLVED unless log confirms fix. */
  errors: Array<{
    description: string;
    status: "UNRESOLVED" | "RESOLVED" | "RECURRED";
  }>;
  /** What the next engineer should start with. */
  next_session: string;
}

// ── Result types ───────────────────────────────────────────────────────────────

/** Result from a compress() call. */
export interface CompressionResult {
  /** The compressed text (prose or JSON string depending on format). */
  compressed: string;
  /** Original character count. */
  originalChars: number;
  /** Compressed character count. */
  compressedChars: number;
  /** Actual compression ratio (originalChars / compressedChars). */
  ratio: number;
  /** Which tier performed the compression. */
  tier: CompressionTier;
  /** Output format: 'json' = grammar-constrained diff-mode, 'prose' = free text. */
  format?: "json" | "prose";
  /**
   * Parsed structured handoff when format is 'json'.
   * Consumers should prefer this over parsing `compressed` directly.
   */
  structured?: StructuredHandoff;
}

/** Result from an embed() call. */
export interface EmbedResult {
  /**
   * Embedding vectors, one per input text. Empty if the tier has no
   * embedding model.
   */
  embeddings: number[][];
  /** Dimensions of each embedding vector (0 if unavailable). */
  dimensions: number;
  /** Which tier produced these embeddings. */
  tier: CompressionTier;
}

// ── Compressor interface ───────────────────────────────────────────────────────

/**
 * Compressor — the interface every compression tier must implement.
 *
 * compress() reduces text length while preserving semantic content.
 * embed()    produces vector embeddings for semantic similarity search.
 *
 * Both methods are async (model loading may be lazy). Both must never throw —
 * they degrade gracefully to a no-op result on any internal failure.
 */
export interface Compressor {
  /** Which tier this compressor represents. */
  readonly tier: CompressionTier;

  /**
   * Compress a text string by up to maxRatio.
   *
   * @param text     - The text to compress.
   * @param maxRatio - Target compression ratio ceiling (default 3.0).
   *                   The actual ratio may be lower if the text is short.
   * @returns CompressionResult with the compressed text and metrics.
   */
  compress(text: string, maxRatio?: number): Promise<CompressionResult>;

  /**
   * Generate embedding vectors for an array of texts.
   *
   * @param texts - Strings to embed.
   * @returns EmbedResult with one vector per input text, or empty if
   *          this tier has no embedding model.
   */
  embed(texts: string[]): Promise<EmbedResult>;

  /**
   * Returns true if this compressor has all required resources available.
   * Tier 1 always returns true. Higher tiers return false if their model
   * file or native module is missing.
   */
  isAvailable(): boolean;
}

// ── Config types ───────────────────────────────────────────────────────────────

/** External provider config for Tier 4 (from plugin-config.yaml). */
export interface ExternalProviderConfig {
  provider: "ollama" | "lmstudio" | "groq" | "claude";
  model: string;
  base_url: string;
}

/** Full compression config section from plugin-config.yaml. */
export interface CompressionConfig {
  tier: CompressionTier | "auto";
  external: ExternalProviderConfig;
}
