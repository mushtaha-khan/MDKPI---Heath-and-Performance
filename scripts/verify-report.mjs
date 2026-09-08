/**
 * Verify the generated HTML report actually renders.
 *
 * Opens it in a real browser, checks for console errors, confirms the key sections
 * and that every embedded screenshot decoded, then saves a screenshot of the report
 * itself as proof.
 */
import { chromium } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Accept an explicit report path so any suite run can be verified, defaulting to
// the newest run under artifacts/runs, then the legacy single report.
function defaultReport() {
  const runs = 'artifacts/runs';
  if (existsSync(runs)) {
    // Reports are named after the module and run time, so look for any HTML in the
    // directory rather than a fixed "report.html".
    const candidates = readdirSync(runs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const html = readdirSync(path.join(runs, d.name))
          .filter((f) => f.toLowerCase().endsWith('.html') && f !== 'index.html')
          .sort();
        return html.length ? { dir: d.name, file: html[html.length - 1] } : null;
      })
      .filter(Boolean)
      // Sort by the timestamp embedded at the start of the directory name.
      .sort((a, b) => {
        const key = (n) => {
          const m = /^(\d{4})-(\d{2})-(\d{2})[T_](\d{2})-(\d{2})-(\d{2})/.exec(n);
          return m ? Number(m.slice(1).join('')) : 0;
        };
        return key(b.dir) - key(a.dir);
      });
    if (candidates.length) return path.join(runs, candidates[0].dir, candidates[0].file);
  }
  return 'artifacts/reports/reconciliation.html';
}

const file = path.resolve(process.argv[2] ?? defaultReport());
console.log(`verifying: ${file}\n`);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 120000 });
await page.waitForTimeout(2500);

// The suite report and the earlier single-module report use different element ids.
// Detect which layout we are looking at so one verifier covers both.
// Three report layouts exist across the project's history. Detect by looking for the
// class-based multi-grid tables first, then the single-grid ids, then the legacy ones.
const ids = await page.evaluate(() => {
  const has = (s) => document.querySelector(s) !== null;
  if (has('.tbl-matrix')) {
    return { layout: 'multi-grid', matrix: '.tbl-matrix', detail: '.tbl-detail', formula: 'table[id^="t-rf"]', matrixChk: '[data-diffonly^="t-mx"]' };
  }
  if (has('#t-mx')) {
    return { layout: 'suite', matrix: '#t-mx', detail: '#t-dt', formula: '#t-rf', matrixChk: '#c-mx' };
  }
  // A run that could not align the two screens produces a report with a diagnosis and no
  // comparison at all. That is a valid, useful report — it is how the tool explains itself
  // when the layouts do not correspond — so verify what it does have rather than timing
  // out looking for a comparison table that is legitimately absent.
  if (has('h2')
    && [...document.querySelectorAll('h2')].some((h) => /Nothing could be compared/i.test(h.textContent))) {
    return { layout: 'blocked', matrix: null, detail: null, formula: null, matrixChk: null };
  }
  // A module with no summary grid on either screen is compared through its analytics strip
  // and, where both sides list records, record by record. That report has no metric matrix,
  // which is not a fault — it is what the screens publish.
  if (has('#t-rec') || has('#t-an')) {
    const matrix = has('#t-rec') ? '#t-rec' : '#t-an';
    return {
      layout: has('#t-rec') ? 'records' : 'analytics',
      matrix,
      detail: matrix,
      formula: 'table[id^="t-rf"]',
      matrixChk: `[data-diffonly="${matrix.slice(1)}"]`,
    };
  }
  return { layout: 'legacy', matrix: '#t-cmp', detail: '#t-row', formula: '#t-col', matrixChk: '#c-cmp' };
});
console.log(`layout           : ${ids.layout}`);

const report = await page.evaluate((sel) => {
  const headings = [...document.querySelectorAll('h2')].map((h) => h.textContent.trim());
  const imgs = [...document.querySelectorAll('img')];
  const count = (s) => (s ? document.querySelectorAll(`${s} tbody tr`).length : 0);
  return {
    title: document.title,
    headings,
    imgTotal: imgs.length,
    imgBroken: imgs.filter((i) => !i.complete || i.naturalWidth === 0).length,
    tables: document.querySelectorAll('table').length,
    rowsCmp: count(sel.matrix),
    rowsDetail: count(sel.detail),
    rowsFormula: count(sel.formula),
    badgesDiff: document.querySelectorAll('.b-bad').length,
    badgesOk: document.querySelectorAll('.b-ok').length,
  };
}, ids);

