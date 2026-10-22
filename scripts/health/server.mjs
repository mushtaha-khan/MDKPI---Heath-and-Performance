/**
 * Live dashboard server for the dealership health crawl.
 *
 * Serves scripts/health/dashboard.html, streams crawl events over Server-Sent Events,
 * runs the (read-only) crawler on demand, and serves the per-screen screenshots so the
 * dashboard can show them. Open the printed URL in Chrome to watch the crawl live.
 *
 * Usage: node scripts/health/server.mjs [port]
 *   KPI_HEADLESS=true node scripts/health/server.mjs   # run the browser hidden
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawl } from './crawler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.HEALTH_PORT || 5174);
// Serve the SAME UI the Chrome extension uses, so http://localhost:5174 and the extension
// side panel are always identical. panel.js guards its chrome.* calls so it runs fine in a
// plain browser tab too.
const EXT = path.resolve('extension');
const HTML = path.join(EXT, 'panel.html');
const PANEL_JS = path.join(EXT, 'panel.js');
const ARTIFACTS = path.resolve('artifacts', 'health');

/** Connected SSE clients. */
const clients = new Set();
let running = false;
let stopRequested = false;

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

/** A filename-safe name: "Dealership Health - DEALER - 21-10-2026 03.45 PM.xlsx". */
function exportFileName(report, ext) {
  const role = report.cfg?.role ?? 'report';
  const dealer = report.cfg?.dealerName ? `${report.cfg.dealerName} - ` : '';
  // startedAt is "DD/MM/YYYY HH:MM AM/PM" — make it filename-safe.
  const stamp = (report.startedAt ?? '').replace(/\//g, '-').replace(':', '.');
  return `Dealership Health - ${dealer}${role} - ${stamp || report.runId || 'run'}.${ext}`.replace(/[\\/:*?"<>|]/g, '_');
}

/** CSV with Failed-APIs, Export-Tests, All-Modules, then same-role history sections. */
function buildCsv(report, history = null) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  const cfg = report.cfg || {};
  const s = report.summary || {};
  lines.push(`Dealership Health Report - ${cfg.role ?? ''}`);
  if (cfg.dealerName) lines.push(`Dealership,${esc(cfg.dealerName)}`);
  lines.push(`Tenant,${esc(cfg.base)}`);
  lines.push(`User,${esc(cfg.user)}`);
  lines.push(`Started,${esc(report.startedAt)}`);
  lines.push(`Finished,${esc(report.finishedAt)}`);
  lines.push(`Totals,PASS ${s.pass || 0} / WARN ${s.warn || 0} / FAIL ${s.fail || 0} / SKIP ${s.skip || 0} of ${s.total || 0}`);
  lines.push('');
  lines.push('FAILED APIS');
  lines.push(['#', 'Module', 'Menu Group', 'Verdict', 'Method', 'Status', 'Failure Kind', 'API URL'].join(','));
  let n = 1;
  for (const r of report.results || []) {
    for (const f of r.failedApis || []) {
      lines.push([n++, esc(r.name), esc(r.group), r.verdict, f.method || '-', f.status, esc(f.kind), esc(f.url)].join(','));
    }
    if (r.verdict === 'FAIL' && !(r.failedApis || []).length) {
      lines.push([n++, esc(r.name), esc(r.group), r.verdict, '-', esc(r.httpStatus), 'nav/other', esc(r.reason)].join(','));
    }
  }
  if (n === 1) lines.push(',No failed APIs');
  lines.push('');
  lines.push('EXPORT TESTS');
  lines.push(['#', 'Module', 'Menu Group', 'Tab', 'Format', 'Result', 'Status', 'Endpoint / Error'].join(','));
  let en = 1;
  for (const r of report.results || []) {
    for (const e of r.exports || []) {
      lines.push([en++, esc(r.name), esc(r.group), esc(e.tab || '(main)'), e.format, e.ok ? 'OK' : 'FAILED', esc(e.status), esc(e.endpoint || e.error || '')].join(','));
    }
  }
  if (en === 1) lines.push(',No export controls tested');
  lines.push('');
  lines.push('ALL MODULES');
  lines.push(['#', 'Heading', 'Sub-Heading', 'Screen', 'Verdict', 'HTTP', 'API Calls', 'Failed', 'Exports', 'Detail'].join(','));
  (report.results || []).forEach((r, i) => {
    const es = r.exportsSummary;
    const exp = es ? `${es.ok}/${es.total}${es.failed ? ` (${es.failed} fail)` : ''}` : '-';
    lines.push([i + 1, esc(r.group), esc(r.subGroup || ''), esc(r.name), r.verdict, esc(r.httpStatus), r.apiCount || 0, (r.failedApis || []).length, esc(exp), esc(r.reason)].join(','));
  });

  // ---- Historical data (same role, across all past runs) — clearly separated ----
  if (history) {
    lines.push('');
    lines.push(`=== HISTORICAL DATA (role ${history.role}, across all past runs — NOT this crawl) ===`);
    lines.push('');
    lines.push(`RECURRING API FAILURES (${(history.recurringFailures || []).length} endpoints, ${history.totalRecords} calls logged)`);
    lines.push(['#', 'Endpoint', 'Method', 'Fails', 'Statuses', 'First Seen', 'Last Seen', 'Weekday Pattern', 'Time Pattern', 'Screens'].join(','));
    (history.recurringFailures || []).forEach((g, i) => {
      lines.push([i + 1, esc(g.endpoint), esc(g.method), g.count, esc(g.statuses), esc(g.firstSeen), esc(g.lastSeen), esc(g.weekdayPattern), esc(g.timePattern), esc(g.screens)].join(','));
    });
    if (!(history.recurringFailures || []).length) lines.push(',No recurring failures recorded');
    lines.push('');
    lines.push('FULL API HISTORY');
    lines.push(['Date', 'Time', 'Weekday', 'ISO', 'Run', 'Heading', 'Sub-Heading', 'Screen', 'Method', 'Endpoint', 'Status', 'Result', 'Kind', 'Error'].join(','));
    for (const r of history.raw || []) {
      lines.push([esc(r.date), esc(r.time), esc(r.weekday), esc(r.iso), esc(r.runId), esc(r.group), esc(r.subGroup), esc(r.screen), esc(r.method), esc(r.endpoint), esc(r.status), esc(r.result), esc(r.kind), esc(r.error)].join(','));
    }
  }

  return '\uFEFF' + lines.join('\r\n'); // BOM so Excel opens UTF-8 cleanly
}

/** Guard screenshot serving against path traversal — files must stay under artifacts/health. */
function safeShotPath(runId, file) {
  const resolved = path.resolve(ARTIFACTS, runId, file);
  if (!resolved.startsWith(ARTIFACTS + path.sep)) return null;
  return resolved;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  // The Chrome extension side panel is a different origin (chrome-extension://…), so the
  // stream, start, and screenshot endpoints must allow cross-origin reads. This server
  // only ever serves local health artifacts, so a permissive policy is fine here.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // --- dashboard page (the extension panel UI, served for the browser) ---
  if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/panel.html') {
    const html = await readFile(HTML, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  // --- panel script ---
  if (u.pathname === '/panel.js') {
    const js = await readFile(PANEL_JS, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(js);
    return;
  }

  // --- SSE stream ---
  if (u.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // --- start a crawl (one or more roles, in parallel) ---
  if (u.pathname === '/start' && req.method === 'POST') {
    if (running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'already running' }));
      return;
    }
    // ?roles=DEALER,AUTOGROUP  (default: both). Each role is an independent, concurrent
    // job with its own browser context/session, tagged by role on every event.
    const rolesParam = (u.searchParams.get('roles') || 'DEALER,AUTOGROUP')
      .split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
    // Export testing toggle from the UI: ?exports=on|off. Omitted = crawler default.
    const expParam = u.searchParams.get('exports');
    const testExports = expParam === null ? null : expParam === 'on' || expParam === 'true' || expParam === '1';
    running = true;
    stopRequested = false;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started: true, roles: rolesParam, testExports }));

    broadcast({ type: 'batch-start', roles: rolesParam, testExports });
    // Fire all roles at once; events stream to the dashboard tagged with their role.
    // Each job polls shouldStop() so the Stop button can end the crawl gracefully.
    Promise.all(
      rolesParam.map((role) =>
        crawl({ emit: broadcast, role, shouldStop: () => stopRequested, testExports }).catch((err) =>
          broadcast({ role, type: 'done', summary: { ok: false, reason: String(err.message) }, results: [] }),
        ),
      ),
    )
      .then(() => broadcast({ type: 'batch-done', roles: rolesParam, stopped: stopRequested }))
      .finally(() => { running = false; stopRequested = false; });
    return;
  }

  // --- stop a running crawl ---
  if (u.pathname === '/stop' && req.method === 'POST') {
    stopRequested = true;
    broadcast({ type: 'log', msg: 'Stop requested by user' });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stopping: true }));
    return;
  }

  // --- list saved crawl reports (one per role-run), newest first ---
  if (u.pathname === '/reports') {
    const { readdir, readFile: rf } = await import('node:fs/promises');
    let dirs = [];
    try { dirs = await readdir(ARTIFACTS, { withFileTypes: true }); } catch { dirs = []; }
    const reports = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const metaPath = path.join(ARTIFACTS, d.name, 'results.json');
      try {
        const meta = JSON.parse(await rf(metaPath, 'utf8'));
        reports.push({
          runId: d.name,
          role: meta.cfg?.role ?? '-',
          base: meta.cfg?.base ?? '',
          dealerName: meta.cfg?.dealerName ?? '',
          summary: meta.summary ?? {},
          // Prefer the stored DD/MM/YYYY HH:MM AM/PM stamp; fall back to the runId.
          when: meta.startedAt ?? d.name,
        });
      } catch { /* no results.json yet (run in progress) */ }
    }
    reports.sort((a, b) => (a.runId < b.runId ? 1 : -1));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(reports));
    return;
  }

  // --- fetch one saved report's full results ---
  if (u.pathname === '/report') {
    const runId = u.searchParams.get('run') || '';
    const safe = path.resolve(ARTIFACTS, runId, 'results.json');
    if (!safe.startsWith(ARTIFACTS + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const report = JSON.parse(await readFile(safe, 'utf8'));
      // Attach same-role API history (across all past runs) so the report shows the current
      // crawl PLUS historical patterns in one place. Kept under `history` so it is clearly
      // separate from the current run's `results`.
      try {
        const { historyForRole } = await import('./history.mjs');
        const h = await historyForRole(report.cfg?.role || '');
        report.history = { role: h.role, totalRecords: h.totalRecords, recurringFailures: h.recurringFailures };
      } catch { report.history = null; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(report));
    } catch { res.writeHead(404); res.end('not found'); }
    return;
  }

  // --- export one report as Excel (.xlsx) ---
  if (u.pathname === '/export.xlsx') {
    const runId = u.searchParams.get('run') || '';
    const safe = path.resolve(ARTIFACTS, runId, 'results.json');
    if (!safe.startsWith(ARTIFACTS + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const report = JSON.parse(await readFile(safe, 'utf8'));
      // Full same-role history (raw rows + recurring-failure summary) for the Excel sheets.
      let history = null;
      try { const { historyForRole } = await import('./history.mjs'); history = await historyForRole(report.cfg?.role || ''); } catch { history = null; }
      const { buildWorkbook } = await import('./excel.mjs');
      const buf = await buildWorkbook(report, history);
      const fname = exportFileName(report, 'xlsx');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fname}"`,
        'Cache-Control': 'no-store',
      });
      res.end(Buffer.from(buf));
    } catch (e) { res.writeHead(500); res.end('export failed: ' + e.message); }
    return;
  }

  // --- export one report as CSV (Failed APIs focus) ---
  if (u.pathname === '/export.csv') {
    const runId = u.searchParams.get('run') || '';
    const safe = path.resolve(ARTIFACTS, runId, 'results.json');
    if (!safe.startsWith(ARTIFACTS + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const report = JSON.parse(await readFile(safe, 'utf8'));
      let history = null;
      try { const { historyForRole } = await import('./history.mjs'); history = await historyForRole(report.cfg?.role || ''); } catch { history = null; }
      const csv = buildCsv(report, history);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFileName(report, 'csv')}"`,
        'Cache-Control': 'no-store',
      });
      res.end(csv);
    } catch (e) { res.writeHead(500); res.end('export failed: ' + e.message); }
    return;
  }

  // --- persistent API history log (raw JSONL) ---
  if (u.pathname === '/api-log.jsonl') {
    const f = path.join(ARTIFACTS, 'api-log.jsonl');
    try {
      await stat(f);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': 'attachment; filename="api-log.jsonl"', 'Cache-Control': 'no-store' });
      createReadStream(f).pipe(res);
    } catch { res.writeHead(404); res.end('no history log yet'); }
    return;
  }

  // --- persistent API history log as CSV (for Excel/analysis) ---
  if (u.pathname === '/api-log.csv') {
    const f = path.join(ARTIFACTS, 'api-log.jsonl');
    try {
      const text = await readFile(f, 'utf8');
      const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const cols = ['date', 'time', 'weekday', 'iso', 'role', 'group', 'subGroup', 'screen', 'method', 'endpoint', 'status', 'result', 'kind', 'error'];
      const rows = [cols.join(',')];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        rows.push(cols.map((c) => esc(o[c])).join(','));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="api-history.csv"', 'Cache-Control': 'no-store' });
      res.end('\uFEFF' + rows.join('\r\n'));
    } catch { res.writeHead(404); res.end('no history log yet'); }
    return;
  }

  // --- screenshots ---
  if (u.pathname === '/shot') {
    const runId = u.searchParams.get('run') || '';
    const file = u.searchParams.get('f') || '';
    const p = safeShotPath(runId, file);
    if (!p) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      await stat(p);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      createReadStream(p).pipe(res);
    } catch {
      res.writeHead(404); res.end('not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Dealership health dashboard: ${url}`);
  console.log(`  Open it in Chrome, then press "Start crawl".`);
  console.log(`  (A Chrome window will open so you can watch — set KPI_HEADLESS=true to hide it.)\n`);
});
