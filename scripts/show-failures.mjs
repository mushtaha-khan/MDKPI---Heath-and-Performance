/**
 * Print formula and derived-column failures from the newest suite run.
 *
 * For a failing derived cell it lists every candidate rule that was tried and what
 * each would have produced, which is how you tell a genuine defect from the validator
 * simply not proposing the right denominator.
 *
 * Usage: node scripts/show-failures.mjs [runDir]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

function newestRun() {
  const root = 'artifacts/runs';
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, 'result.json')))
    .map((d) => d.name)
    .sort((a, b) => {
      const key = (n) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})[T_](\d{2})-(\d{2})-(\d{2})/.exec(n);
        return m ? Number(m.slice(1).join('')) : 0;
      };
      return key(b) - key(a);
    });
  if (!dirs.length) {
    console.error(`No run with result.json under ${root}.`);
    process.exit(1);
  }
  return path.join(root, dirs[0]);
}

const runDir = process.argv[2] ?? newestRun();
console.log(`run: ${runDir}\n`);
const data = JSON.parse(readFileSync(path.join(runDir, 'result.json'), 'utf8'));

for (const side of data.sides ?? []) {
  console.log(`===================== ${side.label} =====================`);

  const rowFails = (side.rowFormulas?.checks ?? []).filter((c) => c.verdict === 'fail');
  console.log(`\n--- row formula failures (${rowFails.length}) ---`);
  for (const c of rowFails) {
    console.log(`\n${c.rowLabel}  [${c.category}]`);
    console.log(`  formula : ${c.formula}`);
    console.log(`  expected: ${c.expected}   rendered: ${c.actual}   delta: ${c.delta}`);
    console.log(`  operands: ${c.trace.map((t) => `${t.op ?? ''}${t.label}=${t.value}`).join(' ')}`);
  }

  const unresolved = new Map();
  for (const c of side.rowFormulas?.checks ?? []) {
    if (c.verdict === 'unresolved') unresolved.set(c.rowLabel, c.unresolved);
  }
  if (unresolved.size) {
    console.log(`\n--- unresolved (operand not on the grid) ---`);
    for (const [k, v] of unresolved) console.log(`  ${k}  ->  ${[...new Set(v)].join(', ')}`);
  }

  const colFails = (side.columnChecks?.checks ?? []).filter((c) => c.verdict === 'fail');
  console.log(`\n--- derived column failures (${colFails.length}) ---`);
  for (const c of colFails) {
    console.log(`\n${c.rowLabel} [${c.category}] ${c.column} — rendered ${c.actual}`);
    for (const t of c.candidates ?? []) {
      console.log(`   ${t.fits ? 'FIT ' : '    '} ${String(t.expected).padStart(13)}  ${t.rule}`);
    }
    if (c.actual) {
      console.log(`   implied denominator if this is a ratio: value / ${(100 / c.actual).toFixed(6)}`);
    }
  }
  console.log('');
}
