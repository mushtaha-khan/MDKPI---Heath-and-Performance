/**
 * Start a run through the GUI's own API and stream it to the console.
 *
 * This is the same endpoint the control panel posts to, so the run is tagged as a GUI
 * run and appears in the report history — unlike invoking the CLI directly, which is
 * tagged 'cli' and deliberately kept out of the list.
 *
 * Reads the live log over Server-Sent Events rather than polling /api/status. Polling
 * loses the end of the log: the server discards the run state the moment the child
 * process closes, so the last interval's output is gone before the next poll asks for
 * it. The SSE stream replays the whole log on connect and then pushes every chunk, so
 * nothing is missed.
 *
 * Usage: node scripts/gui-run.mjs <port> <autogroupUrl> <dmsUrl> [moduleName] [--reuse] [--no-formulas]
 */
const [port, autogroup, dms, ...rest] = process.argv.slice(2);

if (!port || !autogroup || !dms) {
  console.error('Usage: node scripts/gui-run.mjs <port> <autogroupUrl> <dmsUrl> [moduleName] [--reuse] [--no-formulas]');
  process.exit(2);
}

const flags = rest.filter((a) => a.startsWith('--'));
const moduleName = rest.find((a) => !a.startsWith('--'));
const base = `http://127.0.0.1:${port}`;

const body = {
  autogroup,
  dms,
  formulas: !flags.includes('--no-formulas'),
  reuse: flags.includes('--reuse'),
};
if (moduleName) body.module = moduleName;

const started = await fetch(`${base}/api/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

if (started.error) {
  console.error(`Refused: ${started.error}`);
  process.exit(1);
}
console.log(`Run started (pid ${started.runId}). Streaming...\n`);

const stream = await fetch(`${base}/api/stream`);
if (!stream.ok || !stream.body) {
  console.error(`Could not attach to the log stream (HTTP ${stream.status}).`);
  process.exit(1);
}

let outcome = null;
let buffer = '';
const decoder = new TextDecoder();

for await (const chunk of stream.body) {
  buffer += decoder.decode(chunk, { stream: true });

  // SSE frames are separated by a blank line.
  let cut;
  while ((cut = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 2);

    let event = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (!dataLines.length) continue;

    let payload;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      continue;
    }

    if (event === 'log') process.stdout.write(payload.text ?? '');
    else if (event === 'done' || event === 'fatal') outcome = { event, payload };
  }
}

console.log('\n--- newest GUI run ---');

if (outcome?.event === 'fatal' || outcome?.payload?.ok === false) {
  console.error(`Run failed: ${outcome.payload.error ?? 'unknown error'}`);
  process.exit(1);
}

const runs = await fetch(`${base}/api/runs`).then((r) => r.json());
const newest = runs[0];
if (!newest) {
  console.error('No GUI run recorded. The run did not produce a report.');
  process.exit(1);
}

const c = newest.cells ?? {};
console.log(`module   : ${newest.moduleName}`);
console.log(`when     : ${newest.when}`);
console.log(`status   : ${newest.status}`);
console.log(`cells    : ${c.matched}/${c.total} matched, ${c.mismatched} different, ${c.missing} missing`);
console.log(`groups   : ${(newest.groups ?? []).join(', ')}`);
console.log(
  `formulas : rows ${newest.rowFormulas ? `${newest.rowFormulas.passed}/${newest.rowFormulas.total}` : 'none documented'}` +
    `, columns ${newest.columnChecks ? `${newest.columnChecks.passed}/${newest.columnChecks.total}` : 'none derivable'}`,
);
console.log(`shots    : ${newest.screenshots}`);
console.log(`report   : ${base}${newest.url}`);
