/**
 * Resolve a human-readable dealer name for a tenant hostname.
 *
 * The domains file only carries hostnames like "am-gyh.mydealerkpi.com". A friendly
 * name (e.g. "GY Honda") isn't derivable from the code alone, so we support an optional
 * override map at config/dealer-names.json:  { "am-gyh.mydealerkpi.com": "GY Honda" }.
 * When no override exists we fall back to the tenant code (the part before the first dot),
 * uppercased and with the "am-" prefix stripped, so the column is always populated and
 * clearly tied to the domain.
 */
import { readFile } from 'node:fs/promises';

let overrides = null;

export async function loadDealerNames(file = 'config/dealer-names.json') {
  if (overrides) return overrides;
  try {
    overrides = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    overrides = {};
  }
  return overrides;
}

/** Synchronous resolver once overrides are loaded. */
export function dealerName(domain, map = overrides ?? {}) {
  if (map[domain]) return map[domain];
  const code = String(domain).split('.')[0].replace(/^am-/i, '');
  return code.toUpperCase();
}
