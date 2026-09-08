/**
 * Field mapping between AutoGroup v2 Service Summary and the DMS Service Dashboard.
 *
 * ---------------------------------------------------------------------------------------
 * MOSTLY SUPERSEDED. Only three symbols in this file are still used:
 *
 *     CATEGORIES, dmsCol, type Category      — by formulas.ts, for formula validation
 *
 * Everything else — AUTOGROUP_ACTUAL_COL, DMS_ACTUAL_COL, AUTOGROUP_TRACKING_COL,
 * DMS_BLOCK_OFFSET, DMS_MEASURE_OFFSET, METRIC_MAP, DMS_ONLY_ROWS, AUTOGROUP_ONLY_ROWS,
 * SECTION_HEADERS, MARGIN_PERCENT_ROWS, RATE_METRICS and the rest — is the hardcoded
 * column-offset model that `columns.ts` replaced. It is retained only because it
 * documents the layout these two screens had when the offsets were verified.
 *
 * Do not build on it. The engine derives column geometry from each grid's own
 * colspan-expanded header (see columns.ts, which explains why fixed offsets only ever
 * worked for one module). A fixed metric list cannot describe a module it has not seen.
 * ---------------------------------------------------------------------------------------
 *
 * The two screens use different metric labels and very different column layouts, so
 * the mapping is explicit rather than inferred. Column indices below were verified
 * against live captures under `artifacts/capture/<target>/capture.json`.
 *
 * Scope: option A — same single dealer on both sides (autoDealerIds:[1]).
 */
import type { MetricKind } from './normalize.js';

export type Category = 'total' | 'customerPay' | 'warranty' | 'internal';

export const CATEGORIES: Category[] = ['total', 'customerPay', 'warranty', 'internal'];

export const CATEGORY_LABELS: Record<Category, string> = {
  total: 'Total',
  customerPay: 'Customer Pay',
  warranty: 'Warranty',
  internal: 'Internal',
};

/**
 * Index of the ACTUAL cell for each category.
 *
 * AutoGroup row shape: [metric, ACTUAL, TRACKING, %VS TRK, '', ...repeat per category]
 *   -> 4-column stride, actual at 1, 5, 9, 13
 *
 * DMS row shape: [metric, '', ACTUAL, %, AVG, '', TRACKING.., '', BUDGET.., '', VARIANCE..]
 *   -> 16-column stride, actual at 2, 18, 34, 50
 */
export const AUTOGROUP_ACTUAL_COL: Record<Category, number> = {
  total: 1,
  customerPay: 5,
  warranty: 9,
  internal: 13,
};

export const DMS_ACTUAL_COL: Record<Category, number> = {
  total: 2,
  customerPay: 18,
  warranty: 34,
  internal: 50,
};

/** AutoGroup's TRACKING column, used to sanity-check the projection logic. */
export const AUTOGROUP_TRACKING_COL: Record<Category, number> = {
  total: 2,
  customerPay: 6,
  warranty: 10,
  internal: 14,
};

/**
 * Start index of each category's 16-column block in the DMS metric table.
 * Each block holds four measures (Actual, Tracking, Budget, Variance), and each
 * measure renders three cells (value, %, AVG.).
 */
export const DMS_BLOCK_OFFSET: Record<Category, number> = {
  total: 2,
  customerPay: 18,
  warranty: 34,
  internal: 50,
};

export type Measure = 'actual' | 'tracking' | 'budget' | 'variance';

export const MEASURES: Measure[] = ['actual', 'tracking', 'budget', 'variance'];

/** Offset of each measure within a category block. */
export const DMS_MEASURE_OFFSET: Record<Measure, number> = {
  actual: 0,
  tracking: 4,
  budget: 8,
  variance: 12,
};

/** Offset of each sub-cell within a measure. */
export const DMS_SUBCELL_OFFSET = { value: 0, percent: 1, average: 2 } as const;

export type SubCell = keyof typeof DMS_SUBCELL_OFFSET;

/** Absolute column index for a given category / measure / sub-cell. */
export function dmsCol(category: Category, measure: Measure, sub: SubCell): number {
  return DMS_BLOCK_OFFSET[category] + DMS_MEASURE_OFFSET[measure] + DMS_SUBCELL_OFFSET[sub];
}

/**
 * Metrics whose values are rates or per-unit figures rather than volumes.
 * These are NOT scaled up in the TRACKING projection, and a share-of-total
 * percentage is not meaningful for them.
 */
export const RATE_METRICS = new Set([
  'ELR',
  'SALES PER HRS. SOLD',
  'GROSS PER HRS. SOLD',
  'AVERAGE MONTHLY HOURS PER TECH',
  'AVERAGE DAILY HOURS PER TECH',
  'AVG.MONTHLY CLOCKED HRS. PER TECH',
  'AVG. DAILY CLOCKED HRS. PER TECH',
  '(LIFT) HRS. PER LIFT PER MONTH',
  '(LIFT) HRS. PER LIFT PER DAY',
]);

/** Rows whose percentage is a margin (value / sales) rather than a share of total. */
export const MARGIN_PERCENT_ROWS = new Set([
  'LABOR GROSS',
  'PARTS GROSS',
  'LABOR COST',
  'PARTS COST',
]);

export interface MetricMap {
  /** Stable id used in reports. */
  id: string;
  /** Row label as rendered on the AutoGroup Service Summary. */
  autogroup: string;
  /** Row label as rendered on the DMS Service Dashboard. */
  dms: string;
  kind: MetricKind;
  /** Override the default tolerance for this metric. */
  tolerance?: number;
  /** Categories this metric is meaningful for. Defaults to all four. */
  categories?: Category[];
  notes?: string;
}

