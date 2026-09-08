/**
 * Compare the analytics strip — the row of KPI cards above the grid.
 *
 * On several modules this strip is where the headline figures live: total ROs, ELR, labour
 * and parts sales and gross, total sales and gross. On the Closed RO screens it is the
 * *only* place those totals appear, because neither screen publishes a summary grid for
 * that module — so ignoring it meant ignoring everything that was directly comparable and
 * reporting the module as not compared.
 *
 * The cards are not tables, so they are read as label/value pairs during the crawl and
 * matched here by label. Two guards keep that from going wrong:
 *
 *  - Values must be the same shape. A card headed "GROSS %" showing 87.3% must never pair
 *    with "LABOR GROSS" showing $76,065.53, and on token similarity alone it scores 0.67
 *    against it, which is close enough to be dangerous.
 *  - Exact label matches are consumed first, so a vague label cannot steal a card that has
 *    a precise counterpart.
 */
import {
  compareValues,
  parseCell,
  precisionTolerance,
  type ParsedValue,
  type Verdict,
} from './normalize.js';
import { inferKind, normalizeLabel, similarity } from './match.js';

/** One card from the analytics strip, as captured. */
export interface CapturedTile {
  label: string;
  value: string;
  /** The card's secondary line, e.g. "87.3% GROSS" or "PER BILL HOUR". */
  caption?: string | null;
  y?: number;
  x?: number;
}

export interface TilePair {
  label: string;
  rightLabel: string;
  leftCaption: string | null;
  rightCaption: string | null;
  left: ParsedValue;
  right: ParsedValue;
  delta: number | null;
  tolerance: number;
  verdict: Verdict;
  roundedMatch: boolean;
  matchedBy: 'exact' | 'fuzzy';
  confidence: number;
}

export interface AnalyticsComparison {
  compared: number;
  matched: number;
  roundedMatches: number;
  mismatched: number;
  pairs: TilePair[];
  /** Cards published by one screen only. Not a disagreement — a difference in coverage. */
  onlyOnLeft: CapturedTile[];
  onlyOnRight: CapturedTile[];
  note: string;
}

/**
 * How a value is written, used to refuse a pairing between incompatible figures.
 *
 * A percentage and an amount are never the same measure however alike their labels read.
 */
function valueShape(raw: string): 'percent' | 'currency' | 'number' | 'other' {
  const t = (raw ?? '').trim();
  if (!t) return 'other';
  if (/%/.test(t)) return 'percent';
  if (/[$€£]/.test(t)) return 'currency';
  if (/^[-+(]?[\d,]+(\.\d+)?\)?$/.test(t)) return 'number';
  return 'other';
}

/**
 * Does this read like the name of a measure, rather than a row caption?
 *
 * The analytics strip is labelled with measure names — TOTAL RO'S, ELR, LABOR GROSS. A grid
 * row is captioned with a date, a person, or a "+3 more" link. Pairing a stray row value
 * against an unrelated row value produces a confident-looking difference between two numbers
 * that were never the same measure, so these are refused outright.
 */
function labelNamesAMeasure(label: string): boolean {
  const t = label.trim();
  if (!t || t.length > 48) return false;
  if (/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(t)) return false;
  if (/^(OPEN|CLOSE|CLOSED|OPENED)\b.*:/i.test(t)) return false;
  if (/^\+\s*\d+\s*MORE$/i.test(t)) return false;
  if (/\d+\s*(TO|-|–)\s*\d+\s*(OUT\s+)?OF\s*\d+/i.test(t)) return false;
  if (/^SHOWING\b/i.test(t)) return false;
  if (/[$€£]/.test(t)) return false;
  if (/\d+(\.\d+)?\s*%/.test(t)) return false;
  // A caption that is mostly digits — "CP 450 · W 72 · I 648" — names no measure. One such
  // caption paired with an unrelated figure purely because both screens showed 25 rows.
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  if ((t.match(/\d/g) ?? []).length > letters) return false;
  return /[A-Za-z]{2,}/.test(t);
}

/**
 * Drop cards that cannot be compared to anything.
 *
 * A card with no label, or whose "label" is really a sub-caption restating the figure,
 * carries no identity to match on.
 */
