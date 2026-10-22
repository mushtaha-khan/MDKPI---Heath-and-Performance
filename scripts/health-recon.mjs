/**
 * Health-crawl recon: log into the gyh tenant /v2 app as the ghost user and
 * discover the full navigation tree (modules, screens, tabs) the user can reach.
 *
 * STRICTLY READ-ONLY. Logs in, expands the menu, and records every routerLink /
 * href / menu label. Submits NOTHING beyond the login form. No CRUD.
 *
 * Usage: node scripts/health-recon.mjs
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

dotenv.config();

// The user asked specifically for gyh.mydealerkpi.com/v2 (the DEALER "/v2" app),
// not the am-gyh variant the WAF suite uses. Honour that exactly.
const BASE = (process.env.HEALTH_BASE_URL || 'https://gyh.mydealerkpi.com').replace(/\/$/, '');
const ROLE = process.env.HEALTH_ROLE || 'DEALER';
const USER = process.env.KPI_USERNAME;
const PASS = process.env.KPI_PASSWORD;
const NAV_TIMEOUT = Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000);
const HEADLESS = process.env.KPI_HEADLESS !== 'false';
const OUT = 'artifacts/health';

if (!USER || !PASS) {
  console.error('KPI_USERNAME / KPI_PASSWORD missing from .env');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: HEADLESS });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
const page = await context.newPage();

const responses = [];
page.on('response', (r) => {
  const s = r.status();
  const t = r.request().resourceType();
  if (s >= 400 || t === 'document' || t === 'xhr' || t === 'fetch') responses.push({ status: s, type: t, url: r.url() });
});

console.log(`Base: ${BASE}  Role: ${ROLE}  User: ${USER}`);

// ---- login (reuses the confirmed DOM: username/password + PrimeNG p-select role) ----
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
await page.waitForTimeout(1500);

const combo = page.locator('p-select, .p-select, [role="combobox"]').first();
const current = (await combo.innerText().catch(() => '')).trim();
if (current.toUpperCase() !== ROLE.toUpperCase()) {
  await combo.click();
  await page.waitForTimeout(700);
  await page.locator('.p-select-option, [role="option"]').filter({ hasText: new RegExp(`^\\s*${ROLE}\\s*$`, 'i') }).first().click().catch(() => {});
  await page.waitForTimeout(400);
}
await page.locator('input[name="username"]').fill(USER);
await page.locator('input[name="password"]').fill(PASS);
await page.locator('input[type="submit"]').click();

// The auth round-trip can take a while (the screenshot showed the spinner still
// turning when the old 2.5s wait gave up). Wait for the SPA to actually leave /login,
// then for it to settle. Fall back to a networkidle wait if the URL check times out.
await page
  .waitForURL((u) => !/\/login(\?|$|\/)/.test(u.toString()), { timeout: NAV_TIMEOUT })
  .catch(() => {});
await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
await page.waitForTimeout(3000);

const landed = page.url();
const loggedIn = !/\/login(\?|$|\/)/.test(landed);
console.log(`Landed: ${landed}  loggedIn=${loggedIn}`);
if (!loggedIn) {
  await writeFile(`${OUT}/recon-loginfail.html`, await page.content(), 'utf8');
  await page.screenshot({ path: `${OUT}/recon-loginfail.png`, fullPage: true });
  console.error('Login did not succeed. See artifacts/health/recon-loginfail.*');
  await browser.close();
  process.exit(1);
}

// ---- expand every collapsible menu so lazy sub-items render, then harvest links ----
async function expandMenus() {
  // Click anything that looks like an expandable menu header a few times; it is safe
  // (toggles a submenu) and never submits data.
  const expanders = page.locator(
    'p-panelmenu .p-panelmenu-header, .p-panelmenu-header-link, [class*="menu"] [class*="toggle"], ' +
    'a[aria-expanded="false"], li[aria-expanded="false"], .p-panelmenu-header-content',
  );
  for (let pass = 0; pass < 3; pass++) {
    const n = await expanders.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      await expanders.nth(i).click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(400);
  }
}
await expandMenus();
await page.waitForTimeout(800);

const nav = await page.evaluate(() => {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('a[href], [routerlink], [ng-reflect-router-link], [role="menuitem"]')) {
    const href = el.getAttribute('href');
    const rl = el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link');
    let link = rl || href || '';
    if (!link || link === 'javascript:void(0);' || link.startsWith('#')) continue;
    // normalise a routerLink array string like "['/v2','dealership','x']"
    link = link.replace(/[[\]']/g, '').split(',').map((s) => s.trim()).filter(Boolean).join('/');
    if (link && !link.startsWith('/') && !link.startsWith('http')) link = '/' + link;
    const text = clean(el.innerText || el.textContent);
    const key = `${link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: text.slice(0, 80), link });
  }
  return { title: document.title, url: location.href, count: out.length, links: out };
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const report = {
  capturedAt: new Date().toISOString(),
  base: BASE, role: ROLE, landedUrl: landed, loggedIn,
  errorResponses: responses.filter((r) => r.status >= 400),
  navCount: nav.count,
  nav: nav.links,
};
await writeFile(`${OUT}/recon-${stamp}.json`, JSON.stringify(report, null, 2), 'utf8');
await page.screenshot({ path: `${OUT}/recon-${stamp}.png`, fullPage: true });

console.log(`\n--- ${nav.count} nav links discovered ---`);
for (const l of nav.links) console.log(`${(l.link || '-').padEnd(60)} ${l.text}`);
console.log(`\n4xx/5xx during recon: ${report.errorResponses.length}`);
for (const r of report.errorResponses.slice(0, 20)) console.log(`  ${r.status} ${r.type} ${r.url}`);
console.log(`\nArtifacts -> ${OUT}/recon-${stamp}.json + .png`);

await browser.close();
