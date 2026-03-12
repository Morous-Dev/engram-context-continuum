/**
 * tier3b.ts — node-llama-cpp GGUF compressor: Qwen3.5 4B Q4_K_M.
 *
 * Responsible for: compressing session context using Qwen3.5 4B via
 * node-llama-cpp. Scored 10/10 on adversarial benchmark. Upgraded from
 * Qwen3.5 2B (9/10) which failed A10 (long article noise masking real work).
 *
 * Output mode: grammar-constrained JSON ("diff-mode"). Falls back to prose
 * if grammar creation fails. Falls back to Tier1 if model is missing.
 *
 * GPU strategy: tries GPU inference at full 4096 context with
 * ignoreMemorySafetyChecks:true. Qwen3.5's hybrid DeltaNet/GQA architecture
 * causes node-llama-cpp's VRAM estimator to over-estimate KV cache, triggering
 * false "too large" rejections despite sufficient free VRAM. The bypass lets
 * the actual CUDA allocator decide — a 4B Q4_K_M model at 4096 ctx uses
 * ~3.5 GB total, well within 16 GB VRAM. If the GPU load still genuinely
 * fails (OOM), retries with gpu:false for CPU-only inference.
 *
 * Note: Qwen3.5 4B has a thinking mode (generates <think>...</think> blocks).
 * The prompt includes /no_think to disable it for fast, direct output.
 *
 * Model file: Qwen3.5-4B-Q4_K_M.gguf (~2.74 GB)
 * Location:   ~/.engram-cc/models/
 * RAM needed:  ~3.5 GB VRAM (GPU) or ~3 GB RAM (CPU)
 *
 * Depends on: node-llama-cpp (optional native npm package),
 *             src/compression/tier1.ts, src/compression/tier2.ts,
 *             src/compression/schema.ts, src/compression/preprocess.ts.
 * Depended on by: src/compression/index.ts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Compressor, CompressionResult, EmbedResult, StructuredHandoff } from "./types.js";
import { Tier1Compressor } from "./tier1.js";
import { Tier2Compressor } from "./tier2.js";
import { preprocessSessionData } from "./preprocess.js";
import { HANDOFF_SCHEMA, buildDiffModePrompt } from "./schema.js";

// ── Model file ─────────────────────────────────────────────────────────────────

const MODEL_FILE = "Qwen3.5-4B-Q4_K_M.gguf";

function getModelPath(): string {
  return join(homedir(), ".engram-cc", "models", MODEL_FILE);
}

// ── Prose fallback prompt ────────────────────────────────────────────────────

/**
 * Build prose prompt with /no_think prepended for Qwen 3.5 2B.
 */
