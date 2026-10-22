/**
 * Saved module registry.
 *
 * A module is one JSON file in `modules/`, holding both where its two screens live and
 * whatever matching rules the comparison needs for them. The control panel lists these
 * so a module can be re-run with one click instead of pasting two URLs each time.
 *
 * The screen locations are stored as **paths**, not full URLs, and the host comes from
 * KPI_BASE_URL at run time. `modules/` is committed; the tenant hostname belongs to a
 * customer and must not end up in source. Same reason `.env` carries KPI_BASE_URL and
 * KPI_AUTOGROUP_PATH separately today.
 *
 * A module that cannot be resolved is still listed, carrying the reason. Hiding it would
 * leave a file on disk that silently does nothing.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ModulePreset } from './suite.js';

/** One screen of a module. Either `path` (preferred) or `url`. */
export interface ScreenSpec {
  /** Path relative to KPI_BASE_URL, e.g. "/auto-group-v2/service/service-summary". */
  path?: string;
  /**
   * Absolute URL, for the rare module that lives on a different origin. Avoid where a
   * path will do: this puts a hostname into a committed file.
   */
  url?: string;
  /** Login role for this side. Defaults to the KPI_ROLE_* env value. */
  role?: string;
}

/** The full shape of a `modules/<slug>.json` file. */
export interface ModuleDefinition extends ModulePreset {
  screens?: { autogroup?: ScreenSpec; dms?: ScreenSpec };
}

/** A module as the control panel needs it: resolved, or explained. */
export interface SavedModule {
  /** File basename, which is also the preset lookup key the runner derives from the name. */
  slug: string;
  name: string;
  autogroupUrl: string | null;
  dmsUrl: string | null;
  autogroupRole: string;
  dmsRole: string;
  /** Short descriptions of the matching rules this file carries, for the panel. */
  rules: string[];
  /** Why this module cannot be run, or null when it can. */
  problem: string | null;
}

/** Strip one trailing slash so `${base}${path}` never doubles up. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * Resolve one screen to an absolute URL.
 *
 * Returns the reason on failure rather than throwing, so one bad module file does not
 * take the whole list down.
 */
function resolveScreen(
  spec: ScreenSpec | undefined,
  side: 'autogroup' | 'dms',
  base: string,
): { url: string | null; problem: string | null } {
  if (!spec) return { url: null, problem: `screens.${side} is missing.` };

  if (spec.url) {
    try {
      const u = new URL(spec.url);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost') {
        return { url: null, problem: `screens.${side}.url is not https: ${spec.url}` };
      }
      return { url: u.href, problem: null };
    } catch {
      return { url: null, problem: `screens.${side}.url is not a valid URL: ${spec.url}` };
    }
  }

  if (!spec.path) {
    return { url: null, problem: `screens.${side} needs either a "path" or a "url".` };
  }
  // A full URL pasted into `path` is the likely mistake, so name it rather than
  // producing a mangled address.
  if (/^[a-z]+:\/\//i.test(spec.path)) {
    return {
      url: null,
      problem:
        `screens.${side}.path holds a full URL. Put just the path there ` +
        `(e.g. "/report/services/dashboard"), or use "url" if the screen is on another host.`,
    };
  }
  if (!spec.path.startsWith('/')) {
    return { url: null, problem: `screens.${side}.path must start with "/": ${spec.path}` };
  }
  if (!base) {
    return {
      url: null,
      problem: 'KPI_BASE_URL is not set in .env, so a path cannot be resolved to a URL.',
    };
  }
  return { url: `${trimBase(base)}${spec.path}`, problem: null };
}

/** One-line summaries of what this module file configures, for display only. */
function describeRules(def: ModuleDefinition): string[] {
  const out: string[] = [];
  if (def.gridHints?.length) out.push(`grid hints: ${def.gridHints.join(', ')}`);
  const n = (o: object | undefined) => Object.keys(o ?? {}).length;
  if (n(def.aliases)) out.push(`${n(def.aliases)} row alias(es)`);
  if (def.ignore?.length) out.push(`${def.ignore.length} ignored row(s)`);
  if (n(def.tolerances)) out.push(`${n(def.tolerances)} tolerance override(s)`);
  if (def.definitional?.length) out.push(`${def.definitional.length} definitional row(s)`);
  if (n(def.kinds)) out.push(`${n(def.kinds)} kind override(s)`);
  // A declared definitional difference changes what counts as a finding, so it belongs in
  // the panel rather than only inside the module file.
  if (n(def.recordColumns)) {
    out.push(
      `${n(def.recordColumns)} declared column difference(s): ${Object.keys(def.recordColumns!).join(', ')}`,
    );
  }
  if (n(def.corroboration)) {
    out.push(
      `${n(def.corroboration)} declared composition difference(s): ${Object.keys(def.corroboration!).join(', ')}`,
    );
  }
  if (def.matchThreshold != null) out.push(`match threshold ${def.matchThreshold}`);
  return out;
}

/**
 * List every module file, newest convention first.
 *
 * `dir` defaults to `modules/`. Files that do not parse are reported as problems rather
 * than skipped, because a typo in a preset should be visible in the panel.
 */
export async function listModules(
  dir = 'modules',
  env: NodeJS.ProcessEnv = process.env,
): Promise<SavedModule[]> {
  const base = env.KPI_BASE_URL ?? '';
  const defaultAgRole = env.KPI_ROLE_AUTOGROUP ?? 'AUTOGROUP';
  const defaultDmsRole = env.KPI_ROLE_DEALER ?? 'DEALER';

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: SavedModule[] = [];

  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue;
    const slug = e.name.replace(/\.json$/i, '');

    let def: ModuleDefinition;
    try {
      def = JSON.parse(await readFile(path.join(dir, e.name), 'utf8')) as ModuleDefinition;
    } catch (err) {
      out.push({
        slug,
        name: slug,
        autogroupUrl: null,
        dmsUrl: null,
        autogroupRole: defaultAgRole,
        dmsRole: defaultDmsRole,
        rules: [],
        problem: `${e.name} is not valid JSON: ${(err as Error).message}`,
      });
      continue;
    }

    // A preset with no screens block is still a valid preset — it just cannot be offered
    // as a one-click run, so it is left out of the panel entirely rather than listed as
    // broken.
    if (!def.screens) continue;

    const ag = resolveScreen(def.screens.autogroup, 'autogroup', base);
    const dms = resolveScreen(def.screens.dms, 'dms', base);

    out.push({
      slug,
      name: def.name ?? slug,
      autogroupUrl: ag.url,
      dmsUrl: dms.url,
      autogroupRole: def.screens.autogroup?.role ?? defaultAgRole,
      dmsRole: def.screens.dms?.role ?? defaultDmsRole,
      rules: describeRules(def),
      problem: ag.problem ?? dms.problem,
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}
