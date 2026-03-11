/**
 * tier3b.ts — node-llama-cpp GGUF compressor: Qwen 3.5 2B Q5_K_M.
 *
 * Responsible for: compressing session context using Qwen 3.5 2B via
 * node-llama-cpp. This is the lightweight GGUF tier — selected after quality
 * testing where it scored 3/3 on conflict resolution, error truthfulness,
 * and intent extraction. Smaller than tier3 (1.44 GB vs 2.32 GB) and suitable
 * for machines with limited GPU VRAM.
 *
 * GPU strategy: tries GPU inference at full 4096 context with
 * ignoreMemorySafetyChecks:true. Qwen 3.5 2B's hybrid DeltaNet/GQA architecture
 * causes node-llama-cpp's VRAM estimator to over-estimate KV cache by 10-100×,
 * triggering false "too large" rejections at ≥1024 ctx despite 15+ GB free VRAM
 * on RTX 5060 Ti (Blackwell SM_120). The bypass lets the actual CUDA allocator
 * decide — a 2B model at 4096 ctx actually uses ~2.5 GB total, well within VRAM.
 * If the GPU load still genuinely fails, retries with gpu:false for CPU-only
 * inference. CPU is slower (~1-3 min) but always works.
 *
 * Root cause research: node-llama-cpp issue #435, llama.cpp Qwen3.5 arch issues
 * #19879/#19858, and confirmed VRAM reporting quirk on RTX 50-series Blackwell.
 *
 * Model file: qwen3.5-2b-q5_k_m.gguf (~1.44 GB)
 * Location:   ~/.engram-cc/models/
 * RAM needed:  ~2.5 GB VRAM (GPU) or ~2 GB RAM (CPU)
 *
 * Note: Qwen 3.5 2B has a thinking mode (generates <think>...</think> blocks).
 * The prompt includes /no_think to disable it for fast, direct summarization.
 *
 * Depends on: node-llama-cpp (optional native npm package),
 *             src/compression/tier1.ts, src/compression/tier2.ts.
 * Depended on by: src/compression/index.ts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Compressor, CompressionResult, EmbedResult } from "./types.js";
import { Tier1Compressor } from "./tier1.js";
import { Tier2Compressor } from "./tier2.js";

// ── Model file ─────────────────────────────────────────────────────────────────

const MODEL_FILE = "qwen3.5-2b-q5_k_m.gguf";

function getModelPath(): string {
  return join(homedir(), ".engram-cc", "models", MODEL_FILE);
}

// ── Compression prompt ─────────────────────────────────────────────────────────

/**
 * Build the Archivist prompt for Qwen 3.5 2B.
 *
 * Identical to tier3.ts buildCompressionPrompt, with /no_think prepended to
 * suppress Qwen's chain-of-thought reasoning mode. Without this, Qwen generates
 * a <think>...</think> block that gets stripped by LlamaChatSession, leaving
 * an empty or truncated output.
 *
 * @param text     - Structured session data to synthesize.
 * @param maxRatio - Target compression ratio.
 * @returns Formatted prompt string.
 */
function buildCompressionPrompt(text: string, maxRatio: number): string {
  const targetWords = Math.floor(text.split(/\s+/).length / maxRatio);
  return [
    // /no_think disables Qwen 3.5's thinking mode — required for direct output
    `/no_think`,
    ``,
    `You are a session archivist. Produce a concise handoff brief for the next coding session.`,
    `Write ${targetWords} words max. Output ONLY prose — no bullet lists, no file lists, no headings.`,
    ``,
    `Rules:`,
    `- Describe WHAT was done and WHY, not which files were touched (file list is stored separately)`,
    `- Name specific bugs fixed, features added, or architectural changes made`,
    `- If decisions conflict, report only the FINAL decision`,
    `- If an error was resolved, say "resolved" — don't re-report the error`,
    `- End with what is unfinished or what the next session should start with`,
    ``,
    `Session data:`,
    text,
    ``,
    `Brief:`,
  ].join("\n");
}

// ── Internal node-llama-cpp types ──────────────────────────────────────────────

interface LlamaLoadOpts {
  gpu?: boolean;
  [key: string]: unknown;
}
interface LlamaInstance {
  loadModel(opts: { modelPath: string }): Promise<LlamaModel>;
  dispose(): Promise<void>;
}
interface LlamaModel {
  createContext(opts?: { contextSize?: number; ignoreMemorySafetyChecks?: boolean }): Promise<LlamaContext>;
  dispose(): Promise<void>;
}
interface LlamaContext {
  getSequence(): LlamaSequence;
  dispose(): Promise<void>;
}
interface LlamaSequence { [key: string]: unknown; }
interface LlamaChatSessionInstance {
  prompt(text: string, opts?: { maxTokens?: number }): Promise<string>;
  dispose?: () => void;
}
interface NodeLlamaCppModule {
  getLlama(opts?: LlamaLoadOpts): Promise<LlamaInstance>;
  LlamaChatSession: new (opts: { contextSequence: LlamaSequence }) => LlamaChatSessionInstance;
}

// ── Tier3bCompressor ───────────────────────────────────────────────────────────

