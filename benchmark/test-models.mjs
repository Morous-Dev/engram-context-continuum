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
 * Architecture:
 *   Each model is tested in an isolated subprocess (--model-id <id> flag) so
 *   that CUDA context and VRAM are fully released between model runs. Without
 *   isolation, CUDA's lazy memory management causes false "VRAM insufficient"
 *   errors for models tested after the first one.
 *
 * Run via: node benchmark/test-models.mjs
 * Depends on: node-llama-cpp
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODELS_DIR = join(homedir(), '.engram-cc', 'models');
const THIS_FILE  = fileURLToPath(import.meta.url);

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
    // Qwen 3.5 2B has a disproportionately large KV cache per token.
    // Binary search confirmed: FAILS at 1024, WORKS at 768. Max GPU ctx = 768.
    // Try 768 first; if that still fails (different GPU), try 512 before CPU.
    gpuCtxSizes: [768, 512],
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

// ── Single-model worker (subprocess mode) ─────────────────────────────────────

/**
 * Run tests for a single model.
 * Called when this script is spawned with --model-id <id>.
 * Outputs a JSON array of { passed, output, ms, mode } to stdout.
 * Stderr is used for progress messages (visible to parent via inherited stdio).
 *
 * Each model runs in its own process so that CUDA VRAM is fully released
 * between model runs. Sharing a process causes CUDA lazy-GC to accumulate
 * allocations and falsely report "VRAM insufficient" for later models.
 *
 * @param {string} modelId - ID from MODELS array.
 */
async function runSingleModel(modelId) {
  const modelDef = MODELS.find(m => m.id === modelId);
  if (!modelDef) { process.stderr.write(`Unknown model: ${modelId}\n`); process.exit(1); }

  const modelPath = join(MODELS_DIR, modelDef.file);

  let llamaCpp;
  try {
    llamaCpp = await import('node-llama-cpp');
  } catch {
    const fail = TESTS.map(() => ({ passed: false, output: '[node-llama-cpp not available]', ms: 0, mode: 'none' }));
    process.stdout.write(JSON.stringify(fail) + '\n');
    return;
  }

  let llama, model, ctx, session;
  let loadError = null;
  let mode = 'unknown';

  // Context sizes to try on GPU (in order). Qwen 3.5 2B has a large KV cache
  // and fails at ≥1024 even with ample VRAM — 768 is the confirmed max.
  // Other models try 4096 first (standard); if that fails, fall through to CPU.
  const gpuContextSizes = modelDef.gpuCtxSizes ?? [4096];

  for (const ctxSize of gpuContextSizes) {
    try {
      llama   = await llamaCpp.getLlama();
      model   = await llama.loadModel({ modelPath });
      ctx     = await model.createContext({ contextSize: ctxSize });
      session = new llamaCpp.LlamaChatSession({ contextSequence: ctx.getSequence() });
      mode    = `GPU (${ctxSize} ctx)`;
      process.stderr.write(`  Mode: GPU inference (${ctxSize} ctx)\n`);
      loadError = null;
      break; // success — stop trying smaller sizes
    } catch (gpuErr) {
      loadError = gpuErr;
      const msg = String(gpuErr instanceof Error ? gpuErr.message : gpuErr).toLowerCase();
      try { await ctx?.dispose(); } catch { /* ignore */ }
      try { await model?.dispose(); } catch { /* ignore */ }
      try { await llama?.dispose(); } catch { /* ignore */ }
      ctx = model = llama = session = null;

      if (!(msg.includes('vram') || msg.includes('too large'))) break; // non-VRAM error, stop retrying
      process.stderr.write(`  GPU ctx ${ctxSize} failed (VRAM): ${String(gpuErr instanceof Error ? gpuErr.message : gpuErr).slice(0, 120)}\n`);
    }
  }

  // Attempt 2 (final fallback): CPU-only inference
  if (!session && loadError) {
    const msg = String(loadError instanceof Error ? loadError.message : loadError).toLowerCase();
    if (msg.includes('vram') || msg.includes('too large')) {
      process.stderr.write(`  GPU exhausted — falling back to CPU inference\n`);
      try {
        llama   = await llamaCpp.getLlama({ gpu: false });
        model   = await llama.loadModel({ modelPath });
        ctx     = await model.createContext({ contextSize: 4096 });
        session = new llamaCpp.LlamaChatSession({ contextSequence: ctx.getSequence() });
        mode    = 'CPU (4096 ctx)';
        process.stderr.write(`  Mode: CPU inference (4096 ctx)\n`);
        loadError = null;
      } catch (cpuErr) {
        loadError = cpuErr;
      }
    }
  }

  if (!session) {
    const msg = loadError instanceof Error ? loadError.message : String(loadError);
    const fail = TESTS.map(() => ({ passed: false, output: `[load failed: ${msg}]`, ms: 0, mode: 'failed' }));
    process.stdout.write(JSON.stringify(fail) + '\n');
    try { await ctx?.dispose(); } catch { /* ignore */ }
    try { await model?.dispose(); } catch { /* ignore */ }
    try { await llama?.dispose(); } catch { /* ignore */ }
    return;
  }

  const results = [];
  for (const test of TESTS) {
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
    results.push({ passed: test.evaluate(output), output, ms, mode });
  }

  try { await ctx.dispose(); } catch { /* ignore */ }
  try { await model.dispose(); } catch { /* ignore */ }
  try { await llama.dispose(); } catch { /* ignore */ }

  process.stdout.write(JSON.stringify(results) + '\n');
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const modelIdArg = process.argv.indexOf('--model-id');
if (modelIdArg !== -1) {
  // Subprocess mode: test one model, output JSON
  await runSingleModel(process.argv[modelIdArg + 1]);
  process.exit(0);
}

// Orchestrator mode: spawn a subprocess per model for CUDA isolation
console.log('\n' + '═'.repeat(70));
console.log('  SLM QUALITY COMPARISON — Engram Context Continuum');
console.log('═'.repeat(70));
console.log('  (Each model runs in an isolated subprocess for CUDA VRAM isolation)');

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

  const proc = spawnSync(process.execPath, [THIS_FILE, '--model-id', m.id], {
    stdio: ['ignore', 'pipe', 'inherit'],  // inherit stderr for live progress, pipe stdout for JSON
    timeout: 20 * 60 * 1000,              // 20 min per model (Qwen CPU needs ~11 min)
    encoding: 'utf8',
  });

  let results;
  if (proc.error || proc.status !== 0) {
    results = TESTS.map(() => ({ passed: false, output: `[subprocess failed: ${proc.error?.message ?? 'exit ' + proc.status}]`, ms: 0, mode: 'failed' }));
  } else {
    try {
      results = JSON.parse(proc.stdout.trim().split('\n').pop());
    } catch {
      results = TESTS.map(() => ({ passed: false, output: `[JSON parse error: ${proc.stdout.slice(0, 100)}]`, ms: 0, mode: 'failed' }));
    }
  }

  allResults.push({ model: m, results });

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const r = results[i];
    const icon = r.passed ? '✓' : '✗';
    console.log(`\n  ${icon} ${t.id}: ${t.name} (${r.ms}ms${r.mode && r.mode !== 'failed' ? ', ' + r.mode : ''})`);
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
