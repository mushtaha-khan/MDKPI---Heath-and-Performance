/**
 * Formula validation for the DMS Service Dashboard.
 *
 * Each derived row on the dashboard carries its formula in a hover tooltip (bound via
 * Angular [pTooltip]). scripts/extract-formulas.mjs harvests those strings; this
 * module parses them and checks the rendered values actually satisfy them.
 *
 * This is independent of the AutoGroup comparison: it answers "is the DMS dashboard
 * self-consistent?" rather than "do the two screens agree?".
 */
import { parseCell, round, type MetricKind } from './normalize.js';
import { CATEGORIES, dmsCol, type Category } from './mapping.js';
import { inferKind, normalizeLabel } from './match.js';

export interface ExtractedFormula {
  rowIndex: number;
  rowLabel: string;
  cellIndex: number;
  formula: string | null;
}

export type Token =
  | { type: 'ref'; label: string }
  | { type: 'num'; value: number }
  | { type: 'op'; op: '+' | '-' | '*' | '/' };

/**
 * Tokenize a formula string.
 *
 * Row labels are matched greedily against the known label set because some labels
 * themselves contain an operator-looking sequence — e.g. "EXPRESS SERVICE - TIRES
 * GROSS" contains " - ". Splitting naively on operators would corrupt those.
 */
