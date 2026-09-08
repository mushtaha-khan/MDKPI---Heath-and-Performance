/**
 * Suite runner — the tool entry point.
 *
 * Give it a module name and the two URLs; it logs in to each side with the right role,
 * reloads both screens, captures evidence, derives the column geometry, matches rows,
 * compares every shared column group, validates formulas where the screen exposes
 * them, writes a self-contained HTML report, and prints the report URL.
 *
 * Everything here is deterministic Node code — no AI involvement at run time.
 *
 * Usage:
 *   npm run suite -- --module "Service Summary" \
 *     --autogroup https://your-tenant.mydealerkpi.com/auto-group-v2/service/service-summary \
 *     --dms       https://your-tenant.mydealerkpi.com/report/services/dashboard
 *
 * Options:
 *   --module <name>          Module label used in the report and run folder
 *   --autogroup <url>        Full AutoGroup screen URL
 *   --dms <url>              Full DMS screen URL
 *   --autogroup-role <role>  Login role for the AutoGroup side (default AUTOGROUP)
 *   --dms-role <role>        Login role for the DMS side (default DEALER)
 *   --preset <file>          Module preset JSON (defaults to modules/<slug>.json if present)
 *   --port <n>               Port for the report server (default 8080)
 *   --no-serve               Skip starting the server; just print the file path
 *   --no-formulas            Skip tooltip formula harvesting (faster)
 *   --source <gui|cli>       Who launched this run (default cli)
 *
 * Only runs launched from the GUI are listed as reports. Command-line runs still write
 * their output, but are tagged `cli` and kept out of the report history so that
 * debugging and verification do not accumulate as deliverable reports.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { runSuite, type Capture, type ModulePreset } from '../core/suite.js';
import { groupSubColumns } from '../core/columns.js';
import {
  readDayContextDetailed,
  validateColumnsWithGeometry,
  validateFormulasWithGeometry,
  type ColumnCheck,
  type ExtractedFormula,
  type FormulaValidationResult,
} from '../core/formulas.js';
import { renderSuiteHtml, type ScreenshotRef, type SideFormulas } from '../core/suite-report.js';
import { formatDateTime, formatDateTimeForFile } from '../core/datetime.js';
import { titleCaseModuleName } from '../core/module-name.js';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function fail(msg: string): never {
  console.error(`\n${msg}\n`);
  console.error('Usage:');
  console.error('  npm run suite -- --module "Service Summary" \\');
  console.error('    --autogroup <autogroup screen url> \\');
  console.error('    --dms <dms screen url>');
  console.error('');
  console.error('Optional: --autogroup-role --dms-role --preset --port --no-serve --no-formulas');
  process.exit(2);
}

const agUrl = String(args.autogroup ?? '').trim();
const dmsUrl = String(args.dms ?? '').trim();

if (!agUrl) fail('Missing --autogroup <url>.');
if (!dmsUrl) fail('Missing --dms <url>.');

/**
 * Derive a readable module name from the screen URLs when one is not supplied, so the
 * two URLs are the only required input. Uses the deepest meaningful path segment,
 * preferring the AutoGroup side because its paths name the report directly
 * (".../service/service-summary" -> "Service Summary").
 */
function deriveModuleName(primary: string, fallback: string): string {
  const noise = new Set(['report', 'reports', 'v2', 'auto-group', 'auto-group-v2', 'dashboard', 'index']);
  const pick = (u: string): string | null => {
    let segs: string[];
    try {
      segs = new URL(u).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return null;
    }
    // Walk from the end for the first segment that is not structural noise.
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i]!.toLowerCase();
      if (!noise.has(s) && !/^\d+$/.test(s)) return segs[i]!;
    }
    return segs.at(-1) ?? null;
  };

  return titleCaseModuleName(pick(primary) ?? pick(fallback) ?? 'module');
}

const moduleName = String(args.module ?? '').trim() || deriveModuleName(agUrl, dmsUrl);
if (!args.module) console.log(`Module name derived from URL: "${moduleName}"`);

