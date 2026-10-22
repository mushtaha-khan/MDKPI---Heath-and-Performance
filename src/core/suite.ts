/**
 * Module-agnostic reconciliation engine.
 *
 * Given two captured grids, this derives the column geometry, matches rows
 * automatically, and compares every shared column group — with no per-module
 * constants. A module preset can supply aliases, tolerances and ignores, but is
 * optional: without one the suite still runs and reports its own coverage so you can
 * see what it could and could not align.
 */
import {
  compareValues,
  parseCell,
  precisionTolerance,
  type MetricKind,
  type ParsedValue,
  type Verdict,
} from './normalize.js';
import {
  alignGroupsByName,
  deriveGeometry,
  groupColumnsDetailed,
  groupNameScore,
  type GridGeometry,
  type GroupKey,
  type GroupPair,
} from './columns.js';
import {
  inferKind,
  matchRows,
  normalizeLabel,
  similarity,
  type MatchMethod,
  type MatchOptions,
} from './match.js';
import { pairGrids, profileGrids, type GridPair, type GridProfile } from './pairing.js';
import { classifyTables, type TableStructure } from './structure.js';
import { decideMode, type ModeDecision } from './detail.js';
import { compareTiles, type AnalyticsComparison, type CapturedTile } from './kpi.js';
import { compareRecords, type RecordComparison } from './records.js';
import {
  breakdownByEntity,
  canonicalSegment,
  comparableRows,
  describeSegments,
  type NormalizedRow,
} from './rows.js';

export interface CapturedTable {
  index: number;
  caption?: string;
  className?: string;
  headers: string[][];
  /** Colspan/rowspan-expanded header matrix, aligned to body column indices. */
  headerGrid?: string[][];
  rowCount: number;
  rows: string[][];
  footers: string[][];
}

export interface Capture {
  target: string;
  label: string;
  role: string;
  capturedAt: string;
  finalUrl?: string;
  error?: string;
  rendered?: {
    tables: CapturedTable[];
    /** The analytics strip above the grid, read as label/value cards during the crawl. */
    tiles?: CapturedTile[];
    tileCount?: number;
  };
  apiCalls?: Array<{ method: string; url: string; status: number; requestBody: string | null }>;
  screenshots?: { viewport?: string | null; fullPage?: string | null; slices?: string[] };
  /**
   * What the capture did with each paginator it found, recorded so a listing that is still
   * truncated is visible rather than being mistaken for the whole set. `before`/`after` hold
   * the screen's own record count text, e.g. "1 to 10 out of 43 records".
   */
  pagination?: Array<{
    before: string;
    after: string;
    from?: string;
    to?: string;
    changed: boolean;
    note?: string;
  }>;
}

export interface ModulePreset {
  /** Human-readable module name, e.g. "Service Summary". */
  name: string;
  /**
   * Where this module's two screens live, so the control panel can offer it as a saved
   * one-click run. Read by core/modules.ts; the comparison engine ignores it, because by
   * the time runSuite is called both screens have already been captured.
   */
  screens?: {
    autogroup?: { path?: string; url?: string; role?: string };
    dms?: { path?: string; url?: string; role?: string };
  };
  /**
   * Optional narrowing. Every hint must appear in a paired grid's headers for that
   * grid to be compared. Omit to compare every grid that has a counterpart.
   */
  gridHints?: string[];
  /** Minimum shared row labels before two tables are considered a pair. */
  minSharedLabels?: number;
  /** Minimum row-label vocabulary overlap before two tables are considered a pair. */
  minLabelOverlap?: number;
  aliases?: Record<string, string>;
  ignore?: string[];
  /** Per-metric tolerance overrides, keyed by normalized label. */
  tolerances?: Record<string, number>;
  /** Metric kind overrides, keyed by normalized label. */
  kinds?: Record<string, MetricKind>;
  /** Labels where the two products differ by definition rather than by data. */
  definitional?: string[];
  /**
   * Columns of a record listing that differ between the two screens by a known, fixed
   * amount because the two products define the measure differently.
   *
   * Keyed by column name, matched on either screen's heading. `leftMinusRight` states the
   * expected difference, and the engine *verifies* it on every record rather than
   * suppressing the column: a cell that satisfies the declared relationship is a match
   * flagged as definitional, and one that does not is still reported as a difference. So
   * declaring a relationship narrows what counts as a finding without hiding anything —
   * if the relationship ever stops holding, that becomes the finding.
   */
  recordColumns?: Record<string, { leftMinusRight: number; reason: string }>;
  /**
   * Corroboration checks where a screen's own summary total is composed differently from the
   * listing column that would otherwise reproduce it.
   *
   * Keyed by the listing column name. `minusColumns` and `plusColumns` name other columns of
   * the same listing whose aggregates are removed from, or added to, this one before it is
   * checked against the summary — so a relationship involving a third quantity can be stated
   * and then verified.
   *
   * Open RO is the case this exists for: DMS's summary GROSS excludes miscellaneous sales
   * where the listing's TOTAL GROSS includes them, so the listing reproduces the summary only
   * once MISC SALE is taken out. As with recordColumns the relationship is checked rather
   * than assumed, and a run where it stops holding is still reported.
   */
  corroboration?: Record<
    string,
    { minusColumns?: string[]; plusColumns?: string[]; reason: string }
  >;
  matchThreshold?: number;
}

export interface CellOutcome {
  group: GroupKey;
  /** Which column within the group this cell came from, e.g. "RO COUNT". */
  column: string;
  left: ParsedValue;
  right: ParsedValue;
  delta: number | null;
  verdict: Verdict;
  tolerance: number;
  /** Matched only once display rounding was allowed for, rather than being identical. */
  roundedMatch: boolean;
}

/** A column on one screen matched to its counterpart on the other. */
export interface ColumnPair {
  /** Group key, always the left screen's heading. */
  group: GroupKey;
  /**
   * The right screen's heading for the same group. Differs from `group` when the two
   * screens name it differently, e.g. "OPEN RO SALES" against plain "SALES".
   */
  rightGroup: GroupKey;
  /** Display name for the column, e.g. "RO COUNT" or "ACTUAL". */
  name: string;
  leftIndex: number;
  rightIndex: number;
  leftHeader: string;
  rightHeader: string;
  measure: string;
  sub: 'value' | 'percent' | 'average';
  /**
   * The metric this column represents, empty when the column is only a measure tier
   * (Actual / Tracking) and the row carries the metric identity instead.
   */
  metric: string;
  /**
   * How the pairing was established. 'value' means the two screens' headings were too
   * different, or too ambiguously similar, to align by name, and the mapping was inferred
   * from the figures corresponding. Agreement in such a column is therefore not
   * independent evidence that the screens match.
   */
  matchedBy: 'exact' | 'fuzzy' | 'value';
  confidence: number;
}

/** A column with no counterpart on the other screen. */
export interface UnpairedColumn {
  group: GroupKey;
  name: string;
  header: string;
  index: number;
}

export interface MetricOutcome {
  id: string;
  leftLabel: string;
  rightLabel: string;
  matchMethod: MatchMethod;
  matchConfidence: number;
  kind: MetricKind;
  definitional: boolean;
  cells: CellOutcome[];
  passed: boolean;
}

/**
 * One breakdown segment of one entity, compared against its counterpart.
 *
 * Kept separate from `MetricOutcome` so a segment-level disagreement can never be read
 * as a total-level one. The totals are the headline; segments are supporting detail.
 */
export interface SegmentOutcome {
  /** Entity label as it appears on the left screen. */
  entity: string;
  /** Entity label as it appears on the right screen. */
  rightEntity: string;
  /** Canonical segment key, e.g. "CUSTOMER PAY". */
  segment: string;
  /** Segment marker as printed on each screen, e.g. "C" vs "Customer Pay". */
  leftSegment: string;
  rightSegment: string;
  cells: CellOutcome[];
  passed: boolean;
}

/** Segment-by-segment result, present only when both screens carry the breakdown. */
export interface SegmentComparison {
  rowPairs: number;
  totalCells: number;
  matched: number;
  roundedMatches: number;
  mismatched: number;
  missing: number;
  /** Segments one screen shows and the other does not. */
  segmentsOnlyOnLeft: string[];
  segmentsOnlyOnRight: string[];
  outcomes: SegmentOutcome[];
}

