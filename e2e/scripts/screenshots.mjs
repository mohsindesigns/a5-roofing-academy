// Captures key screens for design review. Usage:
//   BASE_URL=http://127.0.0.1:5173 OUT=/tmp/shots node scripts/screenshots.mjs [route...]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const out = process.env.OUT ?? './screenshots';
const email = process.env.EMAIL ?? 'priya.raman@a5roofing.example';
const password = process.env.PASSWORD ?? 'RidgeLine-2026!';
const executablePath =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const routes = process.argv.slice(2).length ? process.argv.slice(2) : ['/'];
const viewports = (process.env.VIEWPORTS ?? 'desktop').split(',');
const sizes = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 900, height: 1100 },
  mobile: { width: 390, height: 844 },
};

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath });
for (const vp of viewports) {
  const context = await browser.newContext({ viewport: sizes[vp], deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log(`[console:${vp}]`, m.text()));
  if (email !== 'none') {
    await page.goto(`${base}/login`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: false }).first().fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  }
  for (const route of routes) {
    await page.goto(`${base}${route}`);
    // The notification SSE stream keeps the network busy, so networkidle never settles.
    await page.waitForLoadState('domcontentloaded');
    await page
      .locator('h1')
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => {});
    await page.waitForTimeout(1200);
    const name = `${vp}${route.replace(/[/?=&]+/g, '_') || '_home'}.png`;
    await page.screenshot({ path: `${out}/${name}`, fullPage: process.env.FULL === '1' });
    console.log('saved', name);
  }
  await context.close();
}
await browser.close();
