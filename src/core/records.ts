/**
 * Compare two record listings against each other, record by record.
 *
 * Some modules publish no summary at all. The Closed RO screens are a listing of individual
 * repair orders on both sides — same records, same order, and fourteen columns in common —
 * yet none of it was compared, because the engine only knew how to reconcile summaries: it
 * matched rows by *label*, and a listing's rows are identified by a record number, not a
 * metric name. So the two grids never paired and the module was written off as
 * uncomparable while nearly all of it was directly comparable.
 *
 * This compares them properly:
 *
 *  - Records are matched on a key column discovered from the data, not assumed. The key is
 *    the column whose values are near-unique on both sides and largely shared between them,
 *    which on these screens is the RO number.
 *  - Every column that pairs is compared, text as well as numeric. Customer, vehicle,
 *    advisor and technician are exactly the fields that expose two systems disagreeing about
 *    which record is which, and dropping them because they are not numbers left the most
 *    telling columns unchecked.
 *  - Records visible on only one side are reported separately from value differences. Both
 *    listings paginate, so a record absent from the other side's current page is a display
 *    limit, not a missing record.
 */
import {
  compareTexts,
  compareValues,
  isBlankText,
  normalizeText,
  parseCell,
  precisionTolerance,
  round,
  type Verdict,
} from './normalize.js';
import { inferKind, normalizeLabel, similarity } from './match.js';
import type { GridProfile } from './pairing.js';

/** A column present on both listings. */
export interface RecordColumnPair {
  name: string;
  rightName: string;
  leftIndex: number;
  rightIndex: number;
  /** How the column's values are compared. */
  kind: 'numeric' | 'text';
  matchedBy: 'exact' | 'fuzzy';
  confidence: number;
}

/**
 * How a cell's contents were compared.
 *
 * A listing cell is often not a single value. The two screens pack these columns
 * differently: where AutoGroup gives one aggregated "$23.09 / $42.98" for parts, DMS itemises
 * every part as its own cost/sale pair; where AutoGroup names a technician, DMS appends that
 * technician's cost and sale to the same cell. Comparing those as plain strings reports a
 * difference on every row and tells you nothing. So the comparable content is extracted
 * first, and which extraction was used is recorded — because "the totals agree but the two
 * screens itemise differently" and "the totals disagree" are entirely different findings.
 */
export type CellStrategy =
  /** Compared as a single number. */
  | 'value'
  /** Both sides hold "cost / sale" pairs; the two columns of figures are summed and compared. */
  | 'pairs'
  /** Both sides hold several numbers; their totals are compared. */
  | 'totals'
  /**
   * The two screens put different things in this column — one a set of counts, the other a
   * set of amounts — so only the leading figure is comparable.
   */
  | 'leading'
  /** Compared on identifying words and codes, ignoring amounts and pay-type annotations. */
  | 'content'
  /** Compared as plain text. */
  | 'text';

/** One column of one record, compared. */
export interface RecordCell {
  column: string;
  kind: 'numeric' | 'text';
  left: string;
  right: string;
  strategy: CellStrategy;
  delta: number | null;
  tolerance: number | null;
  /** For text columns, how alike the two values are. */
  similarity: number | null;
  /** Agreed only once formatting, rounding or itemisation was allowed for. */
  formattingOnly: boolean;
  /**
   * Set when the two screens compose this cell differently — one itemising where the other
   * aggregates, or one appending figures to a name. Reported so a presentational difference
   * is not read as a data difference.
   */
  composition: string | null;
  /**
   * Set when this cell agreed only because a declared definitional difference was allowed
   * for, carrying the stated reason. Kept distinct from `formattingOnly`, which is about
   * presentation; this is about the two products measuring different things on purpose.
   */
  definitional?: string | null;
  verdict: Verdict;
}

export interface RecordOutcome {
  key: string;
  cells: RecordCell[];
  passed: boolean;
}

export interface RecordComparison {
  /** Column used to match records, and why it was chosen. */
  keyColumn: { left: string; right: string; reason: string };
  columnPairs: RecordColumnPair[];
  unpairedLeft: string[];
  unpairedRight: string[];
  records: RecordOutcome[];
  /** Records on one listing with no counterpart on the other. */
  onlyOnLeft: string[];
  onlyOnRight: string[];
  summary: {
    recordsCompared: number;
    totalCells: number;
    matched: number;
    /** Of `matched`, how many agreed only after allowing for formatting or rounding. */
    formattingOnly: number;
    /**
     * Of `matched`, how many agreed only because a declared definitional difference was
     * allowed for. Reported separately so an adjustment is never invisible.
     */
    definitional: number;
    mismatched: number;
    missing: number;
    numericCells: number;
    textCells: number;
  };
  note: string;
}