/** One compared grid pair within a module. */
export interface GridResult {
  id: string;
  name: string;
  /** Why these two tables were paired. */
  pairing: { reason: string; labelOverlap: number; sharedLabels: number };
  groups: GroupKey[];
  /**
   * How each group heading was aligned when the two screens do not name it identically,
   * so the mapping the comparison used is auditable rather than implicit.
   */
  alignmentNotes: string[];
  /**
   * Set when this grid was pivoted from a single-row strip before comparison, describing
   * what was pivoted on which side.
   */
  transposed: { side: 'left' | 'right'; note: string } | null;
  /** Groups present on both sides but not compared because they are not quantities. */
  skippedGroups: GroupKey[];
  /**
   * Whether the two grids are shaped comparably. A screen configured to split rows
   * (grouped by pay type, say) reports per-segment figures against the other screen's
   * totals, which produces differences everywhere without anything being wrong.
   */
  shape: {
    leftDataRows: number;
    rightDataRows: number;
    leftDuplicateLabels: number;
    rightDuplicateLabels: number;
    comparable: boolean;
    warning: string | null;
  };
  /**
   * Row-level breakdown detail, counted and reported on its own rather than folded into
   * the value comparison. A breakdown present on one screen only is a gap in coverage,
   * not a disagreement about totals.
   */
  breakdown: {
    leftSegments: string[];
    rightSegments: string[];
    /** 'both' | 'left' | 'right' | 'neither' */
    availability: 'both' | 'left' | 'right' | 'neither';
    /** Entities whose breakdown exists on one screen only. */
    onlyOnLeft: number;
    onlyOnRight: number;
    /** Segment rows that therefore had no counterpart to compare against. */
    uncomparedSegmentRows: number;
    /** Individual segment comparison, when the breakdown is available on both screens. */
    segmentComparison: SegmentComparison | null;
    note: string | null;
  };
  geometry: { left: GridGeometry; right: GridGeometry };
  /** Every column pair compared, so alignment is auditable. */
  columnPairs: ColumnPair[];
  /** Columns present on only one screen, so coverage gaps are visible. */
  unpairedColumns: { left: UnpairedColumn[]; right: UnpairedColumn[] };
  /** How much of each grid was actually compared. */
  coverageStats: {
    leftValueColumns: number;
    rightValueColumns: number;
    comparedColumns: number;
  };
  metrics: MetricOutcome[];
  coverage: {
    matched: number;
    unmatchedLeft: UnmatchedRowDetail[];
    unmatchedRight: UnmatchedRowDetail[];
    byMethod: Record<MatchMethod, number>;
  };
  summary: {
    totalCells: number;
    matched: number;
    /** Of `matched`, how many agreed only after allowing for display rounding. */
    roundedMatches: number;
    mismatched: number;
    missing: number;
    metricsPassed: number;
    metricsFailed: number;
    byGroup: Record<string, { matched: number; mismatched: number; missing: number }>;
  };
}

/** Whether one of the engine's comparison passes ran on this module. */
export type PassStatus =
  /** It ran and produced results. */
  | 'ran'
  /** This module has nothing for it to work on. Not a gap. */
  | 'not-applicable'
  /** It had something to work on but could not proceed. This is a gap, and it is explained. */
  | 'blocked';

export interface CoveragePass {
  name: string;
  status: PassStatus;
  /** What it compared, or why it did not run. */
  detail: string;
  /** Units compared — cells, cards, or records, depending on the pass. */
  compared: number;
  unit: string;
  differences: number;
}

/** A row with no counterpart, with the values it held in the compared columns. */
export interface UnmatchedRowDetail {
  label: string;
  /** Nearest candidate on the other screen, to explain why it did not match. */
  closest?: { label: string; score: number };
  values: Array<{ group: GroupKey; column: string; raw: string }>;
}

/** One table as the crawl found it, described well enough to diagnose a layout problem. */
export interface ObservedTable {
  /** Index in the capture, so this ties to the structure classification. */
  index: number;
  name: string;
  rows: number;
  groups: string[];
  paired: boolean;
  /** Deepest header row, which is what column matching actually works from. */
  headerRow: string[];
  /** Widest body row, so a header/body width mismatch is visible. */
  bodyWidth: number;
  /** First few rows verbatim, so a transposed or unexpected layout is obvious. */
  sample: string[][];
  /** Row labels the pairing engine extracted, which is what it matches on. */
  labels: string[];
  /** Set when this table was pivoted from a single-row strip before comparison. */
  transposedFrom?: string;
}

/**
 * Why nothing could be compared.
 *
 * Returned rather than thrown. A thrown error aborts the run before the report is
 * written, so the operator is left with no report at all — no screenshots, no table
 * structure, nothing but a stack trace in a log. Everything needed to diagnose the
 * problem was already captured by that point, so the run should still produce a report
 * that shows it.
 */
export interface SuiteBlocked {
  /** Short headline, e.g. "No grid on one screen corresponds to a grid on the other". */
  reason: string;
  /** Full explanation, including what was found on each side. */
  detail: string;
  /** Concrete next steps. */
  remedy: string[];
}

export interface SuiteResult {
  moduleName: string;
  generatedAt: string;
  left: { label: string; role: string; url?: string; capturedAt: string };
  right: { label: string; role: string; url?: string; capturedAt: string };
  /** Every comparable grid found on both screens. Empty when `blocked` is set. */
  grids: GridResult[];
  /**
   * What each screen publishes, established before any comparison was attempted. A
   * difference in structure is not a difference in data, and telling them apart depends on
   * having worked out the structure first.
   */
  structure: {
    left: TableStructure[];
    right: TableStructure[];
    /** Plain-language account of how the two screens present this module. */
    summary: string;
  };
  /** Which comparison mode was used, and why. */
  mode: ModeDecision;
  /**
   * The analytics strip above the grid, compared card by card. Null when neither screen
   * publishes one. On a module with no summary grid this is the only comparable data there
   * is, so it is never conditional on a grid having paired.
   */
  analytics: AnalyticsComparison | null;
  /**
   * Record-by-record comparison, used when both screens publish this module as a listing of
   * individual records rather than as a summary. Null when they do not.
   */
  recordComparison: RecordComparison | null;
  /**
   * Every comparison the engine knows how to make, and whether it ran on this module.
   *
   * The engine has no per-module configuration: it works out what each screen publishes and
   * applies whichever comparisons fit. That is only trustworthy if it is visible, because
   * "this module has no analytics strip" and "the analytics strip was overlooked" produce the
   * same silence. So every pass reports itself, including the ones that did not apply.
   */
  coverage: CoveragePass[];
  /**
   * Set when the comparison could not run at all. The report renders a diagnosis in
   * place of the comparison rather than the run failing without output.
   */
  blocked: SuiteBlocked | null;
  /**
   * Parts of the module that could not be compared while other parts could.
   *
   * Distinct from `blocked`: these are limits on coverage, reported so the reader knows what
   * is missing without writing off the comparison that did happen. A module whose grids will
   * not align but whose analytics strip compares cleanly belongs here, not in `blocked`.
   */
  limitations: SuiteBlocked[];
  /** What the crawl observed, so the approach taken is visible and auditable. */
  observation: {
    leftTables: ObservedTable[];
    rightTables: ObservedTable[];
    notes: string[];
  };
  dateRange: {
    left: string | null;
    right: string | null;
    /**
     * 'unknown' when at least one screen never exposed its range. Distinguished from
     * 'differ' so the report does not claim a mismatch it cannot actually see.
     */
    status: 'aligned' | 'differ' | 'unknown';
    aligned: boolean;
    note: string;
  };
  /** Module-wide totals across all grids. */
  summary: {
    totalCells: number;
    matched: number;
    /** Of `matched`, how many agreed only after allowing for display rounding. */
    roundedMatches: number;
    mismatched: number;
    missing: number;
    metricsPassed: number;
    metricsFailed: number;
    gridsCompared: number;
    byGroup: Record<string, { matched: number; mismatched: number; missing: number }>;
    /**
     * Breakdown accounting, kept out of the totals above on purpose. A breakdown present
     * on one screen only is a coverage gap; folding it into `mismatched` would report it
     * as the two screens disagreeing about a value, which is not what happened.
     */
    breakdown: {
      gridsBothSides: number;
      gridsOneSideOnly: number;
      /** Entities whose breakdown exists on one screen only. */
      missingBreakdownEntities: number;
      /** Segment rows that had no counterpart, so could not be compared. */
      uncomparedSegmentRows: number;
      segmentRowPairs: number;
      segmentCells: number;
      segmentMatched: number;
      segmentRoundedMatches: number;
      segmentMismatched: number;
      segmentMissing: number;
    };
  };
}

/**
 * Choose the metric grid from a capture.
 *
 * Preference order: an explicit hint from the module preset, then the table with the
 * most column groups (report grids are far wider than the small summary strips), then
 * the table with the most rows.
 */
