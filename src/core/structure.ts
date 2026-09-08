/**
 * Work out what each captured table actually is, before any comparison is attempted.
 *
 * Two screens showing the same module rarely publish it the same way. One may show a
 * six-row bucket summary while the other shows a paginated list of individual repair
 * orders; one may run a dimension across its columns while the other runs it down its
 * rows; one may break each row into pay types while the other reports only totals. Those
 * are all differences in *structure*, and mistaking any of them for a difference in data
 * is how a reconciliation report becomes noise.
 *
 * So structure is established first and reported in its own right. Every judgement here
 * carries the evidence it was based on, because a misclassification changes what the whole
 * report means and the reader has to be able to check it.
 *
 * Nothing here is specific to a module. The signals are properties of the table: whether
 * it carries a total row, whether its columns are quantities or descriptions, whether its
 * row labels name metrics or identify records, and whether its row count lands suspiciously
 * exactly on a page boundary.
 */
import { parseCell } from './normalize.js';
import { findGrandTotalRow } from './rows.js';
import type { GridProfile } from './pairing.js';

/** What kind of table this is. */
export type TableRole =
  /** Aggregated figures: metrics, categories or entities, with totals. Comparable row for row. */
  | 'summary'
  /** A listing of individual records — one row per repair order, part, line. */
  | 'detail'
  /** A one-or-two-row KPI strip. Its dimension, if any, runs across the header. */
  | 'strip'
  | 'unknown';

/** What the rows of the table represent. */
export type RowKind = 'metric' | 'entity' | 'category' | 'record' | 'none';

export interface TableStructure {
  /** Index in the capture, so this ties back to the observation table. */
  index: number;
  name: string;
  role: TableRole;
  rowKind: RowKind;
  /** 0..1. Low confidence is itself worth reporting. */
  confidence: number;
  /** Why it was classified this way, in plain terms. */
  evidence: string[];
  bodyRows: number;
  /** Rows that carry a label and at least one value, so are candidates for matching. */
  usableLabels: number;
  numericColumns: number;
  textColumns: number;
  hasTotalRow: boolean;
  totalRowLabel: string | null;
  /** Rows with a label but no values at all — section headings within the grid. */
  sectionRows: number;
  hasBreakdown: boolean;
  segments: string[];
  transposed: boolean;
  /**
   * Set when the row count is exactly a common page size, which is strong evidence the
   * table is one page of a longer list rather than the whole thing.
   */
  pageSize: number | null;
}

/** Row counts that almost always mean "one page of results" rather than "all of them". */
const PAGE_SIZES = [10, 15, 20, 25, 30, 50, 100, 200];

/** Column headings that identify a record rather than measure anything. */
const RECORD_COLUMN = /\bS\.? ?NO\b|\bSR\.? ?NO\b|\bRO ?#|\bINVOICE\b|CUSTOMER INFO|VEHICLE INFO|\bACTIONS?\b|\bNOTES?\b|\bVIN\b|OPEN DATE|\bSTOCK ?#/i;

/** Does this label identify a specific record rather than name a measure or a category? */
function looksLikeRecordLabel(s: string): boolean {
  const t = (s ?? '').trim();
  if (!t) return false;
  // A record identifier characteristically mixes an id with free text, carries a date, or
  // is simply too long to be the name of a metric.
  if (t.length > 28) return true;
  if (/\d/.test(t) && /[A-Za-z]{3,}/.test(t) && /\d{3,}/.test(t)) return true;
  if (/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(t)) return true;
  return false;
}

/** Does this label read like the name of a measure or a category? */
function looksLikeMeasureLabel(s: string): boolean {
  const t = (s ?? '').trim();
  if (!t || t.length > 40) return false;
  if (looksLikeRecordLabel(t)) return false;
  return (t.match(/[A-Za-z]/g) ?? []).length >= 3;
}



/**
 * Classify one profiled table.
 *
 * Scored rather than rule-chained, because no single signal is reliable on its own. A
 * technician grid has entity rows whose labels carry an employee number, which looks
 * record-like; a repair-order listing has a numeric column count comparable to a summary's.
 * Only the combination separates them.
 */
