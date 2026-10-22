/**
 * Entry point for the MDKPI-7508 WAF regression runner.
 *
 * Usage:
 *   node scripts/waf-run.mjs --domains am-gyh.mydealerkpi.com [--roles AUTOGROUP,DEALER]
 *   node scripts/waf-run.mjs --domains am-gyh.mydealerkpi.com --attack   # includes WAF-38/39 last
 *   node scripts/waf-run.mjs --domains-file domains.txt                  # full run (all tenants)
 *   node scripts/waf-run.mjs --domains am-gyh.mydealerkpi.com --headed
 *
 * The attack step (WAF-38/39) only runs with --attack, always last, on the first domain.
 */
import { readFile } from 'node:fs/promises';
import { run } from '../src/waf/runner.mjs';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const attack = process.argv.includes('--attack');
const headed = process.argv.includes('--headed');
const rolesArg = arg('roles');
const roles = rolesArg ? String(rolesArg).split(',').map((r) => r.trim().toUpperCase()) : ['AUTOGROUP', 'DEALER'];

let domains = [];
const domainsFile = arg('domains-file');
if (domainsFile) {
  const text = await readFile(String(domainsFile), 'utf8');
  domains = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
} else {
  const d = arg('domains');
  if (d && d !== true) domains = String(d).split(',').map((s) => s.trim()).filter(Boolean);
}

if (!domains.length) {
  console.error('No domains. Use --domains <host[,host]> or --domains-file <path>');
  process.exit(1);
}

console.log(`WAF run — ${domains.length} domain(s), roles ${roles.join('+')}, attack=${attack}, headless=${!headed}`);
console.time('waf-run');
const { runDir, rows, meta } = await run({ domains, roles, attack, headless: !headed });
console.timeEnd('waf-run');

const counts = rows.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
console.log(`\nResults: ${JSON.stringify(counts)}`);
console.log(`Report:  ${runDir}/report.html`);
console.log(`CSV:     ${runDir}/results.csv`);
console.log(`XLSX:    ${runDir}/results.xlsx`);

const fails = rows.filter((r) => r.verdict === 'FAIL');
if (fails.length) {
  console.log(`\n${fails.length} FAIL row(s):`);
  for (const f of fails.slice(0, 30)) console.log(`  ${f.caseId} [${f.role}] ${f.url} — ${f.result}`);
}
