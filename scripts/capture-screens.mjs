/**
 * Phase 2 capture: log in under a role, open a report screen, and record everything.
 *
 * STRICTLY READ-ONLY. Navigates and reads. Never submits a mutating request.
 *
 * Captures, per screen:
 *   - every XHR/fetch to the API host, with request payload and JSON response body
 *   - the rendered table/grid contents (headers + rows)
 *   - label/value pairs for card-style KPI tiles
 *   - full-page screenshot + raw HTML
 *   - the storage state, so later runs can skip login
 *
 * Usage:
 *   node scripts/capture-screens.mjs autogroup
 *   node scripts/capture-screens.mjs dms
 *   node scripts/capture-screens.mjs both
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

dotenv.config();

const cfg = {
  base: required('KPI_BASE_URL'),
  username: required('KPI_USERNAME'),
  password: required('KPI_PASSWORD'),
  headless: process.env.KPI_HEADLESS !== 'false',
  navTimeout: Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000),
  apiHost: 'api.mydealerkpi.com',
};

function required(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing ${key} in .env`);
    process.exit(1);
  }
  return v;
}

/** Redact anything that could leak the password into an artifact. */
function redact(text) {
  if (typeof text !== 'string') return text;
  return text.split(cfg.password).join('***REDACTED***');
}

const TARGETS = {
  autogroup: {
    key: 'autogroup',
    role: process.env.KPI_ROLE_AUTOGROUP ?? 'AUTOGROUP',
    urlPath: process.env.KPI_AUTOGROUP_PATH ?? '/auto-group-v2/service/service-summary',
    label: 'AutoGroup v2 — Service Summary',
  },
  dms: {
    key: 'dms',
    role: process.env.KPI_ROLE_DEALER ?? 'DEALER',
    urlPath: process.env.KPI_DMS_PATH ?? '/report/services/dashboard',
    label: 'DMS — Service Dashboard',
  },
};

/**
 * Parse `--flag value` pairs so the suite runner can capture any module, not just
 * the two hardcoded Service screens.
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/** Split a full URL into the base origin and the path the SPA should navigate to. */
function splitUrl(full) {
  const u = new URL(full);
  return { base: u.origin, urlPath: `${u.pathname}${u.search}${u.hash}` };
}

/** Select a role in the PrimeNG combobox by its exact visible label. */
async function selectRole(page, roleLabel) {
  const combo = page.locator('p-select').first();
  await combo.waitFor({ state: 'visible', timeout: cfg.navTimeout });
  const current = (await combo.innerText()).trim().toUpperCase();
  if (current === roleLabel.toUpperCase()) return { changed: false, from: current };

  await combo.click();
  const option = page.locator('.p-select-option', { hasText: new RegExp(`^${roleLabel}$`, 'i') });
  await option.first().waitFor({ state: 'visible', timeout: 15000 });
  await option.first().click();
  await page.waitForTimeout(500);
  const after = (await combo.innerText()).trim();
  return { changed: true, from: current, to: after };
}

async function login(page, roleLabel) {
  await page.goto(`${cfg.base}/login`, {
    waitUntil: 'domcontentloaded',
    timeout: cfg.navTimeout,
  });
  await page.waitForLoadState('networkidle', { timeout: cfg.navTimeout }).catch(() => {});
  await page.locator('input[name="username"]').waitFor({ timeout: cfg.navTimeout });

  await page.locator('input[name="username"]').fill(cfg.username);
  await page.locator('input[name="password"]').fill(cfg.password);
  const roleResult = await selectRole(page, roleLabel);

  await page.locator('input[type="submit"]').click();

  // Success == we leave /login. Give the SPA room to bootstrap.
  try {
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), {
      timeout: cfg.navTimeout,
    });
  } catch {
    const err = await page
      .locator('.p-toast-detail, .p-message, [class*="error"]')
      .allInnerTexts()
      .catch(() => []);
    throw new Error(
      `Login did not leave /login for role ${roleLabel}. On-screen messages: ${JSON.stringify(err)}`,
    );
  }
  await page.waitForLoadState('networkidle', { timeout: cfg.navTimeout }).catch(() => {});
  return { roleResult, landedUrl: page.url() };
}

