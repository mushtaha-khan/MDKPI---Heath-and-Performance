/** Sanity checks for cell parsing, including composite and accounting-negative forms. */
import { parseCell } from '../src/core/normalize.ts';

const cases = [
  ['86 (51)', 86, '51'],
  ['$7,403.52 (85.11%)', 7403.52, '85.11%'],
  ['($1,234.00)', -1234, undefined],
  ['$25.00', 25, undefined],
  ['0.00%', 0, undefined],
  ['1,590', 1590, undefined],
  ['—', null, undefined],
  ['', null, undefined],
  ['-$65.00', -65, undefined],
  ['$2,410.75 (57.09%)', 2410.75, '57.09%'],
  ['not a number', null, undefined],
];

let failed = 0;
for (const [input, expected, expectedSecondary] of cases) {
  const r = parseCell(input);
  const valueOk = r.value === expected;
  const secOk = expectedSecondary === undefined ? true : r.secondaryRaw === expectedSecondary;
  const ok = valueOk && secOk;
  if (!ok) failed++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'}  ${JSON.stringify(input).padEnd(24)} -> ${String(r.value).padStart(9)}` +
      `${r.secondaryRaw ? `  secondary=${r.secondaryRaw}` : ''}` +
      `${ok ? '' : `   expected ${expected}${expectedSecondary ? ` / ${expectedSecondary}` : ''}`}`,
  );
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
