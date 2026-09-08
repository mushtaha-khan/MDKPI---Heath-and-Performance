/**
 * Screenshot a generated report at a given scroll position, for visual checking.
 *
 * Usage: node scripts/snap-report.mjs <reportPath> <outPng> [scrollY] [height]
 */
import { chromium } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , reportPath, outPng, scrollY = '0', height = '1200'] = process.argv;
if (!reportPath || !outPng) {
  console.error('Usage: node scripts/snap-report.mjs <reportPath> <outPng> [scrollY] [height]');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: Number(height) } });
await page.goto(pathToFileURL(path.resolve(reportPath)).href, { waitUntil: 'load', timeout: 120000 });
await page.waitForTimeout(1800);
await page.evaluate((y) => window.scrollTo(0, y), Number(scrollY));
await page.waitForTimeout(500);
await page.screenshot({ path: outPng });
console.log(`-> ${outPng}`);
await browser.close();
