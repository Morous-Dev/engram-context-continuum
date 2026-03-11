#!/usr/bin/env node
/**
 * server.ts — MCP server for the engram memory bank.
 *
 * What this file is: a local stdio MCP server that exposes session memory,
 *   handoff context, and knowledge graph as queryable tools.
 * Responsible for: serving memory bank data to any MCP-capable AI assistant
 *   (Claude Code, Gemini CLI, VS Code Copilot, OpenCode, Codex CLI, Cursor).
 *   Runs as a spawned local process — no remote server or hosting needed.
 * Depends on: @modelcontextprotocol/sdk, better-sqlite3, js-yaml, zod,
 *   src/memory/working.ts, src/handoff/writer.ts.
 * Depended on by: any MCP host that configures it (assistant-specific config
 *   files written by src/cli/setup.ts).
 *
 * Usage (added automatically by setup CLI):
 *   Claude Code:  { "command": "node", "args": ["/path/to/build/mcp/server.js"] }
 *   Gemini CLI:   same pattern in ~/.gemini/settings.json mcp section
 *   VS Code:      same pattern in mcp.json
 *
 * IMPORTANT: Never write to stdout except via the MCP SDK transport.
 *   All logging must use console.error() — stdout is reserved for JSON-RPC.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectDBPath } from "../project-id.js";
import Database from "better-sqlite3";
import yaml from "js-yaml";
import type { WorkingMemory } from "../memory/working.js";
import type { HandoffData } from "../handoff/writer.js";

// ── DB path helpers ──────────────────────────────────────────────────────────

/**
 * Compute the SQLite DB path for a project using stable project UUID.
 * Delegates to getProjectDBPath() — path: ~/.engram-cc/sessions/<uuid>.db
 *
 * @param projectDir - Absolute path to the project directory.
 * @returns Absolute path to the project's SQLite DB file.
 */
function getDbPath(projectDir: string): string {
  return getProjectDBPath(projectDir);
}

/**
 * Open the project DB in read-only mode.
 * Returns null if the DB does not exist yet (no sessions for this project).
 *
 * @param projectDir - Absolute path to the project directory.
 */
function openDb(projectDir: string): Database.Database | null {
  const dbPath = getDbPath(projectDir);
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

// ── YAML file helpers ────────────────────────────────────────────────────────

function readHandoff(projectDir: string): HandoffData | null {
  const path = join(projectDir, ".engram-cc", "handoff.yaml");
  if (!existsSync(path)) return null;
  try {
    return yaml.load(readFileSync(path, "utf-8")) as HandoffData;
  } catch {
    return null;
  }
}

function readWorking(projectDir: string): WorkingMemory | null {
  const path = join(projectDir, ".engram-cc", "working.yaml");
  if (!existsSync(path)) return null;
  try {
    return yaml.load(readFileSync(path, "utf-8")) as WorkingMemory;
  } catch {
    return null;
  }
}

// ── MCP Server setup ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "engram-cc",
  version: "0.1.0",
});

// ── Tool: recall ─────────────────────────────────────────────────────────────

/**
 * recall — "What was I working on?"
 * Returns the full session handoff + working memory for a project.
 * This is the primary tool — call it at the start of every session.
 *
 * Parameters:
 *   projectDir (optional) — defaults to process.cwd()
 */
