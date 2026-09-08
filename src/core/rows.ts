/**
 * Row normalization: align rows, recover entity labels, and separate totals from
 * breakdown segments.
 *
 * A screen may express a breakdown as extra rows rather than extra columns. The DMS
 * technician grid gives four rows per technician — Customer Pay, Warranty, Internal and
 * a TOTAL — while AutoGroup gives one row holding the total. Comparing those naively
 * pits a total against a single segment and reports differences everywhere.
 *
 * Two structural quirks have to be handled first:
 *
 *  1. The segment rows are narrower, omitting the leading identity cells (rank, hire
 *     date, name, ...). They are therefore right-aligned to the full width, not left.
 *  2. The entity name appears only on the first row of each group, so it has to be
 *     carried down to the rows beneath it.
 */
import { normalizeLabel } from './match.js';

export interface NormalizedRow {
  /** Cells padded to the table's full width, aligned to the header. */
  cells: string[];
  /** Entity this row belongs to, carried down from the first row of the group. */
  label: string;
  /** Breakdown segment, e.g. "C" / "W" / "I" / "TOTAL". Null when unsegmented. */
  segment: string | null;
  /** True when this row carries the entity's total rather than one segment. */
  isTotal: boolean;
  /** Index in the original table, for tracing back to the capture. */
  sourceIndex: number;
}

export interface NormalizedTable {
  width: number;
  rows: NormalizedRow[];
  labelColumn: number;
  /** Column holding the segment marker, when the grid breaks entities into rows. */
  segmentColumn: number | null;
  /** True when at least one entity is split across several rows. */
  hasBreakdown: boolean;
  /** Distinct breakdown segments, excluding the total marker. */
  segments: string[];
  /** How the structure was resolved, for the report. */
  notes: string[];
}

const TOTAL_WORDS = new Set(['TOTAL', 'TOTALS', 'GRAND TOTAL', 'SUBTOTAL', 'SUB TOTAL', 'ALL']);

/**
 * Words that can begin a *grand* total row. Subtotals are excluded on purpose: a subtotal
 * covers part of the grid, so treating it as the whole would understate every check made
 * against it.
 */
const GRAND_TOTAL_WORDS = new Set(['TOTAL', 'TOTALS', 'GRAND TOTAL', 'ALL', 'OVERALL', 'SUM']);

function looksLikeEntityLabel(s: string): boolean {
  const t = (s ?? '').trim();
  if (!t) return false;
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(t)) return false; // a date
  if (/^[-+(]?[$€£]?\s?[\d,]+(\.\d+)?\s?[%)]?$/.test(t)) return false; // a number
  return ((t.match(/[A-Za-z]/g) ?? []).length) >= 2;
}

/** Is this cell a total marker such as "TOTAL"? */
function isTotalMarker(s: string): boolean {
  const t = normalizeLabel(s);
  return TOTAL_WORDS.has(t);
}

