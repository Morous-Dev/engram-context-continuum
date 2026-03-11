/**
 * session-directive.mjs — Session guide builder for context injection.
 *
 * Responsible for: grouping session events by category, writing a structured
 * markdown events file for FTS5 indexing, and building the <session_knowledge>
 * XML block that is injected into Claude's context via the SessionStart hook.
 *
 * Depends on: node:fs (writeFileSync).
 * Depended on by: src/hooks/sessionstart.mjs.
 *
 * Adapted from: context-mode/hooks/session-directive.mjs (Elastic-2.0).
 * Changes: removed ctx_search MCP tool references (this plugin has no MCP server);
 * the session guide XML is injected inline rather than deferred to search.
 */

import { writeFileSync } from "node:fs";

// ── Group events by category ──────────────────────────────────────────────────

/**
 * Group events by category and extract last user prompt and unique file names.
 *
 * @param events - Array of session event objects from the DB.
 * @returns { grouped, lastPrompt, fileNames }
 */
export function groupEvents(events) {
  const grouped = {};
  let lastPrompt = "";
  for (const ev of events) {
    if (ev.category === "prompt") { lastPrompt = ev.data; continue; }
    if (!grouped[ev.category]) grouped[ev.category] = [];
    grouped[ev.category].push(ev);
  }
  const fileNames = new Set();
  for (const ev of (grouped.file || [])) {
    const path = ev.data.includes(" in ") ? ev.data.split(" in ").pop() : ev.data;
    const base = path?.split(/[/\\]/).pop()?.trim();
    if (base && !base.includes("*")) fileNames.add(base);
  }
  return { grouped, lastPrompt, fileNames };
}

// ── Write session events markdown ─────────────────────────────────────────────

/**
 * Write session events as structured markdown for FTS5 auto-indexing.
 * H2 headings per category produce clean chunks for BM25 search.
 *
 * @param events     - Array of session event objects from the DB.
 * @param eventsPath - Absolute path to write the markdown file.
 * @returns { grouped, lastPrompt, fileNames } metadata for directive building.
 */
