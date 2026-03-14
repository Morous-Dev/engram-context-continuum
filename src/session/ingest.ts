import { createHash } from "node:crypto";
import type { SessionEvent } from "./extract.js";
import { extractEvents, extractUserEvents } from "./extract.js";
import { SessionDB } from "./db.js";
import { buildResumeSnapshot } from "./snapshot.js";
import { auditSessionEvents } from "../tokenization/auditor.js";
import { getCompressor, getHardwareProfile } from "../compression/index.js";
import { generateCompactBrief } from "./compact-brief.js";
import {
  buildRetrievalQuery,
  formatEngramsForContext,
  retrieveEngrams,
} from "./engram-retrieval.js";
import { VectorDB } from "../memory/vector.js";
import { GraphDB, updateGraphFromEvents } from "../memory/graph.js";
import {
  readWorkingMemory,
  mergeWorkingMemory,
  writeWorkingMemory,
} from "../memory/working.js";
import { buildHandoffFromEvents, writeHandoff } from "../handoff/writer.js";
import { extractTranscriptContext } from "../handoff/dedup.js";
import type { ECCIngestEvent } from "./ingest-types.js";
import { getProjectDBPath } from "../project-id.js";

const RETRIEVAL_TRIGGERS = new Set(["AskUserQuestion", "Edit", "Write", "Bash"]);
const RETRIEVAL_SKIP = new Set([
  "Read",
  "Glob",
  "Grep",
  "Skill",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);
const LIVE_INDEX_CATEGORIES = new Set(["decision", "error", "task", "rule"]);
const POST_TOOL_DISTANCE_THRESHOLD = 0.65;
const PROMPT_DISTANCE_THRESHOLD = 0.6;

export interface IngestResult {
  stored: boolean;
  additionalContext?: string;
}

export interface CompactionResult {
  snapshot: string;
  slm_brief: string | null;
  engram_context: string | null;
  hardware_profile: string;
}

function getDb(event: ECCIngestEvent): SessionDB {
  return new SessionDB({ dbPath: getProjectDBPath(event.project_dir) });
}

function getSourceHook(eventType: ECCIngestEvent["event_type"]): string {
  switch (eventType) {
    case "session_start":
      return "SessionStart";
    case "user_prompt_submit":
      return "UserPromptSubmit";
    case "pre_tool_use":
      return "PreToolUse";
    case "post_tool_use":
      return "PostToolUse";
    case "pre_compact":
      return "PreCompact";
    case "stop":
      return "Stop";
  }
}

function toToolResponse(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildToolContext(toolName: string, toolInput?: Record<string, unknown>): string {
  const inputText = toolInput ? JSON.stringify(toolInput) : "";
  return `${toolName} ${inputText}`.trim().slice(0, 1000);
}

async function withProjectRuntime<T>(projectDir: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.ENGRAM_PROJECT_DIR;
  process.env.ENGRAM_PROJECT_DIR = projectDir;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_PROJECT_DIR;
    else process.env.ENGRAM_PROJECT_DIR = previous;
  }
}

function storeEvents(db: SessionDB, event: ECCIngestEvent, events: SessionEvent[]): boolean {
  if (events.length === 0) return false;

  const sourceHook = getSourceHook(event.event_type);
  for (const extracted of events) {
    db.insertEvent(event.session_id, extracted, sourceHook, {
      sourceAssistant: event.assistant,
      sourceKind: event.source_kind,
      sourceConfidence: event.confidence,
    });
  }
  return true;
}

async function liveIndexEvents(
  dbPath: string,
  sessionId: string,
  events: SessionEvent[],
): Promise<void> {
  const indexTargets = events.filter((candidate) =>
    LIVE_INDEX_CATEGORIES.has(candidate.category) ||
    (candidate.category === "prompt" && candidate.priority === 1),
  );
  if (indexTargets.length === 0) return;

  const compressor = getCompressor();
  const result = await compressor.embed(indexTargets.map((candidate) => candidate.data));
  if (result.embeddings.length !== indexTargets.length || result.dimensions === 0) return;

  const vectorDB = new VectorDB(dbPath);
  try {
    if (!vectorDB.isAvailable()) return;

    for (let i = 0; i < indexTargets.length; i++) {
      const candidate = indexTargets[i];
      const embedding = result.embeddings[i];
      if (!candidate || !embedding) continue;

      const contentHash = createHash("sha256").update(candidate.data).digest("hex").slice(0, 32);
      vectorDB.upsert(
        `${sessionId}:live:${contentHash}`,
        embedding,
        candidate.data,
        { session_id: sessionId, category: candidate.category, type: candidate.type },
      );
    }
  } finally {
    vectorDB.close();
  }
}

async function buildSemanticContext(
  db: SessionDB,
  dbPath: string,
  queryText: string,
  opts: {
    distanceThreshold: number;
    vectorOnly?: boolean;
    sourceLabel: string;
  },
): Promise<string> {
  const trimmed = queryText.trim();
  if (trimmed.length < 16) return "";

  const memories: Array<{
    content: string;
    category: string;
    confidence: number;
    source: "vector" | "fts";
  }> = [];

  try {
    const vectorDB = new VectorDB(dbPath);
    try {
      if (vectorDB.isAvailable()) {
        const compressor = getCompressor();
        const embedResult = await compressor.embed([trimmed]);
        const embedding = embedResult.embeddings[0];
        if (embedding && embedResult.dimensions > 0) {
          const results = vectorDB.search(embedding, 5);
          for (const result of results) {
            if (result.distance >= opts.distanceThreshold) continue;
            const meta = result.metadata;
            memories.push({
              content: result.content,
              category: typeof meta.category === "string" ? meta.category : "memory",
              confidence: Math.max(0, 1 - result.distance),
              source: "vector",
            });
          }
        }
      }
    } finally {
      vectorDB.close();
    }
  } catch {
    // Retrieval is best-effort.
  }

  if (!opts.vectorOnly) {
    try {
      const baseTerms = trimmed.toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((term) => term.length >= 4)
        .slice(0, 6);

      let expandedTerms: string[] = [];
      try {
        const { expandQuery } = await import("../retrieval/query-expander.js");
        expandedTerms = await expandQuery(trimmed);
      } catch {
        expandedTerms = [];
      }

      const allTerms = [...new Set([...baseTerms, ...expandedTerms])].slice(0, 12);
      if (allTerms.length > 0) {
        const ftsQuery = allTerms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
        const results = db.searchEvents(ftsQuery, 8);
        for (const result of results) {
          const confidence = Math.min(1, Math.abs(result.rank) / 20);
          if (confidence < 0.35) continue;
          memories.push({
            content: result.data,
            category: result.category,
            confidence,
            source: "fts",
          });
        }
      }
    } catch {
      // Retrieval is best-effort.
    }
  }

  const deduped = new Map<string, typeof memories[number]>();
  for (const memory of memories) {
    const key = memory.content.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
    const existing = deduped.get(key);
    if (!existing || memory.confidence > existing.confidence) {
      deduped.set(key, memory);
    }
  }

  const top = [...deduped.values()]
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 5);

  if (top.length === 0) return "";

  const lines = [`<subconscious_context source="${opts.sourceLabel}" count="${top.length}">`];
  for (const memory of top) {
    const safe = memory.content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    lines.push(
      `  <memory category="${memory.category}" confidence="${memory.confidence.toFixed(2)}" source="${memory.source}">${safe}</memory>`,
    );
  }
  lines.push("</subconscious_context>");
  return lines.join("\n");
}

