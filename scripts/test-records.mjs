/**
 * Analytics-card pairing, text comparison and record-by-record comparison.
 *
 * The cases here are drawn from the real Closed RO screens, which are the reason this code
 * exists: two record listings with fourteen columns in common that the engine previously
 * refused to compare at all.
 *
 * Usage: npx tsx scripts/test-records.mjs
 */
import { compareTiles } from '../src/core/kpi.ts';
import { compareTexts, normalizeText } from '../src/core/normalize.ts';
import { compareRecords } from '../src/core/records.ts';
import { profileGrids } from '../src/core/pairing.ts';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(62)} got ${JSON.stringify(actual)}${ok ? '' : `  expected ${JSON.stringify(expected)}`}`,
  );
  ok ? pass++ : fail++;
}

// ---------------------------------------------------------------------------
// 1. Analytics cards
// ---------------------------------------------------------------------------
console.log('=== analytics cards ===');

const agTiles = [
  { label: 'TOTAL RO', value: '362' },
  { label: 'ELR', value: '$186.77' },
  { label: 'LABOR SALES', value: '$87,240.22' },
  { label: 'PARTS SALES', value: '$50,154.46' },
  { label: 'TOTAL SALES', value: '$137,394.68' },
  { label: 'TOTAL GROSS', value: '$97,449.20' },
];
const dmsTiles = [
  { label: "TOTAL RO'S", value: '362' },
  { label: 'ELR', value: '$186.77', caption: 'PER BILL HOUR' },
  { label: 'LABOR SALE', value: '$87,175.22', caption: '87.3% GROSS' },
  { label: 'PARTS SALE', value: '$50,119.46', caption: '42.7% GROSS' },
  { label: 'TOTAL L/P SALE', value: '$137,294.68' },
  { label: 'TOTAL L/P GROSS', value: '$97,449.20' },
  { label: 'DOOR RATE', value: '$269.99' },
  // A percentage card whose label is a near-match for a currency card. It must not pair.
  { label: 'GROSS %', value: '87.3%' },
  // Grid-row noise: must be refused whatever the crawler hands over.
  { label: 'CLOSE DATE: 09/05/2026', value: '$44.00' },
  { label: '+3 MORE', value: '$12.00' },
  { label: 'SHOWING 1 TO 25 OF 362', value: '25' },
];

const a = compareTiles(agTiles, dmsTiles, { leftLabel: 'AutoGroup', rightLabel: 'DMS' });
check('six cards paired', a?.compared, 6);
check(
  'plural, possessive and L/P wording all pair',
  a?.pairs.map((p) => `${p.label} -> ${p.rightLabel}`).sort(),
  [
    'ELR -> ELR',
    'LABOR SALES -> LABOR SALE',
    'PARTS SALES -> PARTS SALE',
    'TOTAL GROSS -> TOTAL L/P GROSS',
    'TOTAL RO -> TOTAL RO\'S',
    'TOTAL SALES -> TOTAL L/P SALE',
  ],
);
check('three real differences found', a?.mismatched, 3);
check(
  'the differences are the sales figures',
  a?.pairs.filter((p) => p.verdict !== 'match').map((p) => `${p.label} ${p.delta}`).sort(),
  ['LABOR SALES -65', 'PARTS SALES -35', 'TOTAL SALES -100'],
);
check(
  'a percentage card never pairs with a currency card',
  a?.pairs.some((p) => /GROSS %/.test(p.rightLabel)),
  false,
);
check(
  'grid-row captions and pagination are refused outright',
  a?.onlyOnRight.map((t) => t.label).sort(),
  ['DOOR RATE', 'GROSS %'],
);

// ---------------------------------------------------------------------------
// 2. Text comparison
// ---------------------------------------------------------------------------
console.log('\n=== text comparison ===');
check('identical text matches', compareTexts('GARRETT THOMAS', 'GARRETT THOMAS').verdict, 'match');
check('case and punctuation only', compareTexts('2021 Honda CR-V', '2021 HONDA CR V').verdict, 'match');
check('and is flagged as formatting', compareTexts('2021 Honda CR-V', '2021 HONDA CR V').formattingOnly, true);
check('a missing middle name still matches', compareTexts('HERIBERTO XAVIER AVILA', 'HERIBERTO AVILA').verdict, 'match');
check('a different person does not', compareTexts('GARRETT THOMAS', 'LISA KLARICH').verdict, 'mismatch');
check('blank on one side is reported as missing', compareTexts('', 'GARRETT THOMAS').verdict, 'missing-left');
check('normalizeText keeps digits', normalizeText('2021 Honda CR-V EX-L'), '2021 HONDA CR V EX L');

// ---------------------------------------------------------------------------
// 3. Record listings
// ---------------------------------------------------------------------------
console.log('\n=== record listings ===');

function table(header, rows) {
  return { index: 0, caption: '', headers: [header], headerGrid: [header], rowCount: rows.length, rows, footers: [] };
}

// Modelled on the real screens: the same three ROs, one side itemising and annotating where
// the other aggregates, plus a leading row-number column on the right that must not be
// mistaken for the record key.
const agListing = table(
  ['RO #', 'CUSTOMER INFO', 'VEHICLE INFO', 'SERVICE ADVISOR', 'TECHNICIANS', 'TOTAL LINES (C,W,I)', 'PARTS COST / SALE', 'TOTAL SALE', 'TOTAL GROSS'],
  [
    ['238977 OPEN: 09/05/2026', '4841 KYLE C LEHMAN', '2017 NISSAN ROGUE', 'GARRETT THOMAS', 'DAVID MANDOLINI', '3 CP 2 · W 0 · I 1', '$23.09 / $42.98', '$80.42', '$45.33'],
    ['238973 OPEN: 09/05/2026', '129189 JOE MACIOKAS', '2021 HONDA CR-V', 'GARRETT THOMAS', 'NOAH GRENIER', '6 CP 5 · W 0 · I 1', '$92.22 / $162.53', '$464.23', '$310.01'],
    ['238986 OPEN: 09/05/2026', '61301 RINA AKTHER', '2022 HONDA PILOT', 'GARRETT THOMAS', 'JOHN FELICIANO', '3 CP 1 · W 0 · I 2', '$551.07 / $702.95', '$1,233.05', '$544.18'],
  ],
);

const dmsListing = table(
  ['S NO.', 'RO#', 'CUSTOMER INFO', 'VEHICLE INFO', 'DEPARTMENT', 'SERVICE ADVISOR', 'TECHNICIANS', 'TOTAL LINES (WITH C, W, I)', 'PARTS COST / SALE', 'TOTAL SALE', 'TOTAL GROSS'],
  [
    ['1', '238977 CLOSE DATE: 09/05/2026', '4841 KYLE C LEHMAN', '2017 NISSAN ROGUE', 'SERVICE', 'GARRETT THOMAS', 'DAVID MANDOLINI COST: $12.00 SALE: $44.00', '3 CP: $35.09 / $84.97 I: $0.00 / $0.00', '$5.82 / $11.70 $17.27 / $31.28', '$35.09 / $84.97', '$45.33'],
    ['2', '238973 CLOSE DATE: 09/05/2026', '129189 JOE MACIOKAS', '2021 HONDA CR-V EX-L', 'SERVICE', 'GARRETT THOMAS', 'NOAH GRENIER COST: $57.50 SALE: $276.00', '6 CP: $154.22 / $490.73 I: $0.00 / $0.00', '$5.82 / $12.28 $86.40 / $150.25', '$154.22 / $490.73', '$310.01'],
    ['3', '238986 CLOSE DATE: 09/05/2026', '61301 RINA AKTHER', '2022 HONDA PILOT SE', 'SERVICE', 'GARRETT THOMAS', 'JOHN FELICIANO COST: $137.00 SALE: $379.00', '3 CP: $655.06 / $1,314.17 I: $0.00 / $0.00', '$551.07 / $702.95', '$655.06 / $1,314.17', '$544.18'],
  ],
);

const [agProfile] = profileGrids([agListing]);
const [dmsProfile] = profileGrids([dmsListing]);
const rc = compareRecords(agProfile, dmsProfile, { leftLabel: 'AutoGroup', rightLabel: 'DMS' });

check('a record comparison was produced', rc !== null, true);
check('the RO number is used as the key, not the row number', [rc?.keyColumn.left, rc?.keyColumn.right], ['RO #', 'RO#']);
check('all three records matched', rc?.summary.recordsCompared, 3);
check('no records stranded on one side', [rc?.onlyOnLeft.length, rc?.onlyOnRight.length], [0, 0]);
check(
  'the row-number and department columns are reported as uncompared',
  rc?.unpairedRight.sort(),
  ['DEPARTMENT', 'S NO.'],
);

const cellsFor = (col) => rc.records.map((r) => r.cells.find((c) => c.column === col));

check('service advisor matches', cellsFor('SERVICE ADVISOR').every((c) => c.verdict === 'match'), true);
check('customer info matches', cellsFor('CUSTOMER INFO').every((c) => c.verdict === 'match'), true);
check(
  'a technician name matches despite appended figures',
  cellsFor('TECHNICIANS').every((c) => c.verdict === 'match'),
  true,
);
check(
  'and that is recorded as a composition difference, not a data one',
  cellsFor('TECHNICIANS').every((c) => c.composition !== null),
  true,
);
check(
  'an abbreviated vehicle description matches the fuller one',
  cellsFor('VEHICLE INFO').every((c) => c.verdict === 'match'),
  true,
);
check(
  'itemised parts pairs reconcile against the aggregated pair',
  cellsFor('PARTS COST / SALE').every((c) => c.verdict === 'match'),
  true,
);
check('and are compared as pairs', cellsFor('PARTS COST / SALE')[0]?.strategy, 'pairs');
check(
  'counts against amounts compares only the leading figure',
  cellsFor('TOTAL LINES (C,W,I)').map((c) => [c.strategy, c.verdict]),
  [['leading', 'match'], ['leading', 'match'], ['leading', 'match']],
);

// The real finding: DMS's TOTAL SALE is a cost/sale pair whose sale exceeds AutoGroup's by
// exactly the tax. This must be reported, not smoothed away.
const totalSale = cellsFor('TOTAL SALE');
check('a single figure is compared against the sale side of a pair', totalSale[0]?.strategy, 'value');
check('and the difference is reported', totalSale.map((c) => c.verdict), ['mismatch', 'mismatch', 'mismatch']);
check('with the exact delta', totalSale.map((c) => c.delta), [4.55, 26.5, 81.12]);
check('total gross agrees', cellsFor('TOTAL GROSS').every((c) => c.verdict === 'match'), true);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