/** Every number in a cell, in order. */
function extractNumbers(raw: string): number[] {
  const out: number[] = [];
  for (const m of (raw ?? '').matchAll(/-?\$?\s?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/[$,\s]/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * "cost / sale" pairs in a cell.
 *
 * Both screens use this shape for op codes, parts and labour; DMS repeats it per item where
 * AutoGroup gives one aggregate. Summing each side of the slash lets the two be compared
 * without pretending the itemisation matches.
 */
function extractPairs(raw: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of (raw ?? '').matchAll(
    /(-?\$?\s?\d[\d,]*(?:\.\d+)?)\s*\/\s*(-?\$?\s?\d[\d,]*(?:\.\d+)?)/g,
  )) {
    const a = Number(m[1]!.replace(/[$,\s]/g, ''));
    const b = Number(m[2]!.replace(/[$,\s]/g, ''));
    if (Number.isFinite(a) && Number.isFinite(b)) out.push([a, b]);
  }
  return out;
}

/**
 * Words that annotate rather than identify.
 *
 * DMS labels each figure with what it is ("COST: $12.00 SALE: $44.00") and each op code with
 * its pay type ("(CP)", "(I)"). Those are captions on the same underlying content, so they
 * are removed before the identifying words are compared. Pay-type letters are single
 * characters and already dropped by the token filter.
 */
const ANNOTATION_WORDS = new Set([
  'COST', 'SALE', 'SALES', 'CP', 'CW', 'WI', 'MORE', 'QTY', 'EA', 'TOTAL',
]);

/**
 * The identifying words and codes in a cell: names, part numbers, op codes.
 *
 * Amounts and bare quantities are dropped, because those are what the two screens differ on
 * presentationally, and the annotation words above are dropped with them.
 */
function contentTokens(raw: string): Set<string> {
  const out = new Set<string>();
  for (const t of normalizeText(raw).split(' ')) {
    if (t.length < 2) continue;
    // A currency symbol survives normalizeText, so "$12.00" arrives as "$12" — which is
    // neither a bare number nor a word, and was being kept as though it identified
    // something. It is an amount, and amounts are exactly what these two screens format
    // differently.
    if (/[$€£]/.test(t)) continue;
    if (/^\d+$/.test(t)) continue; // a bare number is a quantity or an amount
    if (/^\d[\d.]*$/.test(t)) continue;
    if (ANNOTATION_WORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** Does the cell carry money? Used to spot two screens composing a column differently. */
function hasCurrency(raw: string): boolean {
  return /[$€£]/.test(raw ?? '');
}

/** Does the cell admit to hiding entries, e.g. AutoGroup's "+3 MORE" link? */
function truncationNote(raw: string): string | null {
  const m = /\+\s*(\d+)\s*MORE/i.exec(raw ?? '');
  return m ? `${m[1]} further entr${m[1] === '1' ? 'y' : 'ies'} hidden behind a "+${m[1]} more" link` : null;
}

/** Is `a` contained in `b`? */
function isSubset(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || a.size > b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

function setSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return Number(((2 * shared) / (a.size + b.size)).toFixed(3));
}

/** Header names of a listing, taken from its deepest header row. */
function headerNames(profile: GridProfile): string[] {
  const grid = profile.table.headerGrid ?? profile.table.headers;
  const deepest = grid.at(-1) ?? [];
  const width = profile.table.rows.reduce((m, r) => Math.max(m, r.length), 0);
  const out: string[] = [];
  for (let i = 0; i < Math.max(width, deepest.length); i++) {
    out.push((deepest[i] ?? '').trim());
  }
  return out;
}

/** Is this column mostly numbers? */
function columnIsNumeric(rows: string[][], index: number): boolean {
  let numeric = 0;
  let text = 0;
  for (const r of rows) {
    const v = (r[index] ?? '').trim();
    if (!v) continue;
    if (parseCell(v).value !== null) numeric++;
    else text++;
  }
  return numeric > text;
}

/**
 * The values of one column, as a set of normalized keys.
 *
 * A record key is compared on its leading identifier: one screen renders the RO cell as
 * "238977 OPEN: 09/05/2026" and the other as "238977 CLOSE DATE: 09/05/2026", so the whole
 * cell never matches while the number always does.
 */
function keyOf(raw: string): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  const leading = /^[#\s]*([A-Za-z]*\d[\w-]*)/.exec(t);
  return (leading?.[1] ?? t.split(/\s+/)[0] ?? t).toUpperCase();
}

/**
 * Find the column that identifies a record.
 *
 * Scored, not assumed: the key is the column whose values are near-unique within each
 * listing and largely shared between the two. Near-uniqueness rules out a department or an
 * advisor, which repeat; the shared requirement rules out a per-page row number, which is
 * unique on both sides and identical by coincidence rather than because it identifies
 * anything.
 */
function findKeyColumn(
  left: GridProfile,
  right: GridProfile,
  leftHeaders: string[],
  rightHeaders: string[],
): { leftIndex: number; rightIndex: number; reason: string } | null {
  const lRows = left.table.rows;
  const rRows = right.table.rows;
  if (!lRows.length || !rRows.length) return null;

  interface Candidate {
    li: number;
    ri: number;
    shared: number;
    score: number;
    reason: string;
  }
  const candidates: Candidate[] = [];

  const keysFor = (rows: string[][], index: number) =>
    rows.map((r) => keyOf(r[index] ?? '')).filter(Boolean);

  for (let li = 0; li < leftHeaders.length; li++) {
    const lKeys = keysFor(lRows, li);
    if (lKeys.length < Math.max(3, lRows.length * 0.8)) continue;
    const lDistinct = new Set(lKeys);
    // Near-unique within the listing, or it does not identify a record.
    if (lDistinct.size < lKeys.length * 0.9) continue;

    for (let ri = 0; ri < rightHeaders.length; ri++) {
      const rKeys = keysFor(rRows, ri);
      if (rKeys.length < Math.max(3, rRows.length * 0.8)) continue;
      const rDistinct = new Set(rKeys);
      if (rDistinct.size < rKeys.length * 0.9) continue;

      let shared = 0;
      for (const k of lDistinct) if (rDistinct.has(k)) shared++;
      if (shared < 3) continue;

      const overlap = shared / Math.min(lDistinct.size, rDistinct.size);
      // A header name that matches is supporting evidence, not the deciding factor.
      const nameScore = similarity(
        normalizeLabel(leftHeaders[li] ?? ''),
        normalizeLabel(rightHeaders[ri] ?? ''),
      );
      // Values that look like identifiers rather than a 1..n sequence.
      const looksSequential = [...lDistinct].every((k) => /^\d{1,3}$/.test(k));
      const idBonus = looksSequential ? 0 : 0.3;

      candidates.push({
        li,
        ri,
        shared,
        score: overlap + nameScore * 0.2 + idBonus,
        reason:
          `"${leftHeaders[li] || `column ${li}`}" on the left and "${rightHeaders[ri] || `column ${ri}`}" ` +
          `on the right share ${shared} near-unique value(s) ` +
          `(${Math.round(overlap * 100)}% of the smaller set)` +
          (looksSequential
            ? ', though these look like row numbers rather than record identifiers'
            : ''),
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.shared - a.shared);
  const best = candidates[0]!;
  return { leftIndex: best.li, rightIndex: best.ri, reason: best.reason };
}

/** Pair the columns of two listings by header name. */
function pairColumns(
  left: GridProfile,
  right: GridProfile,
  leftHeaders: string[],
  rightHeaders: string[],
  skip: { left: number; right: number },
): { pairs: RecordColumnPair[]; unpairedLeft: string[]; unpairedRight: string[] } {
  const pairs: RecordColumnPair[] = [];
  const usedRight = new Set<number>();
  const unpairedLeft: string[] = [];

  const lNumeric = leftHeaders.map((_, i) => columnIsNumeric(left.table.rows, i));
  const rNumeric = rightHeaders.map((_, i) => columnIsNumeric(right.table.rows, i));

  const populated = (rows: string[][], i: number) =>
    rows.some((r) => (r[i] ?? '').trim() !== '');

  for (let li = 0; li < leftHeaders.length; li++) {
    const name = leftHeaders[li]!;
    if (!name || li === skip.left) continue;
    if (!populated(left.table.rows, li)) continue;

    const ln = normalizeLabel(name);
    let ri = rightHeaders.findIndex(
      (h, i) => h && !usedRight.has(i) && i !== skip.right && normalizeLabel(h) === ln,
    );
    let matchedBy: 'exact' | 'fuzzy' = 'exact';
    let confidence = 1;

    if (ri === -1) {
      let best: { i: number; score: number } | null = null;
      for (let i = 0; i < rightHeaders.length; i++) {
        const h = rightHeaders[i];
        if (!h || usedRight.has(i) || i === skip.right) continue;
        // A text column and a numeric column are not the same measure however alike
        // their headings read.
        if (lNumeric[li] !== rNumeric[i]) continue;
        const score = similarity(ln, normalizeLabel(h));
        if (!best || score > best.score) best = { i, score };
      }
      if (best && best.score >= 0.6) {
        ri = best.i;
        matchedBy = 'fuzzy';
        confidence = Number(best.score.toFixed(3));
      }
    }

    if (ri === -1) {
      unpairedLeft.push(name);
      continue;
    }

    usedRight.add(ri);
    pairs.push({
      name,
      rightName: rightHeaders[ri]!,
      leftIndex: li,
      rightIndex: ri,
      kind: lNumeric[li] ? 'numeric' : 'text',
      matchedBy,
      confidence,
    });
  }

  const unpairedRight = rightHeaders
    .map((h, i) => ({ h, i }))
    .filter(
      ({ h, i }) =>
        h && !usedRight.has(i) && i !== skip.right && populated(right.table.rows, i),
    )
    .map(({ h }) => h);

  return { pairs, unpairedLeft, unpairedRight };
}

/**
 * Compare one column of one record, choosing the comparison from what the cells hold.
 *
 * Ordered from most specific to least, so the most informative comparison available is the
 * one used. A cell holding cost/sale pairs is compared on its two totals; a cell holding a
 * list of figures on its total; a cell holding names or codes on those, with amounts and
 * annotations set aside; and only a plain cell as plain text.
 */
function compareCell(
  cp: RecordColumnPair,
  leftRow: string[],
  rightRow: string[],
  adjust?: { leftMinusRight: number; reason: string },
): RecordCell {
  const lRaw = (leftRow[cp.leftIndex] ?? '').trim();
  const rRaw = (rightRow[cp.rightIndex] ?? '').trim();

  const base = {
    column: cp.name,
    kind: cp.kind,
    left: lRaw,
    right: rRaw,
  };

  /**
   * A column the module declares as differing by a fixed amount by definition.
   *
   * Checked first and on its own, because the point is to verify the stated relationship
   * rather than to excuse the column. AutoGroup's deal age counts the current day where
   * DMS's does not, so its figure is one higher for the same deal — every time, across 43
   * deals and 11 deal dates. Comparing the two raw would report 43 differences that are
   * not differences; ignoring the column would stop anyone noticing if the relationship
   * changed. So the difference is subtracted and the result compared, and a cell that
   * fails is still a mismatch.
   */
  if (adjust && lRaw && rRaw) {
    const lv = parseCell(lRaw);
    const rv = parseCell(rRaw);
    if (lv.value !== null && rv.value !== null) {
      const delta = round(rv.value - (lv.value - adjust.leftMinusRight), 4);
      const ok = Math.abs(delta) <= 0.02;
      return {
        ...base,
        strategy: 'value',
        delta,
        tolerance: 0.02,
        similarity: null,
        formattingOnly: false,
        composition: null,
        definitional: ok
          ? adjust.reason
          : `Declared to differ by ${adjust.leftMinusRight} (${adjust.reason}), but this record ` +
            `differs by ${round(lv.value - rv.value, 4)} instead.`,
        verdict: ok ? 'match' : 'mismatch',
      };
    }
  }

  // Emptiness is judged the same way here as in compareTexts, including a placeholder dash.
  // These guards run before any comparison, so a narrower notion of "empty" at this point
  // would quietly override the one used everywhere else.
  if (isBlankText(lRaw) && isBlankText(rRaw)) {
    return { ...base, strategy: 'text', delta: null, tolerance: null, similarity: 1, formattingOnly: lRaw !== rRaw, composition: null, verdict: 'match' };
  }
  if (isBlankText(lRaw)) {
    return { ...base, strategy: 'text', delta: null, tolerance: null, similarity: 0, formattingOnly: false, composition: null, verdict: 'missing-left' };
  }
  if (isBlankText(rRaw)) {
    return { ...base, strategy: 'text', delta: null, tolerance: null, similarity: 0, formattingOnly: false, composition: null, verdict: 'missing-right' };
  }

  const lPairs = extractPairs(lRaw);
  const rPairs = extractPairs(rRaw);
  const lNumsAll = extractNumbers(lRaw);
  const rNumsAll = extractNumbers(rRaw);

  /**
   * --- one screen counts where the other prices ---
   *
   * The Closed RO line column reads "3 CP 2 · W 0 · I 1" on one screen and
   * "3 CP: $35.09 / $84.97 I: $0.00 / $0.00" on the other: the same line count, then a
   * per-pay-type breakdown by count on one side and by amount on the other. Summing all the
   * figures compares three lines against ninety dollars. The only comparable figure is the
   * leading count, and the rest is a difference in what each screen chooses to show.
   */
  if (hasCurrency(lRaw) !== hasCurrency(rRaw) && lNumsAll.length && rNumsAll.length) {
    const l0 = lNumsAll[0]!;
    const r0 = rNumsAll[0]!;
    const delta = Number((r0 - l0).toFixed(4));
    const ok = Math.abs(delta) <= 0.005;
    const moneySide = hasCurrency(lRaw) ? 'the first' : 'the second';
    return {
      ...base,
      strategy: 'leading',
      delta,
      tolerance: 0.005,
      similarity: null,
      formattingOnly: ok,
      composition:
        `The two screens compose this column differently: ${moneySide} screen breaks it down by ` +
        `amount where the other breaks it down by count. Only the leading figure is comparable, ` +
        `and it is what has been compared. The breakdown beside it cannot be reconciled because ` +
        `the two screens are not showing the same quantity.`,
      verdict: ok ? 'match' : 'mismatch',
    };
  }

  /**
   * --- a single figure against one cost/sale pair ---
   *
   * DMS renders "TOTAL SALE" as "$35.09 / $84.97" — cost then sale — while AutoGroup renders
   * the sale alone. Adding the pair together and comparing that to the single figure compares
   * a sale against a sale plus a cost. The column is named for the sale, so the sale is what
   * is compared; the assumption is stated, because if it is wrong the reader has to be able to
   * see that it was made.
   */
  if (!lPairs.length && rPairs.length === 1 && lNumsAll.length === 1) {
    const sale = rPairs[0]![1];
    const delta = Number((sale - lNumsAll[0]!).toFixed(4));
    const ok = Math.abs(delta) <= 0.02;
    return {
      ...base,
      strategy: 'value',
      delta,
      tolerance: 0.02,
      similarity: null,
      formattingOnly: false,
      composition:
        `${base.column} is a single figure on one screen and a "cost / sale" pair on the other. ` +
        `The sale side of the pair has been compared, since that is what the column is named for.`,
      verdict: ok ? 'match' : 'mismatch',
    };
  }

  // --- cost/sale pairs on both sides: compare the two totals ---
  if (lPairs.length && rPairs.length) {
    const sum = (ps: Array<[number, number]>, i: 0 | 1) => ps.reduce((a, p) => a + p[i], 0);
    const lFirst = sum(lPairs, 0);
    const rFirst = sum(rPairs, 0);
    const lSecond = sum(lPairs, 1);
    const rSecond = sum(rPairs, 1);
    const tol = 0.02; // two totals of two-decimal figures
    const dFirst = Number((rFirst - lFirst).toFixed(4));
    const dSecond = Number((rSecond - lSecond).toFixed(4));
    const ok = Math.abs(dFirst) <= tol && Math.abs(dSecond) <= tol;
    const itemised = lPairs.length !== rPairs.length;

    return {
      ...base,
      strategy: 'pairs',
      // Report the larger discrepancy of the two.
      delta: Math.abs(dSecond) >= Math.abs(dFirst) ? dSecond : dFirst,
      tolerance: tol,
      similarity: null,
      formattingOnly: ok && itemised,
      composition: itemised
        ? `One screen itemises this column and the other aggregates it: ${lPairs.length} pair(s) ` +
          `against ${rPairs.length}. The totals are compared instead of the individual entries.`
        : null,
      verdict: ok ? 'match' : 'mismatch',
    };
  }

  // --- several figures on both sides: compare the totals ---
  const lNums = extractNumbers(lRaw);
  const rNums = extractNumbers(rRaw);
  if ((lNums.length > 1 || rNums.length > 1) && lNums.length && rNums.length) {
    const lSum = Number(lNums.reduce((a, b) => a + b, 0).toFixed(4));
    const rSum = Number(rNums.reduce((a, b) => a + b, 0).toFixed(4));
    const delta = Number((rSum - lSum).toFixed(4));
    const tol = 0.02;
    const ok = Math.abs(delta) <= tol;
    const counts = lNums.length !== rNums.length;

    // Only trust a total-to-total comparison when the cell is really a list of figures.
    // Otherwise fall through to comparing the words.
    if (ok || !contentTokens(lRaw).size) {
      return {
        ...base,
        strategy: 'totals',
        delta,
        tolerance: tol,
        similarity: null,
        formattingOnly: ok && counts,
        composition: counts
          ? `The two screens list a different number of figures here (${lNums.length} against ` +
            `${rNums.length}), so their totals are compared rather than the entries.`
          : null,
        verdict: ok ? 'match' : 'mismatch',
      };
    }
  }

  // --- names and codes: compare identity, ignoring amounts and annotations ---
  const lTokens = contentTokens(lRaw);
  const rTokens = contentTokens(rRaw);
  if (lTokens.size && rTokens.size) {
    const score = setSimilarity(lTokens, rTokens);
    const exact = lTokens.size === rTokens.size && score === 1;
    const annotated = normalizeText(lRaw) !== normalizeText(rRaw);

    /**
     * One side listing fewer entries than the other, with every entry it does list present
     * on the other, is a shorter rendering of the same content — not different content. Two
     * causes, both presentational: a list truncated behind a "+3 more" link, and an
     * abbreviated description ("2021 HONDA CR-V" for "2021 HONDA CR-V EX-L"). Reporting
     * those as disagreements about the record would be wrong, so a subset counts as a match
     * and says which side is the shorter.
     */
    const leftInRight = isSubset(lTokens, rTokens);
    const rightInLeft = isSubset(rTokens, lTokens);
    const truncation = truncationNote(lRaw) ?? truncationNote(rRaw);

    if ((leftInRight || rightInLeft) && !exact) {
      const shortSide = leftInRight ? 'first' : 'second';
      return {
        ...base,
        strategy: 'content',
        delta: null,
        tolerance: null,
        similarity: score,
        formattingOnly: true,
        composition:
          `Everything the ${shortSide} screen shows here also appears on the other, which shows ` +
          `more. ` +
          (truncation
            ? `That screen has ${truncation}, so this is a display limit rather than missing data.`
            : `The shorter rendering is an abbreviation of the same content, not a different value.`),
        verdict: 'match',
      };
    }

    return {
      ...base,
      strategy: 'content',
      delta: null,
      tolerance: null,
      similarity: score,
      formattingOnly: score >= 0.8 && !exact,
      composition:
        score >= 0.8 && annotated
          ? 'The same names or codes appear on both screens; one of them adds figures or ' +
            'pay-type annotations to the same cell.'
          : truncation
            ? `One screen has ${truncation}, so the two lists may differ only in what is on show.`
            : null,
      verdict: score >= 0.8 ? 'match' : 'mismatch',
    };
  }

  // --- a single value ---
  if (cp.kind === 'numeric' || (lNums.length === 1 && rNums.length === 1)) {
    const lv = parseCell(lRaw);
    const rv = parseCell(rRaw);
    if (lv.value !== null && rv.value !== null) {
      const kind = inferKind(cp.name, lv.raw || rv.raw);
      const tolerance = precisionTolerance(lv.raw, rv.raw, kind);
      const cmp = compareValues(lv, rv, tolerance);
      return {
        ...base,
        strategy: 'value',
        delta: cmp.delta,
        tolerance,
        similarity: null,
        formattingOnly: cmp.roundedMatch,
        composition: null,
        verdict: cmp.verdict,
      };
    }
  }

  const cmp = compareTexts(lRaw, rRaw);
  return {
    ...base,
    strategy: 'text',
    delta: null,
    tolerance: null,
    similarity: cmp.similarity,
    formattingOnly: cmp.formattingOnly,
    composition: null,
    verdict: cmp.verdict,
  };
}

export function compareRecords(
  left: GridProfile,
  right: GridProfile,
  sides: {
    leftLabel: string;
    rightLabel: string;
    /** Columns the module declares as differing by a fixed amount by definition. */
    recordColumns?: Record<string, { leftMinusRight: number; reason: string }>;
  },
): RecordComparison | null {
  const leftHeaders = headerNames(left);
  const rightHeaders = headerNames(right);

  const key = findKeyColumn(left, right, leftHeaders, rightHeaders);
  if (!key) return null;

  const { pairs, unpairedLeft, unpairedRight } = pairColumns(left, right, leftHeaders, rightHeaders, {
    left: key.leftIndex,
    right: key.rightIndex,
  });
  if (!pairs.length) return null;

  // Index the right listing by record key.
  const rightByKey = new Map<string, string[]>();
  for (const row of right.table.rows) {
    const k = keyOf(row[key.rightIndex] ?? '');
    if (k && !rightByKey.has(k)) rightByKey.set(k, row);
  }

  /**
   * Declared definitional differences, resolved per column pair.
   *
   * Matched on the normalized heading from either screen, so the declaration works whichever
   * name the module author had in front of them — "AGE (DAYS)" on one screen and plain "AGE"
   * on the other are the same column.
   */
  const declared = new Map(
    Object.entries(sides.recordColumns ?? {}).map(([k, v]) => [normalizeLabel(k), v]),
  );
  const adjustFor = (cp: RecordColumnPair) =>
    declared.get(normalizeLabel(cp.name)) ?? declared.get(normalizeLabel(cp.rightName)) ?? undefined;

  const records: RecordOutcome[] = [];
  const onlyOnLeft: string[] = [];
  const usedKeys = new Set<string>();

  for (const row of left.table.rows) {
    const k = keyOf(row[key.leftIndex] ?? '');
    if (!k) continue;
    const other = rightByKey.get(k);
    if (!other) {
      onlyOnLeft.push(k);
      continue;
    }
    usedKeys.add(k);

    const cells: RecordCell[] = pairs.map((cp) => compareCell(cp, row, other, adjustFor(cp)));

    records.push({ key: k, cells, passed: cells.every((c) => c.verdict === 'match') });
  }

  const onlyOnRight = [...rightByKey.keys()].filter((k) => !usedKeys.has(k));

  let matched = 0;
  let formattingOnly = 0;
  let definitional = 0;
  let mismatched = 0;
  let missing = 0;
  let numericCells = 0;
  let textCells = 0;
  for (const rec of records) {
    for (const c of rec.cells) {
      if (c.kind === 'numeric') numericCells++;
      else textCells++;
      if (c.verdict === 'match') {
        matched++;
        if (c.formattingOnly) formattingOnly++;
        // Counted separately from formatting: these agreed only because a declared
        // definitional difference was allowed for, which the reader needs to see rather
        // than have folded into a clean total.
        if (c.definitional) definitional++;
      } else if (c.verdict === 'mismatch') mismatched++;
      else missing++;
    }
  }

  const note =
    `Both screens publish this module as a listing of individual records, so they were compared ` +
    `record by record rather than metric by metric. Records were matched on ${key.reason}. ` +
    `${pairs.length} column(s) were compared across ${records.length} record(s) — ` +
    `${pairs.filter((p) => p.kind === 'numeric').length} numeric and ` +
    `${pairs.filter((p) => p.kind === 'text').length} descriptive. ` +
    (onlyOnLeft.length || onlyOnRight.length
      ? `${onlyOnLeft.length} record(s) appear only on ${sides.leftLabel} and ${onlyOnRight.length} only on ` +
        `${sides.rightLabel}; both listings paginate, so a record missing from the other side's current ` +
        'page is a display limit rather than a missing record, and it is counted separately.'
      : 'Every record on each side found its counterpart.');

  return {
    keyColumn: {
      left: leftHeaders[key.leftIndex] || `column ${key.leftIndex}`,
      right: rightHeaders[key.rightIndex] || `column ${key.rightIndex}`,
      reason: key.reason,
    },
    columnPairs: pairs,
    unpairedLeft,
    unpairedRight,
    records,
    onlyOnLeft,
    onlyOnRight,
    summary: {
      recordsCompared: records.length,
      totalCells: matched + mismatched + missing,
      matched,
      formattingOnly,
      definitional,
      mismatched,
      missing,
      numericCells,
      textCells,
    },
    note:
      note +
      (definitional
        ? ` ${definitional} cell(s) agreed only once a declared definitional difference was ` +
          'allowed for; each was verified against the stated relationship rather than skipped, ' +
          'so a record that stopped following it would still be reported.'
        : ''),
  };
}
