/**
 * detect.ts — System hardware detection for automatic compression tier selection.
 *
 * Responsible for: reading available RAM via os.totalmem(), VRAM via nvidia-smi
 * (Windows/Linux) or unified memory proxy (Apple Silicon), and mapping those
 * values to the recommended CompressionTier and HardwareProfile.
 *
 * Hardware profiles drive pipeline behavior (e.g. parallel PreCompact) while
 * compression tiers drive model selection. They are independent — a machine
 * can be "power" profile while running tier3 if the model file is available.
 *
 * Profile thresholds:
 *   power:   VRAM ≥ 12 GB, or Apple Silicon with ≥ 16 GB unified RAM
 *   standard: VRAM 4–11 GB, or x86 system RAM ≥ 16 GB (no discrete GPU)
 *   minimal: everything else (integrated graphics, low RAM, no GPU detected)
 *
 * Depends on: node:os, node:child_process.
 * Depended on by: src/compression/index.ts (when tier = "auto").
 */

import { totalmem } from "node:os";
import { spawnSync } from "node:child_process";
import type { CompressionTier } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Hardware profile: capability tier based on GPU VRAM or unified memory.
 *
 * minimal  — no discrete GPU or VRAM < 4 GB. Single-model sequential pipeline.
 * standard — VRAM 4–11 GB or high-RAM machine. Sequential pipeline, GPU-assisted.
 * power    — VRAM ≥ 12 GB or Apple Silicon ≥ 16 GB. Parallel pipeline unlocked.
 */
export type HardwareProfile = "minimal" | "standard" | "power";

// ── VRAM detection ────────────────────────────────────────────────────────────

/** Cached VRAM result — avoids spawning nvidia-smi / rocm-smi multiple times. */
let _cachedVramGB: number | null = null;

/**
 * Detect available GPU VRAM in gigabytes.
 *
 * Result is cached after first call — subprocess is spawned at most once per
 * process lifetime. This is critical because detectVramGB() is called from
 * both detectSystemTier() and detectHardwareProfile(), and spawnSync blocks
 * the event loop for up to 500ms per call.
 *
 * Strategy by platform:
 *   macOS arm64:   Apple Silicon unified memory — return total RAM as proxy.
 *   Windows:       Try nvidia-smi (NVIDIA), then wmic (vendor-agnostic fallback
 *                  covering AMD Radeon and Intel Arc).
 *   Linux:         Try nvidia-smi (NVIDIA), then rocm-smi (AMD ROCm).
 *   All:           return 0 on any failure (no GPU, driver not installed, etc.).
 *
 * Uses spawnSync with a 500ms timeout — nvidia-smi typically returns in <100ms,
 * and 500ms is generous enough for slow driver starts without blocking the hook
 * pipeline for seconds.
 *
 * @returns VRAM in GB, or 0 if no GPU is detectable.
 */
export function detectVramGB(): number {
  if (_cachedVramGB !== null) return _cachedVramGB;

  _cachedVramGB = detectVramGBUncached();
  return _cachedVramGB;
}

/** Spawn timeout for GPU CLI tools (ms). nvidia-smi returns in <100ms normally. */
const GPU_DETECT_TIMEOUT_MS = 500;

/**
 * Internal uncached VRAM detection. Called once, result stored in _cachedVramGB.
 */