export function selectGrid(capture: Capture, hints: string[] = []): CapturedTable {
  const tables = (capture.rendered?.tables ?? []).filter((t) => t.rowCount > 0);
  if (!tables.length) {
    throw new Error(`Capture "${capture.target}" contains no non-empty tables.`);
  }

  if (hints.length) {
    // Every hint must be present. Matching on any single hint is too loose: the DMS
    // dashboard has a small rates strip whose header contains "WARRANTY RATE", which
    // would otherwise be picked ahead of the real metric grid.
    const hinted = tables.filter((t) => {
      const hay = [...t.headers.flat(), t.caption ?? ''].join(' ').toUpperCase();
      return hints.every((h) => hay.includes(h.toUpperCase()));
    });
    if (hinted.length) {
      // If several qualify, prefer the widest and tallest — the metric grid.
      hinted.sort(
        (a, b) => (b.headerGrid?.[0]?.length ?? 0) - (a.headerGrid?.[0]?.length ?? 0) || b.rowCount - a.rowCount,
      );
      return hinted[0]!;
    }
  }

  const scored = tables.map((t) => {
    const geo = deriveGeometry(t.headerGrid ?? t.headers, t.rows);
    return { table: t, groups: geo.groups.length, rows: t.rowCount };
  });

  scored.sort((a, b) => b.groups - a.groups || b.rows - a.rows);
  return scored[0]!.table;
}

/** Pull the requested date range out of whichever API call exposes it. */
function extractDateRange(capture: Capture): string | null {
  for (const call of capture.apiCalls ?? []) {
    if (call.requestBody) {
      try {
        const body = JSON.parse(call.requestBody);
        if (body.startDate && body.endDate) return `${body.startDate} to ${body.endDate}`;
      } catch {
        /* encrypted or non-JSON payload */
      }
    }
    const m = call.url.match(/startDate=([\d-]+).*?endDate=([\d-]+)/);
    if (m) return `${m[1]} to ${m[2]}`;
  }
  return null;
}

