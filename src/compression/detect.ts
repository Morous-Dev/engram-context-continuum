/**
 * detect.ts — System hardware detection for automatic compression tier selection.
 *
 * Responsible for: reading available RAM via os.totalmem() and VRAM via
 * nvidia-smi, then mapping those values to the recommended CompressionTier.
 * Mirrors the logic in install.ps1 and install.sh so the runtime selection
 * matches what the install script recommended.
 *
 * Depends on: node:os, node:child_process.
 * Depended on by: src/compression/index.ts (when tier = "auto").
 */

import { totalmem } from "node:os";
import type { CompressionTier } from "./types.js";

/**
 * Detect the recommended compression tier for this machine based on RAM.
 *
 * Tier selection rules:
 *   RAM ≥ 4 GB → tier3 (Llama 3.2 3B Q5_K_M, ~2.32 GB model, needs ~4 GB free)
 *   RAM ≥ 2 GB → tier2 (ONNX embeddings, ~23 MB model)
 *   RAM < 2 GB → tier1 (rule-based only)
 *
 * Note: This returns the tier the machine CAN support. Whether the required
 * model file / npm package is actually installed is checked by each tier's
 * isAvailable() method.
 *
 * @returns The CompressionTier best suited to this machine's hardware.
 */
export function detectSystemTier(): CompressionTier {
  const ramGB = Math.floor(totalmem() / 1_073_741_824);

  if (ramGB >= 4) return "tier3";
  if (ramGB >= 2) return "tier2";
  return "tier1";
}