/** Wait until report data has actually rendered, not just the shell. */
async function waitForData(page) {
  await page.waitForLoadState('networkidle', { timeout: cfg.navTimeout }).catch(() => {});
  // Loading indicators used by PrimeNG / Kendo / the app's own spinner.
  const spinners = [
    '.p-progressbar',
    '.p-progress-spinner',
    '.k-loading-mask',
    '[class*="loading"]',
    '[class*="skeleton"]',
  ];
  for (const s of spinners) {
    await page
      .locator(s)
      .first()
      .waitFor({ state: 'hidden', timeout: 20000 })
      .catch(() => {});
  }

  // Wait until some visible table actually holds numeric data.
  //
  // This previously waited for a table containing "RO COUNT", which only exists on the
  // Service screens. On any other module it timed out and the capture went ahead on a
  // guess, sometimes reading the page before its grid had rendered and recording zero
  // tables. The condition below is module-agnostic: a real report grid has a body row
  // with several populated cells, at least one of which is a number.
  const grids = await page
    .waitForFunction(
      () => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const numeric = /[\d]/;
        const ready = [...document.querySelectorAll('table')].filter((t) => {
          if (!visible(t)) return false;
          return [...t.querySelectorAll('tbody tr')].some((tr) => {
            const cells = [...tr.children].map((c) => (c.textContent ?? '').trim());
            return cells.filter(Boolean).length >= 2 && cells.some((c) => numeric.test(c));
          });
        });
        return ready.length > 0 ? ready.length : false;
      },
      { timeout: 60000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => 0);

  if (grids) {
    console.log(`Data grids ready: ${grids}`);
  } else {
    console.log('(no table reported numeric data within 60s — the capture may be incomplete)');
  }

  // The supporting strips (days worked, CSE, advisor counts) hydrate separately and
  // later than the grid. They are needed to validate the derived columns, so wait
  // for the days strip specifically rather than relying on a blanket sleep.
  await page
    .waitForFunction(
      () => {
        const t = [...document.querySelectorAll('table')].find((x) =>
          (x.querySelector('thead')?.innerText ?? '').toUpperCase().includes('DAYS IN A MONTH'),
        );
        if (!t) return false;
        const cells = [...(t.querySelectorAll('tbody tr td, tbody tr th') ?? [])];
        return cells.some((c) => /\d/.test(c.textContent ?? ''));
      },
      { timeout: 30000 },
    )
    .catch(() => console.log('(days strip did not populate; derived-column checks may be limited)'));

  await page.waitForTimeout(3000);
}

