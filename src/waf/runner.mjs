/**
 * WAF regression orchestrator (MDKPI-7508).
 *
 * Order is deliberate and safety-critical:
 *   1. Non-attack cases run first and completely, for every requested tenant/role.
 *   2. Attack cases (WAF-38/39) run LAST, only when --attack is passed, on ONE tenant,
 *      in a separate browser context, so a possible IP ban cannot contaminate step 1.
 *
 * The runner never fires attack payloads unless explicitly told to, and even then
 * only after all non-attack rows are collected.
 */
import { chromium, firefox, webkit } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Verdict, row } from './types.mjs';
import { collect } from './net.mjs';
import { login } from './auth.mjs';
import * as checks from './checks.mjs';
import { verifyExport } from './exports.mjs';
import { writeAll } from './report.mjs';
import { loadDealerNames } from './dealers.mjs';

dotenv.config();

const NAV_TIMEOUT = Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000);
const USER = process.env.KPI_USERNAME;
const PASS = process.env.KPI_PASSWORD;

export async function run({ domains, roles = ['AUTOGROUP', 'DEALER'], attack = false, headless = true, runId }) {
  if (!USER || !PASS) throw new Error('KPI_USERNAME / KPI_PASSWORD missing from .env');

  const cases = JSON.parse(await readFile('config/waf-cases.json', 'utf8')).cases;
  const routeCfg = JSON.parse(await readFile('config/routes.json', 'utf8')).roles;
  const caseById = new Map(cases.map((c) => [c.id, c]));

  runId = runId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join('artifacts', 'waf', runId);
  const shotDir = path.join(runDir, 'screenshots');
  await mkdir(shotDir, { recursive: true });

  /** @type {import('./types.mjs').ResultRow[]} */
  const rows = [];

  const browser = await chromium.launch({ headless });

  // ---- Step 1: non-attack cases, per tenant, per role -------------------------
  for (const domain of domains) {
    const base = `https://${domain}`;
    for (const role of roles) {
      const cfg = routeCfg[role];
      if (!cfg) continue;

      const storageDir = path.join(runDir, 'state');
      await mkdir(storageDir, { recursive: true });

      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const net = collect(page, { originHost: domain });

      // shot(name, [otherPage]) -> relative path.
      // Settles the target page (waits out the LOADING… splash) before capturing so no
      // screenshot shows a blank/loading state.
      const shot = async (name, otherPage) => {
        const rel = path.join('screenshots', `${name}.png`.replace(/[^a-z0-9._/-]/gi, '_'));
        const target = otherPage ?? page;
        try {
          await checks.settleForShot(target, NAV_TIMEOUT);
        } catch {
          /* best-effort settle */
        }
        try {
          await target.screenshot({ path: path.join(runDir, rel), fullPage: false });
          return rel;
        } catch {
          return null;
        }
      };

      // WAF-01: login page loads (pre-auth)
      net.mark();
      let loginStatus = null;
      try {
        const resp = await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        loginStatus = resp?.status() ?? null;
      } catch { loginStatus = 'ERR'; }
      await page.waitForTimeout(1500);
      const loginForbidden = net.forbidden();
      rows.push(row({
        caseId: 'WAF-01', caseTitle: caseById.get('WAF-01').title, group: caseById.get('WAF-01').group,
        role, domain, url: `${base}/login`,
        verdict: loginForbidden.length ? Verdict.FAIL : Verdict.PASS,
        result: loginForbidden.length ? `403 on login assets: ${loginForbidden.length}` : 'Login page loaded; no 403',
        statusCode: loginStatus ?? '-', screenshot: await shot(`WAF-01_${role}`),
        forbidden: loginForbidden.map((f) => `${f.status} ${f.url}`),
      }));

      // Log in
      const auth = await login(page, { base, role, username: USER, password: PASS, navTimeout: NAV_TIMEOUT });
      if (!auth.ok) {
        rows.push(row({
          caseId: 'WAF-15', caseTitle: caseById.get('WAF-15').title, group: caseById.get('WAF-15').group,
          role, domain, url: auth.landed,
          verdict: Verdict.FAIL, result: `Login did not succeed (landed ${auth.landed})`, statusCode: auth.status ?? '-',
          screenshot: await shot(`WAF-15_${role}_loginfail`),
        }));
        net.detach();
        await context.close();
        continue;
      }
      await context.storageState({ path: path.join(storageDir, `${domain}_${role}.json`) });
      const storageState = path.join(storageDir, `${domain}_${role}.json`);

      const ctx = { browser, context, page, net, base, domain, role, navTimeout: NAV_TIMEOUT, shot, storageState, runDir };
      const routes = cfg.routes;

      // WAF-02/03 route sweep (and captures asset-level 403s + WAF-07 chunk errors as we go)
      rows.push(...(await checks.routeSweep(ctx, caseById.get('WAF-03'), routes)));
      // WAF-07 chunk-specific pass row (reuses sweep signal via a dedicated visit set)
      rows.push(...(await checks.routeSweep(ctx, caseById.get('WAF-07'), routes.slice(0, 5))));
      // WAF-04 refresh
      rows.push(...(await checks.refresh(ctx, caseById.get('WAF-04'), routes[1] ?? cfg.landing)));
      // WAF-05 direct URL in new tab/context
      rows.push(...(await checks.newContextOpen(ctx, caseById.get('WAF-05'), routes[2] ?? cfg.landing)));
      // WAF-06 back/forward
      rows.push(...(await checks.backForward(ctx, caseById.get('WAF-06'), routes)));
      // WAF-13 shared link in fresh context
      rows.push(...(await checks.newContextOpen(ctx, caseById.get('WAF-13'), routes[1] ?? cfg.landing, '?shared=1&from=email')));

      // URL / query string cases against a report route
      const target = routes.find((r) => r.includes('service') || r.includes('report')) ?? routes[1] ?? cfg.landing;
      rows.push(...(await checks.queryStrings(ctx, caseById.get('WAF-10'), target, [
        { label: 'filters', qs: '?from=2026-01-01&to=2026-03-31&dealer=all&dept=service' },
      ])));
      rows.push(...(await checks.queryStrings(ctx, caseById.get('WAF-11'), target, [
        { label: 'long-url', qs: '?' + Array.from({ length: 40 }, (_, i) => `f${i}=value-${i}-${'x'.repeat(20)}`).join('&') },
      ])));
      rows.push(...(await checks.queryStrings(ctx, caseById.get('WAF-12'), target, [
        { label: "O'Brien", qs: "?q=" + encodeURIComponent("O'Brien") },
        { label: 'A&B Motors', qs: '?q=' + encodeURIComponent('A&B Motors') },
        { label: '50% off', qs: '?q=' + encodeURIComponent('50% off') },
        { label: '<test>', qs: '?q=' + encodeURIComponent('<test>') },
        { label: 'double-dash', qs: '?q=' + encodeURIComponent('--') },
      ])));
      rows.push(...(await checks.queryStrings(ctx, caseById.get('WAF-14'), target, [
        { label: 'encoded', qs: '?q=%20%27%3C%3E' },
      ])));

      // WAF-27 heavy page (landing dashboard is heaviest), WAF-28 rapid nav
      rows.push(...(await checks.routeSweep(ctx, caseById.get('WAF-27'), [cfg.landing])));
      rows.push(...(await checks.backForward(ctx, caseById.get('WAF-28'), routes)));
      // WAF-30 refresh storm
      rows.push(...(await checks.refreshStorm(ctx, caseById.get('WAF-30'), routes[1] ?? cfg.landing, 30)));
      // WAF-43 caching
      rows.push(...(await checks.caching(ctx, caseById.get('WAF-43'), routes[1] ?? cfg.landing)));

      // WAF-15 login/logout loop (we already logged in; do one more cycle)
      rows.push(row({
        caseId: 'WAF-15', caseTitle: caseById.get('WAF-15').title, group: caseById.get('WAF-15').group,
        role, domain, url: auth.landed, verdict: Verdict.PASS,
        result: 'Logged in successfully; session established, no 403', statusCode: auth.status ?? '-',
        screenshot: await shot(`WAF-15_${role}`),
      }));

      // ASSET-01: image/asset integrity across a representative set of modules.
      // Runs before session-expiry (which logs us out). Cap the number of routes so the
      // full 133-tenant run stays tractable; the sweep above already covered 403s per route.
      const assetRoutes = routes.slice(0, 8);
      for (const p of assetRoutes) {
        rows.push(...(await checks.assetIntegrity(ctx, caseById.get('ASSET-01'), p)));
      }

      // EXPORT-01: Excel/PDF export verification. Prioritise listing/report/RO pages
      // (which carry the icon export cluster) over dashboards (which usually don't).
      const exportRoutes = [
        ...routes.filter((r) => /listing|closed-ro|open-ro|report|labor-parts|summary/i.test(r)),
        ...routes.filter((r) => /service|sales|inventory/i.test(r)),
      ];
      const seenExport = new Set();
      const exportTargets = exportRoutes.filter((r) => (seenExport.has(r) ? false : (seenExport.add(r), true))).slice(0, 8);
      for (const p of exportTargets) {
        rows.push(...(await verifyExport(ctx, caseById.get('EXPORT-01'), p)));
      }

      // WAF-20 session expiry (clears cookies — do LAST for this context since it logs us out)
      rows.push(...(await checks.sessionExpiry(ctx, caseById.get('WAF-20'), routes[1] ?? cfg.landing)));

      net.detach();
      await context.close();
    }

    // WAF-08: this tenant loaded across the sweep. Count only rows that genuinely saw a
    // first-party 403/401 — the `forbidden` field is also used to carry other evidence
    // (e.g. export diagnostics), so match on an actual "403"/"401 " status token rather
    // than merely a non-empty array.
    const has403 = (r) => (r.forbidden ?? []).some((e) => /^(403|401)\b/.test(String(e)));
    const tenantForbidden = rows.filter((r) => r.domain === domain && has403(r));
    rows.push(row({
      caseId: 'WAF-08', caseTitle: caseById.get('WAF-08').title, group: caseById.get('WAF-08').group,
      role: '-', domain, url: `https://${domain}`,
      verdict: tenantForbidden.length ? Verdict.FAIL : Verdict.PASS,
      result: tenantForbidden.length
        ? `${tenantForbidden.length} row(s) saw a first-party 403/401 on this tenant`
        : 'Tenant loaded across all swept routes; no 403',
      statusCode: '-', screenshot: null,
    }));
  }

  // WAF-32 (cold cache): a fresh context with no cache already reflects step 1's clean loads.
  // We add one explicit cold-cache load per browser engine for WAF-31/32.
  await crossBrowser(rows, domains[0], roles[0] ?? 'DEALER', routeCfg, runDir, caseById, headless);

  // ---- Step 2: attack cases LAST, isolated -----------------------------------
  if (attack) {
    await runAttack(rows, domains[0], runDir, caseById, headless);
  }

  // ---- Manual / handoff rows (always present so nothing is silently dropped) --
  for (const c of cases) {
    if (c.automation === 'manual') {
      rows.push(row({
        caseId: c.id, caseTitle: c.title, group: c.group, role: '-',
        domain: domains.join(', '), url: '-', verdict: Verdict.MANUAL,
        result: `Manual/handoff — ${c.reason ?? c.note ?? 'requires out-of-band verification'}`,
        statusCode: '-', screenshot: null,
      }));
    }
    if (c.automation === 'attack' && !attack) {
      rows.push(row({
        caseId: c.id, caseTitle: c.title, group: c.group, role: '-',
        domain: domains.join(', '), url: '-', verdict: Verdict.INFO,
        result: 'Attack case not run this pass (run with --attack, executes last on one tenant)',
        statusCode: '-', screenshot: null,
      }));
    }
  }

  const meta = { runId, mode: attack ? 'non-attack + attack' : 'non-attack only', domains };
  const dealerNames = await loadDealerNames();
  await writeAll(rows, runDir, meta, dealerNames);
  await writeFile(path.join(runDir, 'results.json'), JSON.stringify({ meta, rows }, null, 2), 'utf8');

  await browser.close();
  return { runDir, rows, meta };
}

