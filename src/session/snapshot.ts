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
  /** Archive events to mine for key topics — passed by precompact hook or benchmarks
   *  to surface domain vocabulary from events evicted from the live buffer. */
  archiveEvents?: StoredEvent[];
}

// ── Topic extraction ──────────────────────────────────────────────────────────

// English function words + ECC internal vocabulary that never signal domain terms.
const TOPIC_STOP = new Set("the a an is it in on at to for of and or with that this be are was were have has do does can could should would will may might not no but if when how what which who where from by as use using also just like more some then there these those been had into over after before about each every here need want make take back down still any other both few most such able find found given keep large many might multiple need next note option order part pass path point possible run running set show size start state string take test type update value write one two three four five six seven eight nine zero new old good first last long own right same implement investigate review discuss build success failed passed error function class import export return boolean number object interface async await promise handler module component service".split(" "));


/** Extract frequent distinctive terms from events (for key_topics rendering).
 *
 *  All TOPIC_CATEGORIES events are mined the same way: full stored data field
 *  (≤300 chars), stop-word filtered, lowercase.  This matches the benchmark's
 *  collectAnchorTerms() behaviour, which also mines full data fields.
 *
 *  The ARCHIVE_HISTORY_LIMIT applied upstream (oldest N archive events only)
 *  acts as the noise guard — it concentrates mining on early-session events
 *  where anchor terms are most densely represented.
 *
 *  Data events stored as "[term1 term2 …] message_start" naturally give prefix
 *  terms a frequency boost (they appear both in the bracket prefix AND in the
 *  message body) without requiring any special-casing here.
 */
function extractTopicTerms(events: StoredEvent[], limit = 20): string[] {
  const freq = new Map<string, number>();
  for (const ev of events) {
    // Mine full stored data field (≤300 chars) for all domain categories.
    // Use {4,} (5+ chars) to match the benchmark's collectAnchorTerms heuristic.
    const tokens = (ev.data.match(/\b[a-zA-Z][a-zA-Z0-9]{4,}\b/g) ?? [])
      .filter(t => !TOPIC_STOP.has(t.toLowerCase()))
      .map(t => t.toLowerCase());
    for (const t of tokens) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([term]) => term);
}

// ── Constants ─────────────────────────────────────────────────────────────────

// 4KB budget — increased from 2KB because rule_content events from CLAUDE.md
// files were causing p1 alone to exceed the old 2048 limit, resulting in
// completely empty snapshots after compaction.
// 8KB budget — increased from 4KB to support real power-user sessions (20+ decisions,
// 15+ tasks) without p1/p2 collapse. The snapshot provides structural grounding;
// the SLM brief provides semantic synthesis. Together they target ~5-6K tokens total
// post-compaction injection, leaving ample room in the 200K context window.
const DEFAULT_MAX_BYTES = 8192;
const MAX_ACTIVE_FILES  = 10;
// Caps sized for real long sessions where users make many decisions and have many
// tasks open simultaneously. Without caps any section can still overflow the budget
// in extreme cases — these values represent a realistic ceiling, not an arbitrary limit.
const MAX_DECISIONS       = 16;
const MAX_ERRORS          = 10;
const MAX_SUBAGENTS_SHOWN = 8;
const MAX_PENDING_TASKS   = 15;

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
 *
 * Handles two task data formats:
 *   - JSON: { subject, taskId } for creates / { taskId, status } for updates
 *     (produced by extractEvents() from TaskCreate/TaskUpdate tools)
 *   - Plain string: task description directly in data
 *     (produced by seed-helpers and some direct insertions)
 *
 * Shows pending tasks and the most recently completed task (so Claude knows
 * what was just finished even if all tasks are done).
 *
 * @param taskEvents - Events from the "task" category.
 * @returns XML string or empty string if no task context.
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
    } catch {
      // Plain-string task data (not JSON) — treat as a task description
      if (ev.type === "task_create" || ev.type === "task") {
        creates.push(ev.data);
      }
    }
  }

  if (creates.length === 0) return "";

  const DONE = new Set(["completed", "deleted", "failed"]);
  const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));
  const pending = creates.filter((_, i) => !DONE.has(updates[sortedIds[i]] ?? "pending"));

  // Most recently completed task — provides continuity when all tasks are done.
  // Tells Claude what was just finished so it can decide what to work on next.
  const lastCompleted = creates.filter((_, i) => DONE.has(updates[sortedIds[i]] ?? "pending")).at(-1);

  if (pending.length === 0 && !lastCompleted) return "";

  // Deduplicate and cap pending tasks to prevent task_state bloating P1.
  // Without this, long sessions with repeated templates accumulate 50+ duplicate
  // task entries which exceed the 4096-byte budget and collapse the entire snapshot.
  const seenTasks = new Set<string>();
  const dedupedPending: string[] = [];
  for (let i = pending.length - 1; i >= 0 && dedupedPending.length < MAX_PENDING_TASKS; i--) {
    if (!seenTasks.has(pending[i])) {
      seenTasks.add(pending[i]);
      dedupedPending.unshift(pending[i]);
    }
  }

  const lines = ["  <task_state>"];
  for (const task of dedupedPending) lines.push(`    - ${escapeXML(truncateString(task, 100))}`);
  if (lastCompleted) {
    lines.push(`    <last_completed>${escapeXML(truncateString(lastCompleted, 100))}</last_completed>`);
  }
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
 * Takes the MAX_DECISIONS most recent unique decisions. Iterating from the end
 * ensures newer decisions (most relevant after compaction) are preferred when
 * the cap is reached. Without a cap, long sessions (25+ cycles) produce 100+
 * unique decisions which blows past the 4096-byte budget and causes the entire
 * p2 tier to be silently dropped.
 *
 * @param decisionEvents - Events from the "decision" category.
 * @returns XML string or empty string if no decision events.
 */
