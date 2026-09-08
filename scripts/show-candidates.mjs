/** Show every candidate rule tried for the still-failing derived cells. */
import { readFileSync } from 'node:fs';

const r = JSON.parse(readFileSync('artifacts/reports/reconciliation.json', 'utf8'));

for (const c of r.columnChecks.checks) {
  if (c.verdict !== 'fail') continue;
  console.log(`\n${c.rowLabel} [${c.category}] ${c.column} — rendered ${c.actual}`);
  for (const t of c.candidates ?? []) {
    console.log(`   ${t.fits ? 'FIT ' : '    '} ${String(t.expected).padStart(12)}  ${t.rule}`);
  }
  // Reverse-engineer the denominator the screen must have used.
  if (c.actual) {
    console.log(`   implied denominator for a margin %: value / ${(100 / c.actual).toFixed(6)}`);
  }
}

// Dump the parts rows so the denominator can be identified by eye.
const grid = JSON.parse(readFileSync('artifacts/capture/dms/capture.json', 'utf8')).rendered.tables.find(
  (t) => t.headers.flat().join(' ').toUpperCase().includes('WARRANTY'),
);
const cols = { total: 2, customerPay: 18, warranty: 34, internal: 50 };
console.log('\n=== parts-related row values ===');
for (const row of grid.rows) {
  const l = (row[0] ?? '').trim();
  if (!/PARTS|TOTAL/i.test(l)) continue;
  console.log(
    l.padEnd(42) +
      Object.entries(cols)
        .map(([k, i]) => `${k}=${String(row[i] ?? '').padStart(13)}`)
        .join(' '),
  );
}
