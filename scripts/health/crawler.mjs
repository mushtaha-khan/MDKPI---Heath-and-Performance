/**
 * Read-only dealership health crawler.
 *
 * Logs into the tenant /v2 app as the ghost user, discovers every module/screen the
 * role can reach, navigates each one, exercises its tabs, and opens non-destructive
 * modals — all while recording every API call's HTTP status and every console error.
 *
 * STRICTLY READ-ONLY. It navigates, clicks tabs, and opens (then closes) view-only
 * dialogs. It NEVER submits a form, saves, deletes, or hits a create/edit route.
 *
 * The crawler is event-driven: pass an `emit(event)` callback and it streams progress
 * (run-start, screen-start, api, screen-done, modal, tab, done) so a live dashboard can
 * render it in real time. It also returns the full result set at the end.
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { notifyFailure, notifyRunSummary, notifyEnabled } from './notify.mjs';
import { appendApiLog } from './apilog.mjs';
import { apiName, endpointPath, queryString, redactBody, dedupeApis } from './apiutil.mjs';
import { effectiveConfig } from './settings.mjs';

dotenv.config();

const API_HOST_RE = /(^|\.)mydealerkpi\.com$/i;

/**
 * Routes we must never navigate: create/edit/delete surfaces (CRUD). Read-only only.
 *
 * Note `import-history` is explicitly NOT blocked — it is a read-only listing of past
 * imports, not an import action. Only the write verbs (add/edit/create/delete/upload/
 * the bare /import action) are refused. The negative lookahead keeps "import-history".
 */
const BLOCKED_RE = /\/(add|edit|create|new|delete|remove|save|upload|import(?!-history))(\/|$|\?)/i;

/**
 * The modules to verify, grouped the way the menu presents them. Discovered live from
 * the ghost user's nav tree (artifacts/health/recon-*.json). Each is a view-only report
 * or listing screen. Detail drill-downs (one representative inventory "view") are included
 * so the per-record screen is exercised; /sales/add/* create forms are deliberately absent.
 */
export const MODULES = [
  { group: 'Dashboards', name: 'Sales Dashboard', path: '/v2/dealership/sales-dashboard' },
  { group: 'Dashboards', name: 'Vehicle Inventory Dashboard', path: '/v2/dealership/vehicle-inventory-dashboard' },
  { group: 'Dashboards', name: 'Parts Dashboard', path: '/v2/dealership/parts-dashboard' },
  { group: 'Dashboards', name: 'Auction Dashboard', path: '/v2/dealership/reports/auction-report' },
  { group: 'Dashboards', name: 'Financial Statement', path: '/v2/dealership/app-dashboard/financial-statement' },

  { group: 'Inventory', name: 'Vehicle Inventory', path: '/v2/dealership/vehicle-inventory' },
  { group: 'Inventory', name: 'Vehicle Valuation', path: '/v2/dealership/vehicle-valuation' },
  { group: 'Inventory', name: 'Used Vehicle Recon Turnrate', path: '/v2/dealership/reports/used-recon-turnaround' },
  { group: 'Inventory', name: 'Sales Performance Intelligence', path: '/v2/dealership/reports/vehicle-sales-recon-metrics' },

  { group: 'Sales', name: 'Customer Listing', path: '/v2/dealership/reports/customer-listing' },
  { group: 'Sales', name: 'F&I Report', path: '/v2/report/f-and-i-report/basic' },
  { group: 'Sales', name: 'Commissions', path: '/v2/payroll/sales-commissionable-comp' },
  { group: 'Sales', name: 'Leads (CRM)', path: '/v2/dealership/report/crm' },
  { group: 'Sales', name: 'Unwind Deals', path: '/v2/sales/unwind-deals' },

  { group: 'Service', name: 'Service Dashboard', path: '/v2/report/services/dashboard' },
  { group: 'Service', name: 'Closed ROs', path: '/v2/dealership/service-report/services/listing' },
  { group: 'Service', name: 'Open ROs', path: '/v2/dealership/service-report/open-ro/listing' },
  { group: 'Service', name: 'Service Appointment', path: '/v2/report/service-appointment/appointment' },
  { group: 'Service', name: 'Appointment Recalls', path: '/v2/report/appointment-recalls' },
];

// Resolve the run config, with Settings-tab overrides (base/username/password) taking
// precedence over .env. Async because it consults the saved settings store.
async function resolveCfg(roleOverride) {
  const eff = await effectiveConfig(); // { base, username, password } — settings over env
  return {
    base: eff.base,
    role: roleOverride || process.env.HEALTH_ROLE || 'DEALER',
    username: eff.username,
    password: eff.password,
    navTimeout: Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000),
    headless: process.env.KPI_HEADLESS === 'true', // default HEADED so the user can watch
    slowMo: Number(process.env.KPI_SLOWMO_MS ?? 120),
  };
}

const noop = () => {};

/**
 * Chromium launch args. On Linux/containers (Docker on an Ubuntu server) the Chromium
 * sandbox usually cannot initialise without elevated capabilities, so disable it there —
 * it's the standard, safe approach for headless CI/server use. Local desktop runs (Windows/
 * macOS) keep the sandbox and just maximise the window. Force headless when asked.
 * Exported so the perf crawler reuses the exact same flags.
 */
export function launchArgs(headless) {
  const onLinux = process.platform === 'linux';
  // On a headless Linux server (no X display) a visible browser can't open and would hang,
  // so force headless there regardless of the KPI_HEADLESS setting.
  const noDisplay = onLinux && !process.env.DISPLAY;
  const effHeadless = headless || noDisplay;
  const args = onLinux
    ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    : ['--start-maximized'];
  return { headless: effHeadless, args };
}

