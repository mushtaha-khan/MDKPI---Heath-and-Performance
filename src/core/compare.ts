/**
 * Reconciliation engine: AutoGroup Service Summary vs DMS Service Dashboard.
 *
 * Consumes the JSON produced by scripts/capture-screens.mjs so a comparison can be
 * re-run and audited without touching the portal again.
 */
import {
  compareValues,
  defaultTolerance,
  formatValue,
  parseCell,
  type MetricKind,
  type ParsedValue,
  type Verdict,
} from './normalize.js';
import {
  AUTOGROUP_ACTUAL_COL,
  CATEGORIES,
  CATEGORY_LABELS,
  DMS_ACTUAL_COL,
  METRIC_MAP,
  SECTION_HEADERS,
  type Category,
  type MetricMap,
} from './mapping.js';

export interface CapturedTable {
  index: number;
  headers: string[][];
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
  rendered?: { tables: CapturedTable[] };
  apiCalls?: Array<{
    method: string;
    url: string;
    status: number;
    requestBody: string | null;
  }>;
}

export interface CellResult {
  category: Category;
  categoryLabel: string;
  left: ParsedValue;
  right: ParsedValue;
  delta: number | null;
  verdict: Verdict;
  tolerance: number;
}

export interface MetricResult {
  id: string;
  autogroupLabel: string;
  dmsLabel: string;
  kind: MetricKind;
  notes?: string;
  cells: CellResult[];
  /** True when every category matched. */
  passed: boolean;
}

export interface ComparisonReport {
  generatedAt: string;
  scope: string;
  left: { label: string; role: string; url?: string; capturedAt: string };
  right: { label: string; role: string; url?: string; capturedAt: string };
  dateRange: {
    autogroup: string | null;
    dms: string | null;
    aligned: boolean;
    note: string;
  };
  metrics: MetricResult[];
  unmappedAutogroupRows: string[];
  unmappedDmsRows: string[];
  summary: {
    totalCells: number;
    matched: number;
    mismatched: number;
    missing: number;
    metricsPassed: number;
    metricsFailed: number;
    byCategory: Record<Category, { matched: number; mismatched: number; missing: number }>;
  };
}

/** Locate a row by its first-cell label, case/whitespace insensitive. */
function findRow(rows: string[][], label: string): string[] | undefined {
  const want = label.replace(/\s+/g, ' ').trim().toUpperCase();
  return rows.find((r) => (r[0] ?? '').replace(/\s+/g, ' ').trim().toUpperCase() === want);
}

/**
 * Pick the metric table out of a capture.
 *
 * Identified by structure rather than index: the metric grid is the table whose
 * header row mentions both CUSTOMER PAY and WARRANTY.
 */
export function findMetricTable(capture: Capture): CapturedTable {
  const tables = capture.rendered?.tables ?? [];
  const match = tables.find((t) => {
    const flat = t.headers.flat().join(' ').toUpperCase();
    return flat.includes('CUSTOMER PAY') && flat.includes('WARRANTY');
  });
  if (!match) {
    throw new Error(
      `No metric table found in capture "${capture.target}". ` +
        `Tables seen: ${tables.map((t) => `[${t.index}] rows=${t.rowCount}`).join(', ') || 'none'}`,
    );
  }
  return match;
}

/** Extract the date range each screen actually requested, from its API payload. */
function extractDateRange(capture: Capture): string | null {
  for (const call of capture.apiCalls ?? []) {
    if (call.requestBody) {
      try {
        const body = JSON.parse(call.requestBody);
        if (body.startDate && body.endDate) return `${body.startDate} to ${body.endDate}`;
      } catch {
        /* encrypted or non-JSON payload — skip */
      }
    }
    const m = call.url.match(/startDate=([\d-]+).*?endDate=([\d-]+)/);
    if (m) return `${m[1]} to ${m[2]}`;
  }
  return null;
}

