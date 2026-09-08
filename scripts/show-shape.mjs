/**
 * Compare the shape of the two grids in a run: row counts, duplicate labels, coverage.
 *
 * Useful when a comparison reports a wall of differences, to tell a genuine data
 * problem from the two screens being configured to show different things.
 *
 * Usage: node scripts/show-shape.mjs [runDir]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

function newestRun() {
  const root = 'artifacts/runs';
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, 'result.json')))
    .map((d) => d.name)
    .sort((a, b) => {
      const key = (n) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})[T_](\d{2})-(\d{2})-(\d{2})/.exec(n);
        return m ? Number(m.slice(1).join('')) : 0;
      };
      return key(b) - key(a);
    });
  return dirs.length ? path.join(root, dirs[0]) : null;
}

const runDir = process.argv[2] ?? newestRun();
const { result } = JSON.parse(readFileSync(path.join(runDir, 'result.json'), 'utf8'));
console.log(`run: ${runDir}\n`);

for (const g of result.grids) {
  console.log(`=== ${g.name} ===`);
  console.log(`rows matched    : ${g.coverage.matched}`);
  console.log(`unmatched left  : ${g.coverage.unmatchedLeft.length}`);
  console.log(`unmatched right : ${g.coverage.unmatchedRight.length}`);
  console.log(`cells           : ${g.summary.totalCells} (${g.summary.matched} matched, ${g.summary.mismatched} different)`);
  console.log('');

  if (g.coverage.unmatchedRight.length) {
    console.log('sample rows only on the right:');
    for (const u of g.coverage.unmatchedRight.slice(0, 10)) {
      const c = u.closest ? `${u.closest.label} (${u.closest.score})` : 'none';
      console.log(`   ${JSON.stringify(u.label).padEnd(42)} closest: ${c}`);
    }
    console.log('');
  }
  if (g.coverage.unmatchedLeft.length) {
    console.log('sample rows only on the left:');
    for (const u of g.coverage.unmatchedLeft.slice(0, 10)) {
      const c = u.closest ? `${u.closest.label} (${u.closest.score})` : 'none';
      console.log(`   ${JSON.stringify(u.label).padEnd(42)} closest: ${c}`);
    }
    console.log('');
  }
}
