/**
 * Inspect the row structure of a captured grid: widths, label positions, repeats.
 *
 * Needed to tell whether a screen that splits an entity into several rows also
 * provides an explicit total row, or only the segments.
 *
 * Usage: node scripts/inspect-rows.mjs <runDir> <side> [limit]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [, , runDir, side = 'dms', limit = '40'] = process.argv;
const cap = JSON.parse(readFileSync(path.join(runDir, side, 'capture.json'), 'utf8'));

const table = cap.rendered.tables.find((t) =>
  (t.headerGrid ?? []).flat().join(' ').toUpperCase().includes('TECH INFO'),
) ?? cap.rendered.tables.reduce((a, b) => (b.rowCount > (a?.rowCount ?? 0) ? b : a), null);

console.log(`side=${side}  rows=${table.rowCount}`);
console.log(`header rows=${table.headerGrid?.length}  header width=${table.headerGrid?.[0]?.length}`);

const widths = new Map();
for (const r of table.rows) widths.set(r.length, (widths.get(r.length) ?? 0) + 1);
console.log(`row widths: ${[...widths.entries()].map(([w, n]) => `${w}x${n}`).join(', ')}\n`);

console.log(`first ${limit} rows — width, then first 7 cells:`);
table.rows.slice(0, Number(limit)).forEach((r, i) => {
  const cells = r.slice(0, 7).map((c) => JSON.stringify((c ?? '').slice(0, 26)));
  console.log(`  [${String(i).padStart(3)}] w=${String(r.length).padStart(3)}  ${cells.join(' ')}`);
});

// Where does text that looks like a name appear?
console.log('\ncells containing 2+ letters, by column index (first 25 rows):');
const byCol = new Map();
table.rows.slice(0, 25).forEach((r) => {
  r.forEach((c, i) => {
    if (((c ?? '').match(/[A-Za-z]/g) ?? []).length >= 2) {
      if (!byCol.has(i)) byCol.set(i, []);
      byCol.get(i).push((c ?? '').slice(0, 24));
    }
  });
});
for (const [i, samples] of [...byCol.entries()].sort((a, b) => a[0] - b[0]).slice(0, 12)) {
  console.log(`  col ${String(i).padStart(2)}: ${samples.length} hit(s)  e.g. ${JSON.stringify(samples.slice(0, 3))}`);
}