for (const [label, u] of [
  ['--autogroup', agUrl],
  ['--dms', dmsUrl],
] as const) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
      console.warn(`Warning: ${label} is not https (${parsed.protocol}).`);
    }
  } catch {
    fail(`${label} is not a valid URL: ${u}`);
  }
}

const agRole = String(args['autogroup-role'] ?? process.env.KPI_ROLE_AUTOGROUP ?? 'AUTOGROUP');
const dmsRole = String(args['dms-role'] ?? process.env.KPI_ROLE_DEALER ?? 'DEALER');
const port = Number(args.port ?? 8080);
const doServe = args['no-serve'] !== true;
const doFormulas = args['no-formulas'] !== true;

// Runs are only treated as reports when they came from the GUI with entered URLs.
const source = String(args.source ?? 'cli').toLowerCase() === 'gui' ? 'gui' : 'cli';

const slug = moduleName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

// Date and time first so runs sort chronologically, then the module name, so a folder
// listing reads as "when, what" at a glance.
const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const stamp =
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
  `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

const runId = `${stamp}__${slug}`;
const runDir = path.join('artifacts', 'runs', runId);

/**
 * Report filename: the module name as it reads, plus both sides and the run time.
 *
 * The slug is only used for directory names; the report itself is something people
 * open and forward, so it keeps the readable module name ("Technician Performance"
 * rather than "technician-performance"). Characters Windows forbids in filenames are
 * stripped, but spaces are kept.
 */
const safeModuleName = moduleName.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
/**
 * The filename carries the run time the way a person writes it: DD-MM-YYYY and a 12-hour
 * clock without seconds. The run *directory* keeps the sortable YYYY-MM-DD_HH-MM-SS stamp,
 * because it is parsed and ordered as a key — DD-MM-YYYY does not sort chronologically, and
 * without seconds two runs a moment apart would share an identifier.
 */
const reportFileName = `${safeModuleName} - AutoGroup vs DMS - ${formatDateTimeForFile(now)}.html`;

// ---------------------------------------------------------------------------
// Module preset (optional)
// ---------------------------------------------------------------------------

async function loadPreset(): Promise<ModulePreset> {
  const explicit = args.preset ? String(args.preset) : null;
  const candidate = explicit ?? path.join('modules', `${slug}.json`);
  if (existsSync(candidate)) {
    const preset = JSON.parse(await readFile(candidate, 'utf8')) as ModulePreset;
    console.log(`Preset: ${candidate}`);
    return { ...preset, name: preset.name ?? moduleName };
  }
  if (explicit) fail(`Preset not found: ${explicit}`);
  console.log(`Preset: none (modules/${slug}.json not found) — using automatic matching only`);
  return { name: moduleName };
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

function run(cmd: string, cmdArgs: string[], quiet = false): Promise<number> {
  return new Promise((resolve) => {
    const needsShell = cmd === 'npx' && process.platform === 'win32';
    const child = spawn(cmd, cmdArgs, {
      stdio: quiet ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      shell: needsShell,
    });
    if (quiet && child.stdout) child.stdout.resume();
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`  spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

function stage(n: number, total: number, title: string) {
  const line = `[${n}/${total}] ${title}`;
  console.log(`\n${'='.repeat(Math.min(78, line.length + 2))}\n${line}\n${'='.repeat(Math.min(78, line.length + 2))}`);
}

const t0 = performance.now();
const preset = await loadPreset();
await mkdir(runDir, { recursive: true });

// --from rebuilds the report from an existing run's captures, without touching the
// portal. Useful for regenerating a report after a analysis change, and for
// iterating without burning several minutes of page loads.
const reuseDir = args.from ? String(args.from) : null;
const workDir = reuseDir ?? runDir;
const agDir = path.join(workDir, 'autogroup');
const dmsDir = path.join(workDir, 'dms');
const formulaFile = path.join(workDir, 'formulas', 'formulas.json');

const totalStages = reuseDir ? 1 : doFormulas ? 4 : 3;
let stageNo = 0;

