/**
 * codex-plug.ts — Codex-specific policy helpers.
 *
 * Codex exact prompt/tool capture now comes from the transcript bridge in
 * `src/adapters/codex-transcript.ts`. This module keeps only the shared policy
 * that the Codex hooks still need: when to synthesize a pre-compact snapshot.
 */

const COMPACTION_TOOLS = new Set(["Edit", "Write", "Bash", "AskUserQuestion"]);

export function shouldCodexTriggerCompaction(
  toolName: string,
  eventCount: number,
  compactCount: number,
): boolean {
  if (!COMPACTION_TOOLS.has(toolName)) return false;
  const threshold = 900 + (compactCount * 150);
  return eventCount >= threshold;
}