export function tokenize(formula: string, knownLabels: string[]): Token[] {
  // Longest first so "LABOR SALES AFTER DISC." wins over "LABOR SALES".
  const labels = [...knownLabels].sort((a, b) => b.length - a.length);
  const src = formula.replace(/\s+/g, ' ').trim();
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    if (src[i] === ' ') {
      i++;
      continue;
    }

    // Try a known row label at this position.
    const upper = src.toUpperCase();
    const label = labels.find(
      (l) => l.length > 0 && upper.startsWith(l.toUpperCase(), i),
    );
    if (label) {
      tokens.push({ type: 'ref', label });
      i += label.length;
      continue;
    }

    // Numeric literal.
    const numMatch = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (numMatch) {
      tokens.push({ type: 'num', value: Number(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }

    // Operator.
    const ch = src[i];
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', op: ch });
      i++;
      continue;
    }

    // Unrecognized fragment — consume to the next space so we can report it.
    const next = src.indexOf(' ', i);
    const frag = src.slice(i, next === -1 ? undefined : next);
    tokens.push({ type: 'ref', label: frag });
    i += frag.length;
  }

  return tokens;
}

export interface EvalResult {
  value: number | null;
  /** Labels referenced by the formula that had no row on the grid. */
  unresolved: string[];
  /** Operand-by-operand trace, for showing the arithmetic in the report. */
  trace: Array<{ label: string; value: number | null; op: string | null }>;
}

/**
 * Evaluate tokens strictly left to right.
 *
 * The dashboard's formulas are simple chains ("A + B - C", "A / 32 / 26") with no
 * parentheses and no precedence, so left-to-right matches the intent. Applying
 * normal precedence would actually give the wrong answer for "X / 32 / 26".
 */
export function evaluate(
  tokens: Token[],
  resolve: (label: string) => number | null,
): EvalResult {
  const unresolved: string[] = [];
  const trace: EvalResult['trace'] = [];

  let acc: number | null = null;
  let pendingOp: '+' | '-' | '*' | '/' | null = null;

  for (const t of tokens) {
    if (t.type === 'op') {
      pendingOp = t.op;
      continue;
    }

    let v: number | null;
    let label: string;
    if (t.type === 'num') {
      v = t.value;
      label = String(t.value);
    } else {
      v = resolve(t.label);
      label = t.label;
      if (v === null) unresolved.push(t.label);
    }

    trace.push({ label, value: v, op: pendingOp });

    if (v === null) {
      // Treat an unresolved operand as fatal — a partial sum would be misleading.
      acc = null;
      pendingOp = null;
      continue;
    }

    if (acc === null && pendingOp === null) {
      acc = v;
    } else if (acc === null) {
      acc = v;
    } else {
      switch (pendingOp) {
        case '+':
          acc += v;
          break;
        case '-':
          acc -= v;
          break;
        case '*':
          acc *= v;
          break;
        case '/':
          acc = v === 0 ? null : acc / v;
          break;
        case null:
          acc = v;
          break;
      }
    }
    pendingOp = null;
  }

  return { value: acc === null ? null : round(acc, 4), unresolved, trace };
}

export type FormulaVerdict = 'pass' | 'fail' | 'unresolved' | 'no-data';

export interface FormulaCheck {
  rowLabel: string;
  formula: string;
  category: Category;
  expected: number | null;
  actual: number | null;
  delta: number | null;
  verdict: FormulaVerdict;
  unresolved: string[];
  trace: EvalResult['trace'];
  tolerance: number;
}

export interface FormulaValidationResult {
  checks: FormulaCheck[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    unresolved: number;
    noData: number;
  };
  /** Formula rows that reference labels absent from the grid entirely. */
  missingReferences: string[];
}

/**
 * Validate every extracted formula against the rendered DMS grid, for all four
 * pay-type categories.
 *
 * Tolerance is 0.02 to absorb the dashboard's own cent-level display rounding —
 * values are rendered to 2dp, so a chain of several operands can drift a cent.
 */
/**
 * Validate every extracted formula against a grid, for each column group.
 *
 * `groups` and `colFor` come from the derived geometry, so this works on any grid
 * rather than only the Service dashboard's fixed layout. `labelColumn` says where the
 * row label lives.
 */
export function validateFormulasWithGeometry(
  rows: string[][],
  formulas: ExtractedFormula[],
  groups: string[],
  colFor: (group: string) => number | null,
  labelColumn = 0,
  tolerance = 0.02,
): FormulaValidationResult {
  const labels = rows
    .map((r) => (r[labelColumn] ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const rowByLabel = new Map<string, string[]>();
  for (const r of rows) {
    const l = (r[labelColumn] ?? '').replace(/\s+/g, ' ').trim();
    if (l && !rowByLabel.has(l.toUpperCase())) rowByLabel.set(l.toUpperCase(), r);
  }

  const checks: FormulaCheck[] = [];
  const missingReferences = new Set<string>();

  for (const f of formulas) {
    if (!f.formula) continue;
    const tokens = tokenize(f.formula, labels);

    for (const group of groups) {
      const col = colFor(group);
      if (col === null) continue;

      const resolve = (label: string): number | null => {
        const row = rowByLabel.get(label.toUpperCase());
        if (!row) {
          missingReferences.add(label);
          return null;
        }
        return parseCell(row[col]).value;
      };

      const ev = evaluate(tokens, resolve);
      const ownRow = rowByLabel.get(f.rowLabel.toUpperCase());
      const actual = ownRow ? parseCell(ownRow[col]).value : null;

      let verdict: FormulaVerdict;
      if (ev.unresolved.length > 0) verdict = 'unresolved';
      else if (ev.value === null || actual === null) verdict = 'no-data';
      else verdict = Math.abs(ev.value - actual) <= tolerance ? 'pass' : 'fail';

      checks.push({
        rowLabel: f.rowLabel,
        formula: f.formula,
        category: group as Category,
        expected: ev.value,
        actual,
        delta: ev.value !== null && actual !== null ? round(actual - ev.value, 4) : null,
        verdict,
        unresolved: ev.unresolved,
        trace: ev.trace,
        tolerance,
      });
    }
  }

  return {
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.verdict === 'pass').length,
      failed: checks.filter((c) => c.verdict === 'fail').length,
      unresolved: checks.filter((c) => c.verdict === 'unresolved').length,
      noData: checks.filter((c) => c.verdict === 'no-data').length,
    },
    missingReferences: [...missingReferences].sort(),
  };
}

export function validateFormulas(
  rows: string[][],
  formulas: ExtractedFormula[],
  tolerance = 0.02,
): FormulaValidationResult {
  const labels = rows.map((r) => (r[0] ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);

  const rowByLabel = new Map<string, string[]>();
  for (const r of rows) {
    const l = (r[0] ?? '').replace(/\s+/g, ' ').trim();
    if (l && !rowByLabel.has(l.toUpperCase())) rowByLabel.set(l.toUpperCase(), r);
  }

  const checks: FormulaCheck[] = [];
  const missingReferences = new Set<string>();

  for (const f of formulas) {
    if (!f.formula) continue;
    const tokens = tokenize(f.formula, labels);

    for (const category of CATEGORIES) {
      const col = dmsCol(category, 'actual', 'value');

      const resolve = (label: string): number | null => {
        const row = rowByLabel.get(label.toUpperCase());
        if (!row) {
          missingReferences.add(label);
          return null;
        }
        return parseCell(row[col]).value;
      };

      const ev = evaluate(tokens, resolve);
      const ownRow = rowByLabel.get(f.rowLabel.toUpperCase());
      const actual = ownRow ? parseCell(ownRow[col]).value : null;

      let verdict: FormulaVerdict;
      if (ev.unresolved.length > 0) verdict = 'unresolved';
      else if (ev.value === null || actual === null) verdict = 'no-data';
      else verdict = Math.abs(ev.value - actual) <= tolerance ? 'pass' : 'fail';

      checks.push({
        rowLabel: f.rowLabel,
        formula: f.formula,
        category,
        expected: ev.value,
        actual,
        delta: ev.value !== null && actual !== null ? round(actual - ev.value, 4) : null,
        verdict,
        unresolved: ev.unresolved,
        trace: ev.trace,
        tolerance,
      });
    }
  }

  return {
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.verdict === 'pass').length,
      failed: checks.filter((c) => c.verdict === 'fail').length,
      unresolved: checks.filter((c) => c.verdict === 'unresolved').length,
      noData: checks.filter((c) => c.verdict === 'no-data').length,
    },
    missingReferences: [...missingReferences].sort(),
  };
}

