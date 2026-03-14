#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEBUG_LOG = join(process.env.ENGRAM_PROJECT_DIR ?? process.cwd(), ".engram-cc", "logs", "codex-hook-debug.log");

try {
  mkdirSync(dirname(DEBUG_LOG), { recursive: true });
  appendFileSync(
    DEBUG_LOG,
    `[${new Date().toISOString()}] session_start cwd=${process.cwd()}\n`,
    "utf-8",
  );
} catch {
  // Best-effort logging only.
}

const hookPath = join(dirname(fileURLToPath(import.meta.url)), "sessionstart.mjs");
await import(pathToFileURL(hookPath).href);
