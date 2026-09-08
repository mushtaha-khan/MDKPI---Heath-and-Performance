/**
 * Phase 1 recon: discover the login screen's real DOM.
 *
 * Read-only. Navigates to the portal, waits for the login form, and dumps every
 * form control, dropdown option, and button it finds so we can build reliable
 * selectors instead of guessing. Does NOT submit credentials.
 *
 * Usage: node scripts/recon-login.mjs
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';

dotenv.config();

const BASE = process.env.KPI_BASE_URL;
const HEADLESS = process.env.KPI_HEADLESS !== 'false';
const NAV_TIMEOUT = Number(process.env.KPI_NAV_TIMEOUT_MS ?? 90000);
const OUT = 'artifacts/recon';

if (!BASE) {
  console.error('KPI_BASE_URL missing from .env');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: HEADLESS });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

/** Network log — reveals the auth endpoint and any config/bootstrap calls. */
const requests = [];
page.on('request', (r) => {
  const type = r.resourceType();
  if (type === 'xhr' || type === 'fetch' || type === 'document') {
    requests.push({ method: r.method(), url: r.url(), type });
  }
});

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

console.log(`Navigating to ${BASE} ...`);
const response = await page.goto(BASE, {
  waitUntil: 'domcontentloaded',
  timeout: NAV_TIMEOUT,
});
console.log(`HTTP ${response?.status()} -> ${page.url()}`);

// Give a SPA time to render its login form.
await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {
  console.log('(networkidle not reached; continuing)');
});
await page.waitForTimeout(2500);

/** Enumerate every interactive control, with the attributes we'd build selectors from. */
const controls = await page.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  const describe = (el) => {
    const attrs = {};
    for (const a of el.attributes) {
      // Never capture a value that might hold a typed secret.
      if (a.name === 'value' && el.type === 'password') continue;
      attrs[a.name] = a.value;
    }
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type ?? null,
      attrs,
      text: (el.innerText ?? el.textContent ?? '').trim().slice(0, 120),
      visible: visible(el),
      // For <select>, capture the option list — this is how we learn the role values.
      options:
        el.tagName.toLowerCase() === 'select'
          ? [...el.options].map((o) => ({ value: o.value, label: o.textContent.trim() }))
          : undefined,
    };
  };

  const nodes = [
    ...document.querySelectorAll(
      'input, select, textarea, button, [role="combobox"], [role="listbox"], [role="button"], a[href]',
    ),
  ];

  return {
    title: document.title,
    url: location.href,
    controls: nodes.map(describe).filter((c) => c.visible),
    // Any framework hints help us predict grid/report rendering later.
    frameworkHints: {
      hasAngular: !!document.querySelector('[ng-version]'),
      ngVersion: document.querySelector('[ng-version]')?.getAttribute('ng-version') ?? null,
      hasReactRoot: !!document.querySelector('#root, #app'),
      hasKendo: !!document.querySelector('[class*="k-"]'),
      hasAgGrid: !!document.querySelector('[class*="ag-"]'),
      hasMatSelect: !!document.querySelector('mat-select, .mat-select, .mat-mdc-select'),
      hasPrimeNg: !!document.querySelector('[class*="p-dropdown"], [class*="p-component"]'),
    },
    iframeCount: document.querySelectorAll('iframe').length,
  };
});

const report = {
  capturedAt: new Date().toISOString(),
  landedUrl: controls.url,
  pageTitle: controls.title,
  httpStatus: response?.status() ?? null,
  frameworkHints: controls.frameworkHints,
  iframeCount: controls.iframeCount,
  controlCount: controls.controls.length,
  controls: controls.controls,
  network: requests,
  consoleErrors,
};

await writeFile(`${OUT}/login-dom.json`, JSON.stringify(report, null, 2), 'utf8');
await writeFile(`${OUT}/login.html`, await page.content(), 'utf8');
await page.screenshot({ path: `${OUT}/login.png`, fullPage: true });

// Console summary
console.log(`\nTitle: ${report.pageTitle}`);
console.log(`Landed: ${report.landedUrl}`);
console.log(`Framework: ${JSON.stringify(report.frameworkHints)}`);
console.log(`iframes: ${report.iframeCount}`);
console.log(`\n--- ${report.controlCount} visible controls ---`);
for (const c of report.controls) {
  const id = c.attrs.id ? `#${c.attrs.id}` : '';
  const name = c.attrs.name ? `[name=${c.attrs.name}]` : '';
  const ph = c.attrs.placeholder ? ` ph="${c.attrs.placeholder}"` : '';
  const fc = c.attrs.formcontrolname ? ` formControlName=${c.attrs.formcontrolname}` : '';
  console.log(
    `${c.tag}${c.type ? `:${c.type}` : ''} ${id}${name}${ph}${fc}` +
      `${c.text ? ` text="${c.text}"` : ''}`,
  );
  if (c.options?.length) {
    for (const o of c.options) console.log(`      option value="${o.value}" label="${o.label}"`);
  }
}
console.log(`\n--- network (${requests.length}) ---`);
for (const r of requests) console.log(`${r.method} ${r.type} ${r.url}`);
if (consoleErrors.length) {
  console.log(`\n--- console errors (${consoleErrors.length}) ---`);
  for (const e of consoleErrors.slice(0, 10)) console.log(e);
}
console.log(`\nArtifacts -> ${OUT}/login-dom.json, login.html, login.png`);

await browser.close();
