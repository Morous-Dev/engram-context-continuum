import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * Capture assistant-specific startup-only context that generic hooks cannot see.
 * Today this is limited to Claude's CLAUDE.md system prompt files.
 *
 * @param {{
 *   assistant: string,
 *   projectDir: string,
 *   sessionId: string,
 *   db: { insertEvent(sessionId: string, event: object, source: string, provenance: object): void },
 * }} params
 * @returns {number} Number of events inserted.
 */
export function captureAssistantStartupContext({ assistant, projectDir, sessionId, db }) {
  const normalizedAssistant = assistant.trim().toLowerCase();
  const isClaudeRuntime =
    normalizedAssistant === "claude-code"
    || normalizedAssistant === "claude"
    || (
      (!normalizedAssistant || normalizedAssistant === "unknown")
      && (!!process.env.CLAUDE_PROJECT_DIR || !!process.env.CLAUDE_SESSION_ID)
    );
  if (!isClaudeRuntime) return 0;

  let inserted = 0;
  const claudeMdPaths = [
    join(projectDir, "CLAUDE.md"),
    join(projectDir, ".claude", "CLAUDE.md"),
  ];

  for (const filePath of claudeMdPaths) {
    try {
      const content = readFileSync(filePath, "utf-8");
      if (!content.trim()) continue;

      db.insertEvent(sessionId, { type: "rule", category: "rule", data: filePath, priority: 1 }, "SessionStart", {
        sourceAssistant: assistant,
        sourceKind: "native_hook",
        sourceConfidence: "exact",
      });
      db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 }, "SessionStart", {
        sourceAssistant: assistant,
        sourceKind: "native_hook",
        sourceConfidence: "exact",
      });
      inserted += 2;
    } catch {
      // File does not exist or is unreadable — ignore.
    }
  }

  return inserted;
}
