/**
 * Playwright MCP smoke check.
 *
 * Proves the MCP server can complete the JSON-RPC handshake, launch a real
 * browser, navigate, and return an accessibility snapshot + network log.
 *
 * Usage: node scripts/mcp-smoke.mjs [port] [url]
 *
 * Assumes an MCP server is already listening on the given port, e.g.:
 *   npx -y @playwright/mcp@0.0.79 --config ./playwright-mcp.config.json --port 8932 --headless
 */

const PORT = process.argv[2] ?? '8932';
const URL_UNDER_TEST = process.argv[3] ?? 'https://example.com';
// Use "localhost" (not 127.0.0.1): the MCP server binds to localhost, which on
// Windows resolves to ::1 first, so a hardcoded IPv4 literal fails to connect.
const HOST = process.env.MCP_HOST ?? 'localhost';
const ENDPOINT = `http://${HOST}:${PORT}/mcp`;

let sessionId = null;
let nextId = 1;

/** Parse an SSE body into the first JSON-RPC payload it contains. */
function parseSse(body) {
  const line = body
    .split('\n')
    .find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`No SSE data frame in response: ${body.slice(0, 300)}`);
  return JSON.parse(line.slice('data: '.length));
}

async function rpc(method, params, { notify = false } = {}) {
  const payload = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (notify) return null;

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}: ${text.slice(0, 300)}`);

  const msg = parseSse(text);
  if (msg.error) throw new Error(`RPC error on ${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

/** Pull readable text out of an MCP tool result content array. */
function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

const checks = [];
function record(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ->  ${detail}` : ''}`);
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mydealerkpi-smoke', version: '0.1.0' },
  });
  record(
    'handshake',
    Boolean(init?.serverInfo),
    `${init.serverInfo.name} core ${init.serverInfo.version}`,
  );

  await rpc('notifications/initialized', undefined, { notify: true });

  const tools = await rpc('tools/list', {});
  const names = new Set(tools.tools.map((t) => t.name));
  record('tools/list', names.size > 0, `${names.size} tools`);

  // Capability gates the report suite depends on.
  for (const required of [
    'browser_navigate',
    'browser_snapshot',
    'browser_network_requests',
    'browser_take_screenshot',
    'browser_storage_state',
    'browser_verify_text_visible',
    'browser_pdf_save',
  ]) {
    record(`capability: ${required}`, names.has(required));
  }

  // The real test: can it drive an actual browser?
  const nav = await rpc('tools/call', {
    name: 'browser_navigate',
    arguments: { url: URL_UNDER_TEST },
  });
  const navText = textOf(nav);
  record('browser launch + navigate', !nav.isError, URL_UNDER_TEST);

  const snap = await rpc('tools/call', { name: 'browser_snapshot', arguments: {} });
  const snapText = textOf(snap) || navText;
  record(
    'accessibility snapshot',
    snapText.length > 50,
    `${snapText.length} chars`,
  );

  // browser_network_requests hides static assets by default and surfaces only
  // XHR/fetch — which is what we want for report API calls. A page with no XHR
  // legitimately reports zero, so treat the "static not shown" note as success.
  const net = await rpc('tools/call', {
    name: 'browser_network_requests',
    arguments: { static: true },
  });
  const netText = textOf(net);
  const httpLines = netText.split('\n').filter((l) => l.includes('http')).length;
  record(
    'network capture',
    httpLines > 0 || /static request/i.test(netText),
    httpLines > 0 ? `${httpLines} request(s) logged` : 'reachable, no XHR on this page',
  );

  await rpc('tools/call', { name: 'browser_close', arguments: {} }).catch(() => {});
} catch (err) {
  record('fatal', false, err.message);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
