/**
 * tier4.ts — External HTTP provider compressor.
 *
 * Responsible for: compressing text and generating embeddings by calling an
 * external inference server. Supports four providers:
 *   - Ollama     (local, http://localhost:11434)
 *   - LM Studio  (local, http://localhost:1234, OpenAI-compatible)
 *   - Groq       (cloud, GROQ_API_KEY env var)
 *   - Claude API (cloud, ANTHROPIC_API_KEY env var)
 *
 * API keys for cloud providers MUST come from environment variables — never
 * from config files (CLAUDE.md Security Fundamentals §2).
 *
 * Embeddings are delegated to Tier2Compressor. Only Ollama has a native
 * embeddings endpoint; for LM Studio / Groq / Claude, Tier 2 handles embed().
 *
 * Depends on: node:fetch (Node 18+ built-in), src/compression/tier1.ts,
 *             src/compression/tier2.ts, src/compression/types.ts.
 * Depended on by: src/compression/index.ts.
 */

import type {
  Compressor,
  CompressionResult,
  EmbedResult,
  ExternalProviderConfig,
} from "./types.js";
import { Tier1Compressor } from "./tier1.js";
import { Tier2Compressor } from "./tier2.js";

/** Timeout for external API calls in milliseconds. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Max tokens to generate for a summarization response. */
const MAX_SUMMARY_TOKENS = 512;

// ── HTTP helpers ───────────────────────────────────────────────────────────────

/**
 * POST JSON to a URL with a timeout and return the parsed response body.
 *
 * @param url     - Full URL to POST to.
 * @param body    - Request body (will be JSON-serialized).
 * @param headers - Extra headers (e.g., Authorization).
 * @returns Parsed JSON response.
 * @throws If the request fails, times out, or returns a non-2xx status.
 */
async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Provider-specific compression ─────────────────────────────────────────────

/** Build a compression prompt for chat-format providers. */
function buildCompressPrompt(text: string, maxRatio: number): string {
  const targetWords = Math.floor(text.split(/\s+/).length / maxRatio);
  return (
    `Summarize this technical context in ~${targetWords} words. ` +
    `Preserve ALL file paths, decisions, errors, and key findings. ` +
    `Respond with ONLY the summary — no preamble.\n\n${text}`
  );
}

/**
 * Compress via Ollama (POST /api/generate).
 *
 * @param config - Provider configuration.
 * @param text   - Text to compress.
 * @param ratio  - Target compression ratio.
 */
async function compressViaOllama(
  config: ExternalProviderConfig,
  text: string,
  ratio: number,
): Promise<string> {
  const url = `${config.base_url}/api/generate`;
  const res = await postJson(url, {
    model: config.model,
    prompt: buildCompressPrompt(text, ratio),
    stream: false,
    options: { num_predict: MAX_SUMMARY_TOKENS },
  }) as { response?: string };
  return (res.response ?? "").trim();
}

/**
 * Compress via an OpenAI-compatible endpoint (LM Studio, or Groq).
 *
 * @param baseUrl - Base URL of the API.
 * @param model   - Model ID.
 * @param apiKey  - Authorization bearer token (empty string if none).
 * @param text    - Text to compress.
 * @param ratio   - Target compression ratio.
 */
async function compressViaOpenAICompat(
  baseUrl: string,
  model: string,
  apiKey: string,
  text: string,
  ratio: number,
): Promise<string> {
  const url = `${baseUrl}/v1/chat/completions`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await postJson(url, {
    model,
    messages: [{ role: "user", content: buildCompressPrompt(text, ratio) }],
    max_tokens: MAX_SUMMARY_TOKENS,
    temperature: 0,
  }) as { choices?: Array<{ message?: { content?: string } }> };

  return res.choices?.[0]?.message?.content?.trim() ?? "";
}

/**
 * Compress via the Anthropic Messages API.
 *
 * @param model   - Claude model ID (e.g., "claude-haiku-4-5-20251001").
 * @param apiKey  - Anthropic API key from ANTHROPIC_API_KEY env var.
 * @param text    - Text to compress.
 * @param ratio   - Target compression ratio.
 */