// ---------------------------------------------------------------------------
// Column-level (derived cell) checks
// ---------------------------------------------------------------------------

export interface DayContext {
  daysInMonth: number;
  workingDays: number;
  daysWorked: number;
  daysLeft: number;
}

/**
 * Outcome of looking for the period strip.
 *
 * 'absent' means this screen has no such strip at all, which is normal for most
 * modules. 'empty' means the strip is present but rendered no values, which is a data
 * quality problem worth reporting. Collapsing both to null made the report warn about
 * a missing strip on screens that never had one.
 */
export type DayContextResult =
  | { status: 'ok'; days: DayContext }
  | { status: 'empty'; days: null }
  | { status: 'absent'; days: null };

/** Read the DAYS IN A MONTH / WORKING DAYS / DAYS WORKED / DAYS LEFT strip. */
export function readDayContextDetailed(
  tables: Array<{ headers: string[][]; rows: string[][] }>,
): DayContextResult {
  for (const t of tables) {
    const head = t.headers.flat().join(' ').toUpperCase();
    if (head.includes('DAYS IN A MONTH') && head.includes('DAYS WORKED')) {
      const r = t.rows[0] ?? [];
      const parsed = [0, 1, 2, 3].map((i) => parseCell(r[i]).value);
      if (parsed.every((v) => v === null)) return { status: 'empty', days: null };
      return {
        status: 'ok',
        days: {
          daysInMonth: parsed[0] ?? 0,
          workingDays: parsed[1] ?? 0,
          daysWorked: parsed[2] ?? 0,
          daysLeft: parsed[3] ?? 0,
        },
      };
    }
  }
  return { status: 'absent', days: null };
}

