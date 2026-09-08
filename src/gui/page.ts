/**
 * The GUI page, served inline so there is no build step and no external assets.
 *
 * Talks to the control server over a small JSON API plus one Server-Sent Events
 * stream for live progress, so a run's output appears as it happens rather than
 * only at the end.
 */
export function renderGuiPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Dealer KPI — Reconciliation Runner</title>
<style>
:root{--bg:#0f1014;--panel:#16181f;--panel2:#1c1f28;--line:#272b36;--fg:#e7e9f0;--dim:#9aa0b0;
--ok:#2f9e5f;--okbg:#12301f;--bad:#d1495b;--badbg:#33151b;--warn:#c9821a;--warnbg:#33260f;--accent:#a9232e;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
header{padding:22px 32px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#15171d,#0f1014);
display:flex;align-items:center;gap:16px;flex-wrap:wrap}
h1{margin:0;font-size:19px}
h1 .k{color:var(--accent)}
header .sub{color:var(--dim);font-size:13px;flex:1;min-width:200px}
main{padding:24px 32px 64px;max-width:1250px}
h2{font-size:15px;margin:0 0 12px;text-transform:uppercase;letter-spacing:.7px;color:var(--dim)}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px 22px;margin-bottom:22px}
label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);margin:0 0 5px}
input[type=text],input[type=url],select{width:100%;background:var(--panel2);border:1px solid var(--line);
color:var(--fg);padding:9px 11px;border-radius:7px;font-size:13px;font-family:inherit}
input:focus,select:focus{outline:none;border-color:var(--accent)}
input.bad{border-color:var(--bad)}
.grid{display:grid;gap:16px}
.g2{grid-template-columns:1fr 1fr}
@media(max-width:840px){.g2{grid-template-columns:1fr}}
.field{margin-bottom:16px}
.hint{color:var(--dim);font-size:12px;margin-top:5px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
button{background:var(--accent);border:0;color:#fff;padding:11px 22px;border-radius:7px;cursor:pointer;
font-size:14px;font-weight:600;font-family:inherit}
button:hover{filter:brightness(1.12)}
button:disabled{opacity:.5;cursor:not-allowed;filter:none}
button.ghost{background:var(--panel2);border:1px solid var(--line);color:var(--fg);font-weight:500}
details.adv{background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:12px 14px;margin-top:4px}
details.adv summary{cursor:pointer;color:var(--dim);font-size:13px}
details.adv .grid{margin-top:14px}
.chk{display:flex;align-items:center;gap:7px;color:var(--fg);font-size:13px;text-transform:none;letter-spacing:0}
.stages{display:flex;flex-direction:column;gap:7px;margin:4px 0 14px}
.stage{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--dim)}
.stage .dot{width:9px;height:9px;border-radius:50%;background:#2a2e39;flex:none}
.stage.active{color:var(--fg)}.stage.active .dot{background:var(--warn);box-shadow:0 0 0 3px var(--warnbg)}
.stage.done{color:var(--fg)}.stage.done .dot{background:var(--ok)}
.stage.failed{color:#ff8095}.stage.failed .dot{background:var(--bad)}
pre.log{background:#0b0c10;border:1px solid var(--line);border-radius:7px;padding:12px 14px;margin:0;
max-height:340px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;
white-space:pre-wrap;color:#c9cdd8}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid var(--line);padding:8px 11px;text-align:left}
thead th{background:var(--panel2);color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.5px}
tbody tr:hover{background:#1a1d25}
a{color:#ff8095;text-decoration:none}a:hover{text-decoration:underline}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--dim)}
.b{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap}
.b-ok{background:var(--okbg);color:#61d68f;border:1px solid #245c3b}
.b-bad{background:var(--badbg);color:#ff8095;border:1px solid #6b2431}
.b-warn{background:var(--warnbg);color:#e5ab4e;border:1px solid #6b5320}
.b-dim{background:#20232c;color:var(--dim);border:1px solid var(--line)}
.runbar{display:flex;gap:14px;align-items:center;margin:-4px 0 12px}
button.linkish{background:none;border:0;color:#ff8095;padding:0;font-weight:500;font-size:13px}
button.linkish:hover{text-decoration:underline;filter:none}
button.rowbtn{background:var(--panel2);border:1px solid var(--line);color:var(--dim);
padding:4px 11px;border-radius:6px;font-size:12px;font-weight:500}
button.rowbtn:hover{color:var(--fg);border-color:#3a4050;filter:none}
button.rowbtn.danger:hover{color:#ff8095;border-color:#6b2431}
tr.pending{opacity:.45}
.banner{border-radius:8px;padding:14px 18px;margin-bottom:16px;border:1px solid var(--line);
border-left:3px solid var(--accent);background:var(--panel2);display:none}
.banner.show{display:block}
.banner.ok{border-left-color:var(--ok)}
.banner.bad{border-left-color:var(--bad)}
.banner h3{margin:0 0 6px;font-size:15px}
.banner p{margin:4px 0;color:#c9cdd8}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:9px 14px;min-width:96px}
.card .n{font-size:19px;font-weight:600}
.card .l{color:var(--dim);font-size:11px}
.card.ok .n{color:var(--ok)}.card.bad .n{color:var(--bad)}
.err{color:#ff8095;font-size:12px;margin-top:5px;display:none}
.err.show{display:block}
.spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.25);
border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes sp{to{transform:rotate(360deg)}}
</style></head><body>

<header>
  <h1>My Dealer <span class="k">KPI</span> &mdash; Reconciliation Runner</h1>
  <div class="sub">Enter both module URLs. The runner crawls each screen, matches rows and formulas, and produces a dated report.</div>
  <a href="/runs/" target="_blank" class="mono">open runs folder index &rarr;</a>
</header>

<main>

  <section>
    <h2>New run</h2>
    <div class="grid g2">
      <div class="field">
        <label for="ag">AutoGroup screen URL <span style="color:var(--accent)">*</span></label>
        <input type="url" id="ag" placeholder="https://your-tenant.mydealerkpi.com/auto-group-v2/service/service-summary" autocomplete="off">
        <div class="err" id="ag-err"></div>
      </div>
      <div class="field">
        <label for="dms">DMS screen URL <span style="color:var(--accent)">*</span></label>
        <input type="url" id="dms" placeholder="https://your-tenant.mydealerkpi.com/report/services/dashboard" autocomplete="off">
        <div class="err" id="dms-err"></div>
      </div>
    </div>

    <div class="field">
      <label for="mod">Module name</label>
      <input type="text" id="mod" placeholder="Leave blank to derive from the AutoGroup URL" autocomplete="off">
      <div class="hint">Used in the report title and the report filename, alongside the run date and time.</div>
    </div>

    <details class="adv">
      <summary>Advanced options</summary>
      <div class="grid g2">
        <div>
          <label for="agRole">AutoGroup login role</label>
          <input type="text" id="agRole" value="AUTOGROUP" autocomplete="off">
        </div>
        <div>
          <label for="dmsRole">DMS login role</label>
          <input type="text" id="dmsRole" value="DEALER" autocomplete="off">
        </div>
      </div>
      <div class="grid" style="margin-top:14px">
        <label class="chk"><input type="checkbox" id="formulas" checked> Harvest formulas from tooltips and validate them (adds ~30s)</label>
        <label class="chk"><input type="checkbox" id="reuse"> Reuse existing captures instead of crawling (no portal access, fast)</label>
        <div class="field" id="reuse-from-field" style="display:none;margin:6px 0 0 26px">
          <label for="reuse-from">Captures to reuse</label>
          <select id="reuse-from"><option value="">Most recent available</option></select>
          <p class="hint">Re-runs the comparison against a captured snapshot. Pick a specific run to compare
            the same data again after a change, rather than whatever was captured last.</p>
        </div>
      </div>
    </details>

    <div class="row" style="margin-top:18px">
      <button id="run">Run reconciliation</button>
      <button id="cancel" class="ghost" style="display:none">Stop</button>
      <span class="mono" id="elapsed"></span>
    </div>
  </section>

  <section id="progress-sec" style="display:none">
    <h2>Progress</h2>
    <div class="banner" id="banner"></div>
    <div class="stages" id="stages"></div>
    <pre class="log" id="log"></pre>
  </section>

  <section>
    <h2>Reports <span class="mono" id="run-count"></span></h2>
    <p class="hint" style="margin:-6px 0 12px">Every run started from this panel, newest first.
      Command-line runs are not listed here.</p>
    <div class="runbar">
      <button type="button" class="linkish" id="toggle-deleted">Show deleted</button>
      <span class="mono" id="del-note"></span>
    </div>
    <table>
      <thead><tr>
        <th>Module</th><th>Run date &amp; time</th><th>Result</th>
        <th>Data matched</th><th>Checks run</th><th>Formulas</th><th>Report</th><th></th>
      </tr></thead>
      <tbody id="runs"><tr><td colspan="8" class="mono">Loading…</td></tr></tbody>
    </table>

    <div id="deleted-sec" style="display:none;margin-top:22px">
      <h3>Deleted reports <span class="mono" id="del-count"></span></h3>
      <p class="hint" style="margin:-6px 0 12px">Deleting only hides a report. Nothing is removed from
        disk &mdash; the captures, screenshots and harvested formulas are a record of what the portal showed
        at that moment and cannot be reproduced later, so they are kept and can be restored.</p>
      <table>
        <thead><tr>
          <th>Module</th><th>Run date &amp; time</th><th>Deleted</th><th>Result</th><th>Report</th><th></th>
        </tr></thead>
        <tbody id="deleted-runs"><tr><td colspan="6" class="mono">None.</td></tr></tbody>
      </table>
    </div>
  </section>

</main>

<script>
var STAGE_LABELS = [
  'Capture AutoGroup screen',
  'Capture DMS screen',
  'Harvest and validate formulas',
  'Compare and build report'
];
var es = null, startedAt = 0, timer = null, currentRunId = null;

function $(id){ return document.getElementById(id); }

function setStages(activeIdx, failedIdx){
  var host = $('stages'); host.innerHTML = '';
  STAGE_LABELS.forEach(function(label, i){
    var cls = 'stage';
    if (failedIdx === i) cls += ' failed';
    else if (i < activeIdx) cls += ' done';
    else if (i === activeIdx) cls += ' active';
    var d = document.createElement('div');
    d.className = cls;
    d.innerHTML = '<span class="dot"></span><span>' + label + '</span>';
    host.appendChild(d);
  });
}

function appendLog(text){
  var el = $('log');
  el.textContent += text;
  el.scrollTop = el.scrollHeight;
}

function showBanner(kind, html){
  var b = $('banner');
  b.className = 'banner show ' + kind;
  b.innerHTML = html;
}

function tickElapsed(){
  var s = Math.floor((Date.now() - startedAt) / 1000);
  $('elapsed').textContent = 'running ' + Math.floor(s/60) + 'm ' + (s%60) + 's';
}

function validate(){
  var ok = true;
  [['ag','AutoGroup'],['dms','DMS']].forEach(function(pair){
    var el = $(pair[0]), err = $(pair[0] + '-err');
    var v = el.value.trim();
    var bad = '';
    if (!v) bad = pair[1] + ' URL is required.';
    else {
      try {
        var u = new URL(v);
        if (u.protocol !== 'https:' && u.hostname !== 'localhost') bad = 'Expected an https URL.';
      } catch(e){ bad = 'That is not a valid URL.'; }
    }
    el.classList.toggle('bad', !!bad);
    err.className = 'err' + (bad ? ' show' : '');
    err.textContent = bad;
    if (bad) ok = false;
  });
  return ok;
}

function setRunning(on){
  $('run').disabled = on;
  $('cancel').style.display = on ? '' : 'none';
  $('run').innerHTML = on ? '<span class="spin"></span>Running…' : 'Run reconciliation';
}

$('run').addEventListener('click', function(){
  if (!validate()) return;

  var body = {
    autogroup: $('ag').value.trim(),
    dms: $('dms').value.trim(),
    module: $('mod').value.trim(),
    autogroupRole: $('agRole').value.trim(),
    dmsRole: $('dmsRole').value.trim(),
    formulas: $('formulas').checked,
    reuse: $('reuse').checked,
    reuseFrom: $('reuse').checked ? $('reuse-from').value : ''
  };

  $('progress-sec').style.display = '';
  $('log').textContent = '';
  $('banner').className = 'banner';
  setStages(0, -1);
  setRunning(true);
  startedAt = Date.now();
  tickElapsed();
  timer = setInterval(tickElapsed, 1000);

  fetch('/api/run', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  }).then(function(r){ return r.json(); }).then(function(res){
    if (res.error){ finish('bad', '<h3>Could not start</h3><p>' + res.error + '</p>'); return; }
    currentRunId = res.runId;
    listen();
  }).catch(function(e){
    finish('bad', '<h3>Could not start</h3><p>' + e.message + '</p>');
  });
});

$('cancel').addEventListener('click', function(){
  fetch('/api/cancel', {method:'POST'}).then(function(){
    appendLog('\\n[stop requested]\\n');
  });
});

function listen(){
  if (es) es.close();
  es = new EventSource('/api/stream');

  es.addEventListener('log', function(ev){
    var d = JSON.parse(ev.data);
    appendLog(d.text);
    // Advance the stage indicator from the runner's own stage banners.
    var m = /^\\[(\\d+)\\/(\\d+)\\]/m.exec(d.text);
    if (m) setStages(Number(m[1]) - 1, -1);
    if (/Compare and build report/.test(d.text)) setStages(3, -1);
  });

  es.addEventListener('done', function(ev){
    var d = JSON.parse(ev.data);
    if (d.ok && d.meta){
      var s = d.meta.summary || {};
      var diff = (s.mismatched || 0) + (s.missing || 0);
      var rf = d.meta.rowFormulas, cc = d.meta.columnChecks;
      var cards =
        card(s.totalCells || 0, 'cells compared', '') +
        card(s.matched || 0, 'matched', 'ok') +
        card(s.mismatched || 0, 'different', (s.mismatched ? 'bad' : 'ok')) +
        (rf ? card(rf.failed, 'formula failures', rf.failed ? 'bad' : 'ok') : '') +
        (cc ? card(cc.failed, 'column failures', cc.failed ? 'bad' : 'ok') : '');
      showBanner(diff ? 'bad' : 'ok',
        '<h3>' + (diff ? diff + ' difference(s) found' : 'No differences found') + ' &mdash; ' +
        esc(d.meta.moduleName) + '</h3>' +
        '<p><a href="' + d.url + '" target="_blank">Open report &rarr;</a> ' +
        '<span class="mono">' + esc(d.meta.reportFile) + '</span></p>' +
        '<div class="cards">' + cards + '</div>');
      setStages(4, -1);
    } else {
      showBanner('bad', '<h3>Run failed</h3><p>' + esc(d.error || 'See the log above.') + '</p>');
      setStages(-1, d.failedStage != null ? d.failedStage : 0);
    }
    finish(null, null);
    loadRuns();
  });

  es.addEventListener('fatal', function(ev){
    var d = JSON.parse(ev.data);
    showBanner('bad', '<h3>Run failed</h3><p>' + esc(d.error) + '</p>');
    finish(null, null);
  });

  es.onerror = function(){ /* server closes the stream when the run ends */ };
}

function card(n, label, kind){
  return '<div class="card ' + (kind||'') + '"><div class="n">' + n + '</div><div class="l">' + label + '</div></div>';
}

function finish(kind, html){
  setRunning(false);
  if (timer){ clearInterval(timer); timer = null; }
  $('elapsed').textContent = '';
  if (kind) showBanner(kind, html);
  if (es){ es.close(); es = null; }
}

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function statusBadge(s){
  return s === 'clean' ? '<span class="b b-ok">CLEAN</span>'
    : s === 'differences' ? '<span class="b b-bad">DIFFERENCES</span>'
    : s === 'blocked' ? '<span class="b b-warn">NOT COMPARED</span>'
    : s === 'interrupted' ? '<span class="b b-warn">INTERRUPTED</span>'
    : '<span class="b b-dim">&mdash;</span>';
}

function cellsCell(r){
  if (!r.cells) return '&mdash;';
  return r.cells.matched + '/' + r.cells.total +
    (r.cells.mismatched ? ' <span class="b b-bad">' + r.cells.mismatched + ' diff</span>' : '');
}

var showDeleted = false;

function loadRuns(){
  fetch('/api/runs').then(function(r){ return r.json(); }).then(function(list){
    $('run-count').textContent = list.length ? '(' + list.length + ')' : '';
    var tb = $('runs');
    if (!list.length){ tb.innerHTML = '<tr><td colspan="8" class="mono">No runs yet.</td></tr>'; return; }
    tb.innerHTML = list.map(function(r){
      var f = [];
      if (r.rowFormulas) f.push(r.rowFormulas.passed + '/' + r.rowFormulas.total + ' row');
      if (r.columnChecks) f.push(r.columnChecks.passed + '/' + r.columnChecks.total + ' col');
      // Which comparison passes ran. Shown here so a low-coverage run is visible from the
      // history rather than only from inside the report.
      var passes = r.passes || [];
      var ranCount = passes.filter(function(p){ return p.status === 'ran'; }).length;
      var blockedCount = passes.filter(function(p){ return p.status === 'blocked'; }).length;
      var cov = passes.length
        ? ranCount + '/' + passes.length + ' ran' +
          (blockedCount ? ' <span class="b b-warn">' + blockedCount + ' blocked</span>' : '')
        : '&mdash;';
      return '<tr data-run="' + esc(r.runId) + '">' +
        '<td>' + esc(r.moduleName) + '</td>' +
        '<td class="mono">' + esc(r.when || '') + '</td>' +
        '<td>' + statusBadge(r.status) + '</td>' +
        '<td>' + cellsCell(r) + '</td>' +
        '<td class="mono">' + cov + '</td>' +
        '<td class="mono">' + (f.join(' · ') || '&mdash;') + '</td>' +
        // An interrupted run has captures but never produced a report, so there is nothing
        // to open. Linking anyway would just serve a 404.
        '<td>' + (r.reportFile
          ? '<a href="' + r.url + '" target="_blank">open</a>'
          : '<span class="mono" title="This run was stopped before it produced a report. Its captures are still on disk.">no report</span>') + '</td>' +
        '<td><button type="button" class="rowbtn danger" data-del="' + esc(r.runId) + '">Delete</button></td>' +
        '</tr>';
    }).join('');
  });
  loadDeleted();
}

function loadDeleted(){
  fetch('/api/runs?deleted=deleted').then(function(r){ return r.json(); }).then(function(list){
    $('del-count').textContent = list.length ? '(' + list.length + ')' : '';
    $('toggle-deleted').textContent = showDeleted
      ? 'Hide deleted' + (list.length ? ' (' + list.length + ')' : '')
      : 'Show deleted' + (list.length ? ' (' + list.length + ')' : '');
    var tb = $('deleted-runs');
    if (!list.length){ tb.innerHTML = '<tr><td colspan="6" class="mono">None.</td></tr>'; return; }
    tb.innerHTML = list.map(function(r){
      return '<tr data-run="' + esc(r.runId) + '">' +
        '<td>' + esc(r.moduleName) + '</td>' +
        '<td class="mono">' + esc(r.when || '') + '</td>' +
        '<td class="mono">' + esc(r.deletedWhen || '') + '</td>' +
        '<td>' + statusBadge(r.status) + '</td>' +
        '<td>' + (r.reportFile
          ? '<a href="' + r.url + '" target="_blank">open</a>'
          : '<span class="mono">no report</span>') + '</td>' +
        '<td><button type="button" class="rowbtn" data-restore="' + esc(r.runId) + '">Restore</button></td>' +
        '</tr>';
    }).join('');
  });
}

function post(path, runId){
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: runId })
  }).then(function(r){ return r.json(); });
}

// A delete is reversible, so it happens immediately with an undo rather than behind a
// confirmation dialog. Nothing leaves the disk either way.
function softDelete(runId, row){
  if (row) row.classList.add('pending');
  post('/api/runs/delete', runId).then(function(res){
    if (res.error){ $('del-note').textContent = res.error; if (row) row.classList.remove('pending'); return; }
    $('del-note').innerHTML = 'Deleted <span class="mono">' + esc(runId) +
      '</span> &mdash; <button type="button" class="linkish" data-undo="' + esc(runId) + '">Undo</button>';
    loadRuns();
  });
}

function restore(runId){
  post('/api/runs/restore', runId).then(function(res){
    if (res.error){ $('del-note').textContent = res.error; return; }
    $('del-note').textContent = 'Restored ' + runId + '.';
    loadRuns();
  });
}

// One delegated listener, so buttons keep working after the tables are re-rendered.
document.addEventListener('click', function(ev){
  var t = ev.target;
  if (!t || t.tagName !== 'BUTTON') return;
  var del = t.getAttribute('data-del');
  if (del){ softDelete(del, t.closest('tr')); return; }
  var res = t.getAttribute('data-restore');
  if (res){ restore(res); return; }
  var undo = t.getAttribute('data-undo');
  if (undo){ restore(undo); return; }
});

$('toggle-deleted').addEventListener('click', function(){
  showDeleted = !showDeleted;
  $('deleted-sec').style.display = showDeleted ? '' : 'none';
  loadDeleted();
});

// The capture picker is only meaningful when reuse is on.
$('reuse').addEventListener('change', function(){
  $('reuse-from-field').style.display = $('reuse').checked ? '' : 'none';
});

function loadReusable(){
  fetch('/api/runs?includeCli=1&deleted=all').then(function(r){ return r.json(); }).then(function(list){
    var sel = $('reuse-from');
    var opts = ['<option value="">Most recent available</option>'];
    list.forEach(function(r){
      opts.push('<option value="' + esc(r.runId) + '">' + esc(r.moduleName) + ' — ' + esc(r.when || r.runId) +
        (r.deletedAt ? ' (deleted)' : '') + '</option>');
    });
    sel.innerHTML = opts.join('');
  });
}
loadReusable();

// Reconnect to an in-flight run if the page is reloaded mid-run.
fetch('/api/status').then(function(r){ return r.json(); }).then(function(st){
  if (st.running){
    $('progress-sec').style.display = '';
    $('log').textContent = st.log || '';
    setRunning(true);
    startedAt = Date.now() - (st.elapsedMs || 0);
    tickElapsed(); timer = setInterval(tickElapsed, 1000);
    setStages(st.stage || 0, -1);
    listen();
  }
});

loadRuns();
</script>
</body></html>`;
}
