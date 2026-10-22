/**
 * The automatable WAF checks. Each function takes a live, logged-in page plus a
 * network collector and returns one or more ResultRows. Every check follows the
 * same contract: navigate/act, look at captured responses, and decide PASS/FAIL by
 * "was there a 403?" (the story's universal acceptance criterion for the non-attack
 * cases). Screenshots are written by the caller so paths stay relative to the run dir.
 */
import { Verdict, row } from './types.mjs';

const SETTLE = 1500;

/**
 * Fuller settle for screenshots: wait for network idle, then for the app's loading
 * indicators to disappear, so captures show a finished page with real data rather than
 * the "LOADING…" splash. Handles this portal's specific overlay (MyDealerKPI spinner
 * with "LOADING…" text) plus generic PrimeNG/CSS spinner classes. Falls back on a fixed
 * wait if the indicator never resolves (e.g. genuinely empty data), so the run never
 * hangs on one page.
 */
async function settleFully(page, navTimeout) {
  await page.waitForLoadState('networkidle', { timeout: navTimeout }).catch(() => {});
  const spinnerSelectors = [
    '.p-progressspinner', '.loading', '.loader', '.loading-spinner', '.spinner',
    '[class*="spinner"]', '[class*="loading"]', '[class*="loader"]',
  ].join(', ');
  await page
    .waitForFunction(
      (sel) => {
        const hidden = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0;
        };
        // 1. No visible spinner element.
        const spinnersGone = Array.from(document.querySelectorAll(sel)).every(hidden);
        // 2. No visible "LOADING..." text (the portal's splash overlay).
        const bodyText = document.body ? document.body.innerText : '';
        const loadingTextGone = !/\bLOADING\s*\.\.\.|\bLOADING…/i.test(bodyText);
        return spinnersGone && loadingTextGone;
      },
      spinnerSelectors,
      { timeout: 12000, polling: 300 },
    )
    .catch(() => {});
  // Small extra beat so freshly-rendered grids/charts paint before the capture.
  await page.waitForTimeout(1800);
}

// The default settle used by every navigation now waits for data to finish loading,
// so screenshots taken after it show real content, not the loading splash.
async function settle(page, navTimeout) {
  await settleFully(page, navTimeout);
}

// Exposed so the runner's shot() helper can settle any page (login, cross-browser,
// attack) right before capture — one place guarantees no blank/loading screenshots.
export async function settleForShot(page, navTimeout = 30000) {
  await settleFully(page, navTimeout);
}

/**
 * Asset integrity for one route (post-WAF asset check the user asked for):
 *  - any first-party asset (img/js/css/font) returning 4xx/5xx, especially 403/404
 *  - any <img> in the DOM that failed to render (naturalWidth === 0)
 * Returns one ResultRow per route.
 */
export async function assetIntegrity(ctx, caseMeta, path) {
  const { page, net, base, domain, role, navTimeout, shot } = ctx;
  const url = `${base}${path}`;
  net.mark();
  let status = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    status = resp?.status() ?? null;
  } catch {
    status = 'ERR';
  }
  await settleFully(page, navTimeout);

  const assetFailures = net.assetFailures();
  // Broken images in the rendered DOM (loaded but zero-size, or explicit error).
  const brokenImgs = await page
    .evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs
        .filter((im) => {
          // complete && naturalWidth === 0 means it finished trying and failed to decode.
          const src = im.currentSrc || im.src || '';
          if (!src || src.startsWith('data:')) return false;
          return im.complete && im.naturalWidth === 0;
        })
        .map((im) => im.currentSrc || im.src)
        .slice(0, 25);
    })
    .catch(() => []);

  const shotPath = await shot(`${caseMeta.id}_${role}_${path.replace(/[^a-z0-9]+/gi, '-')}`);
  const problems = [
    ...assetFailures.map((f) => `${f.status} ${f.type} ${f.url}`),
    ...brokenImgs.map((s) => `broken-img ${s}`),
  ];
  const ok = problems.length === 0 && status !== 'ERR';
  return [
    row({
      caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
      url,
      verdict: ok ? Verdict.PASS : Verdict.FAIL,
      result: ok
        ? `All assets/images loaded; no 403/404`
        : `${assetFailures.length} asset 4xx/5xx, ${brokenImgs.length} broken image(s)`,
      statusCode: status ?? '-',
      screenshot: shotPath,
      forbidden: problems,
    }),
  ];
}

/** Navigate one route, measure load time, and judge by any 403. */
async function visit(page, net, base, path, navTimeout) {
  const url = `${base}${path}`;
  net.mark();
  const t0 = Date.now();
  let status = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    status = resp?.status() ?? null;
  } catch (err) {
    return { url, status: 'ERR', loadMs: Date.now() - t0, forbidden: [], assetFailures: [], consoleErrors: [String(err.message)], navError: true };
  }
  await settle(page, navTimeout);
  const loadMs = Date.now() - t0;
  const forbidden = net.forbidden();
  const assetFailures = net.assetFailures();
  const consoleErrors = net.consoleErrors();
  return { url, status, loadMs, forbidden, assetFailures, consoleErrors, navError: false };
}

