/* Side-panel live viewer for the dealership health crawl — DEALER and AUTOGROUP side by
 * side. One SSE stream from the local server carries events tagged by role; each event is
 * routed into its role's column. The server does the crawling; this is purely the view. */

const $ = (s) => document.querySelector(s);
const colsEl = $('#cols');
let es = null, serverBase = '', activeRoles = [];

const ROLE_META = {
  DEALER: { label: 'DEALER', cls: 'd' },
  AUTOGROUP: { label: 'AUTOGROUP', cls: 'a' },
};

/** Per-role column state + DOM. */
const cols = new Map();

// ---- Target banner in the header (which dealer + URL is being crawled) ----
function setTargetUrl(url) {
  const el = $('#t-url');
  if (el && url) el.textContent = 'URL: ' + url;
}
function setTargetDealer(name) {
  const el = $('#t-dealer');
  if (el && name) { el.textContent = 'Dealer: ' + name; el.classList.add('known'); }
}

function stCls(s) { s = +s; if (!s) return 'warn'; if (s >= 500 || s === 401 || s === 403) return 'bad'; if (s >= 400) return 'warn'; return 'ok'; }

function makeColumn(role) {
  const meta = ROLE_META[role] || { label: role, cls: 'd' };
  const col = document.createElement('div');
  col.className = 'col';
  col.innerHTML = `
    <div class="colhead">
      <div class="rname"><span class="${meta.cls}">${meta.label}</span></div>
      <div class="colmeta" data-meta>waiting…</div>
      <div class="counts">
        <span class="chip total filt active" data-c="total" data-f="all">0</span>
        <span class="chip pass filt" data-c="pass" data-f="PASS">0 pass</span>
        <span class="chip warn filt" data-c="warn" data-f="WARN">0 warn</span>
        <span class="chip fail filt" data-c="fail" data-f="FAIL">0 fail</span>
        <span class="chip skip filt" data-c="skip" data-f="SKIP">0 skip</span>
      </div>
      <div class="toolbar">
        <button class="mini" data-expand-all>Expand all</button>
        <button class="mini" data-collapse-all>Collapse all</button>
      </div>
    </div>
    <div class="bar"><div data-progress></div></div>
    <div class="coltabs">
      <button class="active" data-pane="screens">Screens</button>
      <button data-pane="log">Live activity</button>
    </div>
    <div class="colbody">
      <div class="pane active" data-pane-body="screens">
        <div class="hint">Make sure the server is running (<code>npm run health</code>), then press Start.</div>
      </div>
      <div class="pane" data-pane-body="log"><div class="logbox"></div></div>
    </div>`;
  colsEl.appendChild(col);

  col.querySelectorAll('.coltabs button').forEach((b) => {
    b.onclick = () => {
      col.querySelectorAll('.coltabs button').forEach((x) => x.classList.remove('active'));
      col.querySelectorAll('.pane').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      col.querySelector(`[data-pane-body="${b.dataset.pane}"]`).classList.add('active');
    };
  });

  const state = {
    role, el: col,
    screensEl: col.querySelector('[data-pane-body="screens"]'),
    logEl: col.querySelector('.logbox'),
    metaEl: col.querySelector('[data-meta]'),
    progressEl: col.querySelector('[data-progress]'),
    counts: { total: 0, pass: 0, warn: 0, fail: 0, skip: 0 },
    cards: new Map(), groups: new Set(), total: 0, runId: '', hintCleared: false,
    filter: 'all', dealerName: '',
  };

  // Clickable status filters: clicking a chip shows only cards with that verdict.
  col.querySelectorAll('.chip.filt').forEach((chip) => {
    chip.onclick = () => {
      state.filter = chip.dataset.f;
      col.querySelectorAll('.chip.filt').forEach((x) => x.classList.toggle('active', x === chip));
      applyFilter(state);
    };
  });
  col.querySelector('[data-expand-all]').onclick = () =>
    col.querySelectorAll('.card:not(.filtered-out)').forEach((c) => c.classList.add('open'));
  col.querySelector('[data-collapse-all]').onclick = () =>
    col.querySelectorAll('.card').forEach((c) => c.classList.remove('open'));

  return state;
}

/** Show only cards whose verdict matches the active status filter (or all). */
function applyFilter(c) {
  c.cards.forEach((card) => {
    const v = card.dataset.verdict || '';
    const show = c.filter === 'all' || v === c.filter;
    card.classList.toggle('filtered-out', !show);
  });
  // Hide a sub-heading when all cards under it (until the next heading/sub-heading) are
  // filtered out; hide a top heading when everything until the next top heading is hidden.
  c.screensEl.querySelectorAll('h3.subsec').forEach((h) => {
    let n = h.nextElementSibling, any = false;
    while (n && !n.classList.contains('sec') && !n.classList.contains('subsec')) {
      if (n.classList.contains('card') && !n.classList.contains('filtered-out')) { any = true; break; }
      n = n.nextElementSibling;
    }
    h.style.display = any ? '' : 'none';
  });
  c.screensEl.querySelectorAll('h2.sec').forEach((h) => {
    let n = h.nextElementSibling, any = false;
    while (n && !n.classList.contains('sec')) {
      if (n.classList.contains('card') && !n.classList.contains('filtered-out')) { any = true; break; }
      n = n.nextElementSibling;
    }
    h.style.display = any ? '' : 'none';
  });
}

function col(role) {
  if (!cols.has(role)) cols.set(role, makeColumn(role));
  return cols.get(role);
}

function layout() {
  colsEl.classList.toggle('single', cols.size <= 1);
}

