/**
 * Phase 1 recon: open the PrimeNG role dropdown and enumerate its options.
 *
 * Read-only. Does not submit the form. We need the exact option labels/values so
 * role selection is deterministic rather than a guess at "AutoGroup" casing.
 *
 * Usage: node scripts/recon-roles.mjs
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';

dotenv.config();

const BASE = process.env.KPI_BASE_URL;
const NAV_TIMEOUT = Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000);
const OUT = 'artifacts/recon';

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: process.env.KPI_HEADLESS !== 'false' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
await page.waitForTimeout(2000);

// Locate the role combobox. Try the most specific candidates first and report
// which one actually worked, so the auth module can use it directly.
const candidates = [
  'p-select',
  'p-dropdown',
  '[role="combobox"]',
  '.p-select',
  '.p-dropdown',
];

const found = [];
for (const sel of candidates) {
  const n = await page.locator(sel).count();
  found.push({ selector: sel, count: n });
}
console.log('--- combobox candidate selectors ---');
for (const f of found) console.log(`${f.count.toString().padStart(3)}  ${f.selector}`);

const working = found.find((f) => f.count > 0);
if (!working) {
  console.error('No dropdown found. Dumping body HTML head for inspection.');
  await writeFile(`${OUT}/roles-fail.html`, await page.content(), 'utf8');
  await browser.close();
  process.exit(1);
}

const combo = page.locator(working.selector).first();
console.log(`\nUsing: ${working.selector}`);
console.log(`Current label: "${(await combo.innerText()).trim()}"`);

await combo.click();
await page.waitForTimeout(1200);

// PrimeNG renders the overlay in a portal at body level.
const optionSelectors = [
  '.p-select-option',
  '.p-dropdown-item',
  '[role="option"]',
  'li[role="option"]',
];

let options = [];
let usedOptionSelector = null;
for (const sel of optionSelectors) {
  const n = await page.locator(sel).count();
  if (n > 0) {
    usedOptionSelector = sel;
    options = await page.locator(sel).evaluateAll((els) =>
      els.map((el) => ({
        label: (el.innerText ?? el.textContent ?? '').trim(),
        ariaSelected: el.getAttribute('aria-selected'),
        dataValue: el.getAttribute('data-p-value') ?? el.getAttribute('data-value'),
        id: el.id || null,
      })),
    );
    break;
  }
}

console.log(`\n--- role options (via ${usedOptionSelector}) ---`);
for (const o of options) {
  console.log(`"${o.label}"  selected=${o.ariaSelected}  value=${o.dataValue ?? 'n/a'}  id=${o.id ?? 'n/a'}`);
}

await page.screenshot({ path: `${OUT}/roles-open.png`, fullPage: false });
await writeFile(
  `${OUT}/roles.json`,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      comboboxSelector: working.selector,
      optionSelector: usedOptionSelector,
      options,
    },
    null,
    2,
  ),
  'utf8',
);

console.log(`\nArtifacts -> ${OUT}/roles.json, roles-open.png`);
await browser.close();
