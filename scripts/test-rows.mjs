/**
 * Check row normalization on the real captures: alignment, label fill, totals vs segments.
 *
 * Usage: node scripts/test-rows.mjs <runDir>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeTable, comparableRows, breakdownByEntity } from '../src/core/rows.ts';

const runDir = process.argv[2];

for (const side of ['autogroup', 'dms']) {
  const cap = JSON.parse(readFileSync(path.join(runDir, side, 'capture.json'), 'utf8'));
  const table =
    cap.rendered.tables.find((t) =>
      (t.headerGrid ?? []).flat().join(' ').toUpperCase().includes('TECH INFO'),
    ) ?? cap.rendered.tables.reduce((a, b) => (b.rowCount > (a?.rowCount ?? 0) ? b : a), null);

  const n = normalizeTable(table.rows);
  const totals = comparableRows(n);
  const breakdown = breakdownByEntity(n);

  console.log(`===== ${side} =====`);
  console.log(`width=${n.width}  labelColumn=${n.labelColumn}  segmentColumn=${n.segmentColumn}`);
  console.log(`hasBreakdown=${n.hasBreakdown}  segments=${JSON.stringify(n.segments)}`);
  console.log(`rows=${n.rows.length}  comparable(total) rows=${totals.length}  entities with breakdown=${breakdown.size}`);
  n.notes.forEach((x) => console.log(`  note: ${x}`));

  console.log('\n  first 3 comparable rows (label, then cells 5..9):');
  totals.slice(0, 3).forEach((r) => {
    console.log(
      `    ${r.label.slice(0, 30).padEnd(32)} seg=${String(r.segment).padEnd(6)} ` +
        `cells[5..9]=${JSON.stringify(r.cells.slice(5, 10))}`,
    );
  });

  if (breakdown.size) {
    const [ent, segs] = [...breakdown.entries()][0];
    console.log(`\n  breakdown for "${ent}":`);
    segs.forEach((s) => console.log(`    seg=${String(s.segment).padEnd(6)} cells[5..9]=${JSON.stringify(s.cells.slice(5, 10))}`));
  }
  console.log('');
}
