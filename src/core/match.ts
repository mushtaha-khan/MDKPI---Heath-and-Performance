/**
 * Automatic row matching between two report grids.
 *
 * The two products name the same metric differently ("HOURS FLAGGED" vs "HRS.
 * FLAGGED", "PARTS DISCOUNT" vs "PARTS DISC"). Rather than require a hand-written
 * metric list per module, labels are normalized, abbreviations expanded, and then
 * matched exactly, then by alias, then by similarity. Anything still unmatched is
 * reported rather than silently dropped, so coverage is always visible.
 */
import type { MetricKind } from './normalize.js';

/** Abbreviations seen across these grids, expanded to a common form. */
const EXPANSIONS: Array<[RegExp, string]> = [
  [/\bHRS?\b/g, 'HOURS'],
  [/\bDISC\b/g, 'DISCOUNT'],
  [/\bR\.?O\.?\b/g, 'RO'],
  [/\bOP\b/g, 'OPCODE'],
  [/\bOPCODES\b/g, 'OPCODE'],
  [/\bELR\b/g, 'EFFECTIVE LABOUR RATE'],
  [/\bLABOR\b/g, 'LABOUR'],
  [/\bL&P\b/g, 'LABOUR AND PARTS'],
  [/\bSRVC\b/g, 'SERVICE'],
  [/\bACCESS\b/g, 'ACCESSORIES'],
  [/\bAVG\b/g, 'AVERAGE'],
  [/\bTECH\b/g, 'TECHNICIAN'],
  [/\bGOG\b/g, 'GAS OIL GREASE'],
  [/\bSUB TOTAL\b/g, 'SUBTOTAL'],
  [/\bTOTAL ALL\b/g, 'TOTAL'],
  [/\bTTL\b/g, 'TOTAL'],
  [/\bQTY\b/g, 'QUANTITY'],
  [/\bAMT\b/g, 'AMOUNT'],
  [/\bPCT\b/g, 'PERCENT'],
  [/\bCUST\b/g, 'CUSTOMER'],
  [/\bWARR\b/g, 'WARRANTY'],
  [/\bDEPT\b/g, 'DEPARTMENT'],
  [/\bVEH\b/g, 'VEHICLE'],
  [/\bGRS\b/g, 'GROSS'],
];

/**
 * Reduce a plural to its singular so "LABOR SALES" and "LABOR SALE" are one metric.
 *
 * The two products are inconsistent about it — a DMS column reads "TOTAL SALE" where the
 * AutoGroup equivalent reads "OPEN RO SALES" — and as separate tokens they share nothing.
 *
 * Only a trailing "s" is removed, and not when the word ends in SS, US, IS or AS, which are
 * not plural endings: without that guard GROSS becomes GRO and MISCELLANEOUS becomes
 * MISCELLANEOU, and both stop matching themselves.
 */
function singularize(word: string): string {
  if (word.length < 4) return word;
  if (!word.endsWith('S')) return word;
  if (/(SS|US|IS|AS)$/.test(word)) return word;
  return word.slice(0, -1);
}

/**
 * Words that add no meaning when comparing labels.
 *
 * "PER" is deliberately NOT here: it is what distinguishes a volume from a rate
 * ("LABOUR SALES" vs "SALES PER LIFT PER MONTH"). Stripping it made per-unit rows
 * indistinguishable from totals, which caused them to be checked as a share of the
 * total and reported as failures.
 */
const NOISE = new Set(['THE', 'OF', 'AND', 'A']);

/**
 * Labels that mean "everything", used to recognise a grand-total row.
 *
 * One screen may label its total row bare ("ALL") while the other spells out what is
 * being totalled ("ALL OPEN ROS"). Those share only one token out of four, so similarity
 * scores them at 0.5 — far below the match threshold — and the single most important row
 * in the grid went uncompared.
 */
const TOTAL_MARKERS = new Set([
  'TOTAL',
  'TOTALS',
  'GRAND TOTAL',
  'SUBTOTAL',
  'ALL',
  'OVERALL',
  'SUM',
]);

