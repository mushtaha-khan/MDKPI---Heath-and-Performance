/**
 * Cover structure classification, comparison-mode selection and detail corroboration.
 *
 * The live screens only exercise part of this: every record listing the portal renders is
 * paginated, so the detail-assisted mode is always declined on real data. That is the
 * correct outcome, but it means the aggregation path itself would ship unrun — so a
 * complete listing is constructed here to exercise it, including a case where the records
 * do not reconcile with the summary they sit under.
 *
 * Usage: npx tsx scripts/test-structure.mjs
 */
import { runSuite } from '../src/core/suite.ts';
import { profileGrids } from '../src/core/pairing.ts';
import { classifyTables } from '../src/core/structure.ts';
import { findGrandTotalRow } from '../src/core/rows.ts';
import { normalizeTable } from '../src/core/rows.ts';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(60)} got ${JSON.stringify(actual)}${ok ? '' : `  expected ${JSON.stringify(expected)}`}`,
  );
  ok ? pass++ : fail++;
}

function table(header, rows, index = 0) {
  return {
    index,
    caption: '',
    headers: [header],
    headerGrid: [header],
    rowCount: rows.length,
    rows,
    footers: [],
  };
}

function capture(label, role, tables) {
  return {
    target: label,
    label,
    role,
    capturedAt: '2026-01-01T00:00:00.000Z',
    rendered: { tables },
    apiCalls: [],
  };
}

// ---------------------------------------------------------------------------
// 1. Grand-total detection must not mistake a metric row for the grand total
// ---------------------------------------------------------------------------
console.log('=== grand-total detection ===');

// A grid whose rows include TOTAL L&P SALES alongside LABOR SALES and PARTS SALES. The
// TOTAL row is one metric among peers, not the total of the grid.
const serviceLike = normalizeTable([
  ['LABOR SALES', '100'],
  ['PARTS SALES', '200'],
  ['TOTAL L&P SALES', '300'],
  ['LABOR GROSS', '40'],
]);
check('a metric beginning with TOTAL is not the grand total', findGrandTotalRow(serviceLike), null);

// A grid whose total row adds only the subject of the grid.
const bucketLike = normalizeTable([
  ['0-7 DAYS', '3'],
  ['8-15 DAYS', '13'],
  ['31+ DAYS', '6'],
  ['ALL OPEN ROS', '22'],
]);
check('a total naming only the grid subject is the grand total', findGrandTotalRow(bucketLike)?.label, 'ALL OPEN ROS');

const bareTotal = normalizeTable([['A', '1'], ['B', '2'], ['TOTAL', '3']]);
check('a bare TOTAL is the grand total', findGrandTotalRow(bareTotal)?.label, 'TOTAL');

// ---------------------------------------------------------------------------
// 2. Classification
// ---------------------------------------------------------------------------
console.log('\n=== classification ===');

const summaryTable = table(
  ['AGING BUCKET', 'OPEN RO COUNT', 'OPEN RO SALES'],
  [
    ['0-7 DAYS', '3', '$1,500.00'],
    ['8-15 DAYS', '13', '$380.00'],
    ['16-20 DAYS', '3', '$250.00'],
    ['ALL OPEN ROS', '19', '$2,130.00'],
  ],
);

// A record listing: descriptive columns, record-like labels, record headings, no total.
const listingRows = [];
for (let i = 1; i <= 19; i++) {
  listingRows.push([
    String(i),
    `23880${i} OPEN DATE: 09/0${(i % 9) + 1}/2026`,
    `CUSTOMER NUMBER ${i} PERSON NAME`,
    `201${i % 10} HONDA PILOT`,
    'SERVICE',
    'LISA KLARICH',
    `$${100 + i}.00`,
  ]);
}
const listingTable = table(
  ['S NO.', 'RO#', 'CUSTOMER INFO', 'VEHICLE INFO', 'DEPARTMENT', 'OPEN RO ADVISOR', 'TOTAL SALE'],
  listingRows,
  1,
);

const stripTable = table(['WORKING DAYS', 'DAYS WORKED', 'DAYS LEFT'], [['24', '7', '17']], 2);

const structures = classifyTables(profileGrids([summaryTable, listingTable, stripTable]));
check('roles classified', structures.map((s) => s.role), ['summary', 'detail', 'strip']);
check('row kinds classified', structures.map((s) => s.rowKind), ['metric', 'record', 'none']);
check('the summary total row was found', structures[0]?.totalRowLabel, 'ALL OPEN ROS');
check('the listing has no grand total', structures[1]?.hasTotalRow, false);
check('19 rows is not flagged as a page size', structures[1]?.pageSize, null);
check('classification is confident', structures.every((s) => s.confidence >= 0.7), true);

// ---------------------------------------------------------------------------
// 3. Mode: a complete listing is aggregated
// ---------------------------------------------------------------------------
console.log('\n=== detail-assisted mode, complete listing ===');

// Summary count total is 19 and the listing holds 19 records, so it is complete.
// Sum of TOTAL SALE = sum(101..119) = 2090... check: (101+119)*19/2 = 2090.
const agSummary = table(
  ['AGING BUCKET', 'OPEN RO COUNT', 'OPEN RO SALES'],
  [
    ['0-7 DAYS', '3', '$300.00'],
    ['8-15 DAYS', '13', '$1,500.00'],
    ['16-20 DAYS', '3', '$290.00'],
    ['ALL OPEN ROS', '19', '$2,090.00'],
  ],
);

const complete = runSuite(
  capture('AutoGroup', 'AUTOGROUP', [agSummary]),
  capture('DMS', 'DEALER', [{ ...agSummary, index: 0 }, listingTable]),
  { name: 'Complete Detail' },
);

check('mode escalated to detail-assisted', complete.mode.mode, 'detail-assisted');
check('one detail view found', complete.mode.detailViews.length, 1);
check('the listing was judged complete', complete.mode.detailViews[0]?.usable, true);
check('records matched the summary count', complete.mode.detailViews[0]?.expectedRecords, 19);
check('corroboration was produced', complete.mode.corroboration.length, 1);

const saleCheck = complete.mode.corroboration[0]?.checks.find((k) => /SALE/.test(k.detailColumn));
check('the records sum to the summary total', saleCheck?.aggregate, 2090);
check('and that reconciles', saleCheck?.verdict, 'match');
check('the cross-screen comparison is still clean', complete.summary.mismatched, 0);

// ---------------------------------------------------------------------------
// 4. Mode: a paginated listing is declined, not aggregated into a false difference
// ---------------------------------------------------------------------------
console.log('\n=== paginated listing is declined ===');

// Same listing, but the summary says 29 records exist. Aggregating 19 of 29 would report a
// shortfall that is purely a display limit.
const agSaysMore = table(
  ['AGING BUCKET', 'OPEN RO COUNT', 'OPEN RO SALES'],
  [
    ['0-7 DAYS', '3', '$300.00'],
    ['8-15 DAYS', '13', '$1,500.00'],
    ['16-20 DAYS', '13', '$1,290.00'],
    ['ALL OPEN ROS', '29', '$3,090.00'],
  ],
);

const paginated = runSuite(
  capture('AutoGroup', 'AUTOGROUP', [agSaysMore]),
  capture('DMS', 'DEALER', [{ ...agSaysMore, index: 0 }, listingTable]),
  { name: 'Paginated Detail' },
);

check('mode stayed at summary-vs-summary', paginated.mode.mode, 'summary-vs-summary');
check('the listing was declined', paginated.mode.detailViews[0]?.usable, false);
check('no corroboration was attempted', paginated.mode.corroboration.length, 0);
check('nothing was counted as a difference', paginated.summary.mismatched, 0);
check(
  'the reason names the record shortfall',
  /shows 19 record\(s\) but the summary reports 29/.test(paginated.mode.detailViews[0]?.why ?? ''),
  true,
);

// ---------------------------------------------------------------------------
// 5. A genuine disagreement between a summary and its own records is reported
// ---------------------------------------------------------------------------
console.log('\n=== summary that disagrees with its own records ===');

// Complete listing (19 of 19), but the summary claims $9,999 of sales against records
// summing to $2,090. This is a real inconsistency and must be reported as one.
const agWrongTotal = table(
  ['AGING BUCKET', 'OPEN RO COUNT', 'OPEN RO SALES'],
  [
    ['0-7 DAYS', '3', '$300.00'],
    ['8-15 DAYS', '13', '$1,500.00'],
    ['16-20 DAYS', '3', '$290.00'],
    ['ALL OPEN ROS', '19', '$9,999.00'],
  ],
);

const inconsistent = runSuite(
  capture('AutoGroup', 'AUTOGROUP', [agWrongTotal]),
  capture('DMS', 'DEALER', [{ ...agWrongTotal, index: 0 }, listingTable]),
  { name: 'Inconsistent Detail' },
);

const badCheck = inconsistent.mode.corroboration[0]?.checks.find((k) => /SALE/.test(k.detailColumn));
check('the aggregate was still computed', badCheck?.aggregate, 2090);
check('and reported as not reconciling', badCheck?.verdict, 'mismatch');
check(
  'while the cross-screen comparison stays clean, because both screens show the same wrong total',
  inconsistent.summary.mismatched,
  0,
);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