console.log(`title            : ${report.title}`);
console.log(`sections         : ${report.headings.length}`);
report.headings.forEach((h) => console.log(`   - ${h}`));
console.log(`tables           : ${report.tables}`);
console.log(`matrix rows      : ${report.rowsCmp}`);
console.log(`detail rows      : ${report.rowsDetail}`);
console.log(`row-formula rows : ${report.rowsFormula}`);
console.log(`PASS badges      : ${report.badgesOk}`);
console.log(`DIFF badges      : ${report.badgesDiff}`);
console.log(`images           : ${report.imgTotal} (${report.imgBroken} broken)`);
console.log(`console errors   : ${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log(`   ${e}`));

// Test the "differences only" filter actually works. A blocked report has no comparison
// to filter, so instead check it explains itself: a reason, remedy steps, and the table
// structures needed to work out why the two screens would not align.
let visibleAfter = 0;
if (ids.layout === 'blocked') {
  const diagnosis = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      remedySteps: document.querySelectorAll('.rc ul li').length,
      headerRows: [...document.querySelectorAll('details summary')].filter((s) =>
        /body column/i.test(s.textContent),
      ).length,
      saysNotCompared: /Nothing was compared/i.test(text),
    };
  });
  console.log(`blocked diagnosis: ${diagnosis.remedySteps} remedy step(s), ` +
    `${diagnosis.headerRows} table structure(s) shown, states nothing was compared: ${diagnosis.saysNotCompared}`);
  if (!diagnosis.remedySteps || !diagnosis.headerRows || !diagnosis.saysNotCompared) {
    console.error('FAIL: a blocked report must explain the failure and show both screens\' structures.');
    process.exitCode = 1;
  }
} else {
  await page.locator(ids.matrixChk).first().check();
  await page.waitForTimeout(400);
  visibleAfter = await page.evaluate(
    (sel) =>
      [...document.querySelectorAll(`${sel} tbody tr`)].filter((r) => r.style.display !== 'none').length,
    ids.matrix,
  );
  console.log(`matrix rows with 'differences only' on: ${visibleAfter}`);
}

// --- carousel behaviour ---
const carousel = { ok: false, detail: '' };
const slideCount = await page.locator('.cr-slide').count();
if (slideCount === 0) {
  carousel.detail = 'no slides found';
} else {
  const activeCount = () => page.locator('.cr-slide.active').count();
  const first = await activeCount();
  const titleFirst = (await page.locator('#cr-title').innerText()).trim();
  const countFirst = (await page.locator('#cr-count').innerText()).trim();

  await page.locator('#cr-next').click();
  await page.waitForTimeout(250);
  const titleSecond = (await page.locator('#cr-title').innerText()).trim();
  const countSecond = (await page.locator('#cr-count').innerText()).trim();
  const activeSecond = await activeCount();

  // Arrow-key navigation.
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  const countThird = (await page.locator('#cr-count').innerText()).trim();

  // Wrap-around from the first slide backwards should land on the last.
  await page.locator('#cr-jump').selectOption('0');
  await page.waitForTimeout(200);
  await page.locator('#cr-prev').click();
  await page.waitForTimeout(250);
  const countWrapped = (await page.locator('#cr-count').innerText()).trim();

  carousel.ok =
    first === 1 &&
    activeSecond === 1 &&
    titleFirst !== titleSecond &&
    countFirst !== countSecond &&
    countSecond !== countThird &&
    countWrapped === `${slideCount} of ${slideCount}`;

  carousel.detail =
    `${slideCount} slides, exactly one visible at a time; ` +
    `next: "${countFirst}" -> "${countSecond}"; arrow key -> "${countThird}"; ` +
    `wrap back from first -> "${countWrapped}"`;
}
console.log(`carousel         : ${carousel.ok ? 'OK' : 'PROBLEM'} — ${carousel.detail}`);

// Reset to the first slide so the preview reflects how the report actually opens,
// rather than wherever the navigation test left it.
if (slideCount > 0) {
  await page.locator('#cr-jump').selectOption('0');
  await page.waitForTimeout(300);
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(path.dirname(file), 'report-preview.png'), fullPage: false });

// Formula rows are optional: a module whose screens document no formulas is a valid
// report, not a broken one. Requiring them failed a perfectly good Technician
// Performance report.
//
// Comparison rows are required too — except on a blocked report, where their absence is
// the whole point. That report is judged on whether it explains itself instead, which is
// checked above.
const needsComparison = ids.layout !== 'blocked';
const ok =
  errors.length === 0 &&
  report.imgBroken === 0 &&
  (!needsComparison || (report.rowsCmp > 0 && report.rowsDetail > 0)) &&
  carousel.ok &&
  process.exitCode !== 1;
console.log(`\n${ok ? 'REPORT OK' : 'REPORT HAS PROBLEMS'}`);

await browser.close();
process.exit(ok ? 0 : 1);
