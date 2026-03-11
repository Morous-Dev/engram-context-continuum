/**
 * snapshot.ts — Converts stored SessionEvents into an XML resume snapshot.
 *
 * Responsible for: building a priority-budget-aware XML string from session
 * events that is injected into Claude's context after a compact event. Pure
 * functions only — no database access, no file system, no side effects.
 *
 * Budget allocation:
 *   P1 (file, task, rule):                          50% ≈ 1024 bytes
 *   P2 (cwd, error, decision, env, git, subagent):  35% ≈  716 bytes
 *   P3-P4 (intent, mcp, launched subagents):        15% ≈  308 bytes
 *
 * Depends on: src/truncate.ts (escapeXML, truncateString).
 * Depended on by: src/hooks/precompact.mjs.
 */

import { escapeXML, truncateString } from "../truncate.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
  created_at?: string;
}

export interface BuildSnapshotOpts {
  maxBytes?: number;
  compactCount?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// 4KB budget — increased from 2KB because rule_content events from CLAUDE.md
// files were causing p1 alone to exceed the old 2048 limit, resulting in
// completely empty snapshots after compaction.
const DEFAULT_MAX_BYTES = 4096;
const MAX_ACTIVE_FILES = 10;

// ── Section renderers ─────────────────────────────────────────────────────────

/**
 * Render <active_files> from file events.
 * Deduplicates by path, counts operations, keeps the last 10 files.
 *
 * @param fileEvents - Events from the "file" category.
 * @returns XML string or empty string if no file events.
 */
export function renderActiveFiles(fileEvents: StoredEvent[]): string {
  if (fileEvents.length === 0) return "";

  const fileMap = new Map<string, { ops: Map<string, number>; last: string }>();
  for (const ev of fileEvents) {
    let entry = fileMap.get(ev.data);
    if (!entry) { entry = { ops: new Map(), last: "" }; fileMap.set(ev.data, entry); }
    const op = ev.type === "file_write" ? "write" : ev.type === "file_read" ? "read" : ev.type === "file_edit" ? "edit" : ev.type;
    entry.ops.set(op, (entry.ops.get(op) ?? 0) + 1);
    entry.last = op;
  }

  const limited = Array.from(fileMap.entries()).slice(-MAX_ACTIVE_FILES);
  const lines = ["  <active_files>"];
  for (const [path, { ops, last }] of limited) {
    const opsStr = Array.from(ops.entries()).map(([k, v]) => `${k}:${v}`).join(",");
    lines.push(`    <file path="${escapeXML(path)}" ops="${escapeXML(opsStr)}" last="${escapeXML(last)}" />`);
  }
  lines.push("  </active_files>");
  return lines.join("\n");
}

/**
 * Render <task_state> from task events.
 * Reconstructs task list from create/update events, filters out completed tasks.
 *
 * @param taskEvents - Events from the "task" category.
 * @returns XML string or empty string if no pending tasks.
 */
export function renderTaskState(taskEvents: StoredEvent[]): string {
  if (taskEvents.length === 0) return "";

  const creates: string[] = [];
  const updates: Record<string, string> = {};

  for (const ev of taskEvents) {
    try {
      const parsed = JSON.parse(ev.data) as Record<string, unknown>;
      if (typeof parsed.subject === "string") creates.push(parsed.subject);
      else if (typeof parsed.taskId === "string" && typeof parsed.status === "string")
        updates[parsed.taskId] = parsed.status;
    } catch { /* not JSON */ }
  }

  if (creates.length === 0) return "";

  const DONE = new Set(["completed", "deleted", "failed"]);
  const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));
  const pending = creates.filter((_, i) => !DONE.has(updates[sortedIds[i]] ?? "pending"));

  if (pending.length === 0) return "";

  const lines = ["  <task_state>"];
  for (const task of pending) lines.push(`    - ${escapeXML(truncateString(task, 100))}`);
  lines.push("  </task_state>");
  return lines.join("\n");
}

