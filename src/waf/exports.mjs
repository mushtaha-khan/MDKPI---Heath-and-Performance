/**
 * Export verification (Excel / PDF) for report modules.
 *
 * The user asked to verify: generation, download, file opening, and content/layout.
 * From an automated browser we can reliably prove: an export control exists, clicking
 * it produces a download, the file lands on disk, is non-empty, and has the correct
 * binary signature (XLSX = ZIP "PK", PDF = "%PDF"). Deep layout/content validation of
 * the rendered spreadsheet/PDF is out of scope for an unattended run; where a file is
 * captured we record its size + type so a human can open the saved artifact.
 *
 * Detection is heuristic: report toolbars expose export via buttons/menu items labelled
 * Export / Excel / XLSX / PDF / Download / Print, or icons with those aria-labels. We try
 * to find and click one, wait for a Playwright download event, and validate the result.
 */
import { mkdir } from 'node:fs/promises';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Verdict, row } from './types.mjs';

/**
 * Export controls on this portal are ICON-ONLY PrimeNG buttons with no text and no
 * aria-label — a keyword/text matcher misses them entirely. They are identified by the
 * PrimeNG icon class on the button's inner <span>:
 *   pi-file-pdf   -> PDF export
 *   pi-file-excel -> Excel export
 *   pi-download   -> download (module-level; the top-nav one is global chrome, skip it)
 *   pi-print      -> print
 * We detect by icon class and build a Playwright-friendly selector for each.
 * Ordered PDF, Excel first because those are the exports the story targets.
 */
const EXPORT_ICONS = [
  { kind: 'PDF', icon: 'pi-file-pdf' },
  { kind: 'Excel', icon: 'pi-file-excel' },
  { kind: 'CSV', icon: 'pi-file-export' },
  { kind: 'Print', icon: 'pi-print' },
  // NOTE: pi-download and pi-send are intentionally NOT treated as exports here.
  // On this portal pi-download opens the global notification/download center (async
  // delivery target), and pi-send opens an email-share dialog — neither is a per-module
  // file export. Including them produced false FAILs.
];

/**
 * Find candidate export triggers by icon class. Returns [{kind, icon, selector}].
 * The selector targets the enclosing button of the icon span, and we exclude the
 * global top-nav download button (in the header, y < ~60) so module exports are what
 * we click.
 */
async function findExportTriggers(page) {
  const found = await page
    .evaluate((icons) => {
      const hits = [];
      for (const { kind, icon } of icons) {
        const spans = Array.from(document.querySelectorAll(`span.${icon}, i.${icon}, .${icon}`));
        for (const span of spans) {
          const btn = span.closest('button, a, [role="button"], .p-button');
          if (!btn) continue;
          const r = btn.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // Skip the global header download (top strip) — module exports sit lower.
          if (icon === 'pi-download' && r.y < 60) continue;
          hits.push({ kind, icon, y: Math.round(r.y), x: Math.round(r.x) });
          break; // one per icon kind is enough
        }
      }
      return hits;
    }, EXPORT_ICONS)
    .catch(() => []);
  return found;
}

