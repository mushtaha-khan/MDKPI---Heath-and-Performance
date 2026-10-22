/**
 * Shared shapes for the WAF regression runner (MDKPI-7508).
 *
 * A "result row" is one executed check. The report columns the user asked for map
 * directly onto it: TestCase (id + title), Domain, URL, Result, StatusCode, Screenshot.
 * A single WAF case can produce several rows (e.g. WAF-03 visits many routes), so the
 * report groups rows under their case.
 */

/** Verdicts a row can carry. */
export const Verdict = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED', // expected block (WAF-38/39): a 403 here is the pass condition
  INFO: 'INFO', // recorded evidence with no pass/fail (e.g. load-time capture)
  MANUAL: 'MANUAL', // handoff: cannot be produced from this machine
});

/**
 * @typedef {Object} ResultRow
 * @property {string} caseId        e.g. "WAF-03"
 * @property {string} caseTitle
 * @property {string} group
 * @property {string} role          "AUTOGROUP" | "DEALER" | "-"
 * @property {string} domain        tenant host, e.g. "am-gyh.mydealerkpi.com"
 * @property {string} url           the URL exercised (or "-" for manual rows)
 * @property {string} verdict       one of Verdict
 * @property {string} result        human-readable outcome
 * @property {number|string} statusCode  main document status, or "-" / list
 * @property {string|null} screenshot    path relative to the run dir, or null
 * @property {string[]} [forbidden]      any 403 URLs captured on this row
 * @property {string[]} [consoleErrors]  relevant console errors (e.g. chunk load)
 * @property {number} [loadMs]           navigation time in ms, when measured
 */

/** Make an empty row with sensible defaults. */
export function row(partial) {
  return {
    caseId: '',
    caseTitle: '',
    group: '',
    role: '-',
    domain: '',
    url: '-',
    verdict: Verdict.INFO,
    result: '',
    statusCode: '-',
    screenshot: null,
    forbidden: [],
    consoleErrors: [],
    ...partial,
  };
}
