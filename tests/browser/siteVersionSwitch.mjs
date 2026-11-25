// Old/new website switch (owner, 25 Nov 2026). Needs the two-version site served with its
// Cloudflare function: `npx wrangler pages dev <site> --port 4510`, then
// PDF_CHEF_URL=http://127.0.0.1:4510 node tests/browser/siteVersionSwitch.mjs [shots dir]
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.PDF_CHEF_URL ?? 'http://127.0.0.1:4510';
const shots = process.argv[2];
const browser = await chromium.launch();
const results = [];
for (const [name, viewport, mobile] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1280, height: 800 }, false]]) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true }));
  });
  const page = await context.newPage();
  const entry = async () => page.evaluate(() => document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src'));
  const isNew = async () => page.evaluate(() => document.querySelector('meta[name="pdfchef-version-switch"]') !== null);

  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const oldEntry = await entry();
  assert.equal(await isNew(), false, 'a first visit gets the old version');
  const bar = page.getByRole('navigation', { name: 'Website version' });
  await bar.waitFor();
  assert.equal(await bar.locator('[aria-current="true"]').innerText(), 'Old version');
  if (shots) await page.screenshot({ path: `${shots}/${name}-1-old-home.png` });
  await page.goto(`${origin}/merge`, { waitUntil: 'networkidle' });
  assert.equal(await bar.isVisible().catch(() => false), false, 'the switch shows on Home only');
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });

  await bar.getByRole('link', { name: 'New version' }).click();
  await page.waitForLoadState('networkidle');
  assert.equal(await isNew(), true, 'New version loads the new build');
  assert.notEqual(await entry(), oldEntry);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await isNew(), true, 'a reload keeps the new version');

  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  const group = page.getByRole('radiogroup', { name: 'Website version' });
  await group.waitFor();
  await group.scrollIntoViewIfNeeded();
  if (shots) await page.screenshot({ path: `${shots}/${name}-2-new-settings.png` });
  await group.getByRole('radio', { name: 'Old version' }).click();
  await page.waitForURL(`${origin}/`);
  await page.waitForLoadState('networkidle');
  assert.equal(await isNew(), false, 'Old version goes back');
  assert.equal(await entry(), oldEntry);
  if (name === 'desktop' && shots) {
    await bar.getByRole('link', { name: 'New version' }).click();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${shots}/${name}-3-new-home.png` });
  }
  results.push(`PASS ${name}: old by default, switch to new and back, reload keeps the choice`);
  await context.close();
}
await browser.close();
console.log(results.join('\n'));
