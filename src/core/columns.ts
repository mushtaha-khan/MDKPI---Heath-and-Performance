/**
 * Derive a report grid's column geometry from its header structure.
 *
 * The original comparison hardcoded column positions per screen (AutoGroup: stride 4,
 * value at 1/5/9/13; DMS: stride 16, value at 2/18/34/50). That only ever worked for
 * one module. Here the positions are computed from the colspan-expanded header matrix
 * captured alongside the rows, so any grid laid out as
 * "group -> measure -> sub-column" can be read without prior knowledge.
 */
import { normalizeLabel, similarity } from './match.js';

/** Canonical pay-type / column-group identity, used to align the two screens. */
export type GroupKey = string;

export interface ColumnSpec {
  /** Index into a body row array. */
  index: number;
  /** Full header chain top-to-bottom for this column. */
  chain: string[];
  /** Normalized top-level group, e.g. "TOTAL", "CUSTOMER PAY". */
  group: GroupKey;
  /** True when this column holds the primary value (not %, Avg., Tracking, Budget). */
  isPrimaryValue: boolean;
}

export interface GridGeometry {
  /** Column index holding the row label. */
  labelColumn: number;
  columns: ColumnSpec[];
  /** Primary value column per group, in the order the groups appear. */
  primaryByGroup: Map<GroupKey, number>;
  /** Groups discovered, in document order. */
  groups: GroupKey[];
  /** Diagnostic notes about how the geometry was resolved. */
  notes: string[];
}

/** Words that mark a column as a derived figure rather than the primary value. */
const DERIVED_MARKERS = ['%', 'AVG', 'AVERAGE'];
/** Words that mark a column as a non-actual measure. */
const NON_ACTUAL_MEASURES = ['TRACKING', 'BUDGET', 'VARIANCE', 'FORECAST', 'PRIOR', 'LAST YEAR'];

export function normalizeHeader(s: string): string {
  return (s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[\u2018\u2019\u201c\u201d]/g, '')
    .trim()
    .toUpperCase();
}

/**
 * Canonicalize a group heading so the same pay type is recognised across screens.
 * DMS calls the total column "TOTAL CP/W/I" while AutoGroup calls it "TOTAL".
 */
export function canonicalGroup(raw: string): GroupKey {
  const h = normalizeHeader(raw);
  if (!h) return '';
  if (/\bCUSTOMER\s*PAY\b|\bCUST\s*PAY\b|^CP$/.test(h)) return 'CUSTOMER PAY';
  if (/\bWARRANTY\b|^W$/.test(h)) return 'WARRANTY';
  if (/\bINTERNAL\b|^I$/.test(h)) return 'INTERNAL';
  if (/\bTOTAL\b/.test(h)) return 'TOTAL';
  return h;
}

/**
 * Build the geometry for one grid.
 *
 * `headerGrid` must be the colspan/rowspan-expanded header matrix, so that
 * headerGrid[r][c] is the header text covering body column c at header row r.
 */
