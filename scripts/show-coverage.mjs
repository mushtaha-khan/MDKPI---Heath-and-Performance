/**
 * Summarise column coverage and unpaired columns for the newest run.
 *
 * Usage: node scripts/show-coverage.mjs [runDir]
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
console.log(`run: ${runDir}`);
console.log(`module: ${result.moduleName}\n`);

for (const g of result.grids) {
  const cs = g.coverageStats;
  console.log(`=== ${g.name} ===`);
  console.log(
    `compared ${cs.comparedColumns} column(s); ` +
      `${result.left.label} has ${cs.leftValueColumns} numeric, ${result.right.label} has ${cs.rightValueColumns}`,
  );
  console.log(`cells: ${g.summary.totalCells} (${g.coverage.matched} rows x ${cs.comparedColumns} cols)`);
  console.log(`skipped groups: ${(g.skippedGroups ?? []).join(', ') || 'none'}\n`);

  const byGroup = new Map();
  for (const p of g.columnPairs) {
    if (!byGroup.has(p.group)) byGroup.set(p.group, []);
    byGroup.get(p.group).push(p);
  }
  console.log('  compared columns:');
  for (const [grp, list] of byGroup) {
    console.log(`    ${grp.padEnd(12)} ${list.map((p) => p.name + (p.matchedBy === 'fuzzy' ? `~${p.confidence}` : '')).join(' | ')}`);
  }

  for (const [side, list] of [
    [result.left.label, g.unpairedColumns.left],
    [result.right.label, g.unpairedColumns.right],
  ]) {
    if (!list.length) continue;
    console.log(`\n  NOT compared — only on ${side} (${list.length}):`);
    for (const c of list) console.log(`    ${c.group.padEnd(12)} ${c.name}   [${c.header}]`);
  }
  console.log('');
}
