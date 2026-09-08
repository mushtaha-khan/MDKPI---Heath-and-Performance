/**
 * Serve previously generated suite runs.
 *
 * Usage: npm run runs -- [port]
 */
import path from 'node:path';
import { startServer } from '../core/server.js';

const port = Number(process.argv[2] ?? 8080);
const root = process.argv[3] ?? path.join('artifacts', 'runs');

const info = await startServer(root, port);
console.log(`Serving ${info.root}`);
console.log(`  index  ${info.url}`);
console.log('');
console.log('Loopback only — not reachable from other machines. Ctrl+C to stop.');