export function writeSessionEventsFile(events, eventsPath) {
  const { grouped, lastPrompt, fileNames } = groupEvents(events);
  const lines = [];
  lines.push("# Session Resume");
  lines.push("");
  lines.push(`Events: ${events.length} | Timestamp: ${new Date().toISOString()}`);
  lines.push("");

  if (fileNames.size > 0) {
    lines.push("## Active Files");
    lines.push("");
    for (const name of fileNames) lines.push(`- ${name}`);
    lines.push("");
  }

  if (grouped.rule?.length > 0) {
    lines.push("## Project Rules");
    lines.push("");
    for (const ev of grouped.rule) {
      if (ev.type === "rule_content") {
        lines.push(ev.data.replace(/^(#{1,3}) /gm, (_, h) => "#".repeat(h.length + 3) + " "));
        lines.push("");
      } else {
        lines.push(`- ${ev.data}`);
      }
    }
    lines.push("");
  }

  if (grouped.task?.length > 0) {
    const creates = [];
    const updates = {};
    for (const ev of grouped.task) {
      try {
        const p = JSON.parse(ev.data);
        if (p.subject) creates.push(p.subject);
        else if (p.taskId && p.status) updates[p.taskId] = p.status;
      } catch { creates.push(ev.data); }
    }
    const DONE = new Set(["completed", "deleted", "failed"]);
    const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));
    const pending = [], completed = [];
    for (let i = 0; i < creates.length; i++) {
      const status = sortedIds[i] ? (updates[sortedIds[i]] || "pending") : "pending";
      (DONE.has(status) ? completed : pending).push(creates[i]);
    }
    if (pending.length > 0) {
      lines.push("## Tasks In Progress");
      lines.push("");
      for (const t of pending) lines.push(`- ${t}`);
      lines.push("");
    }
    if (completed.length > 0) {
      lines.push("## Tasks Completed");
      lines.push("");
      for (const t of completed) lines.push(`- ${t}`);
      lines.push("");
    }
  }

  if (grouped.decision?.length > 0) {
    lines.push("## User Decisions");
    lines.push("");
    for (const ev of grouped.decision) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.git?.length > 0) {
    lines.push("## Git Operations");
    lines.push("");
    for (const ev of grouped.git) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.env?.length > 0 || grouped.cwd?.length > 0) {
    lines.push("## Environment");
    lines.push("");
    if (grouped.cwd?.length > 0) lines.push(`- cwd: ${grouped.cwd[grouped.cwd.length - 1].data}`);
    for (const ev of (grouped.env || [])) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.error?.length > 0) {
    lines.push("## Errors Encountered");
    lines.push("");
    for (const ev of grouped.error) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.subagent?.length > 0) {
    lines.push("## Subagent Tasks");
    lines.push("");
    for (const ev of grouped.subagent) lines.push(`- ${ev.data}`);
    lines.push("");
  }

  if (grouped.skill?.length > 0) {
    lines.push("## Active Skills");
    lines.push("");
    lines.push(`- ${[...new Set(grouped.skill.map(e => e.data))].join(", ")}`);
    lines.push("");
  }

  if (grouped.intent?.length > 0) {
    lines.push("## Session Intent");
    lines.push("");
    lines.push(`- ${grouped.intent[grouped.intent.length - 1].data}`);
    lines.push("");
  }

  if (grouped.plan?.length > 0) {
    const hasApproved = grouped.plan.some(e => e.type === "plan_approved");
    const hasRejected = grouped.plan.some(e => e.type === "plan_rejected");
    const lastPlan = grouped.plan[grouped.plan.length - 1];
    const isActive = lastPlan.type === "plan_enter" || lastPlan.type === "plan_file_write";
    lines.push("## Plan Mode");
    lines.push("");
    lines.push(hasApproved ? "- Status: APPROVED AND EXECUTED"
      : hasRejected ? "- Status: REJECTED BY USER"
      : isActive ? "- Status: ACTIVE (in planning)"
      : "- Status: COMPLETED");
    lines.push("");
  }

  if (lastPrompt) {
    lines.push("## Last User Prompt");
    lines.push("");
    lines.push(lastPrompt);
    lines.push("");
  }

  writeFileSync(eventsPath, lines.join("\n"), "utf-8");
  return { grouped, lastPrompt, fileNames };
}

// ── Build session directive XML ───────────────────────────────────────────────

/**
 * Build the <session_knowledge> XML block for context injection.
 *
 * Generates a compact, actionable summary of the session for the LLM to
 * use as orientation when resuming. Sections are ordered by priority.
 *
 * @param source    - "compact" | "resume" | "startup".
 * @param eventMeta - Return value of writeSessionEventsFile or groupEvents.
 * @returns XML string to append to additionalContext.
 */
export function buildSessionDirective(source, eventMeta) {
  const { grouped, lastPrompt, fileNames } = eventMeta;
  const isCompact = source === "compact";

  let block = `\n<session_knowledge source="${isCompact ? "compact" : "continue"}">`;
  block += `\n<session_guide>`;

  if (lastPrompt) {
    const display = lastPrompt.length > 300 ? lastPrompt.substring(0, 297) + "..." : lastPrompt;
    block += `\n## Last Request\n${display}\n`;
  }

  if (grouped.task?.length > 0) {
    const creates = [], updates = {};
    for (const ev of grouped.task) {
      try {
        const p = JSON.parse(ev.data);
        if (p.subject) creates.push(p.subject);
        else if (p.taskId && p.status) updates[p.taskId] = p.status;
      } catch { /* not JSON */ }
    }
    if (creates.length > 0) {
      const DONE = new Set(["completed", "deleted", "failed"]);
      const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));
      const pending = creates.filter((_, i) => !DONE.has(updates[sortedIds[i]] || "pending"));
      if (pending.length > 0) {
        block += `\n## Pending Tasks`;
        for (const t of pending) block += `\n- ${t}`;
        block += `\n`;
      }
    }
  }

  if (grouped.decision?.length > 0) {
    block += `\n## Key Decisions`;
    for (const ev of grouped.decision) {
      block += `\n- ${ev.data.length > 150 ? ev.data.substring(0, 147) + "..." : ev.data}`;
    }
    block += `\n`;
  }

  if (fileNames.size > 0) {
    block += `\n## Files Modified\n${[...fileNames].join(", ")}\n`;
  }

  if (grouped.error?.length > 0) {
    // Show only the most recent errors (last 5) — older errors are likely stale.
    // Error resolution tracking happens at handoff time (writer.ts), not here.
    // The PostToolUse hook does not emit error_resolved events, so we cannot
    // distinguish resolved vs unresolved at compact time. Limiting to recent
    // errors reduces noise from stale errors accumulated over long sessions.
    const recentErrors = grouped.error.slice(-5);
    block += `\n## Recent Errors`;
    for (const ev of recentErrors) {
      block += `\n- ${ev.data.length > 150 ? ev.data.substring(0, 147) + "..." : ev.data}`;
    }
    block += `\n`;
  }

  if (grouped.git?.length > 0) {
    block += `\n## Git\n${[...new Set(grouped.git.map(e => e.data))].join(", ")}\n`;
  }

  if (grouped.rule?.length > 0) {
    const rPaths = grouped.rule
      .filter(e => e.type !== "rule_content")
      .map(e => e.data.split(/[/\\]/).slice(-2).join("/"));
    if (rPaths.length > 0) block += `\n## Project Rules\n${[...new Set(rPaths)].join(", ")}\n`;
  }

  if (grouped.subagent?.length > 0) {
    block += `\n## Subagent Tasks`;
    for (const ev of grouped.subagent) {
      block += `\n- ${ev.data.length > 120 ? ev.data.substring(0, 117) + "..." : ev.data}`;
    }
    block += `\n`;
  }

  if (grouped.skill?.length > 0) {
    block += `\n## Skills Used\n${[...new Set(grouped.skill.map(e => e.data))].join(", ")}\n`;
  }

  if (grouped.env?.length > 0 || grouped.cwd?.length > 0) {
    block += `\n## Environment`;
    if (grouped.cwd?.length > 0) block += `\ncwd: ${grouped.cwd[grouped.cwd.length - 1].data}`;
    for (const ev of (grouped.env || [])) block += `\n${ev.data}`;
    block += `\n`;
  }

  if (grouped.intent?.length > 0) {
    block += `\n## Session Intent\n${grouped.intent[grouped.intent.length - 1].data}\n`;
  }

  if (grouped.plan?.length > 0) {
    const hasApproved = grouped.plan.some(e => e.type === "plan_approved");
    const hasRejected = grouped.plan.some(e => e.type === "plan_rejected");
    const lastPlan = grouped.plan[grouped.plan.length - 1];
    const isActive = lastPlan.type === "plan_enter" || lastPlan.type === "plan_file_write";
    block += `\n## Plan Mode`;
    if (hasApproved) block += `\n- Status: APPROVED AND EXECUTED\n- Do NOT re-enter plan mode or re-propose the same plan.`;
    else if (hasRejected) block += `\n- Status: REJECTED BY USER\n- Ask what they want changed before re-planning.`;
    else if (isActive) block += `\n- Status: ACTIVE (in planning phase)`;
    else block += `\n- Status: COMPLETED\n- Do NOT re-enter plan mode.`;
    block += `\n`;
  }

  block += `\n</session_guide>`;

  if (lastPrompt && isCompact) {
    block += `\n<continue_from>Continue working on the last request. Do NOT ask the user to repeat themselves.</continue_from>`;
  }

  block += `\n</session_knowledge>`;
  return block;
}

// ── DB query helpers ──────────────────────────────────────────────────────────

/**
 * Get all events for a specific session from the DB.
 *
 * @param db        - Open SessionDB instance (has .db property).
 * @param sessionId - Session UUID.
 * @returns Array of event rows.
 */
export function getSessionEvents(db, sessionId) {
  return db.db.prepare(
    `SELECT session_id, type, category, priority, data, source_hook, created_at
     FROM session_events WHERE session_id = ? ORDER BY created_at ASC`
  ).all(sessionId);
}

/**
 * Get events from the most recent session that has events (used by resume).
 *
 * @param db - Open SessionDB instance.
 * @returns Array of event rows from the most recent session.
 */
export function getLatestSessionEvents(db) {
  const latest = db.db.prepare(
    `SELECT m.session_id FROM session_meta m
     JOIN session_events e ON m.session_id = e.session_id
     GROUP BY m.session_id
     ORDER BY m.started_at DESC LIMIT 1`
  ).get();
  if (!latest) return [];
  return getSessionEvents(db, latest.session_id);
}
