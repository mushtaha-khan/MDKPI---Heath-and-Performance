/**
 * Persistent, append-only API history log (JSONL — one JSON object per line).
 *
 * Every API call from every crawl is appended here so it can be analysed over days/weeks:
 * "which endpoints fail, on which days, at what times". JSONL is used deliberately — it
 * appends without rewriting the file, survives crashes mid-run, and is trivial to filter
 * with jq / pandas / Excel's Power Query.
 *
 * File: artifacts/health/api-log.jsonl   (never truncated; grows over time)
 *
 * Each record:
 *   runId, role, group, subGroup, screen   — which crawl + which module the call belonged to
 *   endpoint, method                        — the API
 *   status                                  — HTTP status (number) or 'ERR'/'ABORTED'
 *   result                                  — 'success' | 'failure'
 *   kind                                    — 'api' | 'export'
 *   error                                   — error text when available
 *   iso                                     — exact UTC timestamp (sortable)
 *   date, time, weekday                     — local DD/MM/YYYY, HH:MM (24h), day name
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const LOG_DIR = path.resolve('artifacts', 'health');
const LOG_FILE = path.join(LOG_DIR, 'api-log.jsonl');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function localParts(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return {
    date: `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`,
    time: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
    weekday: WEEKDAYS[d.getDay()],
  };
}

/**
 * Append all API calls (and export API calls) from one finished module to the history log.
 * Best-effort: logging must never break a crawl.
 *
 * @param {object} ctx  { runId, role, group, subGroup, screen }
 * @param {object[]} apis        the module's captured APIs ({status,method,url,iso,ts})
 * @param {object[]} failedApis  the module's failed APIs ({status,method,url,kind})
 * @param {object[]} exports     the module's export tests ({format,tab,ok,status,endpoint,error})
 */
export async function appendApiLog(ctx, apis = [], failedApis = [], exports = []) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const failedSet = new Set((failedApis || []).map((f) => `${f.method || ''} ${f.url}`));
    const lines = [];

    for (const a of apis || []) {
      const d = a.iso ? new Date(a.iso) : new Date(a.ts || Date.now());
      const lp = localParts(d);
      const failed = (typeof a.status === 'number' && a.status >= 400) || failedSet.has(`${a.method || ''} ${a.url}`);
      lines.push(JSON.stringify({
        runId: ctx.runId, role: ctx.role, group: ctx.group, subGroup: ctx.subGroup || '', screen: ctx.screen,
        endpoint: a.url, method: a.method || 'GET', status: a.status,
        result: failed ? 'failure' : 'success', kind: 'api', error: '',
        iso: d.toISOString(), date: lp.date, time: lp.time, weekday: lp.weekday,
      }));
    }

    // Export API outcomes (PDF/Excel buttons), including failures with no captured XHR.
    for (const e of exports || []) {
      const d = new Date();
      const lp = localParts(d);
      lines.push(JSON.stringify({
        runId: ctx.runId, role: ctx.role, group: ctx.group, subGroup: ctx.subGroup || '', screen: ctx.screen,
        endpoint: e.endpoint || '', method: e.method || '-', status: e.status,
        result: e.ok ? 'success' : 'failure', kind: `export:${e.format}${e.tab ? `:${e.tab}` : ''}`,
        error: e.ok ? '' : (e.error || `HTTP ${e.status}`),
        iso: d.toISOString(), date: lp.date, time: lp.time, weekday: lp.weekday,
      }));
    }

    if (lines.length) await appendFile(LOG_FILE, lines.join('\n') + '\n', 'utf8');
  } catch {
    /* logging is best-effort; never throw into the crawl */
  }
}

export const API_LOG_FILE = LOG_FILE;