server.tool(
  "recall",
  "Get full session context: last handoff, working memory, decisions, files modified. Call this at the start of every session.",
  {
    projectDir: z.string().optional().describe(
      "Absolute path to the project directory. Defaults to the current working directory.",
    ),
  },
  async ({ projectDir }) => {
    const dir = projectDir ?? process.cwd();
    const handoff = readHandoff(dir);
    const working = readWorking(dir);

    if (!handoff && !working) {
      return {
        content: [{
          type: "text",
          text: `No session memory found for project: ${dir}\nThis is either a new project or the session hooks have not fired yet.`,
        }],
      };
    }

    const sections: string[] = [`# Session Memory — ${dir}\n`];

    if (handoff) {
      sections.push("## Last Session Handoff");
      sections.push(`- **When:** ${handoff.timestamp}`);
      sections.push(`- **Task:** ${handoff.current_task || "(none)"}`);
      sections.push(`- **Last action:** ${handoff.last_action || "(none)"}`);
      sections.push(`- **Context:** ${handoff.working_context || "(none)"}`);
      sections.push(`- **Confidence:** ${handoff.confidence}`);

      if (handoff.next_steps?.length) {
        sections.push("\n**Next steps:**");
        for (const s of handoff.next_steps) sections.push(`  - ${s}`);
      }
      if (handoff.decisions?.length) {
        sections.push("\n**Decisions made:**");
        for (const d of handoff.decisions) sections.push(`  - ${d}`);
      }
      if (handoff.files_modified?.length) {
        sections.push("\n**Files modified:**");
        for (const f of handoff.files_modified) sections.push(`  - ${f}`);
      }
      if (handoff.blockers?.length) {
        sections.push("\n**Blockers:**");
        for (const b of handoff.blockers) sections.push(`  - ${b}`);
      }
      if (handoff.open_questions?.length) {
        sections.push("\n**Open questions:**");
        for (const q of handoff.open_questions) sections.push(`  - ${q}`);
      }
    }

    if (working) {
      sections.push("\n## Working Memory (cross-session)");
      if (working.user_preferences)     sections.push(`- **Preferences:** ${working.user_preferences}`);
      if (working.codebase_conventions) sections.push(`- **Conventions:** ${working.codebase_conventions}`);
      if (working.persistent_decisions?.length) {
        sections.push("- **Persistent decisions:**");
        for (const d of working.persistent_decisions.slice(-10)) sections.push(`  - ${d}`);
      }
      if (working.frequently_modified_files?.length) {
        sections.push(`- **Hot files:** ${working.frequently_modified_files.slice(0, 10).join(", ")}`);
      }
    }

    return { content: [{ type: "text", text: sections.join("\n") }] };
  },
);

// ── Tool: search ─────────────────────────────────────────────────────────────

/**
 * search — "When did we decide X? What happened with Y?"
 * Full-text search over all session events using SQLite FTS5.
 *
 * Parameters:
 *   query      — FTS5 search query (supports AND, OR, NOT, phrase "exact match")
 *   projectDir — defaults to process.cwd()
 *   limit      — max results, default 10
 */
