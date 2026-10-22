/**
 * Flow C — "Navigate to Dealership" from the AutoGroup header. READ-ONLY.
 *
 * One AutoGroup login, then step through the Navigate-to-Dealership selector,
 * hopping dealership -> dealership within the SAME session. At each hop, inspect
 * the dealership header logo (load state + the logo URL's HTTP status) and record
 * the exact navigation sequence. This exercises the client-side logo swap that is
 * the most likely home of an intermittent broken-image bug.
 *
 * Options:
 *   --dealers a,b,c   AM-XXX codes to visit, in order (default: the 13 target codes)
 *   --sequence seq    'list'  = visit --dealers in order once           [default]
 *                     'all'   = visit every dealership in the group list once
 *                     'repeat'= cycle through --dealers --loops times
 *   --loops N         number of passes when --sequence repeat (default 3)
 *
 * The selector is re-opened from the dealership page each hop (the Navigate-to-
 * Dealership control is available in the dealership header too; if not, we fall
 * back to returning to /auto-group/dashboard and selecting from there).
 *
 * Never writes the password to disk.
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

dotenv.config();

const USERNAME = required('KPI_USERNAME');
const PASSWORD = required('KPI_PASSWORD');
const ROLE = (process.env.KPI_ROLE_AUTOGROUP ?? 'AUTOGROUP').toUpperCase();
const HEADLESS = process.env.KPI_HEADLESS !== 'false';
const NAV_TIMEOUT = Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000);
const SLOWMO = Number(process.env.KPI_SLOWMO_MS ?? 0);

// The entry subdomain used to reach the AutoGroup (any dealer subdomain in the
// group works; the AutoGroup app is reached from the same host after login).
const ENTRY = process.env.KPI_AG_ENTRY ?? 'am-gyb';
const BASE = `https://${ENTRY}.mydealerkpi.com`;

const TARGET_CODES = ['AM-GYB','AM-MOM','AM-FMI','AM-LNI','AM-PTB','AM-PHB','AM-ATOT','AM-R1H','AM-RH','AM-MWH','AM-MWA','AM-TMV','AM-BOF'];

const args = parseArgs(process.argv.slice(2));
const SEQUENCE = String(args.sequence ?? 'list').toLowerCase();
const LOOPS = Math.max(1, Number(args.loops ?? 3));
const wantCodes = args.dealers ? String(args.dealers).split(',').map((s) => s.trim().toUpperCase()) : TARGET_CODES;

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join('artifacts', 'logo-investigation', 'flow-c', RUN_ID);

function required(key) { const v = process.env[key]; if (!v) { console.error(`Missing ${key} in .env`); process.exit(1); } return v; }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith('--')) continue;
    const key = a.slice(2); const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
const withGhost = (u) => { const x = new URL(u); x.searchParams.set('ghost', 'true'); return x.toString(); };
const redact = (t) => (typeof t === 'string' ? t.split(PASSWORD).join('***REDACTED***') : t);
const codeOf = (optText) => (optText.match(/\(([^)]+)\)\s*$/)?.[1] ?? '').toUpperCase();

async function waitForDashboard(page) {
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
  for (const sel of ['text=LOADING', '.p-progress-spinner', '[class*="loader"]']) {
    await page.locator(sel).first().waitFor({ state: 'hidden', timeout: 25000 }).catch(() => {});
  }
  await page.waitForTimeout(1200);
}

async function inspectLogo(page) {
  return page.evaluate(() => {
    const header = document.querySelector('div.mdkpi-header, header.ag-header, header');
    const scope = header ?? document;
    let logo = scope.querySelector('img[alt="logo" i]');
    if (!logo && header) {
      const imgs = [...header.querySelectorAll('img')].filter((im) => { const r = im.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      imgs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      logo = imgs.find((im) => !/md-logo|logo-big|small-logo|mydealerkpi|profile-image/i.test(im.currentSrc || im.src)) ?? imgs[0] ?? null;
    }
    if (!logo) return { found: false, classification: 'element-not-found' };
    const r = logo.getBoundingClientRect();
    const src = logo.currentSrc || logo.src || null;
    const hasSrc = Boolean(logo.getAttribute('src'));
    const broken = !logo.complete || logo.naturalWidth === 0;
    let classification;
    if (broken) classification = hasSrc ? 'broken' : 'missing-src';
    else if (r.width === 0 || r.height === 0) classification = 'missing-render';
    else classification = 'ok';
    return {
      found: true, src, hasSrc, complete: logo.complete,
      naturalWidth: logo.naturalWidth, naturalHeight: logo.naturalHeight,
      displayedW: Math.round(r.width), displayedH: Math.round(r.height),
      broken, classification,
    };
  });
}

/** Open the Navigate-to-Dealership selector wherever we currently are. */
async function openNavSelect(page) {
  for (const loc of [
    page.locator('[aria-label="Navigate to Dealership" i]'),
    page.locator('span.p-select-label', { hasText: /navigate to dealership/i }),
    page.getByText('NAVIGATE TO DEALERSHIP', { exact: false }).first(),
  ]) {
    if (await loc.count()) {
      await loc.first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(900);
      if (await page.locator('.p-select-option, li[role="option"]').count()) return true;
    }
  }
  return false;
}