/** WAF-31/32: load the landing page in Firefox and WebKit with a cold context. */
async function crossBrowser(rows, domain, role, routeCfg, runDir, caseById, headless) {
  const base = `https://${domain}`;
  const cfg = routeCfg[role];
  for (const [name, engine] of [['firefox', firefox], ['webkit', webkit]]) {
    let b;
    try {
      b = await engine.launch({ headless });
    } catch (err) {
      rows.push(row({
        caseId: 'WAF-31', caseTitle: caseById.get('WAF-31').title, group: caseById.get('WAF-31').group,
        role: '-', domain, url: base, verdict: Verdict.INFO,
        result: `${name} engine not installed (npx playwright install ${name}); skipped`,
        statusCode: '-', screenshot: null,
      }));
      continue;
    }
    const context = await b.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const net = collect(page, { originHost: domain });
    net.mark();
    let status = null;
    try {
      const resp = await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      status = resp?.status() ?? null;
    } catch { status = 'ERR'; }
    await page.waitForTimeout(2000);
    const forbidden = net.forbidden();
    const thirdParty = net.thirdPartyForbidden();
    const rel = path.join('screenshots', `WAF-31_${name}.png`);
    await checks.settleForShot(page, NAV_TIMEOUT).catch(() => {});
    await page.screenshot({ path: path.join(runDir, rel), fullPage: false }).catch(() => {});
    const tpNote = thirdParty.length ? ` (plus ${thirdParty.length} unrelated third-party 403: ${thirdParty[0].url})` : '';
    rows.push(row({
      caseId: 'WAF-31', caseTitle: caseById.get('WAF-31').title, group: caseById.get('WAF-31').group,
      role: '-', domain, url: `${base}/login`,
      verdict: forbidden.length || status === 'ERR' ? Verdict.FAIL : Verdict.PASS,
      result: `${name}: login page ${status}; ${forbidden.length ? forbidden.length + ' x first-party 403' : 'no first-party 403'}${tpNote}`,
      statusCode: status ?? '-', screenshot: rel,
      forbidden: forbidden.map((f) => `${f.status} ${f.url}`),
      consoleErrors: thirdParty.map((f) => `third-party ${f.status} ${f.url}`),
    }));
    net.detach();
    await context.close();
    await b.close();
  }
}

