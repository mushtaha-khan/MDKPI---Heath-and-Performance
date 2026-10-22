/**
 * Reporter: turns ResultRows into the three deliverables —
 * a self-contained HTML report (screenshots inlined), a CSV, and an XLSX.
 *
 * Columns: TestCase, DealerName, Domain, Role, URL, Result, StatusCode, Screenshot.
 * DealerName sits before Role so it is immediately clear which dealer/tenant a row is for.
 *
 * HTML extras:
 *  - Pass / Fail / All (+ Blocked/Info/Manual) filter buttons at the top that show/hide
 *    rows in place without losing screenshot/evidence detail.
 *  - Every screenshot is clickable and opens in a full-size, zoomable lightbox.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { Verdict } from './types.mjs';
import { dealerName } from './dealers.mjs';

const COLUMNS = ['TestCase', 'DealerName', 'Domain', 'Role', 'URL', 'Result', 'StatusCode', 'Screenshot'];

function testCaseLabel(r) {
  return `${r.caseId} — ${r.caseTitle}`;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeCsv(rows, outPath, names) {
  const lines = [COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        testCaseLabel(r),
        dealerName(r.domain, names),
        r.domain,
        r.role,
        r.url,
        `${r.verdict}: ${r.result}`,
        r.statusCode,
        r.screenshot ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  await writeFile(outPath, lines.join('\n'), 'utf8');
}

export async function writeXlsx(rows, outPath, meta, names) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MDKPI-7508 WAF runner';
  wb.created = new Date();

  const ws = wb.addWorksheet('WAF Results');
  ws.columns = [
    { header: 'TestCase', key: 'tc', width: 40 },
    { header: 'DealerName', key: 'dealer', width: 20 },
    { header: 'Domain', key: 'domain', width: 26 },
    { header: 'Role', key: 'role', width: 12 },
    { header: 'URL', key: 'url', width: 60 },
    { header: 'Result', key: 'result', width: 56 },
    { header: 'StatusCode', key: 'status', width: 12 },
    { header: 'Screenshot', key: 'shot', width: 40 },
  ];
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  const colorFor = (v) =>
    v === Verdict.PASS ? 'FFDCFCE7'
      : v === Verdict.FAIL ? 'FFFEE2E2'
      : v === Verdict.BLOCKED ? 'FFDBEAFE'
      : v === Verdict.MANUAL ? 'FFF3F4F6'
      : 'FFFEF9C3';

  for (const r of rows) {
    const added = ws.addRow({
      tc: testCaseLabel(r),
      dealer: dealerName(r.domain, names),
      domain: r.domain,
      role: r.role,
      url: r.url,
      result: `${r.verdict}: ${r.result}`,
      status: r.statusCode,
      shot: r.screenshot ?? '',
    });
    added.getCell('result').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorFor(r.verdict) } };
  }
  ws.autoFilter = { from: 'A1', to: 'H1' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const sum = wb.addWorksheet('Summary');
  sum.addRow(['MDKPI-7508 — WAF Post-Enablement Regression']);
  sum.addRow(['Run', meta.runId]);
  sum.addRow(['Mode', meta.mode]);
  sum.addRow(['Tenant(s)', meta.domains.join(', ')]);
  sum.addRow(['Generated', new Date().toISOString()]);
  sum.addRow([]);
  const counts = tally(rows);
  sum.addRow(['Verdict', 'Count']);
  for (const [k, v] of Object.entries(counts)) sum.addRow([k, v]);
  sum.getRow(1).font = { bold: true, size: 14 };

  await wb.xlsx.writeFile(outPath);
}

function tally(rows) {
  const c = { PASS: 0, FAIL: 0, BLOCKED: 0, INFO: 0, MANUAL: 0 };
  for (const r of rows) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
  return c;
}

async function inlineImg(runDir, rel) {
  if (!rel) return null;
  try {
    const buf = await readFile(path.join(runDir, rel));
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function writeHtml(rows, outPath, meta, runDir, names) {
  const counts = tally(rows);
  const badge = (v) => `<span class="badge ${v.toLowerCase()}">${v}</span>`;

  const byCase = new Map();
  for (const r of rows) {
    if (!byCase.has(r.caseId)) byCase.set(r.caseId, []);
    byCase.get(r.caseId).push(r);
  }

  const sections = [];
  for (const [caseId, group] of byCase) {
    const head = group[0];
    const bodyRows = [];
    for (const r of group) {
      const img = await inlineImg(runDir, r.screenshot);
      // Clickable thumbnail that opens the full-size zoomable lightbox.
      const thumb = img
        ? `<img class="thumb" src="${img}" alt="${escapeHtml(r.caseId)}" onclick="openLightbox(this.src)"/>`
        : '<span class="muted">—</span>';
      const forbidden = (r.forbidden ?? []).length
        ? `<div class="forbidden">${r.forbidden.map((f) => `<code>${escapeHtml(f)}</code>`).join('<br>')}</div>`
        : '';
      // data-verdict drives the Pass/Fail/All filtering.
      bodyRows.push(`<tr class="v-${r.verdict.toLowerCase()}" data-verdict="${r.verdict}">
        <td>${badge(r.verdict)}</td>
        <td class="dealer">${escapeHtml(dealerName(r.domain, names))}</td>
        <td class="domain">${escapeHtml(r.domain)}</td>
        <td>${escapeHtml(r.role)}</td>
        <td class="url">${escapeHtml(r.url)}</td>
        <td>${escapeHtml(r.result)}${forbidden}</td>
        <td class="status">${escapeHtml(String(r.statusCode))}</td>
        <td>${thumb}</td>
      </tr>`);
    }
    sections.push(`<section data-case="${escapeHtml(caseId)}">
      <h2>${escapeHtml(caseId)} — ${escapeHtml(head.caseTitle)} <span class="grp">${escapeHtml(head.group)}</span></h2>
      <table class="rows">
        <thead><tr><th>Result</th><th>Dealer Name</th><th>Domain</th><th>Role</th><th>URL</th><th>Detail</th><th>Status</th><th>Screenshot</th></tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table>
    </section>`);
  }

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MDKPI-7508 WAF Regression — ${escapeHtml(meta.runId)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; margin: 0; background:#f8fafc; color:#0f172a; }
  header { background:#0f172a; color:#fff; padding:20px 28px; }
  header h1 { margin:0 0 4px; font-size:18px; }
  header .meta { color:#94a3b8; font-size:13px; }
  .summary { display:flex; gap:10px; padding:16px 28px; flex-wrap:wrap; background:#fff; border-bottom:1px solid #e2e8f0; position:sticky; top:0; z-index:5; align-items:center; }
  .card { padding:8px 14px; border-radius:8px; font-weight:600; border:2px solid transparent; cursor:pointer; user-select:none; }
  .card.pass{background:#dcfce7;color:#166534}.card.fail{background:#fee2e2;color:#991b1b}
  .card.blocked{background:#dbeafe;color:#1e40af}.card.info{background:#fef9c3;color:#854d0e}.card.manual{background:#f3f4f6;color:#374151}
  .card.all{background:#0f172a;color:#fff}
  .card.active { outline:3px solid #0ea5e9; outline-offset:1px; }
  .filters-label { font-size:12px; color:#64748b; margin-right:4px; }
  main { padding: 8px 28px 60px; }
  section { background:#fff; border:1px solid #e2e8f0; border-radius:10px; margin:16px 0; overflow:hidden; }
  section.hidden { display:none; }
  section h2 { font-size:15px; margin:0; padding:12px 16px; background:#f1f5f9; border-bottom:1px solid #e2e8f0; }
  section h2 .grp { float:right; font-weight:400; color:#64748b; font-size:12px; }
  table.rows { width:100%; border-collapse:collapse; }
  table.rows th, table.rows td { text-align:left; padding:8px 12px; border-bottom:1px solid #f1f5f9; vertical-align:top; }
  table.rows th { font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:.03em; }
  td.url { max-width:360px; word-break:break-all; font-family:ui-monospace,monospace; font-size:12px; }
  td.dealer { font-weight:600; white-space:nowrap; }
  td.domain { font-family:ui-monospace,monospace; font-size:12px; white-space:nowrap; }
  td.status { font-family:ui-monospace,monospace; }
  tr.filtered-out { display:none; }
  .thumb { width:120px; height:auto; border:1px solid #cbd5e1; border-radius:4px; cursor:zoom-in; transition:transform .1s; }
  .thumb:hover { transform:scale(1.03); border-color:#0ea5e9; }
  .badge { padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; }
  .badge.pass{background:#16a34a;color:#fff}.badge.fail{background:#dc2626;color:#fff}
  .badge.blocked{background:#2563eb;color:#fff}.badge.info{background:#ca8a04;color:#fff}.badge.manual{background:#6b7280;color:#fff}
  tr.v-fail { background:#fff5f5; }
  .forbidden { margin-top:6px; font-size:11px; color:#991b1b; }
  .muted { color:#94a3b8; }
  code { background:#f1f5f9; padding:1px 4px; border-radius:3px; }

  /* Lightbox: full-size, zoomable screenshot viewer */
  #lightbox { position:fixed; inset:0; background:rgba(0,0,0,.9); display:none; z-index:1000; }
  #lightbox.open { display:block; }
  #lightbox .lb-bar { position:fixed; top:0; left:0; right:0; padding:10px 16px; display:flex; gap:10px; align-items:center; color:#fff; background:rgba(0,0,0,.5); z-index:1002; }
  #lightbox .lb-bar button { background:#1e293b; color:#fff; border:1px solid #475569; border-radius:6px; padding:6px 12px; cursor:pointer; font-size:14px; }
  #lightbox .lb-bar button:hover { background:#334155; }
  #lightbox .lb-hint { font-size:12px; color:#94a3b8; margin-left:auto; }
  #lightbox .lb-canvas { position:absolute; inset:0; overflow:auto; cursor:grab; }
  #lightbox .lb-canvas:active { cursor:grabbing; }
  #lightbox img { display:block; transform-origin:0 0; image-rendering:auto; margin:56px auto 20px; }
