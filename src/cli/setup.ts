/**
 * setup.ts — CLI installer entry point for EngramCC.
 *
 * What this file is: cross-platform interactive installer, run as
 *   `npx engram-cc` or `engramcc` after global install.
 * Responsible for: detecting hardware, selecting the right compression tier,
 *   creating project-local .engram-cc/ directories, configuring a shared models
 *   directory, generating assistant setup snippets, and downloading the GGUF model.
 * Depends on: node:os, node:fs, node:path, node:child_process, node:readline,
 *   src/cli/download-model.ts, src/compression/types.ts, src/adapters/index.ts,
 *   src/project-id.ts.
 * Depended on by: nothing — this is the CLI entry point (bin: "engramcc").
 *
 * Flags:
 *   --yes           skip all prompts, accept defaults
 *   --no-model      skip GGUF download (hooks + dirs still registered)
 *   --tier=<id>     force a specific tier (tier1|tier2|tier3|tier3b|tier3c|tier4)
 *   --project-dir   target project directory for all ECC state (default: cwd)
 *   --models-dir    shared models directory (required in non-interactive mode)
 */

import { totalmem } from "node:os";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { downloadModel, isModelDownloaded, getModelSpec } from "./download-model.js";
import { registerAll } from "../adapters/index.js";
import type { CompressionTier } from "../compression/types.js";
import { getProjectDataDir, readProjectConfig, writeProjectConfig } from "../project-id.js";

// ── Constants ────────────────────────────────────────────────────────────────

const VERSION = "0.1.0";

// Resolve the package root from the compiled file location.
// build/cli/setup.js → go up two levels to get the package root.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..", "..");

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
 * Create the required data directories under <projectDir>/.engram-cc/.
 * Each subdirectory has a specific purpose:
 *   sessions/ — per-project SQLite databases
 *   logs/     — hook and debug logs
 *   assistant-configs/ — local setup snippets for supported assistants
 * Shared models live outside the project data dir and are configured separately.
 */
function createDirectories(dataDir: string): void {
  for (const sub of ["sessions", "logs", "assistant-configs"]) {
    const path = join(dataDir, sub);
    mkdirSync(path, { recursive: true });
    console.log(`  [OK] ${path}`);
  }
}

function ensureDirectory(path: string, label: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
    throw new Error(`${label} is not a folder: ${resolved}`);
  }
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

// ── Adapter registration ──────────────────────────────────────────────────────

/**
 * Run registerAll() across all supported AI coding assistants.
 * Prints a per-assistant, per-operation summary to stdout. No user-profile
 * config is modified; setup artifacts are written into the current repo.
 * Never throws — all errors are captured and printed as warnings.
 *
 * @param packageRoot - Absolute path to the installed EngramCC package root.
 * @param projectRoot - Absolute path to the target project directory.
 */
function registerAdapters(packageRoot: string, projectRoot: string): void {
  const results = registerAll(packageRoot, projectRoot);
  for (const r of results) {
    console.log(`  [>] ${r.adapter}`);
    console.log(`      detected=${r.installed ? "yes" : "no"} local_only=yes`);
    console.log(
      `      capabilities start=${r.capabilities.session_start} prompt=${r.capabilities.user_prompt_submit} post=${r.capabilities.post_tool_use} compact=${r.capabilities.pre_compact} stop=${r.capabilities.stop}`,
    );
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

function getFlagValue(args: string[], flag: string): string | undefined {
  const prefixed = `${flag}=`;
  const inline = args.find(arg => arg.startsWith(prefixed));
  if (inline) return inline.slice(prefixed.length);

  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function resolveProjectRoot(args: string[]): string {
  const requested = getFlagValue(args, "--project-dir");
  const projectRoot = resolve(requested ?? process.cwd());

  if (!existsSync(projectRoot)) {
    throw new Error(`Project directory does not exist: ${projectRoot}`);
  }
  if (!statSync(projectRoot).isDirectory()) {
    throw new Error(`Project directory is not a folder: ${projectRoot}`);
  }

  return projectRoot;
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

async function promptText(question: string, defaultValue?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    if (defaultValue) return defaultValue;
    throw new Error(`Missing interactive input for: ${question}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [default: ${defaultValue}] ` : " ";
    const answer = await rl.question(`${question}${suffix}`);
    return answer.trim() || defaultValue || "";
  } finally {
    rl.close();
  }
}

function recommendModelsDir(projectRoot: string): string {
  if (process.platform === "win32") {
    const driveRoot = parse(projectRoot).root || "C:\\";
    return join(driveRoot, "Engram Context Continuum", "models");
  }
  return join(dirname(projectRoot), "Engram Context Continuum", "models");
}

async function resolveModelsDir(args: string[], projectRoot: string, skipPrompts: boolean): Promise<string> {
  const configured = readProjectConfig(projectRoot).sharedModelsDir;
  const requested = getFlagValue(args, "--models-dir");

  if (requested) {
    return ensureDirectory(requested, "Shared models directory");
  }
  if (configured) {
    return ensureDirectory(configured, "Shared models directory");
  }
  if (skipPrompts || !process.stdin.isTTY) {
    throw new Error("Shared models directory is required in non-interactive mode. Use --models-dir <path>.");
  }

  const recommended = recommendModelsDir(projectRoot);
  console.log("  EngramCC requires a shared models directory.");
  console.log("  This folder is reused across projects and may consume several GB.");
  console.log(`  Recommended: ${recommended}`);
  const answer = await promptText("  Enter shared models directory:", recommended);
  if (!answer.trim()) {
    throw new Error("Shared models directory is required.");
  }

  return ensureDirectory(answer, "Shared models directory");
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
  const projectRoot = resolveProjectRoot(args);
  const dataDir = getProjectDataDir(projectRoot);
  const modelsDir = await resolveModelsDir(args, projectRoot, skipPrompts);
  writeProjectConfig(projectRoot, { ...readProjectConfig(projectRoot), sharedModelsDir: modelsDir });

  console.log("");
  console.log("===================================================");
  console.log(`  EngramCC  v${VERSION}  —  Engram Context Continuum`);
  console.log("  Universal AI memory: session handoff + context bank");
  console.log("===================================================");
  console.log("");
  console.log(`  Project: ${projectRoot}`);
  console.log(`  Shared models: ${modelsDir}`);
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
  createDirectories(dataDir);
  console.log(`  [OK] ${modelsDir}`);
  console.log("");

  // Step 3: Generate local-only hook + MCP snippets
  console.log("[3/4] Generating local assistant setup snippets...");
  registerAdapters(PACKAGE_ROOT, projectRoot);
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
      console.log(`    Place in: ${modelsDir} as ${spec.localFile}`);
    }
  } else {
    const alreadyHave = isModelDownloaded(effective.tier, projectRoot);
    let doDownload = !alreadyHave;

    if (!alreadyHave && !skipPrompts) {
      const spec = getModelSpec(effective.tier);
      doDownload = await confirm(
        `  Download model (${spec?.sizeDesc ?? "large file"})? This may take a while.`,
      );
    }

    if (doDownload) {
      const ok = await downloadModel(effective.tier, projectRoot);
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
  console.log(`  Verify: check ${join(dataDir, "sessions")}`);
  console.log(`          and ${join(dataDir, "assistant-configs")}.`);
  console.log(`  Models: ${modelsDir}`);
  console.log("===================================================");
  console.log("");
}

main().catch(err => {
  console.error("[X] Setup failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
