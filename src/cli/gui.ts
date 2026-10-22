/**
 * Launch the GUI control panel.
 *
 * Usage: npm run gui [-- <port>]
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
// Saved modules store their screens as paths; the host comes from KPI_BASE_URL, so the
// panel needs .env loaded to resolve them into URLs.
import 'dotenv/config';
import { startGui } from '../gui/server.js';

const port = Number(process.argv[2] ?? 5173);

// The server lists runs from this directory, so make sure it exists on a fresh clone.
await mkdir(path.join('artifacts', 'runs'), { recursive: true });

const info = await startGui(port);

console.log('');
console.log('  My Dealer KPI — Reconciliation Runner');
console.log('  ' + '-'.repeat(38));
console.log(`  ${info.url}`);
console.log('');
console.log('  Enter the AutoGroup and DMS screen URLs, then run.');
console.log('  Reports are saved per run under artifacts/runs and listed in the panel.');
console.log('');
console.log('  Loopback only — not reachable from other machines. Ctrl+C to stop.');
console.log('');
