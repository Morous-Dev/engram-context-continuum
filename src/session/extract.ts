/**
 * extract.ts — Session event extraction from Claude Code tool calls and user messages.
 *
 * Responsible for: extracting structured SessionEvents from PostToolUse hook
 * inputs (13+ tool categories) and UserPromptSubmit hook inputs (decision,
 * role, intent, data). Pure functions, zero side effects, never throws.
 *
 * Depends on: nothing (pure extraction logic, no imports).
 * Depended on by: src/hooks/posttooluse.mjs, src/hooks/userpromptsubmit.mjs.
 *
 * Ported from: context-mode/src/session/extract.ts (Elastic-2.0 license).
 */

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface SessionEvent {
  /** e.g. "file_read", "file_write", "cwd", "error_tool", "git", "task",
   *  "decision", "rule", "env", "role", "skill", "subagent", "data", "intent" */
  type: string;
  /** e.g. "file", "cwd", "error", "git", "task", "decision",
   *  "rule", "env", "role", "skill", "subagent", "data", "intent" */
  category: string;
  /** Extracted payload, truncated to 300 chars max */
  data: string;
  /** 1=critical (rules, files, tasks) … 5=low */
  priority: number;
}

export interface ToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse?: string;
  isError?: boolean;
}

/**
 * Hook input shape as received from Claude Code PostToolUse hook stdin.
 * Uses snake_case to match the raw hook JSON.
 */
export interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: string;
  /** Optional structured output from the tool (may carry isError) */
  tool_output?: { isError?: boolean };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Truncate a string to at most `max` characters. */
function truncate(value: string | null | undefined, max = 300): string {
  if (value == null) return "";
  if (value.length <= max) return value;
  return value.slice(0, max);
}

/** Serialise an unknown value to a string, then truncate. */
function truncateAny(value: unknown, max = 300): string {
  if (value == null) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return truncate(str, max);
}

// ── Category extractors ───────────────────────────────────────────────────────

/**
 * Category 1 & 2: rule + file
 *
 * CLAUDE.md / .claude/ reads → emit both a "rule" event (priority 1) AND a
 * "file_read" event (priority 1) because the file is being actively accessed.
 *
 * Other Edit/Write/Read tool calls → emit file_edit / file_write / file_read
 * event (priority 1).
 */
function extractFileAndRule(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input, tool_response } = input;
  const events: SessionEvent[] = [];

  if (tool_name === "Read") {
    const filePath = String(tool_input["file_path"] ?? "");
    const isRuleFile = /CLAUDE\.md$|\.claude[\\/]/i.test(filePath);

    if (isRuleFile) {
      events.push({ type: "rule", category: "rule", data: truncate(filePath), priority: 1 });
      // Capture rule file path for reference (content is NOT stored — CLAUDE.md
      // is already in the system prompt and storing 5000-char blobs was causing
      // the snapshot budget to overflow, producing empty session_resume XML).
      // The rule path event above is sufficient to track which rule files were loaded.
    }

    // Reads are context (what was examined), not actions (what was changed).
    // P2 prevents reads from crowding out edits/writes (P1) and user-semantic
    // events under FIFO pressure in long sessions.
    events.push({ type: "file_read", category: "file", data: truncate(filePath), priority: 2 });
    return events;
  }

  if (tool_name === "Edit") {
    events.push({ type: "file_edit", category: "file", data: truncate(String(tool_input["file_path"] ?? "")), priority: 1 });
    return events;
  }

  if (tool_name === "NotebookEdit") {
    events.push({ type: "file_edit", category: "file", data: truncate(String(tool_input["notebook_path"] ?? "")), priority: 1 });
    return events;
  }

  if (tool_name === "Write") {
    events.push({ type: "file_write", category: "file", data: truncate(String(tool_input["file_path"] ?? "")), priority: 1 });
    return events;
  }

  if (tool_name === "Glob") {
    events.push({ type: "file_glob", category: "file", data: truncate(String(tool_input["pattern"] ?? "")), priority: 3 });
    return events;
  }

  if (tool_name === "Grep") {
    const pattern = String(tool_input["pattern"] ?? "");
    const path = String(tool_input["path"] ?? "");
    events.push({ type: "file_search", category: "file", data: truncate(`${pattern} in ${path}`), priority: 3 });
    return events;
  }

  return events;
}

