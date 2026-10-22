/**
 * Broken-logo hunt — reproduce the intermittent broken-IMAGE issue. READ-ONLY.
 *
 * Focus: the dealership header logo failing to LOAD (renders as a broken image),
 * not theme readability. A logo is "broken" when its <img> reports
 * complete===false or naturalWidth===0, and/or the logo's own network request
 * returns a non-2xx status (404/403/5xx) or fails outright.
 *
 * The issue is reported as intermittent and possibly tied to the login flow, to
 * repeated logout/login cycles, or to AutoGroup->dealership navigation. So this
 * runner supports:
 *   --flow A         Direct Dealership login (DEALER role)        [default]
 *   --flow B         Direct AutoGroup login  (AUTOGROUP role)
 *   --cycles N       repeat login->inspect->logout N times per dealer [default 1]
 *   --dealers a,b    comma list of subdomains (default: full list)
 *   --theme dark|light   which theme to inspect in (default dark; theme is NOT
 *                        toggled during a run so it is not a confounding variable)
 *
 * Stops nothing automatically; it logs a loud marker on the first genuine broken
 * image so the operator can halt and report. Never writes the password to disk.
 *
 * Usage:
 *   node scripts/logo-hunt.mjs --flow A --cycles 1
 *   node scripts/logo-hunt.mjs --flow A --cycles 5 --dealers am-gyb,am-bof
 *   node scripts/logo-hunt.mjs --flow B --cycles 1
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

dotenv.config();

const USERNAME = required('KPI_USERNAME');
const PASSWORD = required('KPI_PASSWORD');
const ROLE_DEALER = (process.env.KPI_ROLE_DEALER ?? 'DEALER').toUpperCase();
const ROLE_AUTOGROUP = (process.env.KPI_ROLE_AUTOGROUP ?? 'AUTOGROUP').toUpperCase();
const HEADLESS = process.env.KPI_HEADLESS !== 'false';
const NAV_TIMEOUT = Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000);
const SLOWMO = Number(process.env.KPI_SLOWMO_MS ?? 0);

const ALL_DEALERS = [
  'am-gyb', 'am-mom', 'am-fmi', 'am-lni', 'am-ptb', 'am-phb', 'am-atot',
  'am-r1h', 'am-rh', 'am-mwh', 'am-mwa', 'am-tmv', 'am-bof',
];

const args = parseArgs(process.argv.slice(2));
const FLOW = String(args.flow ?? 'A').toUpperCase();
const CYCLES = Math.max(1, Number(args.cycles ?? 1));
const THEME = String(args.theme ?? 'dark').toLowerCase();
const dealers = args.dealers ? String(args.dealers).split(',').map((s) => s.trim()).filter(Boolean) : ALL_DEALERS;
const ROLE = FLOW === 'B' ? ROLE_AUTOGROUP : ROLE_DEALER;

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join('artifacts', 'logo-investigation', `flow-${FLOW.toLowerCase()}`, RUN_ID);

function required(key) {
  const v = process.env[key];
  if (!v) { console.error(`Missing ${key} in .env`); process.exit(1); }
  return v;
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
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

/**
 * Read the header-logo element's load state. "broken" is the genuine broken-image
 * condition: the browser could not decode/display the image.
 */
