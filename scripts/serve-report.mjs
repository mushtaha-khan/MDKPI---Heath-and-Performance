/**
 * Minimal static server for the generated report.
 *
 * Bound to the loopback interface only (127.0.0.1) so it is not reachable from the
 * network. There is no authentication, which is acceptable only because of that
 * binding — do not change the host to 0.0.0.0 without adding auth, since the report
 * contains dealership financial figures.
 *
 * Serves artifacts/reports read-only. No directory listing outside that root.
 *
 * Usage: npm run serve [port]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.argv[2] ?? 8080);
const HOST = '127.0.0.1';
const ROOT = path.resolve('artifacts/reports');
const DEFAULT_FILE = 'reconciliation.html';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = `/${DEFAULT_FILE}`;

    // Resolve inside ROOT and reject anything that escapes it.
    const target = path.resolve(ROOT, `.${rel}`);
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${rel}`);
      return;
    }

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(target).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Server error: ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  http://localhost:${PORT}/${DEFAULT_FILE}`);
  console.log('');
  console.log('Loopback only — not reachable from other machines. Ctrl+C to stop.');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. Try:  npm run serve -- ${PORT + 1}`);
    process.exit(1);
  }
  throw err;
});
