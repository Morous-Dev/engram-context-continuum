/**
 * index.ts — Compression factory: reads plugin-config.yaml and returns the
 * appropriate Compressor instance for the current machine and configuration.
 *
 * Responsible for: reading the compression config from plugin-config.yaml,
 * running system detection when tier is "auto", instantiating the matching
 * Compressor, and falling back to lower tiers if the requested one is
 * unavailable. The resulting compressor is cached as a module-level singleton.
 *
 * Fallback chain: tier3c → tier3b → tier3a → tier2 → tier1
 * Higher tiers always fall back to lower ones on availability failure, so
 * the caller always receives a working Compressor regardless of environment.
 *
 * Depends on: src/compression/types.ts, src/compression/detect.ts,
 *             src/compression/tier1-4.ts, js-yaml, node:fs, node:path.
 * Depended on by: src/hooks/stop.ts.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { Compressor, CompressionConfig, CompressionTier } from "./types.js";
import { detectSystemTier } from "./detect.js";
import { Tier1Compressor } from "./tier1.js";
import { Tier2Compressor } from "./tier2.js";
import { Tier3Compressor } from "./tier3.js";
import { Tier3bCompressor } from "./tier3b.js";
import { Tier4Compressor } from "./tier4.js";

// ── Config reader ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CompressionConfig = {
  tier: "auto",
  external: {
    provider: "ollama",
    model: "phi4-mini",
    base_url: "http://localhost:11434",
  },
};

/**
 * Read the compression section from plugin-config.yaml.
 * Returns DEFAULT_CONFIG on any parse failure.
 *
 * @returns Parsed CompressionConfig.
 */
function readCompressionConfig(): CompressionConfig {
  try {
    // Walk up from this file to find plugin-config.yaml at the project root
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const configPath = join(thisDir, "..", "..", "plugin-config.yaml");
    if (!existsSync(configPath)) return DEFAULT_CONFIG;

    const raw = yaml.load(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const comp = raw?.["compression"] as Partial<CompressionConfig> | undefined;
    if (!comp) return DEFAULT_CONFIG;

    return {
      tier: (comp.tier as CompressionTier | "auto") ?? "auto",
      external: {
        provider: comp.external?.provider ?? DEFAULT_CONFIG.external.provider,
        model: comp.external?.model ?? DEFAULT_CONFIG.external.model,
        base_url: comp.external?.base_url ?? DEFAULT_CONFIG.external.base_url,
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ── Tier instantiation ─────────────────────────────────────────────────────────

/**
 * Create a Compressor for the given tier.
 * Does not check availability — the caller does that.
 *
 * @param tier   - Target tier.
 * @param config - Full compression config (for Tier 4 external settings).
 * @returns The corresponding Compressor instance.
 */
function instantiateTier(tier: CompressionTier, config: CompressionConfig): Compressor {
  switch (tier) {
    case "tier4":   return new Tier4Compressor(config.external);
    case "tier3":   return new Tier3Compressor();
    case "tier3b":  return new Tier3bCompressor();
    case "tier2":   return new Tier2Compressor();
    case "tier1":
    default:        return new Tier1Compressor();
  }
}

/**
 * Ordered fallback chain — highest capability first.
 *
 * tier3  = Llama 3.2 3B Q5_K_M (~2.32 GB) — primary GGUF, scored 3/3
 * tier3b = Qwen 3.5 2B Q5_K_M  (~1.44 GB) — lightweight GGUF, scored 3/3,
 *          auto-falls back to CPU when GPU VRAM is insufficient
 * tier2  = ONNX embeddings (rule-based compress, no synthesis)
 * tier1  = rule-based only (always available)
 */
const FALLBACK_CHAIN: CompressionTier[] = [
  "tier3", "tier3b", "tier2", "tier1",
];

// ── Singleton ──────────────────────────────────────────────────────────────────

let _instance: Compressor | null = null;

/**
 * Get the singleton Compressor for this process.
 *
 * On first call: reads plugin-config.yaml, resolves the tier (or runs
 * auto-detection), instantiates the compressor. Subsequent calls return
 * the cached instance.
 *
 * Fallback logic for tier3x/tier2:
 *   If the requested tier is unavailable (missing model file or npm package),
 *   walk down the fallback chain until a tier is available. Tier 1 is always
 *   the final fallback — it never fails.
 *
 * Tier 4 is always treated as available (network failures are per-call).
 *
 * @returns A ready-to-use Compressor instance.
 */
export function getCompressor(): Compressor {
  if (_instance) return _instance;

  const config = readCompressionConfig();

  // Resolve "auto" to detected tier
  const requestedTier: CompressionTier =
    config.tier === "auto" ? detectSystemTier() : config.tier;

  console.error(`[EngramCC] compression config: tier=${config.tier}, detected=${requestedTier}`);

  // Tier 4 is always returned without availability check
  if (requestedTier === "tier4") {
    _instance = new Tier4Compressor(config.external);
    console.error(`[EngramCC] compressor: tier4 (${config.external.provider})`);
    return _instance;
  }

  // For tier3x/tier2: try from requested tier down, find first available
  const startIndex = FALLBACK_CHAIN.indexOf(requestedTier);
  const chain = startIndex >= 0 ? FALLBACK_CHAIN.slice(startIndex) : FALLBACK_CHAIN;

  for (const candidateTier of chain) {
    const candidate = instantiateTier(candidateTier, config);
    if (candidate.isAvailable()) {
      _instance = candidate;
      console.error(`[EngramCC] compressor: ${candidateTier} (available)`);
      return _instance;
    }
    console.error(`[EngramCC] compressor: ${candidateTier} skipped (not available)`);
  }

  // Tier 1 is always available — this is unreachable but satisfies the type checker
  _instance = new Tier1Compressor();
  console.error(`[EngramCC] compressor: tier1 (final fallback)`);
  return _instance;
}

// ── Re-exports for convenience ─────────────────────────────────────────────────

export type { Compressor, CompressionResult, EmbedResult, CompressionTier } from "./types.js";
