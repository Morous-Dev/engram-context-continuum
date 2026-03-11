/**
 * run.mjs — Main benchmark runner for Engram Context Continuum.
 *
 * Responsible for: executing all 3 benchmark scenarios in sequence,
 * collecting pass/fail counts from each, and printing an aggregate
 * results table with exit code 0 (all passed) or 1 (any failed).
 *
 * Depends on: scenario-01-initial.mjs, scenario-02-continuation.mjs,
 *             scenario-03-marathon.mjs, build/
 * Run via: node benchmark/run.mjs
 *
 * Scenarios:
 *   S1 — Initial session (REST → GraphQL migration, ~80 events)
 *   S2 — Hot resume continuation (PostgreSQL → SQLite reversal, ~40 events)
 *   S3 — Marathon cold start (3 compaction cycles, library switch, recurring error)
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const CWD   = process.cwd();
const bench = (f) => pathToFileURL(join(CWD, 'benchmark', f)).href;

// ── Intercept console.log to count pass/fail lines per scenario ───────────────

let scenarioPassed = 0;
let scenarioFailed = 0;
const scenarioResults = [];

const originalLog = console.log;

function resetCounters() {
  scenarioPassed = 0;
  scenarioFailed = 0;
}

function captureLog(line) {
  if (typeof line === 'string') {
    if (line.startsWith('  ✓')) scenarioPassed++;
    if (line.startsWith('  ✗')) scenarioFailed++;
  }
  originalLog(line);
}

function snapshotAndReset(label) {
  scenarioResults.push({
    label,
    passed: scenarioPassed,
    failed: scenarioFailed,
  });
  resetCounters();
}

console.log = captureLog;

// ── Run scenarios ─────────────────────────────────────────────────────────────

const startMs = Date.now();

originalLog('\n' + '═'.repeat(70));
originalLog('  ENGRAM CONTEXT CONTINUUM — BENCHMARK SUITE');
originalLog('═'.repeat(70));

try {
  originalLog('\n[1/3] Running Scenario 1 — Initial Session...\n');
  await import(bench('scenario-01-initial.mjs'));
  snapshotAndReset('S1: Initial Session');
} catch (err) {
  originalLog(`\n  !! Scenario 1 crashed: ${err.message}`);
  scenarioResults.push({ label: 'S1: Initial Session', passed: 0, failed: 1, crashed: true });
  resetCounters();
}

try {
  originalLog('\n[2/3] Running Scenario 2 — Continuation / Hot Resume...\n');
  await import(bench('scenario-02-continuation.mjs'));
  snapshotAndReset('S2: Continuation (hot resume)');
} catch (err) {
  originalLog(`\n  !! Scenario 2 crashed: ${err.message}`);
  scenarioResults.push({ label: 'S2: Continuation (hot resume)', passed: 0, failed: 1, crashed: true });
  resetCounters();
}

try {
  originalLog('\n[3/3] Running Scenario 3 — Marathon / Cold Start...\n');
  await import(bench('scenario-03-marathon.mjs'));
  snapshotAndReset('S3: Marathon (cold start)');
} catch (err) {
  originalLog(`\n  !! Scenario 3 crashed: ${err.message}`);
  scenarioResults.push({ label: 'S3: Marathon (cold start)', passed: 0, failed: 1, crashed: true });
  resetCounters();
}

// Restore console.log
console.log = originalLog;

// ── Aggregate results ─────────────────────────────────────────────────────────

const totalPassed  = scenarioResults.reduce((n, r) => n + r.passed, 0);
const totalFailed  = scenarioResults.reduce((n, r) => n + r.failed, 0);
const totalAsserts = totalPassed + totalFailed;
const elapsedSec   = ((Date.now() - startMs) / 1000).toFixed(1);

console.log('\n' + '═'.repeat(70));
console.log('  BENCHMARK RESULTS');
console.log('═'.repeat(70));
console.log('');

const colW = 36;
for (const r of scenarioResults) {
  const label  = r.label.padEnd(colW);
  const status = r.crashed
    ? '  CRASH '
    : r.failed === 0
      ? '  PASS  '
      : `  FAIL  `;
  const counts = r.crashed
    ? '(crashed — check build)'
    : `${r.passed}/${r.passed + r.failed} assertions`;
  console.log(`  ${label} ${status}   ${counts}`);
}

console.log('');
console.log(`  Total: ${totalPassed}/${totalAsserts} assertions passed   (${elapsedSec}s)`);

if (totalFailed === 0) {
  console.log('\n  All assertions passed. ECC handoff quality is GREEN.');
} else {
  console.log(`\n  ${totalFailed} assertion(s) failed. Review output above for details.`);
}

console.log('═'.repeat(70));

process.exit(totalFailed > 0 ? 1 : 0);
