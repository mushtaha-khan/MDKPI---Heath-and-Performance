/**
 * Google Chat webhook notifier for the health crawl.
 *
 * Fires a message to the configured space whenever a screen fails during the crawl, and
 * a run-summary message at the end if anything failed. The webhook URL (which embeds a
 * key + token) is read from HEALTH_GCHAT_WEBHOOK in .env so it is never hardcoded in
 * source. If the var is unset, notifications are silently skipped.
 */
// Read lazily, not at import time: ES module imports are evaluated before the importer's
// dotenv.config() runs, so reading at import would capture an empty value and silently
// disable alerts. Reading per-call picks up the env once .env has loaded.
const webhook = () => process.env.HEALTH_GCHAT_WEBHOOK || '';

/** Post raw text to Google Chat. Best-effort: never throws into the crawl. */
async function post(text) {
  const WEBHOOK = webhook();
  if (!WEBHOOK) return { skipped: true };
  try {
    const resp = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
    });
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
}

export function notifyEnabled() {
  return Boolean(webhook());
}

/** Alert for a single failing screen. */
export async function notifyFailure(rec, cfg) {
  const lines = [
    `🔴 *Dealership health check — FAILURE*`,
    `*Module:* ${rec.group} › ${rec.name}`,
    `*URL:* ${rec.url}`,
    `*HTTP:* ${rec.httpStatus}`,
    `*Why:* ${rec.reason}`,
  ];
  const detail = [
    ...(rec.forbidden || []),
    ...(rec.serverErrors || []),
    ...(rec.clientErrors || []),
  ].slice(0, 5);
  if (detail.length) lines.push('```\n' + detail.join('\n') + '\n```');
  if (rec.consoleErrors && rec.consoleErrors.length) {
    lines.push(`*Console:* ${rec.consoleErrors.slice(0, 2).join(' | ').slice(0, 300)}`);
  }
  if (cfg) lines.push(`_${cfg.dealerName ? `${cfg.dealerName} · ` : ''}tenant ${cfg.base} · role ${cfg.role} · user ${cfg.user}_`);
  return post(lines.join('\n'));
}

/** End-of-run summary — ALWAYS sent, with full counts and a per-module breakdown. */
export async function notifyRunSummary(summary, failures, results, cfg) {
  if (!summary) return { skipped: true };
  const clean = summary.fail === 0 && summary.warn === 0;
  const head = summary.stopped
    ? `⏹️ *Dealership health crawl STOPPED (${cfg?.role ?? ''})*`
    : clean
      ? `✅ *Dealership health crawl PASSED (${cfg?.role ?? ''})*`
      : `🔴 *Dealership health crawl finished with ${summary.fail} failure(s) (${cfg?.role ?? ''})*`;
  const lines = [
    head,
    `✅ ${summary.pass} pass · ⚠️ ${summary.warn} warn · 🔴 ${summary.fail} fail · ⏭️ ${summary.skip} skip (of ${summary.total})`,
  ];
  if (cfg) lines.push(`_${cfg.dealerName ? `${cfg.dealerName} · ` : ''}tenant ${cfg.base} · role ${cfg.role} · user ${cfg.user}${cfg.when ? ` · ${cfg.when}` : ''}_`);

  if (failures.length) {
    lines.push('*Failing modules:*');
    for (const f of failures.slice(0, 20)) lines.push(`🔴 ${f.group} › ${f.name} — ${f.reason}`);
    if (failures.length > 20) lines.push(`…and ${failures.length - 20} more`);
  }

  // Warnings, listed briefly so the full picture is in the final message.
  const warns = (results || []).filter((r) => r.verdict === 'WARN');
  if (warns.length) {
    lines.push('*Warnings:*');
    for (const w of warns.slice(0, 15)) lines.push(`⚠️ ${w.group} › ${w.name} — ${w.reason}`);
    if (warns.length > 15) lines.push(`…and ${warns.length - 15} more`);
  }

  if (clean && !summary.stopped) lines.push('All modules loaded with no API errors or console errors. 🎉');
  return post(lines.join('\n'));
}
