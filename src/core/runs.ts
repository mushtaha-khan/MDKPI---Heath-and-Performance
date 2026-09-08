/**
 * Run registry: discover completed suite runs and describe them.
 *
 * Each run writes a meta.json, so listing runs never requires parsing the full
 * result payload. Runs from before meta.json existed are still listed by falling back
 * to whatever HTML report is present.
 */
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { formatRunStamp, parseRunStamp } from './datetime.js';
import { titleCaseModuleName } from './module-name.js';

export interface RunSummary {
  runId: string;
  moduleName: string;
  reportFile: string;
  /** 'gui' for runs started from the control panel, 'cli' for command-line runs. */
  source: 'gui' | 'cli';
  startedAt: string | null;
  finishedAt: string | null;
  autogroupUrl: string | null;
  dmsUrl: string | null;
  groups: string[];
  cells: { total: number; matched: number; mismatched: number; missing: number } | null;
  rowFormulas: { passed: number; failed: number; total: number } | null;
  columnChecks: { passed: number; failed: number; total: number } | null;
  screenshots: number | null;
  /**
   * Overall verdict for a glanceable badge. 'blocked' means the run produced a report but
   * compared nothing, which must never be shown as clean.
   */
  status: 'clean' | 'differences' | 'blocked' | 'interrupted' | 'unknown';
  /**
   * Which of the engine's comparison passes ran, so coverage is visible from the history
   * without opening the report.
   */
  passes: Array<{ name: string; status: string; compared: number; differences: number }>;
  /** When the run was soft-deleted, or null while it is active. */
  deletedAt: string | null;
}

/**
 * Marker file recording a soft delete.
 *
 * Deleting a report from the panel hides it; it never removes anything from disk. These
 * runs hold the only record of what the portal showed at a given moment — the captures,
 * the screenshots, the harvested formulas — and none of it can be reproduced later, because
 * the underlying feed moves. So a delete is a marker, and restoring is removing it.
 *
 * A separate file rather than a field in meta.json: marking a run deleted then becomes a
 * single small atomic write, with no read-modify-write cycle that could truncate the
 * metadata it was meant to annotate.
 */
const DELETED_MARKER = '.deleted';

export interface DeletionRecord {
  deletedAt: string;
  by: string;
}

/**
 * Resolve a run id to its directory, refusing anything that escapes the runs root.
 *
 * The id arrives from an HTTP request, so "../" and absolute paths have to be rejected
 * rather than sanitised — a delete endpoint that can be talked into touching an arbitrary
 * path is a great deal worse than one that occasionally refuses a legitimate name.
 */
export function resolveRunDir(runsRoot: string, runId: string): string | null {
  if (!runId || runId.includes('\0')) return null;
  // Run ids are generated as a timestamp plus a slug; nothing else is legitimate.
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  if (runId === '.' || runId === '..') return null;

  const root = path.resolve(runsRoot);
  const dir = path.resolve(root, runId);
  if (dir !== root && !dir.startsWith(root + path.sep)) return null;
  if (!existsSync(dir)) return null;
  return dir;
}

/** Read a run's deletion marker, or null when it is active. */
export async function readDeletion(dir: string): Promise<DeletionRecord | null> {
  const file = path.join(dir, DELETED_MARKER);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as DeletionRecord;
    return parsed.deletedAt ? parsed : { deletedAt: new Date(0).toISOString(), by: 'unknown' };
  } catch {
    // A marker that cannot be parsed still means deleted. Treating it as active because of
    // a malformed timestamp would resurrect a report the operator had removed.
    return { deletedAt: new Date(0).toISOString(), by: 'unknown' };
  }
}