/**
 * Category 4: cwd
 * Matches the first `cd <path>` in a Bash command (handles quoted paths).
 */
function extractCwd(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash") return [];
  const cmd = String(input.tool_input["command"] ?? "");
  const cdMatch = cmd.match(/\bcd\s+("([^"]+)"|'([^']+)'|(\S+))/);
  if (!cdMatch) return [];
  const dir = cdMatch[2] ?? cdMatch[3] ?? cdMatch[4] ?? "";
  return [{ type: "cwd", category: "cwd", data: truncate(dir), priority: 2 }];
}

/**
 * Category 5: error
 * Detects failures from bash exit codes / error patterns, or isError flag.
 *
 * Previous implementation matched /error:|Error:|FAIL|failed/ anywhere in the
 * response string, which captured npm warnings, log prefixes, and JSON-wrapped
 * stdout as "error" events. Now requires patterns at line boundaries and
 * extracts only the error-relevant lines instead of the entire tool response.
 */
function extractError(input: HookInput): SessionEvent[] {
  const { tool_name, tool_response, tool_output } = input;
  const response = String(tool_response ?? "");
  const isErrorFlag = tool_output?.isError === true;

  if (isErrorFlag) {
    return [{ type: "error_tool", category: "error", data: extractErrorLines(response), priority: 2 }];
  }

  if (tool_name !== "Bash") return [];

  // Skip JSON-wrapped responses — these are raw tool output objects, not errors
  const trimmed = response.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return [];

  // Require clear error signals: exit code, or error type at line start
  const hasExitCode = /exit code [1-9]/.test(response);
  const hasLineError = /^(Error|TypeError|ReferenceError|SyntaxError|RangeError|FATAL|ENOENT|EACCES|EPERM)/m.test(response);
  const hasFailure = /^(FAIL|FAILED)\b/m.test(response);

  if (!hasExitCode && !hasLineError && !hasFailure) return [];

  return [{ type: "error_tool", category: "error", data: extractErrorLines(response), priority: 2 }];
}

/**
 * Extract only error-relevant lines from a tool response.
 * Keeps lines that contain actual error messages rather than storing
 * the entire stdout/stderr blob.
 */
function extractErrorLines(response: string): string {
  const lines = response.split("\n");
  const errorLines = lines.filter(line => {
    const t = line.trim();
    return /^(Error|TypeError|ReferenceError|SyntaxError|RangeError|FATAL|ENOENT|EACCES|EPERM)\b/.test(t)
      || /exit code [1-9]/.test(t)
      || /^(FAIL|FAILED)\b/.test(t)
      || /^\s+at\s+/.test(t); // stack trace lines
  });
  if (errorLines.length > 0) {
    // Include up to 5 error lines for context
    return truncate(errorLines.slice(0, 5).join("\n"), 300);
  }
  return truncate(response, 300);
}

/**
 * Category 11: git
 * Matches common git operations from Bash commands.
 */
const GIT_PATTERNS: Array<{ pattern: RegExp; operation: string }> = [
  { pattern: /\bgit\s+checkout\b/, operation: "branch" },
  { pattern: /\bgit\s+commit\b/, operation: "commit" },
  { pattern: /\bgit\s+merge\s+\S+/, operation: "merge" },
  { pattern: /\bgit\s+rebase\b/, operation: "rebase" },
  { pattern: /\bgit\s+stash\b/, operation: "stash" },
  { pattern: /\bgit\s+push\b/, operation: "push" },
  { pattern: /\bgit\s+pull\b/, operation: "pull" },
  { pattern: /\bgit\s+log\b/, operation: "log" },
  { pattern: /\bgit\s+diff\b/, operation: "diff" },
  { pattern: /\bgit\s+status\b/, operation: "status" },
  { pattern: /\bgit\s+branch\b/, operation: "branch" },
  { pattern: /\bgit\s+reset\b/, operation: "reset" },
  { pattern: /\bgit\s+add\b/, operation: "add" },
  { pattern: /\bgit\s+cherry-pick\b/, operation: "cherry-pick" },
  { pattern: /\bgit\s+tag\b/, operation: "tag" },
  { pattern: /\bgit\s+fetch\b/, operation: "fetch" },
  { pattern: /\bgit\s+clone\b/, operation: "clone" },
  { pattern: /\bgit\s+worktree\b/, operation: "worktree" },
];