</style></head>
<body>
<header>
  <h1>MDKPI-7508 — WAF Post-Enablement Regression</h1>
  <div class="meta">Run ${escapeHtml(meta.runId)} · Mode: ${escapeHtml(meta.mode)} · Tenant(s): ${escapeHtml(meta.domains.length > 6 ? meta.domains.length + ' tenants' : meta.domains.join(', '))} · ${new Date().toISOString()}</div>
</header>
<div class="summary">
  <span class="filters-label">Filter:</span>
  <div class="card all active" data-filter="ALL" onclick="applyFilter('ALL', this)">All ${rows.length}</div>
  <div class="card pass" data-filter="PASS" onclick="applyFilter('PASS', this)">Pass ${counts.PASS}</div>
  <div class="card fail" data-filter="FAIL" onclick="applyFilter('FAIL', this)">Fail ${counts.FAIL}</div>
  <div class="card blocked" data-filter="BLOCKED" onclick="applyFilter('BLOCKED', this)">Blocked ${counts.BLOCKED}</div>
  <div class="card info" data-filter="INFO" onclick="applyFilter('INFO', this)">Info ${counts.INFO}</div>
  <div class="card manual" data-filter="MANUAL" onclick="applyFilter('MANUAL', this)">Manual ${counts.MANUAL}</div>
