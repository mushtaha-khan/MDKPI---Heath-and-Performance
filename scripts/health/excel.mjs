/**
 * Build an Excel workbook from a saved crawl report (results.json).
 *
 * Sheets:
 *   1. Summary      — run metadata + totals.
 *   2. Failed APIs  — ONE row per failed first-party API (module, verdict, method, status,
 *                     kind, URL). This is the sheet for "which APIs failed" at a glance.
 *   3. All Modules  — every crawled module with its verdict, HTTP, API count, detail.
 *
 * Returns a Buffer of the .xlsx file.
 */
import ExcelJS from 'exceljs';

const COLORS = {
  PASS: 'FF2ECC71',
  WARN: 'FFF1C40F',
  FAIL: 'FFE74C3C',
  SKIP: 'FF95A5A6',
  head: 'FF1F2A37',
  failRow: 'FFFDECEA',
};

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.head } };
    cell.alignment = { vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF444444' } } };
  });
  row.height = 20;
}

export async function buildWorkbook(report, history = null) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MyDealerKPI Health Crawler';
  wb.created = new Date();

  const cfg = report.cfg || {};
  const s = report.summary || {};
  const results = report.results || [];

  // ---- Sheet 1: Summary ----
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 24 }, { width: 60 }];
  const addKV = (k, v) => sum.addRow([k, v]);
  sum.addRow(['Dealership Health Report']).font = { bold: true, size: 16 };
  sum.addRow([]);
  if (cfg.dealerName) addKV('Dealership', cfg.dealerName);
  addKV('Role', cfg.role || '-');
  addKV('Tenant', cfg.base || '-');
  addKV('User', cfg.user || '-');
  addKV('Started', report.startedAt || '-');
  addKV('Finished', report.finishedAt || '-');
  sum.addRow([]);
  const totalsHead = sum.addRow(['Result', 'Count']);
  styleHeader(totalsHead);
  const totalRows = [
    ['PASS', s.pass || 0], ['WARN', s.warn || 0], ['FAIL', s.fail || 0],
    ['SKIP', s.skip || 0], ['TOTAL', s.total || 0],
  ];
  for (const [k, v] of totalRows) {
    const r = sum.addRow([k, v]);
    if (COLORS[k]) r.getCell(1).font = { bold: true, color: { argb: COLORS[k] } };
    if (k === 'TOTAL') r.font = { bold: true };
  }
  sum.getColumn(1).eachCell((c) => { if (!c.font) c.font = { bold: true }; });

  // ---- Sheet 2: Failed APIs (the headline view) ----
  const fa = wb.addWorksheet('Failed APIs', { views: [{ state: 'frozen', ySplit: 1 }] });
  fa.columns = [
    { header: '#', key: 'n', width: 5 },
    { header: 'Module', key: 'module', width: 34 },
    { header: 'Menu Group', key: 'group', width: 30 },
    { header: 'Verdict', key: 'verdict', width: 9 },
    { header: 'Method', key: 'method', width: 8 },
    { header: 'Status', key: 'status', width: 8 },
    { header: 'Failure Kind', key: 'kind', width: 16 },
    { header: 'API URL', key: 'url', width: 90 },
  ];
  styleHeader(fa.getRow(1));
  let n = 1;
  for (const r of results) {
    const fails = r.failedApis || [];
    for (const f of fails) {
      const row = fa.addRow({
        n: n++, module: r.name, group: r.group, verdict: r.verdict,
        method: f.method || '-', status: f.status, kind: f.kind, url: f.url,
      });
      row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.failRow } }; });
      row.getCell('status').font = { bold: true, color: { argb: COLORS.FAIL } };
    }
    // A navigation-level failure with no captured API (e.g. bounced to login) still shows.
    if (r.verdict === 'FAIL' && !fails.length) {
      const row = fa.addRow({ n: n++, module: r.name, group: r.group, verdict: r.verdict, method: '-', status: r.httpStatus, kind: 'nav/other', url: r.reason });
      row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.failRow } }; });
    }
  }
  if (n === 1) fa.addRow({ module: 'No failed APIs 🎉', group: '', verdict: 'PASS' });
  fa.autoFilter = 'A1:H1';

  // ---- Sheet 3: Export Tests (PDF/Excel buttons in each module & tab) ----
  const ex = wb.addWorksheet('Export Tests', { views: [{ state: 'frozen', ySplit: 1 }] });
  ex.columns = [
    { header: '#', key: 'n', width: 5 },
    { header: 'Module', key: 'module', width: 34 },
    { header: 'Menu Group', key: 'group', width: 28 },
    { header: 'Tab', key: 'tab', width: 22 },
    { header: 'Format', key: 'format', width: 10 },
    { header: 'Result', key: 'result', width: 10 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Endpoint / Error', key: 'endpoint', width: 80 },
  ];
  styleHeader(ex.getRow(1));
  let en = 1;
  for (const r of results) {
    for (const e of r.exports || []) {
      const row = ex.addRow({
        n: en++, module: r.name, group: r.group, tab: e.tab || '(main)',
        format: e.format, result: e.ok ? 'OK' : 'FAILED', status: e.status,
        endpoint: e.endpoint || e.error || '',
      });
      const rc = row.getCell('result');
      rc.font = { bold: true, color: { argb: e.ok ? COLORS.PASS : COLORS.FAIL } };
      if (!e.ok) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.failRow } }; });
    }
  }
  if (en === 1) ex.addRow({ module: 'No export controls found / tested', format: '-', result: '-' });
  ex.autoFilter = 'A1:H1';

  // ---- Sheet 4: All Modules ----
  const all = wb.addWorksheet('All Modules', { views: [{ state: 'frozen', ySplit: 1 }] });
  all.columns = [
    { header: '#', key: 'n', width: 5 },
    { header: 'Heading', key: 'group', width: 24 },
    { header: 'Sub-Heading', key: 'subGroup', width: 22 },
    { header: 'Screen', key: 'name', width: 34 },
    { header: 'Verdict', key: 'verdict', width: 9 },
    { header: 'HTTP', key: 'http', width: 8 },
    { header: 'API Calls', key: 'apis', width: 10 },
    { header: 'Failed', key: 'failed', width: 8 },
    { header: 'Exports', key: 'exports', width: 10 },
    { header: 'Detail', key: 'reason', width: 60 },
  ];
  styleHeader(all.getRow(1));
  results.forEach((r, i) => {
    const es = r.exportsSummary;
    const row = all.addRow({
      n: i + 1, group: r.group, subGroup: r.subGroup || '', name: r.name, verdict: r.verdict,
      http: r.httpStatus, apis: r.apiCount || 0, failed: (r.failedApis || []).length,
      exports: es ? `${es.ok}/${es.total}${es.failed ? ` (${es.failed} fail)` : ''}` : '-',
      reason: r.reason,
    });
    const vc = row.getCell('verdict');
    vc.font = { bold: true, color: { argb: COLORS[r.verdict] || 'FF000000' } };
    if (r.verdict === 'FAIL') row.getCell('failed').font = { bold: true, color: { argb: COLORS.FAIL } };
  });
  all.autoFilter = 'A1:J1';

  // ---- Sheet 5: Recurring API Failures (history, same role) ----
  if (history) {
    const rf = wb.addWorksheet('Recurring Failures', { views: [{ state: 'frozen', ySplit: 1 }] });
    rf.columns = [
      { header: '#', key: 'n', width: 5 },
      { header: 'Endpoint', key: 'endpoint', width: 70 },
      { header: 'Method', key: 'method', width: 8 },
      { header: 'Fails', key: 'count', width: 8 },
      { header: 'Statuses', key: 'statuses', width: 16 },
      { header: 'First Seen', key: 'firstSeen', width: 18 },
      { header: 'Last Seen', key: 'lastSeen', width: 18 },
      { header: 'Weekday Pattern', key: 'weekdayPattern', width: 26 },
      { header: 'Time Pattern', key: 'timePattern', width: 22 },
      { header: 'Screens', key: 'screens', width: 40 },
    ];
    styleHeader(rf.getRow(1));
    (history.recurringFailures || []).forEach((g, i) => {
      const row = rf.addRow({ n: i + 1, ...g });
      row.getCell('count').font = { bold: true, color: { argb: COLORS.FAIL } };
    });
    if (!(history.recurringFailures || []).length) rf.addRow({ endpoint: `No recurring failures for ${history.role} (${history.totalRecords} calls logged)` });
    rf.autoFilter = 'A1:J1';

    // ---- Sheet 6: Full API History (raw, same role) ----
    const h = wb.addWorksheet('API History', { views: [{ state: 'frozen', ySplit: 1 }] });
    h.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Time', key: 'time', width: 8 },
      { header: 'Weekday', key: 'weekday', width: 11 },
      { header: 'ISO (UTC)', key: 'iso', width: 24 },
      { header: 'Run', key: 'runId', width: 30 },
      { header: 'Heading', key: 'group', width: 20 },
      { header: 'Sub-Heading', key: 'subGroup', width: 18 },
      { header: 'Screen', key: 'screen', width: 28 },
      { header: 'Method', key: 'method', width: 8 },
      { header: 'Endpoint', key: 'endpoint', width: 80 },
      { header: 'Status', key: 'status', width: 8 },
      { header: 'Result', key: 'result', width: 9 },
      { header: 'Kind', key: 'kind', width: 16 },
      { header: 'Error', key: 'error', width: 40 },
    ];
    styleHeader(h.getRow(1));
    for (const r of history.raw || []) {
      const row = h.addRow(r);
      if (r.result === 'failure') {
        row.getCell('result').font = { bold: true, color: { argb: COLORS.FAIL } };
        row.getCell('status').font = { bold: true, color: { argb: COLORS.FAIL } };
      }
    }
    h.autoFilter = 'A1:N1';
  }

  return wb.xlsx.writeBuffer();
}
