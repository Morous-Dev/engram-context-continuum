/**
 * download-model.ts — GGUF model downloader for EngramCC.
 *
 * What this file is: downloads the correct GGUF model for the user's machine tier.
 * Responsible for: trying hf CLI first (handles resume + auth), falling back to
 *   Node.js fetch, showing progress, and renaming files to the exact names that
 *   the shared models directory expects for the target project.
 * Depends on: node:fs, node:path, node:child_process, node:stream,
 *   src/compression/types.ts, src/project-id.ts.
 * Depended on by: src/cli/setup.ts.
 */

import { existsSync, createWriteStream, renameSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CompressionTier } from "../compression/types.js";
import { getProjectModelsDir } from "../project-id.js";

export function getModelsDir(projectDir = process.cwd()): string {
  return getProjectModelsDir(projectDir);
}

// ── Model registry ──────────────────────────────────────────────────────────

interface ModelSpec {
  /** Hugging Face repo slug (owner/name). */
  hfRepo: string;
  /** Filename as it exists on HF. */
  hfFile: string;
  /**
   * Exact filename tier3.ts expects in the models dir.
   * Must match MODEL_FILES in src/compression/tier3.ts exactly.
   */
  localFile: string;
  /** Human-readable size estimate shown during install. */
  sizeDesc: string;
}