async function inspectLogo(page) {
  return page.evaluate(() => {
    const header = document.querySelector('div.mdkpi-header, header, [class*="mdkpi-header"]');
    const scope = header ?? document;
    let logo = scope.querySelector('img[alt="logo" i]');
    if (!logo && header) {
      const imgs = [...header.querySelectorAll('img')].filter((im) => {
        const r = im.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      imgs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      logo = imgs.find((im) => !/md-logo|logo-big|small-logo|mydealerkpi/i.test(im.currentSrc || im.src)) ?? imgs[0] ?? null;
    }
    const theme = document.documentElement.className.includes('mdkpi-light-mode') ? 'light' : 'dark';
    if (!logo) return { theme, found: false, classification: 'element-not-found' };

    const r = logo.getBoundingClientRect();
    const src = logo.currentSrc || logo.src || null;
    const hasSrc = Boolean(logo.getAttribute('src'));
    const broken = !logo.complete || logo.naturalWidth === 0;
    let classification;
    if (broken) classification = hasSrc ? 'broken' : 'missing-src';
    else if (r.width === 0 || r.height === 0) classification = 'missing-render';
    else classification = 'ok';

    return {
      theme, found: true, src, hasSrc,
      complete: logo.complete,
      naturalWidth: logo.naturalWidth,
      naturalHeight: logo.naturalHeight,
      displayedW: Math.round(r.width),
      displayedH: Math.round(r.height),
      doubleSlashInPath: /\/\/uploads\/\//.test(src ?? '') || /uploads\/\//.test(src ?? ''),
      broken,
      classification,
    };
  });
}

async function waitForDashboard(page) {
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
  for (const sel of ['text=LOADING', '.p-progress-spinner', '[class*="loader"]']) {
    await page.locator(sel).first().waitFor({ state: 'hidden', timeout: 25000 }).catch(() => {});
  }
  await page.waitForTimeout(1500);
}

async function login(page, base, role) {
  const loginUrl = withGhost(`${base}/login`);
  const resp = await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.locator('input[name="username"]').waitFor({ timeout: NAV_TIMEOUT });
  await page.locator('input[name="username"]').fill(USERNAME);
  await page.locator('input[name="password"]').fill(PASSWORD);
  const combo = page.locator('p-select').first();
  if (await combo.count()) {
    const current = (await combo.innerText()).trim().toUpperCase();
    if (current !== role) {
      await combo.click();
      const opt = page.locator('.p-select-option', { hasText: new RegExp(`^${role}$`, 'i') });
      await opt.first().waitFor({ state: 'visible', timeout: 15000 });
      await opt.first().click();
      await page.waitForTimeout(300);
    }
  }
  await page.locator('input[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: NAV_TIMEOUT });
  return { loginHttp: resp?.status() ?? null, landedUrl: page.url() };
}

async function logout(page, base) {
  try {
    await page.context().clearCookies();
    await page.goto(withGhost(`${base}/login`), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
  } catch { /* best-effort */ }
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO, args: ['--start-maximized'] });
const BROWSER_VERSION = `Chromium ${browser.version()}`;
const attempts = [];
let firstBrokenReported = false;

console.log(`\nBroken-logo hunt :: flow=${FLOW} role=${ROLE} theme=${THEME} cycles=${CYCLES} dealers=${dealers.length}`);
console.log(`Browser: ${BROWSER_VERSION}\n`);

for (const sub of dealers) {
  const base = `https://${sub}.mydealerkpi.com`;
  const dealerDir = path.join(OUT, sub);
  await mkdir(dealerDir, { recursive: true });

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
    const page = await context.newPage();

    const imageNetwork = [];
    page.on('response', (resp) => {
      if (resp.request().resourceType() === 'image') {
        imageNetwork.push({ url: resp.url(), status: resp.status(), ok: resp.ok(), fromCache: resp.request().timing ? undefined : undefined });
      }
    });
    const failedRequests = [];
    page.on('requestfailed', (req) => {
      if (req.resourceType() === 'image') failedRequests.push({ url: req.url(), failure: req.failure()?.errorText ?? null });
    });
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(redact(m.text())); });

    const rec = {
      dealer: sub, url: base, flow: FLOW === 'B' ? 'Direct AutoGroup' : 'Direct Dealership',
      role: ROLE, cycle, timestamp: new Date().toISOString(), browser: BROWSER_VERSION,
      loginOutcome: null, loginHttp: null, landedUrl: null, logo: null,
      logoHttpStatus: null, logoRequestFailed: null, imageNetwork: [], failedImageRequests: [],
      consoleErrors: [], error: null,
    };

    const tag = `${sub} [cycle ${cycle}/${CYCLES}]`;
    try {
      const { loginHttp, landedUrl } = await login(page, base, ROLE);
      rec.loginOutcome = 'success';
      rec.loginHttp = loginHttp;
      rec.landedUrl = landedUrl;
      await waitForDashboard(page);

      rec.logo = await inspectLogo(page);

      // Cross-reference the logo's own network request status.
      if (rec.logo?.src) {
        const net = imageNetwork.find((n) => n.url === rec.logo.src);
        rec.logoHttpStatus = net?.status ?? null;
        rec.logoRequestFailed = failedRequests.find((f) => f.url === rec.logo.src) ?? null;
      }

      // Screenshot evidence (header crop + full dashboard) — always, so a later
      // broken case has a before/after neighbour to compare against.
      const headerLoc = page.locator('div.mdkpi-header, header').first();
      const stamp = `c${cycle}`;
      await headerLoc.screenshot({ path: path.join(dealerDir, `${stamp}-header.png`) }).catch(() => {});

      // A genuine broken image: img load failed, OR the logo URL returned non-2xx,
      // OR the logo network request outright failed.
      const netBad = rec.logoHttpStatus != null && (rec.logoHttpStatus < 200 || rec.logoHttpStatus >= 300);
      const genuinelyBroken = (rec.logo.found && (rec.logo.classification === 'broken' || rec.logo.classification === 'missing-src' || rec.logo.classification === 'missing-render'))
        || netBad || Boolean(rec.logoRequestFailed) || !rec.logo.found;

      console.log(`  ${tag}: logo=${rec.logo.found ? rec.logo.classification : 'NOT-FOUND'} nat=${rec.logo.naturalWidth ?? '-'}x${rec.logo.naturalHeight ?? '-'} httpLogo=${rec.logoHttpStatus ?? '-'}${rec.logoRequestFailed ? ' REQ-FAILED' : ''}${rec.logo?.doubleSlashInPath ? ' [//path]' : ''}`);

      if (genuinelyBroken) {
        await page.screenshot({ path: path.join(dealerDir, `${stamp}-BROKEN-dashboard.png`) }).catch(() => {});
        console.log(`\n  *** GENUINE BROKEN LOGO: ${tag} ***`);
        console.log(`      classification=${rec.logo.classification} httpLogo=${rec.logoHttpStatus} reqFailed=${JSON.stringify(rec.logoRequestFailed)} src=${rec.logo.src}`);
        if (!firstBrokenReported) {
          firstBrokenReported = true;
          console.log(`      >>> FIRST reproduction — recommend halting to report. Evidence in ${dealerDir}`);
        }
      }

      await logout(page, base);
    } catch (e) {
      rec.error = redact(e.message.split('\n')[0]);
      rec.loginOutcome = rec.loginOutcome ?? 'failed';
      console.log(`  ${tag}: ERROR ${rec.error}`);
      await page.screenshot({ path: path.join(dealerDir, `c${cycle}-error.png`) }).catch(() => {});
    }

    rec.imageNetwork = imageNetwork;
    rec.failedImageRequests = failedRequests;
    rec.consoleErrors = consoleErrors;
    await writeFile(path.join(dealerDir, `c${cycle}-result.json`), JSON.stringify(rec, null, 2), 'utf8');
    attempts.push(rec);

    await context.close();
  }
}

