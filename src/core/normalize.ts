/**
 * Value normalization for report comparison.
 *
 * Report screens render numbers as display strings ("$34,837", "-90.0%", "1,420",
 * "$181.16"). To compare across two screens that format differently, everything is
 * parsed to a plain number first.
 */

export type MetricKind = 'currency' | 'count' | 'hours' | 'rate' | 'percent';

/** A parsed cell: the number plus whether the source cell was actually present. */
export interface ParsedValue {
  raw: string;
  value: number | null;
  /** True when the cell was blank/absent rather than a real zero. */
  empty: boolean;
  /**
   * The parenthesised figure from a composite cell like "$7,403.52 (85.11%)", where
   * `value` is the primary. Null when the cell has no secondary figure.
   */
  secondary?: number | null;
  secondaryRaw?: string;
}

/**
 * Parse a rendered report cell into a number.
 *
 * Handles currency symbols, thousands separators, percent signs, and the
 * accounting negative convention "($1,234)" as well as a leading minus.
 */
export function parseCell(raw: string | undefined | null): ParsedValue {
  const text = (raw ?? '').trim();
  if (!text || text === '-' || text === '—' || text === 'N/A') {
    return { raw: text, value: null, empty: true };
  }

  // Accounting negatives: ($1,234.00) means -1234.00. Detected before the composite
  // handling below, which also involves parentheses but means something different.
  const parenNegative = /^\(.*\)$/.test(text);

  const strip = (s: string) =>
    s
      .replace(/[()]/g, '')
      .replace(/[$€£]/g, '')
      .replace(/,/g, '')
      .replace(/%/g, '')
      .trim();

  const n = Number(strip(text));
  if (Number.isFinite(n)) {
    return { raw: text, value: parenNegative ? -Math.abs(n) : n, empty: false };
  }

  /**
   * Composite cells: a primary figure followed by a parenthesised secondary, e.g.
   * "86 (51)" for op codes, or "$7,403.52 (85.11%)" for gross with its margin.
   *
   * Stripping the punctuation left "86 51", which is not a number, so these columns
   * were treated as non-numeric and dropped from the comparison entirely — quietly
   * excluding Labor Gross, Parts Gross, Total Gross and Op Code Count. Take the leading
   * figure, which is the value both screens render first, and keep the secondary for
   * reference.
   */
  const composite = /^([^()]+?)\s*\(([^()]*)\)\s*$/.exec(text);
  if (composite) {
    const primary = Number(strip(composite[1]!));
    if (Number.isFinite(primary)) {
      const secondaryNum = Number(strip(composite[2]!));
      return {
        raw: text,
        value: primary,
        empty: false,
        secondary: Number.isFinite(secondaryNum) ? secondaryNum : null,
        secondaryRaw: composite[2]!.trim(),
      };
    }
  }

  return { raw: text, value: null, empty: false };
}

/**
 * Default comparison tolerance per metric kind.
 *
 * Retained as a fallback for callers without both rendered strings to hand. Prefer
 * `precisionTolerance`, which adapts to what each screen actually displays.
 */
export function defaultTolerance(kind: MetricKind): number {
  switch (kind) {
    case 'currency':
      return 1.0;
    case 'count':
      return 0.5;
    case 'hours':
      return 0.5;
    case 'rate':
      return 0.01;
    case 'percent':
      return 0.01;
  }
}

/** How many decimal places a rendered value shows. */
export function displayDecimals(raw: string | undefined | null): number | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  // Look at the numeric portion only, ignoring currency symbols, separators and signs.
  const m = /(\d+)(?:\.(\d+))?\s*%?\s*\)?$/.exec(text.replace(/,/g, ''));
  if (!m) return null;
  return m[2] ? m[2].length : 0;
}

/**
 * Tolerance derived from the precision the two screens display.
 *
 * One product rounds for display where the other shows decimals — AutoGroup renders
 * "237" hours and "$44,444" against DMS's "236.5" and "$44,508.68". The underlying
 * figures are the same; only the presentation differs, so a gap no larger than half of
 * the coarser display unit is rounding, not a discrepancy.
 *
 * Half of the coarsest unit is the correct bound: a value shown to zero decimals can
 * sit up to 0.5 either side of what was rounded. Anything beyond that survives as a
 * genuine difference, which is why the discount gaps and the warranty shortfall are
 * still reported.
 */
export function precisionTolerance(
  leftRaw: string | undefined | null,
  rightRaw: string | undefined | null,
  kind: MetricKind,
): number {
  const l = displayDecimals(leftRaw);
  const r = displayDecimals(rightRaw);

  // With neither side readable, fall back to the per-kind default.
  if (l === null && r === null) return defaultTolerance(kind);

  const coarsest = Math.min(l ?? Number.POSITIVE_INFINITY, r ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(coarsest)) return defaultTolerance(kind);

  // Half the coarsest displayed unit, with a small floor so two values shown to many
  // decimals are not held to an impossible standard.
  return Math.max(0.5 * 10 ** -coarsest, 0.005);
}