/**
 * Render <rules> from rule events. Lists unique rule source paths and content summaries.
 *
 * @param ruleEvents - Events from the "rule" category.
 * @returns XML string or empty string if no rule events.
 */
export function renderRules(ruleEvents: StoredEvent[]): string {
  if (ruleEvents.length === 0) return "";

  const seen = new Set<string>();
  const lines = ["  <rules>"];

  for (const ev of ruleEvents) {
    if (seen.has(ev.data)) continue;
    seen.add(ev.data);
    // rule_content events are filtered out before this function is called
    // (in buildResumeSnapshot) — only rule path references reach here.
    lines.push(`    - ${escapeXML(truncateString(ev.data, 200))}`);
  }

  lines.push("  </rules>");
  return lines.join("\n");
}

/**
 * Render <decisions> from decision events.
 *
 * @param decisionEvents - Events from the "decision" category.
 * @returns XML string or empty string if no decision events.
 */
export function renderDecisions(decisionEvents: StoredEvent[]): string {
  if (decisionEvents.length === 0) return "";

  const seen = new Set<string>();
  const lines = ["  <decisions>"];
  for (const ev of decisionEvents) {
    if (seen.has(ev.data)) continue;
    seen.add(ev.data);
    lines.push(`    - ${escapeXML(truncateString(ev.data, 200))}`);
  }
  lines.push("  </decisions>");
  return lines.join("\n");
}

/**
 * Render <environment> from cwd, env, and git events.
 *
 * @param cwdEvent  - Most recent cwd event (or undefined).
 * @param envEvents - All env events.
 * @param gitEvent  - Most recent git event (or undefined).
 * @returns XML string or empty string if no environment events.
 */
export function renderEnvironment(
  cwdEvent: StoredEvent | undefined,
  envEvents: StoredEvent[],
  gitEvent: StoredEvent | undefined,
): string {
  if (!cwdEvent && envEvents.length === 0 && !gitEvent) return "";

  const parts = ["  <environment>"];
  if (cwdEvent) parts.push(`    <cwd>${escapeXML(cwdEvent.data)}</cwd>`);
  if (gitEvent) parts.push(`    <git op="${escapeXML(gitEvent.data)}" />`);
  for (const env of envEvents) parts.push(`    <env>${escapeXML(truncateString(env.data, 150))}</env>`);
  parts.push("  </environment>");
  return parts.join("\n");
}

/**
 * Render <errors_encountered> from error events.
 *
 * @param errorEvents - Events from the "error" category.
 * @returns XML string or empty string if no error events.
 */
export function renderErrors(errorEvents: StoredEvent[]): string {
  if (errorEvents.length === 0) return "";
  const lines = ["  <errors_encountered>"];
  for (const ev of errorEvents) lines.push(`    - ${escapeXML(truncateString(ev.data, 150))}`);
  lines.push("  </errors_encountered>");
  return lines.join("\n");
}

/** Render <intent> from the most recent intent event. */
export function renderIntent(intentEvent: StoredEvent): string {
  return `  <intent mode="${escapeXML(intentEvent.data)}">${escapeXML(truncateString(intentEvent.data, 100))}</intent>`;
}

/**
 * Render <subagents> from subagent events.
 *
 * @param subagentEvents - Events from the "subagent" category.
 * @returns XML string or empty string if no subagent events.
 */
export function renderSubagents(subagentEvents: StoredEvent[]): string {
  if (subagentEvents.length === 0) return "";
  const lines = ["  <subagents>"];
  for (const ev of subagentEvents) {
    const status = ev.type === "subagent_completed" ? "completed" : ev.type === "subagent_launched" ? "launched" : "unknown";
    lines.push(`    <agent status="${status}">${escapeXML(truncateString(ev.data, 200))}</agent>`);
  }
  lines.push("  </subagents>");
  return lines.join("\n");
}

/**
 * Render <mcp_tools> from MCP tool call events.
 * Deduplicates by tool name and shows usage count.
 *
 * @param mcpEvents - Events from the "mcp" category.
 * @returns XML string or empty string if no MCP events.
 */