await writeFile(path.join(OUT, 'summary.json'), JSON.stringify({
  flow: FLOW, role: ROLE, theme: THEME, cycles: CYCLES, browser: BROWSER_VERSION,
  dealersTested: dealers.length, totalAttempts: attempts.length, runId: RUN_ID, attempts,
}, null, 2), 'utf8');

console.log(`\n===== Hunt summary (flow ${FLOW}, ${CYCLES} cycle(s)) =====`);
const broken = attempts.filter((a) => {
  const netBad = a.logoHttpStatus != null && (a.logoHttpStatus < 200 || a.logoHttpStatus >= 300);
  return (a.logo && ['broken', 'missing-src', 'missing-render'].includes(a.logo.classification)) || netBad || a.logoRequestFailed || (a.logo && !a.logo.found && !a.error);
});
for (const a of attempts) {
  const c = a.logo?.found ? a.logo.classification : (a.error ? 'ERR' : 'NOT-FOUND');
  console.log(`  ${a.dealer.padEnd(9)} c${a.cycle} login=${(a.loginOutcome ?? '-').padEnd(7)} logo=${String(c).padEnd(14)} httpLogo=${a.logoHttpStatus ?? '-'}`);
}
console.log(`\nTotal attempts: ${attempts.length} | genuine broken: ${broken.length}`);
console.log(`Artifacts -> ${OUT}`);

await browser.close();
process.exit(0);