/** Soft-delete a run. Returns false when the id does not resolve to a run. */
export async function softDeleteRun(
  runsRoot: string,
  runId: string,
  by = 'gui',
): Promise<DeletionRecord | null> {
  const dir = resolveRunDir(runsRoot, runId);
  if (!dir) return null;
  const record: DeletionRecord = { deletedAt: new Date().toISOString(), by };
  await writeFile(path.join(dir, DELETED_MARKER), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

/** Restore a soft-deleted run. Returns false when the id does not resolve to a run. */
export async function restoreRun(runsRoot: string, runId: string): Promise<boolean> {
  const dir = resolveRunDir(runsRoot, runId);
  if (!dir) return false;
  const file = path.join(dir, DELETED_MARKER);
  if (existsSync(file)) await rm(file, { force: true });
  return true;
}

/** "2026-09-03_15-59-40__service-summary" -> "03-09-2026 3:59 PM" */
function humanStamp(runId: string): string | null {
  return parseRunStamp(runId) ? formatRunStamp(runId) : null;
}

/** Find the report HTML inside a run directory. */
async function findReport(dir: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => []);
  const html = files.filter((f) => f.toLowerCase().endsWith('.html'));
  if (!html.length) return null;
  // Prefer a descriptively named report over a generic one.
  return html.find((f) => f !== 'report.html') ?? html[0]!;
}

export interface ListRunsOptions {
  /**
   * Include runs launched from the command line. Off by default: only runs started
   * from the GUI with entered URLs are treated as reports, so verification and
   * debugging runs do not accumulate in the history.
   */
  includeCli?: boolean;
  /**
   * 'active' (default) hides soft-deleted runs, 'deleted' returns only those, 'all'
   * returns both. Deleting from the panel is reversible, so the deleted set has to be
   * listable or a report could never be brought back.
   */
  deleted?: 'active' | 'deleted' | 'all';
}

export async function listRuns(
  runsRoot: string,
  opts: ListRunsOptions = {},
): Promise<RunSummary[]> {
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const out: RunSummary[] = [];
  const want = opts.deleted ?? 'active';

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(runsRoot, e.name);

    const deletion = await readDeletion(dir);
    if (want === 'active' && deletion) continue;
    if (want === 'deleted' && !deletion) continue;
    const deletedAt = deletion?.deletedAt ?? null;

    const metaPath = path.join(dir, 'meta.json');
    if (existsSync(metaPath)) {
      try {
        const m = JSON.parse(await readFile(metaPath, 'utf8'));

        // Runs without a source predate the distinction; treat them as GUI runs so
        // nothing already produced silently disappears.
        const runSource = m.source ?? 'gui';
        if (runSource !== 'gui' && !opts.includeCli) continue;
        const s = m.summary ?? {};
        // Differences can come from the grids, the analytics strip, or a record-by-record
        // comparison. A module whose grid is clean but whose headline cards disagree is not
        // clean, and on a module with no summary grid the cards are the entire result.
        const failed =
          (s.mismatched ?? 0) > 0 ||
          (s.missing ?? 0) > 0 ||
          (m.analytics?.mismatched ?? 0) > 0 ||
          (m.records?.mismatched ?? 0) > 0 ||
          (m.records?.missing ?? 0) > 0 ||
          (m.rowFormulas?.failed ?? 0) > 0 ||
          (m.columnChecks?.failed ?? 0) > 0;

        // A run that compared nothing has zero mismatches, which would otherwise read as
        // CLEAN — the most misleading badge it could possibly carry. But "no grid paired" is
        // no longer the same as "nothing compared": the analytics strip and a record listing
        // are compared independently of any grid.
        const comparedSomething =
          (s.gridsCompared ?? 0) > 0 ||
          (m.analytics?.compared ?? 0) > 0 ||
          (m.records?.totalCells ?? 0) > 0;
        const isBlocked = Boolean(m.blocked) || !comparedSomething;
        out.push({
          runId: m.runId ?? e.name,
          moduleName: m.moduleName ?? e.name,
          source: runSource === 'cli' ? 'cli' : 'gui',
          reportFile: m.reportFile ?? (await findReport(dir)) ?? '',
          startedAt: m.startedAt ?? null,
          finishedAt: m.finishedAt ?? null,
          autogroupUrl: m.autogroupUrl ?? null,
          dmsUrl: m.dmsUrl ?? null,
          groups: m.groups ?? [],
          // Everything that was compared, not just the grid. A module with no summary grid
          // is compared through its analytics strip and its record listing, and showing
          // "0/0" for it in the history reads as though nothing happened.
          cells: {
            total: (s.totalCells ?? 0) + (m.analytics?.compared ?? 0) + (m.records?.totalCells ?? 0),
            matched: (s.matched ?? 0) + (m.analytics?.matched ?? 0) + (m.records?.matched ?? 0),
            mismatched:
              (s.mismatched ?? 0) + (m.analytics?.mismatched ?? 0) + (m.records?.mismatched ?? 0),
            missing: (s.missing ?? 0) + (m.records?.missing ?? 0),
          },
          rowFormulas: m.rowFormulas ?? null,
          columnChecks: m.columnChecks ?? null,
          screenshots: m.screenshots ?? null,
          status: isBlocked ? 'blocked' : failed ? 'differences' : 'clean',
          passes: Array.isArray(m.passes) ? m.passes : [],
          deletedAt,
        });
        continue;
      } catch {
        /* fall through to the legacy path */
      }
    }

    const report = await findReport(dir);

    /**
     * A directory with captures but no metadata and no report is an interrupted run.
     *
     * These used to be filtered out entirely, so a run that was cancelled, crashed, or had
     * its server restarted underneath it simply vanished — leaving the operator asking why
     * no report appeared with nothing in the history to explain it. Better to show it,
     * badged for what it is.
     */
    if (!report) {
      const hasCaptures =
        existsSync(path.join(dir, 'autogroup', 'capture.json')) ||
        existsSync(path.join(dir, 'dms', 'capture.json'));
      if (!hasCaptures) continue;
      const info = await stat(dir).catch(() => null);
      out.push({
        runId: e.name,
        moduleName: titleCaseModuleName(e.name.split('__')[1] ?? e.name),
        source: 'gui',
        reportFile: '',
        startedAt: info ? info.birthtime.toISOString() : null,
        finishedAt: null,
        autogroupUrl: null,
        dmsUrl: null,
        groups: [],
        cells: null,
        rowFormulas: null,
        columnChecks: null,
        screenshots: null,
        status: 'interrupted',
        passes: [],
        deletedAt,
      });
      continue;
    }

    // A run with a report but no meta.json predates meta.json, or was written by the CLI.
    if (!opts.includeCli) continue;
    const info = await stat(dir).catch(() => null);
    out.push({
      runId: e.name,
      moduleName: e.name.split('__')[1] ?? e.name,
      source: 'cli',
      reportFile: report,
      startedAt: info ? info.mtime.toISOString() : null,
      finishedAt: info ? info.mtime.toISOString() : null,
      autogroupUrl: null,
      dmsUrl: null,
      groups: [],
      cells: null,
      rowFormulas: null,
      columnChecks: null,
      screenshots: null,
      status: 'unknown',
      passes: [],
      deletedAt,
    });
  }

  // Newest first, by parsed timestamp rather than by string comparison.
  //
  // localeCompare de-prioritises punctuation, so ids from different naming schemes
  // ("...-03T15-53-44_x" vs "...-03_21-35-07__x") did not order reliably and the
  // wrong run was treated as newest. Parse the stamp and compare numerically.
  const keyOf = (r: RunSummary): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T_](\d{2})-(\d{2})-(\d{2})/.exec(r.runId);
    if (m) {
      const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
      return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
    }
    const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
    return Number.isFinite(t) ? t : 0;
  };

  return out.sort((a, b) => keyOf(b) - keyOf(a) || b.runId.localeCompare(a.runId));
}

