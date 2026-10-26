/**
 * Runtime settings store for the testing tool — lets the Settings tab override the target
 * URL and login credentials WITHOUT code changes, applied to subsequent runs.
 *
 * Precedence used by the crawlers: these saved settings (when present) override the .env
 * values. Stored locally in a gitignored JSON file. The password is held so runs can use
 * it, but it is NEVER returned to the browser (the GET exposes only whether one is set).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const FILE = path.resolve('.kpi-settings.json'); // gitignored; local only

let cache = null;

async function load() {
  if (cache) return cache;
  try { cache = JSON.parse(await readFile(FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}

/** Full settings incl. password — for the crawlers only (server-side). */
export async function getSettings() {
  return { ...(await load()) };
}

/**
 * The effective config a run should use: saved setting wins over env, else env.
 * Returns { base, username, password, source:{...} } — password included (server-side use).
 */
export async function effectiveConfig() {
  const s = await load();
  const base = (s.base || process.env.HEALTH_BASE_URL || process.env.KPI_BASE_URL || 'https://gyh.mydealerkpi.com').replace(/\/$/, '');
  const username = s.username || process.env.KPI_USERNAME || '';
  const password = s.password || process.env.KPI_PASSWORD || '';
  return {
    base, username, password,
    source: {
      base: s.base ? 'settings' : 'env',
      username: s.username ? 'settings' : 'env',
      password: s.password ? 'settings' : 'env',
    },
  };
}

/** Browser-safe view — URL + username + whether a password is set, but NOT the password. */
export async function publicSettings() {
  const eff = await effectiveConfig();
  return {
    base: eff.base,
    username: eff.username,
    passwordSet: Boolean(eff.password),
    source: eff.source,
  };
}

/**
 * Update settings. Only non-empty provided fields are written; an explicit empty string
 * for a field clears that override (reverts to env). Returns the new publicSettings().
 */
export async function updateSettings({ base, username, password } = {}) {
  const s = await load();
  if (base !== undefined) { const v = String(base).trim().replace(/\/$/, ''); if (v) s.base = v; else delete s.base; }
  if (username !== undefined) { const v = String(username).trim(); if (v) s.username = v; else delete s.username; }
  // Password: only overwrite when a non-empty value is supplied; empty string clears it.
  if (password !== undefined) { const v = String(password); if (v) s.password = v; else delete s.password; }
  cache = s;
  await mkdir(path.dirname(FILE), { recursive: true }).catch(() => {});
  await writeFile(FILE, JSON.stringify(s, null, 2), 'utf8');
  return publicSettings();
}