function extractGit(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash") return [];
  const cmd = String(input.tool_input["command"] ?? "");
  const match = GIT_PATTERNS.find(p => p.pattern.test(cmd));
  if (!match) return [];
  return [{ type: "git", category: "git", data: truncate(match.operation), priority: 2 }];
}

/**
 * Category 3: task
 * TodoWrite / TaskCreate / TaskUpdate tool calls.
 */
function extractTask(input: HookInput): SessionEvent[] {
  const TASK_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);
  if (!TASK_TOOLS.has(input.tool_name)) return [];
  const type = input.tool_name === "TaskUpdate" ? "task_update"
    : input.tool_name === "TaskCreate" ? "task_create" : "task";
  return [{ type, category: "task", data: truncate(JSON.stringify(input.tool_input), 300), priority: 1 }];
}

/**
 * Category 15: plan
 * Tracks the full plan mode lifecycle via EnterPlanMode / ExitPlanMode.
 */
function extractPlan(input: HookInput): SessionEvent[] {
  if (input.tool_name === "EnterPlanMode") {
    return [{ type: "plan_enter", category: "plan", data: "entered plan mode", priority: 2 }];
  }

  if (input.tool_name === "ExitPlanMode") {
    const events: SessionEvent[] = [];
    const prompts = input.tool_input["allowedPrompts"];
    const detail = Array.isArray(prompts) && prompts.length > 0
      ? `exited plan mode (allowed: ${truncateAny(prompts.map((p: unknown) => {
          if (typeof p === "object" && p !== null && "prompt" in p) return String((p as Record<string, unknown>).prompt);
          return String(p);
        }).join(", "), 200)})`
      : "exited plan mode";
    events.push({ type: "plan_exit", category: "plan", data: truncate(detail), priority: 2 });

    const response = String(input.tool_response ?? "").toLowerCase();
    if (response.includes("approved") || response.includes("approve")) {
      events.push({ type: "plan_approved", category: "plan", data: "plan approved by user", priority: 1 });
    } else if (response.includes("rejected") || response.includes("decline") || response.includes("denied")) {
      events.push({ type: "plan_rejected", category: "plan", data: truncate(`plan rejected: ${input.tool_response ?? ""}`, 300), priority: 2 });
    }
    return events;
  }

  if (input.tool_name === "Write" || input.tool_name === "Edit") {
    const filePath = String(input.tool_input["file_path"] ?? "");
    if (/[/\\]\.claude[/\\]plans[/\\]/.test(filePath)) {
      return [{ type: "plan_file_write", category: "plan", data: truncate(`plan file: ${filePath.split(/[/\\]/).pop() ?? filePath}`), priority: 2 }];
    }
  }

  return [];
}

/**
 * Category 8: env
 * Environment setup commands in Bash: venv, export, nvm, pyenv, conda, etc.
 */
const ENV_PATTERNS: RegExp[] = [
  /\bsource\s+\S*activate\b/, /\bexport\s+\w+=/, /\bnvm\s+use\b/,
  /\bpyenv\s+(shell|local|global)\b/, /\bconda\s+activate\b/, /\brbenv\s+(shell|local|global)\b/,
  /\bnpm\s+install\b/, /\bnpm\s+ci\b/, /\bpip\s+install\b/, /\bbun\s+install\b/,
  /\byarn\s+(add|install)\b/, /\bpnpm\s+(add|install)\b/, /\bcargo\s+(install|add)\b/,
  /\bgo\s+(install|get)\b/, /\brustup\b/, /\basdf\b/, /\bvolta\b/, /\bdeno\s+install\b/,
];

function extractEnv(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash") return [];
  const cmd = String(input.tool_input["command"] ?? "");
  if (!ENV_PATTERNS.some(p => p.test(cmd))) return [];
  // Sanitize export commands to prevent secret leakage in stored events
  const sanitized = cmd.replace(/\bexport\s+(\w+)=\S*/g, "export $1=***");
  return [{ type: "env", category: "env", data: truncate(sanitized), priority: 2 }];
}

/** Category 10: skill — Skill tool invocations. */
function extractSkill(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Skill") return [];
  return [{ type: "skill", category: "skill", data: truncate(String(input.tool_input["skill"] ?? "")), priority: 3 }];
}

/**
 * Category 9: subagent — Agent tool calls.
 * Completed agents (with tool_response) are P2; launched agents are P3.
 */
