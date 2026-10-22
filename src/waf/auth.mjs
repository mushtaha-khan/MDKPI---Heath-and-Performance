/**
 * Login for the WAF runner. Reuses the exact DOM confirmed by recon:
 *   input[name=username], input[name=password], PrimeNG p-select role dropdown,
 *   input[type=submit]. Default role shown is DEALER; AUTOGROUP is the other option.
 */

/**
 * Log a fresh page into a tenant with a given role.
 * @returns {Promise<{ok: boolean, landed: string, status: number|null}>}
 */
export async function login(page, { base, role, username, password, navTimeout = 90000 }) {
  const loginUrl = `${base.replace(/\/$/, '')}/login`;
  const resp = await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  await page.waitForLoadState('networkidle', { timeout: navTimeout }).catch(() => {});
  await page.waitForTimeout(1200);

  // Select role only if it differs from the current label.
  const combo = page.locator('p-select, .p-select, [role="combobox"]').first();
  const current = (await combo.innerText().catch(() => '')).trim();
  if (current.toUpperCase() !== role.toUpperCase()) {
    await combo.click();
    await page.waitForTimeout(700);
    await page
      .locator('.p-select-option, [role="option"]')
      .filter({ hasText: new RegExp(`^\\s*${role}\\s*$`, 'i') })
      .first()
      .click();
    await page.waitForTimeout(400);
  }

  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[type="submit"]').click();

  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle', { timeout: navTimeout }).catch(() => {});
  await page.waitForTimeout(2000);

  const landed = page.url();
  return {
    ok: !/\/login(\?|$|\/)/.test(landed),
    landed,
    status: resp?.status() ?? null,
  };
}

/** Clear client auth state to simulate an expired/absent session (WAF-20). */
export async function clearSession(context) {
  await context.clearCookies();
  for (const page of context.pages()) {
    await page
      .evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch {
          /* storage may be unavailable on some origins */
        }
      })
      .catch(() => {});
  }
}
