/**
 * Print the analytics-strip comparison for a run's captures.
 *
 * Usage: npx tsx scripts/show-analytics.mjs <runDir>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compareTiles } from '../src/core/kpi.ts';

const runDir = process.argv[2];
if (!runDir) {
  console.error('Usage: npx tsx scripts/show-analytics.mjs <runDir>');
  process.exit(2);
}

const load = (side) => JSON.parse(readFileSync(path.join(runDir, side, 'capture.json'), 'utf8'));
const left = load('autogroup');
const right = load('dms');

const lt = left.rendered?.tiles ?? [];
const rt = right.rendered?.tiles ?? [];
console.log(`tiles captured: ${left.label ?? 'AutoGroup'}=${lt.length}  ${right.label ?? 'DMS'}=${rt.length}`);

const a = compareTiles(lt, rt, { leftLabel: left.label ?? 'AutoGroup', rightLabel: right.label ?? 'DMS' });
if (!a) {
  console.log('No analytics strip on either screen.');
  process.exit(0);
}

console.log(`\ncompared=${a.compared}  matched=${a.matched}  rounded=${a.roundedMatches}  different=${a.mismatched}`);
console.log('\n--- matched cards ---');
for (const p of a.pairs) {
  const flag = p.verdict === 'match' ? (p.roundedMatch ? 'ok(rounded)' : 'ok') : p.verdict.toUpperCase();
  console.log(
    `  ${flag.padEnd(12)} ${p.label.slice(0, 26).padEnd(28)} ${String(p.left.raw).padStart(14)}  vs  ` +
      `${String(p.right.raw).padStart(14)}  (${p.rightLabel.slice(0, 22)})` +
      (p.verdict !== 'match' ? `  Δ${p.delta}` : ''),
  );
}
console.log(`\n--- only on ${left.label ?? 'AutoGroup'} (${a.onlyOnLeft.length}) ---`);
a.onlyOnLeft.forEach((t) => console.log(`  ${t.label.slice(0, 36).padEnd(38)} = ${t.value}`));
console.log(`\n--- only on ${right.label ?? 'DMS'} (${a.onlyOnRight.length}) ---`);
a.onlyOnRight.forEach((t) => console.log(`  ${t.label.slice(0, 36).padEnd(38)} = ${t.value}`));