/**
 * The comparison contract.
 *
 * Only metrics that exist on both screens are listed. DMS carries many additional
 * rows (body shop, wholesale, tires, GOG, tax) that AutoGroup Service Summary does
 * not render at all — those are reported separately as unmapped rather than as
 * failures.
 */
export const METRIC_MAP: MetricMap[] = [
  // --- Labor ---
  { id: 'ro_count', autogroup: 'RO COUNT', dms: 'RO COUNT', kind: 'count' },
  { id: 'op_code_count', autogroup: 'OP CODE COUNT', dms: 'OP CODE COUNT', kind: 'count' },
  { id: 'elr', autogroup: 'ELR', dms: 'ELR', kind: 'rate' },
  { id: 'hours_flagged', autogroup: 'HOURS FLAGGED', dms: 'HRS. FLAGGED', kind: 'hours' },
  { id: 'labor_sales', autogroup: 'LABOR SALES', dms: 'LABOR SALES', kind: 'currency' },
  {
    id: 'labor_discount',
    autogroup: 'LABOR DISCOUNT',
    dms: 'LABOR DISC.',
    kind: 'currency',
    notes: 'Sign convention differs: DMS renders discounts negative.',
  },
  {
    id: 'labor_sales_after_disc',
    autogroup: 'LABOR SALES AFTER DISC.',
    dms: 'LABOR SALES AFTER DISC.',
    kind: 'currency',
  },
  {
    id: 'sublet_repairs_sales',
    autogroup: 'SUBLET REPAIRS SALES',
    dms: 'SUBLET REPAIRS SALES',
    kind: 'currency',
  },
  { id: 'labor_cost', autogroup: 'LABOR COST', dms: 'LABOR COST', kind: 'currency' },
  { id: 'labor_gross', autogroup: 'LABOR GROSS', dms: 'LABOR GROSS', kind: 'currency' },

  // --- Parts ---
  {
    id: 'parts_ro_count',
    autogroup: 'PARTS R.O. COUNT',
    dms: 'PARTS R.O. COUNT',
    kind: 'count',
  },
  { id: 'parts_sales', autogroup: 'PARTS SALES', dms: 'PARTS SALES', kind: 'currency' },
  {
    id: 'parts_discount',
    autogroup: 'PARTS DISCOUNT',
    dms: 'PARTS DISC',
    kind: 'currency',
    notes: 'Sign convention differs: DMS renders discounts negative.',
  },
  { id: 'parts_cost', autogroup: 'PARTS COST', dms: 'PARTS COST', kind: 'currency' },
  { id: 'parts_gross', autogroup: 'PARTS GROSS', dms: 'PARTS GROSS', kind: 'currency' },

  // --- Totals ---
  {
    id: 'total_lp_sales',
    autogroup: 'TOTAL L&P SALES',
    dms: 'SUB-TOTAL L&P SALES',
    kind: 'currency',
    notes:
      'DEFINITIONAL DIFFERENCE, not purely a data gap. Verified from the captures: ' +
      'AutoGroup = labor sales + parts sales (excludes sublet). ' +
      'DMS = labor after discount + sublet + parts after discount. ' +
      'Confirm the intended composition before treating this delta as a defect.',
  },
  {
    id: 'total_lp_gross',
    autogroup: 'TOTAL L&P GROSS',
    dms: 'SUB-TOTAL L&P GROSS',
    kind: 'currency',
    notes: 'Inherits the same composition question as TOTAL L&P SALES.',
  },
  {
    id: 'total_lp_cost',
    autogroup: 'TOTAL L&P COST',
    dms: 'TOTAL L&P COST',
    kind: 'currency',
  },
];

/** DMS rows with no AutoGroup counterpart — informational, not failures. */
export const DMS_ONLY_ROWS = [
  'TOTAL LABOR SALES',
  'SALES PER HRS. SOLD',
  'SUBLET REPAIRS GROSS',
  'UNAPPLIED LABOR',
  'TOTAL LABOR GROSS',
  'GROSS PER HRS. SOLD',
  'SALES PER LIFT PER MONTH',
  'GROSS PER LIFT PER MONTH',
  '(LIFT) HRS. PER LIFT PER MONTH',
  '(LIFT) HRS. PER LIFT PER DAY',
  'TECH. HRS.',
  'TECH CLOCKED. HRS. & EFFICIENCY',
  'AVERAGE MONTHLY HOURS PER TECH',
  'AVERAGE DAILY HOURS PER TECH',
  'EXPRESS SERVICE SALES',
  'BODY SHOP SALES',
  'PARTS SALES AFTER DISCOUNT',
  'TOTAL PARTS GROSS',
  'COUNTER RETAIL SALES',
  'WHOLESALE COLLISION SALES',
  'WHOLESALE MECHANICAL SALES',
  'STOCK ORDER DISCOUNT',
  'PURCHASE ALLOWANCE',
  'MISCELLANEOUS SALES',
  'TOTAL TAX',
  'TOTAL ALL PARTS ACCESSORIES SALES',
  'TOTAL SALES',
  'TOTAL GROSS',
  'TOTAL COST',
  'TOTAL DISC.',
];

/** AutoGroup rows with no DMS counterpart. */
export const AUTOGROUP_ONLY_ROWS = ['DISCOUNT %'];

/** Section headers in the AutoGroup table — not data rows. */
export const SECTION_HEADERS = ['LABOR', 'PARTS', 'TOTALS'];