export function renderMcpTools(mcpEvents: StoredEvent[]): string {
  if (mcpEvents.length === 0) return "";
  const toolCounts = new Map<string, number>();
  for (const ev of mcpEvents) {
    const tool = ev.data.split(":")[0].trim();
    toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
  }
  const lines = ["  <mcp_tools>"];
  for (const [tool, count] of toolCounts) lines.push(`    <tool name="${escapeXML(tool)}" calls="${count}" />`);
  lines.push("  </mcp_tools>");
  return lines.join("\n");
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Build a resume snapshot XML string from stored session events.
 *
 * Algorithm:
 * 1. Group events by category
 * 2. Render each section
 * 3. Assemble by priority tier with budget trimming
 * 4. If over maxBytes, drop lowest-priority sections first
 *
 * @param events  - Stored session events (all categories).
 * @param opts    - Optional: maxBytes budget, compactCount for metadata.
 * @returns XML resume snapshot string.
 */
export function buildResumeSnapshot(events: StoredEvent[], opts?: BuildSnapshotOpts): string {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const compactCount = opts?.compactCount ?? 1;
  const now = new Date().toISOString();

  // Group by category
  const byCategory: Record<string, StoredEvent[]> = {};
  for (const ev of events) {
    (byCategory[ev.category] ??= []).push(ev);
  }

  const file     = byCategory["file"]     ?? [];
  const task     = byCategory["task"]     ?? [];
  // Exclude rule_content events from the snapshot — CLAUDE.md content is already
  // in the system prompt. Including it here was the primary cause of budget overflow
  // that produced empty snapshots after compaction.
  const rule     = (byCategory["rule"] ?? []).filter(ev => ev.type !== "rule_content");
  const decision = byCategory["decision"] ?? [];
  const cwd      = byCategory["cwd"]      ?? [];
  const error    = byCategory["error"]    ?? [];
  const env      = byCategory["env"]      ?? [];
  const git      = byCategory["git"]      ?? [];
  const subagent = byCategory["subagent"] ?? [];
  const intent   = byCategory["intent"]   ?? [];
  const mcp      = byCategory["mcp"]      ?? [];
  const plan     = byCategory["plan"]     ?? [];

  // P1 (50%)
  const p1: string[] = [];
  const af = renderActiveFiles(file);       if (af) p1.push(af);
  const ts = renderTaskState(task);         if (ts) p1.push(ts);
  const ru = renderRules(rule);             if (ru) p1.push(ru);

  // P2 (35%)
  const p2: string[] = [];
  const de = renderDecisions(decision);     if (de) p2.push(de);
  const en = renderEnvironment(cwd.at(-1), env, git.at(-1)); if (en) p2.push(en);
  const er = renderErrors(error);           if (er) p2.push(er);
  const cs = renderSubagents(subagent.filter(e => e.type === "subagent_completed")); if (cs) p2.push(cs);
  if (plan.length > 0 && plan.at(-1)?.type === "plan_enter") p2.push(`  <plan_mode status="active" />`);

  // P3-4 (15%)
  const p3: string[] = [];
  if (intent.length > 0) { const ie = renderIntent(intent.at(-1)!); if (ie) p3.push(ie); }
  const mt = renderMcpTools(mcp);           if (mt) p3.push(mt);
  const ls = renderSubagents(subagent.filter(e => e.type === "subagent_launched")); if (ls) p3.push(ls);

  const header = `<session_resume compact_count="${compactCount}" events_captured="${events.length}" generated_at="${now}">`;
  const footer = `</session_resume>`;

  // Drop lowest-priority tiers first if over budget
  for (let dropFrom = 3; dropFrom >= 0; dropFrom--) {
    const body = [p1, p2, p3].slice(0, dropFrom).flat().join("\n");
    const xml = body ? `${header}\n${body}\n${footer}` : `${header}\n${footer}`;
    if (Buffer.byteLength(xml) <= maxBytes) return xml;
  }

  return `${header}\n${footer}`;
}
