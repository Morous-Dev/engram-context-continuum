/**
 * test-models.mjs — SLM quality comparison benchmark.
 *
 * Responsible for: running the 3-test quality suite against all local GGUF
 * models and printing a side-by-side scorecard. Used to evaluate candidate
 * models before promoting them to a production compression tier.
 *
 * Tests:
 *   T1 — Conflict resolution: must report FINAL decision (Tailwind, not Bootstrap)
 *   T2 — Error truthfulness: must NOT claim an unresolved error was fixed
 *   T3 — Intent extraction: must identify current task correctly
 *
 * Depends on: node-llama-cpp, build/compression/index.js
 * Run via: node benchmark/test-models.mjs
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const MODELS_DIR = join(homedir(), '.engram-cc', 'models');
const BUILD      = join(process.cwd(), 'build');

// ── Models to test ────────────────────────────────────────────────────────────

const MODELS = [
  {
    id:        'llama3.2-3b',
    label:     'Llama 3.2 3B  (tier3,  incumbent)',
    file:      'llama-3.2-3b-instruct-q5_k_m.gguf',
    incumbent: true,
    noThink:   false,
  },
  {
    id:        'smollm3-3b',
    label:     'SmolLM3 3B    (rejected — incompatible)',
    file:      'smollm3-3b-q5_k_m.gguf',
    incumbent: false,
    // SmolLM3 produces empty output in both GPU and CPU modes regardless of
    // /no_think. Root cause: non-standard chat template incompatible with
    // LlamaChatSession. Retained here so the incompatibility is documented.
    noThink:   true,
  },
  {
    id:        'qwen3.5-2b',
    label:     'Qwen 3.5 2B   (tier3b, candidate)',
    file:      'qwen3.5-2b-q5_k_m.gguf',
    incumbent: false,
    // Qwen 3.5 2B has thinking mode — /no_think disables it for direct output.
    // GPU-then-CPU fallback is handled inside tier3b.ts; the test uses the
    // same prompt as production.
    noThink:   true,
  },
];

// ── Archivist prompt ──────────────────────────────────────────────────────────

/**
 * Same prompt used in production (tier3.ts buildCompressionPrompt).
 * Must stay in sync with src/compression/tier3.ts.
 */
function buildPrompt(sessionData) {
  const wordCount = sessionData.split(/\s+/).length;
  const targetWords = Math.floor(wordCount / 3);
  return [
    `You are a session archivist. Produce a concise handoff brief for the next coding session.`,
    `Write ${targetWords} words max. Output ONLY prose — no bullet lists, no file lists, no headings.`,
    ``,
    `Rules:`,
    `- Describe WHAT was done and WHY, not which files were touched (file list is stored separately)`,
    `- Name specific bugs fixed, features added, or architectural changes made`,
    `- If decisions conflict, report only the FINAL decision`,
    `- If an error was resolved, say "resolved" — don't re-report the error`,
    `- End with what is unfinished or what the next session should start with`,
    ``,
    `Session data:`,
    sessionData,
    ``,
    `Brief:`,
  ].join('\n');
}

// ── Test cases ────────────────────────────────────────────────────────────────

