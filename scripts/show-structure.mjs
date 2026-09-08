/**
 * Print the structure classification and comparison mode for a run's captures.
 *
 * Usage: npx tsx scripts/show-structure.mjs <runDir>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { profileGrids } from '../src/core/pairing.ts';
import { classifyTables } from '../src/core/structure.ts';
import { runSuite } from '../src/core/suite.ts';

const runDir = process.argv[2];
if (!runDir) {
  console.error('Usage: npx tsx scripts/show-structure.mjs <runDir>');
  process.exit(2);
}

const load = (side) =>
  JSON.parse(readFileSync(path.join(runDir, side, 'capture.json'), 'utf8'));

const left = load('autogroup');
const right = load('dms');

for (const [label, cap] of [
  [left.label ?? 'AutoGroup', left],
  [right.label ?? 'DMS', right],
]) {
  console.log(`\n===== ${label} =====`);
  const profiles = profileGrids(cap.rendered?.tables ?? []);
  const structures = classifyTables(profiles);
  for (const s of structures) {
    console.log(
      `  [${s.role.toUpperCase().padEnd(7)}] conf=${s.confidence}  rows=${String(s.bodyRows).padStart(3)}  ` +
        `labels=${String(s.usableLabels).padStart(3)}  num=${String(s.numericColumns).padStart(2)}  ` +
        `txt=${String(s.textColumns).padStart(2)}  total=${s.hasTotalRow ? 'Y' : 'n'}  ` +
        `page=${s.pageSize ?? '-'}  kind=${s.rowKind}${s.transposed ? '  PIVOTED' : ''}`,
    );
    console.log(`      ${s.name.slice(0, 90)}`);
    s.evidence.forEach((e) => console.log(`        - ${e}`));
  }
}

const result = runSuite(left, right, { name: 'Structure Check' });
console.log(`\n===== structure summary =====\n  ${result.structure.summary}`);
console.log(`\n===== mode =====\n  ${result.mode.mode}\n  ${result.mode.reason}`);
if (result.mode.detailViews.length) {
  console.log('\n  detail views:');
  for (const v of result.mode.detailViews) {
    console.log(`    ${v.sideLabel} "${v.name}" records=${v.records} expected=${v.expectedRecords ?? '?'} usable=${v.usable}`);
    console.log(`      ${v.why}`);
  }
}
for (const c of result.mode.corroboration) {
  console.log(`\n  corroboration from ${c.view.sideLabel} "${c.view.name}":`);
  for (const k of c.checks) {
    console.log(
      `    ${k.detailColumn.padEnd(24)} sum=${k.aggregate}  vs ${k.summaryRow}/${k.summaryColumn} = ${k.expected}  Δ${k.delta}  tol=${k.tolerance}  ${k.verdict}`,
    );
  }
}
