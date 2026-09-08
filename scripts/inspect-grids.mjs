/**
 * Inspect the tables captured for a run and the geometry derived from each.
 *
 * Use this when onboarding a new module and the wrong table is being compared: it
 * shows every table, its header chains and the column groups found, so you can pick
 * `gridHints` for the module preset.
 *
 * Usage:
 *   node scripts/inspect-grids.mjs                 # newest run
 *   node scripts/inspect-grids.mjs <runDir>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const runsRoot = 'artifacts/runs';

function newestRun() {
  const dirs = readdirSync(runsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(runsRoot, d.name, 'dms')))
    .map((d) => d.name)
    .sort()
    .reverse();
  if (!dirs.length) {
    console.error(`No runs found under ${runsRoot}. Run the suite first.`);
    process.exit(1);
  }
  return path.join(runsRoot, dirs[0]);
}

const runDir = process.argv[2] ?? newestRun();
console.log(`run: ${runDir}\n`);

for (const side of ['autogroup', 'dms']) {
  const file = path.join(runDir, side, 'capture.json');
  if (!existsSync(file)) {
    console.log(`===== ${side}: no capture =====\n`);
    continue;
  }
  const cap = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`===== ${side} — ${cap.label} =====`);

  for (const t of cap.rendered.tables) {
    const hg = t.headerGrid;
    const width = hg?.[0]?.length ?? 0;

    // Distinct top-level headings, which are the candidate column groups.
    const groups = hg?.length
      ? [...new Set(hg[0].filter(Boolean))]
      : [...new Set(t.headers[0]?.filter(Boolean) ?? [])];

    console.log(
      `\ntable[${t.index}] rows=${String(t.rowCount).padStart(4)} ` +
        `headerRows=${hg?.length ?? 0} width=${width}`,
    );
    console.log(`  top headings : ${groups.slice(0, 10).join(' | ') || '(none)'}`);
    console.log(`  first labels : ${t.rows.slice(0, 4).map((r) => (r[0] ?? '').trim()).filter(Boolean).join(' / ') || '(none)'}`);

    // Show the chain for the first few value-bearing columns.
    if (hg?.length) {
      const shown = [];
      for (let c = 1; c < width && shown.length < 4; c++) {
        const chain = hg.map((r) => r[c]).filter(Boolean);
        if (chain.length) shown.push(`col ${c}: ${chain.join(' > ')}`);
      }
      shown.forEach((s) => console.log(`    ${s}`));
    }
  }
  console.log('');
}

console.log('Tip: choose gridHints that appear ONLY in the metric grid. Hints are ANDed,');
console.log('so a pair like ["CUSTOMER PAY","WARRANTY"] excludes smaller strips that');
console.log('merely mention one of them (e.g. a "WARRANTY RATE" summary).');
