/**
 * One place for how dates and times are shown.
 *
 * Reports are read by people, so dates are written DD-MM-YYYY and times on a 12-hour clock
 * without seconds. Every display site goes through here, so the report, the GUI history and
 * the console all agree.
 *
 * Run *directory* names deliberately do not use this format. They stay
 * YYYY-MM-DD_HH-MM-SS because they are sorted, compared and parsed as keys: DD-MM-YYYY does
 * not sort chronologically, and dropping seconds would let two runs a few seconds apart
 * collide on the same identifier. The directory is machinery; everything a person reads is
 * formatted.
 */

/** DD-MM-YYYY. */
export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/**
 * 12-hour time with no seconds, e.g. "7:11 PM".
 *
 * Midnight and midday are written 12, not 0 — `getHours() % 12` alone yields "0:30 AM",
 * which reads as an error rather than as half past midnight.
 */
export function formatTime(d: Date): string {
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const meridiem = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${String(d.getMinutes()).padStart(2, '0')} ${meridiem}`;
}

/** DD-MM-YYYY h:mm AM/PM. */
export function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${formatTime(d)}`;
}

/**
 * The same instant, safe to put in a filename.
 *
 * Windows forbids ':' in filenames, so the time is separated with a dot: a report ends up
 * named "... 07-09-2026 7.11 PM.html".
 */
export function formatDateTimeForFile(d: Date): string {
  return `${formatDate(d)} ${formatTime(d).replace(':', '.')}`;
}

/**
 * Parse the internal run stamp, "2026-09-07_19-11-46".
 *
 * Built field by field in local time rather than handed to `new Date(string)`, which would
 * read a bare timestamp as UTC and shift every displayed time by the machine's offset.
 */
export function parseRunStamp(runId: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(runId);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  const date = new Date(y!, mo! - 1, d!, h!, mi!, s!);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Format a run id for display, falling back to the id itself when it does not parse. */
export function formatRunStamp(runId: string): string {
  const d = parseRunStamp(runId);
  return d ? formatDateTime(d) : runId;
}

/**
 * Format an ISO timestamp for display.
 *
 * Returns the input unchanged when it is not a timestamp at all, so a capture that recorded
 * something unexpected still shows what it recorded rather than "Invalid Date".
 */
export function formatIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : formatDateTime(d);
}

/**
 * Rewrite the ISO dates inside a free-text string, e.g. the requested date range
 * "2026-09-01 to 2026-09-30" as read from the portal's own API call.
 *
 * Only the date portion is touched, and only where a full YYYY-MM-DD appears, so any
 * surrounding wording is preserved.
 */
export function formatDatesInText(text: string | null | undefined): string {
  if (!text) return '—';
  return text.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (_, y, mo, d) => {
    const p = (n: string) => n.padStart(2, '0');
    return `${p(d)}-${p(mo)}-${y}`;
  });
}