export function runUrl(run: RunSummary): string {
  return `./${encodeURIComponent(run.runId)}/${encodeURIComponent(run.reportFile)}`;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Static index of all runs, for browsing without the GUI. */
export function renderRunsIndex(runs: RunSummary[]): string {
  const rows = runs
    .map((r) => {
      const badge =
        r.status === 'clean'
          ? '<span class="b b-ok">CLEAN</span>'
          : r.status === 'differences'
            ? '<span class="b b-bad">DIFFERENCES</span>'
            : r.status === 'blocked'
            ? '<span class="b b-warn">NOT COMPARED</span>'
            : r.status === 'interrupted'
              ? '<span class="b b-warn">INTERRUPTED</span>'
              : '<span class="b b-dim">—</span>';
      const cells = r.cells
        ? `${r.cells.matched}/${r.cells.total} matched${r.cells.mismatched ? `, ${r.cells.mismatched} different` : ''}`
        : '—';
      return `<tr>
        <td><a href="${runUrl(r)}">${esc(r.moduleName)}</a></td>
        <td class="mono">${esc(humanStamp(r.runId) ?? r.startedAt ?? '')}</td>
        <td>${badge}</td>
        <td class="mono">${esc(cells)}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Dealer KPI — suite runs</title>
<style>
body{margin:0;background:#0f1014;color:#e7e9f0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
header{padding:24px 32px;border-bottom:1px solid #272b36}h1{margin:0;font-size:20px}
.sub{color:#9aa0b0;font-size:13px;margin-top:4px}
main{padding:24px 32px}
table{border-collapse:collapse;background:#16181f;width:100%;max-width:1100px}
th,td{border:1px solid #272b36;padding:8px 12px;text-align:left}
thead th{background:#1c1f28;color:#9aa0b0;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
a{color:#ff8095;text-decoration:none}a:hover{text-decoration:underline}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#9aa0b0}
.b{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600}
.b-ok{background:#12301f;color:#61d68f;border:1px solid #245c3b}
.b-bad{background:#33151b;color:#ff8095;border:1px solid #6b2431}
.b-dim{background:#20232c;color:#9aa0b0;border:1px solid #272b36}
</style></head><body>
<header><h1>My Dealer KPI &mdash; suite runs</h1>
<div class="sub">${runs.length} run(s), newest first. Launch new runs from the control panel.</div></header>
<main><table><thead><tr><th>Module</th><th>Run date &amp; time</th><th>Result</th><th>Cells</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">No runs yet.</td></tr>'}</tbody></table></main>
</body></html>`;
}
