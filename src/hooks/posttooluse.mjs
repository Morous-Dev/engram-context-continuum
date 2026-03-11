#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * posttooluse.mjs — PostToolUse hook for super-context session continuity.
 *
 * Responsible for: capturing session events from tool calls (13+ categories)
 * and storing them in the per-project SessionDB for later resume snapshot
 * building. Must be fast (<20ms) — no network, no LLM, just SQLite writes.
 *
 * Depends on: suppress-stderr.mjs, session-helpers.mjs,
 *             build/session/extract.js, build/session/db.js (compiled TypeScript).
 * Depended on by: Claude Code PostToolUse hook system.
 */

import { readStdin, getSessionId, getSessionDBPath } from "./session-helpers.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve absolute paths — relative dynamic imports fail when Claude Code
// invokes hooks from a different working directory.
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HOOK_DIR, "..", "..");
const BUILD_SESSION = join(PROJECT_ROOT, "build", "session");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { extractEvents } = await import(pathToFileURL(join(BUILD_SESSION, "extract.js")).href);
  const { SessionDB } = await import(pathToFileURL(join(BUILD_SESSION, "db.js")).href);

  const dbPath = getSessionDBPath();
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input);

  db.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());

  const events = extractEvents({
    tool_name: input.tool_name,
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_response === "string"
      ? input.tool_response
      : JSON.stringify(input.tool_response ?? ""),
    tool_output: input.tool_output,
  });

  for (const event of events) {
    db.insertEvent(sessionId, event, "PostToolUse");
  }

  db.close();
} catch {
  // PostToolUse must never block the session — silent fallback
}

// PostToolUse hooks don't need hookSpecificOutput