async function compressViaClaude(
  model: string,
  apiKey: string,
  text: string,
  ratio: number,
): Promise<string> {
  const res = await postJson(
    "https://api.anthropic.com/v1/messages",
    {
      model,
      max_tokens: MAX_SUMMARY_TOKENS,
      messages: [{ role: "user", content: buildCompressPrompt(text, ratio) }],
    },
    {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  ) as { content?: Array<{ text?: string }> };

  return res.content?.[0]?.text?.trim() ?? "";
}

/**
 * Generate embeddings via Ollama (POST /api/embeddings).
 * Returns empty result if the request fails.
 *
 * @param config - Provider configuration.
 * @param texts  - Strings to embed.
 */
async function embedViaOllama(
  config: ExternalProviderConfig,
  texts: string[],
): Promise<EmbedResult> {
  const embeddings: number[][] = [];
  const url = `${config.base_url}/api/embeddings`;

  for (const text of texts) {
    try {
      const res = await postJson(url, { model: config.model, prompt: text }) as {
        embedding?: number[];
      };
      if (res.embedding?.length) {
        embeddings.push(res.embedding);
      }
    } catch {
      // Partial failure — skip this text
    }
  }

  const dims = embeddings[0]?.length ?? 0;
  return { embeddings, dimensions: dims, tier: "tier4" };
}

// ── Tier4Compressor ────────────────────────────────────────────────────────────

/**
 * Tier4Compressor — external HTTP provider for inference.
 *
 * compress(): calls the configured provider's generation endpoint.
 *             Falls back to Tier 1 on any request failure.
 * embed():    Ollama supports native embeddings. All other providers
 *             delegate to Tier2Compressor (MiniLM-L6-v2 embeddings).
 *
 * API keys (Groq, Claude) are read exclusively from environment variables:
 *   Groq:   GROQ_API_KEY
 *   Claude: ANTHROPIC_API_KEY
 */
export class Tier4Compressor implements Compressor {
  readonly tier = "tier4" as const;

  private readonly config: ExternalProviderConfig;
  private readonly fallback = new Tier1Compressor();
  private readonly embedder = new Tier2Compressor();

  /**
   * @param config - External provider configuration from plugin-config.yaml.
   */
  constructor(config: ExternalProviderConfig) {
    this.config = config;
  }

  /**
   * Returns true. Tier 4 is considered "available" by configuration — if the
   * external service is unreachable, compress() and embed() fall back gracefully.
   */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Compress text by calling the configured external provider.
   * Falls back to Tier 1 if the provider is unreachable or returns empty text.
   *
   * @param text     - Text to compress.
   * @param maxRatio - Target compression ratio.
   */
  async compress(text: string, maxRatio = 3.0): Promise<CompressionResult> {
    let summary = "";

    try {
      switch (this.config.provider) {
        case "ollama":
          summary = await compressViaOllama(this.config, text, maxRatio);
          break;

        case "lmstudio":
          summary = await compressViaOpenAICompat(
            this.config.base_url,
            this.config.model,
            "",  // LM Studio does not require auth
            text,
            maxRatio,
          );
          break;

        case "groq": {
          const groqKey = process.env["GROQ_API_KEY"] ?? "";
          if (!groqKey) return this.fallback.compress(text, maxRatio);
          summary = await compressViaOpenAICompat(
            "https://api.groq.com/openai",
            this.config.model,
            groqKey,
            text,
            maxRatio,
          );
          break;
        }

        case "claude": {
          const anthropicKey = process.env["ANTHROPIC_API_KEY"] ?? "";
          if (!anthropicKey) return this.fallback.compress(text, maxRatio);
          summary = await compressViaClaude(this.config.model, anthropicKey, text, maxRatio);
          break;
        }
      }
    } catch {
      return this.fallback.compress(text, maxRatio);
    }

    if (!summary) return this.fallback.compress(text, maxRatio);

    return {
      compressed: summary,
      originalChars: text.length,
      compressedChars: summary.length,
      ratio: text.length / Math.max(summary.length, 1),
      tier: "tier4",
    };
  }

  /**
   * Generate embeddings.
   * Ollama: uses native /api/embeddings endpoint.
   * All other providers: delegates to Tier2Compressor (MiniLM-L6-v2).
   *
   * @param texts - Strings to embed.
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    if (this.config.provider === "ollama") {
      try {
        return await embedViaOllama(this.config, texts);
      } catch {
        // Fall through to tier2
      }
    }
    return this.embedder.embed(texts);
  }
}