if (reuseDir) {
  if (!existsSync(agDir) || !existsSync(dmsDir)) {
    fail(`--from ${reuseDir} does not contain autogroup/ and dms/ captures.`);
  }
  console.log(`Reusing captures from ${reuseDir} (no portal access)`);
} else {
  // --- 1. capture AutoGroup ---
  stage(++stageNo, totalStages, `Capture ${agRole}: ${agUrl}`);
  let code = await run(process.execPath, [
    'scripts/capture-screens.mjs',
    '--url', agUrl,
    '--role', agRole,
    '--key', 'autogroup',
    // The module name is already the report title; repeating it here made headings
    // read "Service Summary — AutoGroup — Service Summary vs DMS — Service Summary".
    '--label', 'AutoGroup',
    '--out', agDir,
  ]);
  if (code !== 0) {
    console.error('\nAutoGroup capture failed. Cannot continue.');
    process.exit(1);
  }

  // --- 2. capture DMS ---
  stage(++stageNo, totalStages, `Capture ${dmsRole}: ${dmsUrl}`);
  code = await run(process.execPath, [
    'scripts/capture-screens.mjs',
    '--url', dmsUrl,
    '--role', dmsRole,
    '--key', 'dms',
    '--label', 'DMS',
    '--out', dmsDir,
  ]);
  if (code !== 0) {
    console.error('\nDMS capture failed. Cannot continue.');
    process.exit(1);
  }

  // --- 3. formulas from BOTH screens ---
  // Each screen documents its own formulas, so each is checked against itself.
  // Harvesting only one side left half the module unexamined.
  if (doFormulas) {
    stage(++stageNo, totalStages, 'Harvest formulas from both screens');
    for (const [label, url, role, out] of [
      ['AutoGroup', agUrl, agRole, path.join(workDir, 'formulas', 'autogroup')],
      ['DMS', dmsUrl, dmsRole, path.join(workDir, 'formulas', 'dms')],
    ] as const) {
      console.log(`\n-- ${label} --`);
      const fcode = await run(process.execPath, [
        'scripts/extract-formulas.mjs',
        '--mode', 'full',
        '--url', url,
        '--role', role,
        '--out', out,
      ]);
      if (fcode !== 0) console.log(`(${label} formula harvesting failed; that section will be omitted)`);
    }
  }
}

// --- 4. compare + report ---
stage(++stageNo, totalStages, 'Compare and build report');

const loadCapture = async (dir: string, name: string): Promise<Capture> => {
  const file = path.join(dir, 'capture.json');
  if (!existsSync(file)) throw new Error(`Missing ${file} for ${name}.`);
  const cap = JSON.parse(await readFile(file, 'utf8')) as Capture;
  if (cap.error && !cap.rendered) throw new Error(`${name} capture failed: ${cap.error}`);
  return cap;
};

const left = await loadCapture(agDir, 'AutoGroup');
const right = await loadCapture(dmsDir, 'DMS');

const result = runSuite(left, right, preset);

// --- formula validation, per side, driven by each side's own derived geometry ---
const dayResult = readDayContextDetailed(right.rendered?.tables ?? []);
const days = dayResult.days;
const sides: SideFormulas[] = [];

