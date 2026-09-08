/**
 * Pair up comparable grids across two screens.
 *
 * A module is not necessarily one table. The DMS Service Dashboard renders a period
 * strip, a CSE strip, an advisor-count strip, a retention strip and the main metric
 * grid; another module may split its figures across several comparable tables. Rather
 * than assume a single grid, every table on each side is profiled and then matched to
 * its counterpart by how much of its row-label vocabulary and column-group structure
 * it shares with the other side.
 *
 * Pairing is by observed content, not by table index — index-based assumptions break
 * the moment a screen adds a panel.
 */
import { alignGroupsByName, deriveGeometry, type GridGeometry } from './columns.js';
import { normalizeLabel, similarity } from './match.js';
import { comparableRows, normalizeTable, type NormalizedTable } from './rows.js';
import { maybeTranspose } from './transpose.js';
import type { CapturedTable } from './suite.js';

export interface GridProfile {
  table: CapturedTable;
  geometry: GridGeometry;
  /** Rows aligned, labels recovered, totals separated from breakdown segments. */
  normalized: NormalizedTable;
  /** Normalized row labels of the comparable (total) rows. */
  labels: Set<string>;
  /** Display name for the report. */
  name: string;
  dataRows: number;
  /**
   * Set when this profile came from pivoting a single-row strip, describing what was
   * pivoted. The comparison then runs on the pivoted form, so the report has to say so.
   */
  transposedFrom?: string;
}

export interface GridPair {
  id: string;
  name: string;
  left: GridProfile;
  right: GridProfile;
  groups: string[];
  /** Jaccard overlap of row-label vocabularies, 0..1. */
  labelOverlap: number;
  sharedLabels: number;
  /** Why this pairing was accepted, for the report. */
  reason: string;
}

export interface PairingResult {
  pairs: GridPair[];
  unpairedLeft: GridProfile[];
  unpairedRight: GridProfile[];
  notes: string[];
}

/** Readable name for a grid, preferring its own caption then its headings. */
function gridName(table: CapturedTable, geometry: GridGeometry): string {
  const caption = (table.caption ?? '').trim();
  if (caption) return caption;

  const groups = geometry.groups.filter(Boolean);
  if (groups.length >= 2) return groups.slice(0, 4).join(' / ');

  const firstHeader = (table.headerGrid?.[0] ?? table.headers[0] ?? [])
    .filter(Boolean)
    .slice(0, 4)
    .join(' / ');
  if (firstHeader) return firstHeader;

  return `Table ${table.index}`;
}

/** Build a profile from a table exactly as captured. */
function profileOne(table: CapturedTable): GridProfile {
  // Normalize first: geometry must be derived from aligned rows, or a grid whose
  // segment rows omit leading cells will have its columns offset.
  const normalized = normalizeTable(table.rows);
  const geometry = deriveGeometry(
    table.headerGrid ?? table.headers,
    normalized.rows.map((r) => r.cells),
  );

  // Compare on the totals. Where a grid has no breakdown every row is its own total,
  // so this is the full set of data rows.
  const labels = new Set(
    comparableRows(normalized)
      .map((r) => normalizeLabel(r.label))
      .filter(Boolean),
  );

  return {
    table,
    geometry,
    normalized,
    labels,
    name: gridName(table, geometry),
    dataRows: labels.size,
  };
}

export function profileGrids(tables: CapturedTable[]): GridProfile[] {
  return tables
    .filter((t) => t.rowCount > 0)
    .map((table) => {
      const direct = profileOne(table);

      // A table with fewer than two usable row labels cannot be matched by rows at all,
      // so nothing is lost by trying the pivot — and a single-row summary strip is
      // exactly the case that needs it. Guarding on this keeps every grid that already
      // matches by rows completely untouched.
      if (direct.dataRows >= 2) return direct;

      const pivot = maybeTranspose(table);
      if (!pivot) return direct;

      const pivoted = profileOne(pivot.table);
      // Only accept the pivot if it actually produced something matchable.
      if (pivoted.dataRows < 2) return direct;

      return { ...pivoted, transposedFrom: pivot.note };
    });
}

/**
 * Overlap between two label vocabularies, tolerant of near-miss labels.
 *
 * Exact set intersection is too strict for grids whose rows are entities rather than
 * metrics: AutoGroup lists a technician as "HERIBERTO AVILA" while DMS lists
 * "HERIBERTO XAVIER AVILA (4138)". Those are the same person, but as strings they share
 * nothing, so the two grids scored zero overlap and never paired. A label counts as
 * shared when its closest counterpart on the other side is similar enough.
 */