/** Pull tables, grids, and KPI tiles out of the rendered page. */
async function extractRendered(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

    /**
     * Expand a thead into a rectangular matrix aligned index-for-index with body
     * cells, honouring colspan and rowspan.
     *
     * Report grids group columns under spanning headers (a "WARRANTY" cell spanning
     * four measure columns, each of which spans three sub-columns). Reading the
     * header rows flat loses that structure, which is why column positions had to be
     * hardcoded per screen. With the spans expanded, every body column index maps to
     * a full header chain, so the geometry can be derived instead of assumed.
     */
    const buildHeaderGrid = (tbl) => {
      const rows = [...tbl.querySelectorAll('thead tr')];
      if (!rows.length) return [];
      const grid = [];
      // occupied[row][col] tracks cells already filled by a rowspan from above.
      rows.forEach(() => grid.push([]));

      rows.forEach((tr, r) => {
        let c = 0;
        for (const cell of tr.querySelectorAll('th,td')) {
          while (grid[r][c] !== undefined) c++; // skip slots taken by a rowspan
          const text = clean(cell.innerText);
          const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1);
          const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1);
          for (let dr = 0; dr < rowspan && r + dr < rows.length; dr++) {
            for (let dc = 0; dc < colspan; dc++) {
              grid[r + dr][c + dc] = text;
            }
          }
          c += colspan;
        }
      });

      const width = Math.max(0, ...grid.map((g) => g.length));
      return grid.map((g) => {
        const out = [];
        for (let i = 0; i < width; i++) out.push(g[i] ?? '');
        return out;
      });
    };

    // --- Tables (native + PrimeNG p-table + Kendo grid) ---
    const tables = [...document.querySelectorAll('table')]
      .filter(isVisible)
      .map((tbl, idx) => {
        const headers = [...tbl.querySelectorAll('thead tr')].map((tr) =>
          [...tr.querySelectorAll('th,td')].map((c) => clean(c.innerText)),
        );
        const headerGrid = buildHeaderGrid(tbl);
        const bodyRows = [...tbl.querySelectorAll('tbody tr')]
          .filter(isVisible)
          .map((tr) => [...tr.querySelectorAll('th,td')].map((c) => clean(c.innerText)));
        const footRows = [...tbl.querySelectorAll('tfoot tr')].map((tr) =>
          [...tr.querySelectorAll('th,td')].map((c) => clean(c.innerText)),
        );
        return {
          index: idx,
          caption: clean(tbl.caption?.innerText),
          className: tbl.className,
          headers,
          headerGrid,
          rowCount: bodyRows.length,
          rows: bodyRows,
          footers: footRows,
        };
      });

    /**
     * --- KPI tiles: the analytics strip above the grid ---
     *
     * These carry the headline figures for the module — total ROs, ELR, labour and parts
     * sales and gross — and on some screens they are the only place those totals appear.
     * They are card layouts, not tables, so they have to be read as label/value pairs.
     *
     * Two things went wrong in the first version of this, and both mattered:
     *
     *  1. `td` and `li` were in the selector and nothing excluded table descendants, so
     *     every numeric cell of the record listing was collected as a "tile". A 25-row
     *     grid produced hundreds of junk entries that buried the eight real ones.
     *
     *  2. The label was taken as the first non-numeric text in the nearest ancestor. On a
     *     card whose value and sub-caption share a wrapper, that wrapper contains only
     *     "$87,175.22" and "87.3% GROSS", so the sub-caption became the label and the real
     *     one — LABOR SALE, sitting one level up — was never seen.
     *
     * So: leaf nodes outside any table, and the label is the nearest text *preceding* the
     * value that actually reads like the name of a measure, hopping further up while the
     * only candidate looks like a sub-caption.
     */
    const numeric = /^[-+(]?[$€£]?\s?[\d,]+(\.\d+)?\s?[%)]?$/;

    /** Reads like the name of a measure, rather than a value, a date or a person. */
    const labelLike = (t) => {
      if (!t || t.length > 48) return false;
      if (numeric.test(t)) return false;
      // A sub-caption restates the figure: "87.3% GROSS", "AFTER COST", "$269.99 PER HOUR".
      if (/[$€£]/.test(t)) return false;
      if (/\d+(\.\d+)?\s*%/.test(t)) return false;
      // Dates and date captions belong to grid rows, not to the analytics strip.
      if (/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(t)) return false;
      if (/^(OPEN|CLOSE|CLOSED|OPENED)\b.*:/i.test(t)) return false;
      if (/^\+\d+\s*MORE$/i.test(t)) return false;
      // Pagination furniture: "1 TO 25 OUT OF 362 RECORDS", "Showing 1-25 of 362".
      if (/\d+\s*(TO|-|–)\s*\d+\s*(OUT\s+)?OF\s*\d+/i.test(t)) return false;
      if (/^SHOWING\b/i.test(t)) return false;
      if (/\bPER PAGE\b/i.test(t)) return false;
      // A subtotal caption such as "CP 450 · W 72 · I 648" is mostly digits. It names no
      // measure, and one of them paired with an unrelated 25 purely because both screens
      // happened to be showing 25 rows.
      const letters = (t.match(/[A-Za-z]/g) ?? []).length;
      const digits = (t.match(/\d/g) ?? []).length;
      if (digits > letters) return false;
      return /[A-Za-z]{2,}/.test(t);
    };

    const tiles = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('div,span,p,h1,h2,h3,h4,h5,h6,strong,b')) {
      if (el.children.length > 0) continue; // leaf nodes only
      // The analytics strip is never inside the grid. This single exclusion removes the
      // hundreds of row-level values that used to swamp the real tiles.
      if (el.closest('table')) continue;
      if (!isVisible(el)) continue;

      const val = clean(el.innerText);
      if (!val || val.length > 24 || !numeric.test(val)) continue;

      // Walk up looking for the nearest preceding label-like text.
      let label = '';
      let caption = '';
      let node = el;
      for (let hop = 0; hop < 5 && !label; hop++) {
        node = node.parentElement;
        if (!node || node === document.body) break;

        /**
         * Collect text nodes, not leaf elements.
         *
         * A card title is often "LABOR SALE" followed by an info icon inside the same
         * element, which makes that element a non-leaf — so it was skipped, and the nearest
         * preceding text turned out to belong to the *previous* card. DMS's labour sales
         * figure was consequently labelled "DOOR RATE". Walking text nodes sees the title
         * regardless of what markup sits beside it.
         */
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) =>
            clean(n.nodeValue) && isVisible(n.parentElement)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT,
        });
        const texts = [];
        while (walker.nextNode()) texts.push({ text: clean(walker.currentNode.nodeValue), node: walker.currentNode });

        const idx = texts.findIndex((t) => t.node.parentElement === el || el.contains(t.node));
        if (idx === -1) continue;

        // Nearest preceding text that names a measure.
        for (let i = idx - 1; i >= 0; i--) {
          if (texts[i].text === val) continue;
          if (labelLike(texts[i].text)) { label = texts[i].text; break; }
        }
        // The first text after the value is the sub-caption, e.g. "87.3% GROSS".
        if (!caption) {
          for (let i = idx + 1; i < texts.length; i++) {
            if (texts[i].text && texts[i].text !== val) { caption = texts[i].text; break; }
          }
        }
      }

      if (!label) continue; // an unlabelled figure cannot be matched to anything

      const rect = el.getBoundingClientRect();
      const key = `${label}|${val}`;
      if (seen.has(key)) continue;
      seen.add(key);

      tiles.push({
        label,
        value: val,
        // The secondary line on the card, kept because it often states the basis of the
        // figure ("AFTER COST", "PER BILL HOUR") which the label alone does not.
        caption: caption || null,
        y: Math.round(rect.top + window.scrollY),
        x: Math.round(rect.left + window.scrollX),
      });
    }

    // Document order top to bottom, so the strip reads as it looks on screen.
    tiles.sort((a, b) => a.y - b.y || a.x - b.x);

    // --- Filter controls currently applied ---
    const filters = [...document.querySelectorAll('p-select, p-datepicker, p-calendar, input, p-multiselect')]
      .filter(isVisible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        name: el.getAttribute('name'),
        placeholder: el.getAttribute('placeholder'),
        text: clean(el.innerText).slice(0, 80),
        value: el.value ?? null,
      }));

    return {
      url: location.href,
      title: document.title,
      tables,
      tileCount: tiles.length,
      tiles,
      filters,
      iframeCount: document.querySelectorAll('iframe').length,
      bodyTextLength: document.body.innerText.length,
    };
  });
}