for (const [label, capture, dir, legacy] of [
  [left.label, left, path.join(workDir, 'formulas', 'autogroup'), null],
  // Runs made before per-side harvesting wrote a single file at formulas/formulas.json,
  // which was always the DMS side. Honour it so older captures can still be reused.
  [right.label, right, path.join(workDir, 'formulas', 'dms'), path.join(workDir, 'formulas')],
] as const) {
  let file = path.join(dir, 'formulas.json');
  if (!existsSync(file) && legacy) {
    const alt = path.join(legacy, 'formulas.json');
    if (existsSync(alt)) {
      file = alt;
      console.log(`(using legacy formula file for ${label}: ${alt})`);
    }
  }
  if (!existsSync(file)) continue;

  const parsed = JSON.parse(await readFile(file, 'utf8')) as { results: ExtractedFormula[] };
  const formulas = parsed.results.filter((f) => f.formula);
  if (!formulas.length) continue;

  // Validate against every grid on this side that the comparison actually used, so
  // the formula checks line up with the columns being compared.
  const side: SideFormulas = { label };
  const rowChecks: FormulaValidationResult['checks'] = [];
  const colChecks: ColumnCheck[] = [];
  const missingRefs = new Set<string>();

  for (const gridResult of result.grids) {
    const isLeftSide = capture === left;
    const geo = isLeftSide ? gridResult.geometry.left : gridResult.geometry.right;

    // Identify which captured table this grid came from by looking for the row labels
    // the comparison actually matched. Matching on shape alone would be ambiguous when
    // a screen renders several similarly sized tables.
    const wanted = gridResult.metrics.map((m) => (isLeftSide ? m.leftLabel : m.rightLabel));
    const source = (capture.rendered?.tables ?? []).find((t) => {
      const labels = new Set(t.rows.map((r) => (r[geo.labelColumn] ?? '').trim()).filter(Boolean));
      return wanted.filter((w) => labels.has(w)).length >= Math.min(3, wanted.length);
    });
    if (!source) continue;

    const rf = validateFormulasWithGeometry(
      source.rows,
      formulas,
      gridResult.groups,
      (g) => geo.primaryByGroup.get(g) ?? null,
      geo.labelColumn,
    );
    rowChecks.push(...rf.checks);
    rf.missingReferences.forEach((x) => missingRefs.add(x));

    const cc = validateColumnsWithGeometry(
      source.rows,
      days,
      gridResult.groups,
      (g) => groupSubColumns(geo, g),
      geo.labelColumn,
    );
    colChecks.push(...cc.checks);
  }

  if (rowChecks.length) {
    side.rowFormulas = {
      checks: rowChecks,
      summary: {
        total: rowChecks.length,
        passed: rowChecks.filter((c) => c.verdict === 'pass').length,
        failed: rowChecks.filter((c) => c.verdict === 'fail').length,
        unresolved: rowChecks.filter((c) => c.verdict === 'unresolved').length,
        noData: rowChecks.filter((c) => c.verdict === 'no-data').length,
      },
      missingReferences: [...missingRefs].sort(),
    };
  }
  if (colChecks.length) {
    side.columnChecks = {
      checks: colChecks,
      summary: {
        total: colChecks.length,
        passed: colChecks.filter((c) => c.verdict === 'pass').length,
        failed: colChecks.filter((c) => c.verdict === 'fail').length,
      },
    };
  }
  if (side.rowFormulas || side.columnChecks) sides.push(side);
}

// --- screenshots ---
function sliceCaption(file: string): string {
  const m = /^grid-(left|mid|right)-(\d+)\.png$/.exec(file);
  if (!m) return file.replace(/\.png$/, '');
  const band = m[1] === 'left' ? 'leading columns' : m[1] === 'mid' ? 'middle columns' : 'trailing columns';
  return `Grid ${band} (part ${Number(m[2])})`;
}

/** The horizontal band a slice covers, or null for whole-screen shots. */
function sliceBand(file: string): 'left' | 'mid' | 'right' | null {
  const m = /^grid-(left|mid|right)-\d+\.png$/.exec(file);
  return m ? (m[1] as 'left' | 'mid' | 'right') : null;
}

const screenshots: ScreenshotRef[] = [];
for (const [dir, cap, side] of [
  [agDir, left, 'left'],
  [dmsDir, right, 'right'],
] as const) {
  const man = cap.screenshots;
  const files: Array<[string, string]> = [];
  if (man?.viewport) files.push([man.viewport, 'Screen as loaded']);
  for (const s of man?.slices ?? []) files.push([s, sliceCaption(s)]);
  if (man?.fullPage) files.push([man.fullPage, 'Full page']);

  for (const [file, caption] of files) {
    const abs = path.resolve(dir, file);
    if (!existsSync(abs)) continue;
    screenshots.push({
      module: cap.label,
      caption,
      absPath: abs,
      relPath: path.relative(runDir, abs).split(path.sep).join('/'),
      side,
      band: sliceBand(file),
    });
  }
}

const command = [
  'npm run suite --',
  `--module "${moduleName}"`,
  `--autogroup ${agUrl}`,
  `--dms ${dmsUrl}`,
].join(' ');