function buildProsePrompt(text: string, maxRatio: number): string {
  const targetWords = Math.floor(text.split(/\s+/).length / maxRatio);
  return [
    `/no_think`,
    ``,
    `You are a senior software engineer writing a precise handoff brief for the next engineer.`,
    `You never claim errors are fixed unless the session log explicitly confirms it.`,
    `Write ${targetWords} words max. Output ONLY prose — no bullet lists, no file lists, no headings.`,
    ``,
    `RULES (mandatory — no exceptions):`,
    `1. Report ONLY the final decision on each topic. If a decision changed, report only the latest version.`,
    `2. Do NOT claim an error was fixed unless the log explicitly confirms the fix succeeded.`,
    `3. If an error appeared fixed then recurred, report it as STILL UNRESOLVED.`,
    `4. The CURRENT TASK is the LAST active, incomplete task mentioned — not the most-mentioned one.`,
    `5. Ignore code blocks marked [CODE BLOCK] — they are implementation noise, not session facts.`,
    `6. Ignore entries marked [REFERENCE DOCUMENT] — they are background material, not decisions.`,
    `7. State only facts present in the session data. Do not infer or extrapolate.`,
    `8. End with what is unfinished and what the next session should start with.`,
    ``,
    `<session_data>`,
    text,
    `</session_data>`,
    ``,
    `[FOCUS: The CURRENT TASK is the LAST active task above. Report only the FINAL state of each decision.]`,
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
  createGrammarForJsonSchema(schema: unknown): Promise<LlamaGrammarInstance>;
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
interface LlamaGrammarInstance {
  parse(json: string): unknown;
}
interface PromptOpts {
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  minP?: number;
  repeatPenalty?: number | { penalty: number; lastTokens?: number };
  grammar?: LlamaGrammarInstance;
}
interface LlamaChatSessionInstance {
  prompt(text: string, opts?: PromptOpts): Promise<string>;
  dispose?: () => void;
}
interface NodeLlamaCppModule {
  getLlama(opts?: LlamaLoadOpts): Promise<LlamaInstance>;
  LlamaChatSession: new (opts: { contextSequence: LlamaSequence }) => LlamaChatSessionInstance;
}

// ── Tier3bCompressor ───────────────────────────────────────────────────────────

/**
 * Tier3bCompressor — GGUF compression via Qwen3.5 4B Q4_K_M.
 *
 * compress(): uses grammar-constrained JSON (diff-mode) when available.
 *             Falls back to prose, then to Tier1.
 *             Tries GPU first; falls back to CPU if VRAM is insufficient.
 * embed():    delegates to Tier2Compressor (MiniLM-L6-v2 sentence embeddings).
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
  private grammar: LlamaGrammarInstance | null = null;

  constructor() {
    this.modelPath = getModelPath();
    this._available = existsSync(this.modelPath);
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Lazily load the Qwen 3.5 2B model and create the JSON grammar.
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
          try {
            this.llama = await llamaCpp.getLlama();
            this.model = await this.llama.loadModel({ modelPath: this.modelPath });
            this.ctx   = await this.model.createContext({ contextSize: 4096, ignoreMemorySafetyChecks: true });
          } catch (gpuErr) {
            const msg = String(gpuErr instanceof Error ? gpuErr.message : gpuErr).toLowerCase();
            const isVramError = msg.includes("vram") || msg.includes("too large") || msg.includes("out of memory");
            if (!isVramError) throw gpuErr;

            // Attempt 2: CPU-only inference
            console.error(`[EngramCC:tier3b] GPU allocation failed, falling back to CPU inference`);
            try { await this.ctx?.dispose(); } catch { /* ignore */ }
            try { await this.model?.dispose(); } catch { /* ignore */ }
            try { await this.llama?.dispose(); } catch { /* ignore */ }
            this.ctx = this.model = this.llama = null;

            this.llama = await llamaCpp.getLlama({ gpu: false });
            this.model = await this.llama.loadModel({ modelPath: this.modelPath });
            this.ctx   = await this.model.createContext({ contextSize: 4096 });
          }

          // Create grammar for structured JSON output. Non-fatal if unsupported.
          try {
            this.grammar = await this.llama!.createGrammarForJsonSchema(HANDOFF_SCHEMA);
          } catch {
            console.error("[EngramCC:tier3b] grammar creation failed, falling back to prose mode");
          }

          return new llamaCpp.LlamaChatSession({ contextSequence: this.ctx!.getSequence() });
        } catch {
          this._available = false;
          return null;
        }
      })();
    }
    return this.loadPromise;
  }

  /**
   * Compress text using Qwen 3.5 2B. Tries diff-mode (JSON) first,
   * falls back to prose, falls back to Tier1 if unavailable.
   *
   * @param text     - Text to compress.
   * @param maxRatio - Target compression ratio (default 3.0).
   */
  async compress(text: string, maxRatio = 3.0, promptBuilder?: import("./types.js").PromptBuilder): Promise<CompressionResult> {
    const session = await this.getOrLoadSession();
    if (!session) return this.fallback.compress(text, maxRatio);

    try {
      const cleaned = preprocessSessionData(text);
      const targetTokens = Math.ceil(cleaned.split(/\s+/).length / maxRatio * 1.5);
      // JSON is ~50% more token-heavy than prose; grammar mode gets a higher cap.
      const maxTokens = this.grammar
        ? Math.max(300, Math.min(targetTokens, 800))
        : Math.max(200, Math.min(targetTokens, 600));

      // ── Diff-mode: grammar-constrained JSON output ────────────────────────
      if (this.grammar) {
        try {
          // /no_think prepended for Qwen's thinking mode suppression
          const prompt = `/no_think\n\n${(promptBuilder ?? buildDiffModePrompt)(cleaned)}`;
          const raw = await session.prompt(prompt, {
            maxTokens,
            temperature: 0.1,
            topK: 1,
            repeatPenalty: 1.05,
            grammar: this.grammar,
          });

          const parsed = this.grammar.parse(raw) as StructuredHandoff;
          if (parsed && parsed.current_task) {
            const compressed = JSON.stringify(parsed);
            return {
              compressed,
              originalChars: text.length,
              compressedChars: compressed.length,
              ratio: text.length / Math.max(compressed.length, 1),
              tier: this.tier,
              format: "json",
              structured: parsed,
            };
          }
        } catch {
          console.error("[EngramCC:tier3b] diff-mode failed, falling back to prose");
        }
      }

      // ── Prose fallback ────────────────────────────────────────────────────
      const prompt = buildProsePrompt(cleaned, maxRatio);
      const summary = await session.prompt(prompt, {
        maxTokens,
        temperature: 0.1,
        topK: 1,
        repeatPenalty: 1.05,
      });

      const compressed = summary.trim();
      if (!compressed) return this.fallback.compress(text, maxRatio);

      return {
        compressed,
        originalChars: text.length,
        compressedChars: compressed.length,
        ratio: text.length / Math.max(compressed.length, 1),
        tier: this.tier,
        format: "prose",
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
