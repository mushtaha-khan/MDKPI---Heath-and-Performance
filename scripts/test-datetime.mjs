/**
 * Date and time display, plus the soft-delete round trip.
 *
 * The formatting cases here are the ones that go wrong in practice: midnight and midday on a
 * 12-hour clock, single-digit days and months needing a leading zero, and a run stamp being
 * read as UTC and shifted by the machine's offset.
 *
 * Usage: npx tsx scripts/test-datetime.mjs
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  formatDate,
  formatTime,
  formatDateTime,
  formatDateTimeForFile,
  formatIso,
  formatDatesInText,
  parseRunStamp,
  formatRunStamp,
} from '../src/core/datetime.ts';
import { listRuns, softDeleteRun, restoreRun, resolveRunDir } from '../src/core/runs.ts';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(56)} got ${JSON.stringify(actual)}${ok ? '' : `  expected ${JSON.stringify(expected)}`}`,
  );
  ok ? pass++ : fail++;
}

console.log('=== dates are DD-MM-YYYY ===');
check('a two-digit day and month', formatDate(new Date(2026, 8, 27, 13, 5)), '27-09-2026');
check('single digits get a leading zero', formatDate(new Date(2026, 0, 7, 13, 5)), '07-01-2026');

console.log('\n=== times are 12-hour, no seconds ===');
check('afternoon', formatTime(new Date(2026, 8, 7, 19, 11, 46)), '7:11 PM');
check('morning', formatTime(new Date(2026, 8, 7, 9, 5, 3)), '9:05 AM');
check('midnight is 12 AM, not 0 AM', formatTime(new Date(2026, 8, 7, 0, 30)), '12:30 AM');
check('midday is 12 PM, not 0 PM', formatTime(new Date(2026, 8, 7, 12, 0)), '12:00 PM');
check('one minute to midnight', formatTime(new Date(2026, 8, 7, 23, 59, 59)), '11:59 PM');
check('seconds are dropped, not rounded up', formatTime(new Date(2026, 8, 7, 14, 30, 59)), '2:30 PM');

console.log('\n=== combined and filename-safe forms ===');
check('combined', formatDateTime(new Date(2026, 8, 7, 19, 11)), '07-09-2026 7:11 PM');
check('filename form has no colon', formatDateTimeForFile(new Date(2026, 8, 7, 19, 11)), '07-09-2026 7.11 PM');
check(
  'filename form contains no character Windows forbids',
  /[\\/:*?"<>|]/.test(formatDateTimeForFile(new Date(2026, 8, 7, 19, 11))),
  false,
);

console.log('\n=== run stamps ===');
// Parsed field by field in local time. Handing "2026-09-07T19:11:46" to new Date() would be
// read as UTC and shift the displayed time by the machine's offset.
const parsed = parseRunStamp('2026-09-07_19-11-46__open-ro');
check('stamp parses to local time', [parsed?.getHours(), parsed?.getMinutes()], [19, 11]);
check('stamp formats for display', formatRunStamp('2026-09-07_19-11-46__open-ro'), '07-09-2026 7:11 PM');
check('an unparseable id is returned as-is', formatRunStamp('not-a-stamp'), 'not-a-stamp');

console.log('\n=== ISO timestamps and embedded dates ===');
check('an ISO instant formats', formatIso(new Date(2026, 8, 7, 8, 4).toISOString()), '07-09-2026 8:04 AM');
check('null becomes a dash', formatIso(null), '—');
check('a non-timestamp is left alone', formatIso('encrypted'), 'encrypted');
check(
  'a date range is rewritten in place',
  formatDatesInText('2026-09-01 to 2026-09-30'),
  '01-09-2026 to 30-09-2026',
);
check('surrounding wording survives', formatDatesInText('from 2026-9-1 onwards'), 'from 01-09-2026 onwards');

console.log('\n=== soft delete round trip ===');
const root = await mkdtemp(path.join(tmpdir(), 'kpi-runs-'));
const runId = '2026-09-07_19-11-46__open-ro';
const dir = path.join(root, runId);
await mkdir(dir, { recursive: true });
await writeFile(
  path.join(dir, 'meta.json'),
  JSON.stringify({
    runId,
    moduleName: 'Open RO',
    reportFile: 'Open RO - AutoGroup vs DMS - 07-09-2026 7.11 PM.html',
    source: 'gui',
    summary: { totalCells: 18, matched: 18, mismatched: 0, missing: 0, gridsCompared: 1 },
  }),
  'utf8',
);
await writeFile(path.join(dir, 'Open RO - AutoGroup vs DMS - 07-09-2026 7.11 PM.html'), '<html></html>', 'utf8');

check('the run is listed while active', (await listRuns(root)).map((r) => r.runId), [runId]);
check('and reports no deletion', (await listRuns(root))[0]?.deletedAt, null);

const record = await softDeleteRun(root, runId, 'test');
check('deleting returns a timestamp', typeof record?.deletedAt, 'string');
check('the run disappears from the active list', (await listRuns(root)).length, 0);
check('but is listed as deleted', (await listRuns(root, { deleted: 'deleted' })).map((r) => r.runId), [runId]);
check('with its deletion time', typeof (await listRuns(root, { deleted: 'deleted' }))[0]?.deletedAt, 'string');
check('and appears under "all"', (await listRuns(root, { deleted: 'all' })).length, 1);

// The whole point of a soft delete: the artefacts are still there.
const { existsSync } = await import('node:fs');
check('the report file is still on disk', existsSync(path.join(dir, 'Open RO - AutoGroup vs DMS - 07-09-2026 7.11 PM.html')), true);
check('the metadata is still on disk', existsSync(path.join(dir, 'meta.json')), true);

check('restoring succeeds', await restoreRun(root, runId), true);
check('the run is listed again', (await listRuns(root)).map((r) => r.runId), [runId]);
check('and nothing remains in the deleted list', (await listRuns(root, { deleted: 'deleted' })).length, 0);

console.log('\n=== path traversal is refused ===');
// The run id arrives from an HTTP request, so these must be rejected rather than sanitised.
for (const bad of ['../..', '../other', '/etc/passwd', 'a/b', 'a\\b', '', '.', '..', 'run\0id']) {
  check(`refuses ${JSON.stringify(bad)}`, resolveRunDir(root, bad), null);
}
check('accepts a real run id', resolveRunDir(root, runId) !== null, true);
check('refuses a well-formed id that does not exist', resolveRunDir(root, '2026-01-01_00-00-00__nope'), null);
check('deleting an unknown run reports failure', await softDeleteRun(root, '../escape'), null);

await rm(root, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
