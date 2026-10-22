/**
 * Regression harness for the comparison engine.
 *
 * Rebuilds each known-good module from captures already on disk and checks the numbers
 * still come out the same. Because it drives the suite with --from, it needs no portal
 * access and no credentials, and finishes in seconds — so it can be run after every
 * change to the engine rather than only when something looks wrong.
 *
 * The point is to make "nothing else broke" checkable. Every change to column geometry,
 * row matching or structure classification affects every module, and the only way to
 * notice a silent regression is to hold the inputs fixed and compare the outputs.
 *
 * Usage:
 *   npm run baseline                       check every entry
 *   npm run baseline -- --only "Open RO"   check one
 *   npm run baseline -- --update           rewrite baselines.json from what runs now
 *   npm run baseline -- --keep             leave the rebuilt run directories in place
 *
 * --update is for deliberate re-baselining, after a change that is *meant* to move the
 * numbers. It prints what it changed, so an unintended shift still gets seen.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RUNS_ROOT = path.resolve('artifacts', 'runs');
const BASELINE_FILE = 'baselines.json';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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

/** Run the suite against stored captures and return the meta it produced. */
function rebuild(entry, sourceMeta) {
  const runDir = path.join('artifacts', 'runs', entry.run);
  const argv = [
    '--import', 'tsx', 'src/cli/suite.ts',
    '--from', runDir,
    '--module', entry.module,
    '--autogroup', sourceMeta.autogroupUrl,
    '--dms', sourceMeta.dmsUrl,
    '--autogroup-role', sourceMeta.autogroupRole ?? 'AUTOGROUP',
    '--dms-role', sourceMeta.dmsRole ?? 'DEALER',
    '--no-serve',
    // Tag as a command-line run so rebuilt comparisons never appear in the report history.
    '--source', 'cli',
  ];

  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, FORCE_COLOR: '0' },
      windowsHide: true,
    });
    let out = '';
    child.stdout?.on('data', (b) => (out += b.toString()));
    child.stderr?.on('data', (b) => (out += b.toString()));
    child.on('close', () => {
      // The runner announces where it wrote its output, so this never has to guess.
      const id = /##RUN_ID=(.+)/.exec(out)?.[1]?.trim() ?? null;
      resolve({ runId: id, log: out });
    });
    child.on('error', (err) => resolve({ runId: null, log: `spawn failed: ${err.message}` }));
  });
}

/** Reduce a produced meta.json to the shape baselines.json records. */
function actualOf(meta) {
  // Record what each pass compared and found, not just whether it ran. Status alone missed
  // a real change: a corroboration check that stopped being made left the status at "ran"
  // and the harness reported nothing, which is precisely the blind spot a regression suite
  // must not have.
  const passes = {};
  for (const p of meta.passes ?? []) {
    passes[p.name] = `${p.status}/${p.compared ?? 0} compared/${p.differences ?? 0} diff`;
  }
  return {
    mode: meta.mode ?? null,
    blocked: meta.blocked ?? null,
    limitations: (meta.limitations ?? []).length,
    grids: meta.summary?.gridsCompared ?? 0,
    cells: {
      total: meta.summary?.totalCells ?? 0,
      matched: meta.summary?.matched ?? 0,
      mismatched: meta.summary?.mismatched ?? 0,
      missing: meta.summary?.missing ?? 0,
    },
    analytics: meta.analytics
      ? {
          compared: meta.analytics.compared,
          matched: meta.analytics.matched,
          mismatched: meta.analytics.mismatched,
        }
      : null,
    records: meta.records
      ? {
          totalCells: meta.records.totalCells,
          matched: meta.records.matched,
          mismatched: meta.records.mismatched,
          missing: meta.records.missing,
          columnsCompared: meta.records.columnsCompared,
        }
      : null,
    rowFormulas: meta.rowFormulas
      ? { passed: meta.rowFormulas.passed, total: meta.rowFormulas.total }
      : null,
    columnChecks: meta.columnChecks
      ? { passed: meta.columnChecks.passed, total: meta.columnChecks.total }
      : null,
    passes,
  };
}