function log(c, msg, cls = '') {
  const d = document.createElement('div');
  d.className = 'line ' + cls;
  d.textContent = msg;
  c.logEl.prepend(d);
  while (c.logEl.children.length > 300) c.logEl.removeChild(c.logEl.lastChild);
}
function updateCounts(c) {
  c.el.querySelector('[data-c="total"]').textContent = c.counts.total;
  c.el.querySelector('[data-c="pass"]').textContent = c.counts.pass + ' pass';
  c.el.querySelector('[data-c="warn"]').textContent = c.counts.warn + ' warn';
  c.el.querySelector('[data-c="fail"]').textContent = c.counts.fail + ' fail';
  c.el.querySelector('[data-c="skip"]').textContent = c.counts.skip + ' skip';
}
// Two-level headings: a top "group" heading, and under it an optional "subGroup"
// sub-heading. Returns the container element new cards for this (group, subGroup) go into.
function ensureGroup(c, group, subGroup) {
  group = group || 'Menu';
  const gKey = 'g:' + group;
  if (!c.groups.has(gKey)) {
    c.groups.add(gKey);
    const h = document.createElement('h2');
    h.className = 'sec';
    h.textContent = group;
    h.dataset.group = group;
    c.screensEl.appendChild(h);
  }
  if (!subGroup) return c.screensEl;
  const sKey = 's:' + group + '|' + subGroup;
  if (!c.groups.has(sKey)) {
    c.groups.add(sKey);
    const sh = document.createElement('h3');
    sh.className = 'subsec';
    sh.textContent = subGroup;
    sh.dataset.group = group;
    sh.dataset.sub = subGroup;
    c.screensEl.appendChild(sh);
  }
  return c.screensEl;
}
function clearHint(c) {
  if (c.hintCleared) return;
  const hint = c.screensEl.querySelector('.hint');
  if (hint) hint.remove();
  c.hintCleared = true;
}
function screenCard(c, e) {
  clearHint(c);
  ensureGroup(c, e.group || 'Menu', e.subGroup || '');
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="head">
      <span class="dot run"></span>
      <div><div class="nm">${e.name}</div><div class="pth">${e.path}</div></div>
      <span class="v run">…</span>
    </div>
    <div class="cbody"></div>`;
  card.querySelector('.head').onclick = () => card.classList.toggle('open');
  c.screensEl.appendChild(card);
  c.cards.set(e.index, card);
  return card;
}
function finishCard(c, e) {
  const card = c.cards.get(e.index) || screenCard(c, e);
  const v = (e.verdict || 'skip').toLowerCase();
  card.dataset.verdict = e.verdict || 'SKIP';
  card.querySelector('.dot').className = 'dot ' + v;
  const vEl = card.querySelector('.v');
  vEl.className = 'v ' + v;
  vEl.textContent = e.verdict + (e.httpStatus && e.httpStatus !== '-' ? ' · ' + e.httpStatus : '');
  const apiRows = (e.apis || []).map((a) =>
    `<tr><td class="st ${stCls(a.status)}">${a.status}</td><td>${a.method}</td><td class="url">${a.url}</td></tr>`).join('');
  const tabTags = (e.tabs || []).map((t) => `<span class="tag">tab: ${t}</span>`).join('');
  const modalTags = (e.modals || []).map((m) => `<span class="tag ok">modal: ${m.label}</span>`).join('');
  const conErr = (e.consoleErrors || []).map((x) => `<div class="tag err">console: ${x}</div>`).join('');
  // Build a unique, non-lazy image URL per screen. The cache-buster (index) guarantees the
  // browser never reuses another module's cached image, which is what made the same shot
  // appear on every card.
  const shotUrl = e.screenshot
    ? `${serverBase}/shot?run=${encodeURIComponent(c.runId)}&f=${encodeURIComponent(e.screenshot)}&i=${e.index}`
    : '';
  card.querySelector('.cbody').innerHTML = `
    <div class="reason">${e.reason || ''}</div>
    <div class="tags">
      <span class="tag">${e.apiCount || 0} API calls</span>
      ${e.forbidden && e.forbidden.length ? `<span class="tag err">${e.forbidden.length} 401/403</span>` : ''}
      ${e.serverErrors && e.serverErrors.length ? `<span class="tag err">${e.serverErrors.length} 5xx</span>` : ''}
      ${tabTags} ${modalTags}
    </div>
    ${conErr}
    ${apiRows ? `<table class="api">${apiRows}</table>` : ''}
    ${shotUrl ? `<img class="shot" src="${shotUrl}" alt="screenshot of ${e.name}" />` : ''}`;
  c.counts[v] = (c.counts[v] || 0) + 1;
  c.counts.total++;
  updateCounts(c);
  const pct = c.total ? Math.round((c.counts.total / c.total) * 100) : 0;
  c.progressEl.style.width = pct + '%';
  applyFilter(c);
}

function setConn(state, text) {
  $('#conn').className = 'dotc ' + (state === 'on' ? 'on' : state === 'off' ? 'off' : 'wait');
  if (text) $('#meta').textContent = text;
}

function handle(e) {
  // Events without a role are batch-level.
  if (e.type === 'batch-start') {
    // Reset only the columns for the roles in this batch.
    colsEl.innerHTML = '';
    cols.clear();
    for (const r of e.roles) col(r);
    layout();
    const expNote = e.testExports === false ? ' · exports OFF' : e.testExports === true ? ' · exports ON' : '';
    setConn('on', `running ${e.roles.join(' + ')}${expNote}`);
    return;
  }
  if (e.type === 'batch-done') {
    setConn('on', `${e.stopped ? 'stopped' : 'finished'} ${e.roles.join(' + ')}`);
    $('#run').disabled = false; $('#run').textContent = 'Run again';
    $('#stop').disabled = true;
    return;
  }

  const role = e.role || activeRoles[0] || 'DEALER';
  const c = col(role);
  layout();

  switch (e.type) {
    case 'run-start':
      c.runId = e.runId;
      c.metaEl.textContent = `${e.user} @ ${e.base} — discovering…`;
      if (e.base) setTargetUrl(e.base);
      log(c, `Run started as ${e.user} (${role}); logging in…`, 'evt');
      break;
    case 'dealer':
      c.dealerName = e.name;
      setTargetDealer(e.name);
      log(c, `Dealership: ${e.name}`, 'evt');
      break;
    case 'modules':
      c.total = e.total;
      c.metaEl.textContent = `${c.dealerName ? c.dealerName + ' — ' : ''}${e.total} modules (sidebar + children)`;
      log(c, `Discovered ${e.total} menu items`, 'evt');
      break;
    case 'log': log(c, e.msg, 'evt'); break;
    case 'login': log(c, `Login ${e.ok ? 'OK' : 'FAILED'} → ${e.landed}`, e.ok ? 'evt' : 'api-bad'); break;
    case 'screen-start': screenCard(c, e); log(c, '▶ ' + e.name + '  ' + e.path, 'evt'); break;
    case 'api': log(c, `${e.status} ${e.method} ${e.url}`, e.status >= 400 ? 'api-bad' : 'api-ok'); break;
    case 'retry': log(c, `↻ retry ${e.attempt}/${e.of} for "${e.name}" in ${Math.round(e.delayMs / 1000)}s — ${e.reason}`, 'api-bad'); break;
    case 'console-error': log(c, 'console: ' + e.msg, 'api-bad'); break;
    case 'tab': log(c, '  tab → ' + e.label); break;
    case 'modal': log(c, '  modal → ' + e.label); break;
    case 'export': log(c, `  export ${e.format}${e.tab ? ` [${e.tab}]` : ''} → ${e.ok ? 'OK' : 'FAILED'} (${e.status})`, e.ok ? '' : 'api-bad'); break;
    case 'screen-done': finishCard(c, e); log(c, `✔ ${e.name}: ${e.verdict}`, e.verdict === 'FAIL' ? 'api-bad' : 'evt'); break;
    case 'done':
      log(c, `Done. ${e.summary.pass || 0} pass / ${e.summary.warn || 0} warn / ${e.summary.fail || 0} fail / ${e.summary.skip || 0} skip`, 'evt');
      break;
  }
}

function connect(onReady) {
  serverBase = $('#server').value.trim().replace(/\/$/, '');
  if (es) { es.close(); es = null; }
  setConn('wait', 'connecting…');
  // Show the configured target URL in the header immediately (before any crawl).
  fetch(serverBase + '/target').then((r) => r.json()).then((t) => { if (t && t.url) setTargetUrl(t.url); }).catch(() => {});
  es = new EventSource(serverBase + '/events');
  // onReady must run exactly ONCE — on the first open after the user clicked. EventSource
  // auto-reconnects (network blips, long runs), and firing onReady on every reconnect was
  // re-POSTing /start and silently launching a new crawl. Guard with a one-shot flag.
  let readyFired = false;
  es.onopen = () => { setConn('on', 'connected'); if (onReady && !readyFired) { readyFired = true; onReady(); } };
  es.onmessage = (ev) => handle(JSON.parse(ev.data));
  es.onerror = () => setConn('off', 'stream closed (is the server running?)');
}

// Persist server URL. `chrome` is undefined in a plain browser tab (only defined inside the
// extension), so guard on typeof — referencing a bare undefined `chrome` would throw and
// halt the whole script, leaving the page blank.
// Default the server address to the page's OWN origin when the panel is served by the
// server itself (i.e. a user opened http://<server-host>:5174/). This is the fix for
// "only works on my machine": the old hardcoded http://localhost:5174 pointed every
// visitor at THEIR OWN computer. Using location.origin makes any user who opens the
// deployed URL connect to the right server automatically.
// Hardcoded localhost is kept only for the Chrome extension context, where the panel is
// loaded from a chrome-extension:// origin and there is no server to infer.
(function defaultServerUrl() {
  const el = $('#server');
  const loc = (typeof window !== 'undefined' && window.location) ? window.location : null;
  const servedByServer = loc && /^https?:$/.test(loc.protocol) && loc.host;
  if (servedByServer) {
    el.value = loc.origin;      // e.g. http://203.0.113.5:5174
  }
  // else: keep the default (localhost) for the extension side panel.
})();

const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
if (hasChromeStorage) {
  // In the extension, a saved value may override — but only honour it inside the extension,
  // not when the page is served over http(s) (there, the page origin is authoritative).
  const servedByServer = typeof window !== 'undefined' && window.location && /^https?:$/.test(window.location.protocol);
  if (!servedByServer) {
    chrome.storage.local.get(['server'], (r) => { if (r.server) $('#server').value = r.server; });
  }
  $('#server').addEventListener('change', () => chrome.storage.local.set({ server: $('#server').value.trim() }));
}

$('#run').onclick = () => {
  const roles = [];
  if ($('#r-dealer').checked) roles.push('DEALER');
  if ($('#r-autogroup').checked) roles.push('AUTOGROUP');
  if (!roles.length) { setConn('off', 'pick at least one role'); return; }
  activeRoles = roles;
  $('#run').disabled = true; $('#run').textContent = 'Crawling…';
  $('#stop').disabled = false;
  colsEl.innerHTML = ''; cols.clear();
  for (const r of roles) col(r);
  layout();
  const exportsOn = $('#exp-toggle').checked;
  connect(async () => {
    try {
      await fetch(serverBase + '/start?roles=' + encodeURIComponent(roles.join(',')) + '&exports=' + (exportsOn ? 'on' : 'off'), { method: 'POST' });
    } catch (err) {
      setConn('off', 'server unreachable — run `npm run health`');
      $('#run').disabled = false; $('#run').textContent = 'Start';
      $('#stop').disabled = true;
    }
  });
};

// Export-testing toggle: reflect state, persist, and (if a crawl is not running) just save.
const expToggle = $('#exp-toggle');
function reflectToggle() { $('#exp-state').textContent = expToggle.checked ? 'ON' : 'OFF'; }
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(['exportsOn'], (r) => { if (typeof r.exportsOn === 'boolean') { expToggle.checked = r.exportsOn; reflectToggle(); } });
}
expToggle.addEventListener('change', () => {
  reflectToggle();
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) chrome.storage.local.set({ exportsOn: expToggle.checked });
});
reflectToggle();

$('#stop').onclick = async () => {
  $('#stop').disabled = true; $('#stop').textContent = 'Stopping…';
  try {
    await fetch(serverBase + '/stop', { method: 'POST' });
    setConn('wait', 'stopping after current screens…');
  } catch (err) {
    setConn('off', 'could not reach server to stop');
  }
  setTimeout(() => { $('#stop').textContent = 'Stop'; }, 2000);
};

// ---- View switching: Live Crawl vs Crawl Reports ----
document.querySelectorAll('.viewtabs .vt').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.viewtabs .vt').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.getElementById('view-' + b.dataset.view).classList.add('active');
    if (b.dataset.view === 'reports') loadReports();
  };
});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// For PDF/print, expand EVERY module's API detail so all APIs are visible in the printout.
// (On screen they stay collapsible.) Fired automatically before printing.
if (typeof window !== 'undefined' && window.matchMedia) {
  const openAllDetails = () => document.querySelectorAll('details.api-module').forEach((d) => { d.dataset._wasOpen = d.open ? '1' : '0'; d.open = true; });
  const restoreDetails = () => document.querySelectorAll('details.api-module').forEach((d) => { if (d.dataset._wasOpen === '0') d.open = false; });
  window.addEventListener('beforeprint', openAllDetails);
  window.addEventListener('afterprint', restoreDetails);
}

/** Build the module-wise API detail section (all APIs per module) + a slow-APIs summary.
 * Shared shape used by both Health and Performance report panels. */
function buildApiDetailSection(results) {
  // Slow-APIs summary first (across all modules).
  const slowRows = [];
  let sn = 1;
  for (const r of results) for (const a of (r.slowApis || [])) {
    slowRows.push(`<tr class="failrow"><td>${sn++}</td><td>${esc(r.name)}</td><td>${esc(a.name)}</td><td>${esc(a.method)}</td><td class="mono">${esc(a.endpoint)}</td><td>${esc(a.status)}</td><td><b>${esc(a.ms)}ms</b></td></tr>`);
  }
  const slowSection = slowRows.length
    ? `<h2 class="fail-h">Slow APIs (${slowRows.length}, exceeding benchmark)</h2>
       <table class="fail-table"><thead><tr><th>#</th><th>Module</th><th>API</th><th>Method</th><th>Endpoint</th><th>Status</th><th>Time</th></tr></thead><tbody>${slowRows.join('')}</tbody></table>`
    : `<h2 class="all-h">Slow APIs: none exceeded the benchmark</h2>`;

  // Per-module expandable blocks listing ALL APIs.
  const blocks = results.map((r) => {
    const apis = r.allApis || [];
    if (!apis.length) return '';
    const apiRows = apis.map((a) => `<tr${typeof a.ms === 'number' && r.slowThresholdMs && a.ms > r.slowThresholdMs ? ' class="failrow"' : ''}>
      <td>${esc(a.name)}</td><td>${esc(a.method)}</td><td class="mono">${esc(a.endpoint)}</td>
      <td class="mono" style="max-width:280px;overflow:hidden">${esc((a.payload || a.query || '').slice(0, 300))}</td>
      <td class="st ${a.status >= 400 ? 'bad' : 'ok'}">${esc(a.status)}</td>
      <td>${typeof a.ms === 'number' ? esc(a.ms) + 'ms' : '—'}</td><td>${a.count > 1 ? '×' + a.count : ''}</td></tr>`).join('');
    return `<details class="api-module"><summary><b>${esc(r.group)}${r.subGroup ? ' › ' + esc(r.subGroup) : ''} › ${esc(r.name)}</b> — ${apis.length} APIs</summary>
      <table class="fail-table"><thead><tr><th>API</th><th>Method</th><th>Endpoint</th><th>Query / Payload</th><th>Status</th><th>Time</th><th>×</th></tr></thead><tbody>${apiRows}</tbody></table></details>`;
  }).join('');

  return `<hr class="hist-sep"/>${slowSection}
    <h2 class="all-h">Module-wise API detail (all Fetch/XHR APIs)</h2>
    ${blocks || '<div class="hint">No API detail captured.</div>'}`;
}