export function deriveGeometry(headerGrid: string[][], rows: string[][]): GridGeometry {
  const notes: string[] = [];

  if (!headerGrid.length) {
    notes.push('No header rows found; falling back to label column 0 with no groups.');
    return {
      labelColumn: 0,
      columns: [],
      primaryByGroup: new Map(),
      groups: [],
      notes,
    };
  }

  /**
   * Align the header grid to the body's column count.
   *
   * A header can contain spacer cells that the body rows do not repeat. When that
   * happens every column after the spacer is offset by one, so headers describe the
   * wrong data — Labor Sale ends up compared against Labor Cost, producing a mass of
   * differences that are purely an artefact of the misalignment. Detect the surplus and
   * drop the blank header columns that caused it.
   */
  /**
   * Take the widest body row as the column count.
   *
   * Neither the median nor the most common width works: a grid that groups its rows
   * mixes full data rows with narrower subtotal and section rows, and on one screen
   * those narrow rows are the majority. Both statistics then understate the real column
   * count, causing genuine header columns to be dropped and manufacturing the very
   * misalignment this is meant to repair. A subtotal row can only ever have fewer cells
   * than a data row, so the maximum is the honest figure.
   */
  /**
   * Discard header rows that are really totals rows.
   *
   * Some screens render a grand-total row inside the `thead`, below the column names. The
   * deepest header row is what column matching works from, so the columns end up
   * identified by figures — a DMS lender table headed
   * "SHOW ALL (43) | $1,259,141.76 | $1,244,125.23" instead of
   * "BANK NAME | AMOUNT FINANCED | GL". Nothing can then align to the other screen by
   * name, and the whole grid goes uncompared.
   *
   * The test is deliberately narrow. A cell only counts as a figure if it looks like
   * money or a formatted quantity — a currency symbol, thousands separator, or decimal
   * point. A bare integer does not count, because a header row can legitimately be years
   * ("2024", "2025") and dropping that would destroy a real grid. A row also needs at
   * least three filled cells before it can be judged, and the last surviving row is
   * never dropped: a grid with nowhere to read names from is worse than one reading them
   * from an odd row.
   */
  const looksLikeAmount = (s: string) => {
    const t = (s ?? '').trim();
    if (!t || !/\d/.test(t)) return false;
    return /[$€£]/.test(t) || /\d,\d{3}/.test(t) || /\d\.\d/.test(t);
  };

  let hdr = headerGrid;
  if (headerGrid.length > 1) {
    const kept = headerGrid.filter((row) => {
      const filled = row.map((c) => (c ?? '').trim()).filter(Boolean);
      if (filled.length < 3) return true;
      return filled.filter(looksLikeAmount).length / filled.length < 0.6;
    });
    if (kept.length && kept.length < headerGrid.length) {
      notes.push(
        `Discarded ${headerGrid.length - kept.length} header row(s) holding figures rather ` +
          'than column names; a total row rendered inside the header would otherwise be ' +
          'read as the column headings.',
      );
      hdr = kept;
    }
  }

  const bodyWidth = rows.reduce((max, r) => Math.max(max, r.length), 0) || (hdr[0]?.length ?? 0);

  let grid = hdr;
  const headerWidth = hdr[0]?.length ?? 0;

  if (headerWidth > bodyWidth) {
    const surplus = headerWidth - bodyWidth;
    // Columns blank in every header row are spacers and are the ones to drop.
    const blanks: number[] = [];
    for (let c = 0; c < headerWidth; c++) {
      if (hdr.every((row) => !(row[c] ?? '').trim())) blanks.push(c);
    }
    const drop = new Set(blanks.slice(0, surplus));
    if (drop.size === surplus) {
      grid = hdr.map((row) => row.filter((_, c) => !drop.has(c)));
      notes.push(
        `Header had ${headerWidth} columns against ${bodyWidth} in the body; dropped ` +
          `${surplus} blank spacer column(s) at ${[...drop].join(', ')} to realign.`,
      );
    } else {
      notes.push(
        `Header has ${headerWidth} columns but the body has ${bodyWidth}, and the ` +
          'difference could not be attributed to blank spacer columns. Column positions ' +
          'may be unreliable for this grid.',
      );
    }
  } else if (headerWidth < bodyWidth) {
    notes.push(
      `Body has ${bodyWidth} columns against ${headerWidth} in the header; ` +
        'trailing columns will have no header.',
    );
  }

  const width = Math.max(grid[0]?.length ?? 0, bodyWidth);

  /**
   * Resolve which column holds the row label.
   *
   * "First column that is not a number" is not good enough: a grid whose rows are
   * people or vehicles often leads with a date or a code, and a date is not numeric by
   * that test, so the label ended up being a hire date while the other screen used
   * names — giving zero overlap and no pairing. Score each candidate on how much it
   * looks like a name or descriptive label instead, and take the best.
   */
  const looksNumeric = (s: string) =>
    /^[-+(]?[$€£]?\s?[\d,]+(\.\d+)?\s?[%)]?$/.test((s ?? '').trim());
  const looksLikeDate = (s: string) =>
    /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test((s ?? '').trim()) ||
    /^\d{1,2}\s+\w{3,9}\s+\d{2,4}$/.test((s ?? '').trim());
  const looksLikeLabel = (s: string) => {
    const t = (s ?? '').trim();
    if (!t || t === '-' || t === '—') return false;
    if (looksNumeric(t) || looksLikeDate(t)) return false;
    // At least two letters, so codes like "A1" or "$" do not qualify.
    return (t.match(/[A-Za-z]/g) ?? []).length >= 2;
  };

  /**
   * Score on how nearly unique a column's labels are, not on how many rows carry one.
   *
   * Two failure modes have to be avoided at once. A column blank for 22 of 24 rows must
   * not win on its two stray values — hence the requirement to carry a fair share of the
   * distinct labels available. And a breakdown marker column must not win either: a grid
   * that spells its segments out has "Customer Pay" in every single row, so on a hit
   * count it beats the name column, which is filled only once per group. Label columns
   * are near-unique; marker columns cycle through a few values.
   */
  const considered = rows.slice(0, 60);
  const candidates: Array<{ index: number; distinct: number; filled: number; ratio: number }> = [];
  for (let c = 0; c < Math.min(width, 8); c++) {
    const values = considered.map((r) => (r[c] ?? '').trim()).filter(looksLikeLabel);
    if (!values.length) continue;
    const distinct = new Set(values.map((v) => v.toUpperCase())).size;
    candidates.push({ index: c, distinct, filled: values.length, ratio: distinct / values.length });
  }

  let labelColumn = 0;
  if (candidates.length) {
    const maxDistinct = candidates.reduce((m, x) => Math.max(m, x.distinct), 0);
    const viable = candidates.filter((x) => x.distinct >= maxDistinct * 0.5);
    // Highest distinctness wins; ties keep the leftmost, matching how these grids read.
    viable.sort((a, b) => b.ratio - a.ratio || b.distinct - a.distinct || a.index - b.index);
    labelColumn = viable[0]!.index;
    const chosen = viable[0]!;
    notes.push(
      `Label column resolved to index ${labelColumn} (${chosen.distinct} distinct label(s) across ` +
        `${chosen.filled} labelled cell(s) in ${considered.length} sampled row(s)).`,
    );
  } else {
    notes.push('No column carried label-like text; defaulting to index 0.');
  }

  const columns: ColumnSpec[] = [];
  for (let c = 0; c < width; c++) {
    if (c === labelColumn) continue;
    const chain = grid.map((row) => normalizeHeader(row[c] ?? '')).filter(Boolean);
    if (!chain.length) continue;

    const group = canonicalGroup(chain[0] ?? '');
    const upperChain = chain.join(' | ');

    const hasDerived = DERIVED_MARKERS.some((m) => chain.some((h) => h === m || h.startsWith(m)));
    const hasNonActual = NON_ACTUAL_MEASURES.some((m) => upperChain.includes(m));
    const mentionsActual = upperChain.includes('ACTUAL');

    // The primary value column mentions ACTUAL somewhere in its chain and is not a
    // percentage, an average, or a non-actual measure such as Tracking or Budget.
    const isPrimaryValue = mentionsActual && !hasDerived && !hasNonActual;

    columns.push({ index: c, chain, group, isPrimaryValue });
  }

  const primaryByGroup = new Map<GroupKey, number>();
  const groups: GroupKey[] = [];
  for (const col of columns) {
    if (!col.group) continue;
    if (!groups.includes(col.group)) groups.push(col.group);
    if (col.isPrimaryValue && !primaryByGroup.has(col.group)) {
      primaryByGroup.set(col.group, col.index);
    }
  }

  // Fallback: some grids label the value column only at the group level, with no
  // "ACTUAL" sub-header at all. In that case take each group's first column.
  if (primaryByGroup.size === 0) {
    notes.push('No column chain mentioned ACTUAL; using the first column of each group.');
    for (const col of columns) {
      if (col.group && !primaryByGroup.has(col.group)) primaryByGroup.set(col.group, col.index);
    }
  }

  notes.push(
    `Groups: ${groups.map((g) => `${g}@${primaryByGroup.get(g) ?? '?'}`).join(', ') || 'none'}.`,
  );

  return { labelColumn, columns, primaryByGroup, groups, notes };
}