/**
 * Return to a fully-rendered AutoGroup dashboard via the in-app "BACK TO
 * ENTERPRISE" button in the dealership header.
 *
 * Verified in recon: a hard navigation to /auto-group/dashboard?ghost=true loads
 * the URL but does NOT rehydrate the AutoGroup shell (the Navigate-to-Dealership
 * control is absent), whereas the in-app BACK TO ENTERPRISE button restores it.
 * This is also the natural user journey for Flow C.
 */
async function backToEnterprise(page) {
  const btn = page.locator('button', { hasText: /back to enterprise/i }).first();
  if (await btn.count()) {
    await btn.click({ timeout: 10000 }).catch(() => {});
    await page.waitForURL((u) => /auto-group/.test(u.href), { timeout: NAV_TIMEOUT }).catch(() => {});
    await waitForDashboard(page);
    // Confirm the selector is actually present again.
    if (await page.locator('[aria-label="Navigate to Dealership" i]').count()) return true;
  }
  return false;
}

/**
 * Recovery: re-establish a fully-rendered AutoGroup dashboard via a fresh login.
 * Used only if BACK TO ENTERPRISE is unavailable, so a single failed hop cannot
 * abort the whole sequence. Defined as a hoisted function so it is callable from
 * the main loop above its lexical position.
 */
async function gotoAutoGroupViaLogin(page) {
  await page.context().clearCookies().catch(() => {});
  await page.goto(withGhost(`${BASE}/login`), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.locator('input[name="username"]').fill(USERNAME);
  await page.locator('input[name="password"]').fill(PASSWORD);
  const combo = page.locator('p-select').first();
  if (await combo.count() && (await combo.innerText()).trim().toUpperCase() !== ROLE) {
    await combo.click();
    await page.locator('.p-select-option', { hasText: new RegExp(`^${ROLE}$`, 'i') }).first().click();
    await page.waitForTimeout(300);
  }
  await page.locator('input[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: NAV_TIMEOUT });
  await waitForDashboard(page);
}

/**
 * Select a dealership by its AM-XXX code via the Navigate-to-Dealership control.
 * Selecting the option commits the navigation (there is no separate submit button).
 * Caller must ensure we are on a fully-rendered AutoGroup dashboard first.
 */
async function navigateToDealer(page, code) {
  const opened = await openNavSelect(page);
  if (!opened) throw new Error('could not open Navigate-to-Dealership selector (not on a rendered AutoGroup dashboard)');

  // Prefer typing into the select filter if present (122 options), else scan.
  const filter = page.locator('.p-select-filter, input.p-select-filter, .p-dropdown-filter').first();
  if (await filter.count()) {
    await filter.fill(code).catch(() => {});
    await page.waitForTimeout(500);
  }
  const option = page.locator('.p-select-option, li[role="option"]', { hasText: new RegExp(`\\(${code}\\)\\s*$`, 'i') }).first();
  await option.waitFor({ state: 'visible', timeout: 10000 });
  const label = (await option.innerText()).replace(/\s+/g, ' ').trim();
  await option.click();
  await page.waitForURL((u) => /\/v2\/dealership\//.test(u.href) || /dealership/.test(u.href), { timeout: NAV_TIMEOUT }).catch(() => {});
  await waitForDashboard(page);
  return label;
}

// Build the ordered list of codes to visit.
function buildSequence() {
  if (SEQUENCE === 'repeat') {
    const seq = [];
    for (let i = 0; i < LOOPS; i++) seq.push(...wantCodes);
    return seq;
  }
  return wantCodes; // 'list' and 'all' (all resolved after login) handled below
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO, args: ['--start-maximized'] });
const BROWSER_VERSION = `Chromium ${browser.version()}`;
const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
const page = await context.newPage();

const imageNetwork = [];
page.on('response', (r) => { if (r.request().resourceType() === 'image') imageNetwork.push({ url: r.url(), status: r.status(), ok: r.ok() }); });
const failedRequests = [];
page.on('requestfailed', (req) => { if (req.resourceType() === 'image') failedRequests.push({ url: req.url(), failure: req.failure()?.errorText ?? null }); });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(redact(m.text())); });

