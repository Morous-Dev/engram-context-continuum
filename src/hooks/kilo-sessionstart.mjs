#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * kilo-sessionstart.mjs — SessionStart hook for Kilo CLI.
 *
 * Responsible for: reading handoff.yaml and working.yaml from .engram-cc/,
 * formatting them as Kilo-readable context, and writing to kilo-context.md.
 * Kilo can be configured to load this file via the `instructions` config option.
 *
 * Depends on: suppress-stderr.mjs, session-helpers.mjs,
 *             build/handoff/reader.js, build/memory/working.js.
 * Depended on by: ekilo wrapper integration.
 */

import {
  getProjectDir,
} from "./session-helpers.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, existsSync } from "node:fs";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HOOK_DIR, "..", "..");
const BUILD_HANDOFF = join(PROJECT_ROOT, "build", "handoff");
const BUILD_MEMORY = join(PROJECT_ROOT, "build", "memory");

const KILO_CONTEXT_FILE = "kilo-context.md";

function escapeXML(s) {
  if (typeof s !== "string") return String(s);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function main() {
  const projectDir = getProjectDir();
  const dataDir = join(projectDir, ".engram-cc");
  const contextPath = join(dataDir, KILO_CONTEXT_FILE);
  let contextContent = "";

  try {
    const { readHandoff } = await import(
      pathToFileURL(join(BUILD_HANDOFF, "reader.js")).href
    );
    const handoff = readHandoff(projectDir, 15 * 60 * 1000); // 15 min max age

    if (handoff) {
      const handoffAge = Date.now() - new Date(handoff.timestamp).getTime();
      const ageMins = Math.round(handoffAge / 60000);

      contextContent += `## Previous Session Context\n\n`;
      contextContent += `**Session:** ${handoff.session_id}\n`;
      contextContent += `**Time since last session:** ${ageMins} minutes\n\n`;

      if (handoff.current_task) {
        contextContent += `**Current Task:** ${escapeXML(handoff.current_task)}\n\n`;
      }

      if (handoff.last_action) {
        contextContent += `**Last Action:** ${escapeXML(handoff.last_action)}\n\n`;
      }

      if (handoff.working_context) {
        contextContent += `**Working Context:**\n${escapeXML(handoff.working_context)}\n\n`;
      }

      if (handoff.next_steps && handoff.next_steps.length > 0) {
        contextContent += `**Next Steps:**\n`;
        for (const step of handoff.next_steps) {
          contextContent += `- ${escapeXML(step)}\n`;
        }
        contextContent += `\n`;
      }

      if (handoff.decisions && handoff.decisions.length > 0) {
        contextContent += `**Key Decisions:**\n`;
        for (const decision of handoff.decisions) {
          contextContent += `- ${escapeXML(decision)}\n`;
        }
        contextContent += `\n`;
      }

      if (handoff.files_modified && handoff.files_modified.length > 0) {
        contextContent += `**Files Modified:**\n`;
        for (const file of handoff.files_modified.slice(0, 10)) {
          contextContent += `- ${escapeXML(file)}\n`;
        }
        if (handoff.files_modified.length > 10) {
          contextContent += `- ... and ${handoff.files_modified.length - 10} more\n`;
        }
        contextContent += `\n`;
      }

      if (handoff.errors_encountered && handoff.errors_encountered.length > 0) {
        contextContent += `**Errors Encountered:**\n`;
        for (const err of handoff.errors_encountered) {
          contextContent += `- ${escapeXML(err)}\n`;
        }
        contextContent += `\n`;
      }

      if (handoff.blockers && handoff.blockers.length > 0) {
        contextContent += `**Blockers:**\n`;
        for (const blocker of handoff.blockers) {
          contextContent += `- ${escapeXML(blocker)}\n`;
        }
        contextContent += `\n`;
      }

      if (handoff.open_questions && handoff.open_questions.length > 0) {
        contextContent += `**Open Questions:**\n`;
        for (const q of handoff.open_questions) {
          contextContent += `- ${escapeXML(q)}\n`;
        }
        contextContent += `\n`;
      }

      console.error(`[EngramCC:kilo-sessionstart] loaded handoff (${ageMins}min old)`);
    } else {
      console.error(`[EngramCC:kilo-sessionstart] no recent handoff found`);
    }
  } catch (err) {
    console.error(`[EngramCC:kilo-sessionstart] handoff load failed:`, err?.message || err);
  }

  try {
    const { readWorkingMemory } = await import(
      pathToFileURL(join(BUILD_MEMORY, "working.js")).href
    );
    const workingMem = readWorkingMemory(projectDir);

    if (workingMem) {
      contextContent += `## Project Context\n\n`;

      if (workingMem.user_preferences) {
        contextContent += `**User Preferences:**\n${escapeXML(workingMem.user_preferences)}\n\n`;
      }

      if (workingMem.codebase_conventions) {
        contextContent += `**Codebase Conventions:**\n${escapeXML(workingMem.codebase_conventions)}\n\n`;
      }

      if (workingMem.persistent_decisions && workingMem.persistent_decisions.length > 0) {
        contextContent += `**Persistent Decisions:**\n`;
        for (const decision of workingMem.persistent_decisions) {
          contextContent += `- ${escapeXML(decision)}\n`;
        }
        contextContent += `\n`;
      }

      if (workingMem.frequently_modified_files && workingMem.frequently_modified_files.length > 0) {
        contextContent += `**Frequently Modified Files:**\n`;
        for (const file of workingMem.frequently_modified_files) {
          contextContent += `- ${escapeXML(file)}\n`;
        }
        contextContent += `\n`;
      }

      console.error(`[EngramCC:kilo-sessionstart] loaded working memory`);
    }
  } catch (err) {
    console.error(`[EngramCC:kilo-sessionstart] working memory load failed:`, err?.message || err);
  }

  if (contextContent) {
    const header = `# Engram Context Continuum — Session Context\n\n`;
    const footer = `\n\n---\n*This context is auto-generated by Engram CC. Do not edit manually.*\n`;
    writeFileSync(contextPath, header + contextContent + footer, "utf-8");
    console.error(`[EngramCC:kilo-sessionstart] wrote context to ${KILO_CONTEXT_FILE}`);
  } else {
    if (existsSync(contextPath)) {
      // Keep existing context file if no new data
      console.error(`[EngramCC:kilo-sessionstart] no new context, keeping existing`);
    }
  }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "",
    },
  }));
}

main().catch((err) => {
  console.error(`[EngramCC:kilo-sessionstart] fatal error:`, err?.message || err);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "",
    },
  }));
});
