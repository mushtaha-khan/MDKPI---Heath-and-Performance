/**
 * Cover the grid-alignment paths that the live captures reach only rarely or not at all:
 * pivoting a transposed strip, resolving an ambiguous column mapping from values, pairing
 * a differently-worded grand-total row, and reporting a failure to align instead of
 * throwing.
 *
 * The transposed case is modelled on the real Open RO screens, where AutoGroup lists the
 * aging buckets down its rows and DMS spreads them across the header of a one-row strip.
 *
 * Usage: npx tsx scripts/test-alignment.mjs
 */
import { runSuite } from '../src/core/suite.ts';
import { maybeTranspose } from '../src/core/transpose.ts';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(58)} got ${JSON.stringify(actual)}${ok ? '' : `  expected ${JSON.stringify(expected)}`}`,
  );
  ok ? pass++ : fail++;
}

function table(header, rows, caption = '') {
  return {
    index: 0,
    caption,
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
    rendered: { tables: tables.map((t, i) => ({ ...t, index: i })) },
    apiCalls: [
      {
        method: 'POST',
        url: '/x',
        status: 200,
        requestBody: JSON.stringify({ startDate: '2026-01-01', endDate: '2026-01-31' }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Transposed strip
// ---------------------------------------------------------------------------
console.log('=== transposed strip (Open RO shape) ===');

// AutoGroup: buckets down the rows. Note the deliberately awkward extra columns —
// "% OF COUNT" is a *perfect* token match for a bare "COUNT", and "AVG GROSS / RO" is
// exactly as similar to "GROSS" as "OPEN RO GROSS" is. Names alone cannot resolve either.
const agOpenRo = table(
  ['AGING BUCKET', 'OPEN RO COUNT', '% OF COUNT', 'OPEN RO SALES', 'OPEN RO GROSS', 'AVG GROSS / RO'],
  [
    ['0-7 DAYS', '3', '10.3%', '$1,523.93', '$1,523.93', '$507.98'],
    ['8-15 DAYS', '13', '44.8%', '$380.00', '$380.00', '$29.23'],
    ['16-20 DAYS', '3', '10.3%', '$249.95', '$249.95', '$83.32'],
    ['21-30 DAYS', '4', '13.8%', '$34.00', '$34.00', '$8.50'],
    ['31+ DAYS', '6', '20.7%', '$111.78', '$111.78', '$18.63'],
    ['ALL OPEN ROS', '29', '100.0%', '$2,299.66', '$2,299.66', '$79.30'],
  ],
);

// DMS: the same figures as one row, buckets across the header, blank spacer columns
// between blocks, and the grand total labelled just "ALL".
const dmsOpenRo = table(
  [
    '0-7 DAYS', 'SALES', 'GROSS', '',
    '8-15 DAYS', 'SALES', 'GROSS', '',
    '16-20 DAYS', 'SALES', 'GROSS', '',
    '21-30 DAYS', 'SALES', 'GROSS', '',
    '31+ DAYS', 'SALES', 'GROSS', '',
    'ALL', 'SALES', 'GROSS',
  ],
  [
    [
      '3', '$1,523.93', '$1,523.93', '',
      '13', '$380.00', '$380.00', '',
      '3', '$249.95', '$249.95', '',
      '4', '$34.00', '$34.00', '',
      '6', '$111.78', '$111.78', '',
      '29', '$2,299.66', '$2,299.66',
    ],
  ],
);

const pivot = maybeTranspose(dmsOpenRo);
check('strip is recognised as pivotable', pivot !== null, true);
check('pivots into one row per bucket', pivot?.table.rows.length, 6);
check('bucket becomes the row label', pivot?.table.rows[0]?.[0], '0-7 DAYS');
check('unnamed leading column named from its values', pivot?.table.headerGrid?.[0], ['', 'COUNT', 'SALES', 'GROSS']);

const openRo = runSuite(
  capture('AutoGroup', 'AUTOGROUP', [agOpenRo]),
  capture('DMS', 'DEALER', [dmsOpenRo]),
  { name: 'Open RO' },
);

const g = openRo.grids[0];
check('a grid was compared', openRo.grids.length, 1);
check('not blocked', openRo.blocked, null);
check('the pivot is recorded on the right side', g?.transposed?.side, 'right');
check('all six buckets paired, including the total row', g?.coverage.matched, 6);
check('18 cells compared (6 buckets x 3 columns)', openRo.summary.totalCells, 18);
check('every cell matched', openRo.summary.matched, 18);
check('no differences', openRo.summary.mismatched, 0);

// The whole point: COUNT must map to OPEN RO COUNT, not to the token-identical
// "% OF COUNT"; GROSS to OPEN RO GROSS, not to the equally-similar "AVG GROSS / RO".
const mapping = (g?.columnPairs ?? []).map((cp) => `${cp.group} -> ${cp.rightGroup}`).sort();
check('columns mapped to the right counterparts', mapping, [
  'OPEN RO COUNT -> COUNT',
  'OPEN RO GROSS -> GROSS',
  'OPEN RO SALES -> SALES',
]);
check(
  'value-inferred mappings are flagged, not passed off as name matches',
  (g?.columnPairs ?? []).every((cp) => cp.matchedBy === 'value'),
  true,
);
check(
  'the ambiguous percentage and average columns were left unpaired',
  (g?.unpairedColumns.left ?? []).map((c) => c.group).sort(),
  ['% OF COUNT', 'AVG GROSS / RO'],
);

// ---------------------------------------------------------------------------
// 2. A grid with real rows must never be pivoted
// ---------------------------------------------------------------------------
console.log('\n=== a normal grid is left alone ===');
check('multi-row table is not pivoted', maybeTranspose(agOpenRo), null);
check(
  'a one-row table with no repeating header blocks is not pivoted',
  maybeTranspose(table(['NAME', 'SALES', 'GROSS'], [['ALPHA', '1', '2']])),
  null,
);

// ---------------------------------------------------------------------------
// 3. Nothing alignable: report it, do not throw
// ---------------------------------------------------------------------------
console.log('\n=== unalignable screens are reported, not thrown ===');

let blockedResult = null;
let threw = null;
try {
  blockedResult = runSuite(
    capture('AutoGroup', 'AUTOGROUP', [
      table(['METRIC', 'VALUE'], [['ALPHA', '1'], ['BETA', '2'], ['GAMMA', '3']]),
    ]),
    capture('DMS', 'DEALER', [
      table(['CUSTOMER', 'BALANCE'], [['ZULU', '9'], ['YANKEE', '8'], ['XRAY', '7']]),
    ]),
    { name: 'Mismatched' },
  );
} catch (e) {
  threw = e.message;
}

check('runSuite did not throw', threw, null);
check('a result was still produced', blockedResult !== null, true);
check('it is marked as blocked', Boolean(blockedResult?.blocked), true);
check('no grids compared', blockedResult?.grids.length, 0);
check('remedy steps are offered', (blockedResult?.blocked?.remedy ?? []).length > 0, true);
check(
  'both screens are still described so the layouts can be inspected',
  [blockedResult?.observation.leftTables.length, blockedResult?.observation.rightTables.length],
  [1, 1],
);
check(
  'the observation carries the header row for diagnosis',
  blockedResult?.observation.leftTables[0]?.headerRow,
  ['METRIC', 'VALUE'],
);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
