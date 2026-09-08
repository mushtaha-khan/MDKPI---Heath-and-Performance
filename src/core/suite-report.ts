/**
 * Self-contained HTML report for a suite run of any module.
 *
 * Everything shown is derived from the run: which tables were found on each screen,
 * which were paired and why, the column alignment behind every comparison, the matched
 * metrics, and the formula checks. Nothing is specific to any one module.
 */
import { readFile } from 'node:fs/promises';
import type { GridResult, ObservedTable, SuiteResult } from './suite.js';
import type { TableStructure } from './structure.js';
import { formatDatesInText, formatIso } from './datetime.js';
import { describeSegments } from './rows.js';
import type { FormulaValidationResult, ColumnCheck, DayContext } from './formulas.js';

const INLINE_LIMIT = 3_500_000;

export interface ScreenshotRef {
  module: string;
  caption: string;
  absPath: string;
  relPath: string;
  /** Which screen this came from, so a finding can be pointed at the right side. */
  side?: 'left' | 'right';
  /**
   * Which horizontal band of the grid the shot covers. Evidence links resolve a
   * column position to a band; a band spans many columns, so the link lands you in
   * the right region rather than on the exact cell.
   */
  band?: 'left' | 'mid' | 'right' | null;
}

/** Formula validation for one side of the comparison. */
export interface SideFormulas {
  label: string;
  rowFormulas?: FormulaValidationResult;
  columnChecks?: {
    checks: ColumnCheck[];
    summary: { total: number; passed: number; failed: number };
  };
}