export function normalizeTable(rows: string[][]): NormalizedTable {
  const notes: string[] = [];
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);

  // 1. Right-align narrow rows. A row that omits leading identity cells still lines up
  //    on its right-hand edge, so padding the front restores the header alignment.
  const padded = rows.map((r, i) => {
    const pad = width - r.length;
    return {
      cells: pad > 0 ? [...Array<string>(pad).fill(''), ...r] : [...r],
      sourceIndex: i,
      wasPadded: pad > 0,
    };
  });
  const paddedCount = padded.filter((p) => p.wasPadded).length;
  if (paddedCount) {
    notes.push(
      `${paddedCount} row(s) were narrower than the widest and were right-aligned, ` +
        'on the basis that they omit leading identity cells rather than trailing values.',
    );
  }

  // 2. Label column.
  //
  // Counting entity-like cells is not enough. A segment column is entity-like too when
  // the screen spells its segments out — a grid marking rows "Customer Pay" / "Warranty"
  // / "Internal" has text in every row of that column, while the name column is filled
  // only on each group's first row. Counting hits therefore picks the segment column,
  // and every row then gets labelled with its pay type instead of its technician.
  //
  // What separates the two is repetition: a label column's values are near-unique, a
  // segment column cycles through a handful of values. So score on distinctness, having
  // first required a column to carry a reasonable share of the distinct values on offer,
  // which stops a column filled on a single row from winning on a perfect ratio.
  const candidates = [];
  for (let c = 0; c < Math.min(width, 10); c++) {
    const values = padded.map((p) => (p.cells[c] ?? '').trim()).filter(looksLikeEntityLabel);
    if (!values.length) continue;
    const distinct = new Set(values.map((v) => v.toUpperCase())).size;
    candidates.push({ index: c, distinct, filled: values.length, ratio: distinct / values.length });
  }

  let labelColumn = 0;
  if (candidates.length) {
    const maxDistinct = candidates.reduce((m, c) => Math.max(m, c.distinct), 0);
    const viable = candidates.filter((c) => c.distinct >= maxDistinct * 0.5);
    viable.sort((a, b) => b.ratio - a.ratio || b.distinct - a.distinct || a.index - b.index);
    labelColumn = viable[0]!.index;
    const chosen = viable[0]!;
    if (candidates.length > 1) {
      notes.push(
        `Label column resolved to index ${labelColumn}: ${chosen.distinct} distinct value(s) across ` +
          `${chosen.filled} labelled cell(s). Columns that repeat a small set of values were rejected ` +
          'as breakdown markers rather than labels.',
      );
    }
  }

  // 3. Carry the entity label down through its group.
  let current = '';
  const withLabels = padded.map((p) => {
    const raw = (p.cells[labelColumn] ?? '').trim();
    if (looksLikeEntityLabel(raw)) current = raw;
    return { ...p, label: current };
  });

  // 4. Does any entity span several rows? Only then is a segment column meaningful —
  //    this gate stops a metric grid, whose rows are already distinct, from being
  //    misread as a breakdown just because one row happens to be called "TOTAL".
  const perEntity = new Map<string, number>();
  for (const r of withLabels) {
    if (!r.label) continue;
    perEntity.set(r.label, (perEntity.get(r.label) ?? 0) + 1);
  }
  const hasBreakdown = [...perEntity.values()].some((n) => n > 1);

  let segmentColumn: number | null = null;
  if (hasBreakdown) {
    // The segment column is a short, low-cardinality text column that includes a total
    // marker for at least one row.
    let bestScore = 0;
    for (let c = 0; c < Math.min(width, 10); c++) {
      if (c === labelColumn) continue;
      const values = withLabels
        .map((r) => (r.cells[c] ?? '').trim())
        .filter(Boolean);
      if (!values.length) continue;
      if (values.some((v) => v.length > 14)) continue;
      const distinct = new Set(values.map((v) => v.toUpperCase()));
      if (distinct.size > 8) continue;
      if (![...distinct].some((v) => isTotalMarker(v))) continue;
      // Prefer the column that marks a total for the most entities.
      const totals = values.filter((v) => isTotalMarker(v)).length;
      if (totals > bestScore) {
        bestScore = totals;
        segmentColumn = c;
      }
    }
  }

  const out: NormalizedRow[] = withLabels.map((r) => {
    const seg = segmentColumn !== null ? (r.cells[segmentColumn] ?? '').trim() : null;
    const total = segmentColumn === null ? true : isTotalMarker(seg ?? '');
    return {
      cells: r.cells,
      label: r.label,
      segment: seg || null,
      isTotal: total,
      sourceIndex: r.sourceIndex,
    };
  });

  const segments = [
    ...new Set(
      out
        .filter((r) => !r.isTotal && r.segment)
        .map((r) => r.segment!.toUpperCase()),
    ),
  ];

  if (segmentColumn !== null) {
    notes.push(
      `Rows are broken down by column ${segmentColumn} into ${segments.join(', ') || 'segments'}, ` +
        `with a total row per entity. Totals are used for comparison and the segments are ` +
        'reported as breakdown detail.',
    );
  } else if (hasBreakdown) {
    notes.push(
      'Some entities span several rows but no total row could be identified, so each row ' +
        'is treated on its own. Comparisons against a screen that totals may differ.',
    );
  }

  return {
    width,
    rows: out,
    labelColumn,
    segmentColumn,
    hasBreakdown: segmentColumn !== null,
    segments,
    notes,
  };
}