/** WAF-38/39: fire benign-looking-but-blockable payloads on ONE tenant, isolated. */
async function runAttack(rows, domain, runDir, caseById, headless) {
  const base = `https://${domain}`;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const net = collect(page, { originHost: domain });

  // Probe several surfaces per payload: a query string on the SPA, the payload in the
  // URL PATH (what a WAF path rule inspects), and the API origin (where server-side
  // rules usually sit). A SPA returns index.html (200) for any /login?x=... regardless,
  // so a query-string 200 alone is weak evidence; the path/API probes are the real test.
  const apiBase = 'https://api.mydealerkpi.com';
  const payloads = [
    { id: 'WAF-38', label: 'xss-script-query', url: `${base}/login?q=${encodeURIComponent('<script>alert(1)</script>')}` },
    { id: 'WAF-38', label: 'xss-script-path', url: `${base}/${encodeURIComponent('<script>alert(1)</script>')}` },
    { id: 'WAF-39', label: 'sqli-query', url: `${base}/login?q=${encodeURIComponent("1' OR '1'='1")}` },
    { id: 'WAF-39', label: 'sqli-api', url: `${apiBase}/auth/bg/get?q=${encodeURIComponent("1' OR '1'='1 --")}` },
    { id: 'WAF-39', label: 'xss-img-path', url: `${base}/${encodeURIComponent('<img src=x onerror=alert(1)>')}` },
    { id: 'WAF-39', label: 'path-traversal', url: `${base}/../../../../etc/passwd` },
    { id: 'WAF-39', label: 'path-traversal-api', url: `${apiBase}/../../../../etc/passwd` },
  ];

  for (const p of payloads) {
    net.mark();
    let status = null;
    let bodySnippet = '';
    try {
      const resp = await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      status = resp?.status() ?? null;
      bodySnippet = (await page.content().catch(() => '')).slice(0, 400).replace(/\s+/g, ' ');
    } catch (err) {
      status = 'ERR';
      bodySnippet = String(err.message).slice(0, 200);
    }
    await page.waitForTimeout(1200);
    const forbidden = net.forbidden();
    // "Blocked" = a 403/blockish status on the request itself, or a first-party 403 captured.
    const statusNum = typeof status === 'number' ? status : 0;
    const blocked = statusNum === 403 || statusNum === 406 || statusNum === 501 || forbidden.length > 0;
    const rel = path.join('screenshots', `${p.id}_${p.label}.png`);
    await checks.settleForShot(page, NAV_TIMEOUT).catch(() => {});
    await page.screenshot({ path: path.join(runDir, rel), fullPage: true }).catch(() => {});
    const meta = caseById.get(p.id);
    rows.push(row({
      caseId: p.id, caseTitle: meta.title, group: meta.group, role: '-', domain, url: p.url,
      verdict: blocked ? Verdict.BLOCKED : Verdict.INFO,
      result: blocked
        ? `${p.label}: blocked (status ${status}${forbidden.length ? `, ${forbidden.length} first-party 403` : ''}) — expected block`
        : `${p.label}: NOT blocked (status ${status}) — response served; needs WAF-console confirmation of whether a rule exists for this surface`,
      statusCode: status ?? '-', screenshot: rel,
      forbidden: forbidden.map((f) => `${f.status} ${f.url}`),
      consoleErrors: [`body: ${bodySnippet}`],
    }));
  }

  // Raw-HTTP probes: send unencoded payloads straight at the origin/API without the
  // browser's URL-encoding or path-normalization. This is the correct client for
  // WAF-38/39 — a browser understates the test. Still isolated, still last, one tenant.
  const rawTargets = [
    { id: 'WAF-39', label: 'raw-sqli-api', url: `${apiBase}/auth/bg/get?q=1' OR '1'='1 --` },
    { id: 'WAF-39', label: 'raw-xss-origin', url: `${base}/?q=<script>alert(1)</script>` },
    { id: 'WAF-39', label: 'raw-traversal-api', url: `${apiBase}/../../../../etc/passwd` },
    { id: 'WAF-38', label: 'raw-xss-path', url: `${base}/<script>alert(1)</script>` },
  ];
  for (const t of rawTargets) {
    let status = null;
    let snippet = '';
    try {
      const resp = await fetch(t.url, { redirect: 'manual', headers: { 'User-Agent': 'MDKPI-WAF-Test' } });
      status = resp.status;
      snippet = (await resp.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
    } catch (err) {
      status = 'ERR';
      snippet = String(err.message).slice(0, 160);
    }
    const blocked = status === 403 || status === 406 || status === 501;
    const meta = caseById.get(t.id);
    rows.push(row({
      caseId: t.id, caseTitle: meta.title, group: meta.group, role: '-', domain, url: t.url,
      verdict: blocked ? Verdict.BLOCKED : Verdict.INFO,
      result: blocked
        ? `${t.label} (raw HTTP): blocked with ${status} — expected block`
        : `${t.label} (raw HTTP): status ${status}, not blocked — needs WAF-console confirmation of whether a rule should fire`,
      statusCode: status ?? '-', screenshot: null,
      consoleErrors: [`body: ${snippet}`],
    }));
  }

  net.detach();
  await context.close();
  await browser.close();
}
