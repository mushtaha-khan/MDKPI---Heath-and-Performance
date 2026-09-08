/** One-off: dump the raw result of a single MCP tool call, for diagnosing failures. */
const PORT = process.argv[2] ?? '8932';
const TOOL = process.argv[3] ?? 'browser_navigate';
const ARGS = process.argv[4] ? JSON.parse(process.argv[4]) : { url: 'https://example.com' };
const ENDPOINT = `http://localhost:${PORT}/mcp`;

let sessionId = null;
let nextId = 1;

function parseSse(body) {
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`No SSE frame: ${body.slice(0, 300)}`);
  return JSON.parse(line.slice(6));
}

async function rpc(method, params, notify = false) {
  const payload = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(payload) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (notify) return null;
  return parseSse(await res.text());
}

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'debug', version: '1' },
});
await rpc('notifications/initialized', undefined, true);

const out = await rpc('tools/call', { name: TOOL, arguments: ARGS });
console.log(JSON.stringify(out, null, 2));
