/**
 * Exercise the segment-by-segment comparison, which real captures do not yet reach.
 *
 * Both live screens only ever have the breakdown on the DMS side, so the "breakdown on
 * both screens" path would otherwise ship unrun. These synthetic grids put the breakdown
 * on both sides and are built so that:
 *
 *   - every TOTAL agrees, proving a segment disagreement never leaks into the total count
 *   - two segment cells disagree, proving segments really are compared individually
 *   - one screen spells its segments out ("Customer Pay") while the other abbreviates
 *     them ("C"), proving segments are keyed canonically before being paired
 *   - one screen has a SUBLET segment the other lacks, proving a missing segment is
 *     reported as missing rather than as a difference
 *
 * Usage: npx tsx scripts/test-breakdown.mjs
 */
import { runSuite } from '../src/core/suite.ts';

const HEADER = [
  ['', '', 'LABOR', 'LABOR', 'PARTS'],
  ['TECHNICIAN', 'PAY TYPE', 'RO COUNT', 'LABOR SALE', 'PARTS SALE'],
];

function table(rows) {
  return {
    index: 0,
    caption: 'Technician detail',
    headers: HEADER,
    headerGrid: HEADER,
    rowCount: rows.length,
    rows,
    footers: [],
  };
}

function capture(label, role, rows) {
  return {
    target: label,
    label,
    role,
    capturedAt: '2026-01-01T00:00:00.000Z',
    rendered: { tables: [table(rows)] },
    apiCalls: [{ method: 'POST', url: '/x', status: 200, requestBody: JSON.stringify({ startDate: '2026-01-01', endDate: '2026-01-31' }) }],
  };
}

// AutoGroup: segments spelled out. PARTS SALE for ALICE: 205 + 75 + 20 = 300.
const leftRows = [
  ['ALICE SMITH', 'Customer Pay', '5', '1000', '205'],
  ['', 'Warranty', '2', '400', '75'],
  ['', 'Internal', '1', '100', '20'],
  ['', 'TOTAL', '8', '1500', '300'],
  ['BOB JONES', 'Customer Pay', '4', '800', '150'],
  ['', 'Warranty', '3', '600', '90'],
  ['', 'Internal', '1', '100', '10'],
  ['', 'TOTAL', '8', '1500', '250'],
  ['CARL WHITE', 'Customer Pay', '6', '1200', '300'],
  ['', 'Warranty', '1', '200', '40'],
  ['', 'Internal', '2', '150', '30'],
  ['', 'TOTAL', '9', '1550', '370'],
];

// DMS: segments abbreviated. Same TOTALs throughout, but ALICE's split differs
// (200/80 against 205/75) and CARL carries an extra SUBLET segment.
const rightRows = [
  ['ALICE SMITH', 'C', '5', '1000', '200'],
  ['', 'W', '2', '400', '80'],
  ['', 'I', '1', '100', '20'],
  ['', 'TOTAL', '8', '1500', '300'],
  ['BOB JONES', 'C', '4', '800', '150'],
  ['', 'W', '3', '600', '90'],
  ['', 'I', '1', '100', '10'],
  ['', 'TOTAL', '8', '1500', '250'],
  ['CARL WHITE', 'C', '6', '1200', '300'],
  ['', 'W', '1', '200', '40'],
  ['', 'I', '2', '150', '30'],
  ['', 'S', '1', '0', '0'],
  ['', 'TOTAL', '9', '1550', '370'],
];

const result = runSuite(
  capture('AutoGroup', 'AUTOGROUP', leftRows),
  capture('DMS', 'DEALER', rightRows),
  { name: 'Synthetic Breakdown' },
);

const g = result.grids[0];
const bk = g.breakdown;
const sc = bk.segmentComparison;

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(52)} got ${JSON.stringify(actual)}${ok ? '' : `  expected ${JSON.stringify(expected)}`}`,
  );
  ok ? pass++ : fail++;
}

console.log('--- structure ---');
console.log(`left  labelColumn=${g.geometry.left.labelColumn}  segments=${JSON.stringify(bk.leftSegments)}`);
console.log(`right labelColumn=${g.geometry.right.labelColumn} segments=${JSON.stringify(bk.rightSegments)}`);
console.log(`rows aligned: ${g.coverage.matched} entity pair(s), columns compared: ${g.coverageStats.comparedColumns}`);
console.log('--- assertions ---');

check('breakdown seen on both screens', bk.availability, 'both');
check('all three technicians paired on their totals', g.coverage.matched, 3);
check('totals: no differences', g.summary.mismatched, 0);
check('totals: nothing missing', g.summary.missing, 0);
check('segment comparison was produced', sc !== null, true);
check('segment row pairs compared', sc?.rowPairs, 9);
check('segment cells differing', sc?.mismatched, 2);
check('SUBLET flagged as present on the right only', sc?.segmentsOnlyOnRight, ['SUBLET']);
check('no segment claimed as left-only', sc?.segmentsOnlyOnLeft, []);
check('module rollup counts the segment differences', result.summary.breakdown.segmentMismatched, 2);
check('module rollup keeps totals clean', result.summary.mismatched, 0);
check('shape warning suppressed', g.shape.warning, null);

const diffs = (sc?.outcomes ?? [])
  .flatMap((o) => o.cells.filter((c) => c.verdict !== 'match').map((c) => `${o.entity} / ${o.segment} / ${c.column}: ${c.left.raw} vs ${c.right.raw}`));
console.log('--- segment differences found ---');
diffs.forEach((d) => console.log(`  ${d}`));
check(
  'the two differences are ALICE customer-pay and warranty parts',
  diffs,
  ['ALICE SMITH / CUSTOMER PAY / PARTS SALE: 205 vs 200', 'ALICE SMITH / WARRANTY / PARTS SALE: 75 vs 80'],
);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
