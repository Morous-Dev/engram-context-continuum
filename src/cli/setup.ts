/**
 * setup.ts — CLI installer entry point for EngramCC.
 *
 * What this file is: cross-platform interactive installer, run as
 *   `npx engram-cc` or `engramcc` after global install.
 * Responsible for: detecting hardware, selecting the right compression tier,
 *   creating ~/.engram-cc/ directories, registering hooks and MCP servers
 *   for all detected AI coding assistants, and downloading the GGUF model.
 * Depends on: node:os, node:fs, node:path, node:child_process, node:readline,
 *   src/cli/download-model.ts, src/compression/types.ts, src/adapters/index.ts.
 * Depended on by: nothing — this is the CLI entry point (bin: "engramcc").
 *
 * Flags:
 *   --yes           skip all prompts, accept defaults
 *   --no-model      skip GGUF download (hooks + dirs still registered)
 *   --tier=<id>     force a specific tier (tier1|tier2|tier3|tier3b|tier3c|tier4)
 */

import { totalmem } from "node:os";
import { mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { downloadModel, isModelDownloaded, getModelSpec } from "./download-model.js";
import { registerAll } from "../adapters/index.js";
import type { CompressionTier } from "../compression/types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const VERSION = "0.1.0";

// Resolve the package root from the compiled file location.
// build/cli/setup.js → go up two levels to get the package root.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..", "..");

const DATA_DIR = join(homedir(), ".engram-cc");

// ── Hardware detection ───────────────────────────────────────────────────────

interface HardwareInfo {
  ramGB: number;
  vramGB: number;
  gpuName: string;
}

/**
 * Detect system RAM and NVIDIA VRAM for tier auto-selection.
 * VRAM detection uses nvidia-smi; returns 0 if no NVIDIA GPU is found.
 * Mirrors the logic in src/compression/detect.ts.
 *
 * @returns HardwareInfo with ramGB, vramGB, and gpuName.
 */
function detectHardware(): HardwareInfo {
  const ramGB = Math.floor(totalmem() / 1_073_741_824);
  let vramGB = 0;
  let gpuName = "none";

  const smiBins = [
    "nvidia-smi",
    "C:/Program Files/NVIDIA Corporation/NVSMI/nvidia-smi.exe",
    "C:/Windows/System32/nvidia-smi.exe",
  ];

  for (const bin of smiBins) {
    try {
      const name = execSync(
        `"${bin}" --query-gpu=name --format=csv,noheader`,
        { timeout: 4000, stdio: ["ignore", "pipe", "ignore"] },
      ).toString().trim().split("\n")[0]?.trim() ?? "unknown";

      const mb = parseInt(
        execSync(
          `"${bin}" --query-gpu=memory.total --format=csv,noheader,nounits`,
          { timeout: 4000, stdio: ["ignore", "pipe", "ignore"] },
        ).toString().trim().split("\n")[0] ?? "0",
        10,
      );

      gpuName = name;
      vramGB = Math.floor(mb / 1024);
      break;
    } catch {
      // GPU not found via this path — try next
    }
  }

  return { ramGB, vramGB, gpuName };
}

// ── Tier selection ───────────────────────────────────────────────────────────

interface TierInfo {
  tier: CompressionTier;
  label: string;
  needsModel: boolean;
}

/**
 * Map hardware specs to the recommended compression tier.
 * Mirrors the thresholds in src/compression/detect.ts and install.ps1.
 *
 * @param hw - Hardware info from detectHardware().
 * @returns TierInfo with the recommended tier and a display label.
 */
function selectTier(hw: HardwareInfo): TierInfo {
  if (hw.ramGB >= 4) {
    return {
      tier: "tier3",
      label: "Tier 3 — Llama 3.2 3B Q5_K_M (~2.32 GB, needs ~4 GB free RAM)",
      needsModel: true,
    };
  }
  if (hw.ramGB >= 2) {
    return {
      tier: "tier2",
      label: "Tier 2 — ONNX via @huggingface/transformers (~400 MB npm install)",
      needsModel: false,
    };
  }
  return {
    tier: "tier1",
    label: "Tier 1 — Rule-based only (no LLM, zero download)",
    needsModel: false,
  };
}

// ── Directories ──────────────────────────────────────────────────────────────

/**
 * Create the required data directories under ~/.engram-cc/.
 * Each subdirectory has a specific purpose:
 *   sessions/ — per-project SQLite databases
 *   handoff/  — session handoff YAML files
 *   working/  — working memory YAML files
 *   models/   — GGUF model files for Tier 3 compression
 */
function createDirectories(): void {
  for (const sub of ["sessions", "handoff", "working", "models"]) {
    const path = join(DATA_DIR, sub);
    mkdirSync(path, { recursive: true });
    console.log(`  [OK] ${path}`);
  }
}

// ── Adapter registration ──────────────────────────────────────────────────────

/**
 * Run registerAll() across all detected AI coding assistants.
 * Prints a per-assistant, per-operation summary to stdout.
 * Never throws — all errors are captured and printed as warnings.
 *
 * @param packageRoot - Absolute path to the installed EngramCC package root.
 */
function registerAdapters(packageRoot: string): void {
  const results = registerAll(packageRoot);
  for (const r of results) {
    if (!r.installed) {
      console.log(`  [-] ${r.adapter}: not detected, skipped`);
      continue;
    }
    console.log(`  [>] ${r.adapter}`);
    if (r.hooks) {
      const icon = r.hooks.success ? (r.hooks.skipped ? "~" : "OK") : "X";
      console.log(`      hooks [${icon}] ${r.hooks.message}`);
    }
    if (r.mcp) {
      const icon = r.mcp.success ? (r.mcp.skipped ? "~" : "OK") : "X";
      console.log(`      MCP   [${icon}] ${r.mcp.message}`);
    }
  }
}

// ── Prompt helpers ───────────────────────────────────────────────────────────

/**
 * Ask a Y/n question. Returns defaultYes if stdin is not a TTY.
 * Used to confirm the GGUF download before starting a multi-GB transfer.
 *
 * @param question   - Question text (without the [Y/n] suffix).
 * @param defaultYes - Whether the default is yes when user just hits Enter.
 */
async function confirm(question: string, defaultYes = true): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [${defaultYes ? "Y/n" : "y/N"}] `);
    const t = answer.trim().toLowerCase();
    return !t ? defaultYes : t === "y" || t === "yes";
  } finally {
    rl.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Entry point. Orchestrates the full install sequence:
 *   1. Detect hardware + select tier
 *   2. Create data directories
 *   3. Register Claude Code hooks
 *   4. Download GGUF model (with confirmation prompt unless --yes)
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipPrompts = args.includes("--yes") || !process.stdin.isTTY;
  const skipModel   = args.includes("--no-model");
  const tierOverride = args.find(a => a.startsWith("--tier="))?.split("=")[1] as CompressionTier | undefined;

  console.log("");
  console.log("===================================================");
  console.log(`  EngramCC  v${VERSION}  —  Engram Context Continuum`);
  console.log("  Universal AI memory: session handoff + context bank");
  console.log("===================================================");
  console.log("");

  // Step 1: Hardware
  console.log("[1/4] Detecting hardware...");
  const hw = detectHardware();
  console.log(`  RAM:  ${hw.ramGB} GB`);
  if (hw.vramGB > 0) console.log(`  GPU:  ${hw.gpuName}  (${hw.vramGB} GB VRAM)`);
  else               console.log(`  GPU:  none / not detected`);

  const autoTier = selectTier(hw);
  const effective: TierInfo = tierOverride
    ? { tier: tierOverride, label: `(forced) ${tierOverride}`, needsModel: tierOverride.startsWith("tier3") }
    : autoTier;

  console.log(`  Tier: ${effective.label}`);
  console.log("");

  // Step 2: Directories
  console.log("[2/4] Creating data directories...");
  createDirectories();
  console.log("");

  // Step 3: Register hooks + MCP for all detected assistants
  console.log("[3/4] Registering hooks and MCP servers...");
  registerAdapters(PACKAGE_ROOT);
  console.log("");

  // Step 4: Model
  console.log("[4/4] GGUF model...");

  if (!effective.needsModel) {
    console.log(`  No model file needed for ${effective.tier}.`);
  } else if (skipModel) {
    const spec = getModelSpec(effective.tier);
    console.log(`  Skipped (--no-model). Download later with:`);
    console.log(`    engramcc --tier=${effective.tier}`);
    if (spec) {
      console.log(`    Or manually: hf download ${spec.hfRepo} ${spec.hfFile}`);
      console.log(`    Place in: ${DATA_DIR}/models/ as ${spec.localFile}`);
    }
  } else {
    const alreadyHave = isModelDownloaded(effective.tier);
    let doDownload = !alreadyHave;

    if (!alreadyHave && !skipPrompts) {
      const spec = getModelSpec(effective.tier);
      doDownload = await confirm(
        `  Download model (${spec?.sizeDesc ?? "large file"})? This may take a while.`,
      );
    }

    if (doDownload) {
      const ok = await downloadModel(effective.tier);
      if (!ok) process.exitCode = 1;
    } else if (alreadyHave) {
      console.log(`  [OK] Model already present.`);
    } else {
      console.log(`  Skipped by user. Run setup again to download later.`);
    }
  }

  console.log("");
  console.log("===================================================");
  console.log("  Done! Start a new AI coding session to activate.");
  console.log("  Verify: check ~/.engram-cc/sessions/");
  console.log("          after your first session ends.");
  console.log("===================================================");
  console.log("");
}

main().catch(err => {
  console.error("[X] Setup failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
