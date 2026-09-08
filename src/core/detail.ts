/**
 * Comparison mode, and the use of a detail view to corroborate a summary.
 *
 * The default is always summary against summary: compare only what both screens actually
 * publish. That is the honest baseline, because it compares like with like and never
 * depends on the tool reconstructing a figure neither screen showed.
 *
 * When one screen additionally publishes a record-level listing, that listing can
 * corroborate the summary — sum its column and the total should reappear. But only if the
 * listing is complete. A paginated listing shows 25 of 29 records, and aggregating it
 * produces a shortfall that looks exactly like a data defect and is nothing of the kind.
 * So completeness is established first, and where it cannot be established the
 * corroboration is declined and the reason recorded. Declining to answer is a result;
 * inventing a difference is not.
 */
import { parseCell, precisionTolerance, type Verdict } from './normalize.js';
import { inferKind, normalizeLabel } from './match.js';
import { findGrandTotalRow } from './rows.js';
import { groupColumnsDetailed } from './columns.js';
import type { GridProfile } from './pairing.js';
import type { TableStructure } from './structure.js';

export type ComparisonMode = 'summary-vs-summary' | 'detail-assisted';

/** A record-level listing found on one screen, and whether it can be used. */
export interface DetailView {
  side: 'left' | 'right';
  sideLabel: string;
  name: string;
  /** Records the listing shows. */
  records: number;
  /** Records the summary says exist, when it publishes a count. Null when it does not. */
  expectedRecords: number | null;
  usable: boolean;
  /** Why it is or is not usable, in full. */
  why: string;
}

/** One aggregate of a detail column checked against a summary total. */
export interface DetailCheck {
  detailColumn: string;
  summaryRow: string;
  summaryColumn: string;
  aggregate: number;
  expected: number;
  delta: number;
  tolerance: number;
  verdict: Verdict;
}

export interface DetailCorroboration {
  view: DetailView;
  checks: DetailCheck[];
  note: string;
}

export interface ModeDecision {
  mode: ComparisonMode;
  /** Why this mode was chosen, for the report. */
  reason: string;
  /** Every record-level listing found, used or not. */
  detailViews: DetailView[];
  corroboration: DetailCorroboration[];
}

/** Row counts that almost always mean one page of results. */
const PAGE_SIZES = new Set([10, 15, 20, 25, 30, 50, 100, 200]);

/**
 * The count a summary reports, if it publishes one.
 *
 * Looks for a total row and, within it, a column whose figures are counts. This is what
 * makes a completeness check possible: the summary says how many records exist, the
 * listing says how many it is showing, and the two must agree before the listing can be
 * aggregated.
 */
function expectedRecordCount(summary: GridProfile): { count: number; from: string } | null {
  const row = findGrandTotalRow(summary.normalized);
  if (!row) return null;

  for (const group of summary.geometry.groups) {
    if (!group) continue;
    for (const col of groupColumnsDetailed(summary.geometry, group)) {
      const label = `${group} ${col.metric}`.trim();
      const cell = parseCell(row.cells[col.index]);
      if (cell.value === null) continue;
      // A count is a whole number rendered without a currency symbol or a percentage.
      if (!/^\d[\d,]*$/.test(cell.raw.trim())) continue;
      if (inferKind(label, cell.raw) !== 'count') continue;
      return { count: cell.value, from: `${row.label} / ${label}` };
    }
  }
  return null;
}

/**
 * Decide whether a detail listing can be aggregated.
 *
 * Two independent grounds for refusing: the summary's own count disagrees with the number
 * of rows on show, or the row count lands exactly on a page size, which means it almost
 * certainly does. Either is enough.
 */