/**
 * Tier3bCompressor — lightweight GGUF compression via Qwen 3.5 2B.
 *
 * compress(): uses Qwen 3.5 2B to generate a concise handoff summary.
 *             Tries GPU first; falls back to CPU if VRAM is insufficient.
 *             Falls back to Tier1 if the model file is missing.
 * embed():    delegates to Tier2Compressor (MiniLM-L6-v2 sentence embeddings).
 *
 * The model is loaded lazily on first compress() call and cached for the
 * lifetime of the compressor.
 */
export class Tier3bCompressor implements Compressor {
  readonly tier = "tier3b" as const;

  private readonly modelPath: string;
  private readonly fallback = new Tier1Compressor();
  private readonly embedder = new Tier2Compressor();
  private _available: boolean;
  private loadPromise: Promise<LlamaChatSessionInstance | null> | null = null;
  private llama: LlamaInstance | null = null;
  private model: LlamaModel | null = null;
  private ctx: LlamaContext | null = null;

  constructor() {
    this.modelPath = getModelPath();
    this._available = existsSync(this.modelPath);
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Lazily load the Qwen 3.5 2B model via node-llama-cpp.
   *
   * GPU strategy: uses ignoreMemorySafetyChecks:true to bypass the VRAM
   * estimator, which over-estimates KV cache for Qwen 3.5's hybrid
   * DeltaNet/GQA architecture and falsely rejects ≥1024 ctx on Blackwell GPUs.
   * If the actual CUDA allocation fails (genuine OOM), falls back to CPU.
   */
  private getOrLoadSession(): Promise<LlamaChatSessionInstance | null> {
    if (!this.loadPromise) {
      this.loadPromise = (async (): Promise<LlamaChatSessionInstance | null> => {
        if (!this._available) return null;
        try {
          const llamaCpp = await import("node-llama-cpp") as unknown as NodeLlamaCppModule;

          // Attempt 1: GPU at full context, bypassing the VRAM estimator.
          // The estimator wrongly rejects Qwen 3.5 2B at ≥1024 ctx on RTX 5060 Ti
          // (Blackwell SM_120) due to its hybrid DeltaNet architecture not being
          // accounted for. Actual GPU usage is ~2.5 GB — well within 16 GB VRAM.
          try {
            this.llama = await llamaCpp.getLlama();
            this.model = await this.llama.loadModel({ modelPath: this.modelPath });
            this.ctx   = await this.model.createContext({ contextSize: 4096, ignoreMemorySafetyChecks: true });
            return new llamaCpp.LlamaChatSession({ contextSequence: this.ctx.getSequence() });
          } catch (gpuErr) {
            const msg = String(gpuErr instanceof Error ? gpuErr.message : gpuErr).toLowerCase();
            const isVramError = msg.includes("vram") || msg.includes("too large") || msg.includes("out of memory");
            if (!isVramError) throw gpuErr; // Not a VRAM issue — propagate

            // Attempt 2: CPU-only inference (slower but works with any GPU/RAM config)
            console.error(`[EngramCC:tier3b] GPU allocation failed, falling back to CPU inference`);
            try { await this.ctx?.dispose(); } catch { /* ignore */ }
            try { await this.model?.dispose(); } catch { /* ignore */ }
            try { await this.llama?.dispose(); } catch { /* ignore */ }
            this.ctx = this.model = this.llama = null;

            this.llama = await llamaCpp.getLlama({ gpu: false });
            this.model = await this.llama.loadModel({ modelPath: this.modelPath });
            this.ctx   = await this.model.createContext({ contextSize: 4096 });
            return new llamaCpp.LlamaChatSession({ contextSequence: this.ctx.getSequence() });
          }
        } catch {
          this._available = false;
          return null;
        }
      })();
    }
    return this.loadPromise;
  }

  /**
   * Compress text using Qwen 3.5 2B. Falls back to Tier 1 if unavailable.
   *
   * @param text     - Text to compress.
   * @param maxRatio - Target compression ratio (default 3.0).
   */
  async compress(text: string, maxRatio = 3.0): Promise<CompressionResult> {
    const session = await this.getOrLoadSession();
    if (!session) return this.fallback.compress(text, maxRatio);

    try {
      const prompt = buildCompressionPrompt(text, maxRatio);
      const targetTokens = Math.ceil(text.split(/\s+/).length / maxRatio * 1.5);
      const maxTokens = Math.max(150, Math.min(targetTokens, 500));
      const summary = await session.prompt(prompt, { maxTokens });

      const compressed = summary.trim();
      if (!compressed) return this.fallback.compress(text, maxRatio);

      return {
        compressed,
        originalChars: text.length,
        compressedChars: compressed.length,
        ratio: text.length / Math.max(compressed.length, 1),
        tier: this.tier,
      };
    } catch {
      return this.fallback.compress(text, maxRatio);
    }
  }

  /**
   * Delegate embedding generation to Tier2Compressor (MiniLM-L6-v2).
   *
   * @param texts - Strings to embed.
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    return this.embedder.embed(texts);
  }

  /** Dispose the loaded model and context to free RAM/VRAM. */
  async dispose(): Promise<void> {
    try { await this.ctx?.dispose(); } catch { /* ignore */ }
    try { await this.model?.dispose(); } catch { /* ignore */ }
    try { await this.llama?.dispose(); } catch { /* ignore */ }
  }
}