async function loadReports() {
  const listEl = document.getElementById('reports-list');
  listEl.innerHTML = '<div class="hint">Loading…</div>';
  let reports = [];
  try {
    const base = $('#server').value.trim().replace(/\/$/, '');
    reports = await (await fetch(base + '/reports')).json();
  } catch (e) {
    listEl.innerHTML = `<div class="hint">Could not load reports: ${esc(e.message)}</div>`;
    return;
  }
  if (!reports.length) { listEl.innerHTML = '<div class="hint">No completed runs yet. Run a crawl first.</div>'; return; }
  listEl.innerHTML = '';
  reports.forEach((r) => {
    const s = r.summary || {};
    const item = document.createElement('div');
    item.className = 'report-item';
    item.innerHTML = `
      <div class="ri-role ${esc(r.role)}">${esc(r.role)}${r.dealerName ? ` · ${esc(r.dealerName)}` : ''}</div>
      <div class="ri-when">${esc(r.when || r.runId)}</div>
      <div class="ri-counts">✅ ${s.pass || 0} · ⚠️ ${s.warn || 0} · 🔴 ${s.fail || 0} · ⏭️ ${s.skip || 0}</div>`;
    item.onclick = () => {
      document.querySelectorAll('.report-item').forEach((x) => x.classList.remove('active'));
      item.classList.add('active');
      openReport(r.runId);
    };
    listEl.appendChild(item);
  });
}

