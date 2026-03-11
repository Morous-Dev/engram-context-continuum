/**
 * suppress-stderr.mjs — Redirect fd 2 (stderr) to /dev/null at OS level.
 *
 * Responsible for: suppressing native C++ module stderr output that bypasses
 * Node.js process.stderr. better-sqlite3 writes directly to fd 2 during
 * initialization; Claude Code interprets ANY stderr output as hook failure.
 *
 * Must be the FIRST import in every hook entry point. ESM evaluates imports
 * depth-first in declaration order, ensuring fd 2 is redirected before any
 * native modules are loaded.
 *
 * Cross-platform: os.devNull → /dev/null (Unix) or \\.\NUL (Windows).
 *
 * Depends on: node:fs, node:os.
 * Depended on by: all .mjs hooks as their first import.
 */
import { closeSync, openSync } from "node:fs";
import { devNull } from "node:os";

try {
  closeSync(2);
  openSync(devNull, "w"); // Acquires fd 2 (lowest available after close)
} catch {
  // Fallback: suppress at Node.js stream level
  process.stderr.write = /** @type {any} */ (() => true);
}