/** Convenience wrapper for callers that only need the values. */
export function readDayContext(
  tables: Array<{ headers: string[][]; rows: string[][] }>,
): DayContext | null {
  return readDayContextDetailed(tables).days;
}

export interface ColumnCheck {
  rowLabel: string;
  category: Category;
  column: 'percent' | 'average' | 'tracking';
  rule: string;
  expected: number | null;
  actual: number | null;
  delta: number | null;
  verdict: FormulaVerdict;
  tolerance: number;
  /** Candidate rules tried, and whether each reproduced the rendered value. */
  candidates?: Array<{ rule: string; expected: number | null; fits: boolean }>;
}

interface Candidate {
  rule: string;
  value: number | null;
}

/**
 * Pick the candidate rule that reproduces the rendered value.
 *
 * Derived columns on this dashboard do not follow one uniform rule — a share-of-total
 * percentage applies to volume rows while Gross and Cost rows show a margin, and the
 * Avg. denominator switches between total RO count, the pay-type RO count, the parts
 * RO count and days worked depending on the row. Rather than hardcode a guess per row
 * and mislabel a correct cell as broken, try the plausible rules and report which one
 * the screen is actually using. A cell is only flagged when no candidate fits.
 */
function fitCandidates(
  actual: number,
  candidates: Candidate[],
  tolerance: number,
): { rule: string; expected: number | null; verdict: FormulaVerdict; delta: number | null; tried: Array<{ rule: string; expected: number | null; fits: boolean }> } {
  const tried = candidates.map((c) => ({
    rule: c.rule,
    expected: c.value,
    fits: c.value !== null && Math.abs(c.value - actual) <= tolerance,
  }));

  const hit = tried.find((t) => t.fits);
  if (hit) {
    return { rule: hit.rule, expected: hit.expected, verdict: 'pass', delta: 0, tried };
  }

  // No rule fits — report against the primary candidate so the delta is meaningful.
  const primary = tried.find((t) => t.expected !== null) ?? tried[0];
  return {
    rule: primary?.rule ?? 'no candidate',
    expected: primary?.expected ?? null,
    verdict: primary?.expected === null ? 'no-data' : 'fail',
    delta: primary?.expected !== null && primary?.expected !== undefined ? round(actual - primary.expected, 4) : null,
    tried,
  };
}

/**
 * Check the derived %, AVG. and TRACKING cells.
 *
 * Rules were established empirically against the live grid and confirmed by the
 * user for the percentage case:
 *   %        = category value / TOTAL value * 100
 *   AVG.     = value / RO COUNT of the same category
 *              (except the RO COUNT row itself, which divides by days worked)
 *   TRACKING = value / days worked * working days, for volume metrics only
 */
/**
 * Geometry-driven variant of the derived-column checks.
 *
 * Takes the value/%/Avg./Tracking column indices per group from the derived geometry
 * instead of the Service dashboard's fixed offsets, so it runs on any module.
 */