export function classifyTable(profile: GridProfile): TableStructure {
  const rows = profile.table.rows.filter((r) => r.some((c) => (c ?? '').trim()));
  const labelCol = profile.geometry.labelColumn;
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);

  // Columns are quantities or descriptions, judged from the data rather than the heading.
  let numericColumns = 0;
  let textColumns = 0;
  for (let c = 0; c < width; c++) {
    if (c === labelCol) continue;
    let numeric = 0;
    let text = 0;
    for (const r of rows.slice(0, 60)) {
      const v = (r[c] ?? '').trim();
      if (!v) continue;
      if (parseCell(v).value !== null) numeric++;
      else text++;
    }
    if (!numeric && !text) continue; // entirely blank column
    if (numeric >= text) numericColumns++;
    else textColumns++;
  }

  const labels = rows.map((r) => (r[labelCol] ?? '').trim());
  const filledLabels = labels.filter(Boolean);
  const recordish = filledLabels.filter(looksLikeRecordLabel).length;
  const measureish = filledLabels.filter(looksLikeMeasureLabel).length;
  const recordShare = filledLabels.length ? recordish / filledLabels.length : 0;
  const measureShare = filledLabels.length ? measureish / filledLabels.length : 0;

  // Section headings: a label with no values beside it.
  const sectionRows = rows.filter((r) => {
    const l = (r[labelCol] ?? '').trim();
    if (!l) return false;
    return !r.some((c, i) => i !== labelCol && (c ?? '').trim() !== '');
  }).length;

  const totalRow = findGrandTotalRow(profile.normalized);
  const hasTotalRow = Boolean(totalRow);

  const headerText = (profile.table.headerGrid ?? profile.table.headers).flat().join(' ');
  const headerNamesRecords = RECORD_COLUMN.test(headerText);

  const pageSize = PAGE_SIZES.includes(rows.length) ? rows.length : null;

  const evidence: string[] = [];

  // --- a strip is decided on shape alone ---
  if (rows.length <= 2 && profile.dataRows === 0) {
    evidence.push(
      `${rows.length} body row(s) and no row labels, so any dimension it shows runs across its header rather than down its rows.`,
    );
    return {
      index: profile.table.index,
      name: profile.name,
      role: 'strip',
      rowKind: 'none',
      confidence: 0.9,
      evidence,
      bodyRows: rows.length,
      usableLabels: profile.dataRows,
      numericColumns,
      textColumns,
      hasTotalRow,
      totalRowLabel: totalRow?.label ?? null,
      sectionRows,
      hasBreakdown: profile.normalized.hasBreakdown,
      segments: profile.normalized.segments,
      transposed: Boolean(profile.transposedFrom),
      pageSize,
    };
  }

  let detailScore = 0;
  let summaryScore = 0;

  if (pageSize && rows.length >= 10) {
    detailScore += 3;
    evidence.push(
      `Exactly ${pageSize} rows, a standard page size — strong evidence this is one page of a longer list, not the whole set.`,
    );
  }
  if (textColumns >= numericColumns && textColumns > 0) {
    detailScore += 3;
    evidence.push(
      `${textColumns} descriptive column(s) against ${numericColumns} numeric — a listing describes records, a summary measures them.`,
    );
  }
  // Record-like labels only count as evidence of a listing when the table also *describes*
  // its rows. A technician grid labels each row with a name and an employee number, which
  // looks record-like, but every other column is a quantity — it measures technicians, it
  // does not list transactions. Without this gate that grid scored as a record listing on
  // the strength of its labels alone.
  if (recordShare >= 0.6 && textColumns * 2 >= numericColumns) {
    detailScore += 2;
    evidence.push(
      `${Math.round(recordShare * 100)}% of row labels identify an individual record, and the table has ` +
        `${textColumns} descriptive column(s) describing them.`,
    );
  } else if (recordShare >= 0.6) {
    evidence.push(
      `Row labels carry an identifier alongside a name, but the table is otherwise all quantities, ` +
        'so its rows are entities being measured rather than records being listed.',
    );
  }
  if (headerNamesRecords) {
    detailScore += 2;
    evidence.push('Column headings include record identifiers rather than measures.');
  }
  if (!hasTotalRow) detailScore += 1;

  if (hasTotalRow) {
    summaryScore += 3;
    evidence.push(`Carries a total row ("${totalRow!.label}"), which a record listing does not.`);
  }
  if (numericColumns > textColumns * 2) {
    summaryScore += 3;
    evidence.push(`${numericColumns} numeric column(s) against ${textColumns} descriptive — almost entirely quantities.`);
  }
  if (rows.length <= 40) summaryScore += 1;
  if (measureShare >= 0.7) {
    summaryScore += 2;
    evidence.push(`${Math.round(measureShare * 100)}% of row labels name a measure, category or entity.`);
  }
  // A per-entity breakdown with a total for each entity is aggregation by definition. A
  // record listing has nothing to break down — each row is already a single record.
  if (profile.normalized.hasBreakdown) {
    summaryScore += 2;
    evidence.push(
      `Each row is broken down into ${profile.normalized.segments.join('/') || 'segments'} with a total ` +
        'per entity, which is aggregated data rather than a list of records.',
    );
  }

  const isDetail = detailScore >= 5 && detailScore > summaryScore;
  const role: TableRole = isDetail ? 'detail' : summaryScore >= 3 ? 'summary' : 'unknown';

  const spread = Math.abs(detailScore - summaryScore);
  const confidence = Number(Math.min(0.98, 0.5 + spread / 12).toFixed(2));

  const rowKind: RowKind = isDetail
    ? 'record'
    : profile.normalized.hasBreakdown || recordShare > 0.3
      ? 'entity'
      : measureShare >= 0.7
        ? 'metric'
        : 'category';

  if (role === 'unknown') {
    evidence.push(
      'Neither reading fits well. Treated as a summary for comparison, but check the structure below before trusting the result.',
    );
  }

  return {
    index: profile.table.index,
    name: profile.name,
    role,
    rowKind,
    confidence,
    evidence,
    bodyRows: rows.length,
    usableLabels: profile.dataRows,
    numericColumns,
    textColumns,
    hasTotalRow,
    totalRowLabel: totalRow?.label ?? null,
    sectionRows,
    hasBreakdown: profile.normalized.hasBreakdown,
    segments: profile.normalized.segments,
    transposed: Boolean(profile.transposedFrom),
    pageSize,
  };
}

/** Classify every table on one screen. */
export function classifyTables(profiles: GridProfile[]): TableStructure[] {
  return profiles.map(classifyTable);
}
