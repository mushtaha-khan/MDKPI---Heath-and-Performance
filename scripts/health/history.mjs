/**
 * Read the persistent API history (artifacts/health/api-log.jsonl) and derive views used
 * by the per-crawl report: the full raw rows for a role, and a "recurring API failures"
 * summary grouped by endpoint.
 *
 * This is history across ALL past runs for the given role — deliberately separate from the
 * current crawl's own results, so a report shows "this run" plus "this role over time".
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const LOG_FILE = path.resolve('artifacts', 'health', 'api-log.jsonl');

/** Strip the query string so the same endpoint with different filters groups together. */
function normalizeEndpoint(url) {
  if (!url) return '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Parse the whole log once into an array of records (best-effort, skips bad lines). */
async function readLog() {
  let text = '';
  try { text = await readFile(LOG_FILE, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return rows;
}

/**
 * Build the history views for one role.
 * @returns {Promise<{role, totalRecords, raw, recurringFailures, generatedFrom}>}
 */
export async function historyForRole(role) {
  const all = await readLog();
  const raw = all.filter((r) => String(r.role).toUpperCase() === String(role).toUpperCase());

  // Group FAILURES by normalized endpoint to surface recurring problems.
  const byEndpoint = new Map();
  for (const r of raw) {
    if (r.result !== 'failure') continue;
    const key = normalizeEndpoint(r.endpoint) || r.endpoint || '(unknown)';
    let g = byEndpoint.get(key);
    if (!g) {
      g = {
        endpoint: key, method: r.method || '', count: 0,
        statuses: new Map(), weekdays: new Map(), hours: new Map(),
        firstIso: r.iso, lastIso: r.iso, firstSeen: `${r.date} ${r.time}`, lastSeen: `${r.date} ${r.time}`,
        screens: new Set(),
      };
      byEndpoint.set(key, g);
    }
    g.count++;
    g.statuses.set(r.status, (g.statuses.get(r.status) || 0) + 1);
    if (r.weekday) g.weekdays.set(r.weekday, (g.weekdays.get(r.weekday) || 0) + 1);
    if (r.time) { const hr = String(r.time).slice(0, 2) + ':00'; g.hours.set(hr, (g.hours.get(hr) || 0) + 1); }
    if (r.screen) g.screens.add(r.screen);
    if (r.iso && r.iso < g.firstIso) { g.firstIso = r.iso; g.firstSeen = `${r.date} ${r.time}`; }
    if (r.iso && r.iso > g.lastIso) { g.lastIso = r.iso; g.lastSeen = `${r.date} ${r.time}`; }
  }

  const topN = (m, n = 3) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${k}×${v}`).join(', ');

  const recurringFailures = [...byEndpoint.values()]
    .sort((a, b) => b.count - a.count)
    .map((g) => ({
      endpoint: g.endpoint,
      method: g.method,
      count: g.count,
      statuses: topN(g.statuses),
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      weekdayPattern: topN(g.weekdays),
      timePattern: topN(g.hours),
      screens: [...g.screens].slice(0, 5).join(', '),
    }));

  return { role, totalRecords: raw.length, raw, recurringFailures, generatedFrom: 'api-log.jsonl' };
}