function shouldRetrieveToolContext(toolName: string): boolean {
  return RETRIEVAL_TRIGGERS.has(toolName) && !RETRIEVAL_SKIP.has(toolName);
}

export async function ingestEvent(event: ECCIngestEvent): Promise<IngestResult> {
  return withProjectRuntime(event.project_dir, async () => {
    const db = getDb(event);
    db.ensureSession(event.session_id, event.project_dir);

    let stored = false;
    let additionalContext = "";

    try {
      if (event.payload.kind === "session_start") {
        return { stored: false };
      }

      if (event.payload.kind === "pre_tool_use" || event.payload.kind === "post_tool_use") {
        const toolResult = toToolResponse(event.payload.tool_result);
        const extracted = event.payload.extracted_events.length > 0
          ? event.payload.extracted_events
          : (
            event.payload.kind === "post_tool_use" &&
            event.source_kind === "wrapper" &&
            event.confidence === "inferred"
          )
            ? []
            : extractEvents({
              assistant: event.assistant,
              tool_name: event.payload.tool_name,
              tool_input: event.payload.tool_input ?? {},
              tool_response: toolResult,
              tool_output: event.payload.tool_output && typeof event.payload.tool_output === "object"
                ? event.payload.tool_output as { isError?: boolean }
                : toolResult ? undefined : { isError: false },
            });

        if (extracted.length > 0) {
          stored = storeEvents(db, event, extracted);
        } else if (event.payload.kind === "post_tool_use") {
          stored = storeEvents(db, event, [{
            type: "tool_use",
            category: "tool",
            data: buildToolContext(event.payload.tool_name, event.payload.tool_input),
            priority: 3,
          }]);
        }

        if (process.env.ENGRAM_SUBCONSCIOUS !== "0") {
          const dbPath = getProjectDBPath(event.project_dir);
          const shouldLiveIndex =
            event.payload.kind === "post_tool_use" &&
            event.source_kind === "native_hook" &&
            event.confidence === "exact" &&
            extracted.length > 0;

          if (shouldLiveIndex) {
            try {
              await liveIndexEvents(dbPath, event.session_id, extracted);
            } catch {
              // Indexing is best-effort.
            }
          }

          if (shouldRetrieveToolContext(event.payload.tool_name)) {
            const queryText = extracted.length > 0
              ? extracted.map((candidate) => candidate.data).join(" ").slice(0, 1000)
              : buildToolContext(event.payload.tool_name, event.payload.tool_input);
            additionalContext = await buildSemanticContext(db, dbPath, queryText, {
              distanceThreshold: POST_TOOL_DISTANCE_THRESHOLD,
              sourceLabel: "engram_retrieval",
            });
          }
        }
      }

      return additionalContext ? { stored, additionalContext } : { stored };
    } finally {
      db.close();
    }
  });
}

