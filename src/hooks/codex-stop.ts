/**
 * codex-stop.ts — Codex-specific wrapper for the shared Stop hook.
 *
 * Logs Codex stop-hook firing to a dedicated debug file, then delegates to the
 * shared stop pipeline unchanged. This lets us verify whether Codex actually
 * invokes Stop on the current installation without modifying shared behavior.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEBUG_LOG = join(process.cwd(), ".engram-cc", "logs", "codex-hook-debug.log");

try {
  mkdirSync(dirname(DEBUG_LOG), { recursive: true });
  appendFileSync(
    DEBUG_LOG,
    `[${new Date().toISOString()}] stop cwd=${process.cwd()}\n`,
    "utf-8",
  );
} catch {
  // Best-effort logging only.
}

const hookPath = join(dirname(fileURLToPath(import.meta.url)), "stop.js");
await import(pathToFileURL(hookPath).href);