/** Groups present on both grids under the same canonical name, in the left grid's order. */
export function sharedGroups(left: GridGeometry, right: GridGeometry): GroupKey[] {
  return left.groups.filter((g) => right.primaryByGroup.has(g) && left.primaryByGroup.has(g));
}

/** A column group on one screen matched to its counterpart on the other. */
export interface GroupPair {
  left: GroupKey;
  right: GroupKey;
  /** 1 when the canonical names are identical, otherwise the name similarity. */
  score: number;
  matchedBy: 'exact' | 'fuzzy';
}

/**
 * How alike two group headings are, as a name.
 *
 * Exact canonical identity scores 1. Otherwise this falls back to token similarity, so
 * that a screen heading a column "SALES" can still be recognised as the counterpart of
 * "OPEN RO SALES" — one screen names the metric in full, the other relies on the report
 * title for that context.
 */
export function groupNameScore(a: GroupKey, b: GroupKey): number {
  if (!a || !b) return 0;
  if (canonicalGroup(a) === canonicalGroup(b)) return 1;
  return similarity(normalizeLabel(a), normalizeLabel(b));
}

/**
 * Match column groups across two grids by name alone, one to one.
 *
 * Exact matches are taken first so a fuzzy near-miss can never steal a group that has a
 * perfect counterpart. The rest are assigned greedily from the strongest score down.
 *
 * Name alone is not always enough to be sure: a bare "GROSS" is exactly as similar to
 * "OPEN RO GROSS" as it is to "AVG GROSS / RO". This function does not try to resolve
 * that — it reports the alignment it can justify from names, and the caller, which has
 * the row data, settles genuine ambiguity by checking which candidate's values actually
 * correspond.
 */