export async function ingestPrompt(event: ECCIngestEvent): Promise<IngestResult> {
  if (event.payload.kind !== "user_prompt_submit") {
    return { stored: false };
  }

  const promptPayload = event.payload;
  const message = promptPayload.message.trim();
  if (!message) return { stored: false };

  return withProjectRuntime(event.project_dir, async () => {
    const db = getDb(event);
    db.ensureSession(event.session_id, event.project_dir);

    try {
      let stored = false;
      stored = storeEvents(db, event, [{
        type: "user_prompt",
        category: "prompt",
        data: promptPayload.message,
        priority: 1,
      }]) || stored;

      const extracted = promptPayload.extracted_events.length > 0
        ? promptPayload.extracted_events
        : extractUserEvents(message);
      stored = storeEvents(db, event, extracted) || stored;

      if (process.env.ENGRAM_SUBCONSCIOUS === "0" || message.length <= 20) {
        return { stored };
      }

      const additionalContext = await buildSemanticContext(
        db,
        getProjectDBPath(event.project_dir),
        message.slice(0, 1000),
        {
          distanceThreshold: PROMPT_DISTANCE_THRESHOLD,
          vectorOnly: true,
          sourceLabel: "semantic_memory",
        },
      );
      return additionalContext ? { stored, additionalContext } : { stored };
    } finally {
      db.close();
    }
  });
}

export async function prepareCompaction(event: ECCIngestEvent): Promise<CompactionResult> {
  return withProjectRuntime(event.project_dir, async () => {
    const db = getDb(event);
    db.ensureSession(event.session_id, event.project_dir);

    try {
      const allEvents = db.getEvents(event.session_id);
      if (allEvents.length === 0) {
        return {
          snapshot: "",
          slm_brief: null,
          engram_context: null,
          hardware_profile: getHardwareProfile(),
        };
      }

      const { cleanedEvents } = auditSessionEvents(allEvents);
      const stats = db.getSessionStats(event.session_id);
      const archiveEvents = db.getArchiveEvents(event.session_id);
      const compactCount = event.payload.kind === "pre_compact" && event.payload.compact_count > 0
        ? event.payload.compact_count
        : (stats?.compact_count ?? 0) + 1;

      const snapshot = buildResumeSnapshot(cleanedEvents, {
        compactCount,
        archiveEvents,
      });
      const resumeChain = db.getResumeChain(event.session_id);

      const hardwareProfile = getHardwareProfile();

      const slmBriefTask = async (): Promise<{ brief: string | null; structured: string | null }> => {
        try {
          const result = await generateCompactBrief(cleanedEvents, {
            compactCount,
            sessionId: event.session_id,
            projectDir: event.project_dir,
            resumeChain,
          });
          return {
            brief: result.brief,
            structured: result.structured ? JSON.stringify(result.structured) : null,
          };
        } catch {
          return { brief: null, structured: null };
        }
      };

      const engramTask = async (): Promise<string | null> => {
        try {
          const dbPath = getProjectDBPath(event.project_dir);
          const vectorDB = new VectorDB(dbPath);
          let graphDB: GraphDB | null = null;
          try {
            graphDB = new GraphDB(dbPath);
          } catch {
            graphDB = null;
          }

          try {
            const { queryText, ftsTerms, graphSeeds } = buildRetrievalQuery(cleanedEvents);
            if (queryText.length <= 20) return null;

            const compressor = getCompressor();
            const result = await retrieveEngrams(
              queryText,
              ftsTerms,
              graphSeeds,
              vectorDB,
              db,
              graphDB ? {
                findNode: (projectDir, label) => graphDB.findNode(projectDir, label),
                getNeighbors: (id, depth) => graphDB.getNeighbors(id, depth),
                getNodes: (projectDir, type, limit) =>
                  graphDB.getNodes(projectDir, type as "file" | "decision" | "rule" | "concept" | "task" | "error" | undefined, limit),
              } : null,
              event.project_dir,
              (texts) => compressor.embed(texts),
            );
            return result.engrams.length > 0 ? formatEngramsForContext(result) : null;
          } finally {
            vectorDB.close();
            graphDB?.close();
          }
        } catch {
          return null;
        }
      };

      const [slmResult, engramContext] =
        hardwareProfile === "power" || hardwareProfile === "extreme"
          ? await Promise.all([slmBriefTask(), engramTask()])
          : [await slmBriefTask(), await engramTask()];
      const slmBrief = slmResult.brief;
      const structuredHandoff = slmResult.structured;

      db.upsertResume(event.session_id, snapshot, allEvents.length, slmBrief, engramContext);
      db.appendResumeHistory(
        event.session_id,
        compactCount,
        snapshot,
        slmBrief,
        structuredHandoff,
        allEvents.length,
      );
      db.incrementCompactCount(event.session_id);

      return {
        snapshot,
        slm_brief: slmBrief,
        engram_context: engramContext,
        hardware_profile: hardwareProfile,
      };
    } finally {
      db.close();
    }
  });
}