/**
 * Capture screenshot evidence of the metric grid.
 *
 * A single element screenshot is not viable here: the DMS grid is 114 rows by 66
 * columns with frozen columns, and Playwright times out trying to rasterize it.
 * Instead we scroll through it and take plain viewport shots, which always
 * succeed and stay readable. We also scroll horizontally so the Warranty and
 * Internal blocks are captured, not just the leading columns.
 *
 * Returns a manifest of the files written.
 */
async function captureEvidence(page, outDir) {
  const shots = { viewport: null, fullPage: null, slices: [] };

  // 1. Plain viewport — the screen as a user first sees it.
  try {
    await page.screenshot({
      path: path.join(outDir, 'viewport.png'),
      animations: 'disabled',
      timeout: 30000,
    });
    shots.viewport = 'viewport.png';
  } catch (e) {
    console.log(`(viewport screenshot failed: ${e.message.split('\n')[0]})`);
  }

  // 2. Locate the metric grid and whatever elements actually scroll it.
  //    These grids scroll inside their own container, so scrolling the window
  //    alone produces duplicate images.
  const geom = await page.evaluate(() => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
    const table = [...document.querySelectorAll('table')].find((t) =>
      clean(t.innerText).includes('RO COUNT'),
    );
    if (!table) return null;

    table.setAttribute('data-evidence-grid', '1');

    let hScroller = null;
    let vScroller = null;
    let el = table.parentElement;
    while (el && el !== document.documentElement) {
      if (!hScroller && el.scrollWidth > el.clientWidth + 20) {
        el.setAttribute('data-evidence-hscroll', '1');
        hScroller = { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      }
      if (!vScroller && el.scrollHeight > el.clientHeight + 20) {
        el.setAttribute('data-evidence-vscroll', '1');
        vScroller = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      }
      if (hScroller && vScroller) break;
      el = el.parentElement;
    }

    const r = table.getBoundingClientRect();
    return {
      top: r.top + window.scrollY,
      height: r.height,
      width: r.width,
      scroller: hScroller,
      vScroller,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
    };
  });

  if (!geom) {
    console.log('(metric grid not found; only viewport captured)');
    return shots;
  }

  console.log(
    `Grid geometry: ${Math.round(geom.width)}x${Math.round(geom.height)}px` +
      (geom.scroller
        ? `, horizontally scrollable ${geom.scroller.clientWidth}/${geom.scroller.scrollWidth}px`
        : ', no horizontal scroll'),
  );

  const viewportH = page.viewportSize().height;
  const step = Math.floor(viewportH * 0.8);
  const maxSlices = 10;

  /**
   * Take vertical slices down the grid at the current horizontal offset.
   * Prefers the grid's own vertical scroller; falls back to the window. Stops
   * early once the image stops changing, so we never emit duplicates.
   */
  async function verticalSlices(tag) {
    const vTotal = geom.vScroller ? geom.vScroller.scrollHeight : geom.height;
    const vVisible = geom.vScroller ? geom.vScroller.clientHeight : viewportH;
    const vStep = geom.vScroller ? Math.floor(vVisible * 0.8) : step;
    const count = Math.min(maxSlices, Math.max(1, Math.ceil(vTotal / vStep) + 1));

    let lastSize = -1;
    for (let i = 0; i < count; i++) {
      const offset = i * vStep;
      if (geom.vScroller) {
        await page.evaluate((top) => {
          const s = document.querySelector('[data-evidence-vscroll]');
          if (s) s.scrollTop = top;
        }, offset);
      } else {
        await page.evaluate((top) => window.scrollTo(0, top), Math.max(0, geom.top - 80 + offset));
      }
      await page.waitForTimeout(400);

      const name = `grid-${tag}-${String(i + 1).padStart(2, '0')}.png`;
      const file = path.join(outDir, name);
      try {
        await page.screenshot({ path: file, animations: 'disabled', timeout: 25000 });
        const { size } = await stat(file);
        // Identical byte length means the view did not move; drop the duplicate.
        if (size === lastSize) {
          await rm(file, { force: true });
          break;
        }
        lastSize = size;
        shots.slices.push(name);
      } catch (e) {
        console.log(`(slice ${name} failed: ${e.message.split('\n')[0]})`);
      }
    }
  }

  /** Reset both scroll axes before a pass. */
  async function resetScroll() {
    await page.evaluate(() => {
      const v = document.querySelector('[data-evidence-vscroll]');
      if (v) v.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);
  }

  // Leading columns (row labels + Total + Customer Pay).
  if (geom.scroller) {
    await page.evaluate(() => {
      const s = document.querySelector('[data-evidence-hscroll]');
      if (s) s.scrollLeft = 0;
    });
  }
  if (!geom.vScroller) {
    await page.evaluate((top) => window.scrollTo(0, Math.max(0, top - 80)), geom.top);
    await page.waitForTimeout(300);
  } else {
    await resetScroll();
  }
  await verticalSlices('left');

  // Scroll right to bring the Warranty / Internal blocks into view. These carry
  // the most important findings, so they need to be visible in the evidence.
  if (geom.scroller) {
    const maxLeft = geom.scroller.scrollWidth - geom.scroller.clientWidth;
    for (const [frac, tag] of [
      [0.5, 'mid'],
      [1.0, 'right'],
    ]) {
      await resetScroll();
      await page.evaluate(
        ({ left }) => {
          const s = document.querySelector('[data-evidence-hscroll]');
          if (s) s.scrollLeft = left;
        },
        { left: Math.round(maxLeft * frac) },
      );
      await page.waitForTimeout(400);
      await verticalSlices(tag);
    }
  }

  // 3. Full page — best effort only.
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(outDir, 'fullpage.png'),
      fullPage: true,
      animations: 'disabled',
      timeout: 60000,
    });
    shots.fullPage = 'fullpage.png';
  } catch {
    console.log('(fullPage screenshot timed out; slices retained as evidence)');
  }

  console.log(`Evidence: ${shots.slices.length} grid slice(s) + viewport${shots.fullPage ? ' + fullpage' : ''}`);
  return shots;
}

