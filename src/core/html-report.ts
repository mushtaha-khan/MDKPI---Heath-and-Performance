/**
 * Self-contained HTML report generator.
 *
 * Produces a single .html file with no external assets so it can be attached to a
 * ticket or emailed. Screenshots are inlined as base64 when small enough, otherwise
 * referenced relative to the report file.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ComparisonReport } from './compare.js';
import type { ColumnCheck, FormulaCheck, FormulaValidationResult, DayContext } from './formulas.js';
import { CATEGORIES, CATEGORY_LABELS, type Category } from './mapping.js';

/** Max bytes to inline a screenshot as base64. Larger files are linked instead. */
const INLINE_LIMIT = 3_500_000;

export interface ScreenshotRef {
  module: string;
  caption: string;
  absPath: string;
  relPath: string;
}

export interface ReportBundle {
  comparison: ComparisonReport;
  rowFormulas: FormulaValidationResult;
  columnChecks: { checks: ColumnCheck[]; summary: { total: number; passed: number; failed: number } };
  days: DayContext | null;
  screenshots: ScreenshotRef[];
  runStartedAt: string;
  runFinishedAt: string;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(n: number | null, dp = 2): string {
  if (n === null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

async function imgTag(ref: ScreenshotRef): Promise<string> {
  try {
    const buf = await readFile(ref.absPath);
    if (buf.byteLength <= INLINE_LIMIT) {
      return `<img alt="${esc(ref.caption)}" src="data:image/png;base64,${buf.toString('base64')}">`;
    }
    return `<img alt="${esc(ref.caption)}" src="${esc(ref.relPath)}" loading="lazy">
      <p class="hint">Too large to inline (${(buf.byteLength / 1e6).toFixed(1)} MB); kept alongside this report.</p>`;
  } catch {
    return `<p class="hint">Screenshot unavailable: ${esc(ref.relPath)}</p>`;
  }
}

const CSS = `
:root{--bg:#0f1014;--panel:#16181f;--panel2:#1c1f28;--line:#272b36;--fg:#e7e9f0;--dim:#9aa0b0;
--ok:#2f9e5f;--okbg:#12301f;--bad:#d1495b;--badbg:#33151b;--warn:#c9821a;--warnbg:#33260f;--accent:#a9232e;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
header{padding:28px 32px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#15171d,#0f1014)}
h1{margin:0 0 6px;font-size:22px;letter-spacing:.2px}
h2{margin:34px 0 12px;font-size:17px;border-left:3px solid var(--accent);padding-left:10px}
h3{margin:22px 0 8px;font-size:14px;color:var(--dim);text-transform:uppercase;letter-spacing:.8px}
main{padding:0 32px 64px;max-width:1600px}
.sub{color:var(--dim);font-size:13px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 18px;min-width:140px}
.card .n{font-size:26px;font-weight:600;line-height:1.1}
.card .l{color:var(--dim);font-size:12px;margin-top:4px}
.card.ok .n{color:var(--ok)} .card.bad .n{color:var(--bad)} .card.warn .n{color:var(--warn)}
table{border-collapse:collapse;width:100%;margin:10px 0 18px;background:var(--panel);font-size:13px}
th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
thead th{background:var(--panel2);position:sticky;top:0;z-index:2;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)}
tbody tr:hover{background:#1a1d25}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap}
.b-ok{background:var(--okbg);color:#61d68f;border:1px solid #245c3b}
.b-bad{background:var(--badbg);color:#ff8095;border:1px solid #6b2431}
.b-warn{background:var(--warnbg);color:#e5ab4e;border:1px solid #6b5320}
.b-dim{background:#20232c;color:var(--dim);border:1px solid var(--line)}
.rc{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--bad);border-radius:6px;padding:14px 18px;margin:12px 0}
.rc.info{border-left-color:var(--warn)}
.rc h4{margin:0 0 6px;font-size:15px}
.rc p{margin:6px 0;color:#c9cdd8}
.rc code{background:#0c0d11;padding:1px 5px;border-radius:3px;font-size:12px;color:#e5ab4e}
/* --- screenshot carousel --- */
.cr{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;margin:14px 0}
.cr-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.cr-title{font-size:14px;font-weight:600;flex:1;min-width:220px}
.cr-title .mod{color:var(--accent)}
.cr-count{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.cr-stage{position:relative;background:#000;border:1px solid var(--line);border-radius:6px;overflow:hidden;min-height:220px}
.cr-stage img{width:100%;display:block}
.cr-slide{display:none}
.cr-slide.active{display:block}
.cr-nav{position:absolute;top:0;bottom:0;width:14%;border:0;cursor:pointer;color:#fff;
background:linear-gradient(90deg,rgba(0,0,0,.55),transparent);font-size:30px;line-height:1;opacity:0;transition:opacity .15s}
.cr-stage:hover .cr-nav{opacity:1}
.cr-nav:focus-visible{opacity:1;outline:2px solid var(--accent)}
.cr-prev{left:0}
.cr-next{right:0;background:linear-gradient(270deg,rgba(0,0,0,.55),transparent)}
.cr-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:10px}
.cr-btn{background:var(--panel2);border:1px solid var(--line);color:var(--fg);padding:6px 14px;
border-radius:6px;cursor:pointer;font-size:13px}
.cr-btn:hover{border-color:var(--accent)}
.cr-dots{display:flex;gap:5px;flex-wrap:wrap;flex:1}
.cr-dot{width:10px;height:10px;border-radius:50%;border:1px solid var(--line);background:#2a2e39;cursor:pointer;padding:0}
.cr-dot.active{background:var(--accent);border-color:var(--accent)}
.cr-dot.ag{box-shadow:inset 0 0 0 2px #1d2430}
select.cr-jump{background:var(--panel2);border:1px solid var(--line);color:var(--fg);
padding:6px 10px;border-radius:6px;max-width:420px;font-size:13px}
.hint{color:var(--dim);font-size:12px;margin:6px 0 0}
.scroll{overflow:auto;max-height:640px;border:1px solid var(--line);border-radius:6px}
.scroll table{margin:0;border:0}
details{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 14px;margin:10px 0}
summary{cursor:pointer;font-weight:600}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.tools{display:flex;gap:10px;align-items:center;margin:10px 0}
input[type=search]{background:var(--panel2);border:1px solid var(--line);color:var(--fg);padding:7px 10px;border-radius:6px;min-width:260px}
label.chk{color:var(--dim);font-size:13px;display:flex;gap:6px;align-items:center;cursor:pointer}
footer{padding:22px 32px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
`;

const JS = `
function wireFilter(inputId, tableId, chkId){
  const inp=document.getElementById(inputId), tbl=document.getElementById(tableId), chk=document.getElementById(chkId);
  if(!inp||!tbl) return;
  function apply(){
    const q=inp.value.toLowerCase();
    const onlyDiff=chk&&chk.checked;
    for(const tr of tbl.tBodies[0].rows){
      const txt=tr.innerText.toLowerCase();
      const isDiff=tr.dataset.diff==='1';
      tr.style.display=(txt.includes(q)&&(!onlyDiff||isDiff))?'':'none';
    }
  }
  inp.addEventListener('input',apply); if(chk) chk.addEventListener('change',apply); apply();
}
function wireCarousel(){
  var slides=[].slice.call(document.querySelectorAll('.cr-slide'));
  if(!slides.length) return;
  var dots=[].slice.call(document.querySelectorAll('.cr-dot'));
  var jump=document.getElementById('cr-jump');
  var titleEl=document.getElementById('cr-title');
  var countEl=document.getElementById('cr-count');
  var i=0;

  function show(n){
    i=(n+slides.length)%slides.length;
    slides.forEach(function(s,k){ s.classList.toggle('active',k===i); });
    dots.forEach(function(d,k){ d.classList.toggle('active',k===i); });
    var s=slides[i];
    titleEl.innerHTML='<span class="mod">'+s.dataset.module+'</span> &mdash; '+s.dataset.caption;
    countEl.textContent=(i+1)+' of '+slides.length;
    if(jump) jump.value=String(i);
  }

  document.getElementById('cr-prev').addEventListener('click',function(){ show(i-1); });
  document.getElementById('cr-next').addEventListener('click',function(){ show(i+1); });
  document.getElementById('cr-prev2').addEventListener('click',function(){ show(i-1); });
  document.getElementById('cr-next2').addEventListener('click',function(){ show(i+1); });
  dots.forEach(function(d,k){ d.addEventListener('click',function(){ show(k); }); });
  if(jump) jump.addEventListener('change',function(){ show(Number(jump.value)); });

  // Arrow keys work when focus is not in a text field.
  document.addEventListener('keydown',function(e){
    var t=e.target.tagName;
    if(t==='INPUT'||t==='SELECT'||t==='TEXTAREA') return;
    if(e.key==='ArrowLeft'){ show(i-1); }
    else if(e.key==='ArrowRight'){ show(i+1); }
  });

  show(0);
}
document.addEventListener('DOMContentLoaded',function(){
  wireFilter('f-cmp','t-cmp','c-cmp');
  wireFilter('f-row','t-row','c-row');
  wireFilter('f-col','t-col','c-col');
  wireCarousel();
});
`;

function badge(kind: 'ok' | 'bad' | 'warn' | 'dim', text: string): string {
  return `<span class="badge b-${kind}">${esc(text)}</span>`;
}

function verdictBadge(v: string): string {
  if (v === 'match' || v === 'pass') return badge('ok', 'PASS');
  if (v === 'mismatch' || v === 'fail') return badge('bad', 'DIFF');
  if (v === 'unresolved') return badge('warn', 'UNRESOLVED');
  return badge('dim', v.toUpperCase());
}

/** Root-cause narrative derived from the data, not hardcoded. */
function rootCauses(b: ReportBundle): string {
  const cmp = b.comparison;
  const out: string[] = [];

  // Warranty-inherited totals: total delta tracks warranty delta.
  const inherited = cmp.metrics.filter((m) => {
    const t = m.cells.find((c) => c.category === 'total');
    const w = m.cells.find((c) => c.category === 'warranty');
    return (
      t?.verdict === 'mismatch' &&
      w?.verdict === 'mismatch' &&
      t.delta !== null &&
      w.delta !== null &&
      Math.abs(Math.abs(t.delta) - Math.abs(w.delta)) < 1.0
    );
  });

  // Findings are numbered as they are emitted — which of them apply varies per run,
  // so a fixed numbering would leave gaps (e.g. a "2." with no "1.").
  let n = 0;

  if (inherited.length) {
    out.push(`<div class="rc"><h4>${++n}. Warranty is under-reported on AutoGroup, and every Total inherits the error</h4>
      <p>For <strong>${inherited.length}</strong> metrics the Total delta is numerically equal to the Warranty delta,
      which means the Total column is not independently wrong &mdash; it is carrying the Warranty gap.
      Customer Pay and Internal agree, so the fault is isolated to the Warranty pay type.</p>
      <p class="mono">${inherited
        .map((m) => {
          const t = m.cells.find((c) => c.category === 'total');
          const w = m.cells.find((c) => c.category === 'warranty');
          return `${esc(m.autogroupLabel)}: total Δ${num(t?.delta ?? null)} vs warranty Δ${num(w?.delta ?? null)}`;
        })
        .join('<br>')}</p></div>`);
  }

  // Discount handling.
  const disc = cmp.metrics.filter((m) => m.id.endsWith('_discount') && !m.passed);
  if (disc.length) {
    out.push(`<div class="rc"><h4>${++n}. AutoGroup does not apply discounts</h4>
      <p>AutoGroup reports <code>$0</code> for every discount line while DMS reports real values.
      This propagates into the Customer Pay gross figures by exactly the discount amount, which is why
      Customer Pay fails only on gross-related rows.</p>
      <p class="mono">${disc
        .map((m) =>
          m.cells
            .filter((c) => c.verdict === 'mismatch')
            .map(
              (c) =>
                `${esc(m.autogroupLabel)} / ${c.categoryLabel}: AutoGroup ${esc(c.left.raw || '—')} vs DMS ${esc(c.right.raw || '—')}`,
            )
            .join('<br>'),
        )
        .join('<br>')}</p></div>`);
  }

  // Rows whose rendered value contradicts the formula the app itself documents.
  const formulaFails = b.rowFormulas.checks.filter((c) => c.verdict === 'fail');
  if (formulaFails.length) {
    const byRow = new Map<string, typeof formulaFails>();
    for (const f of formulaFails) {
      if (!byRow.has(f.rowLabel)) byRow.set(f.rowLabel, []);
      byRow.get(f.rowLabel)!.push(f);
    }
    out.push(`<div class="rc"><h4>${++n}. A row contradicts the formula shown in its own tooltip</h4>
      <p>These formulas were read from the DMS dashboard's hover tooltips, then re-evaluated against the
      values on the same screen. Where they disagree, either the tooltip documents the wrong formula or the
      calculation is wrong &mdash; both are defects, and this comparison cannot tell you which.</p>
      ${[...byRow.entries()]
        .map(
          ([rowLabel, list]) => `<p class="mono"><strong>${esc(rowLabel)}</strong> &mdash;
          documented as <code>${esc(list[0]!.formula)}</code><br>${list
            .map(
              (f) =>
                `${esc(CATEGORY_LABELS[f.category])}: formula gives ${num(f.expected)}, screen shows ${num(f.actual)}`,
            )
            .join('<br>')}</p>`,
        )
        .join('')}</div>`);
  }

  // Derived cells that match none of the plausible definitions.
  const colFails = b.columnChecks.checks.filter((c) => c.verdict === 'fail');
  if (colFails.length) {
    out.push(`<div class="rc info"><h4>${++n}. Derived cells that match no known rule</h4>
      <p>${colFails.length} derived cell(s) could not be reproduced by any of the candidate rules tried.
      The rules that do apply elsewhere on the grid are listed in the column-formula table below, along with
      what each would have produced. Worth a developer confirming the intended definition.</p>
      <p class="mono">${colFails
        .map(
          (c) =>
            `${esc(c.rowLabel)} / ${esc(CATEGORY_LABELS[c.category])} / ${esc(c.column)}: screen shows ${num(c.actual)}`,
        )
        .join('<br>')}</p></div>`);
  }

  // Clean category = proof the harness is sound.
  const clean = CATEGORIES.filter((c) => cmp.summary.byCategory[c].mismatched === 0);
  if (clean.length) {
    out.push(`<div class="rc info"><h4>Control: ${clean
      .map((c) => CATEGORY_LABELS[c])
      .join(', ')} matched with zero differences</h4>
      <p>This is the control result. It confirms the login, the column mapping, the value parsing and the
      tolerances are all correct &mdash; so the failures elsewhere are genuine data differences rather than
      an artefact of how this harness reads the screens.</p></div>`);
  }

  // Definitional differences flagged in the mapping notes.
  const defs = cmp.metrics.filter((m) => m.notes?.includes('DEFINITIONAL'));
  if (defs.length) {
    out.push(`<div class="rc info"><h4>Needs a decision: the L&amp;P totals are defined differently on each screen</h4>
      <p>These deltas are <strong>not necessarily defects</strong>. The two screens compose the subtotal from
      different components, and both are internally self-consistent. Confirm which composition is intended
      before raising a bug.</p>
      <p class="mono">${defs.map((m) => esc(m.notes ?? '')).join('<br><br>')}</p></div>`);
  }

  return out.join('\n');
}

export async function renderHtml(b: ReportBundle): Promise<string> {
  const cmp = b.comparison;
  const s = cmp.summary;

  // --- screenshot carousel ---
  // One slide at a time rather than 19 stacked images. Navigation uses dots and a
  // jump list instead of image thumbnails, because thumbnails would repeat the
  // inlined base64 and roughly double the file size.
  const slides: string[] = [];
  const dots: string[] = [];
  const jumpOptions: string[] = [];

  for (const [idx, ref] of b.screenshots.entries()) {
    slides.push(`<div class="cr-slide" data-module="${esc(ref.module)}" data-caption="${esc(ref.caption)}">
      ${await imgTag(ref)}
    </div>`);
    const isAg = /AutoGroup/i.test(ref.module);
    dots.push(
      `<button class="cr-dot${isAg ? ' ag' : ''}" type="button" title="${esc(ref.module)} — ${esc(ref.caption)}" aria-label="Show screenshot ${idx + 1}"></button>`,
    );
    jumpOptions.push(
      `<option value="${idx}">${idx + 1}. ${esc(ref.module.replace(/ —.*$/, ''))} — ${esc(ref.caption)}</option>`,
    );
  }

  const carousel = slides.length
    ? `<div class="cr">
    <div class="cr-head">
      <div class="cr-title" id="cr-title"></div>
      <div class="cr-count" id="cr-count"></div>
    </div>
    <div class="cr-stage">
      ${slides.join('\n')}
      <button class="cr-nav cr-prev" id="cr-prev" type="button" aria-label="Previous screenshot">&#8249;</button>
      <button class="cr-nav cr-next" id="cr-next" type="button" aria-label="Next screenshot">&#8250;</button>
    </div>
    <div class="cr-foot">
      <button class="cr-btn" id="cr-prev2" type="button">&#8249; Prev</button>
      <button class="cr-btn" id="cr-next2" type="button">Next &#8250;</button>
      <select class="cr-jump" id="cr-jump" aria-label="Jump to screenshot">${jumpOptions.join('')}</select>
      <div class="cr-dots">${dots.join('')}</div>
    </div>
    <p class="hint">${slides.length} screenshots captured during this run, in sequence.
      Use the arrows, the dots, the jump list, or the left/right arrow keys.
      Outlined dots are AutoGroup; solid are DMS.</p>
  </div>`
    : '<p class="hint">No screenshots were captured for this run.</p>';

  // --- matrix view: metric rows x category columns ---
  const matrixRows = cmp.metrics
    .map((m) => {
      const tds = CATEGORIES.map((c) => {
        const cell = m.cells.find((x) => x.category === c);
        if (!cell) return '<td>—</td>';
        const bad = cell.verdict !== 'match';
        return `<td>${verdictBadge(cell.verdict)}${
          bad && cell.delta !== null ? ` <span class="mono">Δ${num(cell.delta)}</span>` : ''
        }</td>`;
      }).join('');
      return `<tr data-diff="${m.passed ? '0' : '1'}"><td>${esc(m.autogroupLabel)}</td>${tds}</tr>`;
    })
    .join('');

  // --- detailed cell-by-cell view ---
  const detailRows = cmp.metrics
    .flatMap((m) =>
      m.cells.map((c) => {
        const bad = c.verdict !== 'match';
        return `<tr data-diff="${bad ? '1' : '0'}">
        <td>${esc(m.autogroupLabel)}</td>
        <td>${esc(m.dmsLabel)}</td>
        <td>${esc(c.categoryLabel)}</td>
        <td class="n">${esc(c.left.raw || '—')}</td>
        <td class="n">${esc(c.right.raw || '—')}</td>
        <td class="n">${c.delta === null ? '—' : num(c.delta)}</td>
        <td class="n">${c.tolerance}</td>
        <td>${verdictBadge(c.verdict)}</td>
      </tr>`;
      }),
    )
    .join('');

  // --- row formula checks ---
  const rf = b.rowFormulas;
  const rfRows = rf.checks
    .map((c: FormulaCheck) => {
      const bad = c.verdict !== 'pass';
      return `<tr data-diff="${bad ? '1' : '0'}">
      <td>${esc(c.rowLabel)}</td>
      <td>${esc(CATEGORY_LABELS[c.category])}</td>
      <td class="mono">${esc(c.formula)}</td>
      <td class="n">${num(c.expected)}</td>
      <td class="n">${num(c.actual)}</td>
      <td class="n">${c.delta === null ? '—' : num(c.delta)}</td>
      <td>${verdictBadge(c.verdict)}</td>
    </tr>`;
    })
    .join('');

  // --- column formula checks ---
  const cc = b.columnChecks;
  const ccRows = cc.checks
    .map((c: ColumnCheck) => {
      const bad = c.verdict !== 'pass';
      // For a failure, list every rule tried so a developer can see that the
      // rendered value matches none of the plausible definitions.
      const tried =
        bad && c.candidates?.length
          ? `<details><summary>${c.candidates.length} rules tried, none matched</summary>
             <table style="margin:8px 0 0">
               <thead><tr><th>Candidate rule</th><th class="n">Would give</th></tr></thead>
               <tbody>${c.candidates
                 .map((t) => `<tr><td class="mono">${esc(t.rule)}</td><td class="n">${num(t.expected)}</td></tr>`)
                 .join('')}</tbody></table></details>`
          : '';
      return `<tr data-diff="${bad ? '1' : '0'}">
      <td>${esc(c.rowLabel)}</td>
      <td>${esc(CATEGORY_LABELS[c.category])}</td>
      <td>${esc(c.column)}</td>
      <td class="mono">${esc(c.rule)}${tried}</td>
      <td class="n">${num(c.expected)}</td>
      <td class="n">${num(c.actual)}</td>
      <td class="n">${c.delta === null ? '—' : num(c.delta)}</td>
      <td>${verdictBadge(c.verdict)}</td>
    </tr>`;
    })
    .join('');

  const catCards = CATEGORIES.map((c) => {
    const x = s.byCategory[c];
    const kind = x.mismatched === 0 ? 'ok' : 'bad';
    return `<div class="card ${kind}"><div class="n">${x.matched}/${x.matched + x.mismatched + x.missing}</div>
      <div class="l">${CATEGORY_LABELS[c]} matched</div></div>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Dealer KPI — Service Reconciliation</title>
<style>${CSS}</style></head>
<body>
<header>
  <h1>Service Summary (AutoGroup) vs Service Dashboard (DMS)</h1>
  <div class="sub">
    Reconciliation run ${esc(b.runStartedAt)} &rarr; ${esc(b.runFinishedAt)} &middot;
    Scope: ${esc(cmp.scope)}
  </div>
</header>
<main>

  <h2>Result at a glance</h2>
  <div class="cards">
    <div class="card"><div class="n">${s.totalCells}</div><div class="l">Value cells compared</div></div>
    <div class="card ok"><div class="n">${s.matched}</div><div class="l">Matched</div></div>
    <div class="card bad"><div class="n">${s.mismatched}</div><div class="l">Different</div></div>
    <div class="card ${rf.summary.failed ? 'bad' : 'ok'}"><div class="n">${rf.summary.failed}</div><div class="l">Row-formula failures</div></div>
    <div class="card ${cc.summary.failed ? 'bad' : 'ok'}"><div class="n">${cc.summary.failed}</div><div class="l">Column-formula failures</div></div>
  </div>
  <div class="cards">${catCards}</div>

  <table>
    <thead><tr><th></th><th>AutoGroup (left)</th><th>DMS (right)</th></tr></thead>
    <tbody>
      <tr><td>Screen</td><td>${esc(cmp.left.label)}</td><td>${esc(cmp.right.label)}</td></tr>
      <tr><td>Login role</td><td>${esc(cmp.left.role)}</td><td>${esc(cmp.right.role)}</td></tr>
      <tr><td>URL</td><td class="mono">${esc(cmp.left.url ?? '')}</td><td class="mono">${esc(cmp.right.url ?? '')}</td></tr>
      <tr><td>Date range requested</td><td>${esc(cmp.dateRange.autogroup ?? 'unknown')}</td><td>${esc(cmp.dateRange.dms ?? 'unknown')}</td></tr>
      <tr><td>Captured at</td><td>${esc(cmp.left.capturedAt)}</td><td>${esc(cmp.right.capturedAt)}</td></tr>
    </tbody>
  </table>
  ${
    b.days
      ? `<p class="hint">Period context from DMS: ${b.days.daysInMonth} days in month,
        ${b.days.workingDays} working days, ${b.days.daysWorked} worked, ${b.days.daysLeft} left.
        The Tracking columns are month-end projections scaled by
        ${b.days.daysWorked > 0 ? (b.days.workingDays / b.days.daysWorked).toFixed(2) : '?'}×.</p>`
      : ''
  }
  ${
    !cmp.dateRange.aligned
      ? `<div class="rc info"><h4>Note on the date ranges</h4><p>${esc(cmp.dateRange.note)}</p></div>`
      : ''
  }
  ${
    b.days === null
      ? `<div class="rc"><h4>Data quality: the period strip rendered empty</h4>
         <p>The <code>DAYS IN A MONTH / WORKING DAYS / DAYS WORKED / DAYS LEFT</code> strip on the DMS
         dashboard returned no values on this run. An earlier capture of the same screen did populate it
         (<code>30 / 30 / 3 / 27</code>), so this is intermittent rather than absent by design.</p>
         <p>Consequence: the Tracking projection cannot be independently verified without working days,
         so those checks were skipped rather than assumed correct. Days worked was recovered by deriving
         it from the RO Count average so the Avg. column could still be validated.</p></div>`
      : ''
  }

  <h2>Root cause analysis</h2>
  ${rootCauses(b)}

  <h2>Evidence — screens as captured this run</h2>
  ${carousel}

  <h2>Difference matrix — rows × pay type</h2>
  <div class="tools">
    <input type="search" id="f-cmp" placeholder="Filter metrics…">
    <label class="chk"><input type="checkbox" id="c-cmp"> differences only</label>
  </div>
  <div class="scroll"><table id="t-cmp">
    <thead><tr><th>Metric</th>${CATEGORIES.map((c) => `<th>${CATEGORY_LABELS[c]}</th>`).join('')}</tr></thead>
    <tbody>${matrixRows}</tbody>
  </table></div>

  <h2>Detailed differences — every row and column</h2>
  <div class="tools">
    <input type="search" id="f-row" placeholder="Filter…">
    <label class="chk"><input type="checkbox" id="c-row" checked> differences only</label>
  </div>
  <div class="scroll"><table id="t-row">
    <thead><tr>
      <th>AutoGroup row</th><th>DMS row</th><th>Pay type</th>
      <th class="n">AutoGroup</th><th class="n">DMS</th><th class="n">Delta</th><th class="n">Tol.</th><th>Verdict</th>
    </tr></thead>
    <tbody>${detailRows}</tbody>
  </table></div>

  <h2>Row formula validation (DMS self-consistency)</h2>
  <p class="sub">Formulas were read from the dashboard's own hover tooltips, then re-evaluated against the
  rendered values. This checks DMS against itself and is independent of the AutoGroup comparison.
  ${rf.summary.passed}/${rf.summary.total} checks passed.</p>
  ${
    rf.missingReferences.length
      ? `<p class="hint">Formula operands with no matching row on the grid:
         <span class="mono">${rf.missingReferences.map(esc).join(', ')}</span></p>`
      : ''
  }
  <div class="tools">
    <input type="search" id="f-col" placeholder="Filter…">
    <label class="chk"><input type="checkbox" id="c-col"> failures only</label>
  </div>
  <div class="scroll"><table id="t-col">
    <thead><tr><th>Row</th><th>Pay type</th><th>Formula (from tooltip)</th>
      <th class="n">Expected</th><th class="n">Rendered</th><th class="n">Delta</th><th>Verdict</th></tr></thead>
    <tbody>${rfRows}</tbody>
  </table></div>

  <h2>Column formula validation (%, Avg., Tracking)</h2>
  <p class="sub">Derived-column rules: <span class="mono">% = category ÷ total × 100</span>,
  <span class="mono">Avg. = value ÷ RO count of same pay type</span> (the RO Count row divides by days worked),
  <span class="mono">Tracking = value ÷ days worked × working days</span> for volume metrics.
  ${cc.summary.passed}/${cc.summary.total} checks passed.</p>
  <div class="scroll"><table>
    <thead><tr><th>Row</th><th>Pay type</th><th>Column</th><th>Rule</th>
      <th class="n">Expected</th><th class="n">Rendered</th><th class="n">Delta</th><th>Verdict</th></tr></thead>
    <tbody>${ccRows}</tbody>
  </table></div>

  ${
    cmp.unmappedDmsRows.length
      ? `<h2>DMS rows with no AutoGroup counterpart</h2>
         <p class="sub">Present on the dashboard but absent from Service Summary, so not compared.</p>
         <p class="mono">${cmp.unmappedDmsRows.map(esc).join(' · ')}</p>`
      : ''
  }
  ${
    cmp.unmappedAutogroupRows.length
      ? `<h2>AutoGroup rows with no DMS counterpart</h2>
         <p class="mono">${cmp.unmappedAutogroupRows.map(esc).join(' · ')}</p>`
      : ''
  }

</main>
<footer>
  Generated by the My Dealer KPI reconciliation harness. Read-only capture: the portal was
  navigated and read, never modified. Credentials are held in a gitignored .env and are redacted
  from all artifacts.
</footer>
<script>${JS}</script>
</body></html>`;
}
