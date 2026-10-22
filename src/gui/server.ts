/**
 * Control server for the GUI.
 *
 * Serves the single-page control panel, exposes a small JSON API to launch and list
 * runs, streams live progress over Server-Sent Events, and serves the generated
 * reports from artifacts/runs.
 *
 * Bound to the loopback interface only and unauthenticated by design — the reports
 * contain dealership financial figures, and this endpoint can start browser
 * automation against the portal, so it must not be exposed beyond this machine.
 * Do not change HOST without adding authentication.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { listRuns, resolveRunDir, restoreRun, softDeleteRun, type RunSummary } from '../core/runs.js';
import { listModules } from '../core/modules.js';
import { formatIso, formatRunStamp } from '../core/datetime.js';
import { renderGuiPage } from './page.js';

const HOST = '127.0.0.1';
const RUNS_ROOT = path.resolve('artifacts', 'runs');
const MODULES_ROOT = path.resolve('modules');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Run state — one run at a time, since both runs drive a browser and the portal
// data shifts underneath concurrent captures.
// ---------------------------------------------------------------------------

interface RunState {
  child: ChildProcess;
  /** Reported by the runner via a ##RUN_ID marker, not inferred. */
  runId: string | null;
  reportFile: string | null;
  startedAt: number;
  log: string;
  stage: number;
  clients: Set<ServerResponse>;
  cancelled: boolean;
}

let active: RunState | null = null;

function broadcast(event: string, data: unknown): void {
  if (!active) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of active.clients) {
    try {
      res.write(payload);
    } catch {
      active.clients.delete(res);
    }
  }
}

function closeClients(): void {
  if (!active) return;
  for (const res of active.clients) {
    try {
      res.end();
    } catch {
      /* already gone */
    }
  }
  active.clients.clear();
}

/** Strip ANSI colour codes so the log reads cleanly in the browser. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

interface RunRequest {
  autogroup?: string;
  dms?: string;
  module?: string;
  autogroupRole?: string;
  dmsRole?: string;
  formulas?: boolean;
  reuse?: boolean;
  /**
   * Reuse the captures from a specific earlier run rather than the newest available.
   *
   * Without this, "reuse captures" means "whichever run captured most recently", which makes
   * any automated check dependent on what else happens to be on disk — a verification run
   * silently picked up an unrelated module's captures and reported a failure that had nothing
   * to do with the code under test.
   */
  reuseFrom?: string;
}