function detectVramGBUncached(): number {
  try {
    // Apple Silicon: unified memory — GPU and CPU share the same pool.
    // Treat total RAM as effective VRAM for profile classification.
    if (process.platform === "darwin" && process.arch === "arm64") {
      return Math.floor(totalmem() / 1_073_741_824);
    }

    // ── NVIDIA GPU via nvidia-smi (Windows and Linux) ──
    const nvidiaResult = trySpawn(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
    );
    if (nvidiaResult) {
      // Output is one line per GPU (MiB). Take the first (largest) GPU.
      const firstLine = nvidiaResult.trim().split("\n")[0] ?? "";
      const mib = parseInt(firstLine.trim(), 10);
      if (!isNaN(mib) && mib > 0) {
        return Math.floor(mib / 1024); // MiB → GB
      }
    }

    // ── AMD GPU via rocm-smi (Linux ROCm) ──
    if (process.platform === "linux") {
      const rocmResult = trySpawn("rocm-smi", ["--showmeminfo", "vram", "--json"]);
      if (rocmResult) {
        const parsed = JSON.parse(rocmResult) as Record<string, Record<string, Record<string, string>>>;
        // rocm-smi JSON: { "card0": { "VRAM Total Memory (B)": "..." } }
        for (const card of Object.values(parsed)) {
          for (const [key, val] of Object.entries(card)) {
            if (/vram total/i.test(key)) {
              const bytes = parseInt(String(val), 10);
              if (!isNaN(bytes) && bytes > 0) {
                return Math.floor(bytes / 1_073_741_824); // bytes → GB
              }
            }
          }
        }
      }
    }

    // ── Windows vendor-agnostic fallback via wmic ──
    // Covers AMD Radeon, Intel Arc, and any other GPU not reached by nvidia-smi.
    if (process.platform === "win32") {
      const wmicResult = trySpawn("wmic", ["path", "win32_VideoController", "get", "AdapterRAM"]);
      if (wmicResult) {
        // wmic output: header line "AdapterRAM", then one value per GPU (bytes).
        // Take the largest value (skip header and empty lines).
        let maxBytes = 0;
        for (const line of wmicResult.trim().split("\n")) {
          const bytes = parseInt(line.trim(), 10);
          if (!isNaN(bytes) && bytes > maxBytes) maxBytes = bytes;
        }
        if (maxBytes > 0) {
          return Math.floor(maxBytes / 1_073_741_824); // bytes → GB
        }
      }
    }
  } catch {
    // All detection failed — safe to return 0
  }

  return 0;
}

/**
 * Try spawning a command synchronously with timeout. Returns stdout on success, null on failure.
 */
function trySpawn(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf-8",
      timeout: GPU_DETECT_TIMEOUT_MS,
    });
    if (result.status === 0 && result.stdout) return result.stdout;
  } catch {
    // Command not found, timeout, or other error
  }
  return null;
}

// ── Profile detection ─────────────────────────────────────────────────────────

/**
 * Detect the hardware capability profile for this machine.
 *
 * Profile thresholds:
 *   power:    VRAM ≥ 12 GB (RTX 3090/4090, A100, etc.)
 *             OR Apple Silicon with ≥ 16 GB unified RAM
 *   standard: VRAM 4–11 GB (RTX 3060/3070/4060/4070, etc.)
 *             OR x86 machine with ≥ 16 GB RAM and no discrete GPU
 *   minimal:  everything else
 *
 * @returns HardwareProfile for this machine.
 */
export function detectHardwareProfile(): HardwareProfile {
  const ramGB = Math.floor(totalmem() / 1_073_741_824);
  const vramGB = detectVramGB();

  // Apple Silicon: unified memory ≥ 16 GB qualifies as power
  if (process.platform === "darwin" && process.arch === "arm64") {
    if (vramGB >= 16) return "power";
    if (vramGB >= 8)  return "standard";
    return "minimal";
  }

  // Discrete GPU path (NVIDIA detected via nvidia-smi)
  if (vramGB > 0) {
    if (vramGB >= 12) return "power";
    if (vramGB >= 4)  return "standard";
    return "minimal";
  }

  // No discrete GPU — fall back to system RAM as a proxy
  // High-RAM machines (≥ 16 GB) can run large models via CPU inference
  if (ramGB >= 16) return "standard";
  return "minimal";
}

// ── Tier detection ─────────────────────────────────────────────────────────────

/**
 * Detect the recommended compression tier for this machine.
 *
 * Uses VRAM when a GPU is present, falls back to RAM otherwise.
 * The tier controls which model is loaded; the hardware profile controls
 * how the pipeline runs (sequential vs parallel).
 *
 * Tier selection rules:
 *   VRAM ≥ 4 GB OR RAM ≥ 4 GB → tier3 (Llama 3.2 3B, ~2.32 GB)
 *   RAM ≥ 2 GB                 → tier2 (ONNX embeddings, ~23 MB)
 *   RAM < 2 GB                 → tier1 (rule-based only)
 *
 * Note: This returns the tier the machine CAN support. Whether the required
 * model file / npm package is actually installed is checked by each tier's
 * isAvailable() method.
 *
 * @returns The CompressionTier best suited to this machine's hardware.
 */
export function detectSystemTier(): CompressionTier {
  const ramGB  = Math.floor(totalmem() / 1_073_741_824);
  const vramGB = detectVramGB();

  // VRAM present means we can load a GGUF model into GPU memory
  if (vramGB >= 4) return "tier3";

  // CPU-only path — fall back to RAM
  if (ramGB >= 4) return "tier3";
  if (ramGB >= 2) return "tier2";
  return "tier1";
}
