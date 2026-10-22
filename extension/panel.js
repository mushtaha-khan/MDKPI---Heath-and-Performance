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
      log(c, `Run started as ${e.user} (${role}); logging in…`, 'evt');
      break;
    case 'dealer':
      c.dealerName = e.name;
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
  es = new EventSource(serverBase + '/events');
  es.onopen = () => { setConn('on', 'connected'); onReady && onReady(); };
  es.onmessage = (ev) => handle(JSON.parse(ev.data));
  es.onerror = () => setConn('off', 'stream closed (is `npm run health` running?)');
}

// Persist server URL. `chrome` is undefined in a plain browser tab (only defined inside the
// extension), so guard on typeof — referencing a bare undefined `chrome` would throw and
// halt the whole script, leaving the page blank.
const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
if (hasChromeStorage) {
  chrome.storage.local.get(['server'], (r) => { if (r.server) $('#server').value = r.server; });
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
      </div>
    </div>`;
  document.getElementById('xlsx-btn').onclick = () => { window.open(base + '/export.xlsx?run=' + encodeURIComponent(runId), '_blank'); };
  document.getElementById('csv-btn').onclick = () => { window.open(base + '/export.csv?run=' + encodeURIComponent(runId), '_blank'); };
  document.getElementById('pdf-btn').onclick = () => window.print();
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