server.tool(
  "search",
  "Full-text search over session memory. Find past decisions, errors, file changes, and context by keyword.",
  {
    query: z.string().describe('Search query. Supports FTS5 operators: AND, OR, NOT, "phrase search".'),
    projectDir: z.string().optional().describe("Project directory. Defaults to cwd."),
    limit: z.number().int().min(1).max(50).optional().describe("Max results. Default 10."),
  },
  async ({ query, projectDir, limit = 10 }) => {
    const dir = projectDir ?? process.cwd();
    const db = openDb(dir);

    if (!db) {
      return {
        content: [{ type: "text", text: `No session DB found for: ${dir}` }],
      };
    }

    try {
      // Check FTS table exists before querying
      const hasFts = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='session_events_fts'`,
      ).get();

      if (!hasFts) {
        return {
          content: [{ type: "text", text: "FTS index not yet built for this project." }],
        };
      }

      interface EventRow {
        type: string;
        category: string;
        data: string;
        created_at: string;
        session_id: string;
      }

      const rows = db.prepare<[string, number], EventRow>(`
        SELECT e.type, e.category, e.data, e.created_at, e.session_id
        FROM session_events e
        JOIN session_events_fts fts ON e.id = fts.rowid
        WHERE session_events_fts MATCH ?
        ORDER BY e.created_at DESC
        LIMIT ?
      `).all(query, limit);

      if (!rows.length) {
        return { content: [{ type: "text", text: `No results for: "${query}"` }] };
      }

      const lines = [`# Search results for "${query}" (${rows.length} found)\n`];
      for (const row of rows) {
        lines.push(`**[${row.category}/${row.type}]** ${row.created_at.slice(0, 19)}`);
        lines.push(`  ${row.data.slice(0, 300)}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: recent ─────────────────────────────────────────────────────────────

/**
 * recent — "What happened in the last session?"
 * Returns the most recent N session events, optionally filtered by category.
 *
 * Parameters:
 *   projectDir — defaults to process.cwd()
 *   limit      — max events, default 20
 *   category   — filter by category (file, task, decision, error, prompt)
 */
server.tool(
  "recent",
  "Get the most recent session events. Useful for understanding what happened in the last session.",
  {
    projectDir: z.string().optional().describe("Project directory. Defaults to cwd."),
    limit: z.number().int().min(1).max(100).optional().describe("Number of events. Default 20."),
    category: z.enum(["file", "task", "decision", "error", "prompt", "tool"]).optional()
      .describe("Filter by event category."),
  },
  async ({ projectDir, limit = 20, category }) => {
    const dir = projectDir ?? process.cwd();
    const db = openDb(dir);

    if (!db) {
      return { content: [{ type: "text", text: `No session DB found for: ${dir}` }] };
    }

    try {
      interface EventRow {
        type: string;
        category: string;
        data: string;
        created_at: string;
      }

      const rows = category
        ? db.prepare<[string, number], EventRow>(`
            SELECT type, category, data, created_at FROM session_events
            WHERE category = ?
            ORDER BY created_at DESC LIMIT ?
          `).all(category, limit)
        : db.prepare<[number], EventRow>(`
            SELECT type, category, data, created_at FROM session_events
            ORDER BY created_at DESC LIMIT ?
          `).all(limit);

      if (!rows.length) {
        return { content: [{ type: "text", text: "No session events recorded yet." }] };
      }

      const lines = [`# Recent events — ${dir}\n`];
      for (const row of rows) {
        lines.push(`**${row.created_at.slice(0, 19)}** [${row.category}/${row.type}]`);
        lines.push(`  ${row.data.slice(0, 200)}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: graph_query ────────────────────────────────────────────────────────

/**
 * graph_query — "What relates to this file / concept?"
 * BFS traversal of the knowledge graph up to a given depth.
 *
 * Parameters:
 *   label      — node label to start from (file path, concept name, etc.)
 *   projectDir — defaults to process.cwd()
 *   depth      — BFS depth, default 2
 */
server.tool(
  "graph_query",
  "Query the knowledge graph. Find files, concepts, and decisions related to a given topic or file path.",
  {
    label: z.string().describe("Node label to query (file path, concept name, decision keyword)."),
    projectDir: z.string().optional().describe("Project directory. Defaults to cwd."),
    depth: z.number().int().min(1).max(4).optional().describe("BFS traversal depth. Default 2."),
  },
  async ({ label, projectDir, depth = 2 }) => {
    const dir = projectDir ?? process.cwd();
    const db = openDb(dir);

    if (!db) {
      return { content: [{ type: "text", text: `No session DB found for: ${dir}` }] };
    }

    try {
      const hasGraph = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='graph_nodes'`,
      ).get();

      if (!hasGraph) {
        return { content: [{ type: "text", text: "Knowledge graph not yet built for this project." }] };
      }

      interface NodeRow { id: number; type: string; label: string; }
      interface EdgeRow { from_node: number; to_node: number; relation: string; }

      // Find seed node
      const seed = db.prepare<[string, string], NodeRow>(
        `SELECT id, type, label FROM graph_nodes WHERE project_dir = ? AND label LIKE ? LIMIT 1`,
      ).get(dir, `%${label}%`);

      if (!seed) {
        return { content: [{ type: "text", text: `No graph node found matching: "${label}"` }] };
      }

      // BFS traversal
      const visited = new Set<number>([seed.id]);
      const queue: Array<{ id: number; depth: number }> = [{ id: seed.id, depth: 0 }];
      const results: string[] = [`# Knowledge graph — "${label}"\n`, `**Seed:** [${seed.type}] ${seed.label}\n`];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.depth >= depth) continue;

        const edges = db.prepare<[number, number, string], EdgeRow & { neighbor_label: string; neighbor_type: string }>(
          `SELECT e.from_node, e.to_node, e.relation, n.label as neighbor_label, n.type as neighbor_type
           FROM graph_edges e
           JOIN graph_nodes n ON (e.to_node = n.id OR e.from_node = n.id)
           WHERE (e.from_node = ? OR e.to_node = ?) AND e.project_dir = ?
           LIMIT 20`,
        ).all(current.id, current.id, dir);

        for (const edge of edges) {
          const neighborId = edge.from_node === current.id ? edge.to_node : edge.from_node;
          if (visited.has(neighborId)) continue;
          visited.add(neighborId);

          const indent = "  ".repeat(current.depth + 1);
          results.push(`${indent}→ **${edge.relation}** [${edge.neighbor_type}] ${edge.neighbor_label}`);
          queue.push({ id: neighborId, depth: current.depth + 1 });
        }
      }

      if (results.length === 2) results.push("No connected nodes found.");

      return { content: [{ type: "text", text: results.join("\n") }] };
    } finally {
      db.close();
    }
  },
);

// ── Start server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[engram-cc] MCP server running on stdio");
}

main().catch(err => {
  console.error("[engram] Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
