/** Show how the label column was scored for each candidate on both screens. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveGeometry } from '../src/core/columns.js';

const runDir = process.argv[2]!;

for (const side of ['autogroup', 'dms']) {
  const cap = JSON.parse(readFileSync(path.join(runDir, side, 'capture.json'), 'utf8'));
  const t = cap.rendered.tables.find((x: any) =>
    (x.headerGrid ?? []).flat().join(' ').toUpperCase().includes('TECH INFO'),
  );
  if (!t) continue;

  const geo = deriveGeometry(t.headerGrid, t.rows);
  console.log(`===== ${side} =====`);
  console.log(`rows=${t.rowCount}  headerWidth=${t.headerGrid[0]?.length}  bodyWidth=${t.rows[0]?.length}`);
  console.log(`labelColumn = ${geo.labelColumn}`);
  console.log(`notes: ${geo.notes.join(' | ')}`);

  const looksNumeric = (s: string) => /^[-+(]?[$€£]?\s?[\d,]+(\.\d+)?\s?[%)]?$/.test((s ?? '').trim());
  const looksLikeDate = (s: string) => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test((s ?? '').trim());
  const looksLikeLabel = (s: string) => {
    const x = (s ?? '').trim();
    if (!x || x === '-' || x === '—') return false;
    if (looksNumeric(x) || looksLikeDate(x)) return false;
    return (x.match(/[A-Za-z]/g) ?? []).length >= 2;
  };

  const considered = t.rows.slice(0, 60);
  console.log('candidate scores:');
  for (let c = 0; c < Math.min(10, t.rows[0]?.length ?? 0); c++) {
    const hits = considered.filter((r: string[]) => looksLikeLabel(r[c] ?? '')).length;
    const hdr = (t.headerGrid ?? []).map((h: string[]) => h[c]).filter(Boolean).join(' > ');
    console.log(
      `  col ${String(c).padStart(2)}  score=${(hits / considered.length).toFixed(2)}  ` +
        `hdr="${hdr}"  sample="${String(t.rows[0]?.[c] ?? '').slice(0, 28)}"`,
    );
  }
  console.log('');
}
