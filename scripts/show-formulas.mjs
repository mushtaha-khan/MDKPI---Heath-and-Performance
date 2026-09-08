/**
 * List the formulas harvested for a run, per side.
 *
 * Usage: node scripts/show-formulas.mjs [runDir]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

function newestRun() {
  const root = 'artifacts/runs';
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, 'formulas')))
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
if (!runDir) {
  console.error('No run with harvested formulas found.');
  process.exit(1);
}
console.log(`run: ${runDir}\n`);

for (const side of ['autogroup', 'dms']) {
  const file = path.join(runDir, 'formulas', side, 'formulas.json');
  if (!existsSync(file)) {
    console.log(`===== ${side}: none harvested =====\n`);
    continue;
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const withFormula = data.results.filter((r) => r.formula);
  console.log(`===== ${side}: ${withFormula.length} formula(s) =====`);
  for (const r of withFormula.slice(0, 30)) {
    console.log(`  row "${String(r.rowLabel).slice(0, 30)}"  col ${r.cellIndex}`);
    console.log(`      ${r.formula}`);
  }
  console.log('');
}
