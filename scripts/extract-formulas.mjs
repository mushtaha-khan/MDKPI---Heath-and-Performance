/**
 * Extract the authoritative per-cell formulas from the DMS Service Dashboard.
 *
 * The formulas are bound through Angular's [pTooltip] directive, so the text does
 * not exist in the static DOM — PrimeNG builds a `.p-tooltip` element only on hover.
 * This script hovers every tooltip-bearing cell in the metric grid and records the
 * formula against its row label and column position.
 *
 * READ-ONLY with respect to the server. It does tag elements with a temporary
 * data attribute client-side so each one can be addressed reliably; nothing is
 * submitted and no application state is changed.
 *
 * Usage:
 *   node scripts/extract-formulas.mjs probe    # hover a handful, print what we get
 *   node scripts/extract-formulas.mjs full     # sweep every cell, write formulas.json
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';

dotenv.config();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const MODE = (args.mode ?? (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'probe')).toLowerCase();
const OUT = args.out ?? 'artifacts/formulas';

// A full URL wins over the env defaults, so the suite runner can point this at any
// module's screen rather than only the Service dashboard.
const explicit = args.url ? new URL(args.url) : null;

const cfg = {
  base: explicit ? explicit.origin : process.env.KPI_BASE_URL,
  username: process.env.KPI_USERNAME,
  password: process.env.KPI_PASSWORD,
  role: args.role ?? process.env.KPI_ROLE_DEALER ?? 'DEALER',
  urlPath: explicit
    ? `${explicit.pathname}${explicit.search}${explicit.hash}`
    : (process.env.KPI_DMS_PATH ?? '/report/services/dashboard'),
  headless: process.env.KPI_HEADLESS !== 'false',
  navTimeout: Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000),
};

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: cfg.headless });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

// --- login ---
await page.goto(`${cfg.base}/login`, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout });
await page.waitForLoadState('networkidle', { timeout: cfg.navTimeout }).catch(() => {});
await page.locator('input[name="username"]').fill(cfg.username);
await page.locator('input[name="password"]').fill(cfg.password);

const combo = page.locator('p-select').first();
if ((await combo.innerText()).trim().toUpperCase() !== cfg.role.toUpperCase()) {
  await combo.click();
  await page.locator('.p-select-option', { hasText: new RegExp(`^${cfg.role}$`, 'i') }).first().click();
}
await page.locator('input[type="submit"]').click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: cfg.navTimeout });
await page.waitForLoadState('networkidle', { timeout: cfg.navTimeout }).catch(() => {});

// --- open the dashboard ---
console.log(`Opening ${cfg.base}${cfg.urlPath} ...`);
await page.goto(`${cfg.base}${cfg.urlPath}`, {
  waitUntil: 'domcontentloaded',
  timeout: cfg.navTimeout,
});
await page.waitForLoadState('networkidle', { timeout: cfg.navTimeout }).catch(() => {});
await page.waitForTimeout(5000);

/**
 * Tag every tooltip-bearing cell in the metric grid and return its coordinates.
 * Returns [{ id, rowIndex, rowLabel, cellIndex, text }].
 */
const inventory = await page.evaluate(() => {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

  /**
   * Tooltip affordances differ between screens and component versions, so probe for
   * several rather than assuming one. Restricting this to a single PrimeNG attribute
   * on one known grid meant other screens reported "no formulas".
   */
  const isTooltipTarget = (el) =>
    el.hasAttribute('tooltipposition') ||
    el.hasAttribute('ptooltip') ||
    el.hasAttribute('title') ||
    el.hasAttribute('aria-describedby') ||
    el.hasAttribute('data-pc-name') ||
    /\b(info|tooltip|help)\b/i.test(el.className || '') ||
    // A lone icon inside a header cell is the usual "hover me" marker.
    el.querySelector('i,svg,.pi') !== null;

  /** Any element whose static attributes already carry the text. */
  const staticText = (el) =>
    clean(el.getAttribute('title') ?? el.getAttribute('aria-label') ?? '') || null;

  // Consider every visible table, not just one: a module may spread figures over
  // several grids, and each can document its own formulas.
  const tables = [...document.querySelectorAll('table')].filter((t) => {
    const r = t.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && t.querySelectorAll('tbody tr').length > 0;
  });
  if (!tables.length) return { error: 'no visible tables found', cells: [] };

  const cells = [];
  let id = 0;
  let rowTotal = 0;

  tables.forEach((table, tableIndex) => {
    const rows = [...table.querySelectorAll('tbody tr')];
    rowTotal += rows.length;

    rows.forEach((tr, rowIndex) => {
      const labelCell = tr.querySelector('th, td');
      const rowLabel = clean(labelCell?.textContent ?? '');
      if (!rowLabel) return;

      [...tr.children].forEach((cell, cellIndex) => {
        const candidates = [cell, ...cell.querySelectorAll('*')].filter(
          (el) => el.nodeType === 1 && isTooltipTarget(el),
        );
        if (!candidates.length) return;

        // One target per cell is enough; prefer the innermost, which is the icon.
        const target = candidates[candidates.length - 1];
        if (target.hasAttribute('data-tt-id')) return;
        target.setAttribute('data-tt-id', String(id));
        cells.push({
          id,
          tableIndex,
          rowIndex,
          rowLabel,
          cellIndex,
          text: clean(cell.textContent),
          staticFormula: staticText(target),
        });
        id++;
      });
    });
  });

  return { error: null, tableCount: tables.length, rowCount: rowTotal, cells };
});