function normalizeDate(s: string): string {
  return s.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (_, y, mo, d) =>
    `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  );
}

/**
 * Compare a single paired grid.
 *
 * Returns null when the two grids share a column group but no column inside it could be
 * aligned, which leaves nothing to compare. The caller reports that as a coverage
 * problem rather than the run failing outright.
 */
function compareGrid(
  pair: GridPair,
  preset: ModulePreset,
  sides: { leftLabel: string; rightLabel: string },
): GridResult | null {
  const { leftLabel, rightLabel } = sides;
  const leftGeo = pair.left.geometry;
  const rightGeo = pair.right.geometry;

  const matchOpts: MatchOptions = {
    aliases: preset.aliases,
    ignore: preset.ignore,
    threshold: preset.matchThreshold,
  };
  // Compare totals against totals. Where a screen breaks an entity into segment rows,
  // its total row is the like-for-like counterpart of the other screen's single row;
  // comparing a total against one segment is what produced differences everywhere.
  //
  // Rows are matched before columns because settling an ambiguous column alignment
  // requires knowing which rows correspond, so their values can be checked against each
  // other.
  const leftTotals = comparableRows(pair.left.normalized).map((r) => ({
    label: r.label,
    cells: r.cells,
  }));
  const rightTotals = comparableRows(pair.right.normalized).map((r) => ({
    label: r.label,
    cells: r.cells,
  }));

  const matched = matchRows(leftTotals, rightTotals, matchOpts);

  /**
   * Keep only groups whose value column actually holds numbers.
   *
   * Some column groups are descriptive rather than numeric — a "TECH INFO" group leads
   * with a hire date and a level. Comparing those as values produced a row of phantom
   * "missing" cells that read like a data gap when nothing is wrong; they are simply
   * not quantities. Judged from the captured data, not from the group's name.
   */
  const isNumericGroup = (geo: GridGeometry, profile: GridProfile, group: GroupKey): boolean => {
    const col = geo.primaryByGroup.get(group);
    if (col === undefined) return false;
    let numeric = 0;
    for (const row of comparableRows(profile.normalized).slice(0, 40)) {
      if (parseCell(row.cells[col]).value !== null) numeric++;
      if (numeric >= 3) return true;
    }
    return false;
  };

  /**
   * How much two columns' values actually correspond, across the matched rows.
   *
   * Returns null when there are too few comparable samples to say anything. This is the
   * evidence used to settle a column alignment that names alone leave ambiguous.
   */
  const valueAgreement = (leftIndex: number, rightIndex: number): number | null => {
    let compared = 0;
    let agreed = 0;
    for (const m of matched.matches) {
      const l = parseCell(m.leftRow[leftIndex]);
      const r = parseCell(m.rightRow[rightIndex]);
      if (l.value === null || r.value === null) continue;
      compared++;
      const kind = inferKind(m.leftLabel, l.raw || r.raw);
      if (Math.abs(l.value - r.value) <= precisionTolerance(l.raw, r.raw, kind)) agreed++;
    }
    return compared >= 3 ? agreed / compared : null;
  };

  /**
   * Align the column groups, using the values to resolve what the names cannot.
   *
   * The two screens do not always head a group identically. AutoGroup writes
   * "OPEN RO SALES" where DMS writes just "SALES", so requiring identical names refused
   * to compare the grid at all. But name similarity alone is not safe either: a bare
   * "COUNT" is a *perfect* token match for "% OF COUNT" and only a partial one for
   * "OPEN RO COUNT", so names on their own pick the percentage column over the count.
   *
   * So each candidate alignment is scored on its name and on whether its values line up
   * across the matched rows, and the value evidence decides when the names are close
   * enough to be misleading. A group aligned mainly on its values is marked as such: its
   * agreement is then not independent evidence that the two screens match, and the report
   * says so rather than quietly counting it as a pass.
   */
  const nameAligned = alignGroupsByName(leftGeo, rightGeo);
  const exactByLeft = new Map<GroupKey, GroupPair>();
  for (const a of nameAligned) if (a.matchedBy === 'exact') exactByLeft.set(a.left, a);

  const groupAlignment: Array<
    GroupPair & { valueScore: number | null; inferredFromValues: boolean }
  > = [];
  const usedRightGroups = new Set<GroupKey>();
  const alignmentNotes: string[] = [];

  // Exact name matches are taken as given — they are the strongest evidence available.
  for (const a of exactByLeft.values()) {
    usedRightGroups.add(a.right);
    groupAlignment.push({ ...a, valueScore: null, inferredFromValues: false });
  }

  const leftUnaligned = leftGeo.groups.filter(
    (g) => g && leftGeo.primaryByGroup.has(g) && !exactByLeft.has(g),
  );
  const rightUnaligned = () =>
    rightGeo.groups.filter((g) => g && rightGeo.primaryByGroup.has(g) && !usedRightGroups.has(g));

  for (const l of leftUnaligned) {
    const lCol = leftGeo.primaryByGroup.get(l)!;
    let best: { right: GroupKey; name: number; value: number | null; combined: number } | null = null;

    for (const r of rightUnaligned()) {
      const rCol = rightGeo.primaryByGroup.get(r)!;
      const name = groupNameScore(l, r);
      const value = valueAgreement(lCol, rCol);
      if (name < 0.3 && (value === null || value < 0.9)) continue;
      // Value evidence dominates when it exists, because it is direct rather than
      // inferential. Names still contribute, so an unnamed column does not drift onto
      // whichever counterpart happens to agree by coincidence.
      const combined = value === null ? name : value * 0.7 + name * 0.3;
      if (!best || combined > best.combined) best = { right: r, name, value, combined };
    }

    if (!best) continue;
    usedRightGroups.add(best.right);
    // One definition of "inferred from values", used for both the explanatory note and
    // the badge on every column inside the group. Two thresholds that almost agree is how
    // a report ends up explaining that a mapping came from values while simultaneously
    // labelling it a name match.
    const byValue = best.name < 0.6 && best.value !== null && best.value >= 0.9;
    groupAlignment.push({
      left: l,
      right: best.right,
      score: Number(best.combined.toFixed(3)),
      matchedBy: 'fuzzy',
      valueScore: best.value,
      inferredFromValues: byValue,
    });
    if (l !== best.right) {
      alignmentNotes.push(
        `"${l}" on ${leftLabel} was aligned to "${best.right}" on ${rightLabel} ` +
          (byValue
            ? `because their values correspond (${Math.round((best.value ?? 0) * 100)}% of rows agree) ` +
              `even though the headings differ`
            : `on heading similarity ${best.name.toFixed(2)}` +
              (best.value !== null ? `, with ${Math.round(best.value * 100)}% of values agreeing` : '')) +
          '.',
      );
    }
  }

  const skippedGroups: GroupKey[] = [];
  const alignment = groupAlignment.filter((a) => {
    const ok =
      isNumericGroup(leftGeo, pair.left, a.left) || isNumericGroup(rightGeo, pair.right, a.right);
    if (!ok) skippedGroups.push(a.left);
    return ok;
  });

  // Groups are keyed by the left screen's name throughout, with the right screen's name
  // carried on each column pair, so a differing heading is visible without every
  // downstream structure having to hold a pair of names.
  const groups = alignment.map((a) => a.left);
  const rightGroupOf = new Map(alignment.map((a) => [a.left, a.right]));
  const valueAlignedGroups = new Set(
    alignment.filter((a) => a.inferredFromValues).map((a) => a.left),
  );

  /**
   * Pair up every column within each group, rather than comparing one per group.
   *
   * Previously only a single "primary" column per group was compared. That fitted the
   * Service screens, where a group is a pay type with one value column, but badly
   * understated coverage on grids where a group is a family of distinct metrics: the
   * Technician grid compared 5 of its 27 numeric columns, silently ignoring Labor Sale,
   * Labor Cost, Labor Gross and ELR while reporting "all matched".
   */
  const columnPairs: ColumnPair[] = [];
  const unpairedLeftCols: UnpairedColumn[] = [];
  const unpairedRightCols: UnpairedColumn[] = [];
  let leftValueColumns = 0;
  let rightValueColumns = 0;

  // Judge a column numeric from the rows that will actually be compared (the totals),
  // not from every row — segment rows can be blank in columns the totals populate.
  const hasNumbers = (profile: GridProfile, index: number): boolean => {
    let n = 0;
    for (const row of comparableRows(profile.normalized).slice(0, 40)) {
      if (parseCell(row.cells[index]).value !== null) n++;
      if (n >= 2) return true;
    }
    return false;
  };

  for (const group of groups) {
    const rightGroup = rightGroupOf.get(group)!;
    // Only columns that actually hold numbers are worth comparing.
    const lCols = groupColumnsDetailed(leftGeo, group).filter((c) => hasNumbers(pair.left, c.index));
    const rCols = groupColumnsDetailed(rightGeo, rightGroup).filter((c) =>
      hasNumbers(pair.right, c.index),
    );
    leftValueColumns += lCols.length;
    rightValueColumns += rCols.length;

    const usedRight = new Set<number>();

    for (const l of lCols) {
      // Exact identity first: same measure, same derived-ness, same metric name.
      let hit = rCols.find((r) => !usedRight.has(r.index) && r.key === l.key);
      let matchedBy: 'exact' | 'fuzzy' = 'exact';
      let confidence = 1;

      if (!hit) {
        // Then the closest metric name within the same measure and derived-ness, so a
        // wording difference ("TOTAL GROSS EARNINGS" vs "TTL GROSS EARNINGS") still pairs.
        let best: { r: (typeof rCols)[number]; score: number } | null = null;
        for (const r of rCols) {
          if (usedRight.has(r.index)) continue;
          if (r.measure !== l.measure || r.sub !== l.sub) continue;
          const score = similarity(normalizeLabel(l.metric), normalizeLabel(r.metric));
          if (!best || score > best.score) best = { r, score };
        }
        if (best && best.score >= 0.6) {
          hit = best.r;
          matchedBy = 'fuzzy';
          confidence = Number(best.score.toFixed(3));
        }
      }

      if (!hit) {
        unpairedLeftCols.push({
          group,
          name: l.metric || l.measure || l.sub,
          header: l.chain.join(' > '),
          index: l.index,
        });
        continue;
      }

      usedRight.add(hit.index);
      const name = l.metric || [l.measure, l.sub === 'value' ? '' : l.sub].filter(Boolean).join(' ');
      // A group aligned on its values rather than its heading taints every column within
      // it: the mapping was inferred from the figures agreeing, so their agreement cannot
      // also be treated as confirmation. Recorded here so the report can say so.
      const groupByValue = valueAlignedGroups.has(group);
      columnPairs.push({
        group,
        rightGroup,
        name: name || `col ${l.index}`,
        leftIndex: l.index,
        rightIndex: hit.index,
        leftHeader: l.chain.join(' > '),
        rightHeader: hit.chain.join(' > '),
        measure: l.measure,
        sub: l.sub,
        metric: l.metric,
        matchedBy: groupByValue ? 'value' : matchedBy,
        confidence: groupByValue ? Number((confidence * 0.8).toFixed(3)) : confidence,
      });
    }

    for (const r of rCols) {
      if (usedRight.has(r.index)) continue;
      unpairedRightCols.push({
        group,
        name: r.metric || r.measure || r.sub,
        header: r.chain.join(' > '),
        index: r.index,
      });
    }
  }

  /**
   * Report the columns of groups that found no counterpart at all.
   *
   * These were previously dropped before the column loop ever saw them, so they appeared
   * nowhere: not in the compared set, not in the unpaired set, and not in the coverage
   * totals. A report claiming "3 of 3 numeric columns compared" while the screen showed
   * five is worse than one admitting it only reached three.
   */
  const alignedLeft = new Set(alignment.map((a) => a.left));
  const alignedRight = new Set(alignment.map((a) => a.right));

  for (const [geo, profile, aligned, sink, skipped] of [
    [leftGeo, pair.left, alignedLeft, unpairedLeftCols, new Set(skippedGroups)],
    [rightGeo, pair.right, alignedRight, unpairedRightCols, new Set<GroupKey>()],
  ] as const) {
    for (const gk of geo.groups) {
      if (!gk || aligned.has(gk) || skipped.has(gk)) continue;
      const cols = groupColumnsDetailed(geo, gk).filter((c) => hasNumbers(profile, c.index));
      if (!cols.length) continue;
      if (sink === unpairedLeftCols) leftValueColumns += cols.length;
      else rightValueColumns += cols.length;
      for (const c of cols) {
        sink.push({
          group: gk,
          name: c.metric || c.measure || c.sub || gk,
          header: c.chain.join(' > '),
          index: c.index,
        });
      }
    }
  }

  if (!columnPairs.length) return null;

  const definitional = new Set((preset.definitional ?? []).map((s) => s.toUpperCase()));

  /**
   * Compare one aligned pair of rows across every paired column.
   *
   * Extracted so the segment rows of a breakdown go through exactly the same tolerance,
   * kind-inference and sign-convention rules as the total rows. A second implementation
   * would drift, and segment values would end up judged more harshly than totals.
   */
  const compareCells = (
    leftCells: string[],
    rightCells: string[],
    rowId: string,
    kindContext: string,
  ): CellOutcome[] =>
    columnPairs.map((cp) => {
      const rawLeft = parseCell(leftCells[cp.leftIndex]);
      const rawRight = parseCell(rightCells[cp.rightIndex]);

      // Tolerance is decided per cell now, because a row can span columns of different
      // kinds: on the Technician grid one row holds a count, hours, currency and a rate.
      // Judging the whole row by its first column applied the wrong tolerance elsewhere.
      const sample = rawLeft.raw || rawRight.raw;

      // Infer the kind from the row label AND the column's metric together, because
      // which of the two carries the identity depends on the grid's shape. On the
      // Service grids the row is the metric ("HOURS FLAGGED") and the column is only a
      // measure tier ("ACTUAL"); on the Technician grids it is the other way round.
      // Using the column name alone classified "HOURS FLAGGED / ACTUAL" as a count and
      // applied an exact tolerance, turning AutoGroup's rounding of hours into four
      // false differences.
      const kindLabel = `${kindContext} ${cp.metric}`.trim();
      const kind =
        preset.kinds?.[`${rowId}|${cp.name}`] ??
        preset.kinds?.[rowId] ??
        inferKind(kindLabel, sample);
      // Derived from the precision each screen displays, so a value rounded for display
      // on one side is not reported as a discrepancy. A preset may still override it.
      const tolerance =
        preset.tolerances?.[`${rowId}|${cp.name}`] ??
        preset.tolerances?.[rowId] ??
        precisionTolerance(rawLeft.raw, rawRight.raw, kind);

      // Discounts are rendered as a magnitude on one screen and signed negative on the
      // other. Compare magnitudes so a sign convention is not reported as a defect.
      const isDiscount = /DISCOUNT|DISC\b/.test(`${rowId} ${cp.name}`.toUpperCase());
      const l =
        isDiscount && rawLeft.value !== null ? { ...rawLeft, value: Math.abs(rawLeft.value) } : rawLeft;
      const r =
        isDiscount && rawRight.value !== null
          ? { ...rawRight, value: Math.abs(rawRight.value) }
          : rawRight;

      const cmp = compareValues(l, r, tolerance);
      return {
        group: cp.group,
        column: cp.name,
        left: rawLeft,
        right: rawRight,
        delta: cmp.delta,
        verdict: cmp.verdict,
        tolerance,
        roundedMatch: cmp.roundedMatch,
      };
    });

  const metrics: MetricOutcome[] = matched.matches.map((m) => {
    const cells = compareCells(m.leftRow, m.rightRow, m.id, m.leftLabel);

    // The row's kind is only used for display now that tolerance is per cell.
    const firstSample = cells[0]?.left.raw || cells[0]?.right.raw || '';
    const kind = preset.kinds?.[m.id] ?? inferKind(m.leftLabel, firstSample);

    return {
      id: m.id,
      leftLabel: m.leftLabel,
      rightLabel: m.rightLabel,
      matchMethod: m.method,
      matchConfidence: m.confidence,
      kind,
      definitional:
        definitional.has(m.leftLabel.toUpperCase()) || definitional.has(m.rightLabel.toUpperCase()),
      cells,
      passed: cells.every((c) => c.verdict === 'match'),
    };
  });

  const byGroup: Record<string, { matched: number; mismatched: number; missing: number }> = {};
  for (const g of groups) byGroup[g] = { matched: 0, mismatched: 0, missing: 0 };

  let matchedCells = 0;
  let roundedMatches = 0;
  let mismatched = 0;
  let missing = 0;
  for (const m of metrics) {
    for (const c of m.cells) {
      if (c.verdict === 'match') {
        matchedCells++;
        if (c.roundedMatch) roundedMatches++;
        byGroup[c.group]!.matched++;
      } else if (c.verdict === 'mismatch') {
        mismatched++;
        byGroup[c.group]!.mismatched++;
      } else {
        missing++;
        byGroup[c.group]!.missing++;
      }
    }
  }

  const byMethod: Record<MatchMethod, number> = { exact: 0, alias: 0, fuzzy: 0, manual: 0 };
  for (const m of matched.matches) byMethod[m.method]++;

  // --- breakdown: availability first, then a segment-by-segment comparison ---
  //
  // This is computed before the shape check on purpose. A row-count disparity that the
  // breakdown fully explains is a known, benign difference in presentation, not a
  // warning worth raising.
  const leftBreakdown = breakdownByEntity(pair.left.normalized);
  const rightBreakdown = breakdownByEntity(pair.right.normalized);
  const leftHas = pair.left.normalized.hasBreakdown;
  const rightHas = pair.right.normalized.hasBreakdown;

  const availability: 'both' | 'left' | 'right' | 'neither' =
    leftHas && rightHas ? 'both' : leftHas ? 'left' : rightHas ? 'right' : 'neither';

  const countRows = (m: Map<string, NormalizedRow[]>) =>
    [...m.values()].reduce((a, v) => a + v.length, 0);

  /**
   * Where both screens carry the breakdown, compare each segment against its counterpart
   * individually. Segments are keyed canonically first, because DMS writes "C" where
   * AutoGroup writes "Customer Pay"; matching on the raw marker would pair nothing.
   */
  const segmentOutcomes: SegmentOutcome[] = [];
  const segmentsOnlyOnLeft = new Set<string>();
  const segmentsOnlyOnRight = new Set<string>();

  if (availability === 'both') {
    // Reuse the entity pairing already established by the totals, so a segment is only
    // compared for entities the two screens agree exist.
    for (const m of matched.matches) {
      const lRows = leftBreakdown.get(m.leftLabel) ?? [];
      const rRows = rightBreakdown.get(m.rightLabel) ?? [];
      if (!lRows.length && !rRows.length) continue;

      const byKey = (rows: NormalizedRow[]) => {
        const map = new Map<string, NormalizedRow>();
        for (const r of rows) {
          const key = canonicalSegment(r.segment ?? '');
          if (key && !map.has(key)) map.set(key, r);
        }
        return map;
      };
      const lBy = byKey(lRows);
      const rBy = byKey(rRows);

      for (const [key, lRow] of lBy) {
        const rRow = rBy.get(key);
        if (!rRow) {
          segmentsOnlyOnLeft.add(key);
          continue;
        }
        const cells = compareCells(
          lRow.cells,
          rRow.cells,
          `${m.id}|${key}`,
          `${m.leftLabel} ${key}`,
        );
        segmentOutcomes.push({
          entity: m.leftLabel,
          rightEntity: m.rightLabel,
          segment: key,
          leftSegment: lRow.segment ?? '',
          rightSegment: rRow.segment ?? '',
          cells,
          passed: cells.every((c) => c.verdict === 'match'),
        });
      }
      for (const key of rBy.keys()) if (!lBy.has(key)) segmentsOnlyOnRight.add(key);
    }
  }

  let segmentMatched = 0;
  let segmentRounded = 0;
  let segmentMismatched = 0;
  let segmentMissing = 0;
  for (const s of segmentOutcomes) {
    for (const c of s.cells) {
      if (c.verdict === 'match') {
        segmentMatched++;
        if (c.roundedMatch) segmentRounded++;
      } else if (c.verdict === 'mismatch') segmentMismatched++;
      else segmentMissing++;
    }
  }

  let breakdownNote: string | null = null;
  if (availability === 'left' || availability === 'right') {
    const side = availability === 'left' ? leftLabel : rightLabel;
    const other = availability === 'left' ? rightLabel : leftLabel;
    const segs = availability === 'left' ? pair.left.normalized.segments : pair.right.normalized.segments;
    const map = availability === 'left' ? leftBreakdown : rightBreakdown;
    const entities = map.size;
    const rowCount = countRows(map);
    breakdownNote =
      `${side} breaks each row down into ${describeSegments(segs) || 'segments'} while ${other} shows only a ` +
      `total. Totals were compared against totals, which is like for like. The breakdown itself ` +
      `(${entities} entit${entities === 1 ? 'y' : 'ies'}, ${rowCount} segment row(s)) has no counterpart ` +
      `on ${other}, so it could not be compared. Counted here as a missing breakdown, and ` +
      'deliberately not counted as a total-value mismatch.';
  } else if (availability === 'both') {
    breakdownNote =
      `Both screens break rows down into segments (${describeSegments(pair.left.normalized.segments)} on ` +
      `${leftLabel}, ${describeSegments(pair.right.normalized.segments)} on ${rightLabel}). Totals were ` +
      `compared total-against-total, and each segment was then compared individually: ` +
      `${segmentOutcomes.length} segment row pair(s), ` +
      `${segmentMatched + segmentMismatched + segmentMissing} cell(s).`;
  } else {
    breakdownNote = null;
  }

  const breakdown = {
    leftSegments: pair.left.normalized.segments,
    rightSegments: pair.right.normalized.segments,
    availability,
    onlyOnLeft: availability === 'left' ? leftBreakdown.size : 0,
    onlyOnRight: availability === 'right' ? rightBreakdown.size : 0,
    uncomparedSegmentRows:
      availability === 'left'
        ? countRows(leftBreakdown)
        : availability === 'right'
          ? countRows(rightBreakdown)
          : 0,
    segmentComparison:
      availability === 'both'
        ? {
            rowPairs: segmentOutcomes.length,
            totalCells: segmentMatched + segmentMismatched + segmentMissing,
            matched: segmentMatched,
            roundedMatches: segmentRounded,
            mismatched: segmentMismatched,
            missing: segmentMissing,
            segmentsOnlyOnLeft: [...segmentsOnlyOnLeft],
            segmentsOnlyOnRight: [...segmentsOnlyOnRight],
            outcomes: segmentOutcomes,
          }
        : null,
    note: breakdownNote,
  };

  // --- are the two grids even shaped comparably? ---
  //
  // Judged on the rows that were actually compared (the totals), not on raw row counts.
  // A grid with four rows per technician against one row per technician is not
  // misaligned; it is the same data at a finer grain, and the breakdown block above
  // already accounts for it. Warning on the raw counts fired on every grid with a
  // breakdown and taught the reader to ignore the warning.
  const leftDataRows = pair.left.labels.size;
  const rightDataRows = pair.right.labels.size;

  const countDuplicateTotals = (profile: GridProfile): number => {
    const seen = new Map<string, number>();
    for (const r of comparableRows(profile.normalized)) {
      const l = normalizeLabel(r.label);
      if (!l) continue;
      seen.set(l, (seen.get(l) ?? 0) + 1);
    }
    let dupes = 0;
    for (const n of seen.values()) if (n > 1) dupes++;
    return dupes;
  };

  const leftDuplicateLabels = countDuplicateTotals(pair.left);
  const rightDuplicateLabels = countDuplicateTotals(pair.right);

  const leftComparable = comparableRows(pair.left.normalized).length;
  const rightComparable = comparableRows(pair.right.normalized).length;
  const rowRatio =
    Math.max(leftComparable, rightComparable) / Math.max(1, Math.min(leftComparable, rightComparable));

  let shapeWarning: string | null = null;
  const widerName = leftComparable > rightComparable ? leftLabel : rightLabel;
  const dupSide =
    leftDuplicateLabels > rightDuplicateLabels * 2 + 2
      ? leftLabel
      : rightDuplicateLabels > leftDuplicateLabels * 2 + 2
        ? rightLabel
        : null;

  if (rowRatio >= 1.5 || dupSide) {
    const bits: string[] = [];
    if (rowRatio >= 1.5) {
      bits.push(
        `${widerName} contributes ${Math.max(leftComparable, rightComparable)} comparable row(s) ` +
          `against ${Math.min(leftComparable, rightComparable)} on the other side`,
      );
    }
    if (dupSide) {
      bits.push(
        `${dupSide} repeats the same row label multiple times among its comparable rows ` +
          `(${dupSide === leftLabel ? leftDuplicateLabels : rightDuplicateLabels} label(s) appear more than once)`,
      );
    }
    shapeWarning =
      `The two grids are not shaped the same way even after totals were isolated: ${bits.join(', and ')}. ` +
      'One screen is likely split by a dimension the other does not show at all, so some rows have ' +
      'no like-for-like counterpart. Check the unmatched rows below before reading differences as defects.';
  }

  return {
    id: pair.id,
    name: pair.name,
    breakdown,
    shape: {
      leftDataRows,
      rightDataRows,
      leftDuplicateLabels,
      rightDuplicateLabels,
      comparable: shapeWarning === null,
      warning: shapeWarning,
    },
    pairing: {
      reason:
        pair.reason +
        (skippedGroups.length
          ? `. Skipped non-numeric group(s): ${skippedGroups.join(', ')}`
          : ''),
      labelOverlap: pair.labelOverlap,
      sharedLabels: pair.sharedLabels,
    },
    alignmentNotes,
    transposed: pair.left.transposedFrom
      ? { side: 'left', note: pair.left.transposedFrom }
      : pair.right.transposedFrom
        ? { side: 'right', note: pair.right.transposedFrom }
        : null,
    skippedGroups,
    groups,
    geometry: { left: leftGeo, right: rightGeo },
    columnPairs,
    unpairedColumns: { left: unpairedLeftCols, right: unpairedRightCols },
    coverageStats: {
      leftValueColumns,
      rightValueColumns,
      comparedColumns: columnPairs.length,
    },
    metrics,
    coverage: {
      matched: matched.matches.length,
      // Attach the values each unmatched row held, using the column positions for that
      // side, so the report can show what was actually skipped rather than a bare label.
      unmatchedLeft: matched.unmatchedLeft.map((u) => ({
        label: u.label,
        ...(u.closest ? { closest: u.closest } : {}),
        values: columnPairs.map((cp) => ({
          group: cp.group,
          column: cp.name,
          raw: (u.row[cp.leftIndex] ?? '').trim(),
        })),
      })),
      unmatchedRight: matched.unmatchedRight.map((u) => ({
        label: u.label,
        ...(u.closest ? { closest: u.closest } : {}),
        values: columnPairs.map((cp) => ({
          group: cp.group,
          column: cp.name,
          raw: (u.row[cp.rightIndex] ?? '').trim(),
        })),
      })),
      byMethod,
    },
    summary: {
      totalCells: matchedCells + mismatched + missing,
      matched: matchedCells,
      roundedMatches,
      mismatched,
      missing,
      metricsPassed: metrics.filter((m) => m.passed).length,
      metricsFailed: metrics.filter((m) => !m.passed).length,
      byGroup,
    },
  };
}

export function runSuite(left: Capture, right: Capture, preset: ModulePreset): SuiteResult {
  const leftTables = left.rendered?.tables ?? [];
  const rightTables = right.rendered?.tables ?? [];

  // 1. Profile every table on both screens, once. Everything downstream works from these.
  const leftProfiles = profileGrids(leftTables);
  const rightProfiles = profileGrids(rightTables);

  // 2. Work out what each table *is* before attempting to compare anything. A summary and
  //    a record listing are not comparable row for row however similar their columns look,
  //    and knowing which is which is what lets a structural difference be reported as one.
  const leftStructures = classifyTables(leftProfiles);
  const rightStructures = classifyTables(rightProfiles);

  // 3. Compare the analytics strip. Done before the grids and independently of them: on a
  //    module with no summary grid the strip holds the only directly comparable figures
  //    there are, and making it conditional on a grid pairing is what caused such a module
  //    to be reported as entirely uncomparable.
  const analytics = compareTiles(left.rendered?.tiles ?? [], right.rendered?.tiles ?? [], {
    leftLabel: left.label,
    rightLabel: right.label,
  });

  // 4. Then pair the grids that correspond.
  const pairing = pairGrids(leftProfiles, rightProfiles, {
    minSharedLabels: preset.minSharedLabels,
    minOverlap: preset.minLabelOverlap,
  });

  /**
   * 5. Where both screens publish this module as a listing of individual records, compare
   *    them record by record.
   *
   *    Grid pairing matches rows by label, and a listing's rows are identified by a record
   *    number rather than a metric name, so two listings never pair however alike they are.
   *    That is why a module with fourteen columns in common on both sides was reported as
   *    having nothing to compare.
   */
  const leftDetails = leftStructures.filter((s) => s.role === 'detail');
  const rightDetails = rightStructures.filter((s) => s.role === 'detail');
  let recordComparison: RecordComparison | null = null;

  if (leftDetails.length && rightDetails.length) {
    // Take the largest listing on each side; that is the module's own grid rather than a
    // subsidiary panel.
    const pick = (structures: TableStructure[], profiles: GridProfile[]) => {
      const best = [...structures].sort((a, b) => b.bodyRows - a.bodyRows)[0]!;
      return profiles.find((p) => p.table.index === best.index) ?? null;
    };
    const lDetail = pick(leftDetails, leftProfiles);
    const rDetail = pick(rightDetails, rightProfiles);
    if (lDetail && rDetail) {
      recordComparison = compareRecords(lDetail, rDetail, {
        leftLabel: left.label,
        rightLabel: right.label,
        recordColumns: preset.recordColumns,
      });
    }
  }

  // A preset may narrow the comparison to specific grids by header text.
  let pairs = pairing.pairs;
  if (preset.gridHints?.length) {
    const hinted = pairs.filter((p) => {
      const hay = [
        ...(p.left.table.headerGrid?.flat() ?? p.left.table.headers.flat()),
        ...(p.right.table.headerGrid?.flat() ?? p.right.table.headers.flat()),
        p.name,
      ]
        .join(' ')
        .toUpperCase();
      return preset.gridHints!.every((h) => hay.includes(h.toUpperCase()));
    });
    if (hinted.length) pairs = hinted;
    else
      pairing.notes.push(
        `gridHints ${JSON.stringify(preset.gridHints)} matched no paired grid; comparing all ${pairs.length}.`,
      );
  }

  /**
   * Describe what could not be aligned, rather than throwing.
   *
   * Distinguishes "one screen produced nothing" from "both produced grids that do not
   * correspond". They have completely different remedies, and reporting them the same
   * way sends you looking for a mapping problem when the real issue is a failed load.
   */
  /**
   * Things that could not be compared while other things could.
   *
   * Kept apart from `blocked`, which means nothing at all was comparable. A module whose
   * grids will not align but whose analytics strip compares cleanly is a partial
   * comparison, and reporting it as "Not Compared" throws away the part that worked.
   */
  const limitations: SuiteBlocked[] = [];
  let blocked: SuiteBlocked | null = null;
  // Something else compared, so a grid that would not align is a coverage limit rather than
  // a failure to compare the module.
  const analyticsUsable =
    Boolean(analytics && analytics.compared > 0) ||
    Boolean(recordComparison && recordComparison.summary.totalCells > 0);

  if (!pairs.length) {
    let issue: SuiteBlocked;
    const emptySide =
      leftTables.length === 0 ? left.label : rightTables.length === 0 ? right.label : null;

    if (emptySide) {
      issue = {
        reason: `The ${emptySide} capture contains no tables at all`,
        detail:
          `Nothing was found on the ${emptySide} screen to compare against, so the comparison ` +
          'could not start. That screen either had not finished rendering when it was captured, ' +
          'renders its figures without HTML tables, or the URL did not land where expected.',
        remedy: [
          `Open the screenshots below to see what the ${emptySide} screen actually looked like when it was read.`,
          'Confirm the URL points at the screen you meant, and that the login role can see it.',
          'If the screen renders its figures without using HTML tables, it needs a different reader.',
        ],
      };
    } else {
      // Keep this to the shape of the problem. The per-table specifics are in the
      // observation section, which can be expanded; repeating all of them here produced a
      // paragraph nobody would read.
      const lProfiles = leftProfiles;
      const rProfiles = rightProfiles;
      const biggest = (ps: GridProfile[]) =>
        ps.reduce<GridProfile | null>((a, p) => (!a || p.dataRows > a.dataRows ? p : a), null);
      const lBig = biggest(lProfiles);
      const rBig = biggest(rProfiles);
      const labelless = rProfiles.filter((p) => p.dataRows === 0).length +
        lProfiles.filter((p) => p.dataRows === 0).length;

      issue = {
        reason: 'No grid on one screen corresponds to a grid on the other',
        detail:
          `${lProfiles.length} table(s) were found on ${left.label} and ${rProfiles.length} on ` +
          `${right.label}, but no pair of them could be matched. Two tables are only paired when they ` +
          'share a column group and at least a few row labels, because that is the evidence that they ' +
          'describe the same thing. ' +
          (lBig && rBig
            ? `The largest on each side were "${lBig.name}" (${lBig.dataRows} row label(s)) and ` +
              `"${rBig.name}" (${rBig.dataRows} row label(s)), and they have no row labels in common.`
            : '') +
          (labelless
            ? ` ${labelless} table(s) carry no row labels at all, so they cannot be matched by row ` +
              'in the first place — that is the signature of a summary strip whose dimension runs ' +
              'across the header instead of down the rows.'
            : ''),
        remedy: [
          'Expand the table structures under "What the crawl observed" and compare the header rows. ' +
            'If one screen runs a dimension across its columns where the other runs it down its rows, ' +
            'the row labels can never line up.',
          'If one screen shows a per-record listing while the other shows a summary, they are at ' +
            'different levels of detail and there is nothing to reconcile row for row.',
          'Confirm both URLs point at the same report rather than two different views of it.',
          'Set gridHints in modules/<module>.json to point the comparison at the intended tables.',
        ],
      };
    }

    // If the analytics strip compared, this is a limitation on coverage rather than a
    // failure to compare the module. Calling it "Not Compared" would discard everything
    // that did compare.
    if (analyticsUsable) limitations.push(issue);
    else blocked = issue;
  }

  const grids: GridResult[] = [];
  const uncomparableGrids: string[] = [];
  for (const p of pairs) {
    const result = compareGrid(p, preset, { leftLabel: left.label, rightLabel: right.label });
    if (result) grids.push(result);
    else uncomparableGrids.push(p.name);
  }

  if (!grids.length && !blocked && !limitations.length && uncomparableGrids.length) {
    const columnIssue: SuiteBlocked = {
      reason: 'Grids were paired, but no column inside them could be aligned',
      detail:
        `${uncomparableGrids.length} grid pair(s) were matched by their row labels — ` +
        `${uncomparableGrids.join(', ')} — but within the shared column groups no column on one ` +
        'screen could be matched to a column on the other, so there was nothing to compare. The two ' +
        'screens head their columns too differently for names to align them, and their values did ' +
        'not correspond closely enough to settle it either.',
      remedy: [
        'Compare the header rows listed below and confirm the two screens really are showing the same measures.',
        'If the columns mean the same thing under different names, add them to a module preset so the mapping is explicit.',
      ],
    };
    if (analyticsUsable) limitations.push(columnIssue);
    else blocked = columnIssue;
  }

  // --- module-wide rollup ---
  const byGroup: Record<string, { matched: number; mismatched: number; missing: number }> = {};
  let totalCells = 0;
  let matched = 0;
  let mismatched = 0;
  let missing = 0;
  let metricsPassed = 0;
  let metricsFailed = 0;
  let roundedMatches = 0;
  const bd = {
    gridsBothSides: 0,
    gridsOneSideOnly: 0,
    missingBreakdownEntities: 0,
    uncomparedSegmentRows: 0,
    segmentRowPairs: 0,
    segmentCells: 0,
    segmentMatched: 0,
    segmentRoundedMatches: 0,
    segmentMismatched: 0,
    segmentMissing: 0,
  };

  for (const g of grids) {
    totalCells += g.summary.totalCells;
    matched += g.summary.matched;
    roundedMatches += g.summary.roundedMatches;
    mismatched += g.summary.mismatched;
    missing += g.summary.missing;
    metricsPassed += g.summary.metricsPassed;
    metricsFailed += g.summary.metricsFailed;

    const b = g.breakdown;
    if (b.availability === 'both') bd.gridsBothSides++;
    else if (b.availability === 'left' || b.availability === 'right') bd.gridsOneSideOnly++;
    bd.missingBreakdownEntities += b.onlyOnLeft + b.onlyOnRight;
    bd.uncomparedSegmentRows += b.uncomparedSegmentRows;
    if (b.segmentComparison) {
      bd.segmentRowPairs += b.segmentComparison.rowPairs;
      bd.segmentCells += b.segmentComparison.totalCells;
      bd.segmentMatched += b.segmentComparison.matched;
      bd.segmentRoundedMatches += b.segmentComparison.roundedMatches;
      bd.segmentMismatched += b.segmentComparison.mismatched;
      bd.segmentMissing += b.segmentComparison.missing;
    }

    for (const [group, v] of Object.entries(g.summary.byGroup)) {
      byGroup[group] ??= { matched: 0, mismatched: 0, missing: 0 };
      byGroup[group]!.matched += v.matched;
      byGroup[group]!.mismatched += v.mismatched;
      byGroup[group]!.missing += v.missing;
    }
  }

  // Identify paired tables by their capture index, not by object identity. A pivoted
  // strip is a freshly built table object, so profiling the same capture twice yields
  // two distinct objects for it and an identity check reported the grid that was
  // actually compared as having no counterpart.
  const pairedLeft = new Set(pairs.map((p) => p.left.table.index));
  const pairedRight = new Set(pairs.map((p) => p.right.table.index));

  /**
   * Describe each table well enough to diagnose an alignment failure from the report
   * alone. The header row, the body width and a few verbatim rows are what make a
   * transposed or unexpectedly shaped grid obvious; a name and a row count do not.
   */
  const describe = (profiles: GridProfile[], paired: Set<number>): ObservedTable[] =>
    profiles.map((p) => {
      const grid = p.table.headerGrid ?? p.table.headers;
      return {
        index: p.table.index,
        name: p.name,
        rows: p.dataRows,
        groups: p.geometry.groups.filter(Boolean),
        paired: paired.has(p.table.index),
        headerRow: (grid.at(-1) ?? []).map((h) => (h ?? '').trim()),
        bodyWidth: p.table.rows.reduce((m, r) => Math.max(m, r.length), 0),
        sample: p.table.rows.slice(0, 3).map((r) => r.map((c) => (c ?? '').trim())),
        labels: [...p.labels].slice(0, 40),
        ...(p.transposedFrom ? { transposedFrom: p.transposedFrom } : {}),
      };
    });

  const allLeft = leftProfiles;
  const allRight = rightProfiles;

  // 4. Decide the comparison mode. Summary against summary is the default and the
  //    fallback; a record-level listing only escalates it when the listing is complete
  //    enough to be aggregated without inventing a shortfall.
  const mode = decideMode({
    leftLabel: left.label,
    rightLabel: right.label,
    leftProfiles,
    rightProfiles,
    leftStructures,
    rightStructures,
    // The richest compared summary on each side is the one worth checking a listing
    // against — it is the most likely to publish a record count and a grand total.
    comparedLeft:
      pairs.map((p) => p.left).sort((a, b) => b.dataRows - a.dataRows)[0] ?? null,
    comparedRight:
      pairs.map((p) => p.right).sort((a, b) => b.dataRows - a.dataRows)[0] ?? null,
    corroboration: preset.corroboration,
  });

  /** One sentence per screen describing how it presents this module. */
  const describeStructure = (label: string, structures: TableStructure[]): string => {
    if (!structures.length) return `${label} returned no tables.`;
    const by = (role: string) => structures.filter((s) => s.role === role);
    const bits: string[] = [];
    const summaries = by('summary');
    if (summaries.length) {
      const withBreakdown = summaries.filter((s) => s.hasBreakdown);
      bits.push(
        `${summaries.length} summary grid(s)` +
          (withBreakdown.length
            ? `, ${withBreakdown.length} of which break rows down by ${withBreakdown[0]!.segments.join('/')}`
            : ''),
      );
    }
    if (by('detail').length) bits.push(`${by('detail').length} record-level listing(s)`);
    if (by('strip').length) bits.push(`${by('strip').length} single-row KPI strip(s)`);
    if (by('unknown').length) bits.push(`${by('unknown').length} table(s) of unclear structure`);
    const transposed = structures.filter((s) => s.transposed);
    return (
      `${label} publishes ${bits.join(', ') || 'nothing recognisable'}.` +
      (transposed.length
        ? ` ${transposed.length} of them run a dimension across the header rather than down the rows and were pivoted to compare.`
        : '')
    );
  };

  const structureSummary = [
    describeStructure(left.label, leftStructures),
    describeStructure(right.label, rightStructures),
  ].join(' ');

  /**
   * Report on every pass the engine can make, applied or not.
   *
   * This is what makes "it works on any module" checkable rather than a claim. Paste in a
   * module nobody has tried and this table says which comparisons fitted what the two screens
   * publish, and for anything that did not run, whether that is because the module has no such
   * data or because something got in the way.
   */
  const coverage: CoveragePass[] = [];

  /**
   * A pass that compared nothing has not run, whatever it was handed.
   *
   * The analytics comparison is created whenever either screen shows a card, but if none of
   * them pair then nothing was compared — and reporting that as "RAN, 0 cards" invites the
   * reader to conclude the strip was checked and agreed.
   */
  coverage.push(
    analytics && analytics.compared > 0
      ? {
          name: 'Analytics strip (KPI cards)',
          status: 'ran',
          detail:
            `${analytics.compared} card(s) matched by label and compared. ` +
            `${analytics.onlyOnLeft.length} on ${left.label} and ${analytics.onlyOnRight.length} on ` +
            `${right.label} have no counterpart.`,
          compared: analytics.compared,
          unit: 'cards',
          differences: analytics.mismatched,
        }
      : analytics && (analytics.onlyOnLeft.length || analytics.onlyOnRight.length)
        ? {
            name: 'Analytics strip (KPI cards)',
            status: 'blocked',
            detail:
              `Cards were found (${analytics.onlyOnLeft.length} on ${left.label}, ` +
              `${analytics.onlyOnRight.length} on ${right.label}) but none could be matched to a ` +
              'counterpart, so none was compared. The two screens either label them too ' +
              'differently, or each shows figures the other does not.',
            compared: 0,
            unit: 'cards',
            differences: 0,
          }
        : {
            name: 'Analytics strip (KPI cards)',
            status: 'not-applicable',
            detail:
              'Neither screen shows labelled KPI cards outside its grid for this module, so there ' +
              'is no strip to compare.',
            compared: 0,
            unit: 'cards',
            differences: 0,
          },
  );

  const gridCells = grids.reduce((a, g) => a + g.summary.totalCells, 0);
  coverage.push(
    grids.length
      ? {
          name: 'Summary grid, metric by metric',
          status: 'ran',
          detail:
            `${grids.length} grid pair(s) compared: ` +
            grids
              .map(
                (g) =>
                  `"${g.name}" ${g.coverage.matched} row(s) x ${g.coverageStats.comparedColumns} column(s)`,
              )
              .join('; ') +
            '.',
          compared: gridCells,
          unit: 'cells',
          differences: grids.reduce((a, g) => a + g.summary.mismatched, 0),
        }
      : {
          name: 'Summary grid, metric by metric',
          status: pairs.length || leftTables.length ? 'blocked' : 'not-applicable',
          detail:
            limitations[0]?.reason ??
            blocked?.reason ??
            'Neither screen publishes a summary grid for this module.',
          compared: 0,
          unit: 'cells',
          differences: 0,
        },
  );

  const segmentCells = grids.reduce(
    (a, g) => a + (g.breakdown.segmentComparison?.totalCells ?? 0),
    0,
  );
  const anyBreakdown = grids.some((g) => g.breakdown.availability !== 'neither');
  coverage.push({
    name: 'Row breakdown (segments within a row)',
    // A breakdown on one screen only means nothing was compared segment against segment; the
    // rows were still reconciled at total level, and the gap is counted in its own section.
    status: segmentCells > 0 ? 'ran' : anyBreakdown ? 'blocked' : 'not-applicable',
    detail: anyBreakdown
      ? grids
          .filter((g) => g.breakdown.availability !== 'neither')
          .map(
            (g) =>
              `"${g.name}": breakdown on ${
                g.breakdown.availability === 'both' ? 'both screens' : `${g.breakdown.availability} only`
              }` +
              (g.breakdown.segmentComparison
                ? `, ${g.breakdown.segmentComparison.rowPairs} segment row pair(s) compared`
                : `, ${g.breakdown.uncomparedSegmentRows} segment row(s) with no counterpart`),
          )
          .join('; ')
      : 'No grid on either screen splits a row into segments, so there is no breakdown to reconcile.',
    compared: segmentCells,
    unit: 'cells',
    differences: grids.reduce((a, g) => a + (g.breakdown.segmentComparison?.mismatched ?? 0), 0),
  });

  coverage.push(
    recordComparison
      ? {
          name: 'Record listing, record by record',
          status: 'ran',
          detail:
            `${recordComparison.summary.recordsCompared} record(s) matched on ` +
            `${recordComparison.keyColumn.left} and compared across ` +
            `${recordComparison.columnPairs.length} column(s) ` +
            `(${recordComparison.columnPairs.filter((c) => c.kind === 'text').length} descriptive).`,
          compared: recordComparison.summary.totalCells,
          unit: 'cells',
          differences: recordComparison.summary.mismatched,
        }
      : {
          name: 'Record listing, record by record',
          status:
            leftDetails.length && rightDetails.length
              ? 'blocked'
              : 'not-applicable',
          detail:
            leftDetails.length && rightDetails.length
              ? 'Both screens list records, but no column could be found whose values identify a ' +
                'record on both sides, so records could not be paired.'
              : leftDetails.length || rightDetails.length
                ? `Only ${leftDetails.length ? left.label : right.label} publishes a record-level ` +
                  'listing for this module. A listing can only be compared record by record ' +
                  'against another listing.'
                : 'Neither screen publishes a record-level listing for this module.',
          compared: 0,
          unit: 'cells',
          differences: 0,
        },
  );

  const corroborated = mode.corroboration.reduce((a, c) => a + c.checks.length, 0);
  coverage.push({
    name: 'Detail view corroborating a summary',
    status: corroborated
      ? 'ran'
      : mode.detailViews.length
        ? 'blocked'
        : 'not-applicable',
    detail: corroborated
      ? `${corroborated} aggregate(s) from ${mode.corroboration.length} complete listing(s) checked ` +
        'against the matching summary totals.'
      : mode.detailViews.length
        ? mode.detailViews.map((v) => `${v.sideLabel} "${v.name}": ${v.why}`).join(' ')
        : 'No record-level listing was found that could corroborate a summary.',
    compared: corroborated,
    unit: 'checks',
    differences: mode.corroboration.reduce(
      (a, c) => a + c.checks.filter((k) => k.verdict !== 'match').length,
      0,
    ),
  });

  const lRange = extractDateRange(left);
  const rRange = extractDateRange(right);
  const bothKnown = lRange !== null && rRange !== null;
  const sameRange = bothKnown && normalizeDate(lRange!) === normalizeDate(rRange!);
  const rangeStatus: 'aligned' | 'differ' | 'unknown' = !bothKnown
    ? 'unknown'
    : sameRange
      ? 'aligned'
      : 'differ';

  return {
    moduleName: preset.name,
    generatedAt: new Date().toISOString(),
    left: { label: left.label, role: left.role, url: left.finalUrl, capturedAt: left.capturedAt },
    right: { label: right.label, role: right.role, url: right.finalUrl, capturedAt: right.capturedAt },
    grids,
    blocked,
    limitations,
    structure: { left: leftStructures, right: rightStructures, summary: structureSummary },
    mode,
    analytics,
    recordComparison,
    coverage,
    observation: {
      leftTables: describe(allLeft, pairedLeft),
      rightTables: describe(allRight, pairedRight),
      notes: pairing.notes,
    },
    dateRange: {
      left: lRange,
      right: rRange,
      status: rangeStatus,
      aligned: sameRange,
      note:
        rangeStatus === 'aligned'
          ? 'Both screens requested the same range.'
          : rangeStatus === 'differ'
            ? 'The two screens requested different ranges. Check whether their value columns ' +
              'still cover the same period before treating differences as defects.'
            : `The requested range could not be read from ${
                lRange === null && rRange === null
                  ? 'either screen'
                  : lRange === null
                    ? 'the AutoGroup screen'
                    : 'the DMS screen'
              }, because it is not exposed in the calls that screen makes. ` +
              'This is not evidence of a mismatch — only that it could not be confirmed.',
    },
    summary: {
      totalCells,
      matched,
      roundedMatches,
      mismatched,
      missing,
      metricsPassed,
      metricsFailed,
      gridsCompared: grids.length,
      byGroup,
      breakdown: bd,
    },
  };
}
