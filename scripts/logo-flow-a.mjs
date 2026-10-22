/**
 * Flow A — Direct Dealership Login. Logo investigation. STRICTLY READ-ONLY.
 *
 * For each dealership subdomain:
 *   1. Open {sub}.mydealerkpi.com/login?ghost=true
 *   2. Log in with ghost-user under the DEALER role
 *   3. Wait for the dashboard loading overlay to clear
 *   4. Inspect the header logo (top-left) in the current (dark) theme
 *   5. Toggle to light theme, re-inspect
 *   6. Capture screenshots + per-image network status + console errors
 *   7. Log out completely before the next dealer
 *
 * Submits no mutating request. Changes no setting server-side (theme toggle is a
 * client-only class on <html>, verified in recon to issue no API write).
 * Never writes the password into an artifact.
 *
 * Usage:
 *   node scripts/logo-flow-a.mjs                 # all dealers in the list
 *   node scripts/logo-flow-a.mjs am-gyb am-mom   # a subset
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

dotenv.config();

const USERNAME = required('KPI_USERNAME');
const PASSWORD = required('KPI_PASSWORD');
const ROLE = (process.env.KPI_ROLE_DEALER ?? 'DEALER').toUpperCase();
const HEADLESS = process.env.KPI_HEADLESS !== 'false';
const NAV_TIMEOUT = Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000);
const SLOWMO = Number(process.env.KPI_SLOWMO_MS ?? 0);

const ALL_DEALERS = [
  'am-gyb', 'am-mom', 'am-fmi', 'am-lni', 'am-ptb', 'am-phb', 'am-atot',
  'am-r1h', 'am-rh', 'am-mwh', 'am-mwa', 'am-tmv', 'am-bof',
];
const dealers = process.argv.slice(2).length ? process.argv.slice(2) : ALL_DEALERS;

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join('artifacts', 'logo-investigation', 'flow-a', RUN_ID);

function required(key) {
  const v = process.env[key];
  if (!v) { console.error(`Missing ${key} in .env`); process.exit(1); }
  return v;
}
function withGhost(rawUrl) {
  const u = new URL(rawUrl);
  u.searchParams.set('ghost', 'true');
  return u.toString();
}
function redact(text) {
  if (typeof text !== 'string') return text;
  return text.split(PASSWORD).join('***REDACTED***');
}

/** Read the header-logo state + current theme from the live DOM. */
async function inspectLogo(page) {
  return page.evaluate(() => {
    const header = document.querySelector('div.mdkpi-header, header, [class*="mdkpi-header"]');
    const scope = header ?? document;
    // The top-left dealership logo: alt="logo" is the reliable marker from recon.
    let logo = scope.querySelector('img[alt="logo" i]');
    // Fallback: left-most visible header image that isn't the MyDealerKPI product mark.
    if (!logo && header) {
      const imgs = [...header.querySelectorAll('img')].filter((im) => {
        const r = im.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      imgs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      logo = imgs.find((im) => !/md-logo|logo-big|small-logo|mydealerkpi/i.test(im.currentSrc || im.src)) ?? imgs[0] ?? null;
    }
    // Light mode ADDS mdkpi-light-mode to the html class (my-app-dark stays present
    // in both states), so the light class is the reliable discriminator.
    const theme = document.documentElement.className.includes('mdkpi-light-mode') ? 'light' : 'dark';
    if (!logo) {
      return { theme, found: false };
    }
    const r = logo.getBoundingClientRect();
    const broken = !logo.complete || logo.naturalWidth === 0;
    const s = getComputedStyle(logo);
    return {
      theme,
      found: true,
      src: logo.currentSrc || logo.src || null,
      alt: logo.alt || null,
      complete: logo.complete,
      naturalWidth: logo.naturalWidth,
      naturalHeight: logo.naturalHeight,
      displayedW: Math.round(r.width),
      displayedH: Math.round(r.height),
      visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0',
      broken,
      classification: !logo.complete || logo.naturalWidth === 0
        ? (logo.getAttribute('src') ? 'broken' : 'missing')
        : (r.width === 0 || r.height === 0 ? 'missing' : 'ok'),
    };
  });
}

/** Wait for the dashboard's loading overlay/spinner to clear. */
async function waitForDashboard(page) {
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
  for (const sel of ['text=LOADING', '.p-progress-spinner', '[class*="loader"]', '[class*="loading"]']) {
    await page.locator(sel).first().waitFor({ state: 'hidden', timeout: 25000 }).catch(() => {});
  }
  await page.waitForTimeout(1500);
}

/**
 * Toggle the theme via the header sun/moon button.
 *
 * Verified behaviour (probe): light mode is signalled by ADDING `mdkpi-light-mode`
 * to the <html> class — `my-app-dark` stays present in both states — the body
 * background flips (rgb(15,16,20) <-> rgb(238,238,238)), and the header icon swaps
 * sun <-> moon. The handler fires reliably on a hover-then-trusted-click of the
 * button (a bare forced click sometimes landed on the ripple and did nothing). The
 * transition is animated, so poll for the class to settle before inspecting.
 */
async function toggleTheme(page) {
  const read = () => page.evaluate(() => document.documentElement.className.includes('mdkpi-light-mode') ? 'light' : 'dark');
  const before = await read();
  const btn = page.locator('button:has(span.sun-icon), button:has(span.moon-icon), button:has([class*="sun-icon"]), button:has([class*="moon-icon"])').first();
  if (!(await btn.count())) return { toggled: false, before, after: before, note: 'toggle button not found' };

  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.hover().catch(() => {});
  await page.waitForTimeout(250);
  await btn.click().catch(() => {});
  // Poll for the themed class to flip — the transition can take ~1s.
  await page.waitForFunction(
    (prev) => (document.documentElement.className.includes('mdkpi-light-mode') ? 'light' : 'dark') !== prev,
    before,
    { timeout: 15000, polling: 200 },
  ).catch(() => {});
  // Let the animated transition + any logo swap fully settle before inspection.
  await page.waitForTimeout(2500);
  const after = await read();
  return { toggled: after !== before, before, after };
}

async function logout(page, base) {
  // Clearing the session is the reliable, side-effect-free logout for an SPA:
  // navigate to /login which also lets the app tear down the authed state.
  try {
    await page.context().clearCookies();
    await page.goto(withGhost(`${base}/login`), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
  } catch { /* best-effort */ }
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: HEADLESS,
  slowMo: SLOWMO,
  args: ['--start-maximized'],
});
const results = [];

for (const sub of dealers) {
  const base = `https://${sub}.mydealerkpi.com`;
  const dealerDir = path.join(OUT, sub);
  await mkdir(dealerDir, { recursive: true });

  // viewport: null makes the page fill the maximized window, so the app renders
  // responsively at full size instead of inside a fixed 1920x1080 box.
  const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const imageNetwork = [];
  page.on('response', (resp) => {
    if (resp.request().resourceType() === 'image') {
      imageNetwork.push({ url: resp.url(), status: resp.status(), ok: resp.ok() });
    }
  });
  const failedRequests = [];
  page.on('requestfailed', (req) => {
    if (req.resourceType() === 'image') failedRequests.push({ url: req.url(), failure: req.failure()?.errorText ?? null });
  });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(redact(m.text())); });

  const record = {
    dealer: sub,
    url: base,
    flow: 'Direct Dealership',
    role: ROLE,
    timestamp: new Date().toISOString(),
    browser: `Chromium ${browser.version()}`,
    loginOutcome: null,
    landedUrl: null,
    dark: null,
    light: null,
    imageNetwork: [],
    failedImageRequests: [],
    consoleErrors: [],
    error: null,
  };

  console.log(`\n=== Flow A :: ${sub} ===`);
  try {
    const loginUrl = withGhost(`${base}/login`);
    const resp = await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    console.log(`  login page HTTP ${resp?.status()} ${loginUrl}`);
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
    await page.locator('input[name="username"]').waitFor({ timeout: NAV_TIMEOUT });
    await page.locator('input[name="username"]').fill(USERNAME);
    await page.locator('input[name="password"]').fill(PASSWORD);

    const combo = page.locator('p-select').first();
    if (await combo.count()) {
      const current = (await combo.innerText()).trim().toUpperCase();
      if (current !== ROLE) {
        await combo.click();
        const opt = page.locator('.p-select-option', { hasText: new RegExp(`^${ROLE}$`, 'i') });
        await opt.first().waitFor({ state: 'visible', timeout: 15000 });
        await opt.first().click();
        await page.waitForTimeout(300);
      }
    }
    await page.locator('input[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: NAV_TIMEOUT });
    record.loginOutcome = 'success';
    record.landedUrl = page.url();
    console.log(`  logged in -> ${record.landedUrl}`);

    await waitForDashboard(page);

    // --- Dark theme (default landing state) ---
    record.dark = await inspectLogo(page);
    await page.screenshot({ path: path.join(dealerDir, 'dark-dashboard.png') }).catch(() => {});
    // Tight crop of the header for logo evidence.
    const headerLoc = page.locator('div.mdkpi-header, header').first();
    await headerLoc.screenshot({ path: path.join(dealerDir, 'dark-header.png') }).catch(() => {});
    console.log(`  dark : ${record.dark.found ? record.dark.classification : 'logo element not found'} (nat ${record.dark.naturalWidth ?? '-'}x${record.dark.naturalHeight ?? '-'}) ${record.dark.src ?? ''}`);

    // --- Light theme ---
    const t = await toggleTheme(page);
    await page.waitForTimeout(500);
    record.light = await inspectLogo(page);
    record.light.themeToggle = t;
    await page.screenshot({ path: path.join(dealerDir, 'light-dashboard.png') }).catch(() => {});
    await headerLoc.screenshot({ path: path.join(dealerDir, 'light-header.png') }).catch(() => {});
    console.log(`  light: ${record.light.found ? record.light.classification : 'logo element not found'} (toggled=${t.toggled}, theme=${record.light.theme}) ${record.light.src ?? ''}`);

    await logout(page, base);
    console.log(`  logged out`);
  } catch (e) {
    record.error = redact(e.message.split('\n')[0]);
    record.loginOutcome = record.loginOutcome ?? 'failed';
    console.log(`  ERROR: ${record.error}`);
    await page.screenshot({ path: path.join(dealerDir, 'error.png') }).catch(() => {});
  }

  record.imageNetwork = imageNetwork;
  record.failedImageRequests = failedRequests;
  record.consoleErrors = consoleErrors;
  // Cross-reference: HTTP status of the logo's own image request.
  if (record.dark?.src) {
    const net = imageNetwork.find((n) => n.url === record.dark.src);
    record.dark.httpStatus = net?.status ?? null;
  }
  if (record.light?.src) {
    const net = imageNetwork.find((n) => n.url === record.light.src);
    record.light.httpStatus = net?.status ?? null;
  }

  await writeFile(path.join(dealerDir, 'result.json'), JSON.stringify(record, null, 2), 'utf8');
  results.push(record);

  await context.close();

  // Flag the first confirmed broken/missing logo loudly so the run can be stopped and reported.
  const darkBad = record.dark?.found && record.dark.classification !== 'ok';
  const lightBad = record.light?.found && record.light.classification !== 'ok';
  if (darkBad || lightBad) {
    console.log(`\n  *** POSSIBLE REPRODUCTION on ${sub}: dark=${record.dark?.classification} light=${record.light?.classification} ***`);
  }
}

await writeFile(path.join(OUT, 'summary.json'), JSON.stringify({ flow: 'Direct Dealership', runId: RUN_ID, results }, null, 2), 'utf8');

console.log(`\n\n===== Flow A summary =====`);
for (const r of results) {
  const d = r.dark?.found ? r.dark.classification : (r.error ? 'ERR' : 'n/f');
  const l = r.light?.found ? r.light.classification : (r.error ? 'ERR' : 'n/f');
  console.log(`  ${r.dealer.padEnd(9)} login=${(r.loginOutcome ?? '-').padEnd(7)} dark=${String(d).padEnd(7)} light=${String(l).padEnd(7)} ${r.error ? '(' + r.error + ')' : ''}`);
}
console.log(`\nArtifacts -> ${OUT}`);

await browser.close();