function validUrl(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Most recent run directory holding reusable captures, for the "reuse captures" option.
 *
 * Scans directories directly rather than going through listRuns: a run that captured
 * both screens but failed before writing a report is still a perfectly good source of
 * captures, and listRuns deliberately only returns runs that produced a report.
 */
async function latestRunFor(moduleHint: string): Promise<string | null> {
  const slug = moduleHint.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const entries = await readdir(RUNS_ROOT, { withFileTypes: true }).catch(() => []);

  const candidates = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter(
      (name) =>
        existsSync(path.join(RUNS_ROOT, name, 'autogroup', 'capture.json')) &&
        existsSync(path.join(RUNS_ROOT, name, 'dms', 'capture.json')) &&
        // A deleted run's captures stay on disk, but reusing them would quietly resurrect
        // data the operator has removed from the history.
        !existsSync(path.join(RUNS_ROOT, name, '.deleted')),
    )
    .sort()
    .reverse();

  // Prefer a run for the same module; fall back to the newest captures available.
  const preferred = slug ? candidates.find((n) => n.toLowerCase().includes(slug)) : undefined;
  const chosen = preferred ?? candidates[0];
  return chosen ? path.join(RUNS_ROOT, chosen) : null;
}

async function startRun(body: RunRequest): Promise<{ runId?: string; error?: string }> {
  if (active) return { error: 'A run is already in progress.' };
  if (!validUrl(body.autogroup)) return { error: 'AutoGroup URL is missing or invalid.' };
  if (!validUrl(body.dms)) return { error: 'DMS URL is missing or invalid.' };

  const argv = [
    'src/cli/suite.ts',
    '--autogroup', body.autogroup!,
    '--dms', body.dms!,
    '--no-serve', // the GUI serves the reports itself
  ];
  if (body.module) argv.push('--module', body.module);
  if (body.autogroupRole) argv.push('--autogroup-role', body.autogroupRole);
  if (body.dmsRole) argv.push('--dms-role', body.dmsRole);
  if (body.formulas === false) argv.push('--no-formulas');
  // Marks the run as a report. Command-line runs are tagged 'cli' and stay out of the list.
  argv.push('--source', 'gui');

  if (body.reuse || body.reuseFrom) {
    let from: string | null;
    if (body.reuseFrom) {
      from = resolveRunDir(RUNS_ROOT, body.reuseFrom);
      if (!from) return { error: `No such run to reuse captures from: ${body.reuseFrom}` };
      if (
        !existsSync(path.join(from, 'autogroup', 'capture.json')) ||
        !existsSync(path.join(from, 'dms', 'capture.json'))
      ) {
        return { error: `Run ${body.reuseFrom} has no captures to reuse.` };
      }
    } else {
      from = await latestRunFor(body.module ?? '');
      if (!from) return { error: 'No previous captures found to reuse. Uncheck that option.' };
    }
    argv.push('--from', from);
  }

  // Spawn node directly with the tsx loader — never through a shell.
  //
  // `shell: true` concatenates argv into a command string without escaping, which
  // both corrupts arguments containing spaces (a module name like "Service Summary"
  // arrived as just "Service") and lets a crafted form value inject shell commands.
  // Passing an argv array to node with no shell removes both problems.
  const child = spawn(process.execPath, ['--import', 'tsx', ...argv], {
    env: { ...process.env, FORCE_COLOR: '0' },
    windowsHide: true,
  });

  active = {
    child,
    runId: null,
    reportFile: null,
    startedAt: Date.now(),
    log: '',
    stage: 0,
    clients: new Set(),
    cancelled: false,
  };

  const onChunk = (buf: Buffer) => {
    const text = clean(buf.toString());
    if (!active) return;
    active.log += text;
    // Cap retained log so a long run cannot grow memory without bound.
    if (active.log.length > 400_000) active.log = active.log.slice(-300_000);

    const stageMatch = /\[(\d+)\/(\d+)\]/.exec(text);
    if (stageMatch) active.stage = Number(stageMatch[1]) - 1;

    // The runner announces exactly where it wrote the report.
    const idMatch = /##RUN_ID=(.+)/.exec(text);
    if (idMatch) active.runId = idMatch[1]!.trim();
    const fileMatch = /##REPORT_FILE=(.+)/.exec(text);
    if (fileMatch) active.reportFile = fileMatch[1]!.trim();

    // Keep the markers out of the log shown to the user.
    broadcast('log', { text: text.replace(/^##(RUN_ID|RUN_DIR|REPORT_FILE)=.*$/gm, '').replace(/\n{3,}/g, '\n\n') });
  };

  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);

  child.on('close', async (code) => {
    if (!active) return;
    const cancelled = active.cancelled;

    // Use the run id the runner reported. Only fall back to "newest on disk" if the
    // marker never arrived, and even then require that it actually has metadata.
    let meta: Record<string, unknown> | null = null;
    let url: string | null = null;
    try {
      let runId = active.runId;
      let reportFile = active.reportFile;

      if (!runId) {
        const runs = await listRuns(RUNS_ROOT);
        const newest = runs.find((r) => r.reportFile);
        runId = newest?.runId ?? null;
        reportFile = newest?.reportFile ?? null;
      }

      if (runId) {
        const metaPath = path.join(RUNS_ROOT, runId, 'meta.json');
        if (existsSync(metaPath)) meta = JSON.parse(await readFile(metaPath, 'utf8'));
        if (!reportFile && meta) reportFile = String((meta as { reportFile?: string }).reportFile ?? '');
        if (reportFile) {
          url = `/runs/${encodeURIComponent(runId)}/${encodeURIComponent(reportFile)}`;
        }
      }
    } catch {
      /* leave meta null; the log still explains what happened */
    }

    // The suite exits non-zero when it finds differences, which is a result rather
    // than a failure. Treat "report produced" as success.
    const ok = !cancelled && meta !== null;
    if (ok) {
      broadcast('done', { ok: true, meta, url });
    } else {
      broadcast('done', {
        ok: false,
        error: cancelled
          ? 'Run stopped.'
          : `The run did not produce a report (exit code ${code}). See the log above.`,
        failedStage: active.stage,
      });
    }
    closeClients();
    active = null;
  });

  child.on('error', (err) => {
    broadcast('fatal', { error: err.message });
    closeClients();
    active = null;
  });

  return { runId: String(child.pid ?? 'run') };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req: IncomingMessage, limit = 100_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function humanWhen(runId: string): string {
  return formatRunStamp(runId);
}

function decorate(runs: RunSummary[]) {
  return runs.map((r) => ({
    ...r,
    when: humanWhen(r.runId),
    deletedWhen: r.deletedAt ? formatIso(r.deletedAt) : null,
    url: `/runs/${encodeURIComponent(r.runId)}/${encodeURIComponent(r.reportFile)}`,
  }));
}

async function serveStatic(res: ServerResponse, relPath: string): Promise<void> {
  const target = path.resolve(RUNS_ROOT, `.${relPath}`);
  // Refuse anything resolving outside the runs directory.
  if (target !== RUNS_ROOT && !target.startsWith(RUNS_ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let file = target;
  const info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    // Directory: prefer index.html, else the single report inside it.
    const idx = path.join(file, 'index.html');
    if (existsSync(idx)) file = idx;
    else {
      const names = await readdir(file).catch(() => []);
      const html = names.filter((n) => n.toLowerCase().endsWith('.html'));
      if (!html.length) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('No report in that run directory');
        return;
      }
      file = path.join(file, html.find((n) => n !== 'index.html') ?? html[0]!);
    }
  }

  const fInfo = await stat(file).catch(() => null);
  if (!fInfo?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${relPath}`);
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': fInfo.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

export function startGui(port: number): Promise<{ port: number; url: string }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
      const p = url.pathname;

      if (p === '/' || p === '/index.html') {
        const page = renderGuiPage();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(page),
          'Cache-Control': 'no-store',
        });
        res.end(page);
        return;
      }

      // Saved modules, one JSON file each under modules/. Read fresh on every request so
      // a module added or edited on disk appears on a page refresh, with no restart.
      if (p === '/api/modules') {
        json(res, 200, await listModules(MODULES_ROOT));
        return;
      }

      if (p === '/api/runs') {
        // Reports are GUI runs only. `?includeCli=1` also returns command-line runs,
        // which is used for diagnostics rather than by the panel itself.
        // `?deleted=deleted|all` reaches the soft-deleted set so a report can be restored.
        const includeCli = url.searchParams.get('includeCli') === '1';
        const requested = url.searchParams.get('deleted');
        const deleted =
          requested === 'deleted' || requested === 'all' ? requested : ('active' as const);
        json(res, 200, decorate(await listRuns(RUNS_ROOT, { includeCli, deleted })));
        return;
      }

      // Soft delete and restore. Nothing is removed from disk: a run holds captures,
      // screenshots and harvested formulas for a moment in the portal's data that cannot be
      // reproduced, so hiding is the most a delete button should ever do.
      if ((p === '/api/runs/delete' || p === '/api/runs/restore') && req.method === 'POST') {
        let body: { runId?: string };
        try {
          body = JSON.parse(await readBody(req)) as { runId?: string };
        } catch (e) {
          json(res, 400, { error: `Invalid request: ${(e as Error).message}` });
          return;
        }
        const runId = String(body.runId ?? '');
        if (!runId) {
          json(res, 400, { error: 'runId is required.' });
          return;
        }

        if (p === '/api/runs/delete') {
          const record = await softDeleteRun(RUNS_ROOT, runId, 'gui');
          if (!record) {
            json(res, 404, { error: `No such run: ${runId}` });
            return;
          }
          json(res, 200, { runId, deletedAt: record.deletedAt, deletedWhen: formatIso(record.deletedAt) });
          return;
        }

        const ok = await restoreRun(RUNS_ROOT, runId);
        json(res, ok ? 200 : 404, ok ? { runId, restored: true } : { error: `No such run: ${runId}` });
        return;
      }

      if (p === '/api/status') {
        json(res, 200, {
          running: Boolean(active),
          elapsedMs: active ? Date.now() - active.startedAt : 0,
          stage: active?.stage ?? 0,
          log: active?.log ?? '',
        });
        return;
      }

      if (p === '/api/run' && req.method === 'POST') {
        let body: RunRequest;
        try {
          body = JSON.parse(await readBody(req)) as RunRequest;
        } catch (e) {
          json(res, 400, { error: `Invalid request: ${(e as Error).message}` });
          return;
        }
        const result = await startRun(body);
        json(res, result.error ? 409 : 200, result);
        return;
      }

      if (p === '/api/cancel' && req.method === 'POST') {
        if (active) {
          active.cancelled = true;
          active.child.kill();
          json(res, 200, { stopped: true });
        } else {
          json(res, 200, { stopped: false });
        }
        return;
      }

      if (p === '/api/stream') {
        if (!active) {
          json(res, 409, { error: 'No run in progress.' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        // Replay what has happened so far so a late subscriber sees the whole run.
        res.write(`event: log\ndata: ${JSON.stringify({ text: active.log })}\n\n`);
        active.clients.add(res);
        req.on('close', () => active?.clients.delete(res));
        return;
      }

      if (p.startsWith('/runs/')) {
        await serveStatic(res, decodeURIComponent(p.slice('/runs'.length)) || '/');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Server error: ${(err as Error).message}`);
    }
  });

  return new Promise((resolve, reject) => {
    let tries = 0;
    let current = port;
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && tries < 12) {
        tries++;
        current = port + tries;
        server.listen(current, HOST);
        return;
      }
      reject(err);
    };
    server.on('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      server.on('error', (e) => console.error(`Server error: ${e.message}`));
      if (current !== port) console.log(`(port ${port} was busy; using ${current})`);
      resolve({ port: current, url: `http://localhost:${current}/` });
    });
    server.listen(current, HOST);
  });
}
