/**
 * CLI: reconcile the two captured screens and emit a report.
 *
 * Reads artifacts/capture/{autogroup,dms}/capture.json (produced by
 * scripts/capture-screens.mjs) and writes both JSON and Markdown reports.
 *
 * Exit code is 1 when any mismatch is found, so this can gate CI.
 *
 * Usage: npm run compare
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compare, toMarkdown, type Capture } from '../core/compare.js';
import { CATEGORIES, CATEGORY_LABELS } from '../core/mapping.js';

const CAPTURE_DIR = path.join('artifacts', 'capture');
const OUT_DIR = path.join('artifacts', 'reports');

async function loadCapture(name: string): Promise<Capture> {
  const file = path.join(CAPTURE_DIR, name, 'capture.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(
      `Missing ${file}. Run the capture first:  node scripts/capture-screens.mjs ${name}`,
    );
  }
  const capture = JSON.parse(text) as Capture;
  if (capture.error && !capture.rendered) {
    throw new Error(`Capture "${name}" failed and has no data: ${capture.error}`);
  }
  return capture;
}

const autogroup = await loadCapture('autogroup');
const dms = await loadCapture('dms');

const report = compare(autogroup, dms);

// Written under its own name: the richer HTML pipeline owns reconciliation.json,
// and sharing the filename would let whichever ran last clobber the other.
await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, 'comparison.json'), JSON.stringify(report, null, 2), 'utf8');
await writeFile(path.join(OUT_DIR, 'comparison.md'), toMarkdown(report), 'utf8');

// --- Console summary ---
const s = report.summary;
console.log('');
console.log('Service Summary (AutoGroup)  vs  Service Dashboard (DMS)');
console.log('='.repeat(62));
console.log(`AutoGroup range : ${report.dateRange.autogroup ?? 'unknown'}`);
console.log(`DMS range       : ${report.dateRange.dms ?? 'unknown'}`);
console.log(`Ranges aligned  : ${report.dateRange.aligned ? 'yes' : 'NO'}`);
console.log('');
console.log(`Cells compared  : ${s.totalCells}`);
console.log(`Matched         : ${s.matched}`);
console.log(`Mismatched      : ${s.mismatched}`);
console.log(`Missing         : ${s.missing}`);
console.log('');
console.log('By category:');
for (const c of CATEGORIES) {
  const b = s.byCategory[c];
  console.log(
    `  ${CATEGORY_LABELS[c].padEnd(14)} matched=${String(b.matched).padStart(2)}  ` +
      `mismatched=${String(b.mismatched).padStart(2)}  missing=${String(b.missing).padStart(2)}`,
  );
}

const bad = report.metrics.filter((m) => !m.passed);
if (bad.length) {
  console.log('');
  console.log('Mismatches:');
  console.log(
    '  ' +
      'METRIC'.padEnd(26) +
      'CATEGORY'.padEnd(15) +
      'AUTOGROUP'.padEnd(15) +
      'DMS'.padEnd(15) +
      'DELTA',
  );
  for (const m of bad) {
    for (const c of m.cells) {
      if (c.verdict === 'match') continue;
      console.log(
        '  ' +
          m.autogroupLabel.padEnd(26) +
          c.categoryLabel.padEnd(15) +
          (c.left.raw || '—').padEnd(15) +
          (c.right.raw || '—').padEnd(15) +
          (c.delta === null ? '—' : String(c.delta)),
      );
    }
  }
}

console.log('');
console.log(`Reports -> ${OUT_DIR}/comparison.md, comparison.json`);

process.exit(s.mismatched > 0 || s.missing > 0 ? 1 : 0);
