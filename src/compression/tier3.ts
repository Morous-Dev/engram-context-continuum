/**
 * tier3.ts — node-llama-cpp GGUF compressor: Llama 3.2 3B Q5_K_M.
 *
 * Responsible for: compressing session context using Llama 3.2 3B via
 * node-llama-cpp. This is the sole GGUF model — selected after quality
 * testing where it scored 3/3 on code-awareness, conflict resolution,
 * and intent extraction. Qwen 2.5 1.5B and Phi-4 Mini were removed:
 * both hallucinated that unresolved errors were fixed.
 *
 * Embeddings are delegated to Tier2Compressor since GGUF chat models
 * do not reliably produce sentence embeddings.
 *
 * Model file: llama-3.2-3b-instruct-q5_k_m.gguf (~2.32 GB)
 * Location:   ~/.engram-cc/models/
 * RAM needed:  ~4 GB free
 *
 * Depends on: node-llama-cpp (optional native npm package),
 *             src/compression/tier1.ts, src/compression/tier2.ts.
 * Depended on by: src/compression/index.ts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Compressor, CompressionResult, EmbedResult, CompressionTier } from "./types.js";
import { Tier1Compressor } from "./tier1.js";
import { Tier2Compressor } from "./tier2.js";

// ── Model registry ─────────────────────────────────────────────────────────────

/** The sole GGUF model: Llama 3.2 3B Q5_K_M. */
const MODEL_FILE = "llama-3.2-3b-instruct-q5_k_m.gguf";

/**
 * Get the model file path.
 *
 * @returns Absolute path to the GGUF model file.
 */
function getModelPath(): string {
  return join(homedir(), ".engram-cc", "models", MODEL_FILE);
}

// ── Compression prompt ─────────────────────────────────────────────────────────

/**
 * Build a structured extraction prompt for the GGUF model.
 *
 * The prompt asks for reasoning-aware synthesis — not just summarization but
 * intent extraction, conflict resolution between decisions, and actionable
 * context for the next session. This is the core "Archivist" prompt.
 *
 * @param text     - The structured session data to synthesize.
 * @param maxRatio - Target compression ratio.
 * @returns Formatted prompt string.
 */
function buildCompressionPrompt(text: string, maxRatio: number): string {
  const targetWords = Math.floor(text.split(/\s+/).length / maxRatio);
  return [
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

// node-llama-cpp exports getLlama and LlamaChatSession.
// We use a minimal interface to avoid hard-typing the entire library.
interface LlamaInstance {
  loadModel(opts: { modelPath: string }): Promise<LlamaModel>;
  dispose(): Promise<void>;
}
interface LlamaModel {
  createContext(opts?: { contextSize?: number }): Promise<LlamaContext>;
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
  getLlama(): Promise<LlamaInstance>;
  LlamaChatSession: new (opts: { contextSequence: LlamaSequence }) => LlamaChatSessionInstance;
}

// ── Tier3Compressor ────────────────────────────────────────────────────────────

/**
 * Tier3Compressor — GGUF model-based compression via node-llama-cpp.
 *
 * compress(): uses the GGUF model to generate a high-quality summary.
 *             Falls back to Tier1 if the model is not available.
 * embed():    delegates to Tier2Compressor (MiniLM-L6-v2 sentence embeddings).
 *
 * The model is loaded lazily on first compress() call and cached for the
 * lifetime of the compressor. Both llama and model are disposed on GC or
 * explicit dispose() call.
 */
export class Tier3Compressor implements Compressor {
  readonly tier = "tier3" as const;

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
    // Pre-check model file existence — node-llama-cpp itself is checked at load time
    this._available = existsSync(this.modelPath);
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Lazily load the GGUF model via node-llama-cpp.
   * Returns null if the model file is missing or node-llama-cpp is not installed.
   */
  private getOrLoadSession(): Promise<LlamaChatSessionInstance | null> {
    if (!this.loadPromise) {
      this.loadPromise = (async (): Promise<LlamaChatSessionInstance | null> => {
        if (!this._available) return null;
        try {
          // Dynamic import — node-llama-cpp is an optional native addon
          const llamaCpp = await import("node-llama-cpp") as unknown as NodeLlamaCppModule;
          this.llama = await llamaCpp.getLlama();
          this.model = await this.llama.loadModel({ modelPath: this.modelPath });
          // 4096-token context: enough for structured session data + synthesis output.
          // Phi-4 Mini supports 128K but we cap at 4096 to keep RAM and latency bounded.
          this.ctx = await this.model.createContext({ contextSize: 4096 });
          return new llamaCpp.LlamaChatSession({ contextSequence: this.ctx.getSequence() });
        } catch {
          this._available = false;
          return null;
        }
      })();
    }
    return this.loadPromise;
  }

  /**
   * Compress text using the GGUF model. Falls back to Tier 1 if unavailable.
   *
   * @param text     - Text to compress.
   * @param maxRatio - Target compression ratio (default 3.0).
   */
  async compress(text: string, maxRatio = 3.0): Promise<CompressionResult> {
    const session = await this.getOrLoadSession();
    if (!session) return this.fallback.compress(text, maxRatio);

    try {
      const prompt = buildCompressionPrompt(text, maxRatio);
      // Target output: input words / ratio, with a floor of 150 tokens and cap of 500
      // to prevent both truncation and runaway generation.
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
   * GGUF chat models do not produce reliable sentence embeddings.
   *
   * @param texts - Strings to embed.
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    return this.embedder.embed(texts);
  }

  /** Dispose the loaded model and context to free VRAM/RAM. */
  async dispose(): Promise<void> {
    try { await this.ctx?.dispose(); } catch { /* ignore */ }
    try { await this.model?.dispose(); } catch { /* ignore */ }
    try { await this.llama?.dispose(); } catch { /* ignore */ }
  }
}
