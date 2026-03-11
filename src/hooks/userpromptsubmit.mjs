#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * userpromptsubmit.mjs — UserPromptSubmit hook for super-context session continuity.
 *
 * Responsible for: capturing every user prompt so the LLM can continue from
 * the exact point where the user left off after compact or session restart.
 * Also extracts decision/role/intent/data signals from user messages.
 *
 * Must be fast (<10ms) — just a single SQLite write.
 *
 * Depends on: suppress-stderr.mjs, session-helpers.mjs,
 *             build/session/db.js, build/session/extract.js (compiled TypeScript).
 * Depended on by: Claude Code UserPromptSubmit hook system.
 */

import { readStdin, getSessionId, getSessionDBPath } from "./session-helpers.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HOOK_DIR, "..", "..");
const BUILD_SESSION = join(PROJECT_ROOT, "build", "session");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const prompt = input.prompt ?? input.message ?? "";
  const trimmed = (prompt || "").trim();

  // Skip system-generated messages — only capture genuine user prompts
  const isSystemMessage = trimmed.startsWith("<task-notification>")
    || trimmed.startsWith("<system-reminder>")
    || trimmed.startsWith("<context_guidance>")
    || trimmed.startsWith("<tool-result>");

  if (trimmed.length > 0 && !isSystemMessage) {
    const { SessionDB } = await import(pathToFileURL(join(BUILD_SESSION, "db.js")).href);
    const { extractUserEvents } = await import(pathToFileURL(join(BUILD_SESSION, "extract.js")).href);

    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);

    db.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());

    // 1. Always save the raw prompt
    db.insertEvent(sessionId, {
      type: "user_prompt",
      category: "prompt",
      data: prompt,
      priority: 1,
    }, "UserPromptSubmit");

    // 2. Extract decision/role/intent/data signals
    const userEvents = extractUserEvents(trimmed);
    for (const ev of userEvents) {
      db.insertEvent(sessionId, ev, "UserPromptSubmit");
    }

    db.close();
  }
} catch {
  // UserPromptSubmit must never block the session — silent fallback
}