const TESTS = [
  {
    id: 'T1',
    name: 'Conflict resolution — final decision wins',
    input: `
Decisions made this session:
- Use Bootstrap for the component library
- Actually Bootstrap is too heavy, switch to Tailwind CSS instead
- Confirmed: Tailwind CSS is the final choice for all styling

Work done:
- Installed Bootstrap v5 (npm install bootstrap)
- Removed Bootstrap, installed Tailwind CSS (npm install tailwindcss)
- Configured tailwind.config.js
- Updated all component className attributes from Bootstrap to Tailwind
`.trim(),
    /**
     * Pass if output contains "tailwind" (final choice) AND does not contain
     * a claim that Bootstrap is current/final.
     */
    evaluate(output) {
      const lower = output.toLowerCase();
      const hasTailwind = lower.includes('tailwind');
      const hasBootstrapAsFinal =
        /bootstrap\s+(is|as)\s+(the\s+)?(final|current|chosen|selected|our)/i.test(output) ||
        /finali[sz]ed.{0,30}bootstrap/i.test(output) ||
        /settled.{0,30}bootstrap/i.test(output);
      return hasTailwind && !hasBootstrapAsFinal;
    },
    hint: 'Must say Tailwind (not Bootstrap) is the CSS framework',
  },
  {
    id: 'T2',
    name: 'Error truthfulness — unresolved error stays open',
    input: `
Current task: Fix authentication middleware

Errors encountered:
- Error: Cannot read properties of undefined reading 'headers' at extractToken (auth.ts:12) — happens on WebSocket connections

What was tried:
- Read Apollo Server WebSocket docs
- Edited auth.ts to check for connectionParams
- Error: Cannot read properties of undefined reading 'headers' at extractToken (auth.ts:12) — still failing after the edit attempt

The error was NOT resolved. It is still open.
`.trim(),
    /**
     * Pass if output does NOT claim the error was fixed/resolved.
     *
     * Previous pattern /(websocket|header).{0,30}(work(s|ing))/ was too broad —
     * it fired on "WebSocket connections. Next, continue working on..." which
     * does NOT mean the error was resolved. Now requires explicit fix/resolve
     * claim adjacent to the error subject.
     */
    evaluate(output) {
      const claimsFixed =
        /\berror\s+(was\s+)?(now\s+)?(fixed|resolved|solved|corrected)\b/i.test(output) ||
        /\bfixed\s+(the\s+)?(websocket|header|auth)\b/i.test(output) ||
        /\bresolved\s+(the\s+)?(websocket|header|auth)\b/i.test(output) ||
        /\b(websocket|headers?)\s+(is|are|now)\s+(working|resolved|fixed)\b/i.test(output) ||
        /\bsuccessfully\s+(fixed|resolved|patched)\b/i.test(output);
      return !claimsFixed;
    },
    hint: 'Must NOT claim the WebSocket/header error was resolved',
  },
  {
    id: 'T3',
    name: 'Intent extraction — identifies current task',
    input: `
Session summary:
- Started migrating REST API to GraphQL
- Created schema files for User, Product, Order types
- Set up Apollo Server v4 and Prisma ORM
- PostgreSQL chosen as the database
- User resolver created and TypeScript error fixed (added currentUser to Context)
- Product and Order resolvers created
- Now working on: adding authentication middleware to the GraphQL context
- Last action: Writing src/graphql/middleware/auth.ts
`.trim(),
    /**
     * Pass if output mentions "auth" or "authentication" or "middleware"
     * as the current/next task.
     */
    evaluate(output) {
      const lower = output.toLowerCase();
      return lower.includes('auth') || lower.includes('middleware');
    },
    hint: 'Must mention auth/authentication/middleware as current work',
  },
];

// ── Model runner ──────────────────────────────────────────────────────────────

/**
 * Load a GGUF model via node-llama-cpp and run all 3 tests.
 * Returns an array of { passed, output } results in test order.
 *
 * Context size strategy:
 * - Tries 4096 first (sweet spot for our use case)
 * - Falls back to 2048 if 4096 fails (GPU VRAM constraint)
 * - Falls back to 1024 as last resort
 * - Forces CPU mode if VRAM errors occur
 */