/**
 * Canonical name for a breakdown segment.
 *
 * The two products abbreviate pay types differently — DMS marks a row "C" / "W" / "I"
 * while AutoGroup writes "Customer Pay" / "Warranty" / "Internal". Segment rows can only
 * be compared individually if those resolve to the same key first. Anything unrecognised
 * falls through to its normalized label, so a module with its own segment vocabulary
 * still matches itself across the two screens.
 */
export function canonicalSegment(s: string): string {
  const t = normalizeLabel(s);
  if (!t) return '';
  if (/^(C|CP|CUST|CUSTOMER|CUSTOMER PAY|CUSTOMERPAY|PAY)$/.test(t)) return 'CUSTOMER PAY';
  if (/^(W|WAR|WARR|WARRANTY)$/.test(t)) return 'WARRANTY';
  if (/^(I|INT|INTERNAL)$/.test(t)) return 'INTERNAL';
  if (/^(S|SUB|SUBLET)$/.test(t)) return 'SUBLET';
  return t;
}

/**
 * Readable list of segment markers for the report.
 *
 * A grid that marks its segments "C" / "W" / "I" tells the reader nothing on its own, so
 * the expanded name is shown alongside where it is known.
 */
export function describeSegments(segments: string[]): string {
  return segments
    .map((s) => {
      const canon = canonicalSegment(s);
      const shown = s.trim();
      return canon && canon !== shown.toUpperCase() ? `${shown} (${canon})` : shown;
    })
    .filter(Boolean)
    .join(' / ');
}

/**
 * The grid's grand-total row, if it has one.
 *
 * "Starts with a total word" is far too loose. The Service Summary grid contains
 * TOTAL L&P SALES, TOTAL L&P GROSS and TOTAL L&P COST as ordinary metric rows, and treating
 * the first of them as the grand total would attach every whole-grid check to an arbitrary
 * subtotal.
 *
 * What separates a real grand total is that its wording adds nothing but the subject of the
 * grid. "ALL OPEN ROS" is the total of a grid whose other rows are aging buckets — none of
 * them mentions open ROs. "TOTAL L&P SALES" sits among rows called LABOR SALES and
 * PARTS SALES, which share its vocabulary, marking it as one metric among peers. So a
 * candidate qualifies only when its words, aside from the total marker itself, appear in no
 * other row's label.
 */
export function findGrandTotalRow(t: NormalizedTable): NormalizedRow | null {
  const rows = comparableRows(t);
  if (!rows.length) return null;

  const candidates = rows.filter((r) => {
    const norm = normalizeLabel(r.label);
    const first = norm.split(' ')[0] ?? '';
    return GRAND_TOTAL_WORDS.has(first) || GRAND_TOTAL_WORDS.has(norm);
  });
  if (!candidates.length) return null;

  for (const c of candidates) {
    const tokens = normalizeLabel(c.label)
      .split(' ')
      .filter((w) => w && !GRAND_TOTAL_WORDS.has(w) && w.length > 1);

    // A bare marker is unambiguous.
    if (!tokens.length) return c;

    const othersVocabulary = new Set(
      rows
        .filter((r) => r !== c)
        .flatMap((r) => normalizeLabel(r.label).split(' '))
        .filter((w) => w.length > 1),
    );
    if (!tokens.some((t2) => othersVocabulary.has(t2))) return c;
  }

  return null;
}

/** Rows to compare: the totals when a breakdown exists, otherwise every data row. */
export function comparableRows(t: NormalizedTable): NormalizedRow[] {
  return t.rows.filter((r) => r.isTotal && r.label);
}

/** Breakdown rows grouped by entity, for reporting what the other side lacks. */
export function breakdownByEntity(t: NormalizedTable): Map<string, NormalizedRow[]> {
  const map = new Map<string, NormalizedRow[]>();
  for (const r of t.rows) {
    if (r.isTotal || !r.label) continue;
    if (!map.has(r.label)) map.set(r.label, []);
    map.get(r.label)!.push(r);
  }
  return map;
}