async function openReport(runId) {
  const detail = document.getElementById('report-detail');
  detail.innerHTML = '<div class="hint">Loading report…</div>';
  const base = $('#server').value.trim().replace(/\/$/, '');
  let data;
  try {
    data = await (await fetch(base + '/report?run=' + encodeURIComponent(runId))).json();
  } catch (e) { detail.innerHTML = `<div class="hint">Could not load: ${esc(e.message)}</div>`; return; }

  const s = data.summary || {};
  const cfg = data.cfg || {};
  const whenPretty = data.startedAt || runId;

  // Build the "Failed APIs" section first — every failed request as its own row.
  const failRows = [];
  let fn = 1;
  (data.results || []).forEach((r) => {
    (r.failedApis || []).forEach((f) => {
      failRows.push(`<tr class="failrow">
        <td>${fn++}</td><td>${esc(r.name)}</td><td class="vb FAIL">${esc(f.status)}</td>
        <td>${esc(f.method || '-')}</td><td>${esc(f.kind)}</td><td class="mono">${esc(f.url)}</td></tr>`);
    });
    if (r.verdict === 'FAIL' && !(r.failedApis || []).length) {
      failRows.push(`<tr class="failrow">
        <td>${fn++}</td><td>${esc(r.name)}</td><td class="vb FAIL">${esc(r.httpStatus)}</td>
        <td>-</td><td>nav/other</td><td class="mono">${esc(r.reason)}</td></tr>`);
    }
  });
  const failSection = failRows.length
    ? `<h2 class="fail-h">Failed API Requests (${failRows.length})</h2>
       <table class="fail-table"><thead><tr><th>#</th><th>Module</th><th>Status</th><th>Method</th><th>Kind</th><th>API URL</th></tr></thead>
       <tbody>${failRows.join('')}</tbody></table>`
    : `<h2 class="fail-h ok">No failed API requests 🎉</h2>`;

  // Export tests section: every PDF/Excel/download button tested, success vs failure.
  const expRows = [];
  let en = 1;
  (data.results || []).forEach((r) => {
    (r.exports || []).forEach((e) => {
      expRows.push(`<tr class="${e.ok ? '' : 'failrow'}">
        <td>${en++}</td><td>${esc(r.name)}</td><td>${esc(e.tab || '(main)')}</td>
        <td>${esc(e.format)}</td><td class="vb ${e.ok ? 'PASS' : 'FAIL'}">${e.ok ? 'OK' : 'FAILED'}</td>
        <td>${esc(e.status)}</td><td class="mono">${esc(e.endpoint || e.error || '')}</td></tr>`);
    });
  });
  // Recurring API failures (same role, across all past runs) — the historical pattern view.
  const hist = data.history || null;
  const histRows = (hist?.recurringFailures || []).map((g, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="mono">${esc(g.endpoint)}</td>
      <td class="vb FAIL">${esc(g.count)}</td>
      <td>${esc(g.statuses)}</td>
      <td>${esc(g.firstSeen)}</td>
      <td>${esc(g.lastSeen)}</td>
      <td>${esc(g.weekdayPattern)}</td>
      <td>${esc(g.timePattern)}</td>
    </tr>`).join('');
  const historySection = hist
    ? (histRows
        ? `<h2 class="fail-h">Recurring API Failures — ${esc(hist.role)} history (${hist.recurringFailures.length} endpoint${hist.recurringFailures.length === 1 ? '' : 's'}, ${hist.totalRecords} calls logged)</h2>
           <table class="fail-table"><thead><tr><th>#</th><th>Endpoint</th><th>Fails</th><th>Statuses</th><th>First Seen</th><th>Last Seen</th><th>Weekday Pattern</th><th>Time Pattern</th></tr></thead>
           <tbody>${histRows}</tbody></table>`
        : `<h2 class="all-h">Recurring API Failures — ${esc(hist.role)} history: none recorded (${hist.totalRecords} calls logged)</h2>`)
    : '';

  const expFails = expRows.length - expRows.filter((h) => !h.includes('failrow')).length;
  const exportSection = expRows.length
    ? `<h2 class="${expFails ? 'fail-h' : 'all-h'}">Export Tests (${expRows.length}${expFails ? `, ${expFails} failed` : ', all OK'})</h2>
       <table class="fail-table"><thead><tr><th>#</th><th>Module</th><th>Tab</th><th>Format</th><th>Result</th><th>Status</th><th>Endpoint / Error</th></tr></thead>
       <tbody>${expRows.join('')}</tbody></table>`
    : `<h2 class="all-h">Export Tests — no export controls were found/tested</h2>`;

  const rows = (data.results || []).map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${esc(r.group)}</td>
      <td>${esc(r.subGroup || '')}</td>
      <td>${esc(r.name)}</td>
      <td class="vb ${esc(r.verdict)}">${esc(r.verdict)}</td>
      <td>${esc(r.httpStatus)}</td>
      <td>${r.apiCount || 0}</td>
      <td>${(r.failedApis || []).length}</td>
      <td>${r.exportsSummary ? `${r.exportsSummary.ok}/${r.exportsSummary.total}${r.exportsSummary.failed ? ` (${r.exportsSummary.failed}✗)` : ''}` : '-'}</td>
      <td>${esc(r.reason)}</td>
    </tr>`).join('');

  detail.innerHTML = `
    <div class="report-actions">
      <button class="btn" id="xlsx-btn">Export Excel</button>
      <button class="btn" id="csv-btn">Export CSV</button>
      <button class="btn" id="pdf-btn">Export PDF</button>
      <button class="mini" id="back-btn">Back to live</button>
    </div>
    <div id="print-area">
      <div class="pdf-doc">
        <h1>Dealership Health Report${cfg.dealerName ? ' — ' + esc(cfg.dealerName) : ''}</h1>
        <div class="sub">${cfg.dealerName ? esc(cfg.dealerName) + ' · ' : ''}Role ${esc(cfg.role || '')} · tenant ${esc(cfg.base || '')} · user ${esc(cfg.user || '')} · ${esc(whenPretty)}</div>
        <div class="totals">
          <span class="PASS">PASS ${s.pass || 0}</span>
          <span class="WARN">WARN ${s.warn || 0}</span>
          <span class="FAIL">FAIL ${s.fail || 0}</span>
          <span class="SKIP">SKIP ${s.skip || 0}</span>
          <span>Total ${s.total || 0}</span>
        </div>
        ${failSection}
        ${exportSection}
        <hr class="hist-sep" />
        <div class="hist-note">Historical data (this role, across all past runs) — separate from the current crawl above</div>
        ${historySection}
        <hr class="hist-sep" />
        <h2 class="all-h">All Modules (this crawl)</h2>
        <table>
          <thead><tr><th>#</th><th>Heading</th><th>Sub-Heading</th><th>Screen</th><th>Verdict</th><th>HTTP</th><th>APIs</th><th>Failed</th><th>Exports</th><th>Detail</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${buildApiDetailSection(data.results || [])}
      </div>
    </div>`;
  document.getElementById('xlsx-btn').onclick = () => { window.open(base + '/export.xlsx?run=' + encodeURIComponent(runId), '_blank'); };
  document.getElementById('csv-btn').onclick = () => { window.open(base + '/export.csv?run=' + encodeURIComponent(runId), '_blank'); };
  document.getElementById('pdf-btn').onclick = () => { document.querySelectorAll('details.api-module').forEach((d) => { d.open = true; }); window.print(); };
  document.getElementById('back-btn').onclick = () => document.querySelector('.viewtabs .vt[data-view="live"]').click();
}

document.getElementById('reports-refresh').onclick = loadReports;
document.getElementById('hist-csv').onclick = () => {
  const base = $('#server').value.trim().replace(/\/$/, '');
  window.open(base + '/api-log.csv', '_blank');
};
document.getElementById('hist-jsonl').onclick = () => {
  const base = $('#server').value.trim().replace(/\/$/, '');
  window.open(base + '/api-log.jsonl', '_blank');
};

connect();


/* ============================================================================
 * API PERFORMANCE TESTING — independent controller (own SSE, state, columns, reports).
 * Shares the page but not the health logic; talks to /perf/* endpoints on the same server.
 * ========================================================================== */
(function perfModule() {
  const pcolsEl = document.getElementById('pcols');
  let pes = null, pserverBase = '', pActiveRoles = [];
  const pcols = new Map();

  const V = { OK: 'OK', SLOW: 'SLOW', INFO: 'INFO', ERROR: 'ERROR' };

  function pSetConn(state, text) {
    const el = document.getElementById('pconn');
    el.className = 'dotc ' + (state === 'on' ? 'on' : state === 'off' ? 'off' : 'wait');
    if (text) document.getElementById('pmeta').textContent = text;
  }

  function pMakeColumn(role) {
    const meta = ROLE_META[role] || { label: role, cls: 'd' };
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `
      <div class="colhead">
        <div class="rname"><span class="${meta.cls}">${meta.label}</span></div>
        <div class="colmeta" data-meta>waiting…</div>
        <div class="counts">
          <span class="chip total" data-c="total">0</span>
          <span class="chip pass" data-c="ok">0 ok</span>
          <span class="chip fail" data-c="slow">0 slow</span>
          <span class="chip" data-c="info" style="color:var(--info)">0 info</span>
          <span class="chip fail" data-c="error">0 err</span>
        </div>
      </div>
      <div class="bar"><div data-progress></div></div>
      <div class="colbody"><div class="pane active"><div class="logbox" data-perf-list></div></div></div>`;
    pcolsEl.appendChild(col);
    return {
      role, el: col, listEl: col.querySelector('[data-perf-list]'),
      metaEl: col.querySelector('[data-meta]'), progressEl: col.querySelector('[data-progress]'),
      counts: { total: 0, ok: 0, slow: 0, info: 0, error: 0 }, total: 0, runId: '', dealerName: '',
    };
  }
  const pcol = (role) => { if (!pcols.has(role)) pcols.set(role, pMakeColumn(role)); return pcols.get(role); };
  function pLayout() { pcolsEl.classList.toggle('single', pcols.size <= 1); }
  function pUpdateCounts(c) {
    c.el.querySelector('[data-c="total"]').textContent = c.counts.total;
    c.el.querySelector('[data-c="ok"]').textContent = c.counts.ok + ' ok';
    c.el.querySelector('[data-c="slow"]').textContent = c.counts.slow + ' slow';
    c.el.querySelector('[data-c="info"]').textContent = c.counts.info + ' info';
    c.el.querySelector('[data-c="error"]').textContent = c.counts.error + ' err';
  }
  function pRow(c, e) {
    const v = (e.verdict || 'INFO');
    const d = document.createElement('div');
    d.className = 'line';
    const timings = (e.timingsSec || []).length > 1 ? ` (${e.timingsSec.join(', ')})` : '';
    d.innerHTML = `<span class="vb ${v}">${v}</span> ${esc(e.avgSec)}s${esc(timings)} · <b>${esc(e.name)}</b> <span style="color:var(--mut)">[${esc(e.group)}] · ${esc(e.filterLabel || e.filter)}/${esc(e.scope)} · benchmark ${esc(e.benchmark)}</span>`;
    c.listEl.appendChild(d);
    const key = v.toLowerCase() === 'ok' ? 'ok' : v.toLowerCase();
    c.counts[key] = (c.counts[key] || 0) + 1;
    c.counts.total++;
    pUpdateCounts(c);
    const pct = c.total ? Math.round((c.counts.total / c.total) * 100) : 0;
    c.progressEl.style.width = pct + '%';
  }

  // Discovery results collected per role, used to build the confirmation dialog.
  const pDiscovery = { roles: [], byRole: {}, dealerName: '' };

  function pHandle(e) {
    // ---- Discovery-only phase (no measurement) ----
    if (e.type === 'perf-discover-batch-start') {
      pDiscovery.roles = e.roles.slice(); pDiscovery.byRole = {}; pDiscovery.dealerName = '';
      pSetConn('wait', `discovering reports for ${e.roles.join(' + ')}… (no measurement yet)`);
      return;
    }
    if (e.type === 'perf-discover-progress') {
      pSetConn('wait', `discovering ${e.role}: ${e.index + 1}/${e.total} — ${e.name}`);
      return;
    }
    if (e.type === 'perf-dealer') { pDiscovery.dealerName = e.name; setTargetDealer(e.name); return; }
    if (e.type === 'perf-discover-done') {
      if (e.ok) pDiscovery.byRole[e.role] = e.reports || [];
      else pDiscovery.byRole[e.role] = [];
      return;
    }
    if (e.type === 'perf-discover-batch-done') {
      pSetConn('on', 'discovery complete — review and confirm');
      showConfirm();
      return;
    }
    if (e.type === 'perf-batch-start') {
      pcolsEl.innerHTML = ''; pcols.clear();
      for (const r of e.roles) pcol(r);
      pLayout(); pSetConn('on', `running ${e.roles.join(' + ')}`);
      return;
    }
    if (e.type === 'perf-batch-done') {
      pSetConn('on', `${e.stopped ? 'stopped' : 'finished'} ${e.roles.join(' + ')}`);
      document.getElementById('prun').disabled = false; document.getElementById('prun').textContent = 'Run again';
      document.getElementById('pstop').disabled = true;
      return;
    }
    const role = e.role || pActiveRoles[0] || 'DEALER';
    const c = pcol(role); pLayout();
    switch (e.type) {
      case 'perf-run-start': c.runId = e.runId; c.metaEl.textContent = `${e.user} @ ${e.base} — measuring…`; if (e.base) setTargetUrl(e.base); break;
      case 'perf-dealer': c.dealerName = e.name; setTargetDealer(e.name); break;
      case 'perf-modules': c.total = e.total; c.metaEl.textContent = `${c.dealerName ? c.dealerName + ' — ' : ''}${e.total} report(s)`; break;
      case 'perf-screen-start': break;
      case 'perf-screen-done': pRow(c, e); break;
      case 'perf-done': { const s = e.summary || {}; const dd = document.createElement('div'); dd.className = 'line evt'; dd.textContent = `Done. OK ${s.ok_count || 0} / SLOW ${s.slow || 0} / INFO ${s.info || 0} / ERR ${s.error || 0}`; c.listEl.appendChild(dd); break; }
      case 'log': { const dd = document.createElement('div'); dd.className = 'line evt'; dd.textContent = e.msg; c.listEl.appendChild(dd); break; }
    }
  }

  function pConnect(onReady) {
    pserverBase = $('#server').value.trim().replace(/\/$/, '');
    if (pes) { pes.close(); pes = null; }
    pSetConn('wait', 'connecting…');
    fetch(pserverBase + '/perf/target').then((r) => r.json()).then((t) => { if (t && t.url) setTargetUrl(t.url); }).catch(() => {});
    pes = new EventSource(pserverBase + '/perf/events');
    // One-shot onReady: never re-fire on an SSE reconnect (that was auto-restarting runs).
    let pReadyFired = false;
    pes.onopen = () => { pSetConn('on', 'connected'); if (onReady && !pReadyFired) { pReadyFired = true; onReady(); } };
    pes.onmessage = (ev) => pHandle(JSON.parse(ev.data));
    pes.onerror = () => pSetConn('off', 'stream closed (is the server running?)');
  }

  // Read current selections from the controls.
  function pSelections() {
    const roles = [];
    if (document.getElementById('pr-dealer').checked) roles.push('DEALER');
    if (document.getElementById('pr-autogroup').checked) roles.push('AUTOGROUP');
    const filters = [...document.querySelectorAll('.pfilter:checked')].map((c) => c.value);
    const scopes = [];
    if (document.getElementById('psc-single').checked) scopes.push('single');
    if (document.getElementById('psc-all').checked) scopes.push('all');
    const reps = Number((document.querySelector('input[name="preps"]:checked') || {}).value || 3);
    return { roles, filters, scopes, reps };
  }

  const FILTER_LABELS = { month: 'Single Month (MTD)', 'multi-month': 'Multi-Month', ytd: 'YTD', pytd: 'PYTD', alltime: 'All Time' };
  const SECONDS_PER_MEASUREMENT = 9; // labeled ASSUMPTION until live calibration (after Confirm)

  // "Run" = discovery only. No measurement happens until the user confirms the dialog.
  document.getElementById('prun').onclick = () => {
    const sel = pSelections();
    if (!sel.roles.length) { pSetConn('off', 'pick at least one role'); return; }
    if (!sel.filters.length) { pSetConn('off', 'pick at least one date filter'); return; }
    if (!sel.scopes.length) { pSetConn('off', 'pick at least one AutoGroup scope'); return; }
    pActiveRoles = sel.roles;
    document.getElementById('prun').disabled = true; document.getElementById('prun').textContent = 'Discovering…';
    document.getElementById('pstop').disabled = false;
    pConnect(async () => {
      try { await fetch(pserverBase + '/perf/discover?roles=' + encodeURIComponent(sel.roles.join(',')), { method: 'POST' }); }
      catch { pSetConn('off', 'server unreachable'); document.getElementById('prun').disabled = false; document.getElementById('prun').textContent = 'Run (discover & estimate)'; document.getElementById('pstop').disabled = true; }
    });
  };

  // Build & show the confirmation dialog from discovery results + current selections.
  function showConfirm() {
    const sel = pSelections();
    // Compute exact configuration count.
    // DEALER: always single scope. AUTOGROUP: the selected scopes (single/all).
    let configs = 0;
    const perRoleLines = [];
    for (const role of sel.roles) {
      const reports = pDiscovery.byRole[role] || [];
      const withFilter = reports.filter((r) => r.hasDateFilter).length;
      const noFilter = reports.length - withFilter;
      const roleScopes = role === 'DEALER' ? ['single'] : sel.scopes;
      // filter-supporting reports: (selected filters) per scope; no-filter reports: 1 per scope.
      const roleConfigs = roleScopes.length * (withFilter * sel.filters.length + noFilter);
      configs += roleConfigs;
      perRoleLines.push(`<div>• <b>${role}</b>: ${reports.length} reports (${withFilter} date-filterable, ${noFilter} no-filter) × ${roleScopes.length} scope(s) → <b>${roleConfigs}</b> configs</div>`);
    }
    const totalMeasurements = configs * sel.reps;
    const estSec = totalMeasurements * SECONDS_PER_MEASUREMENT;
    const estMin = Math.round(estSec / 60);
    const estText = estMin >= 60 ? `${Math.floor(estMin / 60)}h ${estMin % 60}m` : `${estMin} min`;

    document.getElementById('pc-body').innerHTML = `
      <div><b>Date filters:</b> ${sel.filters.map((f) => FILTER_LABELS[f] || f).join(', ')}</div>
      <div><b>AutoGroup scope:</b> ${sel.scopes.join(' + ')} &nbsp; | &nbsp; <b>Repetitions:</b> ${sel.reps}×</div>
      <hr style="border:0;border-top:1px solid var(--line);margin:8px 0"/>
      ${perRoleLines.join('')}
      <hr style="border:0;border-top:1px solid var(--line);margin:8px 0"/>
      <div><b>Total test configurations:</b> ${configs}</div>
      <div><b>Total measurements (× ${sel.reps} reps):</b> ${totalMeasurements}</div>
      <div><b>Estimated duration:</b> ~${estText}</div>
      <span class="pc-note">Estimate is approximate — it assumes ~${SECONDS_PER_MEASUREMENT}s per measurement (navigate + apply filter + render + settle). The tool will calibrate against the first few real measurements after you confirm and refine the live estimate. No measurements have run yet.</span>`;
    document.getElementById('perf-confirm').style.display = 'flex';
    document.getElementById('prun').disabled = false; document.getElementById('prun').textContent = 'Run (discover & estimate)';
    document.getElementById('pstop').disabled = true;
  }

  document.getElementById('pc-cancel').onclick = () => {
    document.getElementById('perf-confirm').style.display = 'none';
    pSetConn('on', 'cancelled — no measurements run');
  };
  document.getElementById('pc-confirm').onclick = async () => {
    document.getElementById('perf-confirm').style.display = 'none';
    const sel = pSelections();
    // Pass the full selection to the real run (measurement engine — final step).
    pcolsEl.innerHTML = ''; pcols.clear();
    for (const r of sel.roles) pcol(r);
    pLayout();
    document.getElementById('prun').disabled = true; document.getElementById('prun').textContent = 'Running…';
    document.getElementById('pstop').disabled = false;
    const qs = new URLSearchParams({ roles: sel.roles.join(','), filters: sel.filters.join(','), scopes: sel.scopes.join(','), reps: String(sel.reps) }).toString();
    try { await fetch(pserverBase + '/perf/start?' + qs, { method: 'POST' }); }
    catch { pSetConn('off', 'server unreachable'); document.getElementById('prun').disabled = false; document.getElementById('prun').textContent = 'Run (discover & estimate)'; document.getElementById('pstop').disabled = true; }
  };
  document.getElementById('pstop').onclick = async () => {
    document.getElementById('pstop').disabled = true; document.getElementById('pstop').textContent = 'Stopping…';
    try { await fetch(pserverBase + '/perf/stop', { method: 'POST' }); pSetConn('wait', 'stopping…'); } catch {}
    setTimeout(() => { document.getElementById('pstop').textContent = 'Stop'; }, 2000);
  };

  // Perf view tabs
  document.querySelectorAll('.pvt').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.pvt').forEach((x) => x.classList.toggle('active', x === b));
      document.getElementById('view-perf-live').classList.toggle('active', b.dataset.pview === 'live');
      document.getElementById('view-perf-reports').classList.toggle('active', b.dataset.pview === 'reports');
      if (b.dataset.pview === 'reports') pLoadReports();
    };
  });

  async function pLoadReports() {
    const listEl = document.getElementById('perf-reports-list');
    listEl.innerHTML = '<div class="hint">Loading…</div>';
    let reports = [];
    try { reports = await (await fetch($('#server').value.trim().replace(/\/$/, '') + '/perf/reports')).json(); }
    catch (e) { listEl.innerHTML = `<div class="hint">Could not load: ${esc(e.message)}</div>`; return; }
    if (!reports.length) { listEl.innerHTML = '<div class="hint">No performance runs yet.</div>'; return; }
    listEl.innerHTML = '';
    reports.forEach((r) => {
      const s = r.summary || {};
      const item = document.createElement('div');
      item.className = 'report-item';
      item.innerHTML = `<div class="ri-role ${esc(r.role)}">${esc(r.role)}${r.dealerName ? ' · ' + esc(r.dealerName) : ''}</div>
        <div class="ri-when">${esc(r.when || r.runId)}</div>
        <div class="ri-counts">✅ ${s.ok_count || 0} ok · 🔴 ${s.slow || 0} slow · ℹ️ ${s.info || 0} · ⚠️ ${s.error || 0} err</div>`;
      item.onclick = () => { document.querySelectorAll('#perf-reports-list .report-item').forEach((x) => x.classList.remove('active')); item.classList.add('active'); pOpenReport(r.runId); };
      listEl.appendChild(item);
    });
  }

  async function pOpenReport(runId) {
    const detail = document.getElementById('perf-report-detail');
    detail.innerHTML = '<div class="hint">Loading…</div>';
    const base = $('#server').value.trim().replace(/\/$/, '');
    let data; try { data = await (await fetch(base + '/perf/report?run=' + encodeURIComponent(runId))).json(); }
    catch (e) { detail.innerHTML = `<div class="hint">Could not load: ${esc(e.message)}</div>`; return; }
    const cfg = data.cfg || {}; const s = data.summary || {};
    const rows = (data.results || []).map((r, i) => `<tr${r.verdict === 'SLOW' || r.verdict === 'ERROR' ? ' class="failrow"' : ''}>
      <td>${i + 1}</td><td>${esc(r.group)}</td><td>${esc(r.subGroup || '')}</td><td>${esc(r.name)}</td>
      <td>${esc(r.filterLabel || r.filter)}</td><td>${esc(r.scope)}</td><td class="mono">${esc(r.dateRange || '')}</td>
      <td>${esc(r.avgSec)}s</td><td>${esc((r.timingsSec || []).join(', '))}</td><td>${esc(r.benchmark)}</td>
      <td class="vb ${esc(r.verdict)}">${esc(r.verdict)}</td></tr>`).join('');
    detail.innerHTML = `
      <div class="report-actions">
        <button class="btn" id="pperf-xlsx">Export Excel</button>
        <button class="btn" id="pperf-csv">Export CSV</button>
        <button class="btn" id="pperf-pdf">Export PDF</button>
      </div>
      <div id="print-area"><div class="pdf-doc">
        <h1>API Performance Report${cfg.dealerName ? ' — ' + esc(cfg.dealerName) : ''}</h1>
        <div class="sub">${cfg.dealerName ? esc(cfg.dealerName) + ' · ' : ''}Role ${esc(cfg.role || '')} · ${esc(cfg.base || '')} · ${esc(data.startedAt || '')}${cfg.reps ? ' · ' + esc(cfg.reps) + '× reps' : ''}</div>
        <div class="totals"><span class="PASS">OK ${s.ok_count || 0}</span> <span class="FAIL">SLOW ${s.slow || 0}</span> <span>INFO ${s.info || 0}</span> <span class="FAIL">ERROR ${s.error || 0}</span> <span>Total ${s.total || 0}</span></div>
        <table><thead><tr><th>#</th><th>Heading</th><th>Sub-Heading</th><th>Report</th><th>Filter</th><th>Scope</th><th>Date Range</th><th>Avg</th><th>Individual</th><th>Benchmark</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table>
        ${buildApiDetailSection((data.results || []).map((r) => ({ ...r, name: `${r.name} · ${r.filterLabel || r.filter}/${r.scope}` })))}
      </div></div>`;
    document.getElementById('pperf-xlsx').onclick = () => window.open(base + '/perf/export.xlsx?run=' + encodeURIComponent(runId), '_blank');
    document.getElementById('pperf-csv').onclick = () => window.open(base + '/perf/export.csv?run=' + encodeURIComponent(runId), '_blank');
    document.getElementById('pperf-pdf').onclick = () => { document.querySelectorAll('details.api-module').forEach((d) => { d.open = true; }); window.print(); };
  }
  document.getElementById('perf-reports-refresh').onclick = pLoadReports;

  // ---- Mode switch: Health / Performance / Settings ----
  const healthCtrls = document.getElementById('mode-health-controls');
  const perfCtrls = document.getElementById('mode-perf-controls');
  const settingsCtrls = document.getElementById('mode-settings-controls');
  const healthViews = ['view-live', 'view-reports'];
  const perfViews = ['view-perf-live', 'view-perf-reports'];
  function setMode(mode) {
    const perf = mode === 'perf';
    const settings = mode === 'settings';
    document.getElementById('ms-health').classList.toggle('active', mode === 'health');
    document.getElementById('ms-perf').classList.toggle('active', perf);
    document.getElementById('ms-settings').classList.toggle('active', settings);
    healthCtrls.style.display = mode === 'health' ? '' : 'none';
    perfCtrls.style.display = perf ? '' : 'none';
    settingsCtrls.style.display = settings ? '' : 'none';
    // Hide all content views in settings mode (the form lives in the header controls).
    healthViews.forEach((id) => document.getElementById(id).classList.toggle('active', mode === 'health' && id === 'view-live'));
    perfViews.forEach((id) => document.getElementById(id).classList.toggle('active', perf && id === 'view-perf-live'));
    if (perf) pConnect();
    if (settings) loadSettings();
  }
  document.getElementById('ms-health').onclick = () => setMode('health');
  document.getElementById('ms-perf').onclick = () => setMode('perf');
  document.getElementById('ms-settings').onclick = () => setMode('settings');

  // ---- Settings tab: load current, save new (Target URL / Username / Password) ----
  async function loadSettings() {
    const base = $('#server').value.trim().replace(/\/$/, '');
    try {
      const s = await (await fetch(base + '/settings')).json();
      document.getElementById('set-base').value = s.base || '';
      document.getElementById('set-user').value = s.username || '';
      document.getElementById('set-pass').value = ''; // never prefill the password
      document.getElementById('set-pass-note').textContent = s.passwordSet
        ? `A password is set (source: ${s.source?.password || 'env'}). Leave blank to keep it.`
        : 'No password set — will use .env.';
      document.getElementById('set-status').textContent = '';
    } catch {
      document.getElementById('set-status').textContent = 'Could not load settings (is the server running?)';
      document.getElementById('set-status').className = 'settings-status err';
    }
  }
  document.getElementById('set-save').onclick = async () => {
    const base = $('#server').value.trim().replace(/\/$/, '');
    const payload = {
      base: document.getElementById('set-base').value.trim(),
      username: document.getElementById('set-user').value.trim(),
    };
    const pass = document.getElementById('set-pass').value;
    if (pass) payload.password = pass; // only send if the user typed one
    const st = document.getElementById('set-status');
    st.className = 'settings-status'; st.textContent = 'Saving…';
    try {
      const r = await (await fetch(base + '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
      st.textContent = `Saved. Target: ${r.base} · user: ${r.username || '(env)'} · password: ${r.passwordSet ? 'set' : '(env/none)'}`;
      document.getElementById('set-pass').value = '';
      setTargetUrl(r.base); // update the header banner immediately
      document.getElementById('set-pass-note').textContent = r.passwordSet ? 'A password is set. Leave blank to keep it.' : 'No password set — will use .env.';
    } catch (e) {
      st.className = 'settings-status err'; st.textContent = 'Save failed: ' + e.message;
    }
  };
})();