function extractSubagent(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Agent") return [];
  const prompt = truncate(String(input.tool_input["prompt"] ?? input.tool_input["description"] ?? ""), 200);
  const response = input.tool_response ? truncate(String(input.tool_response), 300) : "";
  const isCompleted = response.length > 0;
  return [{
    type: isCompleted ? "subagent_completed" : "subagent_launched",
    category: "subagent",
    data: isCompleted ? truncate(`[completed] ${prompt} → ${response}`, 300) : truncate(`[launched] ${prompt}`, 300),
    priority: isCompleted ? 2 : 3,
  }];
}

/** Category 14: mcp — MCP tool calls (any tool starting with mcp__). */
function extractMcp(input: HookInput): SessionEvent[] {
  if (!input.tool_name.startsWith("mcp__")) return [];
  const parts = input.tool_name.split("__");
  const toolShort = parts[parts.length - 1] || input.tool_name;
  const firstArg = Object.values(input.tool_input).find((v): v is string => typeof v === "string");
  const argStr = firstArg ? `: ${truncate(String(firstArg), 100)}` : "";
  return [{ type: "mcp", category: "mcp", data: truncate(`${toolShort}${argStr}`), priority: 3 }];
}

/**
 * Category 16: checkpoint
 * Infers task progress from tool call patterns. Captures high-level work
 * milestones so the SLM brief can report "step N done, working on step N+1"
 * instead of just "implementing feature X".
 *
 * Patterns detected:
 *   - Bash: test/build/lint runs → "verification checkpoint"
 *   - Bash: git commit → "commit checkpoint" (work was completed and saved)
 *   - Write: new file creation → "created <file>" checkpoint
 *   - Edit after Read: "modified <file>" checkpoint (edit cycle complete)
 */
function extractCheckpoint(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input, tool_response } = input;
  const response = String(tool_response ?? "");

  if (tool_name === "Bash") {
    const cmd = String(tool_input["command"] ?? "");

    // Test run checkpoint — indicates verification of completed work
    if (/\b(npm\s+test|npx\s+jest|npx\s+vitest|pytest|cargo\s+test|go\s+test|npm\s+run\s+test)\b/.test(cmd)) {
      const passed = /pass|ok|success/i.test(response) && !/fail|error/i.test(response);
      return [{ type: "checkpoint_test", category: "checkpoint", data: truncate(`test run: ${passed ? "PASSED" : "FAILED"} — ${cmd}`, 300), priority: 1 }];
    }

    // Build checkpoint — indicates compile/transpile step completed
    if (/\b(npm\s+run\s+build|tsc|npx\s+tsc|cargo\s+build|go\s+build|make\b)/.test(cmd)) {
      const success = !/(error|fail)/i.test(response);
      return [{ type: "checkpoint_build", category: "checkpoint", data: truncate(`build: ${success ? "SUCCESS" : "FAILED"} — ${cmd}`, 300), priority: 1 }];
    }

    // Lint/typecheck checkpoint
    if (/\b(npm\s+run\s+(lint|typecheck)|npx\s+(eslint|tsc\s+--noEmit)|cargo\s+clippy)\b/.test(cmd)) {
      const clean = !/(error|warning)/i.test(response);
      return [{ type: "checkpoint_lint", category: "checkpoint", data: truncate(`lint: ${clean ? "CLEAN" : "ISSUES"} — ${cmd}`, 300), priority: 2 }];
    }

    // Git commit checkpoint — work was completed and committed
    if (/\bgit\s+commit\b/.test(cmd)) {
      const msgMatch = cmd.match(/-m\s+["']([^"']+)["']/);
      const commitMsg = msgMatch ? msgMatch[1] : "no message";
      return [{ type: "checkpoint_commit", category: "checkpoint", data: truncate(`committed: ${commitMsg}`, 300), priority: 1 }];
    }
  }

  // New file creation checkpoint
  if (tool_name === "Write") {
    const filePath = String(tool_input["file_path"] ?? "");
    return [{ type: "checkpoint_create", category: "checkpoint", data: truncate(`created: ${filePath}`), priority: 2 }];
  }

  return [];
}

