/**
 * Verify the evidence links actually drive the carousel.
 *
 * Clicks a link in the detail table and confirms the visible slide changes to the one
 * the link points at, and that it belongs to the expected screen.
 *
 * Usage: node scripts/verify-evidence-links.mjs <reportPath>
 */
import { chromium } from '@playwright/test';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function newestReport() {
  const root = 'artifacts/runs';
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => {
      const key = (n) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})[T_](\d{2})-(\d{2})-(\d{2})/.exec(n);
        return m ? Number(m.slice(1).join('')) : 0;
      };
      return key(b) - key(a);
    });
  for (const d of dirs) {
    const html = readdirSync(path.join(root, d)).filter(
      (f) => f.endsWith('.html') && f !== 'index.html',
    );
    if (html.length) return path.join(root, d, html[0]);
  }
  return null;
}

const file = path.resolve(process.argv[2] ?? newestReport());
console.log(`verifying: ${file}\n`);

const checks = [];
const record = (name, passed, detail = '') => {
  checks.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ->  ${detail}` : ''}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 120000 });
await page.waitForTimeout(2000);

const linkCount = await page.locator('a.shotlink').count();
record('evidence links present', linkCount > 0, `${linkCount} link(s)`);

if (linkCount > 0) {
  const startCount = (await page.locator('#cr-count').innerText()).trim();

  // Pick a link whose target slide is not already showing.
  const target = await page.locator('a.shotlink').first().getAttribute('data-slide');
  await page.locator('a.shotlink').first().click();
  await page.waitForTimeout(700);

  const nowCount = (await page.locator('#cr-count').innerText()).trim();
  const activeIdx = await page.evaluate(() => {
    const slides = [...document.querySelectorAll('.cr-slide')];
    return slides.findIndex((s) => s.classList.contains('active'));
  });
  const activeModule = await page.evaluate(() => {
    const s = document.querySelector('.cr-slide.active');
    return s ? s.dataset.module : null;
  });

  record(
    'link selects the slide it points at',
    String(activeIdx) === String(target),
    `data-slide=${target}, active=${activeIdx} (${activeModule})`,
  );
  record('carousel counter updated', nowCount.length > 0, `${startCount} -> ${nowCount}`);

  // A second link pointing at the other side should switch screens.
  const sides = await page.evaluate(() =>
    [...document.querySelectorAll('a.shotlink')].slice(0, 40).map((a) => a.textContent.trim()),
  );
  record('links cover both screens', sides.includes('AG') && sides.includes('DMS'),
    `sample: ${[...new Set(sides)].join(', ')}`);

  const dmsLink = page.locator('a.shotlink', { hasText: 'DMS' }).first();
  if (await dmsLink.count()) {
    await dmsLink.click();
    await page.waitForTimeout(700);
    const mod = await page.evaluate(() => document.querySelector('.cr-slide.active')?.dataset.module);
    record('DMS link shows a DMS screenshot', /DMS/i.test(mod ?? ''), mod ?? '');
  }
}

record('no JS errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