export function validateColumnsWithGeometry(
  rows: string[][],
  days: DayContext | null,
  groups: string[],
  subColumns: (group: string) => { value: number | null; percent: number | null; average: number | null; tracking: number | null },
  labelColumn = 0,
): { checks: ColumnCheck[]; summary: { total: number; passed: number; failed: number; skipped: number } } {
  const rowByLabel = new Map<string, string[]>();
  for (const r of rows) {
    const l = (r[labelColumn] ?? '').replace(/\s+/g, ' ').trim();
    if (l && !rowByLabel.has(l.toUpperCase())) rowByLabel.set(l.toUpperCase(), r);
  }

  const cellOf = (label: string, group: string): number | null => {
    const r = rowByLabel.get(label);
    const c = subColumns(group).value;
    return r && c !== null ? parseCell(r[c]).value : null;
  };

  const totalGroupEarly = groups.includes('TOTAL') ? 'TOTAL' : groups[0]!;
  const primaryCol = subColumns(totalGroupEarly).value;

  /**
   * Profile every row on the crawled grid so denominator candidates can be derived
   * from what is actually on screen.
   *
   * Naming the denominators explicitly ("LABOR SALES", "RO COUNT", ...) only ever
   * worked for one module: on any other screen those rows do not exist, no candidate
   * fits, and every derived cell is falsely reported as broken. Candidates are now
   * discovered from the grid and ranked by how much of their label they share with the
   * row under test, so "X COST" naturally proposes "X SALES" and "X GROSS".
   */
  interface RowProfile {
    label: string;
    tokens: Set<string>;
    kind: MetricKind;
  }
  const profiles: RowProfile[] = [];
  for (const r of rows) {
    const label = (r[labelColumn] ?? '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const sample = primaryCol !== null ? (r[primaryCol] ?? '') : '';
    if (!sample.trim()) continue; // heading or blank row
    profiles.push({
      label: label.toUpperCase(),
      tokens: new Set(normalizeLabel(label).split(' ').filter(Boolean)),
      kind: inferKind(label, sample),
    });
  }

  const overlap = (a: Set<string>, b: Set<string>): number => {
    let n = 0;
    for (const t of a) if (b.has(t)) n++;
    return n;
  };

  /**
   * Rows that could plausibly be this row's denominator, best first.
   *
   * Two pools are merged, because ranking on overall token overlap alone starves the
   * right answer: for "PARTS GROSS" every slot filled with other GROSS rows and
   * "PARTS SALES" — the actual denominator — never made the list. So one pool is
   * restricted to rows sharing the subject noun ("PARTS"), guaranteeing the related
   * rows of the same family are always offered.
   */
  function denominatorCandidates(
    targetLabel: string,
    predicate: (p: RowProfile) => boolean,
    limit: number,
  ): RowProfile[] {
    const words = normalizeLabel(targetLabel).split(' ').filter(Boolean);
    const tokens = new Set(words);
    const subject = words[0];

    const eligible = profiles.filter((p) => p.label !== targetLabel.toUpperCase() && predicate(p));
    const rank = (list: RowProfile[]) =>
      list
        .map((p) => ({ p, score: overlap(tokens, p.tokens) }))
        .sort((a, b) => b.score - a.score || a.p.label.length - b.p.label.length)
        .map((x) => x.p);

    const family = subject ? rank(eligible.filter((p) => p.tokens.has(subject))) : [];
    const general = rank(eligible);

    const out: RowProfile[] = [];
    const seen = new Set<string>();
    const half = Math.max(2, Math.ceil(limit / 2));
    for (const p of [...family.slice(0, half), ...general]) {
      if (seen.has(p.label)) continue;
      seen.add(p.label);
      out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }
  const safeDiv = (a: number | null, b: number | null): number | null =>
    a === null || b === null || b === 0 ? null : round(a / b, 2);
  const safePct = (a: number | null, b: number | null): number | null =>
    a === null || b === null || b === 0 ? null : round((a / b) * 100, 3);

  // Days worked drives Avg. and Tracking. If the strip is blank, derive it from the
  // RO Count row, whose Avg. is defined as count / days worked.
  const totalGroup = totalGroupEarly;

  // Days worked drives Avg. and Tracking. When the period strip is blank, recover it
  // from any count row whose Avg. is that count divided by days worked. The count row
  // is found by profile, not by a hardcoded "RO COUNT" label.
  let daysWorked = days?.daysWorked ?? 0;
  if (!daysWorked) {
    const sc = subColumns(totalGroup);
    if (sc.value !== null && sc.average !== null) {
      for (const p of profiles.filter((x) => x.kind === 'count')) {
        const r = rowByLabel.get(p.label);
        if (!r) continue;
        const v = parseCell(r[sc.value]).value;
        const a = parseCell(r[sc.average]).value;
        if (v === null || a === null || a === 0) continue;
        const implied = v / a;
        // Only believe it if it lands on a plausible whole number of days.
        if (implied >= 1 && implied <= 31 && Math.abs(implied - Math.round(implied)) < 0.02) {
          daysWorked = Math.round(implied);
          break;
        }
      }
    }
  }
  const effectiveDays: DayContext | null = days
    ? { ...days, daysWorked: days.daysWorked || daysWorked }
    : daysWorked
      ? { daysInMonth: 0, workingDays: 0, daysWorked, daysLeft: 0 }
      : null;

  const checks: ColumnCheck[] = [];

  for (const row of rows) {
    const label = (row[labelColumn] ?? '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    // Rate and per-unit rows are not a share of anything and are not projected, so
    // they are excluded from the % and Tracking checks. Determined from the label and
    // the rendered value rather than from a fixed list of metric names.
    const selfProfile = profiles.find((p) => p.label === label.toUpperCase());
    const isRate = selfProfile?.kind === 'rate';
    const totalValue = cellOf(label.toUpperCase(), totalGroup);

    for (const group of groups) {
      const sc = subColumns(group);
      const value = sc.value !== null ? parseCell(row[sc.value]).value : null;

      // --- % ---
      const pct = sc.percent !== null ? parseCell(row[sc.percent]).value : null;
      if (!isRate && value !== null && pct !== null) {
        // A percentage is either a share of the group total or a margin against a
        // related money row on the same grid.
        const moneyCandidates = denominatorCandidates(
          label,
          (p) => p.kind === 'currency',
          10,
        );
        const fitted = fitCandidates(
          pct,
          [
            { rule: 'value / total * 100 (share of total)', value: safePct(value, totalValue) },
            ...moneyCandidates.map((p) => ({
              rule: `value / ${p.label} * 100`,
              value: safePct(value, cellOf(p.label, group)),
            })),
          ],
          0.05,
        );
        checks.push({
          rowLabel: label,
          category: group as Category,
          column: 'percent',
          rule: fitted.rule,
          expected: fitted.expected,
          actual: pct,
          delta: fitted.delta,
          verdict: fitted.verdict,
          tolerance: 0.05,
          candidates: fitted.tried,
        });
      }

      // --- Avg. ---
      const avg = sc.average !== null ? parseCell(row[sc.average]).value : null;
      if (avg !== null && value !== null) {
        // An average is the value per unit of some count on the grid, or per day.
        // Count rows are discovered from the grid and ranked by label similarity, so a
        // parts row proposes the parts count ahead of an unrelated one.
        const countCandidates = denominatorCandidates(label, (p) => p.kind === 'count', 5);
        const fitted = fitCandidates(
          avg,
          [
            ...countCandidates.flatMap((p) => {
              const groupVal = cellOf(p.label, group);
              const totalVal = cellOf(p.label, totalGroup);
              const out = [
                { rule: `value / ${p.label} of group (${groupVal ?? '?'})`, value: safeDiv(value, groupVal) },
              ];
              // Some grids divide by the overall count rather than the group's own.
              if (group !== totalGroup) {
                out.push({
                  rule: `value / ${p.label} of total (${totalVal ?? '?'})`,
                  value: safeDiv(value, totalVal),
                });
              }
              return out;
            }),
            {
              rule: `value / days worked (${effectiveDays?.daysWorked ?? '?'})`,
              value: effectiveDays ? safeDiv(value, effectiveDays.daysWorked) : null,
            },
          ],
          0.02,
        );
        checks.push({
          rowLabel: label,
          category: group as Category,
          column: 'average',
          rule: fitted.rule,
          expected: fitted.expected,
          actual: avg,
          delta: fitted.delta,
          verdict: fitted.verdict,
          tolerance: 0.02,
          candidates: fitted.tried,
        });
      }

      // --- Tracking. Skipped without working days: deriving the multiplier from the
      // cell under test would be circular and always pass. ---
      const track = sc.tracking !== null ? parseCell(row[sc.tracking]).value : null;
      if (
        !isRate &&
        value !== null &&
        track !== null &&
        effectiveDays &&
        effectiveDays.daysWorked > 0 &&
        effectiveDays.workingDays > 0
      ) {
        const expected = round((value / effectiveDays.daysWorked) * effectiveDays.workingDays, 2);
        const delta = round(track - expected, 4);
        checks.push({
          rowLabel: label,
          category: group as Category,
          column: 'tracking',
          rule: `value / ${effectiveDays.daysWorked} * ${effectiveDays.workingDays}`,
          expected,
          actual: track,
          delta,
          verdict: Math.abs(delta) <= 0.05 ? 'pass' : 'fail',
          tolerance: 0.05,
        });
      }
    }
  }

  return {
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.verdict === 'pass').length,
      failed: checks.filter((c) => c.verdict === 'fail').length,
      skipped: 0,
    },
  };
}

export function validateColumns(
  rows: string[][],
  days: DayContext | null,
  rateMetrics: Set<string>,
  tolerance = 0.02,
): { checks: ColumnCheck[]; summary: { total: number; passed: number; failed: number; skipped: number } } {
  const rowByLabel = new Map<string, string[]>();
  for (const r of rows) {
    const l = (r[0] ?? '').replace(/\s+/g, ' ').trim();
    if (l && !rowByLabel.has(l.toUpperCase())) rowByLabel.set(l.toUpperCase(), r);
  }

  const checks: ColumnCheck[] = [];

  const cellOf = (label: string, category: Category): number | null => {
    const r = rowByLabel.get(label);
    return r ? parseCell(r[dmsCol(category, 'actual', 'value')]).value : null;
  };

  /**
   * Days worked drives the Avg. and Tracking rules. The strip that displays it
   * hydrates separately from the grid and is occasionally still blank at capture
   * time, so fall back to deriving it from the RO Count row: its Avg. is defined
   * as RO count / days worked.
   */
  let daysWorked = days?.daysWorked ?? 0;
  if (!daysWorked) {
    const roRowLocal = rowByLabel.get('RO COUNT');
    if (roRowLocal) {
      const v = parseCell(roRowLocal[dmsCol('total', 'actual', 'value')]).value;
      const a = parseCell(roRowLocal[dmsCol('total', 'actual', 'average')]).value;
      if (v !== null && a !== null && a !== 0) daysWorked = Math.round(v / a);
    }
  }
  const effectiveDays: DayContext | null = days
    ? { ...days, daysWorked: days.daysWorked || daysWorked }
    : daysWorked
      ? { daysInMonth: 0, workingDays: 0, daysWorked, daysLeft: 0 }
      : null;
  const safeDiv = (a: number | null, b: number | null): number | null =>
    a === null || b === null || b === 0 ? null : round(a / b, 2);
  const safePct = (a: number | null, b: number | null): number | null =>
    a === null || b === null || b === 0 ? null : round((a / b) * 100, 3);

  for (const row of rows) {
    const label = (row[0] ?? '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const isRate = rateMetrics.has(label.toUpperCase());
    const totalValue = parseCell(row[dmsCol('total', 'actual', 'value')]).value;

    for (const category of CATEGORIES) {
      const value = parseCell(row[dmsCol(category, 'actual', 'value')]).value;

      // --- % ---
      const pctActual = parseCell(row[dmsCol(category, 'actual', 'percent')]).value;
      if (!isRate && value !== null && pctActual !== null) {
        const fitted = fitCandidates(
          pctActual,
          [
            { rule: 'value / total * 100 (share of total)', value: safePct(value, totalValue) },
            { rule: 'value / LABOR SALES * 100 (margin)', value: safePct(value, cellOf('LABOR SALES', category)) },
            { rule: 'value / PARTS SALES * 100 (margin)', value: safePct(value, cellOf('PARTS SALES', category)) },
            {
              rule: 'value / LABOR SALES AFTER DISC. * 100 (margin)',
              value: safePct(value, cellOf('LABOR SALES AFTER DISC.', category)),
            },
            {
              rule: 'value / PARTS SALES AFTER DISCOUNT * 100 (margin)',
              value: safePct(value, cellOf('PARTS SALES AFTER DISCOUNT', category)),
            },
            // Cost rows express their percentage against Gross, not Sales.
            { rule: 'value / LABOR GROSS * 100', value: safePct(value, cellOf('LABOR GROSS', category)) },
            { rule: 'value / PARTS GROSS * 100', value: safePct(value, cellOf('PARTS GROSS', category)) },
            {
              rule: 'value / TOTAL LABOR GROSS * 100',
              value: safePct(value, cellOf('TOTAL LABOR GROSS', category)),
            },
            {
              rule: 'value / TOTAL PARTS GROSS * 100',
              value: safePct(value, cellOf('TOTAL PARTS GROSS', category)),
            },
            { rule: 'value / TOTAL SALES * 100', value: safePct(value, cellOf('TOTAL SALES', category)) },
            { rule: 'value / TOTAL GROSS * 100', value: safePct(value, cellOf('TOTAL GROSS', category)) },
          ],
          0.05,
        );
        checks.push({
          rowLabel: label,
          category,
          column: 'percent',
          rule: fitted.rule,
          expected: fitted.expected,
          actual: pctActual,
          delta: fitted.delta,
          verdict: fitted.verdict,
          tolerance: 0.05,
          candidates: fitted.tried,
        });
      }

      // --- AVG. ---
      const avgActual = parseCell(row[dmsCol(category, 'actual', 'average')]).value;
      if (avgActual !== null && value !== null) {
        const catRo = cellOf('RO COUNT', category);
        const totalRo = cellOf('RO COUNT', 'total');
        const partsRo = cellOf('PARTS R.O. COUNT', category);
        const fitted = fitCandidates(
          avgActual,
          [
            { rule: `value / RO count of pay type (${catRo ?? '?'})`, value: safeDiv(value, catRo) },
            {
              rule: `value / days worked (${effectiveDays?.daysWorked ?? '?'})`,
              value: effectiveDays ? safeDiv(value, effectiveDays.daysWorked) : null,
            },
            { rule: `value / PARTS RO count (${partsRo ?? '?'})`, value: safeDiv(value, partsRo) },
            { rule: `value / total RO count (${totalRo ?? '?'})`, value: safeDiv(value, totalRo) },
          ],
          0.02,
        );
        checks.push({
          rowLabel: label,
          category,
          column: 'average',
          rule: fitted.rule,
          expected: fitted.expected,
          actual: avgActual,
          delta: fitted.delta,
          verdict: fitted.verdict,
          tolerance: 0.02,
          candidates: fitted.tried,
        });
      }

      // --- TRACKING : month-end projection, volumes only ---
      const trackActual = parseCell(row[dmsCol(category, 'tracking', 'value')]).value;
      // Working days comes only from the days strip. If it is unavailable the check
      // is skipped rather than derived from the Tracking cell itself — deriving the
      // multiplier from the value under test would be circular and always pass.
      if (!isRate && value !== null && trackActual !== null && effectiveDays) {
        const dw = effectiveDays.daysWorked;
        const wd = effectiveDays.workingDays;
        if (dw > 0 && wd > 0) {
          const expected = round((value / dw) * wd, 2);
          const delta = round(trackActual - expected, 4);
          checks.push({
            rowLabel: label,
            category,
            column: 'tracking',
            rule: `value / ${dw} * ${wd}`,
            expected,
            actual: trackActual,
            delta,
            verdict: Math.abs(delta) <= 0.05 ? 'pass' : 'fail',
            tolerance: 0.05,
          });
        }
      }
    }
  }

  return {
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.verdict === 'pass').length,
      failed: checks.filter((c) => c.verdict === 'fail').length,
      skipped: 0,
    },
  };
}
