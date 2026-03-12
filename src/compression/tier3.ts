/**
 * tier3.ts — node-llama-cpp GGUF compressor: Llama 3.2 3B Q5_K_M.
 *
 * Responsible for: compressing session context using Llama 3.2 3B via
 * node-llama-cpp. Scored 10/10 on adversarial benchmark (code walls, stack
 * traces, pasted articles, error flip-flops, buried tasks, domain jargon).
 *
 * Output mode: grammar-constrained JSON ("diff-mode"). Instead of free prose,
 * the model fills a structured JSON schema via GBNF grammar. Enums force
 * conservative status choices (UNRESOLVED/RESOLVED/RECURRED) — the model
 * cannot hedge or soften status. Falls back to prose mode if grammar creation
 * fails (e.g., older node-llama-cpp version).
 *
 * Embeddings are delegated to Tier2Compressor since GGUF chat models
 * do not reliably produce sentence embeddings.
 *
 * Model file: llama-3.2-3b-instruct-q5_k_m.gguf (~2.32 GB)
 * Location:   ~/.engram-cc/models/
 * RAM needed:  ~4 GB free
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

// ── Prose fallback prompt ────────────────────────────────────────────────────

/**
 * Build a prose extraction prompt (used when grammar is unavailable).
 *
 * @param text     - Preprocessed session data (noise already stripped).
 * @param maxRatio - Target compression ratio.
 * @returns Formatted prompt string.
 */
function buildProsePrompt(text: string, maxRatio: number): string {
  const targetWords = Math.floor(text.split(/\s+/).length / maxRatio);
  return [
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

// Minimal interfaces to avoid hard-typing the entire node-llama-cpp library.
interface LlamaInstance {
  loadModel(opts: { modelPath: string }): Promise<LlamaModel>;
  createGrammarForJsonSchema(schema: unknown): Promise<LlamaGrammarInstance>;
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

/** Grammar instance returned by createGrammarForJsonSchema. */
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
  getLlama(): Promise<LlamaInstance>;
  LlamaChatSession: new (opts: { contextSequence: LlamaSequence }) => LlamaChatSessionInstance;
}

// ── Tier3Compressor ────────────────────────────────────────────────────────────

/**
 * Tier3Compressor — GGUF model-based compression via node-llama-cpp.
 *
 * compress(): uses grammar-constrained JSON output (diff-mode) when available.
 *             Falls back to prose mode if grammar creation fails.
 *             Falls back to Tier1 if the model is not available at all.
 * embed():    delegates to Tier2Compressor (MiniLM-L6-v2 sentence embeddings).
 *
 * The model and grammar are loaded lazily on first compress() call and cached.
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
  private grammar: LlamaGrammarInstance | null = null;

  constructor() {
    this.modelPath = getModelPath();
    this._available = existsSync(this.modelPath);
  }

  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Lazily load the GGUF model and create the JSON grammar.
   * Returns null if the model file is missing or node-llama-cpp is not installed.
   * Grammar creation failure is non-fatal — falls back to prose mode.
   */
  private getOrLoadSession(): Promise<LlamaChatSessionInstance | null> {
    if (!this.loadPromise) {
      this.loadPromise = (async (): Promise<LlamaChatSessionInstance | null> => {
        if (!this._available) return null;
        try {
          const llamaCpp = await import("node-llama-cpp") as unknown as NodeLlamaCppModule;
          this.llama = await llamaCpp.getLlama();
          this.model = await this.llama.loadModel({ modelPath: this.modelPath });
          this.ctx = await this.model.createContext({ contextSize: 4096 });

          // Create grammar for structured JSON output. Non-fatal if unsupported.
          try {
            this.grammar = await this.llama.createGrammarForJsonSchema(HANDOFF_SCHEMA);
          } catch {
            console.error("[EngramCC:tier3] grammar creation failed, falling back to prose mode");
          }

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
   * Compress text using the GGUF model. Tries diff-mode (JSON) first,
   * falls back to prose, falls back to Tier1 if unavailable.
   *
   * @param text     - Text to compress.
   * @param maxRatio - Target compression ratio (default 3.0).
   */
  async compress(text: string, maxRatio = 3.0): Promise<CompressionResult> {
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
          const prompt = buildDiffModePrompt(cleaned);
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
          // Grammar-constrained generation failed — fall through to prose
          console.error("[EngramCC:tier3] diff-mode failed, falling back to prose");
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

  /** Dispose the loaded model and context to free VRAM/RAM. */
  async dispose(): Promise<void> {
    try { await this.ctx?.dispose(); } catch { /* ignore */ }
    try { await this.model?.dispose(); } catch { /* ignore */ }
    try { await this.llama?.dispose(); } catch { /* ignore */ }
  }
}