export interface SuiteReportBundle {
  result: SuiteResult;
  screenshots: ScreenshotRef[];
  /** Formula validation per side — both screens are examined, not just one. */
  sides: SideFormulas[];
  days?: DayContext | null;
  /**
   * Whether the period strip was absent (normal for most modules), present but empty
   * (a data problem), or populated. Only 'empty' warrants a warning.
   */
  daysStatus: 'ok' | 'empty' | 'absent';
  runId: string;
  command: string;
  /**
   * Exactly what was entered in the tool. Recorded separately from the URL the browser
   * ended on, so a redirect or a role landing elsewhere is visible rather than hidden
   * behind whatever the page settled on.
   */
  inputs: {
    autogroupUrl: string;
    dmsUrl: string;
    autogroupRole: string;
    dmsRole: string;
    moduleName: string;
    moduleNameDerived: boolean;
  };
  /** False when the run reused earlier captures instead of crawling afresh. */
  capturedThisRun: boolean;
  capturedAt: { left: string; right: string };
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

async function imgTag(ref: ScreenshotRef): Promise<string> {
  try {
    const buf = await readFile(ref.absPath);
    if (buf.byteLength <= INLINE_LIMIT) {
      return `<img alt="${esc(ref.caption)}" src="data:image/png;base64,${buf.toString('base64')}">`;
    }
    return `<img alt="${esc(ref.caption)}" src="${esc(ref.relPath)}" loading="lazy">`;
  } catch {
    return `<p class="hint">Screenshot unavailable: ${esc(ref.relPath)}</p>`;
  }
}

const CSS = `
:root{--bg:#0f1014;--panel:#16181f;--panel2:#1c1f28;--line:#272b36;--fg:#e7e9f0;--dim:#9aa0b0;
--ok:#2f9e5f;--okbg:#12301f;--bad:#d1495b;--badbg:#33151b;--warn:#c9821a;--warnbg:#33260f;--accent:#a9232e;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
header{padding:26px 32px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#15171d,#0f1014)}
h1{margin:0 0 6px;font-size:21px}
h2{margin:34px 0 12px;font-size:17px;border-left:3px solid var(--accent);padding-left:10px}
h3{margin:24px 0 10px;font-size:15px;color:var(--fg)}
main{padding:0 32px 64px;max-width:1600px}
.sub{color:var(--dim);font-size:13px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 18px;min-width:126px}
.card .n{font-size:25px;font-weight:600;line-height:1.1}
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
a.shotlink{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;
background:#1d2430;color:#8fb8ff;border:1px solid #2c3a52;text-decoration:none}
a.shotlink:hover{border-color:#8fb8ff;text-decoration:none}
.rc{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--bad);border-radius:6px;padding:14px 18px;margin:12px 0}
.rc.info{border-left-color:var(--warn)}
.rc.good{border-left-color:var(--ok)}
.rc h4{margin:0 0 6px;font-size:15px}
.rc p{margin:6px 0;color:#c9cdd8}
code{background:#0c0d11;padding:1px 5px;border-radius:3px;font-size:12px;color:#e5ab4e}
.hint{color:var(--dim);font-size:12px;margin:6px 0 0}
.scroll{overflow:auto;max-height:620px;border:1px solid var(--line);border-radius:6px}
.scroll table{margin:0;border:0}
details{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 14px;margin:10px 0}
summary{cursor:pointer;font-weight:600}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.tools{display:flex;gap:10px;align-items:center;margin:10px 0;flex-wrap:wrap}
input[type=search]{background:var(--panel2);border:1px solid var(--line);color:var(--fg);padding:7px 10px;border-radius:6px;min-width:240px}
label.chk{color:var(--dim);font-size:13px;display:flex;gap:6px;align-items:center;cursor:pointer}
footer{padding:22px 32px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
.gridsec{border:1px solid var(--line);border-radius:10px;padding:2px 20px 18px;margin:18px 0;background:#131520}
.gridsec > h3{border-left:3px solid var(--warn);padding-left:9px;margin-top:18px}
/* carousel */
.cr{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;margin:14px 0}
.cr-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.cr-title{font-size:14px;font-weight:600;flex:1;min-width:220px}
.cr-title .mod{color:var(--accent)}
.cr-count{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
.cr-stage{position:relative;background:#000;border:1px solid var(--line);border-radius:6px;overflow:hidden;min-height:200px}
.cr-stage img{width:100%;display:block}
.cr-slide{display:none}.cr-slide.active{display:block}
.cr-nav{position:absolute;top:0;bottom:0;width:14%;border:0;cursor:pointer;color:#fff;
background:linear-gradient(90deg,rgba(0,0,0,.55),transparent);font-size:30px;opacity:0;transition:opacity .15s}
.cr-stage:hover .cr-nav{opacity:1}
.cr-nav:focus-visible{opacity:1;outline:2px solid var(--accent)}
.cr-prev{left:0}.cr-next{right:0;background:linear-gradient(270deg,rgba(0,0,0,.55),transparent)}
.cr-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:10px}
.cr-btn{background:var(--panel2);border:1px solid var(--line);color:var(--fg);padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px}
.cr-btn:hover{border-color:var(--accent)}
.cr-dots{display:flex;gap:5px;flex-wrap:wrap;flex:1}
.cr-dot{width:10px;height:10px;border-radius:50%;border:1px solid var(--line);background:#2a2e39;cursor:pointer;padding:0}
.cr-dot.active{background:var(--accent);border-color:var(--accent)}
.cr-dot.ag{box-shadow:inset 0 0 0 2px #1d2430}
select.cr-jump{background:var(--panel2);border:1px solid var(--line);color:var(--fg);padding:6px 10px;border-radius:6px;max-width:420px;font-size:13px}
`;

const JS = `
// Filters are wired by data attribute so any number of grid sections works without
// having to know their ids up front.
function wireFilters(){
  var inputs = document.querySelectorAll('[data-filter]');
  for (var i=0;i<inputs.length;i++){
    (function(inp){
      var tbl = document.getElementById(inp.getAttribute('data-filter'));
      if (!tbl) return;
      var chk = document.querySelector('[data-diffonly="' + inp.getAttribute('data-filter') + '"]');
      function apply(){
        var q = inp.value.toLowerCase();
        var only = chk && chk.checked;
        var rows = tbl.tBodies[0] ? tbl.tBodies[0].rows : [];
        for (var r=0;r<rows.length;r++){
          var tr = rows[r];
          var ok = tr.innerText.toLowerCase().indexOf(q) > -1 && (!only || tr.dataset.diff === '1');
          tr.style.display = ok ? '' : 'none';
        }
      }
      inp.addEventListener('input', apply);
      if (chk) chk.addEventListener('change', apply);
      apply();
    })(inputs[i]);
  }
}
function wireCarousel(){
  var slides=[].slice.call(document.querySelectorAll('.cr-slide'));
  if(!slides.length)return;
  var dots=[].slice.call(document.querySelectorAll('.cr-dot'));
  var jump=document.getElementById('cr-jump'),t=document.getElementById('cr-title'),c=document.getElementById('cr-count');
  var i=0;
  function show(n){
    i=(n+slides.length)%slides.length;
    slides.forEach(function(s,k){s.classList.toggle('active',k===i)});
    dots.forEach(function(d,k){d.classList.toggle('active',k===i)});
    t.innerHTML='<span class="mod">'+slides[i].dataset.module+'</span> &mdash; '+slides[i].dataset.caption;
    c.textContent=(i+1)+' of '+slides.length;
    if(jump)jump.value=String(i);
  }
  ['cr-prev','cr-prev2'].forEach(function(id){var e=document.getElementById(id);if(e)e.addEventListener('click',function(){show(i-1)})});
  ['cr-next','cr-next2'].forEach(function(id){var e=document.getElementById(id);if(e)e.addEventListener('click',function(){show(i+1)})});
  dots.forEach(function(d,k){d.addEventListener('click',function(){show(k)})});
  if(jump)jump.addEventListener('change',function(){show(Number(jump.value))});
  document.addEventListener('keydown',function(e){
    var tag=e.target.tagName;
    if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA')return;
    if(e.key==='ArrowLeft')show(i-1); else if(e.key==='ArrowRight')show(i+1);
  });
  // Exposed so evidence links elsewhere in the report can drive the carousel.
  window.__showShot = show;
  show(0);
}
// Evidence links jump the carousel to the slide covering that column's region.
function wireShotLinks(){
  var links = document.querySelectorAll('.shotlink');
  for (var i=0;i<links.length;i++){
    links[i].addEventListener('click', function(e){
      e.preventDefault();
      var n = Number(this.getAttribute('data-slide'));
      if (window.__showShot) window.__showShot(n);
      var host = document.getElementById('evidence');
      if (host) host.scrollIntoView({behavior:'smooth', block:'start'});
    });
  }
}
document.addEventListener('DOMContentLoaded',function(){
  wireFilters(); wireCarousel(); wireShotLinks();
});
`;

function badge(kind: 'ok' | 'bad' | 'warn' | 'dim', text: string): string {
  return `<span class="badge b-${kind}">${esc(text)}</span>`;
}

function verdictBadge(v: string): string {
  if (v === 'match' || v === 'pass') return badge('ok', 'PASS');
  if (v === 'mismatch' || v === 'fail') return badge('bad', 'DIFF');
  if (v === 'unresolved') return badge('warn', 'UNRESOLVED');
  return badge('dim', v.replace(/-/g, ' ').toUpperCase());
}

/**
 * Badge for a compared cell. A cell that agrees only after allowing for display
 * rounding is marked separately from an exact match, so the tolerance applied is
 * visible rather than being quietly folded into the pass count.
 */
function cellBadge(c: { verdict: string; roundedMatch?: boolean }): string {
  if (c.verdict === 'match' && c.roundedMatch) return badge('ok', 'PASS · ROUNDED');
  return verdictBadge(c.verdict);
}

/** Findings computed from the run, numbered as emitted so there are never gaps. */
function findings(b: SuiteReportBundle): string {
  const r = b.result;
  const out: string[] = [];
  let n = 0;

  // Nothing compared at all outranks every other finding.
  if (r.blocked) {
    out.push(`<div class="rc"><h4>${++n}. ${esc(r.blocked.reason)} &mdash; no comparison was possible</h4>
      <p>${esc(r.blocked.detail)}</p>
      <p class="hint">Full diagnosis at the top of this report.</p></div>`);
  }

  // Analytics differences come near the top: on a module with no summary grid these are the
  // headline figures, and they are the first thing anyone would check by eye.
  const a = r.analytics;
  if (a && a.mismatched > 0) {
    out.push(`<div class="rc"><h4>${++n}. ${a.mismatched} of ${a.compared} analytics cards disagree</h4>
      <p>The strip above the grid carries this module's headline figures. These are the ones that differ:</p>
      <p class="mono">${a.pairs
        .filter((p) => p.verdict !== 'match')
        .map(
          (p) =>
            `${esc(p.label)} &rarr; ${esc(p.rightLabel)}: ${esc(p.left.raw)} vs ${esc(p.right.raw)}` +
            (p.delta !== null ? ` (&Delta;${num(p.delta)})` : ''),
        )
        .join('<br>')}</p>
      <p class="hint">These are card values read directly off each screen, so a difference here is a
      difference in what the two products are publishing as the module's totals.</p></div>`);
  }

  // Record-level differences, grouped by column so a systematic difference reads as one
  // finding rather than as twenty-five.
  const rc = r.recordComparison;
  if (rc && rc.summary.mismatched > 0) {
    const byColumn = new Map<string, { count: number; examples: string[] }>();
    for (const rec of rc.records) {
      for (const c of rec.cells) {
        if (c.verdict === 'match') continue;
        const e = byColumn.get(c.column) ?? { count: 0, examples: [] };
        e.count++;
        if (e.examples.length < 3) {
          e.examples.push(
            `${rec.key}: ${c.left || '—'} vs ${c.right || '—'}` +
              (c.delta !== null ? ` (Δ${num(c.delta)})` : ''),
          );
        }
        byColumn.set(c.column, e);
      }
    }
    const ranked = [...byColumn.entries()].sort((x, y) => y[1].count - x[1].count);

    out.push(`<div class="rc"><h4>${++n}. ${rc.summary.mismatched} record-level differences, concentrated in ${ranked.length} column(s)</h4>
      <p>Across ${rc.summary.recordsCompared} records and ${rc.columnPairs.length} columns. A column that
      differs on nearly every record is one difference in how the two products calculate or present it,
      not many separate faults &mdash; so they are grouped by column, worst first.</p>
      ${ranked
        .map(
          ([col, e]) =>
            `<p><strong>${esc(col)}</strong> &mdash; differs on ${e.count} of ${rc.summary.recordsCompared} record(s)<br>` +
            `<span class="mono">${e.examples.map(esc).join('<br>')}</span></p>`,
        )
        .join('')}</div>`);
  }

  // A detail view that had to be declined is a finding: it tells the reader that a more
  // thorough comparison was available in principle and why it was not made.
  const declined = (r.mode?.detailViews ?? []).filter((v) => !v.usable);
  if (declined.length) {
    out.push(`<div class="rc info"><h4>${++n}. A more detailed comparison was available but could not be used</h4>
      <p>${declined.length} record-level listing(s) were found. Aggregating them would have allowed each
      summary to be checked against its own underlying records &mdash; a stronger test than comparing the two
      summaries alone. None could be used, because none of them displays every record.</p>
      ${declined.map((v) => `<p class="mono">${esc(v.sideLabel)} &mdash; ${esc(v.name)}: ${esc(v.why)}</p>`).join('')}
      <p>This costs coverage, not correctness. Nothing here is counted as a difference, and the
      summary-against-summary comparison stands on its own. To get the stronger test, the listing would need
      to show all records rather than one page.</p></div>`);
  }

  const usedViews = (r.mode?.corroboration ?? []);
  if (usedViews.length) {
    const failed = usedViews.flatMap((c) => c.checks.filter((k) => k.verdict !== 'match'));
    out.push(`<div class="rc ${failed.length ? '' : 'good'}"><h4>${++n}. A screen was checked against its own records</h4>
      <p>${usedViews.length} complete record-level listing(s) were aggregated and compared with the matching
      summary totals on the same screen. ${
        failed.length
          ? `${failed.length} of those aggregates do not reproduce the summary total, which points at the summary and its own detail disagreeing — independent of anything the other screen shows.`
          : 'Every aggregate reproduced the summary total, so each summary is consistent with its own records.'
      }</p>
      ${
        failed.length
          ? `<p class="mono">${failed
              .map(
                (k) =>
                  `${esc(k.detailColumn)}: records sum to ${num(k.aggregate)}, summary shows ${num(k.expected)} (${esc(k.summaryRow)} / ${esc(k.summaryColumn)}), Δ${num(k.delta)}`,
              )
              .join('<br>')}</p>`
          : ''
      }</div>`);
  }

  // A pivot changes how the reader should interpret everything below it.
  for (const grid of r.grids) {
    if (!grid.transposed) continue;
    const side = grid.transposed.side === 'left' ? r.left.label : r.right.label;
    out.push(`<div class="rc info"><h4>${++n}. ${esc(side)} publishes this data transposed, and was pivoted to compare it &mdash; ${esc(grid.name)}</h4>
      <p>${esc(grid.transposed.note)}</p>
      <p>Only the arrangement was changed; every figure is exactly as the screen published it. This is
      worth knowing because the two screens are not laid out the same way, so a person checking by eye will
      be reading across on one screen and down on the other.</p></div>`);
  }

  // Columns whose mapping was inferred from their values cannot corroborate themselves.
  const valueCols = r.grids.flatMap((g) =>
    (g.columnPairs ?? []).filter((cp) => cp.matchedBy === 'value').map((cp) => ({ g, cp })),
  );
  if (valueCols.length) {
    out.push(`<div class="rc"><h4>${++n}. ${valueCols.length} column(s) were mapped by their values rather than their headings</h4>
      <p>The two screens head these columns too differently, or too ambiguously alike, to align them by name.
      The mapping was inferred from which columns' figures correspond.</p>
      <p><strong>Their agreement is not independent evidence.</strong> The mapping was selected because the
      values matched, so it cannot then be cited as proof that they match. Confirm the mapping is the one you
      intend; once confirmed, the figures do agree.</p>
      <p class="mono">${valueCols
        .map(({ g, cp }) => `${esc(g.name)}: ${esc(cp.leftHeader)} &rarr; ${esc(cp.rightHeader)}`)
        .join('<br>')}</p></div>`);
  }

  // Shape mismatches come next: if the two grids are not comparable, every difference
  // below is suspect and reading them as defects wastes time.
  for (const grid of r.grids) {
    if (!grid.shape?.warning) continue;
    out.push(`<div class="rc"><h4>${++n}. The two screens are not showing the same shape of data &mdash; ${esc(grid.name)}</h4>
      <p>${esc(grid.shape.warning)}</p>
      <table style="margin-top:10px"><thead><tr><th></th>
        <th>${esc(r.left.label)}</th><th>${esc(r.right.label)}</th></tr></thead>
        <tbody>
          <tr><td>Distinct row labels</td><td class="n">${grid.shape.leftDataRows}</td>
            <td class="n">${grid.shape.rightDataRows}</td></tr>
          <tr><td>Labels appearing more than once</td><td class="n">${grid.shape.leftDuplicateLabels}</td>
            <td class="n">${grid.shape.rightDuplicateLabels}</td></tr>
        </tbody></table>
      <p class="hint">A repeated row label is the usual sign of an extra grouping dimension &mdash;
      the same entity listed once per category. Check the column and grouping controls on both screens
      so they show the same breakdown, then run again.</p></div>`);
  }

  // Breakdown availability, stated up front so a reader never mistakes a coverage gap for
  // a value disagreement. Deliberately worded to separate the two.
  const bdSum = r.summary.breakdown;
  if (bdSum && bdSum.gridsOneSideOnly > 0) {
    const oneSided = r.grids.filter(
      (g) => g.breakdown?.availability === 'left' || g.breakdown?.availability === 'right',
    );
    out.push(`<div class="rc info"><h4>${++n}. A breakdown is available on one screen only &mdash; totals were still compared like for like</h4>
      <p>On ${oneSided.length} grid(s) one screen splits each row into segments while the other publishes
      only a total. The comparison used each row's <strong>total</strong> against the other screen's total,
      which is the correct like-for-like pairing. The segment detail itself has no counterpart, so it could
      not be compared.</p>
      <p><strong>${bdSum.missingBreakdownEntities}</strong> row(s) and
      <strong>${bdSum.uncomparedSegmentRows}</strong> segment row(s) fall into this category. They are
      counted separately under "Totals and breakdown" below and are <strong>not</strong> included in the
      ${r.summary.mismatched} difference(s) reported above &mdash; a missing breakdown is a gap in what the
      other screen publishes, not evidence that a total is wrong.</p>
      <p class="mono">${oneSided
        .map(
          (g) =>
            `${esc(g.name)}: ${esc(
              g.breakdown.availability === 'left' ? r.left.label : r.right.label,
            )} shows ${esc(
              describeSegments(
                g.breakdown.availability === 'left'
                  ? g.breakdown.leftSegments
                  : g.breakdown.rightSegments,
              ) || 'segments',
            )}`,
        )
        .join('<br>')}</p></div>`);
  }

  if (bdSum && bdSum.segmentMismatched > 0) {
    out.push(`<div class="rc"><h4>${++n}. ${bdSum.segmentMismatched} segment-level cell(s) differ even though the totals were compared separately</h4>
      <p>Both screens carry the breakdown on ${bdSum.gridsBothSides} grid(s), so each segment was compared
      individually as well as the total. ${bdSum.segmentMatched} of ${bdSum.segmentCells} segment cells
      agreed; ${bdSum.segmentMismatched} did not. A total can agree while its segments disagree &mdash; that
      points at how the two screens classify a row, not at the arithmetic. The detail is under
      "Totals and breakdown".</p></div>`);
  }

  const allMetrics = r.grids.flatMap((g) => g.metrics.map((m) => ({ grid: g, m })));

  // A single group's delta explaining the Total delta.
  for (const grid of r.grids) {
    if (!grid.groups.includes('TOTAL')) continue;
    for (const other of grid.groups.filter((g) => g !== 'TOTAL')) {
      const inherited = grid.metrics.filter((m) => {
        const t = m.cells.find((c) => c.group === 'TOTAL');
        const o = m.cells.find((c) => c.group === other);
        return (
          t?.verdict === 'mismatch' &&
          o?.verdict === 'mismatch' &&
          t.delta !== null &&
          o.delta !== null &&
          Math.abs(Math.abs(t.delta) - Math.abs(o.delta)) < 1.0
        );
      });
      if (inherited.length >= 3) {
        out.push(`<div class="rc"><h4>${++n}. ${esc(other)} differences propagate into every Total &mdash; ${esc(grid.name)}</h4>
          <p>For <strong>${inherited.length}</strong> metrics the Total delta equals the ${esc(other)} delta,
          so the Total column is not independently wrong &mdash; it is carrying the ${esc(other)} gap.</p>
          <p class="mono">${inherited
            .map((m) => {
              const t = m.cells.find((c) => c.group === 'TOTAL');
              const o = m.cells.find((c) => c.group === other);
              return `${esc(m.leftLabel)}: total Δ${num(t?.delta)} vs ${esc(other)} Δ${num(o?.delta)}`;
            })
            .join('<br>')}</p></div>`);
      }
    }
  }

  // One side reporting zero where the other reports a value.
  const zeroOnLeft = allMetrics.filter(
    ({ m }) =>
      !m.passed &&
      m.cells.some((c) => c.verdict === 'mismatch' && c.left.value === 0 && (c.right.value ?? 0) !== 0),
  );
  if (zeroOnLeft.length) {
    out.push(`<div class="rc"><h4>${++n}. ${esc(r.left.label)} reports zero where ${esc(r.right.label)} reports a value</h4>
      <p>One side is not populating these metrics at all, which is a different class of problem from a
      numeric drift. Downstream totals inherit the gap.</p>
      <p class="mono">${zeroOnLeft
        .flatMap(({ m }) =>
          m.cells
            .filter((c) => c.verdict === 'mismatch' && c.left.value === 0)
            .map(
              (c) =>
                `${esc(m.leftLabel)} / ${esc(c.group)}: ${esc(c.left.raw || '—')} vs ${esc(c.right.raw || '—')}`,
            ),
        )
        .join('<br>')}</p></div>`);
  }

  // Rows contradicting their own documented formula, on either screen.
  for (const side of b.sides) {
    const fails = side.rowFormulas?.checks.filter((c) => c.verdict === 'fail') ?? [];
    if (!fails.length) continue;
    const byRow = new Map<string, typeof fails>();
    for (const f of fails) {
      if (!byRow.has(f.rowLabel)) byRow.set(f.rowLabel, []);
      byRow.get(f.rowLabel)!.push(f);
    }
    out.push(`<div class="rc"><h4>${++n}. ${esc(side.label)}: a row contradicts the formula in its own tooltip</h4>
      <p>Formulas were read from this screen's hover tooltips and re-evaluated against its own rendered
      values. Where they disagree, either the tooltip documents the wrong formula or the calculation is
      wrong. This is independent of the cross-product comparison.</p>
      ${[...byRow.entries()]
        .map(
          ([row, list]) =>
            `<p class="mono"><strong>${esc(row)}</strong> &mdash; documented as <code>${esc(list[0]!.formula)}</code><br>` +
            list
              .map((f) => `${esc(f.category)}: formula gives ${num(f.expected)}, screen shows ${num(f.actual)}`)
              .join('<br>') +
            `</p>`,
        )
        .join('')}</div>`);
  }

  // Definitional differences flagged by the module preset.
  const defs = allMetrics.filter(({ m }) => m.definitional && !m.passed);
  if (defs.length) {
    out.push(`<div class="rc info"><h4>${++n}. Flagged as defined differently on each screen</h4>
      <p>The module preset marks these as composition differences rather than defects. Confirm the intended
      definition before raising a bug.</p>
      <p class="mono">${defs.map(({ m }) => `${esc(m.leftLabel)} / ${esc(m.rightLabel)}`).join('<br>')}</p></div>`);
  }

  // Low-confidence pairings deserve a human glance.
  const fuzzy = allMetrics.filter(({ m }) => m.matchMethod === 'fuzzy' && m.matchConfidence < 0.95);
  if (fuzzy.length) {
    out.push(`<div class="rc info"><h4>${++n}. ${fuzzy.length} row pairing(s) matched by similarity, not exactly</h4>
      <p>These labels differ between the screens and were matched on similarity. They are almost certainly
      right, but a wrong pairing would produce a spurious difference, so they are listed for review.</p>
      <p class="mono">${fuzzy
        .map(({ m }) => `${esc(m.leftLabel)} &rarr; ${esc(m.rightLabel)} (${m.matchConfidence})`)
        .join('<br>')}</p></div>`);
  }

  // Explain the rounding allowance whenever it was actually used.
  if (r.summary.roundedMatches > 0) {
    out.push(`<div class="rc info"><h4>${++n}. ${r.summary.roundedMatches} cell(s) matched once display rounding was allowed for</h4>
      <p>One screen rounds some figures for display where the other shows decimals &mdash; a value
      rendered as <code>237</code> against <code>236.5</code>, or <code>$44,444</code> against
      <code>$44,444.31</code>. The underlying figures agree, so these are treated as matches.</p>
      <p>The allowance is derived per cell from the number of decimals each side displays: half of the
      coarser display unit, and no more. A value shown to no decimals therefore allows 0.5 either way,
      one shown to two decimals allows 0.005. Nothing larger is tolerated, which is why the discount
      gaps and other real differences are still reported. These cells are marked
      ${badge('ok', 'PASS · ROUNDED')} in the detail tables so the allowance is auditable.</p></div>`);
  }

  // Clean groups are the control result.
  const clean = Object.entries(r.summary.byGroup).filter(([, v]) => v.mismatched === 0).map(([k]) => k);
  if (clean.length) {
    out.push(`<div class="rc good"><h4>Control: ${clean.map(esc).join(', ')} matched with zero differences</h4>
      <p>These groups agreeing confirms the login, the derived column geometry, the row matching and the
      tolerances are all sound &mdash; so differences elsewhere are genuine, not an artefact of the harness.</p></div>`);
  }

  if (!out.length) {
    out.push(`<div class="rc good"><h4>No differences found</h4>
      <p>Every matched metric agreed across every shared column group on every paired grid.</p></div>`);
  }
  return out.join('\n');
}

/** Lookup from screen side + horizontal band to a carousel slide index. */
type ShotIndex = Map<string, number>;

function buildShotIndex(shots: ScreenshotRef[]): ShotIndex {
  const idx: ShotIndex = new Map();
  shots.forEach((s, i) => {
    if (!s.side) return;
    const key = `${s.side}|${s.band ?? 'full'}`;
    // Keep the first slice of each band; later parts scroll further down the same band.
    if (!idx.has(key)) idx.set(key, i);
  });
  return idx;
}

/**
 * Which horizontal band a column position falls in.
 *
 * The capture takes slices at three horizontal scroll offsets, so a column's position
 * as a fraction of the grid width tells us which slice shows it. This is deliberately
 * coarse: a slice spans many columns, so the link lands you in the right region.
 */
function bandFor(index: number, totalColumns: number): 'left' | 'mid' | 'right' {
  if (totalColumns <= 0) return 'left';
  const f = index / totalColumns;
  return f < 0.4 ? 'left' : f < 0.72 ? 'mid' : 'right';
}

/** Links to the screenshots showing a column pair on each side. */
function evidenceLinks(
  cp: { leftIndex: number; rightIndex: number },
  g: GridResult,
  shots: ShotIndex,
): string {
  const leftTotal = g.geometry.left.columns.length + 1;
  const rightTotal = g.geometry.right.columns.length + 1;

  const out: string[] = [];
  for (const [side, index, total, label] of [
    ['left', cp.leftIndex, leftTotal, 'AG'],
    ['right', cp.rightIndex, rightTotal, 'DMS'],
  ] as const) {
    const band = bandFor(index, total);
    const slide = shots.get(`${side}|${band}`) ?? shots.get(`${side}|full`);
    if (slide === undefined) continue;
    out.push(
      `<a href="#evidence" class="shotlink" data-slide="${slide}" title="Show the ${label} screenshot covering this column">${label}</a>`,
    );
  }
  return out.join(' · ');
}

/** Note about column groups excluded because they hold descriptions, not quantities. */
function skippedNote(g: GridResult): string | null {
  if (!g.skippedGroups?.length) return null;
  return (
    `Group(s) ${g.skippedGroups.join(', ')} were left out because their columns hold text or ` +
    'dates rather than quantities, so there is nothing to compare numerically.'
  );
}

/** One grid's comparison section. */
function gridSection(g: GridResult, r: SuiteResult, shotIndex: ShotIndex): string {
  const matrixId = `t-mx-${g.id}`;
  const detailId = `t-dt-${g.id}`;

  // Each group now spans many columns, so the matrix summarises per group ("7/9 OK")
  // rather than showing a single verdict. The per-column detail is in the table below.
  const matrix = g.metrics
    .map((m) => {
      const tds = g.groups
        .map((grp) => {
          const cells = m.cells.filter((x) => x.group === grp);
          if (!cells.length) return '<td>—</td>';
          const ok = cells.filter((c) => c.verdict === 'match').length;
          const bad = cells.length - ok;
          if (bad === 0) return `<td>${badge('ok', `${ok}/${cells.length} OK`)}</td>`;
          const worst = cells
            .filter((c) => c.verdict !== 'match')
            .map((c) => `${c.column}${c.delta !== null ? ` Δ${num(c.delta)}` : ''}`)
            .join(', ');
          return `<td>${badge('bad', `${bad} of ${cells.length} differ`)}<br><span class="mono">${esc(worst)}</span></td>`;
        })
        .join('');
      return `<tr data-diff="${m.passed ? '0' : '1'}"><td>${esc(m.leftLabel)}</td>${tds}</tr>`;
    })
    .join('');

  const detail = g.metrics
    .flatMap((m) =>
      m.cells.map((c) => {
        const bad = c.verdict !== 'match';
        const cp = g.columnPairs.find((p) => p.group === c.group && p.name === c.column);
        // Only differences get evidence links; linking every matching cell would be noise.
        const evidence = bad && cp ? evidenceLinks(cp, g, shotIndex) : '';
        return `<tr data-diff="${bad ? '1' : '0'}">
        <td>${esc(m.leftLabel)}</td><td>${esc(m.rightLabel)}</td>
        <td>${esc(c.group)}</td><td>${esc(c.column)}</td>
        <td class="n">${esc(c.left.raw || '—')}</td><td class="n">${esc(c.right.raw || '—')}</td>
        <td class="n">${c.delta === null ? '—' : num(c.delta)}</td><td class="n">${c.tolerance}</td>
        <td>${m.matchMethod === 'exact' ? badge('dim', 'exact') : badge('warn', `row ${m.matchConfidence}`)}</td>
        <td>${cellBadge(c)}</td>
        <td>${evidence || '<span class="mono">—</span>'}</td></tr>`;
      }),
    )
    .join('');

  const s = g.summary;
  const cs = g.coverageStats;
  const unpairedTotal = g.unpairedColumns.left.length + g.unpairedColumns.right.length;

  const valueAligned = g.columnPairs.filter((cp) => cp.matchedBy === 'value');

  return `<div class="gridsec">
    <h3>${esc(g.name)} <span class="sub">&mdash; ${s.matched}/${s.totalCells} cells matched, ${g.coverage.matched} metrics aligned</span></h3>
    <p class="hint">Paired because: ${esc(g.pairing.reason)}.</p>

    ${
      g.transposed
        ? `<div class="rc info" style="margin:12px 0"><h4>One screen was pivoted to make the two comparable</h4>
           <p>${esc(g.transposed.note)}</p>
           <p class="hint">The comparison below runs on the pivoted form. The figures are exactly those the
           screen published &mdash; only their arrangement was changed, so that the dimension one screen puts
           across its columns lines up with the dimension the other puts down its rows.</p></div>`
        : ''
    }

    ${
      g.alignmentNotes?.length
        ? `<div class="rc info" style="margin:12px 0"><h4>The two screens head these columns differently</h4>
           <p>Alignment was resolved as follows. Read this before the results: if a mapping is wrong,
           the comparison below it is meaningless.</p>
           <p class="mono">${g.alignmentNotes.map(esc).join('<br>')}</p></div>`
        : ''
    }

    ${
      valueAligned.length
        ? `<div class="rc" style="margin:12px 0"><h4>${valueAligned.length} column(s) were aligned by their values, not their headings</h4>
           <p>The headings on the two screens were either too different or too ambiguously similar to
           establish the mapping by name, so it was inferred from which columns' figures correspond.</p>
           <p><strong>These columns agreeing is therefore not independent evidence that the two screens
           agree</strong> &mdash; the mapping was chosen because the figures matched. Treat them as a
           proposed mapping to confirm, not as a verified result. Every other column was aligned by
           heading and its verdict does stand on its own.</p>
           <p class="mono">${valueAligned
             .map((cp) => `${esc(cp.leftHeader)} &rarr; ${esc(cp.rightHeader)}`)
             .join('<br>')}</p></div>`
        : ''
    }

    <div class="rc ${unpairedTotal ? 'info' : 'good'}" style="margin:12px 0">
      <h4>How much of this grid was compared</h4>
      <p><strong>${cs.comparedColumns}</strong> column(s) compared, out of
      <strong>${cs.leftValueColumns}</strong> numeric column(s) on ${esc(r.left.label)} and
      <strong>${cs.rightValueColumns}</strong> on ${esc(r.right.label)}.
      Every compared column is checked for all ${g.coverage.matched} matched row(s), giving
      ${s.totalCells} value cell(s).</p>
      ${
        unpairedTotal
          ? `<p>${unpairedTotal} column(s) could not be paired and were <strong>not compared</strong>
             &mdash; listed under "What did not match" below.</p>`
          : `<p>Every numeric column on both screens found a counterpart, so nothing was left out.</p>`
      }
      ${
        skippedNote(g)
          ? `<p class="hint">${esc(skippedNote(g))}</p>`
          : ''
      }
    </div>

    <details><summary>Column alignment &mdash; the ${g.columnPairs.length} column pair(s) compared</summary>
      <p class="hint">Each row is one column on ${esc(r.left.label)} matched to its counterpart on
      ${esc(r.right.label)}. Positions are derived from the colspan-expanded header structure, so this is
      how you confirm the tool lined up the columns you expect. "col" is the position in the row.</p>
      <table><thead><tr><th>Group (${esc(r.left.label)})</th><th>Group (${esc(r.right.label)})</th><th>Column</th>
        <th>${esc(r.left.label)} header</th><th class="n">col</th>
        <th>${esc(r.right.label)} header</th><th class="n">col</th><th>Matched</th></tr></thead>
      <tbody>${g.columnPairs
        .map(
          (a) =>
            `<tr><td>${esc(a.group)}</td>
             <td>${a.rightGroup === a.group ? '<span class="mono">same</span>' : esc(a.rightGroup)}</td>
             <td>${esc(a.name)}</td>
             <td class="mono">${esc(a.leftHeader)}</td><td class="n">${a.leftIndex}</td>
             <td class="mono">${esc(a.rightHeader)}</td><td class="n">${a.rightIndex}</td>
             <td>${
               a.matchedBy === 'exact'
                 ? badge('dim', 'exact')
                 : a.matchedBy === 'value'
                   ? // Deliberately not the red "bad" badge: that one means a value
                     // differs, and reusing it here would put pairing caveats into the
                     // difference count. The caveat is spelled out in the callout above.
                     badge('warn', `by value ${a.confidence}`)
                   : badge('warn', `similar ${a.confidence}`)
             }</td></tr>`,
        )
        .join('')}</tbody></table>
    </details>

    <div class="tools">
      <input type="search" data-filter="${matrixId}" placeholder="Filter metrics…">
      <label class="chk"><input type="checkbox" data-diffonly="${matrixId}"> differences only</label>
    </div>
    <div class="scroll"><table id="${matrixId}" class="tbl-matrix">
      <thead><tr><th>Metric</th>${g.groups.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead>
      <tbody>${matrix}</tbody></table></div>

    <div class="tools">
      <input type="search" data-filter="${detailId}" placeholder="Filter…">
      <label class="chk"><input type="checkbox" data-diffonly="${detailId}" checked> differences only</label>
    </div>
    <div class="scroll"><table id="${detailId}" class="tbl-detail">
      <thead><tr><th>${esc(r.left.label)} row</th><th>${esc(r.right.label)} row</th>
        <th>Group</th><th>Column</th>
        <th class="n">${esc(r.left.label)}</th><th class="n">${esc(r.right.label)}</th>
        <th class="n">Delta</th><th class="n">Tol.</th><th>Row match</th><th>Verdict</th>
        <th>Evidence</th></tr></thead>
      <tbody>${detail}</tbody></table></div>
    <p class="hint">Evidence links jump to the screenshot covering that column's region of the grid.
      Each screenshot spans a band of columns, so it shows the right area rather than the exact cell.</p>

    <p class="hint">Anything on this grid that could not be compared is listed in
      "What did not match" below.</p>
  </div>`;
}

/**
 * The diagnosis shown when nothing could be compared.
 *
 * Previously this case threw, so the run produced no report at all and the only record of
 * what happened was a stack trace in a log. Everything needed to work out why was already
 * captured by then, so the report is still written and leads with this.
 */
function blockedSection(b: SuiteReportBundle): string {
  const r = b.result;
  const x = r.blocked;
  if (!x) return '';

  return `<div class="rc"><h4>${esc(x.reason)}</h4>
    <p>${esc(x.detail)}</p>
    <p><strong>What to check</strong></p>
    <ul>${x.remedy.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    <p class="hint">Nothing was compared, so there are no results below &mdash; but the screens were read
    successfully and everything they returned is recorded in this report. The table structures are under
    "What the crawl observed" and the screenshots are under "Evidence". This is a failure to align the two
    layouts, not a statement about whether the figures agree.</p></div>`;
}

/**
 * The analytics strip, compared card by card.
 *
 * On a module with no summary grid this is the only directly comparable data there is, so it
 * gets its own section rather than being an appendix to a grid comparison.
 */
function analyticsSection(b: SuiteReportBundle): string {
  const r = b.result;
  const a = r.analytics;
  if (!a) {
    return `<p class="hint">Neither screen shows an analytics strip above its grid for this module.</p>`;
  }

  const rows = a.pairs
    .map((p) => {
      const bad = p.verdict !== 'match';
      return `<tr data-diff="${bad ? '1' : '0'}">
        <td>${esc(p.label)}</td>
        <td>${p.rightLabel === p.label ? '<span class="mono">same</span>' : esc(p.rightLabel)}</td>
        <td class="n">${esc(p.left.raw)}</td>
        <td class="n">${esc(p.right.raw)}</td>
        <td class="n">${p.delta === null ? '—' : num(p.delta)}</td>
        <td class="n">${p.tolerance}</td>
        <td>${p.matchedBy === 'exact' ? badge('dim', 'exact') : badge('warn', `similar ${p.confidence}`)}</td>
        <td>${cellBadge({ verdict: p.verdict, roundedMatch: p.roundedMatch })}</td>
      </tr>`;
    })
    .join('');

  const onlyList = (tiles: typeof a.onlyOnLeft, side: string) =>
    tiles.length
      ? `<p class="mono"><strong>${esc(side)} only</strong><br>${tiles
          .map((t) => `${esc(t.label)} = ${esc(t.value)}${t.caption ? ` (${esc(t.caption)})` : ''}`)
          .join('<br>')}</p>`
      : '';

  return `<div class="cards">
    <div class="card"><div class="n">${a.compared}</div><div class="l">Cards compared</div></div>
    <div class="card ok"><div class="n">${a.matched}</div><div class="l">Matched</div></div>
    ${a.roundedMatches ? `<div class="card ok"><div class="n">${a.roundedMatches}</div><div class="l">of those, equal after rounding</div></div>` : ''}
    <div class="card ${a.mismatched ? 'bad' : 'ok'}"><div class="n">${a.mismatched}</div><div class="l">Different</div></div>
    <div class="card ${a.onlyOnLeft.length ? 'warn' : 'ok'}"><div class="n">${a.onlyOnLeft.length}</div>
      <div class="l">Only on ${esc(r.left.label)}</div></div>
    <div class="card ${a.onlyOnRight.length ? 'warn' : 'ok'}"><div class="n">${a.onlyOnRight.length}</div>
      <div class="l">Only on ${esc(r.right.label)}</div></div>
  </div>
  <p class="sub">${esc(a.note)}</p>
  <div class="tools">
    <input type="search" data-filter="t-an" placeholder="Filter cards…">
    <label class="chk"><input type="checkbox" data-diffonly="t-an"> differences only</label>
  </div>
  <div class="scroll"><table id="t-an" class="tbl-detail">
    <thead><tr><th>${esc(r.left.label)} card</th><th>${esc(r.right.label)} card</th>
      <th class="n">${esc(r.left.label)}</th><th class="n">${esc(r.right.label)}</th>
      <th class="n">Delta</th><th class="n">Tol.</th><th>Label match</th><th>Verdict</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
  ${
    a.onlyOnLeft.length || a.onlyOnRight.length
      ? `<div class="rc info" style="margin-top:12px"><h4>Cards published by one screen only</h4>
         <p>These have no counterpart to compare against. That is a difference in what each screen
         chooses to show, not a disagreement about a figure, and none of it is counted as a
         difference.</p>
         ${onlyList(a.onlyOnLeft, r.left.label)}${onlyList(a.onlyOnRight, r.right.label)}</div>`
      : ''
  }`;
}

/**
 * Two record listings compared record by record.
 *
 * Used where neither screen publishes a summary. The section leads with how records were
 * matched and which columns were compared, because both are inferred and both have to be
 * checkable.
 */
function recordsSection(b: SuiteReportBundle): string {
  const r = b.result;
  const rc = r.recordComparison;
  if (!rc) return '';

  const s = rc.summary;

  const colRows = rc.columnPairs
    .map(
      (c) =>
        `<tr><td>${esc(c.name)}</td>
         <td>${c.rightName === c.name ? '<span class="mono">same</span>' : esc(c.rightName)}</td>
         <td>${c.kind === 'numeric' ? badge('dim', 'NUMERIC') : badge('dim', 'TEXT')}</td>
         <td>${c.matchedBy === 'exact' ? badge('dim', 'exact') : badge('warn', `similar ${c.confidence}`)}</td></tr>`,
    )
    .join('');

  // Cell detail, differences first by default: 25 records across 14 columns is 350 rows.
  const cellRows = rc.records
    .flatMap((rec) =>
      rec.cells.map((c) => {
        const bad = c.verdict !== 'match';
        return `<tr data-diff="${bad ? '1' : '0'}">
          <td class="mono">${esc(rec.key)}</td>
          <td>${esc(c.column)}</td>
          <td>${esc(c.strategy)}</td>
          <td class="mono">${esc(c.left || '—')}</td>
          <td class="mono">${esc(c.right || '—')}</td>
          <td class="n">${c.delta === null ? '—' : num(c.delta)}</td>
          <td class="n">${c.similarity === null ? '—' : c.similarity}</td>
          <td>${cellBadge({ verdict: c.verdict, roundedMatch: c.formattingOnly })}</td>
          <td class="mono">${esc(c.composition ?? '')}</td>
        </tr>`;
      }),
    )
    .join('');

  // Group the composition notes so the reader sees each structural difference once rather
  // than twenty-five times.
  const compositions = new Map<string, { column: string; count: number }>();
  for (const rec of rc.records) {
    for (const c of rec.cells) {
      if (!c.composition) continue;
      const key = `${c.column}|${c.composition}`;
      const found = compositions.get(key);
      if (found) found.count++;
      else compositions.set(key, { column: c.column, count: 1 });
    }
  }

  return `<div class="cards">
    <div class="card"><div class="n">${s.recordsCompared}</div><div class="l">Records compared</div></div>
    <div class="card"><div class="n">${rc.columnPairs.length}</div><div class="l">Columns compared</div></div>
    <div class="card"><div class="n">${s.totalCells}</div><div class="l">Value cells compared</div></div>
    <div class="card ok"><div class="n">${s.matched}</div><div class="l">Matched</div></div>
    ${s.formattingOnly ? `<div class="card ok"><div class="n">${s.formattingOnly}</div><div class="l">of those, after allowing formatting</div></div>` : ''}
    <div class="card ${s.mismatched ? 'bad' : 'ok'}"><div class="n">${s.mismatched}</div><div class="l">Different</div></div>
    <div class="card ${s.missing ? 'warn' : 'ok'}"><div class="n">${s.missing}</div><div class="l">Missing one side</div></div>
    <div class="card ${rc.onlyOnLeft.length + rc.onlyOnRight.length ? 'warn' : 'ok'}">
      <div class="n">${rc.onlyOnLeft.length + rc.onlyOnRight.length}</div>
      <div class="l">Records on one side only</div></div>
  </div>
  <p class="sub">${esc(rc.note)}</p>

  <div class="rc info" style="margin:12px 0">
    <h4>How records were matched</h4>
    <p>Records were paired on <strong>${esc(rc.keyColumn.left)}</strong> against
    <strong>${esc(rc.keyColumn.right)}</strong>. ${esc(rc.keyColumn.reason)}.</p>
    <p class="hint">The key column is discovered from the data, not assumed: it is the column whose
    values are near-unique within each listing and largely shared between the two. If this is the wrong
    column, every comparison below is wrong, so it is stated first.</p>
    ${
      rc.unpairedLeft.length || rc.unpairedRight.length
        ? `<p><strong>Columns with no counterpart</strong> &mdash; not compared:<br>
           <span class="mono">${[
             ...rc.unpairedLeft.map((c) => `${esc(r.left.label)}: ${esc(c)}`),
             ...rc.unpairedRight.map((c) => `${esc(r.right.label)}: ${esc(c)}`),
           ].join('<br>')}</span></p>`
        : '<p>Every populated column on both screens found a counterpart.</p>'
    }
  </div>

  <details><summary>Column alignment &mdash; the ${rc.columnPairs.length} column(s) compared</summary>
    <table><thead><tr><th>${esc(r.left.label)}</th><th>${esc(r.right.label)}</th><th>Compared as</th><th>Matched</th></tr></thead>
    <tbody>${colRows}</tbody></table>
  </details>

  ${
    compositions.size
      ? `<div class="rc info" style="margin:12px 0"><h4>Columns the two screens compose differently</h4>
         <p>In these columns the screens do not present the same thing in the same way &mdash; one
         itemises where the other aggregates, or appends figures to a name, or breaks a count down by
         amount. The comparable part was extracted and compared; the difference in presentation is
         recorded here and is <strong>not</strong> counted as a data difference.</p>
         ${[...compositions.values()]
           .map((c, i) => {
             const note = [...compositions.entries()][i]![0].split('|').slice(1).join('|');
             return `<p><strong>${esc(c.column)}</strong> (${c.count} record(s))<br>
               <span class="mono">${esc(note)}</span></p>`;
           })
           .join('')}</div>`
      : ''
  }

  <div class="tools">
    <input type="search" data-filter="t-rec" placeholder="Filter by record or column…">
    <label class="chk"><input type="checkbox" data-diffonly="t-rec" checked> differences only</label>
  </div>
  <div class="scroll"><table id="t-rec" class="tbl-detail">
    <thead><tr><th>Record</th><th>Column</th><th>Compared as</th>
      <th>${esc(r.left.label)}</th><th>${esc(r.right.label)}</th>
      <th class="n">Delta</th><th class="n">Similarity</th><th>Verdict</th><th>Note</th></tr></thead>
    <tbody>${cellRows}</tbody></table></div>

  ${
    rc.onlyOnLeft.length || rc.onlyOnRight.length
      ? `<div class="rc info" style="margin-top:12px"><h4>Records visible on one screen only</h4>
         <p>${rc.onlyOnLeft.length} record(s) appear only on ${esc(r.left.label)} and
         ${rc.onlyOnRight.length} only on ${esc(r.right.label)}. Both listings paginate, so a record
         absent from the other side's current page is a display limit rather than a missing record.
         Counted separately and not as a difference.</p>
         <p class="mono">${[
           ...rc.onlyOnLeft.slice(0, 40).map((k) => `${esc(r.left.label)}: ${esc(k)}`),
           ...rc.onlyOnRight.slice(0, 40).map((k) => `${esc(r.right.label)}: ${esc(k)}`),
         ].join('<br>')}</p></div>`
      : ''
  }`;
}

/**
 * Every comparison the engine can make, and whether it ran here.
 *
 * The engine has no per-module configuration — it reads what each screen publishes and applies
 * whichever comparisons fit. That is only worth trusting if it is visible, because a module
 * with no analytics strip and a module whose analytics strip was overlooked both produce
 * silence. So each pass reports itself, including the ones that did not apply, and anything
 * that was blocked says why.
 */
function coverageSection(b: SuiteReportBundle): string {
  const r = b.result;
  const passes = r.coverage ?? [];
  if (!passes.length) return '';

  const rowFormulas = b.sides.reduce((a, x) => a + (x.rowFormulas?.summary.total ?? 0), 0);
  const colChecks = b.sides.reduce((a, x) => a + (x.columnChecks?.summary.total ?? 0), 0);
  const formulaFailed =
    b.sides.reduce((a, x) => a + (x.rowFormulas?.summary.failed ?? 0), 0) +
    b.sides.reduce((a, x) => a + (x.columnChecks?.summary.failed ?? 0), 0);

  // Formula validation lives outside runSuite, so it is appended here rather than duplicated.
  const all = [
    ...passes,
    {
      name: "Each screen against its own documented formulas",
      status: rowFormulas + colChecks > 0 ? ('ran' as const) : ('not-applicable' as const),
      detail:
        rowFormulas + colChecks > 0
          ? `${rowFormulas} row formula(s) read from tooltips and ${colChecks} derived-column check(s) re-evaluated against each screen's own values.`
          : 'Neither screen documents a formula in a tooltip for this module, and no derived column could be re-derived, so there was nothing to re-check.',
      compared: rowFormulas + colChecks,
      unit: 'checks',
      differences: formulaFailed,
    },
  ];

  const statusBadge = (s: string) =>
    s === 'ran' ? badge('ok', 'RAN') : s === 'blocked' ? badge('bad', 'BLOCKED') : badge('dim', 'N/A');

  const ran = all.filter((p) => p.status === 'ran');
  const blockedPasses = all.filter((p) => p.status === 'blocked');
  const totalCompared = all.reduce((a, p) => a + p.compared, 0);

  return `<div class="cards">
    <div class="card ${ran.length ? 'ok' : 'bad'}"><div class="n">${ran.length}/${all.length}</div>
      <div class="l">Comparison passes that ran</div></div>
    <div class="card"><div class="n">${totalCompared}</div><div class="l">Data points compared in total</div></div>
    <div class="card ${blockedPasses.length ? 'bad' : 'ok'}"><div class="n">${blockedPasses.length}</div>
      <div class="l">Passes blocked</div></div>
  </div>
  <p class="sub">Nothing here is configured per module. The engine works out what each screen publishes
  and applies whichever of these comparisons fit, so the same set is attempted whatever URLs you enter.
  Passes marked <strong>N/A</strong> found nothing of their kind on either screen &mdash; that is not a
  gap. Passes marked <strong>BLOCKED</strong> had something to work on and could not proceed, and say why.</p>
  <table>
    <thead><tr><th>Comparison</th><th>Status</th><th class="n">Compared</th><th class="n">Different</th><th>What it did, or why not</th></tr></thead>
    <tbody>${all
      .map(
        (p) =>
          `<tr><td><strong>${esc(p.name)}</strong></td>
           <td>${statusBadge(p.status)}</td>
           <td class="n">${p.compared || '—'}${p.compared ? `<br><span class="mono">${esc(p.unit)}</span>` : ''}</td>
           <td class="n">${p.status === 'ran' ? p.differences : '—'}</td>
           <td>${esc(p.detail)}</td></tr>`,
      )
      .join('')}</tbody>
  </table>
  ${
    blockedPasses.length
      ? `<div class="rc"><h4>${blockedPasses.length} comparison(s) could not run</h4>
         <p>These had data to work on and were prevented. Each one is a gap in what this report covers.</p>
         ${blockedPasses.map((p) => `<p><strong>${esc(p.name)}</strong><br><span class="mono">${esc(p.detail)}</span></p>`).join('')}</div>`
      : `<div class="rc good"><h4>Nothing was blocked</h4>
         <p>Every comparison that had data to work on ran. The passes marked N/A found no data of their
         kind on either screen for this module.</p></div>`
  }`;
}

/** Parts of the module that could not be compared, while others could. */
function limitationsSection(b: SuiteReportBundle): string {
  const r = b.result;
  if (!r.limitations?.length) return '';
  return r.limitations
    .map(
      (x) => `<div class="rc info"><h4>${esc(x.reason)}</h4>
        <p>${esc(x.detail)}</p>
        <p><strong>What to check</strong></p>
        <ul>${x.remedy.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
        <p class="hint">This limits coverage. It does not invalidate the comparisons that did run, and
        nothing here is counted as a difference.</p></div>`,
    )
    .join('\n');
}

/** Badge for a table's structural role. */
function roleBadge(role: string): string {
  if (role === 'summary') return badge('ok', 'SUMMARY');
  if (role === 'detail') return badge('warn', 'RECORD LISTING');
  if (role === 'strip') return badge('dim', 'KPI STRIP');
  return badge('bad', 'UNCLEAR');
}

/**
 * How each screen presents this module, and which comparison mode followed from it.
 *
 * This comes before the results because it determines what the results mean. A summary
 * compared against a summary is like for like. A summary compared against a record listing
 * would not be, and the tool declining to do that is a finding in its own right rather than
 * a gap to apologise for.
 */
function structureSection(b: SuiteReportBundle): string {
  const r = b.result;
  const mode = r.mode;

  const modeLabel =
    mode.mode === 'detail-assisted'
      ? 'Detail-assisted &mdash; summary against summary, corroborated by a record-level listing'
      : 'Summary against summary &mdash; only what both screens publish';

  const row = (s: TableStructure, side: string) =>
    `<tr>
      <td>${esc(side)}</td>
      <td>${esc(s.name)}</td>
      <td>${roleBadge(s.role)}${s.transposed ? ` ${badge('warn', 'PIVOTED')}` : ''}</td>
      <td>${esc(s.rowKind)}</td>
      <td class="n">${s.bodyRows}</td>
      <td class="n">${s.usableLabels}</td>
      <td class="n">${s.numericColumns}</td>
      <td class="n">${s.textColumns}</td>
      <td>${s.hasTotalRow ? esc(s.totalRowLabel ?? 'yes') : '<span class="mono">none</span>'}</td>
      <td>${s.hasBreakdown ? esc(s.segments.join('/')) : '<span class="mono">none</span>'}</td>
      <td class="n">${s.confidence}</td>
    </tr>`;

  const all = [
    ...r.structure.left.map((s) => ({ s, side: r.left.label })),
    ...r.structure.right.map((s) => ({ s, side: r.right.label })),
  ];

  const lowConfidence = all.filter(({ s }) => s.confidence < 0.7 || s.role === 'unknown');

  return `<div class="rc ${mode.mode === 'detail-assisted' ? 'good' : 'info'}">
    <h4>Comparison mode: ${modeLabel}</h4>
    <p>${esc(mode.reason)}</p>
    <p class="hint">Summary against summary is the default and always the fallback. It compares only figures
    both screens actually publish, so nothing depends on this tool reconstructing a number neither screen
    showed. A record-level listing is used in addition, never instead &mdash; and only once it is shown to be
    complete.</p>
  </div>

  <h3>How each screen presents this module</h3>
  <p class="sub">${esc(r.structure.summary)}</p>
  <div class="scroll"><table>
    <thead><tr><th>Screen</th><th>Table</th><th>Structure</th><th>Rows are</th>
      <th class="n">Rows</th><th class="n">Labelled</th><th class="n">Numeric cols</th><th class="n">Text cols</th>
      <th>Grand total</th><th>Breakdown</th><th class="n">Conf.</th></tr></thead>
    <tbody>${all.map(({ s, side }) => row(s, side)).join('')}</tbody>
  </table></div>

  ${
    lowConfidence.length
      ? `<div class="rc"><h4>${lowConfidence.length} table(s) could not be classified confidently</h4>
         <p>The structure of these was ambiguous, and structure decides how they are compared. Check them
         before relying on any result that involves them.</p>
         <p class="mono">${lowConfidence
           .map(({ s, side }) => `${esc(side)} "${esc(s.name)}" &mdash; read as ${esc(s.role)}, confidence ${s.confidence}`)
           .join('<br>')}</p></div>`
      : ''
  }

  <details><summary>Why each table was classified this way</summary>
    <p class="hint">A misclassification changes what the whole report means, so the evidence behind each
    judgement is recorded rather than left implicit.</p>
    ${all
      .map(
        ({ s, side }) =>
          `<p><strong>${esc(side)} &mdash; ${esc(s.name)}</strong> ${roleBadge(s.role)}<br>` +
          (s.evidence.length
            ? `<span class="mono">${s.evidence.map((e) => `&bull; ${esc(e)}`).join('<br>')}</span>`
            : '<span class="mono">No distinguishing evidence either way.</span>') +
          '</p>',
      )
      .join('')}
  </details>

  ${detailViewsBlock(b)}`;
}

/** Record-level listings found, whether each was usable, and any corroboration it gave. */
function detailViewsBlock(b: SuiteReportBundle): string {
  const r = b.result;
  const views = r.mode.detailViews;
  if (!views.length) return '';

  const parts: string[] = [
    `<h3>Record-level detail views</h3>
     <p class="sub">A listing of individual records can corroborate a summary: sum its column and the
     summary's total should reappear. That only holds if the listing is complete, so completeness is
     established first.</p>
     <table><thead><tr><th>Screen</th><th>Listing</th><th class="n">Records shown</th>
       <th class="n">Records expected</th><th>Used</th></tr></thead>
     <tbody>${views
       .map(
         (v) =>
           `<tr><td>${esc(v.sideLabel)}</td><td>${esc(v.name)}</td><td class="n">${v.records}</td>
            <td class="n">${v.expectedRecords ?? '—'}</td>
            <td>${v.usable ? badge('ok', 'AGGREGATED') : badge('warn', 'NOT USED')}</td></tr>`,
       )
       .join('')}</tbody></table>`,
  ];

  for (const v of views.filter((x) => !x.usable)) {
    parts.push(`<div class="rc info"><h4>${esc(v.sideLabel)} &mdash; ${esc(v.name)}: not used</h4>
      <p>${esc(v.why)}</p>
      <p class="hint">This is a limit on what the screen displays, not a discrepancy. Nothing in the
      difference count comes from it. To use this listing, the screen would need to show every record
      rather than one page.</p></div>`);
  }

  for (const c of r.mode.corroboration) {
    parts.push(`<div class="rc good"><h4>${esc(c.view.sideLabel)} &mdash; ${esc(c.view.name)}: aggregated</h4>
      <p>${esc(c.note)}</p>
      <table><thead><tr><th>Listing column</th><th class="n">Sum of all records</th>
        <th>Summary figure</th><th class="n">Summary value</th><th class="n">Delta</th>
        <th class="n">Tol.</th><th>Verdict</th></tr></thead>
      <tbody>${c.checks
        .map(
          (k) =>
            `<tr><td>${esc(k.detailColumn)}</td><td class="n">${num(k.aggregate)}</td>
             <td>${esc(k.summaryRow)} / ${esc(k.summaryColumn)}</td>
             <td class="n">${num(k.expected)}</td><td class="n">${num(k.delta)}</td>
             <td class="n">${num(k.tolerance)}</td><td>${verdictBadge(k.verdict)}</td></tr>`,
        )
        .join('')}</tbody></table>
      <p class="hint">These check a screen against its own records. They are separate from the comparison
      between the two screens and are not counted in its totals.</p></div>`);
  }

  return parts.join('\n');
}

/** One table's structure, in enough detail to spot a transposed or unexpected layout. */
function observedTableDetail(t: ObservedTable, side: string): string {
  const cell = (s: string) => `<td class="mono">${esc(s || '—')}</td>`;
  return `<details><summary>${esc(side)} &mdash; ${esc(t.name)} (${t.rows} usable row label(s), ${t.bodyWidth} body column(s))</summary>
    ${
      t.transposedFrom
        ? `<div class="rc info" style="margin:8px 0"><h4>Pivoted before comparison</h4>
           <p>${esc(t.transposedFrom)}</p></div>`
        : ''
    }
    <p class="hint">Header row the column matching works from:</p>
    <div class="scroll"><table><tbody><tr>${t.headerRow.map(cell).join('')}</tr></tbody></table></div>
    ${
      t.sample.length
        ? `<p class="hint">First ${t.sample.length} body row(s) as captured:</p>
           <div class="scroll"><table><tbody>${t.sample
             .map((row) => `<tr>${row.map(cell).join('')}</tr>`)
             .join('')}</tbody></table></div>`
        : ''
    }
    <p class="hint">Row labels extracted for matching (${t.labels.length} shown):
      <span class="mono">${esc(t.labels.join(' · ') || 'none — this table has no row labels, so it cannot be matched by row')}</span></p>
  </details>`;
}

/**
 * Breakdown reporting, kept deliberately separate from the value comparison.
 *
 * A screen that splits each row by pay type carries strictly more information than one
 * that shows only a total. That is a gap in coverage, not a disagreement — so it is
 * counted here, on its own, and never added to the difference count. Where both screens
 * carry the breakdown, each segment is compared individually and reported below the
 * totals rather than mixed in with them.
 */
function breakdownSection(b: SuiteReportBundle): string {
  const r = b.result;
  const bd = r.summary.breakdown;
  const relevant = r.grids.filter((g) => g.breakdown && g.breakdown.availability !== 'neither');

  if (!relevant.length) {
    return `<div class="rc good"><h4>Neither screen breaks its rows down into segments</h4>
      <p>Every row on both screens is a single total, so each one was compared directly against its
      counterpart. There is no breakdown to reconcile and nothing was left uncompared on this account.</p>
    </div>`;
  }

  const cards = `<div class="cards">
    <div class="card"><div class="n">${bd.gridsBothSides}</div><div class="l">Grid(s) with a breakdown on both screens</div></div>
    <div class="card ${bd.gridsOneSideOnly ? 'warn' : 'ok'}"><div class="n">${bd.gridsOneSideOnly}</div>
      <div class="l">Grid(s) with a breakdown on one screen only</div></div>
    <div class="card ${bd.missingBreakdownEntities ? 'warn' : 'ok'}"><div class="n">${bd.missingBreakdownEntities}</div>
      <div class="l">Row(s) whose breakdown is missing on the other screen</div></div>
    <div class="card ${bd.uncomparedSegmentRows ? 'warn' : 'ok'}"><div class="n">${bd.uncomparedSegmentRows}</div>
      <div class="l">Segment row(s) with no counterpart to compare</div></div>
    ${
      bd.segmentCells
        ? `<div class="card"><div class="n">${bd.segmentCells}</div><div class="l">Segment-level cells compared</div></div>
           <div class="card ok"><div class="n">${bd.segmentMatched}</div><div class="l">Segment cells matched</div></div>
           <div class="card ${bd.segmentMismatched ? 'bad' : 'ok'}"><div class="n">${bd.segmentMismatched}</div>
             <div class="l">Segment cells different</div></div>`
        : ''
    }
  </div>`;

  const parts: string[] = [cards];

  parts.push(`<p class="hint">These counts are reported on their own and are <strong>not</strong> included in
    the ${r.summary.mismatched} difference(s) at the top of this report. A breakdown available on one screen
    only means the other screen simply does not publish that detail &mdash; the totals still agreed or
    disagreed on their own merits, which is what the difference count reflects.</p>`);

  for (const g of relevant) {
    const bk = g.breakdown;
    const kind =
      bk.availability === 'both'
        ? 'good'
        : 'info';
    const oneSide =
      bk.availability === 'left' ? r.left.label : bk.availability === 'right' ? r.right.label : null;
    const otherSide =
      bk.availability === 'left' ? r.right.label : bk.availability === 'right' ? r.left.label : null;

    const head = `<div class="rc ${kind}" style="margin:12px 0">
      <h4>${esc(g.name)} &mdash; ${
        bk.availability === 'both'
          ? 'breakdown present on both screens, compared segment by segment'
          : `breakdown present on ${esc(oneSide ?? '')} only`
      }</h4>
      ${bk.note ? `<p>${esc(bk.note)}</p>` : ''}
      <table style="margin-top:10px"><thead><tr><th></th>
        <th>${esc(r.left.label)}</th><th>${esc(r.right.label)}</th></tr></thead>
        <tbody>
          <tr><td>Segments shown</td>
            <td class="mono">${esc(describeSegments(bk.leftSegments) || '—')}</td>
            <td class="mono">${esc(describeSegments(bk.rightSegments) || '—')}</td></tr>
          <tr><td>Rows with a breakdown the other screen lacks</td>
            <td class="n">${bk.onlyOnLeft}</td><td class="n">${bk.onlyOnRight}</td></tr>
        </tbody></table>
      ${
        bk.availability !== 'both'
          ? `<p class="hint">Totals were compared total-against-total, so the headline comparison for this
             grid is like for like. The ${bk.uncomparedSegmentRows} segment row(s) on
             ${esc(oneSide ?? '')} have no counterpart on ${esc(otherSide ?? '')} and are counted above as a
             missing breakdown &mdash; ${badge('warn', 'NOT COMPARED')}, and not as a value mismatch.</p>`
          : ''
      }
    </div>`;

    parts.push(head);

    const sc = bk.segmentComparison;
    if (!sc) continue;

    if (sc.segmentsOnlyOnLeft.length || sc.segmentsOnlyOnRight.length) {
      parts.push(`<div class="rc info"><h4>${esc(g.name)} &mdash; some segments exist on one screen only</h4>
        <p>${
          sc.segmentsOnlyOnLeft.length
            ? `${esc(r.left.label)} shows <span class="mono">${esc(sc.segmentsOnlyOnLeft.join(', '))}</span> with no counterpart. `
            : ''
        }${
          sc.segmentsOnlyOnRight.length
            ? `${esc(r.right.label)} shows <span class="mono">${esc(sc.segmentsOnlyOnRight.join(', '))}</span> with no counterpart.`
            : ''
        }</p>
        <p class="hint">Counted as a missing breakdown for those segments, not as a difference in value.</p></div>`);
    }

    const tableId = `t-bd-${g.id}`;
    const rows = sc.outcomes
      .flatMap((o) =>
        o.cells.map((c) => {
          const bad = c.verdict !== 'match';
          return `<tr data-diff="${bad ? '1' : '0'}">
            <td>${esc(o.entity)}</td><td>${esc(o.segment)}</td>
            <td class="mono">${esc(o.leftSegment || '—')} / ${esc(o.rightSegment || '—')}</td>
            <td>${esc(c.group)}</td><td>${esc(c.column)}</td>
            <td class="n">${esc(c.left.raw || '—')}</td><td class="n">${esc(c.right.raw || '—')}</td>
            <td class="n">${c.delta === null ? '—' : num(c.delta)}</td>
            <td class="n">${c.tolerance}</td>
            <td>${cellBadge(c)}</td></tr>`;
        }),
      )
      .join('');

    parts.push(`<p class="sub">${sc.rowPairs} segment row pair(s), ${sc.totalCells} cell(s):
      ${sc.matched} matched${sc.roundedMatches ? ` (${sc.roundedMatches} after allowing for display rounding)` : ''},
      ${sc.mismatched} different, ${sc.missing} missing on one side. These are segment-level results and are
      separate from the total-level results above.</p>
      <div class="tools">
        <input type="search" data-filter="${tableId}" placeholder="Filter segments…">
        <label class="chk"><input type="checkbox" data-diffonly="${tableId}" checked> differences only</label>
      </div>
      <div class="scroll"><table id="${tableId}" class="tbl-detail">
        <thead><tr><th>Row</th><th>Segment</th><th>As printed (L / R)</th>
          <th>Group</th><th>Column</th>
          <th class="n">${esc(r.left.label)}</th><th class="n">${esc(r.right.label)}</th>
          <th class="n">Delta</th><th class="n">Tol.</th><th>Verdict</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`);
  }

  return parts.join('\n');
}

/**
 * Everything that could not be compared, in one place.
 *
 * Previously an unmatched row was a bare label inside a collapsed block, so there was
 * no way to see what it held or how near it came to matching. This gathers rows,
 * columns, whole tables and skipped groups together, with values, so a gap in coverage
 * is as visible as a difference.
 */
function notMatchedSection(b: SuiteReportBundle): string {
  const r = b.result;
  const parts: string[] = [];

  // --- rows with no counterpart ---
  for (const g of r.grids) {
    for (const [sideLabel, rows, otherLabel] of [
      [r.left.label, g.coverage.unmatchedLeft, r.right.label],
      [r.right.label, g.coverage.unmatchedRight, r.left.label],
    ] as const) {
      if (!rows.length) continue;
      parts.push(`<h3>${rows.length} row(s) only on ${esc(sideLabel)} &mdash; ${esc(g.name)}</h3>
        <p class="sub">These rows exist on ${esc(sideLabel)} but no matching row was found on
        ${esc(otherLabel)}, so their values were never compared. The closest candidate and its
        similarity score are shown to explain the near miss &mdash; a genuinely missing row will have a
        low score, whereas a high score suggests the labels differ more than the matcher allows.</p>
        <div class="scroll"><table>
          <thead><tr><th>Row</th><th>Closest on ${esc(otherLabel)}</th><th class="n">Score</th>
            <th>Values not compared</th></tr></thead>
          <tbody>${rows
            .map(
              (u) => `<tr data-diff="1">
              <td>${esc(u.label)}</td>
              <td>${esc(u.closest?.label ?? '—')}</td>
              <td class="n">${u.closest ? u.closest.score : '—'}</td>
              <td class="mono">${
                u.values.filter((v) => v.raw).length
                  ? esc(
                      u.values
                        .filter((v) => v.raw)
                        .map((v) => `${v.column}=${v.raw}`)
                        .join('  ·  '),
                    )
                  : '(no values)'
              }</td></tr>`,
            )
            .join('')}</tbody></table></div>`);
    }
  }

  // --- columns with no counterpart ---
  for (const g of r.grids) {
    const { left, right } = g.unpairedColumns;
    if (!left.length && !right.length) continue;
    parts.push(`<h3>Columns with no counterpart &mdash; ${esc(g.name)}</h3>
      <p class="sub">These columns appear on one screen only, so there is nothing to compare them
      against. This is often legitimate (one product simply reports more), but it is also where a
      genuinely missing figure would show up.</p>
      <table><thead><tr><th>Only on</th><th>Group</th><th>Column</th><th>Header</th></tr></thead>
      <tbody>${[
        ...left.map((c) => ({ side: r.left.label, c })),
        ...right.map((c) => ({ side: r.right.label, c })),
      ]
        .map(
          ({ side, c }) =>
            `<tr data-diff="1"><td>${esc(side)}</td><td>${esc(c.group)}</td>
             <td>${esc(c.name)}</td><td class="mono">${esc(c.header)}</td></tr>`,
        )
        .join('')}</tbody></table>`);
  }

  // --- groups excluded as non-numeric ---
  const skipped = r.grids.filter((g) => g.skippedGroups?.length);
  if (skipped.length) {
    parts.push(`<h3>Column groups excluded</h3>
      <table><thead><tr><th>Grid</th><th>Group(s)</th><th>Reason</th></tr></thead>
      <tbody>${skipped
        .map(
          (g) =>
            `<tr><td>${esc(g.name)}</td><td>${esc(g.skippedGroups.join(', '))}</td>
             <td>Holds text or dates rather than quantities, so there is nothing to compare numerically.</td></tr>`,
        )
        .join('')}</tbody></table>`);
  }

  // --- tables with no counterpart, split by whether the reason is structural ---
  //
  // A record listing on one screen and a summary on the other are not a missing table;
  // they are the two screens publishing this module at different levels of detail. Listing
  // that alongside genuinely unpaired tables invited it to be read as a coverage defect, so
  // structural cases are named as such and kept apart.
  const roleOf = new Map<string, string>();
  for (const [side, structures] of [
    [r.left.label, r.structure?.left ?? []],
    [r.right.label, r.structure?.right ?? []],
  ] as const) {
    for (const s of structures) roleOf.set(`${side}|${s.index}`, s.role);
  }

  const lonely = [
    ...r.observation.leftTables.filter((t) => !t.paired).map((t) => ({ side: r.left.label, t })),
    ...r.observation.rightTables.filter((t) => !t.paired).map((t) => ({ side: r.right.label, t })),
  ].map((x) => ({ ...x, role: roleOf.get(`${x.side}|${x.t.index ?? -1}`) ?? 'unknown' }));

  const structural = lonely.filter((x) => x.role === 'detail' || x.role === 'strip');
  const unexplained = lonely.filter((x) => x.role !== 'detail' && x.role !== 'strip');

  if (structural.length) {
    parts.push(`<h3>Tables present on one screen by design</h3>
      <p class="sub">These have no counterpart because the two screens publish this module at different
      levels of detail, not because data is missing. They are <strong>not</strong> counted as differences.</p>
      <table><thead><tr><th>Only on</th><th>Table</th><th>Structure</th><th class="n">Rows</th><th>Why it has no counterpart</th></tr></thead>
      <tbody>${structural
        .map(
          ({ side, t, role }) =>
            `<tr><td>${esc(side)}</td><td>${esc(t.name)}</td><td>${roleBadge(role)}</td>
             <td class="n">${t.rows}</td>
             <td>${
               role === 'detail'
                 ? `A listing of individual records. The other screen publishes only aggregated figures for this module, so there is nothing to compare it against row for row.`
                 : `A single-row KPI strip with no row labels. It has no rows to match, and no equivalent strip appears on the other screen.`
             }</td></tr>`,
        )
        .join('')}</tbody></table>`);
  }

  if (unexplained.length) {
    parts.push(`<h3>Tables with no counterpart</h3>
      <p class="sub">Present on one screen with no comparable table on the other, and not explained by a
      difference in structure. Worth checking: these may be genuine coverage gaps.</p>
      <table><thead><tr><th>Only on</th><th>Table</th><th>Structure</th><th class="n">Data rows</th><th>Column groups</th></tr></thead>
      <tbody>${unexplained
        .map(
          ({ side, t, role }) =>
            `<tr><td>${esc(side)}</td><td>${esc(t.name)}</td><td>${roleBadge(role)}</td>
             <td class="n">${t.rows}</td>
             <td class="mono">${esc(t.groups.join(', ') || '—')}</td></tr>`,
        )
        .join('')}</tbody></table>`);
  }

  if (!parts.length) {
    return `<div class="rc good"><h4>Nothing was left out</h4>
      <p>Every row, column and table on both screens found a counterpart and was compared.</p></div>`;
  }
  return parts.join('\n');
}

/** Formula sections for one side. */
function sideFormulaSections(side: SideFormulas, idx: number): string {
  const rf = side.rowFormulas;
  const cc = side.columnChecks;
  if (!rf && !cc) return '';

  const rfId = `t-rf-${idx}`;
  const ccId = `t-cf-${idx}`;
  const parts: string[] = [];

  if (rf) {
    parts.push(`<h3>${esc(side.label)} &mdash; row formulas</h3>
    <p class="sub">Harvested from this screen's own hover tooltips and re-evaluated against its rendered
    values. ${rf.summary.passed}/${rf.summary.total} passed, ${rf.summary.failed} failed,
    ${rf.summary.unresolved} not evaluable because an operand is not displayed.</p>
    ${
      rf.missingReferences.length
        ? `<p class="hint">Operands with no matching row: <span class="mono">${rf.missingReferences.map(esc).join(', ')}</span></p>`
        : ''
    }
    <div class="tools"><input type="search" data-filter="${rfId}" placeholder="Filter…">
      <label class="chk"><input type="checkbox" data-diffonly="${rfId}"> failures only</label></div>
    <div class="scroll"><table id="${rfId}">
      <thead><tr><th>Row</th><th>Group</th><th>Formula (from tooltip)</th>
        <th class="n">Expected</th><th class="n">Rendered</th><th class="n">Delta</th><th>Verdict</th></tr></thead>
      <tbody>${rf.checks
        .map(
          (c) => `<tr data-diff="${c.verdict !== 'pass' ? '1' : '0'}">
        <td>${esc(c.rowLabel)}</td><td>${esc(c.category)}</td><td class="mono">${esc(c.formula)}</td>
        <td class="n">${num(c.expected)}</td><td class="n">${num(c.actual)}</td>
        <td class="n">${c.delta === null ? '—' : num(c.delta)}</td><td>${verdictBadge(c.verdict)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`);
  }

  if (cc) {
    parts.push(`<h3>${esc(side.label)} &mdash; derived columns (%, Avg., Tracking)</h3>
    <p class="sub">Each derived cell is tested against the plausible rules; the rule that reproduces the
    rendered value is reported. A cell fails only when no rule fits.
    ${cc.summary.passed}/${cc.summary.total} passed, ${cc.summary.failed} failed.</p>
    <div class="tools"><input type="search" data-filter="${ccId}" placeholder="Filter…">
      <label class="chk"><input type="checkbox" data-diffonly="${ccId}"> failures only</label></div>
    <div class="scroll"><table id="${ccId}">
      <thead><tr><th>Row</th><th>Group</th><th>Column</th><th>Rule that fits</th>
        <th class="n">Expected</th><th class="n">Rendered</th><th class="n">Delta</th><th>Verdict</th></tr></thead>
      <tbody>${cc.checks
        .map((c) => {
          const bad = c.verdict !== 'pass';
          const tried =
            bad && c.candidates?.length
              ? `<details><summary>${c.candidates.length} rules tried, none matched</summary>
                 <table style="margin:8px 0 0"><thead><tr><th>Candidate</th><th class="n">Would give</th></tr></thead>
                 <tbody>${c.candidates
                   .map((t) => `<tr><td class="mono">${esc(t.rule)}</td><td class="n">${num(t.expected)}</td></tr>`)
                   .join('')}</tbody></table></details>`
              : '';
          return `<tr data-diff="${bad ? '1' : '0'}">
          <td>${esc(c.rowLabel)}</td><td>${esc(c.category)}</td><td>${esc(c.column)}</td>
          <td class="mono">${esc(c.rule)}${tried}</td>
          <td class="n">${num(c.expected)}</td><td class="n">${num(c.actual)}</td>
          <td class="n">${c.delta === null ? '—' : num(c.delta)}</td><td>${verdictBadge(c.verdict)}</td></tr>`;
        })
        .join('')}</tbody></table></div>`);
  }

  return parts.join('\n');
}

export async function renderSuiteHtml(b: SuiteReportBundle): Promise<string> {
  const r = b.result;
  const s = r.summary;
  const shotIndex = buildShotIndex(b.screenshots);

  // --- carousel ---
  const slides: string[] = [];
  const dots: string[] = [];
  const jump: string[] = [];
  for (const [i, ref] of b.screenshots.entries()) {
    slides.push(
      `<div class="cr-slide" data-module="${esc(ref.module)}" data-caption="${esc(ref.caption)}">${await imgTag(ref)}</div>`,
    );
    const isLeft = ref.module === r.left.label;
    dots.push(
      `<button class="cr-dot${isLeft ? ' ag' : ''}" type="button" title="${esc(ref.module)} — ${esc(ref.caption)}" aria-label="Screenshot ${i + 1}"></button>`,
    );
    jump.push(`<option value="${i}">${i + 1}. ${esc(ref.module)} — ${esc(ref.caption)}</option>`);
  }

  const carousel = slides.length
    ? `<div class="cr">
    <div class="cr-head"><div class="cr-title" id="cr-title"></div><div class="cr-count" id="cr-count"></div></div>
    <div class="cr-stage">${slides.join('')}
      <button class="cr-nav cr-prev" id="cr-prev" type="button" aria-label="Previous">&#8249;</button>
      <button class="cr-nav cr-next" id="cr-next" type="button" aria-label="Next">&#8250;</button>
    </div>
    <div class="cr-foot">
      <button class="cr-btn" id="cr-prev2" type="button">&#8249; Prev</button>
      <button class="cr-btn" id="cr-next2" type="button">Next &#8250;</button>
      <select class="cr-jump" id="cr-jump" aria-label="Jump to screenshot">${jump.join('')}</select>
      <div class="cr-dots">${dots.join('')}</div>
    </div>
    <p class="hint">${slides.length} screenshots from this run, in sequence. Arrows, dots, jump list, or left/right keys.
      Outlined dots are ${esc(r.left.label)}; solid are ${esc(r.right.label)}.</p>
  </div>`
    : '<p class="hint">No screenshots captured for this run.</p>';

  const groupCards = Object.entries(s.byGroup)
    .map(([g, x]) => {
      const total = x.matched + x.mismatched + x.missing;
      return `<div class="card ${x.mismatched === 0 ? 'ok' : 'bad'}"><div class="n">${x.matched}/${total}</div>
        <div class="l">${esc(g)} matched</div></div>`;
    })
    .join('');

  const formulaFailures = b.sides.reduce((a, x) => a + (x.rowFormulas?.summary.failed ?? 0), 0);
  const columnFailures = b.sides.reduce((a, x) => a + (x.columnChecks?.summary.failed ?? 0), 0);

  // --- observation table ---
  const obsRow = (
    t: { name: string; rows: number; groups: string[]; paired: boolean },
    side: string,
  ) =>
    `<tr><td>${esc(side)}</td><td>${esc(t.name)}</td><td class="n">${t.rows}</td>
     <td class="mono">${esc(t.groups.join(', ') || '—')}</td>
     <td>${t.paired ? badge('ok', 'COMPARED') : badge('dim', 'no counterpart')}</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.moduleName)} — ${esc(r.left.label)} vs ${esc(r.right.label)}</title>
<style>${CSS}</style></head><body>
<header>
  <h1>${esc(r.moduleName)} &mdash; ${esc(r.left.label)} vs ${esc(r.right.label)}</h1>
  <div class="sub">Run <code>${esc(b.runId)}</code> &middot; generated ${esc(formatIso(r.generatedAt))}</div>
</header>
<main>

  <h2>Result at a glance</h2>
  ${
    r.blocked
      ? `<div class="rc"><h4>Not compared &mdash; ${esc(r.blocked.reason)}</h4>
         <p>The counts below are all zero because nothing was compared, <strong>not</strong> because
         everything agreed. Read the diagnosis in the next section.</p></div>`
      : ''
  }
  <p class="sub">Mode: <strong>${
    r.mode?.mode === 'detail-assisted'
      ? 'detail-assisted'
      : 'summary against summary'
  }</strong> &mdash; ${
    r.mode?.mode === 'detail-assisted'
      ? 'both screens\u2019 summaries compared, and corroborated against a complete record-level listing'
      : 'only figures both screens publish were compared'
  }. Explained in full under "Report structure and comparison mode".</p>
  <div class="cards">
    ${
      r.analytics
        ? `<div class="card ${r.analytics.mismatched ? 'bad' : 'ok'}">
             <div class="n">${r.analytics.matched}/${r.analytics.compared}</div>
             <div class="l">Analytics cards matched</div></div>`
        : ''
    }
    ${
      r.recordComparison
        ? `<div class="card ${r.recordComparison.summary.mismatched ? 'bad' : 'ok'}">
             <div class="n">${r.recordComparison.summary.matched}/${r.recordComparison.summary.totalCells}</div>
             <div class="l">Record cells matched (${r.recordComparison.summary.recordsCompared} records)</div></div>`
        : ''
    }
    <div class="card${r.blocked ? ' bad' : ''}"><div class="n">${s.gridsCompared}</div><div class="l">Grid(s) compared</div></div>
    <div class="card"><div class="n">${s.totalCells}</div><div class="l">Value cells compared</div></div>
    <div class="card${r.blocked ? '' : ' ok'}"><div class="n">${s.matched}</div><div class="l">Matched</div></div>
    ${
      s.roundedMatches
        ? `<div class="card ok"><div class="n">${s.roundedMatches}</div>
           <div class="l">of those, equal after rounding</div></div>`
        : ''
    }
    <div class="card ${s.mismatched ? 'bad' : r.blocked ? '' : 'ok'}"><div class="n">${s.mismatched}</div><div class="l">Different</div></div>
    <div class="card ${s.missing ? 'warn' : r.blocked ? '' : 'ok'}"><div class="n">${s.missing}</div><div class="l">Missing one side</div></div>
    <div class="card ${formulaFailures ? 'bad' : 'ok'}"><div class="n">${formulaFailures}</div><div class="l">Row-formula failures</div></div>
    <div class="card ${columnFailures ? 'bad' : 'ok'}"><div class="n">${columnFailures}</div><div class="l">Column-formula failures</div></div>
  </div>
  <div class="cards">${groupCards}</div>

  <h3>Run inputs</h3>
  <table>
    <thead><tr><th></th><th>AutoGroup</th><th>DMS</th></tr></thead>
    <tbody>
      <tr><td><strong>URL entered</strong></td>
        <td class="mono">${esc(b.inputs.autogroupUrl)}</td>
        <td class="mono">${esc(b.inputs.dmsUrl)}</td></tr>
      <tr><td>Landed on</td>
        <td class="mono">${esc(r.left.url ?? '—')}${
          r.left.url && r.left.url !== b.inputs.autogroupUrl ? ` ${badge('warn', 'redirected')}` : ''
        }</td>
        <td class="mono">${esc(r.right.url ?? '—')}${
          r.right.url && r.right.url !== b.inputs.dmsUrl ? ` ${badge('warn', 'redirected')}` : ''
        }</td></tr>
      <tr><td>Login role</td><td>${esc(b.inputs.autogroupRole)}</td><td>${esc(b.inputs.dmsRole)}</td></tr>
      <tr><td>Screens captured at</td><td>${esc(formatIso(b.capturedAt.left))}</td><td>${esc(formatIso(b.capturedAt.right))}</td></tr>
      <tr><td>Date range requested</td><td>${esc(r.dateRange.left ? formatDatesInText(r.dateRange.left) : 'unknown')}</td><td>${esc(r.dateRange.right ? formatDatesInText(r.dateRange.right) : 'unknown')}</td></tr>
    </tbody>
  </table>
  <p class="hint">Module name: <strong>${esc(b.inputs.moduleName)}</strong>${
    b.inputs.moduleNameDerived ? ' (derived from the AutoGroup URL)' : ' (entered)'
  }</p>
  ${
    r.dateRange.status === 'differ'
      ? `<div class="rc"><h4>The two screens requested different date ranges</h4><p>${esc(r.dateRange.note)}</p></div>`
      : r.dateRange.status === 'unknown'
        ? `<div class="rc info"><h4>Date range could not be confirmed</h4><p>${esc(r.dateRange.note)}</p></div>`
        : ''
  }
  ${
    b.daysStatus === 'empty'
      ? `<div class="rc"><h4>Data quality: the period strip rendered empty</h4>
         <p>This screen has a days-worked strip but it returned no values this run, so Tracking
         projections could not be verified independently and those checks were skipped rather than
         assumed correct.</p></div>`
      : ''
  }

  ${
    r.blocked
      ? `<h2>Nothing could be compared &mdash; why</h2>
         ${blockedSection(b)}`
      : ''
  }

  <h2>Comparison coverage &mdash; what was checked</h2>
  ${coverageSection(b)}

  <h2>Report structure and comparison mode</h2>
  ${structureSection(b)}

  <h2>Findings</h2>
  ${findings(b)}

  ${
    r.limitations?.length
      ? `<h2>What could not be compared</h2>
         <p class="sub">Parts of this module have no counterpart on the other screen, or could not be
         aligned. Listed here rather than folded into the results, and not counted as differences.</p>
         ${limitationsSection(b)}`
      : ''
  }

  <h2>Analytics strip</h2>
  <p class="sub">The row of KPI cards above the grid. These are not a table, so they are read as label
  and value pairs during the crawl and matched by label. On a module with no summary grid they carry the
  only figures that are directly comparable.</p>
  ${analyticsSection(b)}

  ${
    r.recordComparison
      ? `<h2>Record-by-record comparison</h2>
         <p class="sub">Both screens publish this module as a listing of individual records, so it was
         compared record by record: every column that pairs, descriptive as well as numeric.</p>
         ${recordsSection(b)}`
      : ''
  }

  <h2>What the crawl observed</h2>
  <p class="sub">Every table on both screens was profiled, then paired with its counterpart by shared row
  labels and column groups &mdash; not by position. Tables with no counterpart are listed so nothing is
  silently skipped.</p>
  <table>
    <thead><tr><th>Screen</th><th>Table</th><th class="n">Data rows</th><th>Column groups</th><th>Status</th></tr></thead>
    <tbody>
      ${r.observation.leftTables.map((t) => obsRow(t, r.left.label)).join('')}
      ${r.observation.rightTables.map((t) => obsRow(t, r.right.label)).join('')}
    </tbody>
  </table>
  <p class="sub">Expand a table below to see the header row, the first rows as captured, and the row labels
  that were extracted for matching. This is what to read when two screens will not align.</p>
  ${r.observation.leftTables.map((t) => observedTableDetail(t, r.left.label)).join('')}
  ${r.observation.rightTables.map((t) => observedTableDetail(t, r.right.label)).join('')}
  <details><summary>Pairing and geometry notes</summary>
    <p class="mono">${r.observation.notes.map(esc).join('<br>')}</p>
    ${r.grids
      .map(
        (g) => `<p class="mono"><strong>${esc(g.name)}</strong><br>
        ${esc(r.left.label)}: ${g.geometry.left.notes.map(esc).join(' ')}<br>
        ${esc(r.right.label)}: ${g.geometry.right.notes.map(esc).join(' ')}</p>`,
      )
      .join('')}
  </details>

  <h2 id="evidence">Evidence — the screens themselves</h2>
  ${
    b.capturedThisRun
      ? `<p class="sub">Captured fresh during this run: both screens were logged into and reloaded,
         then photographed. ${b.screenshots.length} image(s) below, taken
         ${esc(formatIso(b.capturedAt.left))} and ${esc(formatIso(b.capturedAt.right))}.</p>`
      : `<div class="rc info"><h4>These screenshots are not from this run</h4>
         <p>This run reused captures taken earlier (<code>${esc(formatIso(b.capturedAt.left))}</code> and
         <code>${esc(formatIso(b.capturedAt.right))}</code>) instead of crawling the portal again, so the images and
         values below are that earlier snapshot. Re-run without the reuse option for current data.</p></div>`
  }
  ${carousel}

  ${
    r.grids.length
      ? `<h2>Comparison by grid</h2>
         ${r.grids.map((g) => gridSection(g, r, shotIndex)).join('\n')}`
      : ''
  }

  <h2>Totals and breakdown</h2>
  <p class="sub">Totals are always compared against totals. Where both screens also break a row down into
  segments, each segment is compared individually. Where only one screen breaks it down, the missing
  breakdown is counted here in its own right rather than being reported as the totals disagreeing.</p>
  ${breakdownSection(b)}

  <h2>What did not match</h2>
  ${notMatchedSection(b)}

  <h2>Formula validation</h2>
  <p class="sub">Each screen is checked against its own documented formulas, independently of the other.</p>
  ${b.sides.map((side, i) => sideFormulaSections(side, i)).join('\n') || '<p class="hint">No formulas were harvested for this run.</p>'}

</main>
<footer>
  Generated by the My Dealer KPI suite runner &mdash; <code>${esc(b.command)}</code><br>
  Read-only capture: both screens were navigated and read, never modified. Credentials live in a gitignored
  .env and are redacted from every artifact.
</footer>
<script>${JS}</script>
</body></html>`;
}