/**
 * Compare expected against actual, returning one line per difference.
 *
 * Walks the structure rather than diffing JSON text, so a difference reads as
 * "cells.matched 124 -> 118" instead of an unhelpful blob.
 */
function diff(expected, actual, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  for (const k of keys) {
    const e = expected?.[k];
    const a = actual?.[k];
    const label = prefix ? `${prefix}.${k}` : k;
    const isObj = (v) => v && typeof v === 'object';
    if (isObj(e) && isObj(a)) {
      out.push(...diff(e, a, label));
    } else if (isObj(e) !== isObj(a)) {
      out.push(`${label}: ${JSON.stringify(e) ?? 'null'} -> ${JSON.stringify(a) ?? 'null'}`);
    } else if (e !== a) {
      out.push(`${label}: ${e === null || e === undefined ? 'null' : e} -> ${a === null || a === undefined ? 'null' : a}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

const spec = JSON.parse(await readFile(BASELINE_FILE, 'utf8'));
let entries = spec.entries;
if (args.only) {
  const want = String(args.only).toLowerCase();
  entries = entries.filter((e) => e.module.toLowerCase().includes(want));
  if (!entries.length) {
    console.error(`No baseline entry matching "${args.only}".`);
    process.exit(2);
  }
}

const results = [];

for (const entry of entries) {
  const dir = path.join(RUNS_ROOT, entry.run);
  const sourceMetaPath = path.join(dir, 'meta.json');

  if (
    !existsSync(path.join(dir, 'autogroup', 'capture.json')) ||
    !existsSync(path.join(dir, 'dms', 'capture.json')) ||
    !existsSync(sourceMetaPath)
  ) {
    // Never pass an entry that could not be checked. A corpus that quietly shrinks is
    // worse than one that complains, because the checks it stops making are invisible.
    console.log(`UNAVAILABLE  ${entry.module}  (captures not on this machine: ${entry.run})`);
    results.push({ entry, status: 'unavailable', diffs: [] });
    continue;
  }

  const sourceMeta = JSON.parse(await readFile(sourceMetaPath, 'utf8'));
  const { runId, log } = await rebuild(entry, sourceMeta);

  if (!runId) {
    console.log(`ERROR        ${entry.module}  (rebuild produced no run)`);
    console.log(log.split('\n').slice(-12).join('\n'));
    results.push({ entry, status: 'error', diffs: [] });
    continue;
  }

  const producedMeta = JSON.parse(await readFile(path.join(RUNS_ROOT, runId, 'meta.json'), 'utf8'));
  const actual = actualOf(producedMeta);
  const diffs = diff(entry.expect, actual);

  if (args.update) {
    entry.expect = actual;
  }

  results.push({ entry, status: diffs.length ? 'changed' : 'ok', diffs, actual });

  const label = diffs.length ? (args.update ? 'UPDATED     ' : 'CHANGED     ') : 'OK          ';
  console.log(
    `${label} ${entry.module.padEnd(24)} ${actual.cells.matched}/${actual.cells.total} cells` +
      (actual.records ? `, ${actual.records.matched}/${actual.records.totalCells} record cells` : '') +
      (actual.analytics?.compared ? `, ${actual.analytics.matched}/${actual.analytics.compared} cards` : ''),
  );
  for (const d of diffs) console.log(`               ${d}`);

  // The rebuilt run is a throwaway; leave the corpus and the report history untouched.
  if (!args.keep) {
    const target = path.join(RUNS_ROOT, runId);
    if (target.startsWith(RUNS_ROOT + path.sep) && runId) {
      await rm(target, { recursive: true, force: true });
    }
  }
}

if (args.update) {
  await writeFile(BASELINE_FILE, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  console.log(`\n${BASELINE_FILE} rewritten from this run.`);
}

const changed = results.filter((r) => r.status === 'changed');
const broken = results.filter((r) => r.status === 'error' || r.status === 'unavailable');
console.log('');
console.log(
  `${results.filter((r) => r.status === 'ok').length}/${results.length} unchanged` +
    (changed.length ? `, ${changed.length} changed` : '') +
    (broken.length ? `, ${broken.length} could not be checked` : ''),
);

process.exit(args.update ? (broken.length ? 1 : 0) : changed.length || broken.length ? 1 : 0);
