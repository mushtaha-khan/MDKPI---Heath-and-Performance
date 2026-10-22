/**
 * Phase 1 recon: log in with a given role and capture the landing route + nav menu.
 *
 * This is the first script that actually submits credentials — needed to learn the
 * real post-login report routes so the WAF sweep uses a verified route list rather
 * than guesses. Captures no page figures, only URLs/hrefs and HTTP statuses.
 *
 * Usage: node scripts/recon-auth.mjs <baseUrl> <ROLE>
 *   e.g. node scripts/recon-auth.mjs https://am-gyh.mydealerkpi.com AUTOGROUP
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';

dotenv.config();

const BASE = (process.argv[2] || process.env.KPI_BASE_URL || '').replace(/\/$/, '');
const ROLE = process.argv[3] || 'DEALER';
const USER = process.env.KPI_USERNAME;
const PASS = process.env.KPI_PASSWORD;
const NAV_TIMEOUT = Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000);
const OUT = 'artifacts/recon';

if (!BASE || !USER || !PASS) {
  console.error('Need baseUrl (arg or KPI_BASE_URL) plus KPI_USERNAME/KPI_PASSWORD in .env');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: process.env.KPI_HEADLESS !== 'false' });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

// Track every response so we can see any 403s during login itself.
const responses = [];
page.on('response', (r) => {
  const s = r.status();
  const type = r.request().resourceType();
  if (s >= 400 || type === 'document' || type === 'xhr' || type === 'fetch') {
    responses.push({ status: s, type, url: r.url() });
  }
});

console.log(`Base:  ${BASE}`);
console.log(`Role:  ${ROLE}`);

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
await page.waitForTimeout(1500);

// Select the role in the PrimeNG p-select if it isn't already the default.
const combo = page.locator('p-select, .p-select, [role="combobox"]').first();
const current = (await combo.innerText().catch(() => '')).trim();
if (current.toUpperCase() !== ROLE.toUpperCase()) {
  await combo.click();
  await page.waitForTimeout(800);
  await page.locator('.p-select-option, [role="option"]', { hasText: ROLE })
    .filter({ hasText: new RegExp(`^${ROLE}$`, 'i') })
    .first()
    .click();
  await page.waitForTimeout(500);
}

await page.locator('input[name="username"]').fill(USER);
await page.locator('input[name="password"]').fill(PASS);

const before = page.url();
await page.locator('input[type="submit"]').click();

// Wait for navigation away from /login (or a visible error).
await page.waitForTimeout(2000);
await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
await page.waitForTimeout(2500);

const landed = page.url();
const loggedIn = !/\/login/.test(landed);
console.log(`\nSubmitted. Landed: ${landed}  loggedIn=${loggedIn}`);

// Capture nav links / menu hrefs for the route list.
const nav = await page.evaluate(() => {
  const links = Array.from(document.querySelectorAll('a[href], [routerlink]'))
    .map((el) => ({
      text: (el.innerText ?? el.textContent ?? '').trim().slice(0, 60),
      href: el.getAttribute('href'),
      routerLink: el.getAttribute('routerlink') ?? el.getAttribute('ng-reflect-router-link'),
    }))
    .filter((l) => (l.href && l.href !== 'javascript: void(0);') || l.routerLink);
  // Dedupe by href|routerLink
  const seen = new Set();
  const uniq = [];
  for (const l of links) {
    const key = `${l.href}|${l.routerLink}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(l);
  }
  return { title: document.title, count: uniq.length, links: uniq };
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const safeRole = ROLE.toLowerCase();
const report = {
  capturedAt: new Date().toISOString(),
  base: BASE,
  role: ROLE,
  loginUrlBefore: before,
  landedUrl: landed,
  loggedIn,
  errorResponses: responses.filter((r) => r.status >= 400),
  navCount: nav.count,
  nav: nav.links,
};
await writeFile(`${OUT}/auth-${safeRole}-${stamp}.json`, JSON.stringify(report, null, 2), 'utf8');
await page.screenshot({ path: `${OUT}/auth-${safeRole}-${stamp}.png`, fullPage: true });

console.log(`\n--- nav links (${nav.count}) ---`);
for (const l of nav.links) {
  console.log(`"${l.text}"  href=${l.href ?? '-'}  routerLink=${l.routerLink ?? '-'}`);
}
if (report.errorResponses.length) {
  console.log(`\n--- 4xx/5xx during login (${report.errorResponses.length}) ---`);
  for (const r of report.errorResponses) console.log(`${r.status} ${r.type} ${r.url}`);
} else {
  console.log('\nNo 4xx/5xx during login.');
}
console.log(`\nArtifacts -> ${OUT}/auth-${safeRole}-${stamp}.json + .png`);

await browser.close();