/** Format a Date as DD/MM/YYYY HH:MM AM/PM (12-hour, no seconds). */
export function formatStamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const dd = p2(d.getDate());
  const mm = p2(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${dd}/${mm}/${yyyy} ${p2(h)}:${p2(d.getMinutes())} ${ampm}`;
}

/** Resolve a promise, or resolve with `fallback` if it hasn't settled within `ms`. */
function withDeadline(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** Settle: wait out network + the portal's LOADING… splash so a screen is really ready. */
async function settle(page, navTimeout) {
  await page.waitForLoadState('networkidle', { timeout: navTimeout }).catch(() => {});
  await page
    .waitForFunction(
      () => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
        };
        const spin = [...document.querySelectorAll('[class*="spinner"],[class*="loading"],[class*="loader"],.p-progressspinner')];
        const spinnersGone = spin.every((el) => !vis(el));
        const txt = document.body ? document.body.innerText : '';
        const loadingGone = !/\bLOADING\s*\.\.\.|\bLOADING…/i.test(txt);
        return spinnersGone && loadingGone;
      },
      { timeout: 15000, polling: 300 },
    )
    .catch(() => {});
  await page.waitForTimeout(1200);
}

/** Log in with username/password + PrimeNG role select, waiting for the slow auth round-trip. */
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
    await page
      .locator('.p-select-option, [role="option"]')
      .filter({ hasText: new RegExp(`^\\s*${cfg.role}\\s*$`, 'i') })
      .first()
      .click()
      .catch(() => {});
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

/**
 * Resolve the dealership's full display name (e.g. "Gary Yeomans Honda") from the app's
 * own API, so the reports show the real dealer, not just the tenant subdomain. The
 * autogroup "assigned" endpoint returns it as companyName for the logged-in session.
 * Best-effort: returns '' if it can't be determined.
 */
/**
 * Pull a dealership name out of an API JSON body. The app exposes it under a few shapes
 * across products: autogroup `[].companyName`, DEALER `data.MtdSales.autoDealer.companyName`,
 * and `*.company_name`. Returns '' if none present. Deliberately avoids per-row customer/
 * person names — only fields literally named company/companyName/dealerName.
 */
function extractDealerName(obj, depth = 0) {
  if (obj == null || depth > 8) return '';
  if (Array.isArray(obj)) {
    for (const v of obj) { const n = extractDealerName(v, depth + 1); if (n) return n; }
    return '';
  }
  if (typeof obj !== 'object') return '';
  for (const key of Object.keys(obj)) {
    const lk = key.toLowerCase();
    const val = obj[key];
    if ((lk === 'companyname' || lk === 'company_name' || lk === 'dealername' || lk === 'dealer_name') && typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  for (const key of Object.keys(obj)) {
    const n = extractDealerName(obj[key], depth + 1);
    if (n) return n;
  }
  return '';
}

/**
 * Discover the sidebar menu live: expand every parent so its children render, then read
 * the whole tree. Returns a flat, de-duplicated list of visitable modules, each tagged
 * with the parent group it sits under, so every menu item AND every child item is covered
 * rather than a hand-picked subset.
 *
 * Read-only: expanding a menu parent only toggles a submenu; it submits nothing.
 */
export async function discoverSidebar(page, cfg, emit) {
  // 0. Reveal the admin / settings / profile menu, which lives behind a gear or avatar
  //    trigger rather than in the main report sidebar. Clicking it only opens a menu
  //    overlay — read-only. We open each candidate, let its items render, and leave it
  //    open so the tree read below captures them.
  const revealSel = [
    '[class*="setting"] [class*="icon"]', '[class*="gear"]', 'button[aria-label*="setting" i]',
    'button[aria-label*="menu" i]', '[class*="avatar"]', '[class*="profile"] button',
    '.pi-cog', '.pi-bars', '.pi-ellipsis-v', '[class*="user-menu"]', '[class*="topbar"] button',
  ].join(', ');
  const revealers = page.locator(revealSel);
  const revN = await revealers.count().catch(() => 0);
  for (let i = 0; i < Math.min(revN, 8); i++) {
    const r = revealers.nth(i);
    if (!(await r.isVisible().catch(() => false))) continue;
    await r.click({ timeout: 1200 }).catch(() => {});
    await page.waitForTimeout(250);
  }

  // DMS (/v2) left sidebar: a 3-level nested tree that is fully present in the DOM
  //   ul.collapsed-sidebar-nav > li (top)                e.g. Sales
  //     ul.sidebar-revamp-sub-menu > li.level-2 (group)  e.g. Sales Department
  //       ul.sub-child-menu > li (leaf)                  e.g. Sales Desk Log, Sales Trend
  // Many leaves have NO href — they navigate via an Angular click handler — so they must
  // be crawled by CLICKING the menu item, not by URL. We tag every leaf with a stable
  // data attribute so the crawl can locate and click it. Read-only: tagging only adds an
  // attribute; clicking a report menu item just navigates.
  const sidebarHarvest = await page.evaluate(() => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
    const ul = document.querySelector('ul.collapsed-sidebar-nav');
    if (!ul) return { items: [], debug: 'no ul.collapsed-sidebar-nav' };
    const out = [];
    let seq = 0;
    // Keep group (top heading) and subGroup (level-2 heading) SEPARATE so the tool can
    // render the real two-level hierarchy, not a flattened "A › B" string.
    const tag = (a, group, subGroup, name) => {
      const id = `m${seq++}`;
      a.setAttribute('data-health-id', id);
      out.push({ id, group, subGroup: subGroup || '', name: name || clean(a.textContent), href: a.getAttribute('href') || '' });
    };
    // Direct children of the top <ul> are the top-level items (Dashboard, Sales, …).
    const tops = [...ul.children].filter((c) => c.tagName === 'LI');
    for (const top of tops) {
      // The top item's own label is its first anchor's text.
      const topAnchor = top.querySelector(':scope > a');
      const topName = clean(topAnchor?.textContent) || 'Menu';
      const subMenu = top.querySelector(':scope > ul.sidebar-revamp-sub-menu');
      if (!subMenu) {
        if (topAnchor && topAnchor.getAttribute('href')) tag(topAnchor, topName, '', topName);
        continue;
      }
      // Level-2 items under the sub-menu.
      for (const lvl2 of [...subMenu.children].filter((c) => c.tagName === 'LI')) {
        const subChild = lvl2.querySelector(':scope > ul.sub-child-menu');
        const lvl2Anchor = lvl2.querySelector(':scope > div a, :scope > a');
        const lvl2Name = clean(lvl2Anchor?.textContent) || topName;
        if (subChild) {
          // A level-2 GROUP with leaves in sub-child-menu (e.g. Sales Department → Sales
          // Desk Log …). group = top heading, subGroup = this level-2 heading.
          for (const leaf of [...subChild.children].filter((c) => c.tagName === 'LI')) {
            const a = leaf.querySelector('a');
            if (a) tag(a, topName, lvl2Name, clean(a.textContent));
          }
        } else if (lvl2Anchor) {
          // Level-2 is itself a leaf (e.g. Vehicle Inventory Dashboard under Inventory):
          // it sits directly under the top heading, no sub-heading.
          tag(lvl2Anchor, topName, '', lvl2Name);
        }
      }
    }
    return { items: out, debug: `tops=${tops.length} leaves=${out.length}` };
  }).then((r) => { try { console.error('[sidebar] ' + (r.debug || '')); } catch {} ; return r.items || []; }).catch(() => []);
  emit({ type: 'log', msg: `DMS sidebar tree leaves: ${sidebarHarvest.length}` });

  // 0b. Top navigation bar (AutoGroup): nav.ag-nav > ul.ag-nav-list > li, where each li is
  //    a parent (DASHBOARD / INVENTORY / SALES / F&I / SERVICE / PARTS / ACCOUNTING /
  //    SCHEDULES / COMPARISON / FORECAST) whose children render in a dropdown on hover.
  //    Hover each parent (and its nested items), then read every anchor inside that li —
  //    children live inside the same li subtree even when visually in a flyout. The li's
  //    own heading text becomes the group so items sit under the right menu.
  const topNavHarvest = [];
  const agTops = page.locator('nav.ag-nav > ul.ag-nav-list > li');
  const agN = await agTops.count().catch(() => 0);
  for (let i = 0; i < agN; i++) {
    const li = agTops.nth(i);
    if (!(await li.isVisible().catch(() => false))) continue;
    await li.hover({ timeout: 1200 }).catch(() => {});
    await page.waitForTimeout(450);
    // Hover nested sub-items so deeper submenus (e.g. Performance Report → …) open.
    const nested = li.locator('li');
    const nn = await nested.count().catch(() => 0);
    for (let j = 0; j < Math.min(nn, 20); j++) {
      await nested.nth(j).hover({ timeout: 500 }).catch(() => {});
      await page.waitForTimeout(100);
    }
    const links = await page.evaluate((idx) => {
      const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
      const li = document.querySelectorAll('nav.ag-nav > ul.ag-nav-list > li')[idx];
      if (!li) return [];
      // Group = the parent tab label only (DASHBOARD / INVENTORY / SALES / …). Take the
      // li's FIRST direct text node / first anchor-span, not its whole innerText (which
      // also contains the dropdown items and an unrelated "NAVIGATE TO DEALERSHIP" button).
      let group = '';
      const firstLink = li.querySelector(':scope > a, :scope > span, :scope > button');
      if (firstLink) group = clean(firstLink.textContent).split('\n')[0];
      if (!group) {
        for (const n of li.childNodes) { if (n.nodeType === 3 && clean(n.nodeValue)) { group = clean(n.nodeValue); break; } }
      }
      group = group.slice(0, 24) || 'Menu';
      const out = [];
      for (const a of li.querySelectorAll('a[routerlink], a[href], a[ng-reflect-router-link]')) {
        const raw = a.getAttribute('routerlink') || a.getAttribute('ng-reflect-router-link') || a.getAttribute('href') || '';
        out.push({ raw, text: clean(a.innerText || a.textContent), group });
      }
      return out;
    }, i).catch(() => []);
    for (const l of links) topNavHarvest.push(l);
  }
  // Close any open dropdown so it doesn't cover the page for later steps.
  await page.keyboard.press('Escape').catch(() => {});

  // 1. Expand every collapsible parent, several passes (children can themselves be parents).
  const expanderSel = [
    '.p-panelmenu-header-link',
    '.p-panelmenu-header-content',
    '.p-panelmenu-header',
    'a[aria-expanded="false"]',
    'li[aria-expanded="false"] > a',
    '.menu-item.has-children > a',
    '[class*="submenu"][aria-expanded="false"]',
  ].join(', ');
  for (let pass = 0; pass < 4; pass++) {
    const exp = page.locator(expanderSel);
    const n = await exp.count().catch(() => 0);
    let clicked = 0;
    for (let i = 0; i < n; i++) {
      const el = exp.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 1200 }).catch(() => {});
      clicked++;
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(350);
    if (!clicked) break;
  }
  emit({ type: 'log', msg: 'Sidebar expanded; reading menu tree' });

  // 2. Read the tree. Prefer a real sidebar/nav container so we don't pick up content links.
  let items = await page.evaluate(() => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
    const navRoot =
      document.querySelector('p-panelmenu') ||
      document.querySelector('[class*="sidebar"]') ||
      document.querySelector('aside') ||
      document.querySelector('nav') ||
      document.body;

    const toPath = (raw) => {
      if (!raw) return '';
      let link = raw.trim();
      // routerLink arrays: "['/v2','dealership','x']" -> "/v2/dealership/x"
      if (link.includes('[') || link.includes("'")) {
        link = link.replace(/[[\]']/g, '').split(',').map((s) => s.trim()).filter(Boolean).join('/');
        if (link && !link.startsWith('/')) link = '/' + link;
      }
      try {
        // Absolute URL on this origin -> pathname; keep same-origin only.
        if (/^https?:\/\//i.test(link)) {
          const u = new URL(link);
          if (u.hostname !== location.hostname) return '';
          link = u.pathname + u.search;
        }
      } catch { /* leave as-is */ }
      return link;
    };

    /** Nearest ancestor submenu's header text = the group this item belongs to. */
    const groupOf = (el) => {
      let node = el.parentElement;
      for (let hop = 0; hop < 8 && node; hop++, node = node.parentElement) {
        const header = node.querySelector(
          ':scope > .p-panelmenu-header, :scope > a.p-panelmenu-header-link, :scope > [class*="header"]',
        );
        if (header) {
          const t = clean(header.innerText);
          if (t) return t.slice(0, 40);
        }
      }
      return 'Menu';
    };

    const out = [];
    const seen = new Set();
    // Scan the main nav plus any open menu overlays/popups (the admin & profile menus
    // render in a PrimeNG overlay/tieredmenu at body level, outside the sidebar).
    const overlayRoots = [
      ...document.querySelectorAll(
        '.p-menu, .p-tieredmenu, .p-menubar, .p-slidemenu, [role="menu"], [class*="dropdown-menu"], [class*="overlay"]',
      ),
    ];
    const roots = [navRoot, ...overlayRoots];
    const anchors = [];
    const anchorSet = new Set();
    for (const root of roots) {
      for (const a of root.querySelectorAll('a[href], [routerlink], [ng-reflect-router-link], [role="menuitem"]')) {
        if (anchorSet.has(a)) continue;
        anchorSet.add(a);
        anchors.push(a);
      }
    }
    for (const el of anchors) {
      const raw = el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link') || el.getAttribute('href') || '';
      const path = toPath(raw);
      if (!path || path === '/' || path.startsWith('#') || path.startsWith('javascript')) continue;
      const name = clean(el.innerText || el.textContent) || path;
      if (seen.has(path)) continue;
      seen.add(path);
      // Group: prefer the submenu header; else derive from the path so admin/import
      // items read sensibly instead of all landing under a generic "Menu".
      let group = groupOf(el);
      if (group === 'Menu') {
        if (/import-history/.test(path)) group = 'Import History';
        else if (/\/app\/settings|\/department|\/manage_users|commission-config/.test(path)) group = 'Settings';
        else if (/\/v2\//.test(path)) group = 'Reports';
      }
      out.push({ group, subGroup: '', name: name.slice(0, 60), path });
    }
    return out;
  });

  // 2b. Fold in the top-nav dropdown links harvested earlier (AutoGroup menubar). Normalise
  //     their raw hrefs the same way toPath did in-page, and name the group from the path.
  const host = new URL(cfg.base).hostname;
  const normalize = (raw) => {
    if (!raw) return '';
    let link = String(raw).trim();
    if (link.includes('[') || link.includes("'")) {
      link = link.replace(/[[\]']/g, '').split(',').map((s) => s.trim()).filter(Boolean).join('/');
      if (link && !link.startsWith('/')) link = '/' + link;
    }
    try {
      if (/^https?:\/\//i.test(link)) {
        const uu = new URL(link);
        if (uu.hostname !== host) return '';
        link = uu.pathname + uu.search;
      }
    } catch { /* keep */ }
    return link;
  };
  const agGroup = (p) => {
    const seg = (p.split('/')[2] || p.split('/')[1] || 'menu').replace(/-/g, ' ');
    return seg.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
  };
  // Assemble in priority + app order:
  //   1. DMS sidebar tree (authoritative hierarchy: group + subGroup, correct order)
  //   2. AutoGroup top-nav dropdowns
  //   3. Leftover anchor-scan items (settings/import-history overlays, anything not already
  //      covered). Because the later `cleaned` dedup keeps the FIRST occurrence per path,
  //      putting the sidebar tree first means its correct hierarchy wins over the flat
  //      anchor-scan duplicates — which is what removed the doubled "Dashboard"/"Inventory"
  //      headings.
  const anchorScan = items;        // step-2 result
  const assembled = [];

  for (const l of sidebarHarvest) {
    const p = l.href ? normalize(l.href) : '';
    if (p && (p === '/' || p.startsWith('#') || p.startsWith('javascript'))) continue;
    if (!p && !l.id) continue;
    assembled.push({ group: l.group || 'Menu', subGroup: l.subGroup || '', name: (l.name || p).slice(0, 60), path: p || '', clickId: l.id || null });
  }
  for (const l of topNavHarvest) {
    const p = normalize(l.raw);
    if (!p || p === '/' || p.startsWith('#') || p.startsWith('javascript')) continue;
    assembled.push({ group: l.group || agGroup(p), subGroup: '', name: (l.text || p).slice(0, 60), path: p });
  }
  for (const it of anchorScan) assembled.push(it);
  items = assembled;

  // 3. Filter: drop per-record drill-downs and anything matching a write/CRUD route.
  //    Per-record links (a specific stock number / RO id) are not "modules"; we keep one
  //    representative later if desired, but the menu sweep is about modules + children.
  const RECORD_RE = /\/(view|detail|edit|add)\/[^/]+$|\/\d{3,}(\/|$)/i; // trailing id segment
  const cleaned = [];
  const kept = new Set();
  for (const it of items) {
    if (it.path && BLOCKED_RE.test(it.path)) continue; // add/edit/create/import/... = CRUD
    if (it.path && RECORD_RE.test(it.path)) continue; // specific-record drill-down
    // Dedup key: the path when present, else the clickId (unique per tagged leaf), else
    // group+name. Keying click-only leaves on "" collapsed them all into one — the bug
    // that dropped Sales Desk Log, Sales Trend, and every other href-less sub-child.
    const key = it.path || it.clickId || `${it.group}|${it.subGroup}|${it.name}`;
    if (kept.has(key)) continue;
    kept.add(key);
    cleaned.push({ group: it.group, subGroup: it.subGroup || '', name: it.name, path: it.path, clickId: it.clickId || null });
  }

  emit({ type: 'log', msg: `Discovered ${cleaned.length} menu item(s) across sidebar + children` });
  return cleaned;
}

/**
 * Open each non-destructive dialog that this screen offers, confirm it renders, then
 * close it. Only triggers that read like "view / details / info / filter" are touched;
 * anything that reads like add/edit/delete/save is skipped so nothing is mutated.
 */
async function exerciseModals(page, navTimeout, emit, onApi) {
  const triggers = page.locator(
    'button, a, [role="button"], .p-button, [class*="btn"]',
  );
  const total = await triggers.count().catch(() => 0);
  const SAFE = /\b(view|detail|details|info|information|more|preview|show|filter|column|legend|help|expand|chart)\b/i;
  const UNSAFE = /\b(add|edit|create|new|delete|remove|save|submit|update|import|upload|export|download|print|send|assign|approve|reject|cancel\s*ro|void)\b/i;
  const results = [];
  let opened = 0;
  for (let i = 0; i < total && opened < 4; i++) {
    const t = triggers.nth(i);
    const label = ((await t.innerText().catch(() => '')) || (await t.getAttribute('aria-label').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 40) continue;
    if (UNSAFE.test(label) || !SAFE.test(label)) continue;
    if (!(await t.isVisible().catch(() => false))) continue;

    try {
      await t.click({ timeout: 4000 });
      await page.waitForTimeout(900);
      const dialog = page.locator('.p-dialog, [role="dialog"], .modal, .p-overlaypanel, .p-sidebar').first();
      const shown = await dialog.isVisible().catch(() => false);
      if (shown) {
        opened++;
        results.push({ label, shown: true });
        emit({ type: 'modal', label, shown: true });
        // Close via the dialog's close control or Escape — never a Save/Confirm button.
        const close = page.locator('.p-dialog-header-close, [aria-label="Close"], .p-sidebar-close, .p-overlaypanel-close').first();
        if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
        else await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch {
      /* trigger not clickable; move on */
    }
  }
  return results;
}

/**
 * Click through any tab strip on the screen (PrimeNG tabs / Kendo tabs / role=tab),
 * settling after each so its lazy data + API calls fire. Read-only.
 */
async function exerciseTabs(page, navTimeout, emit) {
  const tabs = page.locator('[role="tab"], .p-tabview-nav li, .p-tabmenu-item, .mat-tab-label, .nav-tabs li');
  const total = await tabs.count().catch(() => 0);
  const seen = [];
  const max = Math.min(total, 8);
  for (let i = 0; i < max; i++) {
    const tab = tabs.nth(i);
    const label = (await tab.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!(await tab.isVisible().catch(() => false))) continue;
    try {
      await tab.click({ timeout: 4000 });
      await settle(page, navTimeout);
      seen.push(label || `tab ${i + 1}`);
      emit({ type: 'tab', label: label || `tab ${i + 1}` });
    } catch {
      /* skip */
    }
  }
  return seen;
}

/**
 * Test the in-app Export buttons (PDF / Excel / download icons) on the current screen or
 * tab. For each export control: click it, watch for the export API call it fires
 * (…/pdf, …/excel, …/export, …/download…), and record the endpoint + status. A 4xx/5xx on
 * an export endpoint is an export failure.
 *
 * This TRIGGERS a request (an export generates a file) but never mutates data. Downloads
 * are accepted and discarded. If no export control exists, it returns [] (skip).
 *
 * @param apiLog live array of {status,method,url,firstParty,ts} the page listener fills.
 * @param tab    optional tab label this export belongs to.
 */
async function exerciseExports(page, navTimeout, emit, apiLog, tab = null) {
  const EXPORT_API_RE = /\/(pdf|excel|xls|xlsx|csv|export|download[-\w]*|s3-files)(\/|\?|$)/i;
  // Export icons: PrimeNG file-pdf / file-excel, and download icons.
  const icons = page.locator(
    'span.pi-file-pdf, span.pi-file-excel, button .pi-file-pdf, button .pi-file-excel, ' +
    '[class*="pi-file-pdf"], [class*="pi-file-excel"], [aria-label*="export" i], [title*="export" i], ' +
    '[title*="pdf" i], [title*="excel" i]',
  );
  const n = await icons.count().catch(() => 0);
  const results = [];
  const MAX = 12; // cap per screen so a grid of 40 row-download icons can't explode the run
  let tested = 0;
  for (let i = 0; i < n && tested < MAX; i++) {
    const icon = icons.nth(i);
    if (!(await icon.isVisible().catch(() => false))) continue;
    // Classify format from the icon's own classes.
    const cls = ((await icon.getAttribute('class').catch(() => '')) || '').toLowerCase();
    const title = ((await icon.getAttribute('title').catch(() => '')) || (await icon.getAttribute('aria-label').catch(() => '')) || '').toLowerCase();
    let format = 'export';
    if (/pdf/.test(cls + title)) format = 'PDF';
    else if (/excel|xls/.test(cls + title)) format = 'Excel';
    else if (/download/.test(cls + title)) format = 'Download';

    const mark = apiLog.length; // snapshot the log position
    let downloadName = null;
    const dlP = page.waitForEvent('download', { timeout: 3000 }).then((d) => { downloadName = d.suggestedFilename(); return d.delete?.().catch(() => {}); }).catch(() => {});
    try {
      // Click the clickable ancestor (the button), falling back to the icon itself.
      const clickable = icon.locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button"][1]');
      if (await clickable.count().catch(() => 0)) await clickable.first().click({ timeout: 4000 });
      else await icon.click({ timeout: 4000, force: true });
    } catch (e) {
      results.push({ format, tab, ok: false, status: 'ERR', endpoint: '', error: `could not click export control: ${String(e.message).split('\n')[0]}` });
      emit({ type: 'export', tab, format, ok: false, status: 'ERR' });
      continue;
    }
    // Wait for the export request to fire and settle.
    await page.waitForTimeout(3000);
    await dlP;

    // Find the export API call(s) that fired since the click.
    const fired = apiLog.slice(mark).filter((a) => a.firstParty && EXPORT_API_RE.test(a.url));
    tested++;
    if (!fired.length) {
      // A download may have happened without a captured XHR (direct link). If we got a
      // file, call it success; otherwise record that nothing identifiable fired.
      const ok = Boolean(downloadName);
      results.push({ format, tab, ok, status: ok ? 'download' : 'no-api', endpoint: downloadName || '', error: ok ? '' : 'no export API detected' });
      emit({ type: 'export', tab, format, ok, status: ok ? 'download' : 'no-api' });
      continue;
    }
    for (const f of fired) {
      const ok = f.status < 400;
      results.push({ format, tab, ok, status: f.status, method: f.method, endpoint: f.url, error: ok ? '' : `HTTP ${f.status}` });
      emit({ type: 'export', tab, format, ok, status: f.status, endpoint: f.url });
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
  return results;
}

/**
 * Crawl the dealership.
 * @param {object} opts
 * @param {(e:object)=>void} opts.emit event callback for the live dashboard
 * @param {object[]} [opts.modules] override module list (defaults to MODULES)
 * @returns {Promise<{ok:boolean, landed?:string, results:object[], runDir:string, summary:object}>}
 */
export async function crawl({ emit: rawEmit = noop, modules = null, role = null, shouldStop = () => false, testExports = null } = {}) {
  const cfg = await resolveCfg(role);
  // Export testing: explicit option wins; otherwise fall back to the env var (default on).
  const exportsEnabled = testExports === null ? (process.env.HEALTH_TEST_EXPORTS !== 'false') : Boolean(testExports);
  if (!cfg.username || !cfg.password) throw new Error('KPI_USERNAME / KPI_PASSWORD missing from .env');

  // Tag every event with the role so a single dashboard can route DEALER vs AUTOGROUP
  // events into their own columns when both run at once.
  const emit = (e) => rawEmit({ role: cfg.role, ...e });

  const startedDate = new Date();
  const startedAt = formatStamp(startedDate); // DD/MM/YYYY HH:MM AM/PM
  const runId = `${startedDate.toISOString().replace(/[:.]/g, '-')}-${cfg.role.toLowerCase()}`;
  const runDir = path.join('artifacts', 'health', runId);
  const shotDir = path.join(runDir, 'screenshots');
  await mkdir(shotDir, { recursive: true });

  emit({ type: 'run-start', base: cfg.base, role: cfg.role, user: cfg.username, total: 0, runId, startedAt });

  const browser = await chromium.launch({ ...launchArgs(cfg.headless), slowMo: cfg.slowMo });
  const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Per-screen network + console buffers.
  let apis = [];
  let consoleErrs = [];
  let dealerName = ''; // discovered passively from an API body (see below)
  const firstParty = (url) => { try { return API_HOST_RE.test(new URL(url).hostname); } catch { return false; } };
  // Wall-clock request-start timestamps, keyed by the Playwright request object. Used to
  // compute a reliable response time, because req.timing().responseEnd is NOT populated in
  // the 'response' event (it's -1 until the request finishes) — which is why Time(ms) was
  // coming out blank.
  const reqStart = new WeakMap();
  page.on('request', (req) => { try { const t = req.resourceType(); if (t === 'xhr' || t === 'fetch') reqStart.set(req, Date.now()); } catch { /* ignore */ } });
  page.on('response', (r) => {
    try {
      const req = r.request();
      const t = req.resourceType();
      if (t !== 'xhr' && t !== 'fetch') return;
      const url = r.url();
      const now = Date.now();
      // Response time = now − request start (wall clock). Prefer Playwright's own timing if
      // it happens to be populated; otherwise use the wall-clock delta. null only if neither.
      let ms = null;
      try { const tm = req.timing(); if (tm && tm.responseEnd > 0) ms = Math.round(tm.responseEnd - (tm.startTime > 0 ? 0 : 0)); } catch { ms = null; }
      if (ms == null) { const s = reqStart.get(req); if (typeof s === 'number') ms = Math.max(0, now - s); }
      // Payload: query string for GET, redacted + truncated body for POST/PUT/PATCH.
      const method = req.method();
      let payload = '';
      try { if (method !== 'GET' && method !== 'HEAD') payload = redactBody(req.postData()); } catch { payload = ''; }
      const rec = {
        status: r.status(), method, url, name: apiName(url), endpoint: endpointPath(url),
        query: queryString(url), payload, ms, firstParty: firstParty(url),
        ts: now, iso: new Date(now).toISOString(),
      };
      apis.push(rec);
      emit({ type: 'api', status: rec.status, method: rec.method, url: rec.url, ms });
      // Passively sniff the dealership name out of API bodies (works for both DEALER and
      // AUTOGROUP, no CORS/401 issues since the app itself made the authenticated call).
      if (!dealerName && firstParty(url) && rec.status === 200 && /companyname|company_name|dealername|dealer_name|autodealer|dealer-dashboard|dashboard\/get/i.test(url)) {
        r.json().then((body) => {
          if (dealerName) return;
          const n = extractDealerName(body);
          if (n) { dealerName = n; emit({ type: 'dealer', name: n }); }
        }).catch(() => {});
      }
    } catch { /* ignore */ }
  });
  page.on('console', (m) => { if (m.type() === 'error') { consoleErrs.push(m.text()); emit({ type: 'console-error', msg: m.text().slice(0, 300) }); } });
  page.on('requestfailed', (req) => {
    // Only Fetch/XHR matter for this report — ignore failed images/scripts/fonts/etc so
    // the results contain strictly API (Fetch/XHR) outcomes, nothing else.
    const t = req.resourceType();
    if (t !== 'xhr' && t !== 'fetch') return;
    const err = req.failure()?.errorText ?? '';
    // An ABORTED request is NOT a server failure — it means the page navigated away or we
    // called window.stop() (budget/retry) before the request finished. Counting it would
    // be a false positive (e.g. "Deal Structure Log" flipped to WARN purely because a slow
    // menu click triggered window.stop() mid-request). Ignore these cancellations.
    if (/ERR_ABORTED|NS_BINDING_ABORTED|ABORTED|canceled|cancelled/i.test(err)) return;
    const msg = `requestfailed ${t} ${req.url()} :: ${err}`;
    consoleErrs.push(msg);
    emit({ type: 'console-error', msg: msg.slice(0, 300) });
  });

  const results = [];

  const auth = await login(page, cfg, emit);
  emit({ type: 'login', ok: auth.ok, landed: auth.landed });
  if (!auth.ok) {
    await page.screenshot({ path: path.join(shotDir, 'login-fail.png'), fullPage: true }).catch(() => {});
    await browser.close();
    const summary = { ok: false, reason: 'login-failed', landed: auth.landed };
    // A failed login blocks the whole crawl — alert on it as a failure too.
    await notifyFailure(
      { group: 'Auth', name: 'Login', url: `${cfg.base}/login`, httpStatus: '-', reason: `login did not succeed (landed ${auth.landed})`, forbidden: [], serverErrors: [], clientErrors: [], consoleErrors: [] },
      { base: cfg.base, role: cfg.role, user: cfg.username },
    ).catch(() => {});
    emit({ type: 'done', summary, results });
    return { ok: false, landed: auth.landed, results, runDir, summary };
  }

  // The dealership name (e.g. "Gary Yeomans Honda") is captured passively from API bodies
  // by the response listener above as the crawl proceeds; `dealerName` fills in once seen.

  // Discover the full sidebar (every module + every child item) live, unless the caller
  // passed an explicit list. Merge with the curated MODULES so a known screen is never
  // dropped if discovery misses it, and so grouping stays readable.
  if (!modules) {
    let discovered = [];
    try {
      discovered = await discoverSidebar(page, cfg, emit);
    } catch (e) {
      emit({ type: 'log', msg: `Sidebar discovery failed (${String(e.message).split('\n')[0]}); using curated list` });
    }
    // Discovery now walks the full nested DMS tree, so the curated list is only a safety
    // net: use it for DEALER ONLY if discovery came back suspiciously small (e.g. the menu
    // failed to render). Otherwise trust live discovery entirely.
    const curated = cfg.role.toUpperCase() === 'DEALER' && discovered.length < 15 ? MODULES : [];
    const byPath = new Map();
    for (const m of [...discovered, ...curated]) {
      // Normalise so /v2/x and https://host/v2/x collapse to one entry.
      let p = m.path;
      try { if (/^https?:/i.test(p)) p = new URL(p).pathname; } catch { /* keep */ }
      // Key on the path when there is one; otherwise on group+name (click-only leaves that
      // share no URL must each stay distinct).
      const key = p || `${m.group}|${m.subGroup || ''}|${m.name}`;
      if (!byPath.has(key)) byPath.set(key, { group: m.group || 'Menu', subGroup: m.subGroup || '', name: m.name || p, path: p, clickId: m.clickId || null });
    }
    // Preserve menu order: the Map keeps insertion order, and `discovered` is built by
    // walking the DOM top-to-bottom (DMS left sidebar) and left-to-right across the
    // top-nav dropdowns (AutoGroup). Do NOT sort — crawling must follow the on-screen
    // sequence so the user can track what's done vs pending against the real menu.
    modules = [...byPath.values()];
  }
  emit({ type: 'modules', total: modules.length, modules: modules.map((m) => ({ group: m.group, subGroup: m.subGroup || '', name: m.name, path: m.path })) });

  let stopped = false;
  for (let idx = 0; idx < modules.length; idx++) {
    if (shouldStop()) { stopped = true; emit({ type: 'log', msg: 'Stop requested — ending crawl' }); break; }
    const m = modules[idx];
    const url = m.path ? `${cfg.base}${m.path}` : '';
    const navBy = m.clickId && !m.path ? 'click' : 'url';

    if (m.path && BLOCKED_RE.test(m.path)) {
      const rec = { ...m, url, verdict: 'SKIP', reason: 'write/CRUD route — skipped by design', apis: [], consoleErrors: [], tabs: [], modals: [], attempts: 0 };
      results.push(rec);
      emit({ type: 'screen-done', index: idx, ...rec });
      continue;
    }

    emit({ type: 'screen-start', index: idx, group: m.group, subGroup: m.subGroup || '', name: m.name, path: m.path || `(menu click: ${m.name})`, url });

    // One full check of this screen: navigate, settle, exercise tabs + modals + exports,
    // then judge by the first-party API statuses and console errors seen during that visit.
    // Export testing clicks several buttons with waits, so the budget is larger when it's on.
    const SCREEN_BUDGET_MS = Number(process.env.HEALTH_SCREEN_BUDGET_MS ?? (exportsEnabled ? 120000 : 45000));
    const attemptScreen = async () => {
      apis = [];
      consoleErrs = [];
      let httpStatus = null;
      let navError = null;
      let tabs = [];
      let modals = [];
      let exportTests = [];
      let timedOut = false;
      let capturedShot = null;

      const work = (async () => {
        try {
          if (navBy === 'click') {
            // href-less menu leaf: click its tagged anchor. The sidebar persists across SPA
            // navigation, so the data-health-id set during discovery is still present. If a
            // prior full-page nav wiped it, re-run discovery tagging by going to the landing.
            let target = page.locator(`[data-health-id="${m.clickId}"]`).first();
            if (!(await target.count().catch(() => 0))) {
              await page.goto(`${cfg.base}/v2/dealership/sales-dashboard`, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout }).catch(() => {});
              await settle(page, cfg.navTimeout);
              await discoverSidebar(page, cfg, () => {}).catch(() => {});
              target = page.locator(`[data-health-id="${m.clickId}"]`).first();
            }
            await target.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
            await target.click({ timeout: 8000 });
            httpStatus = '(spa)';
          } else {
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(cfg.navTimeout, SCREEN_BUDGET_MS) });
            httpStatus = resp?.status() ?? null;
          }
        } catch (e) {
          navError = String(e.message).split('\n')[0];
        }
        await settle(page, cfg.navTimeout);
        modals = await exerciseModals(page, cfg.navTimeout, emit, null).catch(() => []);

        // Test exports when enabled (per-run UI toggle, or env fallback). First on the base
        // screen, then within each tab. When off: pure navigation health only.
        if (exportsEnabled) {
          exportTests.push(...(await exerciseExports(page, cfg.navTimeout, emit, apis, null).catch(() => [])));
        }

        // Click through tabs; test each tab's exports too.
        const tabLocs = page.locator('[role="tab"], .p-tabview-nav li, .p-tabmenu-item, .mat-tab-label, .nav-tabs li');
        const tabTotal = await tabLocs.count().catch(() => 0);
        for (let ti = 0; ti < Math.min(tabTotal, 8); ti++) {
          const tab = tabLocs.nth(ti);
          if (!(await tab.isVisible().catch(() => false))) continue;
          const tabLabel = (await tab.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 40) || `tab ${ti + 1}`;
          try {
            await tab.click({ timeout: 4000 });
            await settle(page, cfg.navTimeout);
            tabs.push(tabLabel);
            emit({ type: 'tab', label: tabLabel });
            if (exportsEnabled) {
              exportTests.push(...(await exerciseExports(page, cfg.navTimeout, emit, apis, tabLabel).catch(() => [])));
            }
          } catch { /* skip tab */ }
        }

        // Capture the screenshot HERE, while we are provably still on this module's page
        // and it has settled. Taking it later (after the retry loop) risked snapping the
        // next page or a half-loaded admin reload — that caused the wrong-screenshot bug.
        const shotRel = `screenshots/${String(idx).padStart(2, '0')}-${m.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`;
        await page.screenshot({ path: path.join(runDir, ...shotRel.split('/')), fullPage: false }).catch(() => {});
        capturedShot = shotRel;
      })();

      await withDeadline(work.then(() => false), SCREEN_BUDGET_MS, true).then((hit) => { timedOut = hit; });
      if (timedOut) {
        navError = navError || `screen exceeded ${SCREEN_BUDGET_MS}ms budget`;
        await page.evaluate(() => window.stop()).catch(() => {});
      }

      const screenApis = apis.slice();
      const screenConsole = consoleErrs.slice();
      const forbidden = screenApis.filter((a) => a.firstParty && (a.status === 401 || a.status === 403));
      const serverErr = screenApis.filter((a) => a.firstParty && a.status >= 500);
      const clientErr = screenApis.filter((a) => a.firstParty && a.status >= 400 && a.status < 500 && a.status !== 401 && a.status !== 403);
      const landed = page.url();
      const bouncedToLogin = /\/login(\?|$|\/)/.test(landed);

      let verdict = 'PASS';
      const reasons = [];
      if (timedOut && !forbidden.length && !serverErr.length && !bouncedToLogin) {
        verdict = 'WARN'; reasons.push(navError);
      } else if (navError) { verdict = 'FAIL'; reasons.push(`navigation error: ${navError}`); }
      if (bouncedToLogin) { verdict = 'FAIL'; reasons.push('bounced to /login (session/route issue)'); }
      if (forbidden.length) { verdict = 'FAIL'; reasons.push(`${forbidden.length} API 401/403`); }
      if (serverErr.length) { verdict = 'FAIL'; reasons.push(`${serverErr.length} API 5xx`); }
      if (clientErr.length && verdict === 'PASS') { verdict = 'WARN'; reasons.push(`${clientErr.length} API 4xx`); }
      if (screenConsole.length && verdict === 'PASS') { verdict = 'WARN'; reasons.push(`${screenConsole.length} console error(s)`); }

      // Export test outcomes: a failed export (4xx/5xx on its endpoint, or a click/other
      // error) is an export failure and makes the whole screen FAIL.
      const exportFails = exportTests.filter((e) => !e.ok);
      const exportOks = exportTests.filter((e) => e.ok);
      if (exportFails.length) {
        verdict = 'FAIL';
        reasons.push(`${exportFails.length} export failure(s)`);
      }
      if (exportTests.length) {
        reasons.push(`exports tested: ${exportTests.length} (${exportOks.length} ok, ${exportFails.length} failed)`);
      }

      // Every failed first-party API, structured, so the report can show each one as its
      // own row with method + status + the classification that made it a failure. Export
      // failures are included here too, tagged with their format and tab.
      const failedApis = [
        ...forbidden.map((a) => ({ status: a.status, method: a.method, url: a.url, kind: 'auth (401/403)' })),
        ...serverErr.map((a) => ({ status: a.status, method: a.method, url: a.url, kind: 'server (5xx)' })),
        ...clientErr.map((a) => ({ status: a.status, method: a.method, url: a.url, kind: 'client (4xx)' })),
        ...exportFails.map((e) => ({ status: e.status, method: e.method || '-', url: e.endpoint || e.error || '', kind: `export ${e.format}${e.tab ? ` [tab: ${e.tab}]` : ''}` })),
      ];

      // Full, de-duped API list for this screen (every first-party Fetch/XHR, with name,
      // endpoint, query, redacted payload, response time, status). This is the "complete
      // API list" the report groups module-wise. Slow line = §2 single-dealer month max
      // (1.30s tolerance = 1300ms) — the only §2 value applicable without a filter context.
      const SLOW_MS = 1300;
      const allApis = dedupeApis(screenApis.filter((a) => a.firstParty).map((a) => ({
        name: a.name, method: a.method, endpoint: a.endpoint, query: a.query || '',
        payload: a.payload || '', status: a.status, ms: typeof a.ms === 'number' ? a.ms : null,
        error: a.status >= 400 ? `HTTP ${a.status}` : '',
      })));
      const slowApis = allApis.filter((a) => typeof a.ms === 'number' && a.ms > SLOW_MS);

      return {
        ...m, url, landed, verdict,
        httpStatus: httpStatus ?? (navError ? 'ERR' : '-'),
        reason: reasons.join('; ') || 'loaded; all first-party APIs < 400; no console errors',
        apiCount: screenApis.length,
        apis: screenApis.map((a) => ({ status: a.status, method: a.method, url: a.url })),
        allApis, slowApis, slowThresholdMs: SLOW_MS,
        // Keep timestamped APIs separately for the persistent history log (not sent to the
        // live UI event, which keeps the lighter apis[] above).
        apisTimed: screenApis.map((a) => ({ status: a.status, method: a.method, url: a.url, iso: a.iso, ts: a.ts })),
        failedApis,
        exports: exportTests,
        exportsSummary: { total: exportTests.length, ok: exportOks.length, failed: exportFails.length },
        forbidden: forbidden.map((a) => `${a.status} ${a.url}`),
        serverErrors: serverErr.map((a) => `${a.status} ${a.url}`),
        clientErrors: clientErr.map((a) => `${a.status} ${a.url}`),
        consoleErrors: screenConsole.slice(0, 20),
        tabs, modals,
        screenshot: capturedShot,
      };
    };

    // Retry on FAIL before alerting: a failure is often transient (a deploy/build in
    // flight, a cold cache, a brief 5xx). Re-check up to RETRIES times, waiting a random
    // 10–20s between attempts, and only treat it as a real failure if it keeps failing.
    const RETRIES = Number(process.env.HEALTH_FAIL_RETRIES ?? 2);
    const MIN_DELAY = Number(process.env.HEALTH_RETRY_MIN_MS ?? 10000);
    const MAX_DELAY = Number(process.env.HEALTH_RETRY_MAX_MS ?? 20000);
    let rec = await attemptScreen();
    let attempts = 1;
    while (rec.verdict === 'FAIL' && attempts <= RETRIES && !shouldStop()) {
      const delay = Math.round(MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY));
      emit({ type: 'retry', index: idx, name: m.name, attempt: attempts, of: RETRIES, delayMs: delay, reason: rec.reason });
      emit({ type: 'log', msg: `"${m.name}" failed (${rec.reason}); retry ${attempts}/${RETRIES} in ${Math.round(delay / 1000)}s` });
      await new Promise((r) => setTimeout(r, delay));
      rec = await attemptScreen();
      attempts++;
    }
    rec.attempts = attempts;
    // rec.screenshot was captured inside the attempt, on the correct settled page.
    if (attempts > 1) rec.reason = `${rec.reason} (after ${attempts} attempt${attempts > 1 ? 's' : ''})`;

    results.push(rec);
    emit({ type: 'screen-done', index: idx, ...rec });

    // Append every API (and export) from this module to the persistent history log, with
    // exact timestamps + module context, for later day/time trend analysis.
    appendApiLog(
      { runId, role: cfg.role, group: m.group, subGroup: m.subGroup || '', screen: m.name },
      rec.apisTimed || [],
      rec.failedApis || [],
      rec.exports || [],
    ).catch(() => {});
    // Don't carry the timestamped copy into results.json (apis[] + failedApis already cover it).
    delete rec.apisTimed;

    // Alert only after the retries have been exhausted and it is still failing.
    if (rec.verdict === 'FAIL') {
      notifyFailure(rec, { base: cfg.base, role: cfg.role, user: cfg.username, dealerName })
        .then((r) => { if (r && r.ok) emit({ type: 'log', msg: `Google Chat alert sent for "${rec.name}" (failed ${attempts} attempts)` }); })
        .catch(() => {});
    }
  }

  await browser.close();

  const summary = {
    ok: true,
    stopped,
    total: results.length,
    pass: results.filter((r) => r.verdict === 'PASS').length,
    warn: results.filter((r) => r.verdict === 'WARN').length,
    fail: results.filter((r) => r.verdict === 'FAIL').length,
    skip: results.filter((r) => r.verdict === 'SKIP').length,
  };
  await writeFile(path.join(runDir, 'results.json'), JSON.stringify({ cfg: { base: cfg.base, role: cfg.role, user: cfg.username, dealerName }, startedAt, finishedAt: formatStamp(new Date()), summary, results }, null, 2), 'utf8');

  // End-of-run roll-up to Google Chat — ALWAYS sent, with full counts and the per-module
  // breakdown, whether or not anything failed.
  const failures = results.filter((r) => r.verdict === 'FAIL');
  await notifyRunSummary(summary, failures, results, { base: cfg.base, role: cfg.role, user: cfg.username, dealerName, when: formatStamp(new Date()) }).catch(() => {});

  emit({ type: 'done', summary, results, runDir });
  return { ok: true, landed: auth.landed, results, runDir, summary };
}