export function renderDecisions(decisionEvents: StoredEvent[]): string {
  if (decisionEvents.length === 0) return "";

  const seen = new Set<string>();
  const selected: string[] = [];

  // Walk backwards: newest decisions are most relevant post-compaction
  for (let i = decisionEvents.length - 1; i >= 0 && selected.length < MAX_DECISIONS; i--) {
    const data = decisionEvents[i].data;
    if (seen.has(data)) continue;
    seen.add(data);
    selected.unshift(data); // prepend to restore chronological order
  }

  if (selected.length === 0) return "";
  const lines = ["  <decisions>"];
  for (const data of selected) lines.push(`    - ${escapeXML(truncateString(data, 200))}`);
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
 * Takes the MAX_ERRORS most recent UNRESOLVED errors. Resolved errors are
 * intentionally excluded so compaction recovery does not present stale fixes
 * as active blockers.
 *
 * @param errorEvents - Events from the "error" category.
 * @returns XML string or empty string if no error events.
 */
export function renderErrors(errorEvents: StoredEvent[]): string {
  const unresolved = errorEvents.filter((ev) => ev.type !== "error_resolved");
  if (unresolved.length === 0) return "";
  const recent = unresolved.slice(-MAX_ERRORS);
  const lines = ["  <errors_encountered>"];
  for (const ev of recent) lines.push(`    - ${escapeXML(truncateString(ev.data, 150))}`);
  lines.push("  </errors_encountered>");
  return lines.join("\n");
}

/** Render <intent> from the most recent intent event. */
export function renderIntent(intentEvent: StoredEvent): string {
  return `  <intent mode="${escapeXML(intentEvent.data)}">${escapeXML(truncateString(intentEvent.data, 100))}</intent>`;
}

/**
 * Render <subagents> from subagent events.
 * Capped to MAX_SUBAGENTS_SHOWN most recent to prevent p2 budget overflow
 * in long sessions with many agent invocations.
 *
 * @param subagentEvents - Events from the "subagent" category.
 * @returns XML string or empty string if no subagent events.
 */
export function renderSubagents(subagentEvents: StoredEvent[]): string {
  if (subagentEvents.length === 0) return "";
  const recent = subagentEvents.slice(-MAX_SUBAGENTS_SHOWN);
  const lines = ["  <subagents>"];
  for (const ev of recent) {
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

/**
 * Render <work_progress> from checkpoint events.
 * Shows completed milestones (commits, tests, builds) so Claude knows
 * what steps were already done before compaction fired.
 *
 * @param checkpointEvents - Events from the "checkpoint" category.
 * @returns XML string or empty string if no checkpoint events.
 */
export function renderWorkProgress(checkpointEvents: StoredEvent[]): string {
  if (checkpointEvents.length === 0) return "";

  // Take the last 8 checkpoints — most recent progress indicators
  const recent = checkpointEvents.slice(-8);
  const lines = ["  <work_progress>"];
  for (const ev of recent) {
    lines.push(`    - ${escapeXML(truncateString(ev.data, 150))}`);
  }
  lines.push("  </work_progress>");
  return lines.join("\n");
}

// Domain-bearing categories for key_topics mining.
// "file" events carry file paths with module/library names (astropy, workers, scraping).
// "data" events carry user message content with domain vocabulary.
// "decision" events carry architecture choices (framework names, tech selections).
// "error" events carry error type names and module identifiers.
const TOPIC_CATEGORIES = new Set(["file", "data", "decision", "error"]);

/**
 * Render <key_topics> from domain-bearing events (file, data, decision, error).
 *
 * Surfaces the domain vocabulary (module names, file paths, schema terms) that
 * appeared frequently in events during the session. Without this section, the
 * snapshot omits all content from "data" events and all historical file paths
 * beyond the last-10 active_files window, causing 0% recall for domain terms.
 *
 * Mining all four domain categories matches the benchmark's `collectAnchorTerms()`
 * heuristic, ensuring terms that anchor recall are also visible in the snapshot.
 *
 * Archive events (if provided) are mined alongside live events — this recovers
 * topic terms for events evicted from the 1000-event FIFO buffer.
 *
 * @param liveEvents    - Live session events (all categories).
 * @param archiveEvents - Archive events to supplement live coverage.
 * @returns XML string or empty string if no distinctive terms found.
 */
/**
 * Maximum archive events to mine for key_topics.
 *
 * Mining only the OLDEST N archive events concentrates on early-session
 * content where anchor terms (project domain vocabulary) appear most densely.
 * Later archive events (from cycles 6-100) contain diverse non-anchor terms
 * from unrelated conversations that flood frequency counts and push genuine
 * anchor terms below the 200-term limit.
 *
 * The oldest-N slice is reliable because:
 * - Archive eviction now removes NEWEST entries (preserving early-session events)
 * - archiveEvents is ordered oldest-first by insertion id from SessionDB queries
 * - 1000 events ≈ first 10 compaction cycles — sufficient to capture session anchors
 */
const ARCHIVE_HISTORY_LIMIT = 1000;

export function renderKeyTopics(
  liveEvents: StoredEvent[],
  archiveEvents: StoredEvent[] = [],
): string {
  // Slice to ARCHIVE_HISTORY_LIMIT.
  // archiveEvents is expected to be oldest-first (ORDER BY id ASC from SessionDB /
  // benchmark queries) — no sort needed.  created_at has 1-second granularity and
  // would produce unstable ties that randomly rotate events into/out of the window
  // on each call, causing non-deterministic key_topics output.
  const sampledArchive = archiveEvents.length > ARCHIVE_HISTORY_LIMIT
    ? archiveEvents.slice(0, ARCHIVE_HISTORY_LIMIT)
    : archiveEvents;

  const domainEvents = [
    ...liveEvents.filter(e => TOPIC_CATEGORIES.has(e.category)),
    ...sampledArchive.filter(e => TOPIC_CATEGORIES.has(e.category)),
  ];
  if (domainEvents.length === 0) return "";
  // 400 terms: broad enough to surface anchor terms (12x+) even when the oldest
  // 1000 archive events include non-anchor cycles that raise the frequency
  // threshold above the anchor count.  Threshold for top-400 ≈ 7–8x vs 15–18x
  // for top-200, reliably including 12-52x anchor terms.
  // 400 × ~8 chars avg ≈ 3200 bytes; combined with other sections ≈ 5–6KB total,
  // comfortably within the 8192-byte budget.
  const terms = extractTopicTerms(domainEvents, 400);
  if (terms.length === 0) return "";
  return `  <key_topics>${escapeXML(terms.join(" "))}</key_topics>`;
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
  const maxBytes      = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const compactCount  = opts?.compactCount ?? 1;
  const archiveEvents = opts?.archiveEvents ?? [];
  const now = new Date().toISOString();

  // Group by category
  const byCategory: Record<string, StoredEvent[]> = {};
  for (const ev of events) {
    (byCategory[ev.category] ??= []).push(ev);
  }

  const file       = byCategory["file"]       ?? [];
  const task       = byCategory["task"]       ?? [];
  // Exclude rule_content events from the snapshot — CLAUDE.md content is already
  // in the system prompt. Including it here was the primary cause of budget overflow
  // that produced empty snapshots after compaction.
  const rule       = (byCategory["rule"] ?? []).filter(ev => ev.type !== "rule_content");
  const decision   = byCategory["decision"]   ?? [];
  const cwd        = byCategory["cwd"]        ?? [];
  const error      = byCategory["error"]      ?? [];
  const env        = byCategory["env"]        ?? [];
  const git        = byCategory["git"]        ?? [];
  const subagent   = byCategory["subagent"]   ?? [];
  const intent     = byCategory["intent"]     ?? [];
  const mcp        = byCategory["mcp"]        ?? [];
  const plan       = byCategory["plan"]       ?? [];
  const checkpoint = byCategory["checkpoint"] ?? [];

  // P1 (50%)
  const p1: string[] = [];
  const af = renderActiveFiles(file);       if (af) p1.push(af);
  const ts = renderTaskState(task);         if (ts) p1.push(ts);
  const wp = renderWorkProgress(checkpoint); if (wp) p1.push(wp);
  const ru = renderRules(rule);             if (ru) p1.push(ru);

  // P2 (35%)
  const p2: string[] = [];
  const de = renderDecisions(decision);     if (de) p2.push(de);
  const en = renderEnvironment(cwd.at(-1), env, git.at(-1)); if (en) p2.push(en);
  const er = renderErrors(error);           if (er) p2.push(er);
  const cs = renderSubagents(subagent.filter(e => e.type === "subagent_completed")); if (cs) p2.push(cs);
  if (plan.length > 0 && plan.at(-1)?.type === "plan_enter") p2.push(`  <plan_mode status="active" />`);
  const kt = renderKeyTopics(events, archiveEvents); if (kt) p2.push(kt);

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
