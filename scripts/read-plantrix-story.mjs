// Temporary helper: open a Plantrix task in the persistent Chromium profile and
// dump its readable text so the story description + acceptance criteria can be read.
//
// Usage:
//   node scripts/read-plantrix-story.mjs <taskUrl>                 # headless, assumes session exists
//   node scripts/read-plantrix-story.mjs <taskUrl> --login         # headed, waits for manual sign-in
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scripts/read-plantrix-story.mjs <taskUrl> [--login]');
  process.exit(1);
}
const loginMode = process.argv.includes('--login');
const profileDir = path.resolve('.playwright-mcp/profile');
const outDir = path.resolve('artifacts/plantrix');
const LOGIN_WAIT_MS = 10 * 60 * 1000; // give the human 10 minutes to sign in

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: !loginMode,
  viewport: { width: 1920, height: 1080 },
  ignoreHTTPSErrors: true,
});

const page = ctx.pages()[0] ?? (await ctx.newPage());

const settle = async () => {
  try {
    await page.waitForLoadState('networkidle', { timeout: 20000 });
  } catch {
    /* SPA keeps sockets open */
  }
  await page.waitForTimeout(2500);
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);
  await settle();

  if (/\/auth\/login/.test(page.url())) {
    if (!loginMode) {
      console.log('NEEDS_LOGIN: no valid Plantrix session in the profile.');
      process.exitCode = 2;
    } else {
      console.log('WAITING_FOR_LOGIN: sign in in the open browser window...');
      const deadline = Date.now() + LOGIN_WAIT_MS;
      while (Date.now() < deadline) {
        if (!/\/auth\/login/.test(page.url())) break;
        await page.waitForTimeout(3000);
      }
      if (/\/auth\/login/.test(page.url())) {
        console.log('LOGIN_TIMEOUT: still on the login page.');
        process.exitCode = 2;
      } else {
        console.log('LOGIN_DETECTED: navigating to the task.');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForTimeout(5000);
        await settle();
      }
    }
  }

  if (process.exitCode !== 2) {
    const finalUrl = page.url();
    const title = await page.title();
    const text = await page.evaluate(() =>
      (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim()
    );

    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(outDir, `task-${stamp}`);
    await writeFile(`${base}.txt`, `URL: ${finalUrl}\nTITLE: ${title}\n\n${text}`, 'utf8');
    await page.screenshot({ path: `${base}.png`, fullPage: true });

    console.log(`FINAL_URL: ${finalUrl}`);
    console.log(`TITLE: ${title}`);
    console.log(`TEXT_LENGTH: ${text.length}`);
    console.log(`SAVED: ${base}.txt / ${base}.png`);
    console.log('----- BEGIN PAGE TEXT -----');
    console.log(text.slice(0, 40000));
    console.log('----- END PAGE TEXT -----');
  }
} finally {
  await ctx.close();
}