const html = await renderSuiteHtml({
  result,
  screenshots,
  sides,
  days,
  daysStatus: dayResult.status,
  runId,
  command,
  inputs: {
    autogroupUrl: agUrl,
    dmsUrl: dmsUrl,
    autogroupRole: agRole,
    dmsRole: dmsRole,
    moduleName,
    moduleNameDerived: !args.module,
  },
  capturedThisRun: !reuseDir,
  capturedAt: { left: left.capturedAt, right: right.capturedAt },
});

const htmlPath = path.join(runDir, reportFileName);
await writeFile(htmlPath, html, 'utf8');
await writeFile(
  path.join(runDir, 'result.json'),
  JSON.stringify({ result, sides, days }, null, 2),
  'utf8',
);

const formulaTotals = {
  rowPassed: sides.reduce((a, x) => a + (x.rowFormulas?.summary.passed ?? 0), 0),
  rowFailed: sides.reduce((a, x) => a + (x.rowFormulas?.summary.failed ?? 0), 0),
  rowTotal: sides.reduce((a, x) => a + (x.rowFormulas?.summary.total ?? 0), 0),
  colPassed: sides.reduce((a, x) => a + (x.columnChecks?.summary.passed ?? 0), 0),
  colFailed: sides.reduce((a, x) => a + (x.columnChecks?.summary.failed ?? 0), 0),
  colTotal: sides.reduce((a, x) => a + (x.columnChecks?.summary.total ?? 0), 0),
};

// Compact metadata so the GUI and the index can list runs without parsing the
// full result payload.
await writeFile(
  path.join(runDir, 'meta.json'),
  JSON.stringify(
    {
      runId,
      moduleName,
      reportFile: reportFileName,
      /** 'gui' runs are listed as reports; 'cli' runs are kept out of the history. */
      source,
      startedAt: now.toISOString(),
      finishedAt: new Date().toISOString(),
      autogroupUrl: agUrl,
      dmsUrl: dmsUrl,
      autogroupRole: agRole,
      dmsRole: dmsRole,
      groups: Object.keys(result.summary.byGroup),
      /** Set when nothing could be compared, so the history badges the run honestly. */
      blocked: result.blocked?.reason ?? null,
      /** Which comparison mode was used, so the history shows it without opening the report. */
      mode: result.mode.mode,
      /** Coverage limits that did not stop the comparison, so history can distinguish them. */
      limitations: result.limitations.map((l) => l.reason),
      /** Which comparison passes ran, so coverage is visible without opening the report. */
      passes: result.coverage.map((p) => ({
        name: p.name,
        status: p.status,
        compared: p.compared,
        differences: p.differences,
      })),
      analytics: result.analytics
        ? {
            compared: result.analytics.compared,
            matched: result.analytics.matched,
            mismatched: result.analytics.mismatched,
            onlyOnLeft: result.analytics.onlyOnLeft.length,
            onlyOnRight: result.analytics.onlyOnRight.length,
          }
        : null,
      records: result.recordComparison
        ? {
            ...result.recordComparison.summary,
            columnsCompared: result.recordComparison.columnPairs.length,
            onlyOnLeft: result.recordComparison.onlyOnLeft.length,
            onlyOnRight: result.recordComparison.onlyOnRight.length,
          }
        : null,
      detailViews: result.mode.detailViews.map((v) => ({
        side: v.sideLabel,
        name: v.name,
        records: v.records,
        expectedRecords: v.expectedRecords,
        used: v.usable,
      })),
      summary: result.summary,
      grids: result.grids.map((g) => ({
        name: g.name,
        groups: g.groups,
        metricsAligned: g.coverage.matched,
        cells: g.summary,
        unmatchedLeft: g.coverage.unmatchedLeft.length,
        unmatchedRight: g.coverage.unmatchedRight.length,
      })),
      coverage: {
        matched: result.grids.reduce((a, g) => a + g.coverage.matched, 0),
        unmatchedLeft: result.grids.reduce((a, g) => a + g.coverage.unmatchedLeft.length, 0),
        unmatchedRight: result.grids.reduce((a, g) => a + g.coverage.unmatchedRight.length, 0),
      },
      rowFormulas: formulaTotals.rowTotal
        ? { passed: formulaTotals.rowPassed, failed: formulaTotals.rowFailed, total: formulaTotals.rowTotal }
        : null,
      columnChecks: formulaTotals.colTotal
        ? { passed: formulaTotals.colPassed, failed: formulaTotals.colFailed, total: formulaTotals.colTotal }
        : null,
      screenshots: screenshots.length,
      reusedCaptures: Boolean(reuseDir),
    },
    null,
    2,
  ),
  'utf8',
);

