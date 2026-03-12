/**
 * test-diffmode.mjs — Quick validation of grammar-constrained JSON (diff-mode).
 *
 * Tests that both GGUF models produce valid, parseable structured handoff JSON
 * via the GBNF grammar. Uses a realistic session input and verifies:
 *   1. Grammar creation succeeds
 *   2. Model output is valid JSON conforming to the schema
 *   3. Parsed output has correct enum values (UNRESOLVED, not free text)
 *   4. current_task is populated
 *
 * Run via: node benchmark/test-diffmode.mjs
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const MODELS_DIR = join(homedir(), '.engram-cc', 'models');

const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    current_task: { type: "string" },
    task_status: { type: "string", enum: ["IN_PROGRESS", "BLOCKED", "COMPLETE"] },
    synthesis: { type: "string" },
    decisions: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          decision: { type: "string" },
          status: { type: "string", enum: ["FINAL", "TENTATIVE", "REVERTED"] },
        },
      },
    },
    errors: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          status: { type: "string", enum: ["UNRESOLVED", "RESOLVED", "RECURRED"] },
        },
      },
    },
    next_session: { type: "string" },
  },
};

const TEST_INPUT = `Current task: Fix race condition in WebSocket message ordering
Last action: Added mutex lock around message queue push

User requests (chronological):
- Fix the WebSocket ordering bug reported by QA
- Try mutex approach first, then SharedArrayBuffer if needed

Decisions made:
- Use mutex for message ordering (decided over channel-based approach)
- SharedArrayBuffer blocked by missing COOP/COEP headers

Unresolved errors:
- Race condition persists under 50-client load test (mutex only protects push, not sequence assignment)

Resolved errors: 0 fixed`;

function buildDiffModePrompt(text) {
  return [
    `Extract structured handoff data from this developer session log.`,
    `Fill each JSON field based ONLY on explicit facts in the session data.`,
    ``,
    `RULES:`,
    `1. current_task: The LAST active, incomplete task — not the most-mentioned one.`,
    `2. task_status: IN_PROGRESS unless explicitly blocked or confirmed complete.`,
    `3. decisions: Only FINAL decisions. If a decision changed, report only the latest.`,
    `4. errors.status: UNRESOLVED unless the log explicitly confirms the fix succeeded.`,
    `   If an error appeared fixed then recurred, use RECURRED.`,
    `5. synthesis: 2-3 sentence factual summary of the session's key outcomes.`,
    `6. next_session: What the next engineer should start with.`,
    `7. Do NOT infer or extrapolate — state only facts present in the session data.`,
    ``,
    `<session_data>`,
    text,
    `</session_data>`,
    ``,
    `[FOCUS: current_task is the LAST active task. Default error status to UNRESOLVED.]`,
  ].join('\n');
}

const MODELS = [
  {
    id: 'llama',
    label: 'Llama 3.2 3B',
    file: 'llama-3.2-3b-instruct-q5_k_m.gguf',
    noThink: false,
    ctxOpts: { contextSize: 4096 },
  },
  {
    id: 'qwen',
    label: 'Qwen 3.5 2B',
    file: 'qwen3.5-2b-q5_k_m.gguf',
    noThink: true,
    ctxOpts: { contextSize: 4096, ignoreMemorySafetyChecks: true },
  },
];

console.log('');
console.log('═'.repeat(60));
console.log('  DIFF-MODE (Grammar-Constrained JSON) Validation');
console.log('═'.repeat(60));

let llamaCpp;
try {
  llamaCpp = await import('node-llama-cpp');
} catch (e) {
  console.error('  node-llama-cpp not available:', e.message);
  process.exit(1);
}

for (const m of MODELS) {
  const modelPath = join(MODELS_DIR, m.file);
  if (!existsSync(modelPath)) {
    console.log(`\n  [SKIP] ${m.label} — model not found`);
    continue;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Testing: ${m.label}`);

  let llama, model, ctx, grammar, session;
  try {
    llama = await llamaCpp.getLlama();
    model = await llama.loadModel({ modelPath });
    ctx = await model.createContext(m.ctxOpts);

    console.log('  ✓ Model loaded');

    // Create grammar
    grammar = await llama.createGrammarForJsonSchema(HANDOFF_SCHEMA);
    console.log('  ✓ Grammar created');

    session = new llamaCpp.LlamaChatSession({ contextSequence: ctx.getSequence() });

    const prompt = m.noThink
      ? `/no_think\n\n${buildDiffModePrompt(TEST_INPUT)}`
      : buildDiffModePrompt(TEST_INPUT);

    const t0 = Date.now();
    const raw = await session.prompt(prompt, {
      maxTokens: 800,   // JSON is more token-heavy than prose; prevent truncation
      temperature: 0.1,
      topK: 1,
      repeatPenalty: 1.05,
      grammar,
    });
    const ms = Date.now() - t0;

    console.log(`  ✓ Inference complete (${ms}ms)`);
    console.log(`  Raw output length: ${raw.length} chars`);

    // Parse — handle truncated JSON from token limit gracefully
    let parsed;
    try {
      parsed = grammar.parse(raw);
    } catch {
      // Try raw JSON.parse (grammar.parse may be stricter)
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Truncated JSON — try closing brackets
        let fixed = raw;
        const opens = (raw.match(/[{[]/g) || []).length;
        const closes = (raw.match(/[}\]]/g) || []).length;
        for (let i = 0; i < opens - closes; i++) {
          fixed += fixed.includes('[') && !fixed.endsWith(']') ? ']}' : '}';
        }
        try {
          parsed = JSON.parse(fixed);
          console.log('  ⚠ JSON was truncated, recovered with bracket closing');
        } catch (e2) {
          console.log(`  ✗ JSON parse failed even after recovery: ${e2.message}`);
          console.log(`  Raw (last 200): ...${raw.slice(-200)}`);
          parsed = null;
        }
      }
    }
    console.log('  ✓ JSON parsed successfully');
    console.log('');
    console.log('  Structured output:');
    console.log(JSON.stringify(parsed, null, 2).split('\n').map(l => `    ${l}`).join('\n'));

    if (!parsed) {
      console.log('\n  Result: PARSE FAILED ✗');
      continue;
    }

    // Validate
    const checks = [];
    checks.push(['current_task populated', !!parsed.current_task]);
    checks.push(['task_status is valid enum', ['IN_PROGRESS', 'BLOCKED', 'COMPLETE'].includes(parsed.task_status)]);
    checks.push(['synthesis populated', !!parsed.synthesis]);
    checks.push(['has decisions array', Array.isArray(parsed.decisions)]);
    checks.push(['has errors array', Array.isArray(parsed.errors)]);
    checks.push(['next_session populated', !!parsed.next_session]);

    if (parsed.errors?.length > 0) {
      checks.push(['error status is enum', ['UNRESOLVED', 'RESOLVED', 'RECURRED'].includes(parsed.errors[0].status)]);
      checks.push(['error not falsely RESOLVED', parsed.errors[0].status !== 'RESOLVED']);
    }

    console.log('');
    let allPassed = true;
    for (const [name, ok] of checks) {
      console.log(`  ${ok ? '✓' : '✗'} ${name}`);
      if (!ok) allPassed = false;
    }
    console.log(`\n  Result: ${allPassed ? 'ALL CHECKS PASSED ✓' : 'SOME CHECKS FAILED ✗'}`);

  } catch (err) {
    console.error(`  ✗ Error: ${err.message}`);
  } finally {
    try { await ctx?.dispose(); } catch {}
    try { await model?.dispose(); } catch {}
    try { await llama?.dispose(); } catch {}
  }
}

console.log('\n' + '═'.repeat(60));