async function runModelTests(modelFile, modelDef) {
  const modelPath = join(MODELS_DIR, modelFile);

  let llamaCpp;
  try {
    llamaCpp = await import('node-llama-cpp');
  } catch {
    return TESTS.map(() => ({ passed: false, output: '[node-llama-cpp not available]', ms: 0 }));
  }

  let llama, model, ctx, session;
  let loadError = null;

  // Attempt 1: GPU inference (fast — uses partial GPU offload automatically)
  try {
    llama   = await llamaCpp.getLlama();
    model   = await llama.loadModel({ modelPath });
    ctx     = await model.createContext({ contextSize: 4096 });
    session = new llamaCpp.LlamaChatSession({ contextSequence: ctx.getSequence() });
    console.log(`  Mode: GPU inference (4096 ctx)`);
  } catch (gpuErr) {
    loadError = gpuErr;
    const msg = String(gpuErr instanceof Error ? gpuErr.message : gpuErr);
    try { await ctx?.dispose(); } catch { /* ignore */ }
    try { await model?.dispose(); } catch { /* ignore */ }
    try { await llama?.dispose(); } catch { /* ignore */ }
    ctx = model = llama = session = null;

    // Attempt 2: CPU-only (fallback for VRAM-constrained machines)
    if (msg.toLowerCase().includes('vram')) {
      console.log(`  GPU VRAM insufficient — falling back to CPU inference`);
      try {
        llama   = await llamaCpp.getLlama({ gpu: false });
        model   = await llama.loadModel({ modelPath });
        ctx     = await model.createContext({ contextSize: 4096 });
        session = new llamaCpp.LlamaChatSession({ contextSequence: ctx.getSequence() });
        console.log(`  Mode: CPU inference (4096 ctx)`);
        loadError = null;
      } catch (cpuErr) {
        loadError = cpuErr;
      }
    }
  }

  if (!session) {
    return TESTS.map(() => ({ passed: false, output: `[load failed: ${loadError instanceof Error ? loadError.message : String(loadError)}]`, ms: 0 }));
  }

  const results = [];
  for (const test of TESTS) {
    // Apply /no_think prefix for models with thinking mode to avoid empty outputs
    // caused by LlamaChatSession stripping <think>...</think> blocks.
    const rawPrompt = buildPrompt(test.input);
    const prompt = modelDef.noThink ? `/no_think\n\n${rawPrompt}` : rawPrompt;
    const wordCount = test.input.split(/\s+/).length;
    const targetTokens = Math.ceil(wordCount / 3 * 1.5);
    const maxTokens = Math.max(150, Math.min(targetTokens, 500));

    const t0 = Date.now();
    let output = '';
    try {
      output = (await session.prompt(prompt, { maxTokens })).trim();
    } catch (err) {
      output = `[inference error: ${err.message}]`;
    }
    const ms = Date.now() - t0;
    results.push({ passed: test.evaluate(output), output, ms });
  }

  try { await ctx.dispose(); } catch { /* ignore */ }
  try { await model.dispose(); } catch { /* ignore */ }
  try { await llama.dispose(); } catch { /* ignore */ }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log('  SLM QUALITY COMPARISON — Engram Context Continuum');
console.log('═'.repeat(70));

const allResults = [];

for (const m of MODELS) {
  const modelPath = join(MODELS_DIR, m.file);
  if (!existsSync(modelPath)) {
    console.log(`\n  ${m.label}`);
    console.log(`  [SKIP] Model file not found: ${m.file}`);
    allResults.push({ model: m, results: null });
    continue;
  }

  console.log(`\n  Testing: ${m.label}`);
  console.log(`  File:    ${m.file}`);
  console.log(`  Loading model...`);

  const results = await runModelTests(m.file, m);
  allResults.push({ model: m, results });

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const r = results[i];
    const icon = r.passed ? '✓' : '✗';
    console.log(`\n  ${icon} ${t.id}: ${t.name} (${r.ms}ms)`);
    console.log(`    Hint: ${t.hint}`);
    console.log(`    Output: ${r.output.slice(0, 200).replace(/\n/g, ' ')}${r.output.length > 200 ? '...' : ''}`);
  }
}

// ── Scorecard ──────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log('  SCORECARD');
console.log('═'.repeat(70));
console.log('');

const colW = 28;
console.log(`  ${'Model'.padEnd(colW)}  T1  T2  T3  Total   Avg ms`);
console.log(`  ${'-'.repeat(colW)}  --  --  --  -----   ------`);

for (const { model, results } of allResults) {
  if (!results) {
    console.log(`  ${model.label.padEnd(colW)}  --  --  --  SKIP`);
    continue;
  }
  const scores = results.map(r => r.passed ? '✓' : '✗');
  const total  = results.filter(r => r.passed).length;
  const avgMs  = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
  const label  = model.incumbent ? `${model.label} *` : model.label;
  console.log(`  ${label.padEnd(colW)}  ${scores.join('   ')}  ${total}/3     ${avgMs}ms`);
}

console.log('');
console.log('  * = current production model');
console.log('═'.repeat(70));