if (inventory.error) {
  console.error(inventory.error);
  await browser.close();
  process.exit(1);
}

console.log(`Tables scanned: ${inventory.tableCount}, body rows: ${inventory.rowCount}`);
console.log(`Tooltip-bearing cells found: ${inventory.cells.length}`);

/** Hover one tagged element once and read whatever tooltip appears. */
async function hoverOnce(id, settle) {
  const el = page.locator(`[data-tt-id="${id}"]`);
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 5000 });
    // Nudge the pointer away first so re-hovering the same spot re-triggers.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(settle);
    await el.hover({ timeout: 5000, force: true });
  } catch {
    return null;
  }
  const tip = page.locator('.p-tooltip .p-tooltip-text, .p-tooltip-text').first();
  try {
    await tip.waitFor({ state: 'visible', timeout: 2500 });
    const text = (await tip.innerText()).replace(/\s+/g, ' ').trim();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(80);
    return text || null;
  } catch {
    await page.mouse.move(0, 0);
    return null;
  }
}

/**
 * Read a tooltip with retries. PrimeNG tooltips are hover-timing sensitive, so a
 * single miss is not evidence the cell has no formula.
 */
async function readTooltip(id) {
  for (const settle of [80, 250, 600]) {
    const text = await hoverOnce(id, settle);
    if (text) return text;
  }
  return null;
}

const limit = MODE === 'full' ? inventory.cells.length : Math.min(14, inventory.cells.length);
console.log(`\nHovering ${limit} cell(s) (${MODE} mode)...\n`);

/**
 * Distinguish a formula from an ordinary UI tooltip.
 *
 * Broadening the tooltip search picked up plain hints such as "View repair orders",
 * which are not formulas. Treating those as formulas produced a wall of "unresolved"
 * checks that buried the real results. An expression has a space-delimited arithmetic
 * operator; requiring the spaces avoids mistaking a hyphenated label like
 * "Sub-total" for a subtraction.
 */
function looksLikeFormula(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 3) return false;
  return /\s[+\-*/]\s/.test(t);
}

const results = [];
let hits = 0;
let hints = 0;
for (let i = 0; i < limit; i++) {
  const c = inventory.cells[i];
  // A title/aria-label already holds the text; no need to hover for those.
  const tooltip = c.staticFormula ?? (await readTooltip(c.id));
  const formula = looksLikeFormula(tooltip) ? tooltip : null;
  if (formula) hits++;
  else if (tooltip) hints++;
  results.push({ ...c, tooltip, formula });
  if (MODE !== 'full' || formula) {
    console.log(
      `row=${String(c.rowIndex).padStart(3)} col=${String(c.cellIndex).padStart(2)} ` +
        `label="${c.rowLabel.slice(0, 28).padEnd(28)}" value="${c.text.slice(0, 12).padEnd(12)}" ` +
        `-> ${formula ?? (tooltip ? `(hint: ${tooltip.slice(0, 40)})` : '(no tooltip)')}`,
    );
  }
  if (MODE === 'full' && i > 0 && i % 50 === 0) {
    console.log(`  ...${i}/${limit} (${hits} formulas so far)`);
  }
}

console.log(
  `\n${hits}/${limit} cells documented a formula` +
    (hints ? `; ${hints} carried a non-formula tooltip (ignored).` : '.'),
);

await writeFile(
  `${OUT}/formulas.json`,
  JSON.stringify(
    { capturedAt: new Date().toISOString(), mode: MODE, rowCount: inventory.rowCount, results },
    null,
    2,
  ),
  'utf8',
);
console.log(`-> ${OUT}/formulas.json`);

await browser.close();
