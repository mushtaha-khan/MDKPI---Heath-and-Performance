/**
 * Build an Excel workbook from a saved PERFORMANCE report (artifacts/perf/<run>/results.json).
 *
 * Sheets:
 *   1. Summary   — run metadata + OK/SLOW/INFO/ERROR totals.
 *   2. Results   — one row per (report × filter × scope): avg load, benchmark, verdict,
 *                  date range, and the individual rep timings (so outliers are visible).
 */
import ExcelJS from 'exceljs';

const COLORS = { OK: 'FF2ECC71', SLOW: 'FFE74C3C', INFO: 'FF3498DB', ERROR: 'FFE74C3C', head: 'FF1F2A37', slowRow: 'FFFDECEA' };

function styleHeader(row) {
  row.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.head } }; });
  row.height = 20;
}

export async function buildPerfWorkbook(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MyDealerKPI Performance Tester';
  wb.created = new Date();
  const cfg = report.cfg || {};
  const s = report.summary || {};
  const results = report.results || [];

  // Summary
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 26 }, { width: 60 }];
  sum.addRow(['API Performance Report']).font = { bold: true, size: 16 };
  sum.addRow([]);
  if (cfg.dealerName) sum.addRow(['Dealership', cfg.dealerName]);
  sum.addRow(['Role', cfg.role || '-']);
  sum.addRow(['Tenant', cfg.base || '-']);
  sum.addRow(['Started', report.startedAt || '-']);
  sum.addRow(['Finished', report.finishedAt || '-']);
  sum.addRow(['Filters', (cfg.filters || []).join(', ')]);
  sum.addRow(['Scopes', (cfg.scopes || []).join(', ')]);
  sum.addRow(['Repetitions', cfg.reps || '-']);
  sum.addRow([]);
  const th = sum.addRow(['Result', 'Count']); styleHeader(th);
  for (const [k, v] of [['OK', s.ok_count || 0], ['SLOW', s.slow || 0], ['INFO', s.info || 0], ['ERROR', s.error || 0], ['TOTAL', s.total || 0]]) {
    const r = sum.addRow([k, v]); if (COLORS[k]) r.getCell(1).font = { bold: true, color: { argb: COLORS[k] } };
  }
  sum.getColumn(1).eachCell((c) => { if (!c.font) c.font = { bold: true }; });

  // Results
  const res = wb.addWorksheet('Results', { views: [{ state: 'frozen', ySplit: 1 }] });
  res.columns = [
    { header: '#', key: 'n', width: 5 },
    { header: 'Heading', key: 'group', width: 22 },
    { header: 'Sub-Heading', key: 'subGroup', width: 18 },
    { header: 'Report', key: 'name', width: 30 },
    { header: 'Filter', key: 'filterLabel', width: 18 },
    { header: 'Scope', key: 'scope', width: 9 },
    { header: 'Date Range', key: 'dateRange', width: 32 },
    { header: 'Avg (s)', key: 'avgSec', width: 9 },
    { header: 'Individual (s)', key: 'timings', width: 22 },
    { header: 'Benchmark', key: 'benchmark', width: 12 },
    { header: 'Verdict', key: 'verdict', width: 9 },
    { header: 'Note', key: 'note', width: 30 },
  ];
  styleHeader(res.getRow(1));
  results.forEach((r, i) => {
    const row = res.addRow({
      n: i + 1, group: r.group, subGroup: r.subGroup || '', name: r.name,
      filterLabel: r.filterLabel || r.filter, scope: r.scope, dateRange: r.dateRange || '',
      avgSec: r.avgSec, timings: (r.timingsSec || []).join(', '),
      benchmark: r.benchmark, verdict: r.verdict,
      note: [r.fromNav ? 'timed from navigation (no main-data API seen)' : '', r.dateFallback ? 'all-time fallback Jan 1 2015' : '', r.navError].filter(Boolean).join('; '),
    });
    row.getCell('verdict').font = { bold: true, color: { argb: COLORS[r.verdict] || 'FF000000' } };
    if (r.verdict === 'SLOW' || r.verdict === 'ERROR') row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.slowRow } }; });
  });
  res.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: res.columns.length } };

  // ---- All APIs: every first-party Fetch/XHR captured (rep 1 per config), module-wise ----
  const allApi = wb.addWorksheet('All APIs', { views: [{ state: 'frozen', ySplit: 1 }] });
  allApi.columns = [
    { header: '#', key: 'n', width: 5 },
    { header: 'Heading', key: 'group', width: 20 },
    { header: 'Report', key: 'module', width: 26 },
    { header: 'Filter', key: 'filter', width: 16 },
    { header: 'Scope', key: 'scope', width: 8 },
    { header: 'API Name', key: 'name', width: 22 },
    { header: 'Method', key: 'method', width: 8 },
    { header: 'Endpoint', key: 'endpoint', width: 55 },
    { header: 'Query / Payload', key: 'payload', width: 45 },
    { header: 'Status', key: 'status', width: 8 },
    { header: 'Time (ms)', key: 'ms', width: 10 },
    { header: 'Count', key: 'count', width: 7 },
    { header: 'From Rep', key: 'rep', width: 9 },
  ];
  styleHeader(allApi.getRow(1));
  let an = 1;
  for (const r of results) {
    for (const a of r.allApis || []) {
      const row = allApi.addRow({
        n: an++, group: r.group, module: r.name, filter: r.filterLabel || r.filter, scope: r.scope,
        name: a.name, method: a.method, endpoint: a.endpoint, payload: a.payload || a.query || '',
        status: a.status, ms: typeof a.ms === 'number' ? a.ms : '', count: a.count || 1, rep: r.payloadRep || 1,
      });
      if (typeof a.status === 'number' && a.status >= 400) row.getCell('status').font = { bold: true, color: { argb: COLORS.ERROR } };
      if (typeof a.ms === 'number' && r.slowThresholdMs && a.ms > r.slowThresholdMs) row.getCell('ms').font = { bold: true, color: { argb: COLORS.SLOW } };
    }
  }
  if (an === 1) allApi.addRow({ module: 'No APIs captured' });
  allApi.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: allApi.columns.length } };

  // ---- Slow APIs: only those exceeding the config's §2 threshold ----
  const slow = wb.addWorksheet('Slow APIs', { views: [{ state: 'frozen', ySplit: 1 }] });
  slow.columns = [
    { header: '#', key: 'n', width: 5 },
    { header: 'Heading', key: 'group', width: 20 },
    { header: 'Report', key: 'module', width: 26 },
    { header: 'Filter', key: 'filter', width: 16 },
    { header: 'Scope', key: 'scope', width: 8 },
    { header: 'API Name', key: 'name', width: 22 },
    { header: 'Method', key: 'method', width: 8 },
    { header: 'Endpoint', key: 'endpoint', width: 55 },
    { header: 'Query / Payload', key: 'payload', width: 45 },
    { header: 'Status', key: 'status', width: 8 },
    { header: 'Time (ms)', key: 'ms', width: 10 },
    { header: 'Count', key: 'count', width: 7 },
    { header: 'From Rep', key: 'rep', width: 9 },
    { header: 'Threshold (ms)', key: 'thr', width: 13 },
  ];
  styleHeader(slow.getRow(1));
  let sn = 1;
  for (const r of results) {
    for (const a of r.slowApis || []) {
      const row = slow.addRow({
        n: sn++, group: r.group, module: r.name, filter: r.filterLabel || r.filter, scope: r.scope,
        name: a.name, method: a.method, endpoint: a.endpoint, payload: a.payload || a.query || '',
        status: a.status, ms: typeof a.ms === 'number' ? a.ms : '', count: a.count || 1, rep: r.payloadRep || 1, thr: r.slowThresholdMs,
      });
      row.getCell('ms').font = { bold: true, color: { argb: COLORS.SLOW } };
    }
  }
  if (sn === 1) slow.addRow({ module: 'No slow APIs above threshold' });
  slow.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: slow.columns.length } };

  return wb.xlsx.writeBuffer();
}