// Refresh the index of all runs so the server root is browsable.
await writeRunsIndex();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const s = result.summary;
const secs = ((performance.now() - t0) / 1000).toFixed(1);

console.log('');
console.log('='.repeat(78));
console.log(`RESULT — ${result.moduleName}`);
console.log('='.repeat(78));
console.log(`Run at                 : ${formatDateTime(now)}`);
// What the crawl observed, so the approach taken is visible in the console too.
console.log('Comparison coverage:');
for (const p of result.coverage) {
  const mark = p.status === 'ran' ? 'RAN    ' : p.status === 'blocked' ? 'BLOCKED' : 'n/a    ';
  console.log(
    `  ${mark} ${p.name.padEnd(42)} ${p.status === 'ran' ? `${p.compared} ${p.unit}, ${p.differences} different` : ''}`,
  );
  if (p.status === 'blocked') console.log(`          ${p.detail}`);
}
console.log('');
console.log(`Mode                   : ${result.mode.mode}`);
console.log(`  ${result.mode.reason}`);
console.log('');
console.log('Structure:');
for (const [side, structures] of [
  [result.left.label, result.structure.left],
  [result.right.label, result.structure.right],
] as const) {
  for (const st of structures) {
    console.log(
      `  ${side.padEnd(12)} ${st.role.toUpperCase().padEnd(8)} ${st.name.slice(0, 34).padEnd(34)} ` +
        `rows=${String(st.bodyRows).padStart(4)} conf=${st.confidence}` +
        `${st.transposed ? ' PIVOTED' : ''}${st.pageSize ? ` page=${st.pageSize}` : ''}`,
    );
  }
}
console.log('');
console.log('Observed tables:');
for (const [side, tables] of [
  [result.left.label, result.observation.leftTables],
  [result.right.label, result.observation.rightTables],
] as const) {
  for (const t of tables) {
    console.log(
      `  ${side.padEnd(30)} ${t.name.slice(0, 34).padEnd(34)} ` +
        `rows=${String(t.rows).padStart(4)}  ${t.paired ? 'COMPARED' : 'no counterpart'}`,
    );
  }
}

if (result.blocked) {
  console.log('');
  console.log('!'.repeat(78));
  console.log(`NOT COMPARED — ${result.blocked.reason}`);
  console.log('!'.repeat(78));
  console.log(result.blocked.detail);
  console.log('');
  console.log('What to check:');
  for (const step of result.blocked.remedy) console.log(`  - ${step}`);
  console.log('');
  console.log('A report was still written, with both screens\' table structures and screenshots.');
}

for (const lim of result.limitations) {
  console.log('');
  console.log(`PARTIAL — ${lim.reason}`);
  console.log(`  ${lim.detail}`);
  console.log('  (Other parts of this module were still compared; see below.)');
}

if (result.analytics) {
  const a = result.analytics;
  console.log('');
  console.log(`Analytics cards        : ${a.matched}/${a.compared} matched, ${a.mismatched} different`);
  console.log(`  only on ${result.left.label}: ${a.onlyOnLeft.length}   only on ${result.right.label}: ${a.onlyOnRight.length}`);
  for (const p of a.pairs.filter((x) => x.verdict !== 'match')) {
    console.log(
      `    ${p.label.slice(0, 24).padEnd(26)} ${(p.left.raw || '—').padStart(14)}  vs  ` +
        `${(p.right.raw || '—').padStart(14)}  Δ${p.delta ?? '—'}   (${p.rightLabel})`,
    );
  }
}

