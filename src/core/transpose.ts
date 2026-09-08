/**
 * Pivot a single-row summary strip into rows.
 *
 * Two screens can publish exactly the same figures with the dimensions swapped. The
 * AutoGroup Open RO screen puts the aging buckets down the rows:
 *
 *     AGING BUCKET | OPEN RO COUNT | % OF COUNT | OPEN RO SALES | OPEN RO GROSS
 *     0-7 DAYS     | 3             | 10.3%      | $1,523.93     | $1,523.93
 *     8-15 DAYS    | 13            | 44.8%      | $380.00       | $380.00
 *
 * while the DMS screen puts them across the header of a strip with one body row:
 *
 *     0-7 DAYS | SALES     | GROSS     |  | 8-15 DAYS | SALES   | GROSS   | ...
 *     3        | $1,523.93 | $1,523.93 |  | 13        | $380.00 | $380.00 | ...
 *
 * Row matching compares row labels, and the strip has no row labels at all — its bucket
 * names live in the header. The two grids therefore share nothing and never pair, even
 * though every figure agrees. Pivoting the strip so each header block becomes a row
 * restores the correspondence.
 *
 * This is deliberately conservative. It only fires on a table that cannot be matched by
 * rows as it stands, and only when the header genuinely repeats a consistent block of
 * sub-columns, which is what makes the pivot unambiguous.
 */
import type { CapturedTable } from './suite.js';
import { normalizeHeader } from './columns.js';

export interface TransposeResult {
  table: CapturedTable;
  /** Human-readable account of what was pivoted, for the report. */
  note: string;
}

/** A repeating block of columns within the header. */
interface Block {
  label: string;
  /** Column indices in the original strip, paired with the name to give each one. */
  columns: Array<{ index: number; name: string }>;
}

/** Does this cell hold a number rather than a label? */
function isNumeric(s: string): boolean {
  return /^[-+(]?[$€£]?\s?[\d,]+(\.\d+)?\s?[%)]?$/.test((s ?? '').trim());
}

/**
 * Name for a block's leading column.
 *
 * In this layout the leading cell of each block is the block's own label ("0-7 DAYS"),
 * so the column beneath it has no name of its own — the screen leaves it implied. Rather
 * than invent a specific metric name, describe what the values actually are. The report
 * states that the column was unnamed and how it was labelled, and the column alignment
 * confirms the mapping against the other screen's values.
 */
function nameLeadingColumn(values: string[]): string {
  const filled = values.filter((v) => (v ?? '').trim());
  if (!filled.length) return 'VALUE';
  if (filled.every((v) => /^\d[\d,]*$/.test(v.trim()))) return 'COUNT';
  if (filled.some((v) => /[$€£]/.test(v))) return 'AMOUNT';
  if (filled.every((v) => /%/.test(v))) return 'PERCENT';
  return 'VALUE';
}

/**
 * Attempt the pivot. Returns null when the table is not a repeating strip, which is the
 * normal case and not an error.
 */
export function maybeTranspose(table: CapturedTable): TransposeResult | null {
  const rows = table.rows.filter((r) => r.some((c) => (c ?? '').trim()));
  // Only a strip. With two or more body rows the grid has its own row dimension and
  // pivoting it would destroy information rather than recover it.
  if (rows.length !== 1) return null;

  const body = rows[0]!;
  const grid = table.headerGrid ?? table.headers;
  const header = grid.at(-1);
  if (!header || header.length < 4) return null;

  const names = header.map((h) => normalizeHeader(h ?? ''));

  // Which header names repeat? Those are the sub-columns of each block; the ones
  // appearing once are the block labels.
  const counts = new Map<string, number>();
  for (const n of names) {
    if (!n) continue;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const repeating = new Set([...counts].filter(([, n]) => n >= 2).map(([k]) => k));
  const unique = [...counts].filter(([, n]) => n === 1).map(([k]) => k);

  // Need at least two blocks to pivot into, and at least one repeating sub-column to
  // establish where each block begins and ends.
  if (unique.length < 2 || repeating.size < 1) return null;

  const blocks: Block[] = [];
  let current: Block | null = null;
  for (let i = 0; i < names.length; i++) {
    const n = names[i]!;
    if (!n) continue; // spacer column between blocks
    if (repeating.has(n)) {
      // A sub-column only means something inside a block.
      if (current) current.columns.push({ index: i, name: n });
      continue;
    }
    // A name that appears once starts a new block and labels it. Its own column holds
    // the block's leading, unnamed value.
    current = { label: (header[i] ?? '').trim(), columns: [{ index: i, name: '' }] };
    blocks.push(current);
  }

  if (blocks.length < 2) return null;

  // Every block must have the same sub-column shape, or the pivot is guesswork.
  const shape = (b: Block) => b.columns.map((c) => c.name).join('|');
  const firstShape = shape(blocks[0]!);
  if (!blocks.every((b) => shape(b) === firstShape)) return null;

  // A block label must actually look like a label, not a stray number.
  if (blocks.some((b) => !b.label || isNumeric(b.label))) return null;

  // The pivoted body must hold numbers, or this is not a figures strip.
  const allValues = blocks.flatMap((b) => b.columns.map((c) => (body[c.index] ?? '').trim()));
  const numeric = allValues.filter(isNumeric).length;
  if (numeric < allValues.length / 2) return null;

  // Name the leading column from its values across all blocks.
  const leadingValues = blocks.map((b) => (body[b.columns[0]!.index] ?? '').trim());
  const leadingName = nameLeadingColumn(leadingValues);
  for (const b of blocks) b.columns[0]!.name = leadingName;

  const columnNames = blocks[0]!.columns.map((c) => c.name);
  const newHeader = ['', ...columnNames];
  const newRows = blocks.map((b) => [b.label, ...b.columns.map((c) => (body[c.index] ?? '').trim())]);

  const pivoted: CapturedTable = {
    index: table.index,
    caption: table.caption,
    className: table.className,
    headers: [newHeader],
    headerGrid: [newHeader],
    rowCount: newRows.length,
    rows: newRows,
    footers: [],
  };

  const note =
    `This screen published these figures as a single row with ${blocks.length} repeating header ` +
    `block(s) (${blocks.map((b) => b.label).join(', ')}), each holding ${columnNames.length} ` +
    `value(s). The other screen lists the same dimension down its rows, so the strip was pivoted ` +
    `into ${newRows.length} row(s) to make them comparable. The leading value in each block had no ` +
    `column heading of its own — the heading is the block label — so it was named "${leadingName}" ` +
    `from the values it holds.`;

  return { table: pivoted, note };
}
