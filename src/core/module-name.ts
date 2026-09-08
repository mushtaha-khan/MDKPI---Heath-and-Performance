/**
 * Turning a URL slug into a module name people recognise.
 *
 * Plain title-casing gets the acronyms wrong: ".../service/open-ro" becomes "Open Ro", which
 * then appears as the report's title and its filename. These are initialisms in this domain,
 * not words.
 *
 * Shared because the name is derived in two places — when a run starts, and when the history
 * has only a directory name to go on because the run was interrupted before it wrote its
 * metadata.
 */
const ACRONYMS = new Set([
  'RO', 'ROS', 'KPI', 'ELR', 'CP', 'DMS', 'CSE', 'CSI', 'GL', 'MTD', 'YTD',
  'PDI', 'VIN', 'ASR', 'WIP', 'AR', 'AP', 'OEM', 'SUV', 'GOG', 'LP',
]);

/** "open-ro" / "open ro" -> "Open RO" */
export function titleCaseModuleName(raw: string): string {
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) =>
      ACRONYMS.has(w.toUpperCase())
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(' ');
}