const hops = [];
let firstBroken = null;

console.log(`\nFlow C :: AutoGroup Navigate-to-Dealership`);
console.log(`Entry: ${BASE} | role=${ROLE} | sequence=${SEQUENCE}${SEQUENCE === 'repeat' ? ` loops=${LOOPS}` : ''}`);
console.log(`Browser: ${BROWSER_VERSION}\n`);

try {
  // --- AutoGroup login ---
  await page.goto(withGhost(`${BASE}/login`), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.locator('input[name="username"]').fill(USERNAME);
  await page.locator('input[name="password"]').fill(PASSWORD);
  const combo = page.locator('p-select').first();
  if (await combo.count() && (await combo.innerText()).trim().toUpperCase() !== ROLE) {
    await combo.click();
    await page.locator('.p-select-option', { hasText: new RegExp(`^${ROLE}$`, 'i') }).first().click();
    await page.waitForTimeout(300);
  }
  await page.locator('input[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: NAV_TIMEOUT });
  await waitForDashboard(page);
  console.log(`Logged in to AutoGroup -> ${page.url()}`);

  // If sequence=all, resolve the full group list from the selector.
  let codes = buildSequence();
  if (SEQUENCE === 'all') {
    await gotoAutoGroup(page);
    await openNavSelect(page);
    const opts = await page.locator('.p-select-option, li[role="option"]').allInnerTexts();
    codes = opts.map((o) => codeOf(o.replace(/\s+/g, ' ').trim())).filter(Boolean);
    await page.keyboard.press('Escape').catch(() => {});
    console.log(`Resolved ${codes.length} dealerships from the group list.`);
  }

  // Ensure we start on a rendered AutoGroup dashboard.
  if (!(await page.locator('[aria-label="Navigate to Dealership" i]').count())) {
    await gotoAutoGroupViaLogin(page);
  }

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const hop = { step: i + 1, code, timestamp: new Date().toISOString(), label: null, landedUrl: null, logo: null, logoHttpStatus: null, logoRequestFailed: null, returnedToEnterprise: null, error: null };
    const netBefore = imageNetwork.length;
    try {
      const label = await navigateToDealer(page, code);
      hop.label = label;
      hop.landedUrl = page.url();
      hop.logo = await inspectLogo(page);

      if (hop.logo?.src) {
        // Look only at image requests observed since this hop began.
        const recent = imageNetwork.slice(netBefore);
        const net = recent.find((n) => n.url === hop.logo.src) ?? imageNetwork.find((n) => n.url === hop.logo.src);
        hop.logoHttpStatus = net?.status ?? null;
        hop.logoRequestFailed = failedRequests.find((f) => f.url === hop.logo.src) ?? null;
      }

      const header = page.locator('div.mdkpi-header, header').first();
      await header.screenshot({ path: path.join(OUT, `step${String(i + 1).padStart(3, '0')}-${code}-header.png`) }).catch(() => {});

      const netBad = hop.logoHttpStatus != null && (hop.logoHttpStatus < 200 || hop.logoHttpStatus >= 300);
      const broken = (hop.logo.found && hop.logo.classification !== 'ok') || netBad || Boolean(hop.logoRequestFailed) || !hop.logo.found;

      console.log(`  [${i + 1}/${codes.length}] ${code.padEnd(8)} ${hop.logo.found ? hop.logo.classification.padEnd(14) : 'NOT-FOUND     '} nat=${hop.logo.naturalWidth ?? '-'}x${hop.logo.naturalHeight ?? '-'} httpLogo=${hop.logoHttpStatus ?? '-'}${hop.logoRequestFailed ? ' REQ-FAILED' : ''} ${hop.landedUrl}`);

      if (broken) {
        await page.screenshot({ path: path.join(OUT, `step${String(i + 1).padStart(3, '0')}-${code}-BROKEN.png`) }).catch(() => {});
        console.log(`\n  *** GENUINE BROKEN LOGO via Flow C: ${code} at step ${i + 1} ***`);
        console.log(`      classification=${hop.logo.classification} httpLogo=${hop.logoHttpStatus} reqFailed=${JSON.stringify(hop.logoRequestFailed)} src=${hop.logo.src}`);
        if (!firstBroken) {
          firstBroken = hop;
          console.log(`      >>> FIRST Flow-C reproduction at step ${i + 1} (prev dealer: ${i > 0 ? codes[i - 1] : '(none)'})`);
        }
      }
    } catch (e) {
      hop.error = redact(e.message.split('\n')[0]);
      console.log(`  [${i + 1}/${codes.length}] ${code}: ERROR ${hop.error}`);
      await page.screenshot({ path: path.join(OUT, `step${String(i + 1).padStart(3, '0')}-${code}-error.png`) }).catch(() => {});
    }
    hops.push(hop);

    // Return to the AutoGroup dashboard for the next hop, unless this was the last.
    if (i < codes.length - 1) {
      hop.returnedToEnterprise = await backToEnterprise(page);
      if (!hop.returnedToEnterprise) {
        // Recovery: re-establish a rendered AutoGroup dashboard via a fresh login.
        console.log(`      (BACK TO ENTERPRISE unavailable — recovering via AutoGroup re-login)`);
        await gotoAutoGroupViaLogin(page);
      }
    }
  }
} catch (e) {
  console.error(`FATAL: ${redact(e.message.split('\n')[0])}`);
  await page.screenshot({ path: path.join(OUT, 'fatal.png') }).catch(() => {});
}

await writeFile(path.join(OUT, 'summary.json'), JSON.stringify({
  flow: 'Navigate to Dealership', role: ROLE, sequence: SEQUENCE, loops: SEQUENCE === 'repeat' ? LOOPS : 1,
  browser: BROWSER_VERSION, entry: BASE, runId: RUN_ID, totalHops: hops.length,
  hops, imageNetwork, failedImageRequests: failedRequests, consoleErrors,
}, null, 2), 'utf8');

const broken = hops.filter((h) => {
  const netBad = h.logoHttpStatus != null && (h.logoHttpStatus < 200 || h.logoHttpStatus >= 300);
  return (h.logo && h.logo.found && h.logo.classification !== 'ok') || netBad || h.logoRequestFailed || (h.logo && !h.logo.found && !h.error);
});

console.log(`\n===== Flow C summary =====`);
console.log(`Total hops: ${hops.length} | genuine broken: ${broken.length}`);
if (broken.length) {
  console.log(`Broken at steps: ${broken.map((b) => `${b.step}:${b.code}`).join(', ')}`);
}
console.log(`Artifacts -> ${OUT}`);

await context.close();
await browser.close();
process.exit(0);