export async function runStopPipeline(event: ECCIngestEvent): Promise<void> {
  await withProjectRuntime(event.project_dir, async () => {
    const db = getDb(event);

    try {
      const events = db.getEvents(event.session_id);
      const resumeChain = db.getResumeChain(event.session_id);
      const { cleanedEvents } = auditSessionEvents(events);
      const transcriptPath = event.payload.kind === "stop" ? event.payload.transcript_path : undefined;

      let transcriptContext = null;
      try {
        transcriptContext = transcriptPath ? extractTranscriptContext(transcriptPath) : null;
      } catch {
        transcriptContext = null;
      }

      const workingMem = readWorkingMemory(event.project_dir);
      const compressor = getCompressor();
      const handoffData = await buildHandoffFromEvents(
        event.session_id,
        event.project_dir,
        cleanedEvents,
        workingMem,
        transcriptContext,
        compressor,
        resumeChain,
        {
          writtenBy: event.assistant,
          sourceKind: event.source_kind,
          sourceConfidence: event.confidence,
        },
      );
      writeHandoff(handoffData, event.project_dir);

      const dbPath = getProjectDBPath(event.project_dir);

      try {
        const graphDB = new GraphDB(dbPath);
        try {
          updateGraphFromEvents(graphDB, event.project_dir, event.session_id, cleanedEvents);
        } finally {
          graphDB.close();
        }
      } catch {
        // Stop path is best-effort.
      }

      try {
        const vectorDB = new VectorDB(dbPath);
        try {
          if (vectorDB.isAvailable()) {
            const embedTargets = cleanedEvents.filter(
              (candidate) => candidate.category === "decision"
                || candidate.category === "error"
                || candidate.category === "task"
                || candidate.category === "rule"
                || (candidate.category === "prompt" && candidate.priority === 1)
                || (
                  candidate.category === "file" &&
                  candidate.priority === 1 &&
                  (candidate.type === "file_write" || candidate.type === "file_edit")
                ),
            ).slice(-50);

            if (embedTargets.length > 0) {
              const result = await compressor.embed(embedTargets.map((candidate) => candidate.data));
              if (result.embeddings.length === embedTargets.length && result.dimensions > 0) {
                for (let i = 0; i < result.embeddings.length; i++) {
                  const candidate = embedTargets[i];
                  const embedding = result.embeddings[i];
                  if (!candidate || !embedding) continue;
                  vectorDB.upsert(
                    `${event.session_id}:${candidate.id ?? i}`,
                    embedding,
                    candidate.data,
                    {
                      session_id: event.session_id,
                      category: candidate.category,
                      type: candidate.type,
                      source_assistant: candidate.source_assistant,
                      source_kind: candidate.source_kind,
                      source_confidence: candidate.source_confidence,
                    },
                  );
                }
              }
            }
          }
        } finally {
          vectorDB.close();
        }
      } catch {
        // Stop path is best-effort.
      }

      const filesModified = cleanedEvents
        .filter((candidate) => candidate.type === "file_write" || candidate.type === "file_edit")
        .map((candidate) => candidate.data);
      const decisions = cleanedEvents
        .filter((candidate) => candidate.category === "decision")
        .map((candidate) => candidate.data.slice(0, 200));
      const updatedWorking = mergeWorkingMemory(workingMem, {
        sessionId: event.session_id,
        projectDir: event.project_dir,
        decisions,
        filesModified,
        lastWrittenBy: event.assistant,
      });
      writeWorkingMemory(event.project_dir, updatedWorking);
    } finally {
      db.close();
    }
  });
}