if (result.recordComparison) {
  const rc = result.recordComparison;
  console.log('');
  console.log(
    `Record comparison      : ${rc.summary.recordsCompared} record(s) x ${rc.columnPairs.length} column(s)`,
  );
  console.log(`  key column           : ${rc.keyColumn.left} <-> ${rc.keyColumn.right}`);
  console.log(
    `  cells                : ${rc.summary.matched}/${rc.summary.totalCells} matched ` +
      `(${rc.summary.formattingOnly} after allowing formatting), ${rc.summary.mismatched} different, ` +
      `${rc.summary.missing} missing`,
  );
  console.log(`  records one side only: ${rc.onlyOnLeft.length} / ${rc.onlyOnRight.length}`);
  if (rc.unpairedLeft.length || rc.unpairedRight.length) {
    console.log(
      `  columns not compared : ${[...rc.unpairedLeft, ...rc.unpairedRight].join(', ')}`,
    );
  }
}

console.log('');
console.log(`Grids compared         : ${s.gridsCompared}`);
console.log(`Value cells            : ${s.totalCells}`);
console.log(`  matched              : ${s.matched}`);
console.log(`  different            : ${s.mismatched}`);
console.log(`  missing one side     : ${s.missing}`);
for (const [g, b] of Object.entries(s.byGroup)) {
  console.log(`    ${g.padEnd(14)} matched=${String(b.matched).padStart(3)} different=${String(b.mismatched).padStart(3)}`);
}
for (const side of sides) {
  if (side.rowFormulas) {
    console.log(
      `Row formulas (${side.label.slice(0, 12).padEnd(12)}): ${side.rowFormulas.summary.passed}/${side.rowFormulas.summary.total} passed, ` +
        `${side.rowFormulas.summary.failed} failed, ${side.rowFormulas.summary.unresolved} unresolved`,
    );
  }
  if (side.columnChecks) {
    console.log(
      `Derived cols (${side.label.slice(0, 12).padEnd(12)}): ${side.columnChecks.summary.passed}/${side.columnChecks.summary.total} passed, ` +
        `${side.columnChecks.summary.failed} failed`,
    );
  }
}
console.log(`Screenshots            : ${screenshots.length}`);
console.log(`Elapsed                : ${secs}s`);

if (s.mismatched > 0) {
  console.log('');
  console.log('Differences:');
  for (const grid of result.grids) {
    if (grid.summary.mismatched === 0) continue;
    if (result.grids.length > 1) console.log(`  [${grid.name}]`);
    for (const m of grid.metrics) {
      for (const c of m.cells) {
        if (c.verdict === 'match') continue;
        console.log(
          `  ${m.leftLabel.padEnd(28)} ${c.group.padEnd(14)} ` +
            `${(c.left.raw || '—').padStart(14)}  vs  ${(c.right.raw || '—').padStart(14)}  ` +
            `Δ${c.delta ?? '—'}`,
        );
      }
    }
  }
}

console.log('');
console.log('REPORT');
console.log(`  file  ${path.resolve(htmlPath)}`);
console.log(`  url   ${pathToFileURL(path.resolve(htmlPath)).href}`);

// Machine-readable markers. The GUI parses these instead of guessing which run
// directory is newest — timestamped directory names do not sort reliably across
// naming changes, and an unrelated newer folder would otherwise be reported.
console.log(`##RUN_ID=${runId}`);
console.log(`##RUN_DIR=${path.resolve(runDir)}`);
console.log(`##REPORT_FILE=${reportFileName}`);

if (doServe) {
  const { startServer } = await import('../core/server.js');
  const info = await startServer(path.join('artifacts', 'runs'), port);
  console.log(`  http  ${info.url}${encodeURIComponent(runId)}/${encodeURIComponent(reportFileName)}`);
  console.log(`  index ${info.url}`);
  console.log('');
  console.log('Server is loopback-only. Ctrl+C to stop.');
} else {
  console.log('');
  console.log(`Serve later with:  npm run runs -- ${port}`);
}

/** Write an index.html listing every run, newest first. */
async function writeRunsIndex(): Promise<void> {
  const { listRuns, renderRunsIndex } = await import('../core/runs.js');
  const runsRoot = path.join('artifacts', 'runs');
  const runs = await listRuns(runsRoot);
  await writeFile(path.join(runsRoot, 'index.html'), renderRunsIndex(runs), 'utf8');
}