const MODEL_REGISTRY: Record<string, ModelSpec> = {
  tier3: {
    hfRepo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    hfFile: "Llama-3.2-3B-Instruct-Q5_K_M.gguf",
    localFile: "llama-3.2-3b-instruct-q5_k_m.gguf",
    sizeDesc: "~2.32 GB",
  },
  // tier3b: Qwen3.5 4B Q4_K_M — scored 10/10 on adversarial benchmark.
  // Upgraded from Qwen3.5 2B (9/10) which failed A10 (article noise test).
  // Qwen family: strong multilingual + coding. Has thinking mode (suppressed).
  // Falls back to CPU on genuine VRAM OOM via ignoreMemorySafetyChecks bypass.
  "tier3b": {
    hfRepo: "unsloth/Qwen3.5-4B-GGUF",
    hfFile: "Qwen3.5-4B-Q4_K_M.gguf",
    localFile: "Qwen3.5-4B-Q4_K_M.gguf",
    sizeDesc: "~2.74 GB",
  },
  // tier3c: Gemma 3 4B QAT Q4_0 — candidate for high-quality tier.
  // IFEval 90.2% — highest of any sub-5B model (20pts above threshold).
  // QAT (Quantization-Aware Training) preserves near-bfloat16 quality at 2.37 GB.
  // No thinking mode to suppress. Pending adversarial benchmark validation.
  "tier3c": {
    hfRepo: "bartowski/google_gemma-3-4b-it-qat-GGUF",
    hfFile: "google_gemma-3-4b-it-qat-Q4_0.gguf",
    localFile: "gemma-3-4b-it-qat-q4_0.gguf",
    sizeDesc: "~2.37 GB",
  },
  // query-expander: Gemma 3 1B QAT Q4_0 — lightweight FTS5 query expansion.
  // Not a compression tier — runs independently in PostToolUse to generate
  // semantic search terms (~30-80ms warm). Optional: FTS5 falls back to
  // plain word-splitting if this model is absent.
  "query-expander": {
    hfRepo: "bartowski/google_gemma-3-1b-it-qat-GGUF",
    hfFile: "google_gemma-3-1b-it-qat-Q4_0.gguf",
    localFile: "google_gemma-3-1b-it-qat-Q4_0.gguf",
    sizeDesc: "~689 MB",
  },
  // REJECTED: SmolLM3 3B produces empty outputs with node-llama-cpp LlamaChatSession.
  // Root cause: chat-template incompatibility — the model generates <think>...</think>
  // blocks that get stripped, leaving empty responses. Not usable until node-llama-cpp
  // adds native SmolLM3 template support. Kept here for documentation only.
  "smollm3-3b": {
    hfRepo: "bartowski/HuggingFaceTB_SmolLM3-3B-GGUF",
    hfFile: "HuggingFaceTB_SmolLM3-3B-Q5_K_M.gguf",
    localFile: "smollm3-3b-q5_k_m.gguf",
    sizeDesc: "~2.21 GB",
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function localPath(localFile: string, projectDir = process.cwd()): string {
  return join(getModelsDir(projectDir), localFile);
}

/**
 * Check whether the model file for a given tier already exists on disk.
 *
 * @param tier - The compression tier to check (tier3 / tier3b / tier3c).
 * @returns true if the model file is present and non-empty.
 */
export function isModelDownloaded(tier: string, projectDir = process.cwd()): boolean {
  const spec = MODEL_REGISTRY[tier];
  if (!spec) return false;
  const p = localPath(spec.localFile, projectDir);
  return existsSync(p) && statSync(p).size > 0;
}

/**
 * Return the ModelSpec for a tier, or null if the tier needs no GGUF.
 * Tiers 1, 2, and 4 return null — they have no local model file.
 *
 * @param tier - The compression tier.
 */
export function getModelSpec(tier: string): ModelSpec | null {
  return MODEL_REGISTRY[tier] ?? null;
}

// ── Strategy 1: hf CLI ──────────────────────────────────────────────────────

/**
 * Attempt download via the `hf` or `huggingface-cli` Python CLI.
 * Preferred over fetch because it handles resume, auth, and retries natively.
 * Sets PYTHONUTF8=1 + PYTHONIOENCODING=utf-8 to prevent cp1252 crashes on Windows.
 *
 * @param spec - The model to download.
 * @returns true if the expected local file is present after the attempt.
 */
function tryHfCli(spec: ModelSpec, projectDir = process.cwd()): boolean {
  const bins = ["hf", "huggingface-cli"];
  const utf8Env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  const modelsDir = getModelsDir(projectDir);

  for (const bin of bins) {
    try {
      execFileSync(bin, ["download", spec.hfRepo, spec.hfFile, "--local-dir", modelsDir], {
        env: utf8Env,
        stdio: "inherit",
        timeout: 600_000,
      });
      // HF downloads with the original HF filename — rename to what tier3.ts expects
      const downloaded = join(modelsDir, spec.hfFile);
      const target = localPath(spec.localFile, projectDir);
      if (existsSync(downloaded) && downloaded !== target) renameSync(downloaded, target);
      return existsSync(target) && statSync(target).size > 0;
    } catch {
      // Binary not found or download failed — try next
    }
  }
  return false;
}

// ── Strategy 2: Node.js fetch with progress ─────────────────────────────────

/**
 * Download a GGUF model via Node.js fetch (requires Node 18+).
 * Writes to a .incomplete temp file and renames atomically on success,
 * so a partial download never leaves a corrupt file at the final path.
 * Shows percentage progress every 2% when Content-Length is known.
 *
 * @param spec - The model to download.
 * @returns true if the file was fully downloaded and placed at localFile.
 * @throws on HTTP error or stream failure — caller handles.
 */
async function fetchDownload(spec: ModelSpec, projectDir = process.cwd()): Promise<boolean> {
  const url =
    `https://huggingface.co/${spec.hfRepo}/resolve/main/${encodeURIComponent(spec.hfFile)}`;
  const tmpPath = localPath(spec.localFile, projectDir) + ".incomplete";
  const finalPath = localPath(spec.localFile, projectDir);

  console.log(`    URL: ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const total = parseInt(res.headers.get("content-length") ?? "0", 10);
  let received = 0;
  let lastPct = -1;

  const fileStream = createWriteStream(tmpPath);

  // Convert Web ReadableStream → Node.js Readable for pipeline compatibility
  const nodeReadable = Readable.fromWeb(
    res.body as Parameters<typeof Readable.fromWeb>[0],
  );

  nodeReadable.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct && pct % 2 === 0) {
        const gb = (received / 1_073_741_824).toFixed(2);
        const totalGb = (total / 1_073_741_824).toFixed(2);
        process.stdout.write(
          `\r    Progress: ${String(pct).padStart(3)}%  (${gb} / ${totalGb} GB)   `,
        );
        lastPct = pct;
      }
    }
  });

  await pipeline(nodeReadable, fileStream);
  process.stdout.write("\n");

  renameSync(tmpPath, finalPath);
  return existsSync(finalPath) && statSync(finalPath).size > 0;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Download the GGUF model for the given compression tier.
 * Skips silently if the model is already present.
 * Tries hf CLI first; falls back to Node.js fetch.
 *
 * @param tier - The compression tier whose model to download.
 * @returns true if the model is present after this call (downloaded or pre-existing).
 *          Returns false on download failure — never throws.
 */
export async function downloadModel(tier: CompressionTier, projectDir = process.cwd()): Promise<boolean> {
  const spec = MODEL_REGISTRY[tier];
  if (!spec) {
    // Tiers 1, 2, 4 — no local GGUF needed
    return true;
  }

  mkdirSync(getModelsDir(projectDir), { recursive: true });

  if (isModelDownloaded(tier, projectDir)) {
    const bytes = statSync(localPath(spec.localFile, projectDir)).size;
    console.log(
      `  [OK] Already present: ${spec.localFile} (${(bytes / 1_073_741_824).toFixed(2)} GB)`,
    );
    return true;
  }

  console.log(`  Downloading ${spec.localFile} (${spec.sizeDesc})...`);

  // Strategy 1: hf CLI (resume support, auth, native progress)
  if (tryHfCli(spec, projectDir)) {
    console.log(`  [OK] ${spec.localFile}`);
    return true;
  }

  // Strategy 2: Node.js fetch fallback
  try {
    const ok = await fetchDownload(spec, projectDir);
    if (ok) {
      console.log(`  [OK] ${spec.localFile}`);
      return true;
    }
    console.error(`  [!] Download completed but file missing — check disk space.`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [X] Download failed: ${msg}`);
    console.error(`  Manual fallback: https://huggingface.co/${spec.hfRepo}`);
    console.error(`  Save as: ${localPath(spec.localFile, projectDir)}`);
    return false;
  }
}
