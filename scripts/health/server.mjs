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
import dotenv from 'dotenv';
import { crawl } from './crawler.mjs';
import { runPerf } from '../perf/crawler.mjs';
import { publicSettings, updateSettings, effectiveConfig } from './settings.mjs';

dotenv.config();

/** The tenant this server is pointed at (health target, else legacy base). */
const TARGET_URL = (process.env.HEALTH_BASE_URL || process.env.KPI_BASE_URL || 'https://gyh.mydealerkpi.com').replace(/\/$/, '');

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

// --- Performance Testing: fully independent run state + its own SSE clients + artifacts ---
const PERF_ARTIFACTS = path.resolve('artifacts', 'perf');
const perfClients = new Set();
let perfRunning = false;
let perfStopRequested = false;
function perfBroadcast(event) {
  try {
    if (event.type === 'perf-dealer' && event.name) console.log(`  >>> [PERF] TARGET DEALER : ${event.name}  (${TARGET_URL})  [${event.role || ''}]`);
    else if (event.type === 'perf-run-start') console.log(`  >>> [PERF] started : ${event.role || ''} @ ${event.base || TARGET_URL}`);
    else if (event.type === 'perf-done' && event.summary) { const s = event.summary; console.log(`  >>> [PERF] finished: ${event.role || ''} — OK ${s.ok_count || 0} / SLOW ${s.slow || 0} / INFO ${s.info || 0} / ERR ${s.error || 0}`); }
  } catch { /* best-effort */ }
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of perfClients) res.write(data);
}

