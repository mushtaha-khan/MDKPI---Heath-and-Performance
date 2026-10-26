/**
 * API PERFORMANCE TESTING — standalone module (independent of Health Testing).
 *
 * This measures report LOAD TIME against the agreed benchmarks (MDKPI-7663 §2), keyed on
 * dealership scope (single vs multiple) × date filter (single month / multiple months /
 * YTD-PYTD-AllTime). DMS is always single-dealership; AutoGroup can select multiple dealers.
 *
 * It is deliberately kept separate from scripts/health/* — its own engine, events, results
 * (artifacts/perf/), and reports — so performance can be run on its own.
 *
 * NOTE: the exact measurement logic (what counts as "load time", how the date filter and
 * the AutoGroup dealership selection are driven, repetition count) is pending the scope
 * decisions. `measureScreen` below is a clearly-marked stub that currently records a single
 * navigate-to-networkidle timing and classifies it with a placeholder benchmark; it will be
 * completed once the criteria questions are answered. The scaffolding (login, discovery,
 * events, results, start/stop) is final.
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverSidebar, launchArgs } from '../health/crawler.mjs';
import { apiName, endpointPath, queryString, redactBody, dedupeApis } from '../health/apiutil.mjs';
import { effectiveConfig } from '../health/settings.mjs';

dotenv.config();

const API_HOST_RE = /(^|\.)mydealerkpi\.com$/i;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** DD/MM/YYYY HH:MM AM/PM (shared format with health, duplicated to stay independent). */
export function formatStamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(h)}:${p2(d.getMinutes())} ${ampm}`;
}

async function resolveCfg(roleOverride) {
  const eff = await effectiveConfig(); // Settings-tab overrides over .env
  return {
    base: eff.base,
    role: roleOverride || process.env.HEALTH_ROLE || 'DEALER',
    username: eff.username,
    password: eff.password,
    navTimeout: Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000),
    headless: process.env.KPI_HEADLESS === 'true',
    slowMo: Number(process.env.KPI_SLOWMO_MS ?? 120),
  };
}

const noop = () => {};

// Selectable filters and their benchmark "class" per MDKPI-7663 §2:
//   month  (Single Month / MTD)  -> "month"
//   multi-month (last 3 complete)-> "multi-month"
//   ytd / pytd / alltime         -> "long" (YTD/PYTD/All Time row: 5–10s)
const FILTER_CLASS = { month: 'month', 'multi-month': 'multi-month', ytd: 'long', pytd: 'long', alltime: 'long', none: 'none' };
const FILTER_LABEL = { month: 'Single Month (MTD)', 'multi-month': 'Multi-Month', ytd: 'YTD', pytd: 'PYTD', alltime: 'All Time', none: 'No date filter' };

/**
 * Benchmark table (MDKPI-7663 §2). Returns {min?,max,tolerance?} seconds for a scope + filter,
 * or null when the report has no date filter (no benchmark — informational only).
 * scope: 'single' | 'multiple'; filter: one of FILTER_CLASS keys.
 */
export function benchmarkFor(scope, filter) {
  const cls = FILTER_CLASS[filter] ?? 'multi-month';
  if (cls === 'none') return null; // no explicit benchmark per the ticket
  if (scope === 'single') {
    if (cls === 'month') return { max: 1, tolerance: 1.30 };        // 1 sec (tol 1.15–1.30)
    if (cls === 'multi-month') return { min: 3, max: 5 };            // 3–5 sec
    return { min: 5, max: 10 };                                      // YTD/PYTD/All Time 5–10 sec
  }
  // multiple dealerships
  if (cls === 'long') return { min: 5, max: 10 };                    // 5–10 sec
  return { min: 3, max: 5 };                                         // month or multi-month 3–5 sec
}

function benchLabel(bench) {
  if (!bench) return 'no benchmark';
  if (bench.min) return `${bench.min}-${bench.max}s`;
  return `≤${bench.tolerance ?? bench.max}s`;
}

/** All-Time fallback start when earliest data can't be detected (clearly labeled). */
const ALLTIME_FALLBACK = new Date(2015, 0, 1); // Jan 1, 2015

/**
 * Compute the concrete {start, end, label, viaPreset} date range for a filter, relative to
 * `now`. These match the agreed definitions exactly:
 *   month       : 1st of current month → today            (driven via RELATIVE "MTD")
 *   multi-month : last 3 COMPLETE months (excl. current)  (driven via CUSTOM range)
 *   ytd         : Jan 1 this year → today                 (driven via RELATIVE "YTD")
 *   pytd        : Jan 1 last year → same date last year    (driven via RELATIVE "PYTD")
 *   alltime     : earliest-detectable (else Jan 1 2015 fb) → today  (driven via CUSTOM)
 */
export function dateRangeFor(filter, now = new Date(), earliest = null) {
  const y = now.getFullYear();
  const mo = now.getMonth(); // 0-based
  const d = now.getDate();
  const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  switch (filter) {
    case 'month': {
      const start = new Date(y, mo, 1);
      return { start, end: now, preset: 'MTD', via: 'relative', label: `${iso(start)} → ${iso(now)}` };
    }
    case 'multi-month': {
      // Last 3 COMPLETE calendar months, excluding the current (incomplete) month.
      // For Oct 2026: Jul 1 → Sep 30.
      const endMonth = new Date(y, mo, 1);      // 1st of current month
      const lastComplete = new Date(endMonth.getTime() - 1); // last day of previous month
      const end = new Date(lastComplete.getFullYear(), lastComplete.getMonth() + 1, 0); // end of that month
      const start = new Date(end.getFullYear(), end.getMonth() - 2, 1); // first day, 3 months back
      return { start, end, via: 'custom', label: `${iso(start)} → ${iso(end)}` };
    }
    case 'ytd': {
      const start = new Date(y, 0, 1);
      return { start, end: now, preset: 'YTD', via: 'relative', label: `${iso(start)} → ${iso(now)}` };
    }
    case 'pytd': {
      const start = new Date(y - 1, 0, 1);
      const end = new Date(y - 1, mo, d); // same calendar date, prior year
      return { start, end, preset: 'PYTD', via: 'relative', label: `${iso(start)} → ${iso(end)}` };
    }
    case 'alltime': {
      const start = earliest instanceof Date ? earliest : ALLTIME_FALLBACK;
      const fallback = !(earliest instanceof Date);
      return { start, end: now, via: 'custom', label: `${iso(start)} → ${iso(now)}${fallback ? ' (fallback Jan 1 2015)' : ''}`, fallback };
    }
    default:
      return { start: new Date(y, mo, 1), end: now, via: 'custom', label: 'current month' };
  }
}

async function settle(page, navTimeout) {
  await page.waitForLoadState('networkidle', { timeout: navTimeout }).catch(() => {});
  await page
    .waitForFunction(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0; };
      const spin = [...document.querySelectorAll('[class*="spinner"],[class*="loading"],[class*="loader"],.p-progressspinner')];
      const txt = document.body ? document.body.innerText : '';
      return spin.every((el) => !vis(el)) && !/\bLOADING\s*\.\.\.|\bLOADING…/i.test(txt);
    }, { timeout: 15000, polling: 300 })
    .catch(() => {});
  await page.waitForTimeout(600);
}

async function login(page, cfg, emit) {
  emit({ type: 'log', msg: `Opening ${cfg.base}/login` });
  await page.goto(`${cfg.base}/login`, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
  await page.waitForLoadState('networkidle', { timeout: cfg.navTimeout }).catch(() => {});
  await page.waitForTimeout(1500);
  const combo = page.locator('p-select, .p-select, [role="combobox"]').first();
  const current = (await combo.innerText().catch(() => '')).trim();
  if (current.toUpperCase() !== cfg.role.toUpperCase()) {
    await combo.click().catch(() => {});
    await page.waitForTimeout(600);
    await page.locator('.p-select-option, [role="option"]').filter({ hasText: new RegExp(`^\\s*${cfg.role}\\s*$`, 'i') }).first().click().catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.locator('input[name="username"]').fill(cfg.username);
  await page.locator('input[name="password"]').fill(cfg.password);
  emit({ type: 'log', msg: `Submitting login as ${cfg.username} (${cfg.role})` });
  await page.locator('input[type="submit"]').click();
  await page.waitForURL((u) => !/\/login(\?|$|\/)/.test(u.toString()), { timeout: cfg.navTimeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: cfg.navTimeout }).catch(() => {});
  await page.waitForTimeout(2500);
  const landed = page.url();
  return { ok: !/\/login(\?|$|\/)/.test(landed), landed };
}

/** Pull a dealership name out of an API JSON body (company/dealer name fields only). */
function extractDealerName(obj, depth = 0) {
  if (obj == null || depth > 8) return '';
  if (Array.isArray(obj)) { for (const v of obj) { const n = extractDealerName(v, depth + 1); if (n) return n; } return ''; }
  if (typeof obj !== 'object') return '';
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase(); const v = obj[k];
    if ((lk === 'companyname' || lk === 'company_name' || lk === 'dealername' || lk === 'dealer_name') && typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const k of Object.keys(obj)) { const n = extractDealerName(obj[k], depth + 1); if (n) return n; }
  return '';
}

/** Is this URL the report's "main data" API (not a notification/favorites/support call)? */
function isMainDataApi(url) {
  try {
    if (!API_HOST_RE.test(new URL(url).hostname)) return false;
  } catch { return false; }
  // Report data endpoints across both products.
  if (!/\/(report|reports|dashboard|dealer-dashboard|rolebase|services|service|sales|inventory|payroll|auto-?group|f-and-i|financial)/i.test(url)) return false;
  // Exclude noise endpoints that fire on every screen but aren't the report's data.
  if (/notification-center|user-report-favorites|global-filter|makes\/active|top-nav|get-grouped-user-roles|to-do|current-working-days|user-name-with-role/i.test(url)) return false;
  return true;
}

/**
 * ONE timed measurement of a report under a given filter: triggers the load (navigate for
 * the first rep, or re-apply filter for subsequent), captures when the MAIN-DATA API request
 * starts, and times until the report is fully rendered (settle complete).
 *
 * loadMs = render-complete time − main-data-request-start time.
 */
async function timeOneLoad(page, cfg, m, filter, range, applyFn, collectApis = false) {
  // Arm a one-shot capture of the first main-data request start time.
  let mainStart = null;
  const captured = []; // full API list when collectApis is true (rep 1)
  // Wall-clock request-start per request, so response time is reliable (req.timing() is
  // not populated in the 'response' event).
  const reqStart = new WeakMap();
  const onReq = (req) => {
    try {
      const t = req.resourceType();
      if (t !== 'xhr' && t !== 'fetch') return;
      reqStart.set(req, Date.now());
      if (!mainStart && isMainDataApi(req.url())) mainStart = Date.now();
    } catch { /* ignore */ }
  };
  const onResp = (r) => {
    if (!collectApis) return;
    try {
      const req = r.request();
      const t = req.resourceType();
      if (t !== 'xhr' && t !== 'fetch') return;
      const url = r.url();
      if (!API_HOST_RE.test(new URL(url).hostname)) return;
      let ms = null;
      const s = reqStart.get(req); if (typeof s === 'number') ms = Math.max(0, Date.now() - s);
      const method = req.method();
      let payload = '';
      try { if (method !== 'GET' && method !== 'HEAD') payload = redactBody(req.postData()); } catch { payload = ''; }
      captured.push({ name: apiName(url), method, endpoint: endpointPath(url), query: queryString(url), payload, status: r.status(), ms, error: r.status() >= 400 ? `HTTP ${r.status()}` : '' });
    } catch { /* ignore */ }
  };
  page.on('request', onReq);
  if (collectApis) page.on('response', onResp);
  let navError = null;
  const tNav = Date.now();
  try {
    await applyFn(); // navigate and/or apply the filter — this triggers the main-data call
  } catch (e) {
    navError = String(e.message).split('\n')[0];
  }
  await settle(page, cfg.navTimeout);
  const tDone = Date.now();
  page.off('request', onReq);
  if (collectApis) page.off('response', onResp);
  const start = mainStart ?? tNav;
  return { loadMs: Math.max(0, tDone - start), fromNav: mainStart == null, navError, apis: collectApis ? dedupeApis(captured) : null };
}

/**
 * Measure one report under one filter + scope, running `reps` repetitions. Returns the
 * record with individual timings, average, benchmark, and OK/SLOW/INFO/ERROR verdict.
 */
async function measureConfig(page, cfg, m, filter, scopeKey, range, reps, emit) {
  const url = m.path ? `${cfg.base}${m.path}` : '';
  const scopeBench = scopeKey === 'all' ? 'multiple' : 'single';
  const bench = filter === 'none' ? null : benchmarkFor(scopeBench, filter);
  const timings = [];
  let navError = '';
  let fromNav = false;
  let allApis = [];
  let payloadRep = null; // which rep supplied the full API/payload detail

  for (let r = 0; r < reps; r++) {
    // Rep 1: navigate fresh, then apply filter. Later reps: re-apply filter to re-trigger.
    const applyFn = async () => {
      if (r === 0) {
        if (m.path) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
        else if (m.clickId) { const t = page.locator(`[data-health-id="${m.clickId}"]`).first(); if (await t.count()) await t.click({ timeout: 8000 }); }
        await settle(page, cfg.navTimeout);
        if (scopeKey === 'all') { const sd = await selectAllDealers(page, cfg); if (sd.note) emit({ type: 'log', msg: `dealers: ${sd.note}` }); }
      }
      if (filter !== 'none') {
        const res = await applyDateFilter(page, cfg, filter, range);
        if (res.note) emit({ type: 'log', msg: `${m.name} [${filter}]: ${res.note}` });
      } else {
        // No date filter: just reload to re-trigger the data call for timing.
        if (r > 0 && m.path) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
      }
    };
    const collect = r === 0; // full API list captured on the FIRST repetition
    const one = await timeOneLoad(page, cfg, m, filter, range, applyFn, collect);
    if (one.navError) navError = one.navError;
    if (one.fromNav) fromNav = true;
    if (collect && one.apis) { allApis = one.apis; payloadRep = r + 1; }
    timings.push(one.loadMs);
    emit({ type: 'perf-rep', name: m.name, filter, scope: scopeKey, rep: r + 1, of: reps, ms: one.loadMs });
  }

  const avgMs = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
  const avgSec = +(avgMs / 1000).toFixed(2);
  let verdict = 'INFO';
  if (bench) {
    const maxMs = (bench.tolerance ?? bench.max) * 1000;
    verdict = navError ? 'ERROR' : avgMs <= maxMs ? 'OK' : 'SLOW';
  } else if (navError) verdict = 'ERROR';

  // Per-API slow line for this config = the §2 max (tolerance or max) in ms. No benchmark
  // (filter 'none') → fall back to the single-dealer month value so we still flag outliers.
  const slowMs = bench ? (bench.tolerance ?? bench.max) * 1000 : 1300;
  const slowApis = (allApis || []).filter((a) => typeof a.ms === 'number' && a.ms > slowMs);

  return {
    group: m.group, subGroup: m.subGroup || '', name: m.name, path: m.path || '', url,
    filter, filterLabel: FILTER_LABEL[filter] || filter, scope: scopeKey, scopeBench,
    dateRange: range?.label || '', dateFallback: Boolean(range?.fallback),
    reps, timingsMs: timings, timingsSec: timings.map((t) => +(t / 1000).toFixed(2)),
    avgMs, avgSec, fromNav,
    benchmark: benchLabel(bench), verdict, navError: navError || '',
    allApis: allApis || [], slowApis, slowThresholdMs: slowMs, payloadRep,
  };
}

/**
 * Open the date picker, switch to a tab, and apply a filter.
 *   - RELATIVE presets (MTD/YTD/PYTD): click the .relative-option with that label.
 *   - CUSTOM ranges (Multi-Month, All-Time): open CUSTOM, navigate months, click start+end.
 * Returns { ok, applied, note }. Best-effort; a failure is reported, not thrown.
 */
async function applyDateFilter(page, cfg, filter, range) {
  const trigger = page.locator('button.date-months-trigger, .date-months-trigger').first();
  if (!(await trigger.count().catch(() => 0))) return { ok: false, note: 'no date-months-trigger on this report' };
  try {
    await trigger.click({ timeout: 6000 });
    await page.waitForTimeout(800);
  } catch { return { ok: false, note: 'could not open date picker' }; }

  const clickTab = async (label) => {
    const tab = page.locator('.p-tab', { hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }).first();
    if (await tab.count().catch(() => 0)) { await tab.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(500); return true; }
    return false;
  };

  if (range.via === 'relative' && range.preset) {
    const hasRel = await clickTab('RELATIVE');
    if (!hasRel) {
      // DMS might lack a RELATIVE tab — fall back to CUSTOM range for this filter.
      return applyCustomRange(page, cfg, range, `RELATIVE tab absent; used CUSTOM for ${range.preset}`);
    }
    const opt = page.locator('.relative-option', { hasText: new RegExp(`^\\s*${range.preset}\\s*$`, 'i') }).first();
    if (!(await opt.count().catch(() => 0))) {
      return applyCustomRange(page, cfg, range, `preset ${range.preset} not found; used CUSTOM`);
    }
    await opt.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
    return { ok: true, applied: range.preset, note: '' };
  }
  // CUSTOM range
  return applyCustomRange(page, cfg, range, '');
}

/**
 * Drive the CUSTOM day calendar to select range.start → range.end. The calendar shows two
 * months; navigate with the chevrons until the target month is visible, then click the day.
 */
async function applyCustomRange(page, cfg, range, note) {
  const hasCustom = await (async () => {
    const tab = page.locator('.p-tab', { hasText: /^\s*CUSTOM\s*$/i }).first();
    if (await tab.count().catch(() => 0)) { await tab.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(500); return true; }
    return false;
  })();
  if (!hasCustom) return { ok: false, note: (note ? note + '; ' : '') + 'no CUSTOM tab' };

  const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const clickDayInMonth = async (target) => {
    const wantMonth = MONTHS[target.getMonth()];
    const wantYear = String(target.getFullYear());
    const wantDay = String(target.getDate());
    // Navigate: the calendar header shows month+year; click the back/forward chevron until
    // the wanted month/year appears in one of the two visible panels. Cap the hops.
    for (let hop = 0; hop < 36; hop++) {
      const shown = await page.evaluate(() => {
        const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
        const heads = [...document.querySelectorAll('[class*="datepicker"] [class*="title"], [class*="datepicker"] [class*="header"], .p-datepicker-title')];
        return heads.map((h) => clean(h.innerText)).filter(Boolean);
      }).catch(() => []);
      if (shown.some((s) => s.includes(wantMonth) && s.includes(wantYear))) break;
      // Decide direction: if target is earlier than the first shown month, go back.
      const back = page.locator('.p-datepicker-prev, [class*="prev"], button[aria-label*="Previous" i]').first();
      const fwd = page.locator('.p-datepicker-next, [class*="next"], button[aria-label*="Next" i]').first();
      // Heuristic: compare target to "now"; past → back, future → forward.
      const goBack = target.getTime() < Date.now();
      const nav = goBack ? back : fwd;
      if (!(await nav.count().catch(() => 0))) break;
      await nav.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    // Click the day cell matching wantDay within a panel whose header is the wanted month.
    const clicked = await page.evaluate(({ wantMonth, wantYear, wantDay }) => {
      const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
      const panels = [...document.querySelectorAll('.p-datepicker-calendar, [class*="datepicker"] table, [class*="month-panel"], [class*="calendar"]')];
      for (const p of panels) {
        const head = clean(p.closest('[class*="datepicker"]')?.innerText || p.innerText);
        if (!(head.includes(wantMonth) && head.includes(wantYear))) continue;
        const cells = [...p.querySelectorAll('td, [class*="day"], [role="gridcell"]')];
        for (const c of cells) {
          if (clean(c.innerText) === wantDay && !/disabled|other-month|p-disabled/.test((c.className || '').toString()) && !/other-month|p-datepicker-other/.test((c.firstElementChild?.className || '').toString())) {
            (c.querySelector('span, a, button') || c).click();
            return true;
          }
        }
      }
      return false;
    }, { wantMonth, wantYear, wantDay }).catch(() => false);
    return clicked;
  };

  const s = await clickDayInMonth(range.start);
  await page.waitForTimeout(300);
  const e = await clickDayInMonth(range.end);
  await page.waitForTimeout(400);
  // Some pickers need an Apply; try clicking an apply/ok button if present.
  const apply = page.locator('button', { hasText: /^\s*(APPLY|OK|DONE)\s*$/i }).first();
  if (await apply.count().catch(() => 0)) await apply.click({ timeout: 2500 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  return { ok: s && e, applied: range.label, note: (note ? note + '; ' : '') + (s && e ? '' : 'custom day click incomplete') };
}

/**
 * AutoGroup only: select ALL dealerships via the dealership multiselect's header checkbox.
 * Returns { ok, selected, total, note }. Documents any access/selection limit.
 */
async function selectAllDealers(page, cfg) {
  // Tag the DEALERSHIP multiselect (not "ALL MAKES").
  const tagged = await page.evaluate(() => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
    const ms = [...document.querySelectorAll('p-multiselect')].find((m) => /DEALERSHIP/i.test(clean(m.innerText)));
    if (ms) { ms.setAttribute('data-dealer-ms', '1'); return true; }
    return false;
  }).catch(() => false);
  if (!tagged) return { ok: false, note: 'dealership multiselect not found' };
  const trig = page.locator('[data-dealer-ms="1"] .p-multiselect-dropdown, [data-dealer-ms="1"]').first();
  await trig.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(900);
  // Click the header select-all checkbox if not already all-selected.
  const headerCb = page.locator('.p-multiselect-header .p-checkbox, .p-multiselect-header [class*="checkbox"]').first();
  let note = '';
  if (await headerCb.count().catch(() => 0)) {
    const checked = await page.evaluate(() => {
      const h = document.querySelector('.p-multiselect-header .p-checkbox, .p-multiselect-header [class*="checkbox"]');
      return h ? (h.getAttribute('data-p-checked') === 'true' || h.classList.contains('p-highlight')) : false;
    }).catch(() => false);
    if (!checked) await headerCb.click({ timeout: 3000 }).catch(() => {});
  } else {
    note = 'no select-all checkbox; could not select all dealers';
  }
  await page.waitForTimeout(600);
  const counts = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.p-multiselect-item, li[role="option"]')];
    const selected = items.filter((i) => i.getAttribute('aria-selected') === 'true' || i.classList.contains('p-highlight')).length;
    return { total: items.length, selected };
  }).catch(() => ({ total: 0, selected: 0 }));
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  const ok = counts.selected > 1;
  if (ok && counts.selected < counts.total) note = `only ${counts.selected}/${counts.total} selectable (access limit)`;
  return { ok, selected: counts.selected, total: counts.total, note };
}

/** Does this report have a date-filter control on screen? Read-only DOM check. */
async function hasDateFilter(page) {
  return page.evaluate(() => {
    // The portal's date control renders as a PrimeNG datepicker / calendar, or a date-range
    // trigger whose text looks like "OCT (132) - 2026" / "YTD · JAN 1 … - OCT 22 …".
    const sel = 'p-datepicker, p-calendar, [class*="datepicker"], [class*="calendar"], [class*="date-range"], [class*="daterange"]';
    if (document.querySelector(sel)) return true;
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    for (const el of document.querySelectorAll('button, span, div, [class*="filter"]')) {
      if (!vis(el)) continue;
      const t = (el.innerText || '').trim();
      if (/\b(YTD|PYTD|MTD|ALL TIME)\b/i.test(t)) return true;
      if (/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b.*\b20\d{2}\b/i.test(t) && t.length < 60) return true;
    }
    return false;
  }).catch(() => false);
}

/**
 * DISCOVERY-ONLY (no performance measurement). Logs in, enumerates every report via the
 * shared sidebar discovery, visits each once to detect whether it has a date-filter control,
 * and returns the list + a filter-support flag per report. This makes NO filter changes and
 * runs NO timed measurements — it only produces the exact report inventory so the UI can
 * show accurate configuration counts before the user confirms a real run.
 *
 * @returns {Promise<{ok, role, dealerName, reports:[{group,subGroup,name,path,clickId,hasDateFilter}]}>}
 */
export async function discoverForPerf({ emit: rawEmit = noop, role = null, shouldStop = () => false } = {}) {
  const cfg = await resolveCfg(role);
  if (!cfg.username || !cfg.password) throw new Error('KPI_USERNAME / KPI_PASSWORD missing from .env');
  const emit = (e) => rawEmit({ role: cfg.role, ...e });

  emit({ type: 'perf-discover-start', role: cfg.role, base: cfg.base });
  const browser = await chromium.launch({ ...launchArgs(cfg.headless), slowMo: cfg.slowMo });
  const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  let dealerName = '';
  page.on('response', (r) => {
    try {
      if (dealerName) return;
      const t = r.request().resourceType();
      if ((t !== 'xhr' && t !== 'fetch') || r.status() !== 200) return;
      const url = r.url();
      if (!API_HOST_RE.test(new URL(url).hostname)) return;
      if (!/companyname|company_name|dealername|autodealer|dealer-dashboard|dashboard\/get/i.test(url)) return;
      r.json().then((b) => { if (!dealerName) { const n = extractDealerName(b); if (n) { dealerName = n; emit({ type: 'perf-dealer', name: n }); } } }).catch(() => {});
    } catch { /* ignore */ }
  });

  const auth = await login(page, cfg, emit);
  emit({ type: 'perf-login', ok: auth.ok, landed: auth.landed });
  if (!auth.ok) { await browser.close(); emit({ type: 'perf-discover-done', ok: false, reason: 'login-failed', reports: [] }); return { ok: false, role: cfg.role, reports: [] }; }

  let discovered = [];
  try { discovered = await discoverSidebar(page, cfg, emit); } catch (e) { emit({ type: 'log', msg: `discovery failed: ${String(e.message).split('\n')[0]}` }); }

  const reports = [];
  for (let i = 0; i < discovered.length; i++) {
    if (shouldStop()) break;
    const m = discovered[i];
    emit({ type: 'perf-discover-progress', index: i, total: discovered.length, name: m.name });
    let supports = false;
    if (m.path) {
      try {
        await page.goto(`${cfg.base}${m.path}`, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
        await settle(page, cfg.navTimeout);
        supports = await hasDateFilter(page);
      } catch { supports = false; }
    } else if (m.clickId) {
      // Click-only leaf: open via its tagged anchor if still present.
      try { const t = page.locator(`[data-health-id="${m.clickId}"]`).first(); if (await t.count()) { await t.click({ timeout: 6000 }); await settle(page, cfg.navTimeout); supports = await hasDateFilter(page); } } catch { supports = false; }
    }
    reports.push({ group: m.group, subGroup: m.subGroup || '', name: m.name, path: m.path || '', clickId: m.clickId || null, hasDateFilter: supports });
  }

  await browser.close();
  const withFilter = reports.filter((r) => r.hasDateFilter).length;
  emit({ type: 'perf-discover-done', ok: true, role: cfg.role, dealerName, total: reports.length, withFilter, reports });
  return { ok: true, role: cfg.role, dealerName, reports };
}

/**
 * Run performance testing. Mirrors the health crawl's lifecycle (run-start → per-screen →
 * done) but with perf-specific event names and results, so the UI/report stay independent.
 */
export async function runPerf({ emit: rawEmit = noop, role = null, modules = null, shouldStop = () => false, filters = ['month'], scopes = ['single'], reps = 3 } = {}) {
  const cfg = await resolveCfg(role);
  if (!cfg.username || !cfg.password) throw new Error('KPI_USERNAME / KPI_PASSWORD missing from .env');
  const emit = (e) => rawEmit({ role: cfg.role, ...e });
  reps = reps === 1 ? 1 : 3;
  // DEALER is always single-dealer regardless of requested scopes.
  const roleScopes = cfg.role.toUpperCase() === 'DEALER' ? ['single'] : (scopes.length ? scopes : ['single']);

  const startedDate = new Date();
  const startedAt = formatStamp(startedDate);
  const runId = `${startedDate.toISOString().replace(/[:.]/g, '-')}-${cfg.role.toLowerCase()}`;
  const runDir = path.join('artifacts', 'perf', runId);
  await mkdir(runDir, { recursive: true });

  emit({ type: 'perf-run-start', base: cfg.base, role: cfg.role, user: cfg.username, runId, startedAt });

  const browser = await chromium.launch({ ...launchArgs(cfg.headless), slowMo: cfg.slowMo });
  const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  let dealerName = '';
  page.on('response', (r) => {
    try {
      const t = r.request().resourceType();
      if (t !== 'xhr' && t !== 'fetch') return;
      const url = r.url();
      if (!dealerName && r.status() === 200 && API_HOST_RE.test(new URL(url).hostname) && /companyname|company_name|dealername|autodealer|dealer-dashboard|dashboard\/get/i.test(url)) {
        r.json().then((b) => { if (!dealerName) { const n = extractDealerName(b); if (n) { dealerName = n; emit({ type: 'perf-dealer', name: n }); } } }).catch(() => {});
      }
    } catch { /* ignore */ }
  });

  const results = [];
  const auth = await login(page, cfg, emit);
  emit({ type: 'perf-login', ok: auth.ok, landed: auth.landed });
  if (!auth.ok) {
    await browser.close();
    const summary = { ok: false, reason: 'login-failed' };
    emit({ type: 'perf-done', summary, results });
    return { ok: false, results, runDir, summary };
  }

  // Reports to measure: use the provided list (from discovery, with hasDateFilter), else
  // discover live now.
  if (!modules) {
    try { modules = await discoverSidebar(page, cfg, emit); } catch { modules = []; }
    // Without discovery metadata we can't know date-filter support; assume supported.
    modules = modules.map((m) => ({ ...m, hasDateFilter: m.hasDateFilter !== false }));
  }

  // Build the measurement matrix:
  //   per report: if it has a date filter -> one config per selected filter; else one 'none' config.
  //   per config: one entry per role scope (single / all).
  const now = new Date();
  const configs = [];
  for (const m of modules) {
    if (m.path && /\/(add|edit|create|new|delete|import(?!-history)|upload)(\/|$|\?)/i.test(m.path)) continue; // skip CRUD
    const reportFilters = m.hasDateFilter ? filters : ['none'];
    for (const f of reportFilters) {
      for (const scopeKey of roleScopes) {
        configs.push({ m, filter: f, scopeKey });
      }
    }
  }
  emit({ type: 'perf-modules', total: configs.length, reportCount: modules.length, reps, filters, scopes: roleScopes });

  let stopped = false;
  for (let idx = 0; idx < configs.length; idx++) {
    if (shouldStop()) { stopped = true; emit({ type: 'log', msg: 'Stop requested — ending performance run' }); break; }
    const { m, filter, scopeKey } = configs[idx];
    const range = filter === 'none' ? null : dateRangeFor(filter, now);
    emit({ type: 'perf-screen-start', index: idx, total: configs.length, group: m.group, subGroup: m.subGroup || '', name: m.name, filter, scope: scopeKey });
    const rec = await measureConfig(page, cfg, m, filter, scopeKey, range, reps, emit);
    results.push(rec);
    emit({ type: 'perf-screen-done', index: idx, ...rec });
  }

  await browser.close();
  const summary = {
    ok: true, stopped, total: results.length,
    ok_count: results.filter((r) => r.verdict === 'OK').length,
    slow: results.filter((r) => r.verdict === 'SLOW').length,
    info: results.filter((r) => r.verdict === 'INFO').length,
    error: results.filter((r) => r.verdict === 'ERROR').length,
  };
  await writeFile(path.join(runDir, 'results.json'), JSON.stringify({ kind: 'performance', cfg: { base: cfg.base, role: cfg.role, user: cfg.username, dealerName, filters, scopes: roleScopes, reps }, startedAt, finishedAt: formatStamp(new Date()), summary, results }, null, 2), 'utf8');
  emit({ type: 'perf-done', summary, results, runDir });
  return { ok: true, results, runDir, summary };
}