function normalizeDate(s: string): string {
  // "2026-9-1" and "2026-09-01" denote the same day.
  return s.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (_, y, mo, d) =>
    `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  );
}

export function compare(autogroup: Capture, dms: Capture): ComparisonReport {
  const agTable = findMetricTable(autogroup);
  const dmsTable = findMetricTable(dms);

  const agRange = extractDateRange(autogroup);
  const dmsRange = extractDateRange(dms);
  const aligned =
    agRange !== null && dmsRange !== null && normalizeDate(agRange) === normalizeDate(dmsRange);

  const metrics: MetricResult[] = [];

  for (const map of METRIC_MAP) {
    const agRow = findRow(agTable.rows, map.autogroup);
    const dmsRow = findRow(dmsTable.rows, map.dms);
    const tolerance = map.tolerance ?? defaultTolerance(map.kind);
    const cats = map.categories ?? CATEGORIES;

    const cells: CellResult[] = cats.map((category) => {
      const left = parseCell(agRow?.[AUTOGROUP_ACTUAL_COL[category]]);
      const right = parseCell(dmsRow?.[DMS_ACTUAL_COL[category]]);

      // Discounts: AutoGroup renders magnitude, DMS renders signed negative.
      // Compare magnitudes so a pure sign convention difference is not a defect.
      const isDiscount = map.id.endsWith('_discount');
      const l = isDiscount && left.value !== null ? { ...left, value: Math.abs(left.value) } : left;
      const r =
        isDiscount && right.value !== null ? { ...right, value: Math.abs(right.value) } : right;

      const cmp = compareValues(l, r, tolerance);
      return {
        category,
        categoryLabel: CATEGORY_LABELS[category],
        left,
        right,
        delta: cmp.delta,
        verdict: cmp.verdict,
        tolerance,
      };
    });

    metrics.push({
      id: map.id,
      autogroupLabel: map.autogroup,
      dmsLabel: map.dms,
      kind: map.kind,
      notes: map.notes,
      cells,
      passed: cells.every((c) => c.verdict === 'match'),
    });
  }

  // Rows present on screen but not in the mapping — surfaced for review, not failed.
  const mappedAg = new Set(METRIC_MAP.map((m) => m.autogroup.toUpperCase()));
  const mappedDms = new Set(METRIC_MAP.map((m) => m.dms.toUpperCase()));
  const skip = new Set(SECTION_HEADERS.map((s) => s.toUpperCase()));

  const unmappedAutogroupRows = agTable.rows
    .map((r) => (r[0] ?? '').trim())
    .filter((l) => l && !mappedAg.has(l.toUpperCase()) && !skip.has(l.toUpperCase()));

  const unmappedDmsRows = dmsTable.rows
    .map((r) => (r[0] ?? '').trim())
    .filter((l) => l && !mappedDms.has(l.toUpperCase()) && !skip.has(l.toUpperCase()));

  // Summary
  const byCategory = Object.fromEntries(
    CATEGORIES.map((c) => [c, { matched: 0, mismatched: 0, missing: 0 }]),
  ) as Record<Category, { matched: number; mismatched: number; missing: number }>;

  let matched = 0;
  let mismatched = 0;
  let missing = 0;

  for (const m of metrics) {
    for (const c of m.cells) {
      if (c.verdict === 'match') {
        matched++;
        byCategory[c.category].matched++;
      } else if (c.verdict === 'mismatch') {
        mismatched++;
        byCategory[c.category].mismatched++;
      } else {
        missing++;
        byCategory[c.category].missing++;
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    scope: 'Option A — single dealer, same dealer on both sides',
    left: {
      label: autogroup.label,
      role: autogroup.role,
      url: autogroup.finalUrl,
      capturedAt: autogroup.capturedAt,
    },
    right: {
      label: dms.label,
      role: dms.role,
      url: dms.finalUrl,
      capturedAt: dms.capturedAt,
    },
    dateRange: {
      autogroup: agRange,
      dms: dmsRange,
      aligned,
      note: aligned
        ? 'Both screens requested the same range.'
        : 'Ranges differ. AutoGroup ACTUAL is month-to-date despite requesting the full month; ' +
          'its TRACKING column is the month-end projection.',
    },
    metrics,
    unmappedAutogroupRows,
    unmappedDmsRows,
    summary: {
      totalCells: matched + mismatched + missing,
      matched,
      mismatched,
      missing,
      metricsPassed: metrics.filter((m) => m.passed).length,
      metricsFailed: metrics.filter((m) => !m.passed).length,
      byCategory,
    },
  };
}

/** Render the report as Markdown. */
export function toMarkdown(r: ComparisonReport): string {
  const L: string[] = [];
  const pct = (n: number, d: number) => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1));

  L.push('# Service Summary vs Service Dashboard — Reconciliation');
  L.push('');
  L.push(`Generated: ${r.generatedAt}`);
  L.push(`Scope: ${r.scope}`);
  L.push('');
  L.push('| | Left | Right |');
  L.push('|---|---|---|');
  L.push(`| Screen | ${r.left.label} | ${r.right.label} |`);
  L.push(`| Role | ${r.left.role} | ${r.right.role} |`);
  L.push(`| Date range | ${r.dateRange.autogroup ?? 'unknown'} | ${r.dateRange.dms ?? 'unknown'} |`);
  L.push('');

  if (!r.dateRange.aligned) {
    L.push(`> **Date ranges are not identical.** ${r.dateRange.note}`);
    L.push('');
  }

  const s = r.summary;
  L.push('## Summary');
  L.push('');
  L.push(`- Cells compared: **${s.totalCells}**`);
  L.push(`- Matched: **${s.matched}** (${pct(s.matched, s.totalCells)}%)`);
  L.push(`- Mismatched: **${s.mismatched}** (${pct(s.mismatched, s.totalCells)}%)`);
  L.push(`- Missing on one side: **${s.missing}**`);
  L.push(`- Metrics fully clean: **${s.metricsPassed}/${s.metricsPassed + s.metricsFailed}**`);
  L.push('');
  L.push('| Category | Matched | Mismatched | Missing |');
  L.push('|---|---|---|---|');
  for (const c of CATEGORIES) {
    const b = s.byCategory[c];
    L.push(`| ${CATEGORY_LABELS[c]} | ${b.matched} | ${b.mismatched} | ${b.missing} |`);
  }
  L.push('');

  L.push('## Mismatches');
  L.push('');
  const bad = r.metrics.filter((m) => !m.passed);
  if (!bad.length) {
    L.push('None.');
  } else {
    L.push('| Metric | Category | AutoGroup | DMS | Delta | Tol |');
    L.push('|---|---|---|---|---|---|');
    for (const m of bad) {
      for (const c of m.cells) {
        if (c.verdict === 'match') continue;
        L.push(
          `| ${m.autogroupLabel} | ${c.categoryLabel} | ${c.left.raw || '—'} | ${c.right.raw || '—'} | ` +
            `${c.delta === null ? '—' : formatValue(c.delta, m.kind)} | ${c.tolerance} |`,
        );
      }
    }
  }
  L.push('');

  L.push('## All metrics');
  L.push('');
  L.push('| Metric | Total | Customer Pay | Warranty | Internal |');
  L.push('|---|---|---|---|---|');
  const mark = (v: Verdict) => (v === 'match' ? 'OK' : v === 'mismatch' ? 'DIFF' : 'n/a');
  for (const m of r.metrics) {
    const cells = CATEGORIES.map((c) => {
      const cell = m.cells.find((x) => x.category === c);
      return cell ? mark(cell.verdict) : 'n/a';
    });
    L.push(`| ${m.autogroupLabel} | ${cells.join(' | ')} |`);
  }
  L.push('');

  if (r.unmappedDmsRows.length) {
    L.push('## DMS rows with no AutoGroup counterpart');
    L.push('');
    L.push(r.unmappedDmsRows.map((x) => `\`${x}\``).join(', '));
    L.push('');
  }
  if (r.unmappedAutogroupRows.length) {
    L.push('## AutoGroup rows with no DMS counterpart');
    L.push('');
    L.push(r.unmappedAutogroupRows.map((x) => `\`${x}\``).join(', '));
    L.push('');
  }

  return L.join('\n');
}
