/**
 * query-expander.ts — Gemma 3 1B query expansion for FTS5 retrieval.
 *
 * Responsible for: taking raw event text from a tool call and generating
 * semantically enriched search terms that improve FTS5 recall. The current
 * word-splitting approach (split → filter ≥4 chars → OR-join) misses
 * synonyms, related concepts, and technical term associations. A 1B model
 * bridges that vocabulary gap in ~30-80ms on GPU.
 *
 * This is Gemma 1B's one job — focused query expansion, nothing else.
 *
 * Architecture:
 *   1. Receive raw event text (truncated to 500 chars for speed)
 *   2. Prompt Gemma 1B to emit 5-8 distinctive search terms
 *   3. Merge SLM terms with the original word-split terms (union)
 *   4. Return expanded term array ready for FTS5 OR-join
 *
 * Performance budget:
 *   - Warm inference: ~30-80ms (1B model, short prompt, short output)
 *   - Cold start (first call): ~500ms-2s (1B model is small)
 *   - Timeout: 3 seconds hard cap (falls back to original terms)
 *   - GPU memory: ~800 MB VRAM (fits alongside tier3 models)
 *
 * The expander is independent from the Compressor interface — it doesn't
 * compress or embed. It has its own model, lifecycle, and singleton.
 *
 * Depends on: node-llama-cpp (optional), node:fs, src/project-id.ts.
 * Depended on by: src/hooks/posttooluse.mjs (FTS5 path).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getProjectModelsDir, getRuntimeProjectDir } from "../project-id.js";

// ── Model file ─────────────────────────────────────────────────────────────────

const MODEL_FILE = "google_gemma-3-1b-it-qat-Q4_0.gguf";

function getModelPath(): string {
  return join(getProjectModelsDir(getRuntimeProjectDir()), MODEL_FILE);
}

/**
 * Hard timeout for a single expand() call. If the model doesn't respond
 * within this window, we fall back to the original terms — no harm done.
 * 3s is generous for a 1B model generating ~20 tokens.
 */
const EXPAND_TIMEOUT_MS = 3_000;

/**
 * Context window for the expander model. 1B models are fast at small
 * context sizes. 512 tokens is plenty for a short prompt + 20-token output.
 */
const CONTEXT_SIZE = 512;

// ── Internal node-llama-cpp types (minimal subset) ──────────────────────────

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
interface PromptOpts {
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  repeatPenalty?: number;
}
interface LlamaChatSessionInstance {
  prompt(text: string, opts?: PromptOpts): Promise<string>;
  dispose?: () => void;
}
interface NodeLlamaCppModule {
  getLlama(): Promise<LlamaInstance>;
  LlamaChatSession: new (opts: { contextSequence: LlamaSequence }) => LlamaChatSessionInstance;
}

// ── Singleton state ─────────────────────────────────────────────────────────

let _session: LlamaChatSessionInstance | null = null;
let _loadPromise: Promise<LlamaChatSessionInstance | null> | null = null;
let _llama: LlamaInstance | null = null;
let _model: LlamaModel | null = null;
let _ctx: LlamaContext | null = null;
let _available: boolean | null = null;

// ── Prompt ──────────────────────────────────────────────────────────────────

/**
 * Build the query expansion prompt. Short and directive — the 1B model
 * works best with clear, constrained instructions.
 *
 * @param text - Raw event text (truncated to 500 chars by caller).
 * @returns Formatted prompt string.
 */
function buildExpandPrompt(text: string): string {
  return [
    `You are a search query expander. Given a software development action description, output 5-8 distinctive search terms that would help find related past decisions, errors, and patterns.`,
    ``,
    `Rules:`,
    `- Output ONLY the terms, one per line`,
    `- Include synonyms, related concepts, and technical alternatives`,
    `- Include specific technology names and common abbreviations`,
    `- Do NOT repeat words already in the input`,
    `- Do NOT output explanations, headers, or numbering`,
    ``,
    `Action: ${text}`,
    ``,
    `Terms:`,
  ].join("\n");
}

// ── Core ────────────────────────────────────────────────────────────────────

/**
 * Check if the Gemma 1B model file exists. Cached after first check.
 *
 * @returns true if the model file is present in the current project's configured shared models directory.
 */
export function isExpanderAvailable(): boolean {
  if (_available === null) {
    try {
      _available = existsSync(getModelPath());
    } catch {
      _available = false;
    }
  }
  return _available;
}

/**
 * Lazily load the Gemma 1B model. Returns null if model is missing or
 * node-llama-cpp is not installed. Cached as a module-level singleton.
 */
async function getOrLoadSession(): Promise<LlamaChatSessionInstance | null> {
  if (!_loadPromise) {
    _loadPromise = (async (): Promise<LlamaChatSessionInstance | null> => {
      if (!isExpanderAvailable()) return null;
      try {
        const llamaCpp = await import("node-llama-cpp") as unknown as NodeLlamaCppModule;
        _llama = await llamaCpp.getLlama();
        _model = await _llama.loadModel({ modelPath: getModelPath() });
        _ctx = await _model.createContext({ contextSize: CONTEXT_SIZE });
        _session = new llamaCpp.LlamaChatSession({ contextSequence: _ctx.getSequence() });
        return _session;
      } catch {
        _available = false;
        return null;
      }
    })();
  }
  return _loadPromise;
}

/**
 * Parse the model's raw output into an array of clean search terms.
 * Handles numbered lists, bullet points, and comma-separated output.
 *
 * @param raw - Raw model output string.
 * @returns Array of lowercase, sanitized terms (4+ chars, max 8).
 */
function parseTerms(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map(line =>
      line
        .replace(/^\s*[-•*\d.)\]]+\s*/, "")  // Strip bullets/numbers
        .replace(/[^a-zA-Z0-9\s_.-]/g, " ")  // Strip special chars
        .trim()
        .toLowerCase()
    )
    .filter(t => t.length >= 3 && t.length <= 40)
    .slice(0, 8);
}

/**
 * Expand a raw event text into enriched FTS5 search terms using Gemma 1B.
 *
 * Falls back to an empty array on any failure (model unavailable, timeout,
 * empty output). The caller is responsible for merging with the original
 * word-split terms.
 *
 * @param eventText - Raw event text from a tool call (will be truncated to 500 chars).
 * @returns Array of expanded search terms, or empty array on failure.
 */
export async function expandQuery(eventText: string): Promise<string[]> {
  if (!isExpanderAvailable()) return [];

  const truncated = eventText.slice(0, 500);

  try {
    // Race the model against a hard timeout
    const result = await Promise.race([
      (async () => {
        const session = await getOrLoadSession();
        if (!session) return [];

        const prompt = buildExpandPrompt(truncated);
        const raw = await session.prompt(prompt, {
          maxTokens: 60,
          temperature: 0.3,
          topK: 10,
          repeatPenalty: 1.2,
        });

        return parseTerms(raw);
      })(),
      new Promise<string[]>((resolve) =>
        setTimeout(() => resolve([]), EXPAND_TIMEOUT_MS)
      ),
    ]);

    return result;
  } catch {
    // Query expansion failure is non-fatal — return empty, caller uses original terms
    return [];
  }
}

/**
 * Dispose the loaded model to free VRAM/RAM. Called during cleanup.
 */
export async function disposeExpander(): Promise<void> {
  try { await _ctx?.dispose(); } catch { /* ignore */ }
  try { await _model?.dispose(); } catch { /* ignore */ }
  try { await _llama?.dispose(); } catch { /* ignore */ }
  _session = null;
  _loadPromise = null;
  _ctx = null;
  _model = null;
  _llama = null;
}
