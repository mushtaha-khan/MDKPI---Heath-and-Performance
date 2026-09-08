/**
 * Checks for the display-rounding tolerance.
 *
 * The point is twofold: rounding differences must pass, and genuine differences must
 * still fail. Both directions are asserted, using real value pairs seen on the portal.
 */
import { compareValues, parseCell, precisionTolerance } from '../src/core/normalize.ts';

const cases = [
  // [left, right, kind, expected verdict, why]
  ['237', '236.5', 'hours', 'match', 'AutoGroup rounds hours to whole units'],
  ['104', '104.4', 'hours', 'match', 'rounding, 0.4 within half a unit'],
  ['30', '29.9', 'hours', 'match', 'rounding'],
  ['$44,444', '$44,444.31', 'currency', 'match', 'AutoGroup rounds to whole dollars'],
  ['$44,444', '$44,443.60', 'currency', 'match', 'rounds down'],
  ['1,590', '1,590', 'count', 'match', 'identical'],
  ['$25.00', '$25.00', 'currency', 'match', 'identical to the cent'],

  // These must still be reported — they are larger than display rounding can explain.
  ['$0', '-$65.00', 'currency', 'mismatch', 'AutoGroup omits the discount entirely'],
  ['$44,444', '$44,508.68', 'currency', 'mismatch', 'the $64.68 discount gap'],
  ['142', '144', 'count', 'mismatch', 'two whole ROs missing'],
  ['192', '194.1', 'hours', 'mismatch', 'beyond half a unit'],
  ['$181.16', '$181.61', 'rate', 'mismatch', 'both show cents, so 0.45 is real'],
  ['$9,846', '$9,881.14', 'currency', 'mismatch', 'the $35 parts discount gap'],
];

let failed = 0;
for (const [leftRaw, rightRaw, kind, expected, why] of cases) {
  const l = parseCell(leftRaw);
  const r = parseCell(rightRaw);
  const tol = precisionTolerance(leftRaw, rightRaw, kind);
  const cmp = compareValues(l, r, tol);
  const ok = cmp.verdict === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'}  ${leftRaw.padStart(11)} vs ${rightRaw.padEnd(12)} ` +
      `tol=${String(tol).padEnd(6)} Δ=${String(cmp.delta).padStart(8)} ` +
      `${cmp.verdict.padEnd(9)}${cmp.roundedMatch ? ' (rounded)' : ''}  ${why}` +
      `${ok ? '' : `   EXPECTED ${expected}`}`,
  );
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
