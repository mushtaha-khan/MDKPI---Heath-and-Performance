/**
 * Minimal read-only static server for generated reports.
 *
 * Bound to the loopback interface only. There is no authentication, which is
 * acceptable solely because of that binding — these reports contain dealership
 * financial figures, so do not change the host to 0.0.0.0 without adding auth.
 */
import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const HOST = '127.0.0.1';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
};

export interface ServerInfo {
  server: Server;
  port: number;
  url: string;
  root: string;
}

/**
 * Start the server, trying the next port if the requested one is taken so a run is
 * never blocked by a leftover process.
 */
export function startServer(root: string, port: number, attempts = 12): Promise<ServerInfo> {
  const absRoot = path.resolve(root);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      if (rel === '/index.html' && !rel.startsWith('//')) {
        // keep as-is; resolved below
      }

      const target = path.resolve(absRoot, `.${rel}`);
      // Reject anything resolving outside the served root.
      if (target !== absRoot && !target.startsWith(absRoot + path.sep)) {
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
      res.end(`Server error: ${(err as Error).message}`);
    }
  });

  return new Promise((resolve, reject) => {
    let tries = 0;
    let current = port;

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && tries < attempts) {
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
      resolve({
        server,
        port: current,
        url: `http://localhost:${current}/`,
        root: absRoot,
      });
    });

    server.listen(current, HOST);
  });
}
