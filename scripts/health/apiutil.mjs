/**
 * Shared helpers for capturing API detail across Health + Performance reports:
 *   - deriving a short API name from an endpoint
 *   - redacting sensitive values from URLs / payloads
 *   - truncating large bodies
 *
 * Redaction is deliberately conservative: tokens, passwords, emails, phone numbers, and
 * common secret-ish keys are masked before anything is saved or exported. We never invent
 * data — a missing payload stays empty.
 */

const MAX_BODY = 2048; // 2 KB cap for captured request bodies

/** Short, human name for an endpoint = last meaningful path segment (no query). */
export function apiName(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    // Prefer the last non-numeric segment (ids aren't descriptive).
    for (let i = segs.length - 1; i >= 0; i--) {
      if (!/^\d+$/.test(segs[i])) return segs[i];
    }
    return segs[segs.length - 1] || u.hostname;
  } catch {
    return String(url).split('?')[0].split('/').filter(Boolean).pop() || url;
  }
}

/** Endpoint path (no query string) for grouping/identity. */
export function endpointPath(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return String(url).split('?')[0]; }
}

/** Query string (decoded-ish), redacted. '' if none. */
export function queryString(url) {
  try { const u = new URL(url); return redact(u.search ? u.search.slice(1) : ''); } catch { return ''; }
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._-]+/gi;
// key:"value" or key=value for sensitive key names.
const SECRET_KEY_RE = /("?\b(?:password|passwd|pwd|token|access_token|refresh_token|api[_-]?key|apikey|secret|authorization|auth|session|cookie|ssn|credit[_-]?card|card[_-]?number)\b"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,&}]+)/gi;

/** Redact sensitive values from any string (URL query, JSON body, etc.). */
export function redact(text) {
  if (text == null) return '';
  let s = String(text);
  s = s.replace(JWT_RE, '***JWT***');
  s = s.replace(BEARER_RE, '$1***');
  s = s.replace(SECRET_KEY_RE, '$1***REDACTED***');
  s = s.replace(EMAIL_RE, '***EMAIL***');
  s = s.replace(PHONE_RE, '***PHONE***');
  return s;
}

/** Capture + redact + truncate a request body. Returns '' when there is none. */
export function redactBody(raw) {
  if (raw == null || raw === '') return '';
  let s = typeof raw === 'string' ? raw : (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })();
  s = redact(s);
  if (s.length > MAX_BODY) s = s.slice(0, MAX_BODY) + `… [truncated, ${s.length} chars]`;
  return s;
}

/**
 * De-duplicate a list of captured API records by method+endpoint+query, keeping a `count`
 * and the SLOWEST observed response time (worst case is the useful one for perf triage).
 * Preserves first-seen order. Does not invent timing — missing stays null.
 */
export function dedupeApis(list) {
  const map = new Map();
  for (const a of list) {
    const key = `${a.method} ${a.endpoint} ${a.query || ''}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...a, count: 1 });
    } else {
      prev.count++;
      // keep worst (max) response time if both present
      if (typeof a.ms === 'number' && (typeof prev.ms !== 'number' || a.ms > prev.ms)) prev.ms = a.ms;
      // keep a failing status over a passing one
      if (typeof a.status === 'number' && a.status >= 400) prev.status = a.status;
      // keep a body if we didn't have one
      if (!prev.payload && a.payload) prev.payload = a.payload;
    }
  }
  return [...map.values()];
}
