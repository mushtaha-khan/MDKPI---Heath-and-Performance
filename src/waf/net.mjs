/**
 * Network + console collector for a Playwright page.
 *
 * The whole WAF suite hinges on one question per navigation: did anything return 403?
 * This attaches listeners that record every response status and console error, so each
 * check can ask "were there any forbidden responses while I was on this page?" and
 * capture the offending URLs with their status for the report and for WAF-40/41 handoff.
 */

/**
 * Attach collectors to a page. Returns a controller with:
 *   mark(label)  - start a fresh window (clears buffers), tagging subsequent events
 *   forbidden()  - array of {status,url,type} with status 401/403 since last mark
 *   errors()     - array of {status,url,type} with status >= 400 since last mark
 *   all()        - every recorded response since last mark
 *   consoleErrors() - console error strings since last mark
 *   detach()     - remove listeners
 */
export function collect(page, { originHost = null } = {}) {
  let responses = [];
  let consoleErrs = [];

  // Classify a response as first-party (the tenant origin / mydealerkpi API) vs
  // third-party (e.g. an S3 bucket, Google Maps). WAF acceptance criteria are about
  // the tenant's own origin; a 403 from an unrelated third-party CDN is not a WAF
  // failure and must not be counted as one.
  const isFirstParty = (url) => {
    try {
      const h = new URL(url).hostname;
      if (originHost && h === originHost) return true;
      return /(^|\.)mydealerkpi\.com$/i.test(h);
    } catch {
      return false;
    }
  };

  const onResponse = (resp) => {
    try {
      const url = resp.url();
      responses.push({
        status: resp.status(),
        url,
        type: resp.request().resourceType(),
        firstParty: isFirstParty(url),
      });
    } catch {
      /* response object may be gone on teardown */
    }
  };
  const onConsole = (msg) => {
    if (msg.type() === 'error') consoleErrs.push(msg.text());
  };
  const onRequestFailed = (req) => {
    // Chunk load failures surface here as well as in console.
    consoleErrs.push(`requestfailed ${req.resourceType()} ${req.url()} :: ${req.failure()?.errorText ?? ''}`);
  };

  page.on('response', onResponse);
  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);

  return {
    mark() {
      responses = [];
      consoleErrs = [];
    },
    // First-party 401/403 only — the signal the WAF cases actually care about.
    forbidden() {
      return responses.filter((r) => (r.status === 403 || r.status === 401) && r.firstParty);
    },
    // Third-party 401/403 (e.g. external CDN) — recorded for transparency, never a FAIL.
    thirdPartyForbidden() {
      return responses.filter((r) => (r.status === 403 || r.status === 401) && !r.firstParty);
    },
    // First-party asset failures: any 4xx/5xx on a first-party JS/CSS/font/image request.
    // This is the signal for the asset-integrity check (broken images / 403 / 404).
    assetFailures() {
      const assetTypes = new Set(['image', 'stylesheet', 'font', 'script', 'media']);
      return responses.filter(
        (r) => r.firstParty && r.status >= 400 && (assetTypes.has(r.type) || r.status === 404),
      );
    },
    errors() {
      return responses.filter((r) => r.status >= 400);
    },
    all() {
      return responses.slice();
    },
    consoleErrors() {
      return consoleErrs.slice();
    },
    detach() {
      page.off('response', onResponse);
      page.off('console', onConsole);
      page.off('requestfailed', onRequestFailed);
    },
  };
}
