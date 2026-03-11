/**
 * assertions.mjs — Handoff validation helpers for ECC benchmarks.
 *
 * Responsible for: checking that a handoff YAML object contains or avoids
 * specific content, and reporting pass/fail with evidence.
 *
 * Depends on: nothing.
 * Depended on by: benchmark scenarios.
 */

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Assert that text appears in the handoff working_context or headline.
 *
 * @param {object} handoff   - Parsed handoff object
 * @param {string} pattern   - Substring to look for (case-insensitive)
 * @param {string} label     - Human-readable assertion description
 */
export function mustContain(handoff, pattern, label) {
  const haystack = [
    handoff.working_context ?? '',
    handoff.headline ?? '',
    (handoff.decisions ?? []).join(' '),
  ].join(' ').toLowerCase();

  if (haystack.includes(pattern.toLowerCase())) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`    Pattern not found: "${pattern}"`);
    console.log(`    working_context: ${(handoff.working_context ?? '').slice(0, 200)}`);
    failed++;
    failures.push(label);
  }
}

/**
 * Assert that text does NOT appear in the handoff.
 *
 * @param {object} handoff   - Parsed handoff object
 * @param {string} pattern   - Substring that must be absent (case-insensitive)
 * @param {string} label     - Human-readable assertion description
 */
export function mustNotContain(handoff, pattern, label) {
  const haystack = [
    handoff.working_context ?? '',
    handoff.headline ?? '',
  ].join(' ').toLowerCase();

  if (!haystack.includes(pattern.toLowerCase())) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`    Forbidden pattern found: "${pattern}"`);
    console.log(`    working_context: ${(handoff.working_context ?? '').slice(0, 200)}`);
    failed++;
    failures.push(label);
  }
}

/**
 * Assert the handoff field matches expected value exactly.
 */
export function fieldEquals(handoff, field, expected, label) {
  const actual = handoff[field];
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`    Expected ${field}="${expected}", got "${actual}"`);
    failed++;
    failures.push(label);
  }
}

/**
 * Print the final benchmark summary and exit with appropriate code.
 */
export function summary() {
  const total = passed + failed;
  console.log('\n' + '='.repeat(60));
  console.log(`BENCHMARK RESULTS: ${passed}/${total} passed`);
  if (failures.length > 0) {
    console.log(`\nFailed assertions:`);
    for (const f of failures) console.log(`  - ${f}`);
  } else {
    console.log('All assertions passed.');
  }
  console.log('='.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}