function assessDetailView(
  side: 'left' | 'right',
  sideLabel: string,
  structure: TableStructure,
  summary: GridProfile | null,
): DetailView {
  const records = structure.bodyRows;
  const expected = summary ? expectedRecordCount(summary) : null;

  if (expected && expected.count !== records) {
    return {
      side,
      sideLabel,
      name: structure.name,
      records,
      expectedRecords: expected.count,
      usable: false,
      why:
        `The listing shows ${records} record(s) but the summary reports ${expected.count} ` +
        `(${expected.from}), so it is displaying one page of results rather than all of them. ` +
        'Aggregating it would fall short of the true total by whatever is on the pages not shown, ' +
        'which would appear as a data difference when it is only a display limit. Not used.',
    };
  }

  if (expected && expected.count === records) {
    return {
      side,
      sideLabel,
      name: structure.name,
      records,
      expectedRecords: expected.count,
      usable: true,
      why:
        `The listing shows all ${records} record(s) the summary accounts for (${expected.from}), ` +
        'so it is complete and can be aggregated to corroborate the summary.',
    };
  }

  if (PAGE_SIZES.has(records)) {
    return {
      side,
      sideLabel,
      name: structure.name,
      records,
      expectedRecords: null,
      usable: false,
      why:
        `The listing shows exactly ${records} rows, a standard page size, and the summary does not ` +
        'publish a record count to check it against. It is very likely one page of a longer list, so ' +
        'aggregating it would understate the total. Not used.',
    };
  }

  return {
    side,
    sideLabel,
    name: structure.name,
    records,
    expectedRecords: null,
    usable: true,
    why:
      `The listing shows ${records} record(s), which is not a page-size boundary, and nothing ` +
      'suggests it is truncated. Aggregated to corroborate the summary, though note the summary ' +
      'publishes no record count to confirm completeness against.',
  };
}

/**
 * Sum each numeric column of a detail listing and check it against the summary's total row.
 *
 * Columns are tied to the summary by name. A listing column called "TOTAL SALE" corroborates
 * a summary column about sales; where no summary column corresponds, the aggregate is simply
 * not checked rather than being forced onto the nearest candidate.
 */
function corroborate(view: DetailView, detail: GridProfile, summary: GridProfile): DetailCheck[] {
  const checks: DetailCheck[] = [];

  const totalRow = findGrandTotalRow(summary.normalized);
  if (!totalRow) return checks;

  // Every numeric column of the summary's total row, as candidate counterparts.
  const summaryColumns: Array<{ name: string; value: number; raw: string }> = [];
  for (const group of summary.geometry.groups) {
    if (!group) continue;
    for (const col of groupColumnsDetailed(summary.geometry, group)) {
      const cell = parseCell(totalRow.cells[col.index]);
      if (cell.value === null) continue;
      summaryColumns.push({
        name: [group, col.metric].filter(Boolean).join(' '),
        value: cell.value,
        raw: cell.raw,
      });
    }
  }
  if (!summaryColumns.length) return checks;

  const detailGrid = detail.table.headerGrid ?? detail.table.headers;
  const header = detailGrid.at(-1) ?? [];
  const width = detail.table.rows.reduce((m, r) => Math.max(m, r.length), 0);

  for (let c = 0; c < width; c++) {
    if (c === detail.geometry.labelColumn) continue;
    const colName = (header[c] ?? '').trim();
    if (!colName) continue;

    let sum = 0;
    let counted = 0;
    let sample = '';
    for (const row of detail.table.rows) {
      const cell = parseCell(row[c]);
      if (cell.value === null) continue;
      sum += cell.value;
      counted++;
      if (!sample) sample = cell.raw;
    }
    // A column has to be substantially populated to be worth aggregating.
    if (counted < Math.max(3, detail.table.rows.length / 2)) continue;

    // Tie it to a summary column by name. Require a strong match: a wrong pairing here
    // manufactures a difference out of nothing.
    const normalized = normalizeLabel(colName);
    let best: { s: (typeof summaryColumns)[number]; score: number } | null = null;
    for (const s of summaryColumns) {
      const score = tokenOverlap(normalized, normalizeLabel(s.name));
      if (!best || score > best.score) best = { s, score };
    }
    if (!best || best.score < 0.5) continue;

    const kind = inferKind(colName, sample);
    // The aggregate carries the rounding of every row it summed, so the tolerance has to
    // scale with the number of rows rather than being a single cell's allowance.
    const tolerance = precisionTolerance(sample, best.s.raw, kind) * Math.max(1, counted);
    const delta = Number((sum - best.s.value).toFixed(4));

    checks.push({
      detailColumn: colName,
      summaryRow: totalRow.label,
      summaryColumn: best.s.name,
      aggregate: Number(sum.toFixed(4)),
      expected: best.s.value,
      delta,
      tolerance: Number(tolerance.toFixed(4)),
      verdict: Math.abs(delta) <= tolerance ? 'match' : 'mismatch',
    });
  }

  return checks;
}