</div>
<main>${sections.join('')}</main>

<div id="lightbox" role="dialog" aria-label="Screenshot viewer">
  <div class="lb-bar">
    <button onclick="lbZoom(1.25)">Zoom +</button>
    <button onclick="lbZoom(0.8)">Zoom −</button>
    <button onclick="lbSet(1)">100%</button>
    <button onclick="lbFit()">Fit</button>
    <button onclick="closeLightbox()">Close ✕</button>
    <span class="lb-hint">Scroll to pan · click Close or press Esc</span>
  </div>
  <div class="lb-canvas" id="lbCanvas"><img id="lbImg" src="" alt="full size screenshot"></div>
</div>

<script>
  // ---- Pass/Fail/All filtering (in place; evidence stays intact) ----
  function applyFilter(verdict, el) {
    document.querySelectorAll('.summary .card').forEach(c => c.classList.remove('active'));
    if (el) el.classList.add('active');
    document.querySelectorAll('table.rows tbody tr').forEach(tr => {
      const show = verdict === 'ALL' || tr.getAttribute('data-verdict') === verdict;
      tr.classList.toggle('filtered-out', !show);
    });
    // Hide sections that have no visible rows under the current filter.
    document.querySelectorAll('section[data-case]').forEach(sec => {
      const anyVisible = Array.from(sec.querySelectorAll('tbody tr')).some(tr => !tr.classList.contains('filtered-out'));
      sec.classList.toggle('hidden', !anyVisible);
    });
  }

  // ---- Zoomable lightbox ----
  var lbScale = 1;
  function openLightbox(src) {
    var lb = document.getElementById('lightbox');
    var img = document.getElementById('lbImg');
    img.src = src;
    lb.classList.add('open');
    img.onload = fitToView;
  }
  function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); }
  function applyScale() { document.getElementById('lbImg').style.transform = 'scale(' + lbScale + ')'; }
  function lbZoom(f) { lbScale = Math.min(8, Math.max(0.1, lbScale * f)); applyScale(); }
  function lbSet(s) { lbScale = s; applyScale(); }
  function fitToView() {
    var img = document.getElementById('lbImg');
    var canvas = document.getElementById('lbCanvas');
    if (!img.naturalWidth) return;
    var avail = canvas.clientWidth - 40;
    lbScale = Math.min(1, avail / img.naturalWidth);
    applyScale();
  }
  function lbFit() { fitToView(); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === '+' || e.key === '=') lbZoom(1.25);
    if (e.key === '-') lbZoom(0.8);
  });
  // Ctrl/Cmd + wheel to zoom inside the lightbox.
  document.getElementById('lbCanvas').addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); lbZoom(e.deltaY < 0 ? 1.15 : 0.87); }
  }, { passive: false });
  // Click the dark backdrop (not the image) to close.
  document.getElementById('lightbox').addEventListener('click', function (e) {
    if (e.target.id === 'lightbox' || e.target.id === 'lbCanvas') closeLightbox();
  });
</script>
</body></html>`;

  await writeFile(outPath, html, 'utf8');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function writeAll(rows, runDir, meta, names = {}) {
  await writeHtml(rows, path.join(runDir, 'report.html'), meta, runDir, names);
  await writeCsv(rows, path.join(runDir, 'results.csv'), names);
  await writeXlsx(rows, path.join(runDir, 'results.xlsx'), meta, names);
}