/** Reduce a display label to a comparable canonical form. */
export function normalizeLabel(raw: string): string {
  let s = (raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    // Keep & and / initially so expansions can see L&P, then strip.
    // '#' is stripped so rank prefixes like "#1 " become a bare ordinal, which the
    // single-character filter in similarity() then discards.
    //
    // '?' and '!' are stripped for the same reason. A screen that heads its milestone
    // columns as questions — "B.O RECEIVED?", "DEAL FUNDED?" — otherwise yields the token
    // "RECEIVED?", which shares nothing with the other screen's "RECEIVED" and scores zero.
    // "SENT TO B.O?" still paired, because its match rested on SENT and TO, so the columns
    // pairing at all was down to how much of the heading happened to survive.
    .replace(/[.,:;()\[\]"'#?!]/g, ' ');

  for (const [re, to] of EXPANSIONS) s = s.replace(re, to);

  s = s
    .replace(/[&/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = s
    .split(' ')
    .filter((w) => w && !NOISE.has(w))
    .map(singularize);
  return words.join(' ');
}

/**
 * Token-set similarity in [0,1]. Order-insensitive, which suits label variants.
 *
 * Single-character tokens are discarded: they carry almost no identifying signal but
 * inflate the denominator badly. One product renders a technician as
 * "#1 HERIBERTO XAVIER AVILA (4158) I" and the other as "HERIBERTO AVILA 4158" — with
 * the stray "1" and "I" counted, the same person scored 0.67 and fell below the match
 * threshold; without them, 0.86.
 */
export function similarity(a: string, b: string): number {
  const tokens = (s: string) => new Set(s.split(' ').filter((t) => t.length > 1));
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** Infer how a value should be compared from its label and rendered form. */
export function inferKind(label: string, sample: string): MetricKind {
  const L = normalizeLabel(label);
  const s = (sample ?? '').trim();

  if (/%/.test(s)) return 'percent';

  // "X PER Y" is a per-unit figure regardless of what X is, so it is a rate rather
  // than a volume: it is not a share of any total and is not projected forward.
  // Checked before COUNT/HOURS because "HOURS PER TECH" is a rate, not an hours total.
  if (/\bPER\b/.test(L) || /\bRATE\b/.test(L) || /^AVERAGE\b|^AVG\b/.test(L)) return 'rate';

  if (/\bCOUNT\b/.test(L)) return 'count';
  if (/\bHOURS\b/.test(L)) return 'hours';
  if (/[$€£]/.test(s)) return 'currency';
  if (/^\d[\d,]*$/.test(s)) return 'count';
  return 'currency';
}

export type MatchMethod = 'exact' | 'alias' | 'fuzzy' | 'manual';

export interface RowMatch {
  id: string;
  leftLabel: string;
  rightLabel: string;
  leftRow: string[];
  rightRow: string[];
  method: MatchMethod;
  confidence: number;
}

/** A row with no counterpart, carrying its data so the report can show its values. */
export interface UnmatchedRow {
  label: string;
  row: string[];
  /** Closest candidate on the other side and its score, to explain the near miss. */
  closest?: { label: string; score: number };
}

export interface MatchResult {
  matches: RowMatch[];
  unmatchedLeft: UnmatchedRow[];
  unmatchedRight: UnmatchedRow[];
}

export interface MatchOptions {
  /** Explicit left-label -> right-label overrides from a module preset. */
  aliases?: Record<string, string>;
  /** Labels to ignore entirely (section headers, spacers). */
  ignore?: string[];
  /** Minimum similarity to accept a fuzzy match. */
  threshold?: number;
}

/** A row paired with the label identifying it. */
export interface LabelledRow {
  label: string;
  cells: string[];
}

/**
 * Match rows between two grids.
 *
 * Labels are supplied rather than read from a fixed column, because a grid that groups
 * its rows names the entity only on the first row of each group — the total row beneath
 * it has an empty label cell. Row normalization recovers those labels, so matching works
 * from them directly.
 */
export function matchRows(
  leftRows: LabelledRow[],
  rightRows: LabelledRow[],
  opts: MatchOptions = {},
): MatchResult {
  const threshold = opts.threshold ?? 0.82;
  const ignore = new Set((opts.ignore ?? []).map(normalizeLabel));
  const aliases = new Map(
    Object.entries(opts.aliases ?? {}).map(([k, v]) => [normalizeLabel(k), normalizeLabel(v)]),
  );

  const prep = (rows: LabelledRow[]) =>
    rows
      .filter((r) => r.label.trim() && r.cells.some((c) => (c ?? '').trim() !== ''))
      .map((r) => ({
        raw: r.label.trim(),
        norm: normalizeLabel(r.label),
        row: r.cells,
      }))
      .filter((x) => x.norm && !ignore.has(x.norm));

  const left = prep(leftRows);
  const right = prep(rightRows);

  const rightByNorm = new Map<string, (typeof right)[number]>();
  for (const r of right) if (!rightByNorm.has(r.norm)) rightByNorm.set(r.norm, r);

  const usedRight = new Set<string>();
  const matches: RowMatch[] = [];
  const unmatchedLeft: UnmatchedRow[] = [];

  for (const l of left) {
    // 1. Explicit override from the module preset.
    const aliasTarget = aliases.get(l.norm);
    if (aliasTarget) {
      const hit = rightByNorm.get(aliasTarget);
      if (hit && !usedRight.has(hit.norm)) {
        usedRight.add(hit.norm);
        matches.push({
          id: l.norm,
          leftLabel: l.raw,
          rightLabel: hit.raw,
          leftRow: l.row,
          rightRow: hit.row,
          method: 'manual',
          confidence: 1,
        });
        continue;
      }
    }

    // 2. Exact normalized match.
    const exact = rightByNorm.get(l.norm);
    if (exact && !usedRight.has(exact.norm)) {
      usedRight.add(exact.norm);
      matches.push({
        id: l.norm,
        leftLabel: l.raw,
        rightLabel: exact.raw,
        leftRow: l.row,
        rightRow: exact.row,
        method: 'exact',
        confidence: 1,
      });
      continue;
    }

    // 3. Best fuzzy candidate above the threshold.
    let best: { r: (typeof right)[number]; score: number } | null = null;
    for (const r of right) {
      if (usedRight.has(r.norm)) continue;
      const score = similarity(l.norm, r.norm);
      if (!best || score > best.score) best = { r, score };
    }
    if (best && best.score >= threshold) {
      usedRight.add(best.r.norm);
      matches.push({
        id: l.norm,
        leftLabel: l.raw,
        rightLabel: best.r.raw,
        leftRow: l.row,
        rightRow: best.r.row,
        method: 'fuzzy',
        confidence: Number(best.score.toFixed(3)),
      });
      continue;
    }

    // Keep the row and its nearest miss, so the report can show what it held and how
    // close the best candidate came rather than just naming it.
    unmatchedLeft.push({
      label: l.raw,
      row: l.row,
      ...(best && best.score > 0
        ? { closest: { label: best.r.raw, score: Number(best.score.toFixed(3)) } }
        : {}),
    });
  }

  /**
   * Final pass: a grand-total row that the two screens label differently.
   *
   * One side writes "ALL", the other "ALL OPEN ROS". Similarity puts them at 0.5, so the
   * total row — usually the row that matters most — was left uncompared on both sides.
   *
   * Deliberately narrow, because "contains a total word" is far too loose on its own: a
   * grid can hold TOTAL SALES, TOTAL GROSS and TOTAL COST as separate metrics, and pairing
   * any of those with each other would be badly wrong. So this requires one label to be a
   * bare total marker, every one of its tokens to appear in the other, and the whole thing
   * to be unambiguous — exactly one such pairing available across what remains. Anything
   * less certain is left unmatched and reported.
   */
  const isTotalMarker = (norm: string) => TOTAL_MARKERS.has(norm);
  const tokensOf = (norm: string) => norm.split(' ').filter(Boolean);
  const contains = (haystack: string, needle: string) => {
    const H = new Set(tokensOf(haystack));
    return tokensOf(needle).every((t) => H.has(t));
  };

  const leftLeftovers = unmatchedLeft.map((u, i) => ({ u, i, norm: normalizeLabel(u.label) }));
  const rightLeftovers = right.filter((r) => !usedRight.has(r.norm));

  const totalCandidates: Array<{ li: number; l: (typeof leftLeftovers)[number]; r: (typeof right)[number] }> = [];
  for (const l of leftLeftovers) {
    for (const r of rightLeftovers) {
      const ok =
        (isTotalMarker(l.norm) && contains(r.norm, l.norm)) ||
        (isTotalMarker(r.norm) && contains(l.norm, r.norm));
      if (ok) totalCandidates.push({ li: l.i, l, r });
    }
  }

  if (totalCandidates.length === 1) {
    const { l, r } = totalCandidates[0]!;
    usedRight.add(r.norm);
    matches.push({
      id: l.norm,
      leftLabel: l.u.label,
      rightLabel: r.raw,
      leftRow: l.u.row,
      rightRow: r.row,
      method: 'fuzzy',
      confidence: Number(Math.max(similarity(l.norm, r.norm), 0.5).toFixed(3)),
    });
    unmatchedLeft.splice(
      unmatchedLeft.findIndex((x) => x === l.u),
      1,
    );
  }

  const unmatchedRight: UnmatchedRow[] = right
    .filter((r) => !usedRight.has(r.norm))
    .map((r) => {
      let best: { label: string; score: number } | null = null;
      for (const l of left) {
        const score = similarity(r.norm, l.norm);
        if (!best || score > best.score) best = { label: l.raw, score: Number(score.toFixed(3)) };
      }
      return { label: r.raw, row: r.row, ...(best && best.score > 0 ? { closest: best } : {}) };
    });

  return { matches, unmatchedLeft, unmatchedRight };
}