function vocabularyOverlap(a: Set<string>, b: Set<string>): { score: number; shared: number } {
  if (!a.size || !b.size) return { score: 0, shared: 0 };

  const right = [...b];
  let shared = 0;
  for (const x of a) {
    if (b.has(x)) {
      shared++;
      continue;
    }
    let best = 0;
    for (const y of right) {
      const s = similarity(x, y);
      if (s > best) best = s;
      if (best >= 0.99) break;
    }
    if (best >= 0.7) shared++;
  }

  const union = a.size + b.size - shared;
  return { score: union === 0 ? 0 : shared / union, shared };
}

export interface PairingOptions {
  /** Minimum shared row labels for a pairing to be considered meaningful. */
  minSharedLabels?: number;
  /** Minimum label overlap. Kept low because the two products differ in breadth. */
  minOverlap?: number;
}

/**
 * Match each left grid to at most one right grid.
 *
 * Scores every candidate combination, then accepts them greedily from strongest to
 * weakest so a strong pairing is never stolen by a weaker one. Requires both a shared
 * column group and a minimum shared-label count: overlap alone would happily pair two
 * unrelated tables that both happen to contain the word "TOTAL".
 *
 * Takes already-profiled grids rather than raw tables, so the caller profiles each capture
 * exactly once. Profiling the same capture twice yields two distinct objects for the same
 * table, which breaks identity comparisons downstream, and repeats all the geometry work.
 */
export function pairGrids(
  left: GridProfile[],
  right: GridProfile[],
  opts: PairingOptions = {},
): PairingResult {
  const minShared = opts.minSharedLabels ?? 3;
  const minOverlap = opts.minOverlap ?? 0.08;

  const notes: string[] = [];

  interface Candidate {
    l: GridProfile;
    r: GridProfile;
    score: number;
    shared: number;
    groups: string[];
  }

  const candidates: Candidate[] = [];
  for (const l of left) {
    for (const r of right) {
      // Groups need only be alignable, not identically named. One screen may head a
      // column "SALES" where the other heads it "OPEN RO SALES", relying on the report
      // title for the rest. Requiring identical names refused to pair such grids at all.
      const aligned = alignGroupsByName(l.geometry, r.geometry);
      if (!aligned.length) continue;
      const { score, shared } = vocabularyOverlap(l.labels, r.labels);
      if (shared < minShared || score < minOverlap) continue;
      candidates.push({ l, r, score, shared, groups: aligned.map((a) => a.left) });
    }
  }

  // Strongest first: more shared labels wins, then higher overlap, then more groups.
  candidates.sort(
    (a, b) => b.shared - a.shared || b.score - a.score || b.groups.length - a.groups.length,
  );

  const usedLeft = new Set<CapturedTable>();
  const usedRight = new Set<CapturedTable>();
  const pairs: GridPair[] = [];

  for (const c of candidates) {
    if (usedLeft.has(c.l.table) || usedRight.has(c.r.table)) continue;
    usedLeft.add(c.l.table);
    usedRight.add(c.r.table);
    pairs.push({
      id: `grid-${pairs.length + 1}`,
      // Prefer the richer of the two names.
      name: c.l.name.length >= c.r.name.length ? c.l.name : c.r.name,
      left: c.l,
      right: c.r,
      groups: c.groups,
      labelOverlap: Number(c.score.toFixed(3)),
      sharedLabels: c.shared,
      reason:
        `${c.shared} shared row label(s), ${(c.score * 100).toFixed(0)}% vocabulary overlap, ` +
        `groups: ${c.groups.join(', ')}`,
    });
  }

  const unpairedLeft = left.filter((p) => !usedLeft.has(p.table));
  const unpairedRight = right.filter((p) => !usedRight.has(p.table));

  notes.push(
    `Profiled ${left.length} table(s) on the left and ${right.length} on the right; ` +
      `paired ${pairs.length}.`,
  );
  if (!pairs.length) {
    notes.push(
      'No table on one screen shared both a column group and at least ' +
        `${minShared} row labels with a table on the other. Check that both URLs point at ` +
        'comparable screens, or set gridHints in the module preset.',
    );
  }
  for (const u of unpairedLeft) {
    notes.push(`Left "${u.name}" (${u.dataRows} data rows) had no counterpart.`);
  }
  for (const u of unpairedRight) {
    notes.push(`Right "${u.name}" (${u.dataRows} data rows) had no counterpart.`);
  }

  return { pairs, unpairedLeft, unpairedRight, notes };
}
