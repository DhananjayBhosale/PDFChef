import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(process.env.PDF_CHEF_DIST_DIR || 'dist');
const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3075';
const output = process.env.PDF_CHEF_I18N_OUTPUT || 'output/localization-20260918/offline';
await mkdir(output, { recursive: true });
const mapping = JSON.parse(await readFile(resolve(root, 'localization/locale-mapping.json'), 'utf8'));
const worker = await readFile(resolve(dist, 'sw.js'), 'utf8');
const manifest = JSON.parse(worker.match(/const PRECACHE_ASSETS = (\[[^;]*\]);/)?.[1] || 'null');
assert(Array.isArray(manifest), 'Production service-worker manifest was injected');
const localeAssets = mapping.filter(row => !row.app.startsWith('en-')).map(row => {
  const matches = manifest.filter(path => new RegExp(`/assets/${row.app}-[\\w-]+\\.js$`).test(path));
  assert.equal(matches.length, 1, `${row.app}: one separately emitted offline catalog`);
  return { locale: row.app, path: matches[0] };
});
const html = await readFile(resolve(dist, 'index.html'), 'utf8');
for (const { path } of localeAssets) assert(!html.includes(path), `${path}: not an initial script/preload`);
const browser = await chromium.launch({ headless: true });
const reports = [];
try {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: 'en-US' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/settings');
  await page.evaluate(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true }));
  });
  await page.reload();
  // Keep the predicate synchronous: an async predicate can be treated as a
  // truthy Promise before installation and precaching have finished.
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', undefined, { timeout: 120_000 });
  const cached = await page.evaluate(async paths => Promise.all(paths.map(async path => Boolean(await caches.match(path)))) , localeAssets.map(row => row.path));
  assert(cached.every(Boolean), 'Every language is cached before going offline');
  await context.setOffline(true);
  for (const { app, direction } of mapping) {
    await page.locator('#app-language').selectOption(app);
    await page.waitForFunction(({ app, direction }) => document.documentElement.lang === app && document.documentElement.dir === direction, { app, direction });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#app-language').waitFor();
    assert.equal(await page.locator('#app-language').inputValue(), app);
    assert.equal(await page.locator('html').getAttribute('lang'), app);
    reports.push({ locale: app, offlineLoad: true, persistedReload: true });
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${reports.length} offline language selections and reloads; ${localeAssets.length} independent cached locale chunks`);
  await context.close();
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ reports, localeAssets }, null, 2));
  await browser.close();
}
