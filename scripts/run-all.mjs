/**
 * One-shot pipeline: reload both screens, harvest formulas, build the HTML report.
 *
 * Runs the stages in order and keeps going when a stage exits non-zero for an
 * expected reason. `report:html` deliberately exits 1 when differences are found so
 * it can gate CI, which would otherwise abort a shell `&&` chain — that is a result,
 * not a failure of the run.
 *
 * Usage: npm run all
 */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STAGES = [
  {
    name: 'Capture both screens (fresh login + reload + screenshots)',
    cmd: process.execPath,
    args: ['scripts/capture-screens.mjs', 'both'],
    // A capture failure is fatal: everything downstream reads its output.
    fatal: true,
  },
  {
    name: 'Extract row formulas from DMS tooltips',
    cmd: process.execPath,
    args: ['scripts/extract-formulas.mjs', 'full'],
    // Non-fatal: the report still builds, just without row-formula validation.
    fatal: false,
  },
  {
    name: 'Validate + build HTML report',
    cmd: 'npx',
    args: ['tsx', 'src/cli/report.ts'],
    // Exit 1 here means "differences found", which is an outcome we want reported.
    fatal: false,
    expectedNonZero: true,
  },
  {
    name: 'Verify the report renders',
    cmd: process.execPath,
    args: ['scripts/verify-report.mjs'],
    fatal: false,
  },
];

function run(stage) {
  return new Promise((resolve) => {
    // Only shell out for `npx`, which needs it on Windows. Running node itself
    // through a shell breaks on the space in "C:\Program Files\nodejs\node.exe".
    const needsShell = stage.cmd === 'npx' && process.platform === 'win32';
    const child = spawn(stage.cmd, stage.args, {
      stdio: 'inherit',
      shell: needsShell,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`  spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

const results = [];
let aborted = false;

for (const [i, stage] of STAGES.entries()) {
  const label = `[${i + 1}/${STAGES.length}] ${stage.name}`;
  console.log(`\n${'='.repeat(Math.min(78, label.length + 2))}`);
  console.log(label);
  console.log('='.repeat(Math.min(78, label.length + 2)));

  const t0 = performance.now();
  const code = await run(stage);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);

  const ok = code === 0 || (stage.expectedNonZero && code === 1);
  results.push({ name: stage.name, code, secs, ok });

  if (!ok && stage.fatal) {
    console.error(`\nStage failed (exit ${code}) and is required. Stopping.`);
    aborted = true;
    break;
  }
  if (!ok) {
    console.log(`\n(stage exited ${code}; continuing — not required for the report)`);
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log('PIPELINE SUMMARY');
console.log('='.repeat(78));
for (const r of results) {
  console.log(`${r.ok ? 'OK  ' : 'WARN'}  ${r.secs.padStart(6)}s  ${r.name}  (exit ${r.code})`);
}

if (!aborted) {
  const htmlPath = path.resolve('artifacts/reports/reconciliation.html');
  console.log('');
  console.log('Report:');
  console.log(`  file  ${htmlPath}`);
  console.log(`  url   ${pathToFileURL(htmlPath).href}`);
  console.log('');
  console.log('For a browsable http:// URL, run:  npm run serve');
}

process.exit(aborted ? 1 : 0);