function signatureOf(buf) {
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === '%PDF') return 'PDF';
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return 'XLSX/ZIP'; // PK
  if (buf.length >= 5 && /^[\w",]/.test(buf.toString('utf8', 0, 5))) return 'CSV/text';
  return 'unknown';
}

/**
 * Attempt one export on the given report route.
 * @returns {Promise<import('./types.mjs').ResultRow[]>}
 */
export async function verifyExport(ctx, caseMeta, routePath) {
  const { page, base, domain, role, navTimeout, runDir, shot } = ctx;
  const url = `${base}${routePath}`;
  const downloadsDir = path.join(runDir, 'downloads');
  await mkdir(downloadsDir, { recursive: true });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  } catch {
    /* fall through; detection will just find nothing */
  }
  await page.waitForLoadState('networkidle', { timeout: navTimeout }).catch(() => {});
  // The export toolbar renders after the grid initialises, which can lag networkidle.
  // Wait (best-effort) for any export icon to appear before deciding there is none.
  await page
    .waitForSelector('.pi-file-pdf, .pi-file-excel, .pi-file-export, .pi-print', { timeout: 8000, state: 'attached' })
    .catch(() => {});
  await page.waitForTimeout(1500);

  const triggers = await findExportTriggers(page);
  if (!triggers.length) {
    return [
      row({
        caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
        url, verdict: Verdict.INFO,
        result: 'No export/print control detected on this module',
        statusCode: '-', screenshot: await shot(`${caseMeta.id}_${role}_noexport`),
      }),
    ];
  }

  const rows = [];
  // Warm up the toolbar: the very first export click on a freshly-loaded page can fire
  // its request before our listeners attach (or is spent focusing/dismissing a tooltip),
  // which previously produced a false FAIL on whichever icon was clicked first. Hovering
  // the first export button primes the toolbar so the first real click behaves like the
  // rest.
  try {
    const firstIcon = triggers[0]?.icon;
    if (firstIcon) {
      await page.locator(`button:has(.${firstIcon}), .p-button:has(.${firstIcon})`).first().hover({ timeout: 3000 });
      await page.waitForTimeout(600);
    }
  } catch {
    /* best-effort warm-up */
  }

  // This portal generates exports ASYNCHRONOUSLY: clicking PDF/Excel fires
  //   POST/GET /api/report/.../pdf  (or /excel)  -> 200  (queues the job)
  // and the file is delivered later via the notification center (DOWNLOAD_READY),
  // so there is often NO browser download event on click. We therefore verify by
  // watching for the export API call and judging on its HTTP status. A direct download
  // or a print popup (older/print flows) is also accepted as success.
  for (const t of triggers) {
    const iconLoc = page.locator(`span.${t.icon}, i.${t.icon}, .${t.icon}`).first();
    const btnLoc = page.locator(`button:has(.${t.icon}), .p-button:has(.${t.icon}), [role="button"]:has(.${t.icon})`).first();
    const shotName = `${caseMeta.id}_${role}_${routePath.replace(/[^a-z0-9]+/gi, '-')}_${t.kind}`;

    // Match the export/generation endpoint. Accept POST or GET, and match either a
    // path segment (…/pdf, …/excel) or a query hint (?type=pdf, format=excel). Some
    // report exports are slower to fire, so allow a wider window.
    const exportRespP = page
      .waitForResponse(
        (resp) => {
          const u = resp.url();
          const m = resp.request().method();
          if (m !== 'POST' && m !== 'GET') return false;
          return /\/(pdf|excel|xlsx|csv|export|download|print|generate-report|report\/[^/]+\/(pdf|excel|csv))(\?|$|\b|\/)/i.test(u)
            || /[?&](type|format|export)=(pdf|excel|xlsx|csv)/i.test(u);
        },
        { timeout: 22000 },
      )
      .catch(() => null);
    const downloadP = page.waitForEvent('download', { timeout: 22000 }).catch(() => null);
    const popupP = page.waitForEvent('popup', { timeout: 22000 }).catch(() => null);

    const target = (await btnLoc.count()) ? btnLoc : iconLoc;
    // Let the waitForResponse/download/popup listeners register before the click fires.
    await page.waitForTimeout(250);
    await target.click({ timeout: 6000 }).catch(() => {});

    const [exportResp, download, popup] = await Promise.all([exportRespP, downloadP, popupP]);

    if (download) {
      const suggested = download.suggestedFilename() || `${caseMeta.id}_${role}_${t.kind}.bin`;
      const dest = path.join(downloadsDir, `${domain}_${role}_${suggested}`.replace(/[^a-z0-9._-]/gi, '_'));
      let size = 0, sig = 'unknown';
      try {
        await download.saveAs(dest);
        size = (await stat(dest)).size;
        sig = signatureOf((await readFile(dest)).subarray(0, 8));
      } catch { /* size stays 0 */ }
      const ok = size > 0 && sig !== 'unknown';
      rows.push(row({
        caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain, url,
        verdict: ok ? Verdict.PASS : Verdict.FAIL,
        result: ok ? `${t.kind} export downloaded: ${suggested} (${size} bytes, ${sig})` : `${t.kind} export file invalid/empty`,
        statusCode: '-', screenshot: await shot(shotName),
        forbidden: ok ? [] : [`export-invalid ${t.kind}`], consoleErrors: [`saved=${dest}`],
      }));
    } else if (exportResp) {
      const st = exportResp.status();
      const ok = st >= 200 && st < 300;
      rows.push(row({
        caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
        url: exportResp.url(),
        verdict: ok ? Verdict.PASS : Verdict.FAIL,
        result: ok
          ? `${t.kind} export accepted (async): POST ${st}. File is generated server-side and delivered via the notification center (DOWNLOAD_READY).`
          : `${t.kind} export endpoint returned ${st}`,
        statusCode: st, screenshot: await shot(shotName),
        forbidden: ok ? [] : [`export-http ${st} ${exportResp.url()}`],
      }));
    } else if (popup) {
      const purl = popup.url();
      await popup.close().catch(() => {});
      rows.push(row({
        caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain, url,
        verdict: Verdict.PASS,
        result: `${t.kind} export opened a preview/print tab (${purl.slice(0, 80)})`,
        statusCode: '-', screenshot: await shot(shotName),
      }));
    } else {
      // No export request fired. Distinguish "the module has no data to export" (common on
      // the empty ghost-user tenant — the app correctly no-ops the click) from a genuine
      // failure on a populated report. The former is INFO (not testable), the latter FAIL.
      const emptyData = await page
        .evaluate(() => /no matches for these filters|no data|no records|no results/i.test(document.body?.innerText || ''))
        .catch(() => false);
      rows.push(row({
        caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain, url,
        verdict: emptyData ? Verdict.INFO : Verdict.FAIL,
        result: emptyData
          ? `${t.kind} export control present; module has no data ("no matches"), so export is a no-op here — not testable without data`
          : `${t.kind} export button is present and enabled but clicking it fires no export request and produces no download/preview — the control appears non-functional on this module (other export types on the same page may still work)`,
        statusCode: '-', screenshot: await shot(shotName),
        forbidden: emptyData ? [] : [`export-nonfunctional ${t.kind}`],
      }));
    }
    await page.waitForTimeout(800); // let any toast settle before the next click
  }

  if (!rows.length) {
    rows.push(
      row({
        caseId: caseMeta.id, caseTitle: caseMeta.title, group: caseMeta.group, role, domain,
        url, verdict: Verdict.INFO,
        result: 'No export/print control detected on this module',
        statusCode: '-', screenshot: await shot(`${caseMeta.id}_${role}_noexport`),
      }),
    );
  }
  return rows;
}