function verdictFor(nav) {
  if (nav.navError) return Verdict.FAIL;
  if (nav.forbidden.length) return Verdict.FAIL;
  if (nav.assetFailures?.length) return Verdict.FAIL;
  return Verdict.PASS;
}

function resultText(nav) {
  if (nav.navError) return `Navigation error: ${nav.consoleErrors[0] ?? 'unknown'}`;
  if (nav.forbidden.length) {
    return `403/401 on ${nav.forbidden.length} request(s): ${nav.forbidden.slice(0, 3).map((f) => f.url).join(', ')}`;
  }
  if (nav.assetFailures?.length) {
    return `${nav.assetFailures.length} asset 4xx/5xx: ${nav.assetFailures.slice(0, 3).map((f) => `${f.status} ${f.url}`).join(', ')}`;
  }
  return `Loaded; ${nav.status ?? '?'}; no 403/404 across assets`;
}

/**
 * WAF-01 login page loads (checked pre-login by caller passing the login URL path "").
 * Here we treat the landing/dashboard as the representative authenticated page.
 */
export async function routeSweep(ctx, caseMeta, paths) {
  // WAF-02/03/07: visit every route, one row each.
  const { page, net, base, domain, role, navTimeout, shot } = ctx;
  const rows = [];
  for (const p of paths) {
    const nav = await visit(page, net, base, p, navTimeout);
    const shotPath = await shot(`${caseMeta.id}_${role}_${p.replace(/[^a-z0-9]+/gi, '-')}`);
    const chunkErrs = nav.consoleErrors.filter((e) => /chunk|failed to load|Loading chunk/i.test(e));
    let verdict = verdictFor(nav);
    let result = resultText(nav);
    if (verdict === Verdict.PASS && caseMeta.id === 'WAF-07' && chunkErrs.length) {
      verdict = Verdict.FAIL;
      result = `Chunk load error: ${chunkErrs[0]}`;
    }
    rows.push(
      row({
        caseId: caseMeta.id,
        caseTitle: caseMeta.title,
        group: caseMeta.group,
        role,
        domain,
        url: nav.url,
        verdict,
        result,
        statusCode: nav.status ?? '-',
        screenshot: shotPath,
        forbidden: [
          ...nav.forbidden.map((f) => `${f.status} ${f.url}`),
          ...(nav.assetFailures ?? []).map((f) => `${f.status} ${f.type} ${f.url}`),
        ],
        consoleErrors: chunkErrs,
        loadMs: nav.loadMs,
      }),
    );
  }
  return rows;
}

/** WAF-04: reload a report and confirm same page, no block. */
export async function refresh(ctx, caseMeta, path) {
  const { page, net, base, domain, role, navTimeout, shot } = ctx;
  await visit(page, net, base, path, navTimeout);
  const before = page.url();
  net.mark();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(() => {});
  await settle(page, navTimeout);
  const after = page.url();
  const forbidden = net.forbidden();
  const same = before === after;
  const shotPath = await shot(`${caseMeta.id}_${role}`);
  const ok = same && !forbidden.length;
  return [
    row({
      caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
      url: after,
      verdict: ok ? Verdict.PASS : Verdict.FAIL,
      result: ok ? 'Reloaded to same page; no 403' : `same=${same}, 403s=${forbidden.length}`,
      statusCode: '-', screenshot: shotPath,
      forbidden: forbidden.map((f) => `${f.status} ${f.url}`),
    }),
  ];
}

/** WAF-06: navigate several pages, then back/forward. */
export async function backForward(ctx, caseMeta, paths) {
  const { page, net, base, domain, role, navTimeout, shot } = ctx;
  for (const p of paths.slice(0, 5)) await visit(page, net, base, p, navTimeout);
  net.mark();
  await page.goBack({ timeout: navTimeout }).catch(() => {});
  await settle(page, navTimeout);
  await page.goBack({ timeout: navTimeout }).catch(() => {});
  await settle(page, navTimeout);
  await page.goForward({ timeout: navTimeout }).catch(() => {});
  await settle(page, navTimeout);
  const forbidden = net.forbidden();
  const shotPath = await shot(`${caseMeta.id}_${role}`);
  return [
    row({
      caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
      url: page.url(),
      verdict: forbidden.length ? Verdict.FAIL : Verdict.PASS,
      result: forbidden.length ? `403s during history nav: ${forbidden.length}` : 'Back/forward worked; no 403',
      statusCode: '-', screenshot: shotPath,
      forbidden: forbidden.map((f) => `${f.status} ${f.url}`),
    }),
  ];
}

