/**
 * Report how many of a grid's numeric columns were actually compared.
 *
 * Each column group can hold many value columns; the comparison currently uses one per
 * group. This quantifies the gap so coverage is not overstated.
 *
 * Usage: node scripts/explain-coverage.mjs [runDir]
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
  console.log(`=== grid "${g.name}" ===`);
  console.log(`compared groups: ${g.groups.join(', ')}`);
  console.log(`skipped groups : ${(g.skippedGroups ?? []).join(', ') || 'none'}`);
  console.log('');

  for (const side of ['left', 'right']) {
    const geo = g.geometry[side];
    const label = side === 'left' ? result.left.label : result.right.label;
    console.log(`  ${label}:`);
    // Count how many columns belong to each group and how many are numeric-ish.
    const byGroup = new Map();
    for (const col of geo.columns) {
      if (!col.group) continue;
      if (!byGroup.has(col.group)) byGroup.set(col.group, []);
      byGroup.get(col.group).push(col);
    }
    for (const [group, cols] of byGroup) {
      const compared = geo.primaryByGroup?.[group] ?? null;
      const isCompared = g.groups.includes(group);
      console.log(
        `    ${group.padEnd(22)} ${String(cols.length).padStart(2)} column(s)  ` +
          `${isCompared ? `comparing 1 of them` : 'group not compared'}`,
      );
      if (isCompared) {
        console.log(
          `      columns present: ${cols.map((c) => c.chain[c.chain.length - 1]).join(' | ')}`,
        );
      }
    }
    console.log('');
  }

  const totalCols = g.geometry.left.columns.filter((c) => c.group).length;
  console.log(`  cells compared: ${g.summary.totalCells}`);
  console.log(
    `  = ${g.coverage.matched} row(s) x ${g.groups.length} group(s), one column per group`,
  );
  console.log(`  left grid has ${totalCols} grouped column(s) in total\n`);
}