export function alignGroupsByName(
  left: GridGeometry,
  right: GridGeometry,
  minScore = 0.3,
): GroupPair[] {
  const lGroups = left.groups.filter((g) => g && left.primaryByGroup.has(g));
  const rGroups = right.groups.filter((g) => g && right.primaryByGroup.has(g));

  const pairs: GroupPair[] = [];
  const usedLeft = new Set<GroupKey>();
  const usedRight = new Set<GroupKey>();

  for (const g of lGroups) {
    if (!rGroups.includes(g)) continue;
    usedLeft.add(g);
    usedRight.add(g);
    pairs.push({ left: g, right: g, score: 1, matchedBy: 'exact' });
  }

  const candidates: GroupPair[] = [];
  for (const l of lGroups) {
    if (usedLeft.has(l)) continue;
    for (const r of rGroups) {
      if (usedRight.has(r)) continue;
      const score = groupNameScore(l, r);
      if (score >= minScore) candidates.push({ left: l, right: r, score, matchedBy: 'fuzzy' });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  for (const c of candidates) {
    if (usedLeft.has(c.left) || usedRight.has(c.right)) continue;
    usedLeft.add(c.left);
    usedRight.add(c.right);
    pairs.push(c);
  }

  // Keep the left grid's document order so the report reads like the screen.
  return pairs.sort((a, b) => lGroups.indexOf(a.left) - lGroups.indexOf(b.left));
}

/** A column described well enough to be matched against the other screen. */
export interface ClassifiedColumn {
  index: number;
  chain: string[];
  group: GroupKey;
  /** ACTUAL / TRACKING / BUDGET / VARIANCE, or '' when the grid has no measure tier. */
  measure: string;
  /** Whether this column is the value itself or a figure derived from it. */
  sub: 'value' | 'percent' | 'average';
  /** The metric within the group, e.g. "RO COUNT". Empty when the group is the metric. */
  metric: string;
  /** Identity used to pair this column with its counterpart. */
  key: string;
}

const MEASURE_WORDS = ['ACTUAL', 'TRACKING', 'BUDGET', 'VARIANCE', 'FORECAST'];

/**
 * Describe one column in terms of its group, measure, derived-ness and metric.
 *
 * Two different grid shapes have to be handled by the same rule. On the Service
 * screens a group is a pay type and its sub-columns are measures of a single figure
 * (Actual / Tracking / Budget, each with %, Avg.). On the Technician screens a group is
 * a family and its sub-columns are entirely different metrics (RO Count, Labor Sale,
 * ELR). Splitting the chain into measure / derived / metric covers both, and gives a
 * key that pairs "LABOR > RO COUNT" with "LABOR > RO COUNT" while also pairing
 * "TOTAL > ACTUAL" with "TOTAL CP/W/I > ACTUAL > ACTUAL".
 */
export function classifyColumn(chain: string[], group: GroupKey): ClassifiedColumn {
  // Everything below the group heading describes the column.
  const below = chain.filter((h, i) => !(i === 0 && canonicalGroup(h) === group));

  let sub: 'value' | 'percent' | 'average' = 'value';
  let measure = '';
  const metricParts: string[] = [];

  for (const h of below) {
    if (/^%/.test(h)) {
      sub = 'percent';
      continue;
    }
    if (h === 'AVG' || h === 'AVG.' || /^AVERAGE\b/.test(h) || /^AVG\b/.test(h)) {
      sub = 'average';
      continue;
    }
    const asMeasure = MEASURE_WORDS.find((m) => h === m);
    if (asMeasure) {
      // The outermost measure wins; a repeated "ACTUAL" beneath it adds nothing.
      if (!measure) measure = asMeasure;
      continue;
    }
    metricParts.push(h);
  }

  const metric = metricParts.join(' ').trim();
  return {
    index: -1,
    chain,
    group,
    measure,
    sub,
    metric,
    key: `${measure}|${sub}|${metric.replace(/\s+/g, ' ').toUpperCase()}`,
  };
}

/** Every column belonging to a group, classified. */
export function groupColumnsDetailed(geo: GridGeometry, group: GroupKey): ClassifiedColumn[] {
  return geo.columns
    .filter((c) => c.group === group)
    .map((c) => ({ ...classifyColumn(c.chain, group), index: c.index }));
}

/** The value and derived sub-columns belonging to one group. */
export interface GroupColumns {
  value: number | null;
  percent: number | null;
  average: number | null;
  tracking: number | null;
}

/**
 * Locate a group's value, %, Avg. and Tracking columns from the header chains.
 *
 * This replaces the previously hardcoded per-screen offsets, so the derived-column
 * checks work on any grid laid out as group -> measure -> sub-column.
 */
export function groupSubColumns(geo: GridGeometry, group: GroupKey): GroupColumns {
  const cols = geo.columns.filter((c) => c.group === group);
  const chainOf = (c: (typeof cols)[number]) => c.chain.join(' | ');
  const isOtherMeasure = (c: (typeof cols)[number]) =>
    NON_ACTUAL_MEASURES.some((m) => chainOf(c).includes(m));
  const hasMark = (c: (typeof cols)[number], mark: string) =>
    c.chain.some((h) => h === mark || h.startsWith(mark));

  const value = cols.find((c) => c.isPrimaryValue)?.index ?? null;

  const percent =
    cols.find((c) => !isOtherMeasure(c) && hasMark(c, '%'))?.index ?? null;

  const average =
    cols.find((c) => !isOtherMeasure(c) && (hasMark(c, 'AVG') || hasMark(c, 'AVERAGE')))?.index ??
    null;

  // Tracking's own value column: mentions TRACKING but is not its % or Avg. sub-cell.
  const tracking =
    cols.find(
      (c) =>
        chainOf(c).includes('TRACKING') &&
        !hasMark(c, '%') &&
        !hasMark(c, 'AVG') &&
        !hasMark(c, 'AVERAGE'),
    )?.index ?? null;

  return { value, percent, average, tracking };
}