function broadcast(event) {
  // Surface key milestones to the server console so the terminal shows which dealer/URL is
  // being targeted and the run outcome — not just the browser panel.
  try {
    if (event.type === 'dealer' && event.name) {
      console.log(`  >>> TARGET DEALER : ${event.name}  (${TARGET_URL})  [${event.role || ''}]`);
    } else if (event.type === 'run-start') {
      console.log(`  >>> crawl started  : ${event.role || ''} @ ${event.base || TARGET_URL}  user=${event.user || ''}  ${event.startedAt || ''}`);
    } else if (event.type === 'done' && event.summary) {
      const s = event.summary;
      console.log(`  >>> crawl finished : ${event.role || ''} — PASS ${s.pass || 0} / WARN ${s.warn || 0} / FAIL ${s.fail || 0} / SKIP ${s.skip || 0}`);
    }
  } catch { /* console logging is best-effort */ }
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

  // ---- All APIs (module-wise) + Slow APIs ----
  lines.push('');
  lines.push('ALL APIS (module-wise — every first-party Fetch/XHR)');
  lines.push(['Heading', 'Sub-Heading', 'Module', 'API Name', 'Method', 'Endpoint', 'Query/Payload', 'Status', 'Time (ms)', 'Count', 'Error'].join(','));
  for (const r of report.results || []) {
    for (const a of r.allApis || []) {
      lines.push([esc(r.group), esc(r.subGroup || ''), esc(r.name), esc(a.name), esc(a.method), esc(a.endpoint), esc(a.payload || a.query || ''), esc(a.status), esc(typeof a.ms === 'number' ? a.ms : ''), esc(a.count || 1), esc(a.error || '')].join(','));
    }
  }
  lines.push('');
  lines.push('SLOW APIS (exceeding the per-API benchmark threshold)');
  lines.push(['Heading', 'Sub-Heading', 'Module', 'API Name', 'Method', 'Endpoint', 'Query/Payload', 'Status', 'Time (ms)', 'Count'].join(','));
  let anySlow = false;
  for (const r of report.results || []) {
    for (const a of r.slowApis || []) {
      anySlow = true;
      lines.push([esc(r.group), esc(r.subGroup || ''), esc(r.name), esc(a.name), esc(a.method), esc(a.endpoint), esc(a.payload || a.query || ''), esc(a.status), esc(typeof a.ms === 'number' ? a.ms : ''), esc(a.count || 1)].join(','));
    }
  }
  if (!anySlow) lines.push(',,No slow APIs above threshold');

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

/** Filename-safe name for a performance export. */
function perfExportName(report, ext) {
  const role = report.cfg?.role ?? 'perf';
  const dealer = report.cfg?.dealerName ? `${report.cfg.dealerName} - ` : '';
  const stamp = (report.startedAt ?? '').replace(/\//g, '-').replace(':', '.');
  return `API Performance - ${dealer}${role} - ${stamp || report.runId || 'run'}.${ext}`.replace(/[\\/:*?"<>|]/g, '_');
}

/** CSV of a performance report: one row per (report × filter × scope) with rep timings. */
function buildPerfCsv(report) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cfg = report.cfg || {}; const s = report.summary || {};
  const lines = [];
  lines.push(`API Performance Report - ${cfg.role ?? ''}`);
  if (cfg.dealerName) lines.push(`Dealership,${esc(cfg.dealerName)}`);
  lines.push(`Tenant,${esc(cfg.base)}`);
  lines.push(`Started,${esc(report.startedAt)}`);
  lines.push(`Finished,${esc(report.finishedAt)}`);
  lines.push(`Filters,${esc((cfg.filters || []).join(' '))}`);
  lines.push(`Scopes,${esc((cfg.scopes || []).join(' '))}`);
  lines.push(`Repetitions,${esc(cfg.reps)}`);
  lines.push(`Totals,OK ${s.ok_count || 0} / SLOW ${s.slow || 0} / INFO ${s.info || 0} / ERROR ${s.error || 0} of ${s.total || 0}`);
  lines.push('');
  lines.push(['#', 'Heading', 'Sub-Heading', 'Report', 'Filter', 'Scope', 'Date Range', 'Avg (s)', 'Individual (s)', 'Benchmark', 'Verdict', 'Note'].join(','));
  (report.results || []).forEach((r, i) => {
    const note = [r.fromNav ? 'timed from navigation' : '', r.dateFallback ? 'all-time fallback Jan 1 2015' : '', r.navError].filter(Boolean).join('; ');
    lines.push([i + 1, esc(r.group), esc(r.subGroup || ''), esc(r.name), esc(r.filterLabel || r.filter), esc(r.scope), esc(r.dateRange || ''), esc(r.avgSec), esc((r.timingsSec || []).join(' ')), esc(r.benchmark), esc(r.verdict), esc(note)].join(','));
  });

  // All APIs (module-wise, captured on rep 1 of each config).
  lines.push('');
  lines.push('ALL APIS (per report × filter × scope — captured on first repetition)');
  lines.push(['Heading', 'Report', 'Filter', 'Scope', 'API Name', 'Method', 'Endpoint', 'Query/Payload', 'Status', 'Time (ms)', 'Count'].join(','));
  for (const r of report.results || []) {
    for (const a of r.allApis || []) {
      lines.push([esc(r.group), esc(r.name), esc(r.filterLabel || r.filter), esc(r.scope), esc(a.name), esc(a.method), esc(a.endpoint), esc(a.payload || a.query || ''), esc(a.status), esc(typeof a.ms === 'number' ? a.ms : ''), esc(a.count || 1)].join(','));
    }
  }
  lines.push('');
  lines.push('SLOW APIS (exceeding the per-API §2 threshold)');
  lines.push(['Heading', 'Report', 'Filter', 'Scope', 'API Name', 'Method', 'Endpoint', 'Status', 'Time (ms)', 'Threshold (ms)'].join(','));
  let anySlow = false;
  for (const r of report.results || []) {
    for (const a of r.slowApis || []) { anySlow = true; lines.push([esc(r.group), esc(r.name), esc(r.filterLabel || r.filter), esc(r.scope), esc(a.name), esc(a.method), esc(a.endpoint), esc(a.status), esc(typeof a.ms === 'number' ? a.ms : ''), esc(r.slowThresholdMs)].join(',')); }
  }
  if (!anySlow) lines.push(',,No slow APIs above threshold');

  return '\uFEFF' + lines.join('\r\n');
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

  // --- settings: read (browser-safe, password never returned) ---
  if (u.pathname === '/settings' && req.method === 'GET') {
    const s = await publicSettings();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(s));
    return;
  }
  // --- settings: update (Target URL / Username / Password) ---
  if (u.pathname === '/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
      try {
        const updated = await updateSettings({ base: parsed.base, username: parsed.username, password: parsed.password });
        // Reflect the new target in the console so it's visible which dealer is now set.
        console.log(`  >>> settings updated — TARGET URL: ${updated.base}  user: ${updated.username}  password: ${updated.passwordSet ? 'set' : '(from .env/none)'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(updated));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message) }));
      }
    });
    return;
  }

  // --- panel script ---
  if (u.pathname === '/panel.js') {
    const js = await readFile(PANEL_JS, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(js);
    return;
  }

  // --- configured target tenant (so the panel header can show it before a crawl) ---
  if (u.pathname === '/target') {
    const eff = await effectiveConfig();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ url: eff.base, running }));
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

  // ===================== PERFORMANCE TESTING (independent) =====================
  // --- perf SSE stream ---
  if (u.pathname === '/perf/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    perfClients.add(res);
    req.on('close', () => perfClients.delete(res));
    return;
  }

  // --- start a performance run (one or more roles, in parallel) ---
  if (u.pathname === '/perf/start' && req.method === 'POST') {
    if (perfRunning) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'already running' })); return; }
    const rolesParam = (u.searchParams.get('roles') || 'DEALER,AUTOGROUP').split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
    const filters = (u.searchParams.get('filters') || 'month').split(',').map((s) => s.trim()).filter(Boolean);
    const scopes = (u.searchParams.get('scopes') || 'single').split(',').map((s) => s.trim()).filter(Boolean);
    const reps = Number(u.searchParams.get('reps') || 3) === 1 ? 1 : 3;
    perfRunning = true; perfStopRequested = false;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started: true, roles: rolesParam, filters, scopes, reps }));
    perfBroadcast({ type: 'perf-batch-start', roles: rolesParam, filters, scopes, reps });
    Promise.all(
      rolesParam.map((role) =>
        runPerf({ emit: perfBroadcast, role, filters, scopes, reps, shouldStop: () => perfStopRequested }).catch((err) =>
          perfBroadcast({ role, type: 'perf-done', summary: { ok: false, reason: String(err.message) }, results: [] }),
        ),
      ),
    ).then(() => perfBroadcast({ type: 'perf-batch-done', roles: rolesParam, stopped: perfStopRequested }))
      .finally(() => { perfRunning = false; perfStopRequested = false; });
    return;
  }

  // --- discovery-only (NO measurement): enumerate reports + date-filter support ---
  if (u.pathname === '/perf/discover' && req.method === 'POST') {
    if (perfRunning) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'already running' })); return; }
    const rolesParam = (u.searchParams.get('roles') || 'DEALER,AUTOGROUP').split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
    perfRunning = true; perfStopRequested = false;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ discovering: true, roles: rolesParam }));
    perfBroadcast({ type: 'perf-discover-batch-start', roles: rolesParam });
    (async () => {
      const { discoverForPerf } = await import('../perf/crawler.mjs');
      for (const role of rolesParam) {
        if (perfStopRequested) break;
        await discoverForPerf({ emit: perfBroadcast, role, shouldStop: () => perfStopRequested }).catch((err) => perfBroadcast({ role, type: 'perf-discover-done', ok: false, reason: String(err.message), reports: [] }));
      }
      perfBroadcast({ type: 'perf-discover-batch-done', roles: rolesParam, stopped: perfStopRequested });
    })().finally(() => { perfRunning = false; perfStopRequested = false; });
    return;
  }

  // --- stop a performance run ---
  if (u.pathname === '/perf/stop' && req.method === 'POST') {
    perfStopRequested = true;
    perfBroadcast({ type: 'log', msg: 'Perf stop requested by user' });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stopping: true }));
    return;
  }

  // --- perf target info ---
  if (u.pathname === '/perf/target') {
    const eff = await effectiveConfig();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ url: eff.base, running: perfRunning }));
    return;
  }

  // --- list saved performance reports, newest first ---
  if (u.pathname === '/perf/reports') {
    const { readdir, readFile: rf } = await import('node:fs/promises');
    let dirs = [];
    try { dirs = await readdir(PERF_ARTIFACTS, { withFileTypes: true }); } catch { dirs = []; }
    const reports = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      try {
        const meta = JSON.parse(await rf(path.join(PERF_ARTIFACTS, d.name, 'results.json'), 'utf8'));
        reports.push({ runId: d.name, role: meta.cfg?.role ?? '-', base: meta.cfg?.base ?? '', dealerName: meta.cfg?.dealerName ?? '', summary: meta.summary ?? {}, when: meta.startedAt ?? d.name });
      } catch { /* in progress */ }
    }
    reports.sort((a, b) => (a.runId < b.runId ? 1 : -1));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(reports));
    return;
  }

  // --- fetch one saved performance report ---
  if (u.pathname === '/perf/report') {
    const runId = u.searchParams.get('run') || '';
    const safe = path.resolve(PERF_ARTIFACTS, runId, 'results.json');
    if (!safe.startsWith(PERF_ARTIFACTS + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const body = await readFile(safe, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
    return;
  }

  // --- export a performance report as Excel ---
  if (u.pathname === '/perf/export.xlsx') {
    const runId = u.searchParams.get('run') || '';
    const safe = path.resolve(PERF_ARTIFACTS, runId, 'results.json');
    if (!safe.startsWith(PERF_ARTIFACTS + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const report = JSON.parse(await readFile(safe, 'utf8'));
      const { buildPerfWorkbook } = await import('../perf/excel.mjs');
      const buf = await buildPerfWorkbook(report);
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${perfExportName(report, 'xlsx')}"`, 'Cache-Control': 'no-store' });
      res.end(Buffer.from(buf));
    } catch (e) { res.writeHead(500); res.end('export failed: ' + e.message); }
    return;
  }

  // --- export a performance report as CSV ---
  if (u.pathname === '/perf/export.csv') {
    const runId = u.searchParams.get('run') || '';
    const safe = path.resolve(PERF_ARTIFACTS, runId, 'results.json');
    if (!safe.startsWith(PERF_ARTIFACTS + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const report = JSON.parse(await readFile(safe, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${perfExportName(report, 'csv')}"`, 'Cache-Control': 'no-store' });
      res.end(buildPerfCsv(report));
    } catch (e) { res.writeHead(500); res.end('export failed: ' + e.message); }
    return;
  }
  // =================== END PERFORMANCE TESTING ===================

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
  console.log(`\n  ============================================================`);
  console.log(`  TARGET DEALER : (resolving on login…)`);
  console.log(`  TARGET URL    : ${TARGET_URL}`);
  console.log(`  ============================================================`);
  console.log(`  Dealership health dashboard: ${url}`);
  console.log(`  Open it in Chrome, then press "Start crawl".`);
  console.log(`  (A Chrome window opens so you can watch — set KPI_HEADLESS=true to hide it.)\n`);
});