/** Category 6: decision — AskUserQuestion tool interactions. */
function extractDecision(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "AskUserQuestion") return [];
  const questions = input.tool_input["questions"];
  const questionText = Array.isArray(questions) && questions.length > 0
    ? String((questions[0] as Record<string, unknown>)["question"] ?? "") : "";
  const answer = truncate(String(input.tool_response ?? ""), 150);
  const summary = questionText
    ? `Q: ${truncate(questionText, 120)} → A: ${answer}` : `answer: ${answer}`;
  return [{ type: "decision_question", category: "decision", data: truncate(summary), priority: 2 }];
}

/** Category 8: env (worktree) — EnterWorktree tool. */
function extractWorktree(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "EnterWorktree") return [];
  return [{ type: "worktree", category: "env", data: truncate(`entered worktree: ${String(input.tool_input["name"] ?? "unnamed")}`), priority: 2 }];
}

// ── User-message extractors ───────────────────────────────────────────────────

// Decision patterns require directive structure, not just common words.
// Previous patterns matched bare words like "instead", "rather", "prefer"
// which polluted the decisions section with conversational messages.
// Each pattern here requires a verb + object structure indicating an explicit choice.
const DECISION_PATTERNS: RegExp[] = [
  /\b(use|switch to|go with|pick|choose)\s+\w+\s+(instead|over|not)\b/i,
  /\b(no,?\s+(use|do|try|make))\b/i,
  /\b(don'?t|do not)\s+(use|add|install|import|include)\b/i,
  /\b(let'?s|we should|I prefer to|I want to)\s+(use|switch|go with|pick|choose|remove|drop)\b/i,
  /\b(hayır|hayir|evet)\b.*\b(kullan|yerine|değil|degil)\b/i,
];

// Maximum message length for decision extraction — long messages are explanations
// or discussions, not concise directive decisions.
const MAX_DECISION_MESSAGE_LENGTH = 300;

// Matches fenced code blocks (```...```) for stripping before pattern checks.
// Code snippets often contain directive-looking comments ("// use Redis instead")
// that are NOT the user's own decisions and would otherwise be false positives.
const CODE_BLOCK_RE = /```[\s\S]*?```/g;

/** Category 6: decision — User corrections and approach selections. */
function extractUserDecision(message: string): SessionEvent[] {
  if (message.length > MAX_DECISION_MESSAGE_LENGTH) return [];
  // Strip markdown code blocks before checking patterns — code comments like
  // "// use Redis instead of X" look like directives but are not user decisions.
  const stripped = message.replace(CODE_BLOCK_RE, "");
  if (!DECISION_PATTERNS.some(p => p.test(stripped))) return [];
  return [{ type: "decision", category: "decision", data: truncate(message, 300), priority: 2 }];
}

const ROLE_PATTERNS: RegExp[] = [
  /\b(act as|you are|behave like|pretend|role of|persona)\b/i,
  /\b(senior|staff|principal|lead)\s+(engineer|developer|architect)\b/i,
  /\b(gibi davran|rolünde|olarak çalış)\b/i,
];

/** Category 7: role — Persona and behavioral directive patterns. */
function extractRole(message: string): SessionEvent[] {
  if (!ROLE_PATTERNS.some(p => p.test(message))) return [];
  return [{ type: "role", category: "role", data: truncate(message, 300), priority: 3 }];
}

const INTENT_PATTERNS: Array<{ mode: string; pattern: RegExp }> = [
  // "raises/throws" added after SWE-bench calibration: GitHub bug reports describe
  // errors with "it raises a ValueError" — these should classify as investigate.
  { mode: "investigate", pattern: /\b(why|how does|explain|understand|what is|analyze|debug|look into|raises?|throws?)\b/i },
  // "refactor/migrate/convert/remove" added after SWE-bench calibration: GitHub feature
  // requests commonly say "please refactor X" or "let's remove the legacy Y".
  { mode: "implement",   pattern: /\b(create|add|build|implement|write|make|develop|fix|refactor|migrate|convert|remove)\b/i },
  // "which is better / which one" and "compare / versus" added after real-world
  // calibration showed these common comparison requests were not matched.
  { mode: "discuss",     pattern: /\b(think about|consider|should we|what if|pros and cons|opinion|which is better|which one|compare|versus)\b/i },
  { mode: "review",      pattern: /\b(review|check|audit|verify|test|validate)\b/i },
];

/** Category 13: intent — Session mode classification from user messages. */
function extractIntent(message: string): SessionEvent[] {
  const match = INTENT_PATTERNS.find(({ pattern }) => pattern.test(message));
  if (!match) return [];
  // P3 (not P4): user intent is at least as valuable as glob/search results.
  // At P4, intent events were always first-evicted, losing the user's conceptual
  // thread while retaining structural metadata. P3 keeps them alive longer.
  return [{ type: "intent", category: "intent", data: truncate(match.mode), priority: 3 }];
}

// Stop words filtered out when extracting key terms — ECC vocabulary (intent modes,
// checkpoint labels) + common English function words that are not domain signals.
// OVERSIZE: extract.ts is ~548 lines due to this stop set + extractKeyTerms helper.
// Split plan: move user-message extractors to extract-user.ts when next refactor lands.
const DATA_STOP = new Set("implement investigate review discuss function import export return undefined boolean string number object interface class async await promise error fetch response request handler module component service repository controller provider factory middleware decorator parameter argument variable constant namespace generic abstract prototype constructor extends implements static readonly private public protected override callback closure generator iterator async yield Symbol Promise Array Object String Number Boolean BigInt Error Function RegExp Date Map Set WeakMap WeakSet Buffer Promise".split(" ").map(s => s.toLowerCase()));

/**
 * Extract up to `limit` distinctive key terms from a message.
 * Used to front-load domain vocabulary into data events so FTS5 can find
 * terms that appear anywhere in the message, not just the first 300 chars.
 *
 * @param message - Raw message text to scan.
 * @param limit   - Maximum number of terms to return.
 * @returns Lowercase tokens sorted longest-first (longer = more distinctive).
 */
function extractKeyTerms(message: string, limit = 5): string[] {
  // Use {4,} (5+ chars) to match anchor collection heuristic — 5-char domain terms
  // like "flask", "react", "nginx", "query" are meaningful vocabulary anchors.
  const tokens = (message.match(/\b[a-zA-Z][a-zA-Z0-9]{4,}\b/g) ?? [])
    .filter(t => !DATA_STOP.has(t.toLowerCase()));
  const unique = [...new Set(tokens.map(t => t.toLowerCase()))];
  return unique.sort((a, b) => b.length - a.length).slice(0, limit);
}

/** Category 12: data — User messages >300 chars (lowered from 1024). */
function extractData(message: string): SessionEvent[] {
  if (message.length <= 300) return [];
  // P3 (not P4): messages over 300 chars contain domain-specific vocabulary
  // (function names, schema terms, error details) that anchors context. At P4
  // they were evicted first, losing the user's problem domain while keeping
  // structural metadata. Threshold lowered from 1024: real conversations are
  // typically 300-800 chars, not >1024 — the old threshold captured almost nothing.
  //
  // Key terms are prepended so FTS5 can find distinctive vocabulary that appears
  // anywhere in the message, even beyond the 300-char truncation boundary.
  const terms = extractKeyTerms(message);
  const prefix = terms.length > 0 ? `[${terms.join(" ")}] ` : "";
  return [{ type: "data", category: "data", data: truncate(prefix + message, 300), priority: 3 }];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract session events from a PostToolUse hook input.
 *
 * Accepts the raw hook JSON shape (snake_case keys) as received from stdin.
 * Returns an array of zero or more SessionEvents. Never throws.
 *
 * @param input - Raw hook input from Claude Code PostToolUse stdin.
 * @returns Array of extracted session events (may be empty).
 */
export function extractEvents(input: HookInput): SessionEvent[] {
  try {
    return [
      ...extractFileAndRule(input),
      ...extractCwd(input),
      ...extractError(input),
      ...extractGit(input),
      ...extractEnv(input),
      ...extractTask(input),
      ...extractPlan(input),
      ...extractSkill(input),
      ...extractSubagent(input),
      ...extractMcp(input),
      ...extractDecision(input),
      ...extractWorktree(input),
      ...extractCheckpoint(input),
    ];
  } catch {
    return [];
  }
}

/**
 * Extract session events from a UserPromptSubmit hook input (user message text).
 *
 * Handles: decision, role, intent, data categories.
 * Returns an array of zero or more SessionEvents. Never throws.
 *
 * @param message - Raw user message text.
 * @returns Array of extracted session events (may be empty).
 */
export function extractUserEvents(message: string): SessionEvent[] {
  try {
    return [
      ...extractUserDecision(message),
      ...extractRole(message),
      ...extractIntent(message),
      ...extractData(message),
    ];
  } catch {
    return [];
  }
}