/** Share of the shorter label's tokens present in the longer. */
function tokenOverlap(a: string, b: string): number {
  const A = new Set(a.split(' ').filter((t) => t.length > 1));
  const B = new Set(b.split(' ').filter((t) => t.length > 1));
  if (!A.size || !B.size) return 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return shared / small.size;
}

export interface ModeInputs {
  leftLabel: string;
  rightLabel: string;
  leftProfiles: GridProfile[];
  rightProfiles: GridProfile[];
  leftStructures: TableStructure[];
  rightStructures: TableStructure[];
  /** The summary grid actually compared on each side, when one was. */
  comparedLeft: GridProfile | null;
  comparedRight: GridProfile | null;
}

/**
 * Choose the comparison mode.
 *
 * Summary against summary is the default and the fallback. The mode only escalates to
 * detail-assisted when a listing is provably complete *and* at least one of its columns
 * could actually be tied to a summary total — an escalation that produced no checks would
 * be a label, not a capability.
 */
export function decideMode(inputs: ModeInputs): ModeDecision {
  const {
    leftLabel,
    rightLabel,
    leftProfiles,
    rightProfiles,
    leftStructures,
    rightStructures,
    comparedLeft,
    comparedRight,
  } = inputs;

  const detailViews: DetailView[] = [];
  const corroboration: DetailCorroboration[] = [];

  for (const [side, sideLabel, profiles, structures, summary] of [
    ['left', leftLabel, leftProfiles, leftStructures, comparedLeft],
    ['right', rightLabel, rightProfiles, rightStructures, comparedRight],
  ] as const) {
    for (const structure of structures) {
      if (structure.role !== 'detail') continue;
      const view = assessDetailView(side, sideLabel, structure, summary);
      detailViews.push(view);

      if (!view.usable || !summary) continue;
      const detail = profiles.find((p) => p.table.index === structure.index);
      if (!detail) continue;

      const checks = corroborate(view, detail, summary);
      if (!checks.length) {
        view.usable = false;
        view.why +=
          ' In the event no column of the listing could be tied to a figure in the summary, so ' +
          'there was nothing to corroborate.';
        continue;
      }
      corroboration.push({
        view,
        checks,
        note:
          `Each figure below is the sum of "${view.name}" across all ${view.records} record(s), ` +
          `checked against the corresponding total on the summary grid. This corroborates the ` +
          `summary against its own underlying records; it is separate from, and does not replace, ` +
          `the comparison between the two screens.`,
      });
    }
  }

  const usable = detailViews.filter((v) => v.usable);
  const mode: ComparisonMode = corroboration.length ? 'detail-assisted' : 'summary-vs-summary';

  let reason: string;
  if (mode === 'detail-assisted') {
    reason =
      `Summary compared against summary, and additionally corroborated against ` +
      `${usable.length} record-level listing(s) that proved complete: ` +
      `${usable.map((v) => `${v.sideLabel} "${v.name}"`).join(', ')}. ` +
      'The cross-screen comparison is still summary against summary — the listing adds an ' +
      'independent check that each summary agrees with its own records.';
  } else if (detailViews.length) {
    reason =
      `Summary compared against summary. ${detailViews.length} record-level listing(s) were found ` +
      `but none could be used: ${detailViews.map((v) => `${v.sideLabel} "${v.name}"`).join(', ')}. ` +
      'The reasons are given below — in each case using them would have introduced a difference ' +
      'that reflects a display limit rather than the data.';
  } else {
    reason =
      'Summary compared against summary. Neither screen publishes a record-level listing for this ' +
      'module, so there is no more detailed view to draw on.';
  }

  return { mode, reason, detailViews, corroboration };
}