/** WAF-05 / WAF-13: open a deep URL in a brand-new context (shared-link style). */
export async function newContextOpen(ctx, caseMeta, path, extraQuery = '') {
  const { browser, base, domain, role, navTimeout, shot, storageState } = ctx;
  const fresh = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true, storageState });
  const p = await fresh.newPage();
  const { collect } = await import('./net.mjs');
  const net = collect(p, { originHost: domain });
  const url = `${base}${path}${extraQuery}`;
  net.mark();
  let status = null;
  try {
    const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    status = resp?.status() ?? null;
  } catch (err) {
    status = 'ERR';
  }
  await settle(p, navTimeout);
  const forbidden = net.forbidden();
  const shotPath = await shot(`${caseMeta.id}_${role}`, p);
  await fresh.close();
  return [
    row({
      caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
      url,
      verdict: forbidden.length || status === 'ERR' ? Verdict.FAIL : Verdict.PASS,
      result: status === 'ERR' ? 'Navigation error' : forbidden.length ? `403s: ${forbidden.length}` : 'Opened in fresh context; no 403',
      statusCode: status ?? '-', screenshot: shotPath,
      forbidden: forbidden.map((f) => `${f.status} ${f.url}`),
    }),
  ];
}

/** WAF-10/11/12/14: exercise query strings against a report route. */
export async function queryStrings(ctx, caseMeta, path, queries) {
  const { page, net, base, domain, role, navTimeout, shot } = ctx;
  const rows = [];
  for (const q of queries) {
    const nav = await visit(page, net, base, `${path}${q.qs}`, navTimeout);
    const shotPath = await shot(`${caseMeta.id}_${role}_${q.label.replace(/[^a-z0-9]+/gi, '-')}`);
    rows.push(
      row({
        caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
        url: nav.url,
        verdict: verdictFor(nav),
        result: `${q.label}: ${resultText(nav)}`,
        statusCode: nav.status ?? '-', screenshot: shotPath,
        forbidden: nav.forbidden.map((f) => `${f.status} ${f.url}`),
      }),
    );
  }
  return rows;
}

/** WAF-30: refresh a page many times quickly; report any block and whether it clears. */
export async function refreshStorm(ctx, caseMeta, path, times = 30) {
  const { page, net, base, domain, role, navTimeout, shot } = ctx;
  await visit(page, net, base, path, navTimeout);
  net.mark();
  let blockedAt = -1;
  for (let i = 0; i < times; i++) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(() => {});
    await page.waitForTimeout(300);
    if (net.forbidden().length && blockedAt < 0) blockedAt = i + 1;
  }
  await settle(page, navTimeout);
  const forbidden = net.forbidden();
  const shotPath = await shot(`${caseMeta.id}_${role}`);
  const blocked = forbidden.length > 0;
  return [
    row({
      caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
      url: page.url(),
      // Rate-limit behaviour is acceptable per the story; a block that follows the rule is INFO, not FAIL.
      verdict: blocked ? Verdict.INFO : Verdict.PASS,
      result: blocked ? `Rate-limited after ~${blockedAt} refreshes (expected per rule; verify it clears after the window)` : `${times} refreshes, no block`,
      statusCode: '-', screenshot: shotPath,
      forbidden: forbidden.map((f) => `${f.status} ${f.url}`),
    }),
  ];
}

/** WAF-20: with session cleared, hitting a deep route should redirect to login, not 403. */
export async function sessionExpiry(ctx, caseMeta, path) {
  const { page, net, base, domain, role, navTimeout, shot, context } = ctx;
  const { clearSession } = await import('./auth.mjs');
  await clearSession(context);
  const nav = await visit(page, net, base, path, navTimeout);
  const landed = page.url();
  const redirectedToLogin = /\/login/.test(landed);
  const shotPath = await shot(`${caseMeta.id}_${role}`);
  const ok = redirectedToLogin && !nav.forbidden.length;
  return [
    row({
      caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
      url: landed,
      verdict: ok ? Verdict.PASS : Verdict.FAIL,
      result: ok ? 'Redirected to login; no 403' : `login=${redirectedToLogin}, 403s=${nav.forbidden.length}`,
      statusCode: nav.status ?? '-', screenshot: shotPath,
      forbidden: nav.forbidden.map((f) => `${f.status} ${f.url}`),
    }),
  ];
}

/** WAF-43: caching — load twice, second load should serve from cache (304/from cache). */
export async function caching(ctx, caseMeta, path) {
  const { page, net, base, domain, role, navTimeout, shot } = ctx;
  await visit(page, net, base, path, navTimeout);
  net.mark();
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(() => {});
  await settle(page, navTimeout);
  const all = net.all();
  const cached = all.filter((r) => r.status === 304).length;
  const shotPath = await shot(`${caseMeta.id}_${role}`);
  return [
    row({
      caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
      url: `${base}${path}`,
      verdict: net.forbidden().length ? Verdict.FAIL : Verdict.INFO,
      result: `Second load: ${cached} request(s) served 304 (from-cache also possible via memory/disk, not visible to network events)`,
      statusCode: '-', screenshot: shotPath,
      forbidden: net.forbidden().map((f) => `${f.status} ${f.url}`),
    }),
  ];
}
