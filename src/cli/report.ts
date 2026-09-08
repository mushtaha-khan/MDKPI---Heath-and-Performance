/**
 * Build the HTML reconciliation report from the current captures.
 *
 * Expects a fresh capture to have run first (npm run capture), so the screenshots
 * and values in the report are from the same page loads.
 *
 * Usage: npm run report:html
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { compare, findMetricTable, toMarkdown, type Capture } from '../core/compare.js';
import {
  readDayContext,
  validateColumns,
  validateFormulas,
  type ExtractedFormula,
} from '../core/formulas.js';
import { renderHtml, type ScreenshotRef } from '../core/html-report.js';
import { RATE_METRICS } from '../core/mapping.js';

const CAPTURE_DIR = path.join('artifacts', 'capture');
const FORMULA_FILE = path.join('artifacts', 'formulas', 'formulas.json');
const OUT_DIR = path.join('artifacts', 'reports');

async function loadCapture(name: string): Promise<Capture> {
  const file = path.join(CAPTURE_DIR, name, 'capture.json');
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Capture;
  } catch {
    throw new Error(`Missing ${file}. Run:  node scripts/capture-screens.mjs ${name}`);
  }
}

const autogroup = await loadCapture('autogroup');
const dms = await loadCapture('dms');

const comparison = compare(autogroup, dms);

// --- formula validation against the DMS grid ---
let formulas: ExtractedFormula[] = [];
if (existsSync(FORMULA_FILE)) {
  const parsed = JSON.parse(await readFile(FORMULA_FILE, 'utf8')) as {
    results: ExtractedFormula[];
  };
  formulas = parsed.results.filter((r) => r.formula);
} else {
  console.log(`No ${FORMULA_FILE}; skipping row-formula validation.`);
  console.log('Run:  node scripts/extract-formulas.mjs full');
}

const dmsTable = findMetricTable(dms);
const days = readDayContext(dms.rendered?.tables ?? []);
const rowFormulas = validateFormulas(dmsTable.rows, formulas);
const columnChecks = validateColumns(dmsTable.rows, days, RATE_METRICS);

// --- screenshot evidence ---
await mkdir(OUT_DIR, { recursive: true });

/** Human-readable caption for a grid slice filename. */
function sliceCaption(file: string): string {
  const m = /^grid-(left|mid|right)-(\d+)\.png$/.exec(file);
  if (!m) return file;
  const band =
    m[1] === 'left'
      ? 'Row labels · Total · Customer Pay'
      : m[1] === 'mid'
        ? 'Customer Pay · Warranty'
        : 'Warranty · Internal';
  return `Grid ${band} (part ${Number(m[2])})`;
}

const modules: Array<[string, string, Capture]> = [
  ['autogroup', 'AutoGroup v2 — Service Summary', autogroup],
  ['dms', 'DMS — Service Dashboard', dms],
];

const screenshots: ScreenshotRef[] = [];
for (const [target, moduleLabel, cap] of modules) {
  const manifest = (cap as Capture & {
    screenshots?: { viewport?: string | null; fullPage?: string | null; slices?: string[] };
  }).screenshots;

  const files: Array<[string, string]> = [];
  if (manifest?.viewport) files.push([manifest.viewport, 'Screen as loaded']);
  for (const s of manifest?.slices ?? []) files.push([s, sliceCaption(s)]);
  if (manifest?.fullPage) files.push([manifest.fullPage, 'Full page']);

  // Fall back to a directory guess if the capture predates the manifest.
  if (!files.length) {
    for (const f of ['viewport.png', 'fullpage.png']) {
      if (existsSync(path.resolve(CAPTURE_DIR, target, f))) files.push([f, f]);
    }
  }

  for (const [file, caption] of files) {
    const abs = path.resolve(CAPTURE_DIR, target, file);
    if (!existsSync(abs)) continue;
    screenshots.push({
      module: moduleLabel,
      caption,
      absPath: abs,
      relPath: path.relative(OUT_DIR, abs).split(path.sep).join('/'),
    });
  }
}

const html = await renderHtml({
  comparison,
  rowFormulas,
  columnChecks,
  days,
  screenshots,
  runStartedAt: autogroup.capturedAt,
  runFinishedAt: dms.capturedAt,
});

const htmlPath = path.join(OUT_DIR, 'reconciliation.html');
await writeFile(htmlPath, html, 'utf8');
await writeFile(
  path.join(OUT_DIR, 'reconciliation.json'),
  JSON.stringify({ comparison, rowFormulas, columnChecks, days }, null, 2),
  'utf8',
);
await writeFile(path.join(OUT_DIR, 'reconciliation.md'), toMarkdown(comparison), 'utf8');

// --- console summary ---
const s = comparison.summary;
console.log('');
console.log('Value comparison   : ' + `${s.matched}/${s.totalCells} matched, ${s.mismatched} different`);
console.log(
  'Row formulas (DMS) : ' +
    `${rowFormulas.summary.passed}/${rowFormulas.summary.total} passed, ` +
    `${rowFormulas.summary.failed} failed, ${rowFormulas.summary.unresolved} unresolved`,
);
console.log(
  'Column formulas    : ' +
    `${columnChecks.summary.passed}/${columnChecks.summary.total} passed, ${columnChecks.summary.failed} failed`,
);
console.log(`Screenshots        : ${screenshots.length} embedded`);
console.log('');
console.log(`HTML report -> ${htmlPath}`);

const failed =
  s.mismatched > 0 || s.missing > 0 || rowFormulas.summary.failed > 0 || columnChecks.summary.failed > 0;
process.exit(failed ? 1 : 0);
