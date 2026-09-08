/**
 * Print the record-by-record comparison for a run's captures.
 *
 * Usage: npx tsx scripts/show-records.mjs <runDir> [maxRecords]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { profileGrids } from '../src/core/pairing.ts';
import { classifyTables } from '../src/core/structure.ts';
import { compareRecords } from '../src/core/records.ts';

const runDir = process.argv[2];
const maxRecords = Number(process.argv[3] ?? 4);
if (!runDir) {
  console.error('Usage: npx tsx scripts/show-records.mjs <runDir> [maxRecords]');
  process.exit(2);
}

const load = (side) => JSON.parse(readFileSync(path.join(runDir, side, 'capture.json'), 'utf8'));
const left = load('autogroup');
const right = load('dms');

const lp = profileGrids(left.rendered?.tables ?? []);
const rp = profileGrids(right.rendered?.tables ?? []);
const ls = classifyTables(lp);
const rs = classifyTables(rp);

const pick = (structures, profiles) => {
  const details = structures.filter((s) => s.role === 'detail');
  if (!details.length) return null;
  const best = [...details].sort((a, b) => b.bodyRows - a.bodyRows)[0];
  return profiles.find((p) => p.table.index === best.index) ?? null;
};

const ld = pick(ls, lp);
const rd = pick(rs, rp);
if (!ld || !rd) {
  console.log(`No record listing on both sides (left=${Boolean(ld)}, right=${Boolean(rd)}).`);
  process.exit(0);
}

const rc = compareRecords(ld, rd, { leftLabel: left.label ?? 'AutoGroup', rightLabel: right.label ?? 'DMS' });
if (!rc) {
  console.log('Listings found but no record key or column pair could be established.');
  process.exit(0);
}

console.log(`key column: ${rc.keyColumn.left}  <->  ${rc.keyColumn.right}`);
console.log(`  ${rc.keyColumn.reason}`);
console.log(`\ncolumns compared: ${rc.columnPairs.length}`);
for (const c of rc.columnPairs) {
  console.log(
    `  ${c.kind.padEnd(8)} ${c.name.slice(0, 28).padEnd(30)} -> ${c.rightName.slice(0, 28).padEnd(30)} ` +
      `${c.matchedBy}${c.matchedBy === 'fuzzy' ? ' ' + c.confidence : ''}`,
  );
}
console.log(`\nunpaired on left  : ${rc.unpairedLeft.join(', ') || 'none'}`);
console.log(`unpaired on right : ${rc.unpairedRight.join(', ') || 'none'}`);

const s = rc.summary;
console.log(
  `\nrecords compared: ${s.recordsCompared}   cells: ${s.matched}/${s.totalCells} matched ` +
    `(${s.formattingOnly} only after allowing formatting/rounding), ${s.mismatched} different, ${s.missing} missing`,
);
console.log(`  numeric cells=${s.numericCells}  text cells=${s.textCells}`);
console.log(`only on left : ${rc.onlyOnLeft.length}   only on right: ${rc.onlyOnRight.length}`);

console.log(`\n--- first ${maxRecords} record(s) ---`);
for (const rec of rc.records.slice(0, maxRecords)) {
  console.log(`  RECORD ${rec.key}  ${rec.passed ? 'all match' : 'has differences'}`);
  for (const c of rec.cells) {
    const flag = c.verdict === 'match' ? (c.formattingOnly ? 'ok(fmt)' : 'ok') : c.verdict.toUpperCase();
    console.log(
      `    ${flag.padEnd(14)} ${c.strategy.padEnd(8)} ${c.column.slice(0, 22).padEnd(24)} ${String(c.left).slice(0, 28).padEnd(30)} | ${String(c.right).slice(0, 28)}` +
        (c.delta !== null && c.verdict !== 'match' ? `   Δ${c.delta}` : ''),
    );
  }
}

const diffs = rc.records.flatMap((r) => r.cells.filter((c) => c.verdict !== 'match').map((c) => ({ k: r.key, c })));
console.log(`\n--- differences by column (${diffs.length} cell(s)) ---`);
const byCol = new Map();
for (const d of diffs) byCol.set(d.c.column, (byCol.get(d.c.column) ?? 0) + 1);
[...byCol.entries()].sort((a, b) => b[1] - a[1]).forEach(([col, n]) => console.log(`  ${String(n).padStart(4)}  ${col}`));
