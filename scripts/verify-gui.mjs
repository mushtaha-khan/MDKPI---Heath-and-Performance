/**
 * End-to-end check of the GUI control panel.
 *
 * Drives the real page in a browser: fills the form, launches a run with the
 * "reuse captures" option so it completes in seconds without hitting the portal,
 * waits for the result banner, then follows the report link and confirms the report
 * renders. Also checks the runs table populates and that path traversal is refused.
 *
 * Usage: node scripts/verify-gui.mjs [port]
 */
import { chromium } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
// Needed for the first-run fallback below, which reads the tenant URL from .env rather than
// carrying a customer's hostname in source.
import 'dotenv/config';

const PORT = process.argv[2] ?? '5173';
const BASE = `http://localhost:${PORT}`;

/** Module name used only by this check, so its run is identifiable and removable. */
const VERIFY_MODULE = 'ZZ Verification Check';

const checks = [];
function record(name, passed, detail = '') {
  checks.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ->  ${detail}` : ''}`);
}

/** Remove the run this check created, so the report history stays the user's own. */
async function cleanupVerificationRuns() {
  const root = 'artifacts/runs';
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const metaPath = path.join(dir, 'meta.json');
    let isVerification = name.toLowerCase().includes('zz-verification');
    if (!isVerification && existsSync(metaPath)) {
      try {
        isVerification = JSON.parse(readFileSync(metaPath, 'utf8')).moduleName === VERIFY_MODULE;
      } catch {
        /* unreadable meta; leave it alone */
      }
    }
    if (isVerification) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

try {
  // --- API surface ---
  const api = await (await fetch(`${BASE}/api/status`)).json();
  record('GET /api/status', typeof api.running === 'boolean', `running=${api.running}`);

  const runsBefore = await (await fetch(`${BASE}/api/runs`)).json();
  record('GET /api/runs', Array.isArray(runsBefore), `${runsBefore.length} existing run(s)`);

  // Traversal must be refused by the static handler.
  const trav = await fetch(`${BASE}/runs/../../.env`);
  record('path traversal refused', trav.status === 403 || trav.status === 404, `HTTP ${trav.status}`);

  // --- the page itself ---
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  record('control panel loads', (await page.title()).includes('Reconciliation'), await page.title());

  for (const id of ['#ag', '#dms', '#mod', '#agRole', '#dmsRole', '#run']) {
    record(`field present: ${id}`, (await page.locator(id).count()) === 1);
  }

  record(
    'runs table populated',
    (await page.locator('#runs tr').count()) >= 1,
    `${await page.locator('#runs tr').count()} row(s)`,
  );

  // --- validation blocks an empty submit ---
  await page.locator('#run').click();
  await page.waitForTimeout(400);
  const agErrVisible = await page.locator('#ag-err.show').count();
  record('empty form is rejected', agErrVisible === 1, await page.locator('#ag-err').innerText());

  // --- pick captures that are known to produce a comparison ---
  //
  // "Reuse the newest captures" made this check depend on whatever else was on disk: a run
  // of an unrelated module whose screens do not align left the verification reporting zero
  // compared cells, which looks like a regression and is nothing of the kind. So pin the
  // reuse to a specific earlier run that did compare something, and borrow its URLs.
  const reusable = runsBefore.find((r) => (r.cells?.total ?? 0) > 0 && r.autogroupUrl && r.dmsUrl);

  /**
   * URLs to test with.
   *
   * Normally borrowed from an earlier run, which keeps this check independent of any
   * particular tenant. The fallback, used only on a first run with no history, comes from
   * .env — the tenant hostname is a customer's, so it does not belong in source.
   */
  const base = (process.env.KPI_BASE_URL ?? '').replace(/\/$/, '');
  const agUrl =
    reusable?.autogroupUrl ??
    (base ? `${base}${process.env.KPI_AUTOGROUP_PATH ?? '/auto-group-v2/service/service-summary'}` : '');
  const dmsUrl =
    reusable?.dmsUrl ??
    (base ? `${base}${process.env.KPI_DMS_PATH ?? '/report/services/dashboard'}` : '');

  if (!agUrl || !dmsUrl) {
    record(
      'URLs available to test with',
      false,
      'No previous run to borrow URLs from, and KPI_BASE_URL is not set in .env.',
    );
    throw new Error('Set KPI_BASE_URL in .env, or run one comparison from the panel first.');
  }

  await page.locator('#ag').fill(agUrl);
  await page.locator('#dms').fill(dmsUrl);
  await page.locator('#mod').fill(VERIFY_MODULE);
  await page.locator('details.adv').click(); // expand advanced

  if (reusable) {
    await page.locator('#reuse').check();
    // Pin the exact run through the panel's own capture picker, so the result does not
    // change when someone runs a different module in between.
    await page.locator('#reuse-from').selectOption(reusable.runId);
    record(
      'capture picker pins a specific run',
      (await page.locator('#reuse-from').inputValue()) === reusable.runId,
      `${reusable.moduleName} — ${reusable.runId}`,
    );
  } else {
    console.log('      (no prior run produced a comparison — full crawl, this takes a few minutes)');
  }
  await page.waitForTimeout(200);

  await page.locator('#run').click();
  record('run started', true);

  // The banner appears when the run finishes.
  await page.locator('#banner.show').waitFor({ state: 'visible', timeout: 180000 });
  const bannerText = (await page.locator('#banner').innerText()).replace(/\s+/g, ' ').trim();

  // A run that finds differences is a SUCCESSFUL run — the banner is red but a report
  // exists. Only the absence of a report link means the run actually failed.
  const hasReportLink = (await page.locator('#banner a').count()) > 0;
  const cleanRun = (await page.locator('#banner.ok').count()) > 0;
  record('run completed', hasReportLink, bannerText.slice(0, 110));
  record(
    'verdict reported',
    /difference|No differences/i.test(bannerText),
    cleanRun ? 'clean' : 'differences found (expected on live data)',
  );

  const logText = await page.locator('#log').innerText();
  record('live log streamed', logText.length > 200, `${logText.length} chars`);
  record(
    'stages advanced',
    (await page.locator('.stage.done').count()) > 0,
    `${await page.locator('.stage.done').count()} done`,
  );

  // --- follow the report link ---
  const href = await page.locator('#banner a').first().getAttribute('href');
  record('report link present', Boolean(href), href ?? '');

  if (href) {
    const reportPage = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    const rErrors = [];
    reportPage.on('pageerror', (e) => rErrors.push(String(e)));
    await reportPage.goto(new URL(href, BASE).href, { waitUntil: 'load', timeout: 120000 });
    await reportPage.waitForTimeout(1500);

    const info = await reportPage.evaluate(() => {
      // Multi-grid reports use classes; older single-grid ones used fixed ids. A module with
      // no summary grid on either screen has neither: it is compared through its analytics
      // strip and, where both sides list records, record by record. Requiring a metric matrix
      // failed such a report for not containing something the screens never published.
      const matrixSel = document.querySelector('.tbl-matrix')
        ? '.tbl-matrix'
        : document.querySelector('#t-mx')
          ? '#t-mx'
          : document.querySelector('#t-rec')
            ? '#t-rec'
            : '#t-an';
      const detailSel = document.querySelector('.tbl-detail') ? '.tbl-detail' : '#t-dt';
      return {
        title: document.title,
        slides: document.querySelectorAll('.cr-slide').length,
        grids: document.querySelectorAll('.tbl-matrix').length || 1,
        matrix: document.querySelectorAll(`${matrixSel} tbody tr`).length,
        detail: document.querySelectorAll(`${detailSel} tbody tr`).length,
        brokenImgs: [...document.querySelectorAll('img')].filter(
          (i) => !i.complete || i.naturalWidth === 0,
        ).length,
      };
    });
    record('report opens from GUI', info.matrix > 0 && info.detail > 0,
      `${info.grids} grid(s), ${info.matrix} matrix rows, ${info.detail} detail rows, ${info.slides} slides`);
    record('report images intact', info.brokenImgs === 0, `${info.brokenImgs} broken`);
    record('report has no JS errors', rErrors.length === 0, rErrors.slice(0, 2).join(' | '));
    await reportPage.close();
  }

  // --- the new run appears in the table ---
  await page.waitForTimeout(600);
  const runsAfter = await (await fetch(`${BASE}/api/runs`)).json();
  record('run recorded in history', runsAfter.length >= runsBefore.length,
    `${runsBefore.length} -> ${runsAfter.length}`);
  record('newest run has metadata', Boolean(runsAfter[0]?.cells && runsAfter[0]?.moduleName),
    `${runsAfter[0]?.moduleName}: ${runsAfter[0]?.cells?.matched}/${runsAfter[0]?.cells?.total} matched`);
  record('run is tagged as a GUI run', runsAfter[0]?.source === 'gui', `source=${runsAfter[0]?.source}`);
  // Expected shape: "<Module Name> - AutoGroup vs DMS - DD-MM-YYYY h.mm AM/PM.html"
  const reportFile = runsAfter[0]?.reportFile ?? '';
  const moduleName = runsAfter[0]?.moduleName ?? '';
  record(
    'report filename carries module + date',
    reportFile.startsWith(`${moduleName} - AutoGroup vs DMS - `) &&
      /\d{2}-\d{2}-\d{4} \d{1,2}\.\d{2} (AM|PM)\.html$/.test(reportFile),
    reportFile,
  );

  // Dates and times shown to the user: DD-MM-YYYY on a 12-hour clock, no seconds.
  const shownWhen = runsAfter[0]?.when ?? '';
  record(
    'history shows DD-MM-YYYY and 12-hour time',
    /^\d{2}-\d{2}-\d{4} \d{1,2}:\d{2} (AM|PM)$/.test(shownWhen),
    shownWhen,
  );

  // --- soft delete and restore, driven from the page ---
  const targetRun = runsAfter[0]?.runId;
  if (targetRun) {
    await page.locator(`#runs tr[data-run="${targetRun}"] button[data-del]`).click();
    await page.waitForTimeout(700);

    const afterDelete = await (await fetch(`${BASE}/api/runs`)).json();
    record(
      'delete removes the report from the list',
      !afterDelete.some((r) => r.runId === targetRun),
      `${runsAfter.length} -> ${afterDelete.length}`,
    );

    const deletedList = await (await fetch(`${BASE}/api/runs?deleted=deleted`)).json();
    const deletedEntry = deletedList.find((r) => r.runId === targetRun);
    record('deleted report is listed as deleted', Boolean(deletedEntry), `${deletedList.length} deleted`);
    record(
      'deletion time is shown in the same format',
      /^\d{2}-\d{2}-\d{4} \d{1,2}:\d{2} (AM|PM)$/.test(deletedEntry?.deletedWhen ?? ''),
      deletedEntry?.deletedWhen ?? '',
    );

    // Soft, not hard: everything must still be on disk.
    record(
      'delete is soft — the run directory survives',
      existsSync(path.join('artifacts/runs', targetRun, 'meta.json')),
      path.join('artifacts/runs', targetRun),
    );
    record(
      'and so does the report itself',
      existsSync(path.join('artifacts/runs', targetRun, reportFile)),
      reportFile,
    );

    // The deleted report must still open, or "restore" would be a promise the tool cannot keep.
    const stillServed = await fetch(
      `${BASE}/runs/${encodeURIComponent(targetRun)}/${encodeURIComponent(reportFile)}`,
    );
    record('a deleted report can still be opened', stillServed.status === 200, `HTTP ${stillServed.status}`);

    // Undo from the status line.
    await page.locator('button[data-undo]').first().click();
    await page.waitForTimeout(700);
    const afterUndo = await (await fetch(`${BASE}/api/runs`)).json();
    record(
      'undo restores the report',
      afterUndo.some((r) => r.runId === targetRun),
      `${afterUndo.length} active`,
    );

    // Restore from the deleted table too.
    await page.locator(`#runs tr[data-run="${targetRun}"] button[data-del]`).click();
    await page.waitForTimeout(700);
    await page.locator('#toggle-deleted').click();
    await page.waitForTimeout(400);
    record('deleted section reveals the report', (await page.locator('#deleted-runs tr[data-run]').count()) >= 1);
    await page.locator(`#deleted-runs tr[data-run="${targetRun}"] button[data-restore]`).click();
    await page.waitForTimeout(700);
    const afterRestore = await (await fetch(`${BASE}/api/runs`)).json();
    record('restore button brings it back', afterRestore.some((r) => r.runId === targetRun));

    // A crafted run id must be refused rather than sanitised.
    const evil = await fetch(`${BASE}/api/runs/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: '../../..' }),
    });
    record('delete refuses a traversal id', evil.status === 404, `HTTP ${evil.status}`);
  }

  record('control panel has no JS errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  await page.screenshot({ path: 'artifacts/gui-preview.png', fullPage: false });
} catch (err) {
  record('fatal', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
}

// Leave no trace: the report history should contain only the user's own runs.
const removed = await cleanupVerificationRuns();
console.log(`\ncleanup: removed ${removed} verification run(s)`);

const failed = checks.filter((c) => !c.passed);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