function usable(tiles: CapturedTile[]): CapturedTile[] {
  const out: CapturedTile[] = [];
  const seen = new Set<string>();
  for (const t of tiles) {
    const label = (t.label ?? '').trim();
    const value = (t.value ?? '').trim();
    if (!label || !value) continue;
    if (valueShape(value) === 'other') continue;
    // Refuse anything whose "label" is really a grid row's caption rather than the name of a
    // measure. The crawler already excludes table descendants, but this does not depend on
    // that: a stray row value paired with a date caption produces a confident-looking
    // difference out of two unrelated numbers, which is far worse than omitting it.
    if (!labelNamesAMeasure(label)) continue;
    const key = `${normalizeLabel(label)}|${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...t, label, value });
  }
  return out;
}

export function compareTiles(
  leftTiles: CapturedTile[],
  rightTiles: CapturedTile[],
  sides: { leftLabel: string; rightLabel: string },
): AnalyticsComparison | null {
  const left = usable(leftTiles ?? []);
  const right = usable(rightTiles ?? []);
  if (!left.length && !right.length) return null;

  const pairs: TilePair[] = [];
  const usedRight = new Set<number>();
  const matchedLeft = new Set<number>();

  const norm = (t: CapturedTile) => normalizeLabel(t.label);

  const build = (l: CapturedTile, r: CapturedTile, matchedBy: 'exact' | 'fuzzy', confidence: number) => {
    const lv = parseCell(l.value);
    const rv = parseCell(r.value);
    const kind = inferKind(`${l.label} ${l.caption ?? ''}`, lv.raw || rv.raw);
    const tolerance = precisionTolerance(lv.raw, rv.raw, kind);
    const cmp = compareValues(lv, rv, tolerance);
    pairs.push({
      label: l.label,
      rightLabel: r.label,
      leftCaption: l.caption ?? null,
      rightCaption: r.caption ?? null,
      left: lv,
      right: rv,
      delta: cmp.delta,
      tolerance,
      verdict: cmp.verdict,
      roundedMatch: cmp.roundedMatch,
      matchedBy,
      confidence,
    });
  };

  // 1. Identical labels, once normalized. Strongest evidence, so taken first.
  left.forEach((l, li) => {
    const ln = norm(l);
    const ri = right.findIndex(
      (r, i) => !usedRight.has(i) && norm(r) === ln && valueShape(r.value) === valueShape(l.value),
    );
    if (ri === -1) return;
    usedRight.add(ri);
    matchedLeft.add(li);
    build(l, right[ri]!, 'exact', 1);
  });

  // 2. Then the closest remaining label, provided the values are the same shape.
  const candidates: Array<{ li: number; ri: number; score: number }> = [];
  left.forEach((l, li) => {
    if (matchedLeft.has(li)) return;
    right.forEach((r, ri) => {
      if (usedRight.has(ri)) return;
      if (valueShape(r.value) !== valueShape(l.value)) return;
      const score = similarity(norm(l), norm(r));
      if (score >= 0.6) candidates.push({ li, ri, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (matchedLeft.has(c.li) || usedRight.has(c.ri)) continue;
    matchedLeft.add(c.li);
    usedRight.add(c.ri);
    build(left[c.li]!, right[c.ri]!, 'fuzzy', Number(c.score.toFixed(3)));
  }

  const matched = pairs.filter((p) => p.verdict === 'match').length;
  const roundedMatches = pairs.filter((p) => p.verdict === 'match' && p.roundedMatch).length;
  const mismatched = pairs.filter((p) => p.verdict === 'mismatch').length;

  const onlyOnLeft = left.filter((_, i) => !matchedLeft.has(i));
  const onlyOnRight = right.filter((_, i) => !usedRight.has(i));

  const note =
    `The analytics strip is a set of cards rather than a table, so it is read as label and ` +
    `value pairs. ${pairs.length} card(s) were matched across the two screens and compared; ` +
    `${onlyOnLeft.length} appear only on ${sides.leftLabel} and ${onlyOnRight.length} only on ` +
    `${sides.rightLabel}. A card on one screen only is a difference in what that screen ` +
    `publishes, not a disagreement about a figure, and is counted separately.`;

  return {
    compared: pairs.length,
    matched,
    roundedMatches,
    mismatched,
    pairs,
    onlyOnLeft,
    onlyOnRight,
    note,
  };
}