export type Verdict = 'match' | 'mismatch' | 'missing-left' | 'missing-right' | 'missing-both';

export interface Comparison {
  verdict: Verdict;
  delta: number | null;
  withinTolerance: boolean;
  /**
   * True when the values are not identical but agree once display rounding is allowed
   * for. Surfaced separately so tolerance is auditable rather than silent leniency.
   */
  roundedMatch: boolean;
}

/** Compare two parsed cells under a tolerance. */
export function compareValues(
  left: ParsedValue,
  right: ParsedValue,
  tolerance: number,
): Comparison {
  if (left.value === null && right.value === null) {
    return { verdict: 'missing-both', delta: null, withinTolerance: false, roundedMatch: false };
  }
  if (left.value === null) {
    return { verdict: 'missing-left', delta: null, withinTolerance: false, roundedMatch: false };
  }
  if (right.value === null) {
    return { verdict: 'missing-right', delta: null, withinTolerance: false, roundedMatch: false };
  }

  const delta = round(right.value - left.value, 4);
  const withinTolerance = Math.abs(delta) <= tolerance;
  return {
    verdict: withinTolerance ? 'match' : 'mismatch',
    delta,
    withinTolerance,
    roundedMatch: withinTolerance && delta !== 0,
  };
}

export function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Reduce a text cell to a comparable form.
 *
 * Descriptive columns are worth comparing — a record listing's customer, vehicle, advisor
 * and technician columns are exactly the fields that reveal two systems disagreeing about
 * which record is which — but they are never formatted identically. The two screens differ
 * in case, in spacing, in punctuation, and in whether they append a trailing marker. So
 * compare on the words, not the characters.
 *
 * Digits are kept: an id or a year is the most identifying part of "2021 HONDA CR-V EX-L".
 */
export function normalizeText(raw: string | undefined | null): string {
  return (raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    // Punctuation is presentational here; "CR-V" and "CR V" are the same vehicle.
    .replace(/[.,:;()[\]"'#/\\|&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TextComparison {
  verdict: Verdict;
  /** 0..1 similarity of the two texts, for reporting a near miss. */
  similarity: number;
  /** True when they differ only in formatting, so they normalize to the same thing. */
  formattingOnly: boolean;
}

/**
 * Compare two text cells.
 *
 * Three outcomes matter, not two: identical, the same content formatted differently, and
 * genuinely different. Collapsing the middle case into "different" would report a
 * disagreement every time one screen writes "2021 HONDA CR-V" and the other "2021 Honda
 * CR V"; collapsing it into "identical" would hide that the two screens present the same
 * record inconsistently. So it is a match, flagged as a formatting difference.
 *
 * `threshold` is the similarity above which two texts are taken to be the same content.
 * One screen truncating a value ("HERIBERTO XAVIER AVILA" against "HERIBERTO AVILA") is
 * the same person, and holding those to exact equality produces noise, not findings.
 */
export function compareTexts(
  leftRaw: string | undefined | null,
  rightRaw: string | undefined | null,
  threshold = 0.8,
): TextComparison {
  const l = (leftRaw ?? '').trim();
  const r = (rightRaw ?? '').trim();

  if (!l && !r) return { verdict: 'missing-both', similarity: 1, formattingOnly: false };
  if (!l) return { verdict: 'missing-left', similarity: 0, formattingOnly: false };
  if (!r) return { verdict: 'missing-right', similarity: 0, formattingOnly: false };

  if (l === r) return { verdict: 'match', similarity: 1, formattingOnly: false };

  const ln = normalizeText(l);
  const rn = normalizeText(r);
  if (ln === rn) return { verdict: 'match', similarity: 1, formattingOnly: true };

  // Token overlap, so word order and a missing middle name do not count against it.
  const tokens = (s: string) => new Set(s.split(' ').filter((t) => t.length > 1));
  const A = tokens(ln);
  const B = tokens(rn);
  if (!A.size || !B.size) return { verdict: 'mismatch', similarity: 0, formattingOnly: false };
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  const score = Number(((2 * shared) / (A.size + B.size)).toFixed(3));

  return {
    verdict: score >= threshold ? 'match' : 'mismatch',
    similarity: score,
    formattingOnly: score >= threshold,
  };
}

/** Format a number back to a readable string for the report. */
export function formatValue(v: number | null, kind: MetricKind): string {
  if (v === null) return '—';
  switch (kind) {
    case 'currency':
      return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'count':
      return v.toLocaleString('en-US');
    case 'hours':
      return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    case 'rate':
      return `$${v.toFixed(2)}`;
    case 'percent':
      return `${v.toFixed(2)}%`;
  }
}