async function captureTarget(target) {
  const outDir = target.outDir ?? path.join('artifacts', 'capture', target.key);
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: cfg.headless });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
  });
  const page = await context.newPage();

  /** API traffic — the authoritative numbers behind the screen. */
  const apiCalls = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes(cfg.apiHost)) return;
    const req = res.request();
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;

    const entry = {
      method: req.method(),
      url,
      status: res.status(),
      requestBody: redact(req.postData() ?? null),
      responseBody: null,
      responseError: null,
    };
    try {
      const ct = res.headers()['content-type'] ?? '';
      if (ct.includes('application/json')) {
        entry.responseBody = await res.json();
      } else {
        const t = await res.text();
        entry.responseBody = redact(t.slice(0, 20000));
      }
    } catch (e) {
      entry.responseError = e.message;
    }
    apiCalls.push(entry);
  });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(redact(m.text()));
  });

  const result = {
    target: target.key,
    label: target.label,
    role: target.role,
    capturedAt: new Date().toISOString(),
  };

  try {
    console.log(`\n=== ${target.label} (role: ${target.role}) ===`);
    const auth = await login(page, target.role);
    console.log(`Logged in. Landed: ${auth.landedUrl}`);
    console.log(`Role dropdown: ${JSON.stringify(auth.roleResult)}`);
    result.auth = auth;

    const targetUrl = `${target.base ?? cfg.base}${target.urlPath}`;
    console.log(`Navigating to ${targetUrl} ...`);
    apiCalls.length = 0; // scope the API log to this screen
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
    await waitForData(page);

    result.finalUrl = page.url();
    result.redirected = !page.url().includes(target.urlPath);
    console.log(`Final URL: ${result.finalUrl}${result.redirected ? '  (REDIRECTED)' : ''}`);

    let rendered = await extractRendered(page);

    // An empty extraction almost always means the grid was still rendering. Give it a
    // second chance rather than recording a table-less capture that fails downstream
    // with a confusing "no comparable grid" error.
    if (!rendered.tables.length) {
      console.log('(no tables extracted; waiting 8s and retrying once)');
      await page.waitForTimeout(8000);
      rendered = await extractRendered(page);
    }
    if (!rendered.tables.length) {
      result.warning =
        'No tables were found on this screen. It may render its data without HTML tables, ' +
        'or it may not have finished loading.';
      console.log(`WARNING: ${result.warning}`);
    }

    result.rendered = rendered;
    result.apiCalls = apiCalls.map((c) => ({ ...c }));
    result.consoleErrors = consoleErrors;

    result.screenshots = await captureEvidence(page, outDir);

    await writeFile(path.join(outDir, 'page.html'), redact(await page.content()), 'utf8');
    await context.storageState({ path: path.join('storage-state', `${target.key}.storage.json`) });

    console.log(
      `Rendered: ${rendered.tables.length} table(s), ` +
        `${rendered.tileCount} numeric tile(s), ${rendered.filters.length} filter control(s), ` +
        `${rendered.iframeCount} iframe(s)`,
    );
    for (const t of rendered.tables) {
      console.log(`  table[${t.index}] rows=${t.rowCount} headers=${JSON.stringify(t.headers[0]?.slice(0, 8) ?? [])}`);
    }
    console.log(`API calls captured: ${apiCalls.length}`);
    for (const c of apiCalls) {
      console.log(`  ${c.status} ${c.method} ${c.url.replace(`https://${cfg.apiHost}`, '')}`);
    }
    if (consoleErrors.length) console.log(`Console errors: ${consoleErrors.length}`);
  } catch (err) {
    result.error = redact(err.message);
    console.error(`FAILED: ${err.message}`);
    await page.screenshot({ path: path.join(outDir, 'error.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(outDir, 'page.html'), redact(await page.content()), 'utf8').catch(() => {});
    result.apiCalls = apiCalls;
    result.consoleErrors = consoleErrors;
  } finally {
    await writeFile(path.join(outDir, 'capture.json'), JSON.stringify(result, null, 2), 'utf8');
    await browser.close();
  }

  console.log(`Artifacts -> ${outDir}/`);
  return result;
}

const args = parseArgs(process.argv.slice(2));
const positional = (process.argv[2] ?? '').startsWith('--') ? '' : (process.argv[2] ?? 'both').toLowerCase();

let list;
if (args.url) {
  // Explicit single target, driven by the suite runner.
  const { base, urlPath } = splitUrl(args.url);
  list = [
    {
      key: args.key ?? 'target',
      role: args.role ?? cfg.base,
      base,
      urlPath,
      label: args.label ?? args.key ?? urlPath,
      outDir: args.out,
    },
  ];
  if (!args.role) {
    console.error('--role is required when using --url (e.g. --role AUTOGROUP)');
    process.exit(1);
  }
} else {
  list = positional === 'both' ? [TARGETS.autogroup, TARGETS.dms] : [TARGETS[positional]].filter(Boolean);
  if (!list.length) {
    console.error(`Unknown target "${positional}". Use: autogroup | dms | both, or --url/--role/--key/--out`);
    process.exit(1);
  }
}

await mkdir('storage-state', { recursive: true });

const results = [];
for (const t of list) results.push(await captureTarget(t));

const summaryDir = args.out ? path.dirname(args.out) : path.join('artifacts', 'capture');
await mkdir(summaryDir, { recursive: true });
await writeFile(
  path.join(summaryDir, 'capture-summary.json'),
  JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2),
  'utf8',
);

const failed = results.filter((r) => r.error);
console.log(`\n${results.length - failed.length}/${results.length} screen(s) captured`);
process.exit(failed.length ? 1 : 0);
