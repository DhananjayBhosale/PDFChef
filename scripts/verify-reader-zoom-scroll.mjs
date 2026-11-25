// Read PDF's floating zoom (plan 2.3) steps aside while a phone reads down and comes back
// on the way up and when focus reaches it. It stays in the accessibility tree throughout.
// On a wide screen zoom sits in the header and never hides. Uses qa-sample.pdf only.
//
//   PDF_CHEF_URL=http://127.0.0.1:4173 node scripts/verify-reader-zoom-scroll.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { newContext, qaPdf, sizes } from './lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const out = process.env.PDF_CHEF_READER_OUTPUT || 'output/web/reader-zoom';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];
const viewport = '[data-testid="pdf-zoom-viewport"]';

/** Scrolls the pages by `distance` px in 20 px steps, a frame apart, as a finger would. */
const scrollBy = (page, distance) => page.evaluate(async ({ selector, distance }) => {
  const scroller = document.querySelector(selector);
  const step = Math.sign(distance) * 20;
  for (let moved = 0; Math.abs(moved) < Math.abs(distance); moved += step) {
    scroller.scrollTop += step;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  return scroller.scrollTop;
}, { selector: viewport, distance });

/** Whether a tap at the button's centre reaches it. */
const tappable = (locator) => locator.evaluate((button) => {
  const box = button.getBoundingClientRect();
  return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button;
});
const settle = (page) => page.waitForTimeout(450);

async function open(size, settings = {}) {
  const context = await newContext(browser, size, settings);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/view`);
  await page.locator('input[type=file]').first().setInputFiles(qaPdf);
  await page.locator('#viewer-page-3').waitFor();
  await page.waitForFunction((selector) => {
    const scroller = document.querySelector(selector);
    return scroller && scroller.scrollHeight - scroller.clientHeight > 600;
  }, viewport);
  await page.waitForTimeout(600);
  return { context, page, errors };
}

// Phone.
{
  const size = sizes.find((entry) => entry.key === '390x844');
  const { context, page, errors } = await open(size);
  const float = page.locator('[data-zoom-float]');
  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
  const zoomOut = page.getByRole('button', { name: 'Zoom out', exact: true });
  assert.equal(await float.count(), 1);
  assert.equal(await tappable(zoomIn), true, 'Zoom is there when the file opens');
  await page.screenshot({ path: `${out}/reader-loaded-390x844.png` });

  // Down 400 px: zoom steps aside, but stays in the accessibility tree.
  const down = await scrollBy(page, 400);
  await settle(page);
  assert.equal(await float.getAttribute('data-hidden'), '', `hidden after scrolling down to ${down}`);
  assert.equal(await tappable(zoomIn), false, 'A hidden zoom does not take taps');
  assert.equal(await zoomIn.count(), 1, 'Zoom in stays in the accessibility tree');
  assert.equal(await zoomOut.count(), 1, 'Zoom out stays in the accessibility tree');
  await page.screenshot({ path: `${out}/reader-scrolled-down-390x844.png` });

  // Up 40 px: back.
  await scrollBy(page, -40);
  await settle(page);
  assert.equal(await float.getAttribute('data-hidden'), null, 'shown after scrolling up');
  assert.equal(await tappable(zoomIn), true);
  await page.screenshot({ path: `${out}/reader-scrolled-up-390x844.png` });

  // Down again, then keyboard focus reaches zoom: back, and stays while focused.
  await scrollBy(page, 200);
  await settle(page);
  assert.equal(await float.getAttribute('data-hidden'), '');
  await zoomOut.focus();
  await settle(page);
  assert.equal(await float.getAttribute('data-hidden'), null, 'focus brings zoom back');
  await scrollBy(page, 100);
  await settle(page);
  assert.equal(await float.getAttribute('data-hidden'), null, 'stays while a zoom control has focus');

  // Zooming shows it and is not mistaken for reading down.
  await page.locator(viewport).click({ position: { x: 20, y: 20 } });
  await scrollBy(page, 120);
  await settle(page);
  await zoomIn.evaluate((button) => button.click());
  await settle(page);
  assert.equal(await float.getAttribute('data-hidden'), null, 'shown after a zoom change');

  // The tools menu.
  await page.getByRole('button', { name: /Tools/ }).first().click();
  await page.locator('.tk-rmenu').waitFor();
  await page.screenshot({ path: `${out}/reader-menu-390x844.png` });
  await page.keyboard.press('Escape');

  assert.deepEqual(errors, [], 'page errors on the phone');
  results.push({ size: size.key, scrolledTo: down });
  await context.close();
}

// Wide screen: zoom lives in the header and never hides.
{
  const size = sizes.find((entry) => entry.key === '1440x900');
  const { context, page, errors } = await open(size);
  assert.equal(await page.locator('[data-zoom-float]').count(), 0, 'No floating zoom on a wide screen');
  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
  await page.screenshot({ path: `${out}/reader-loaded-1440x900.png` });
  const down = await scrollBy(page, 400);
  await settle(page);
  assert.equal(await tappable(zoomIn), true, 'Header zoom stays after scrolling down');
  await page.screenshot({ path: `${out}/reader-scrolled-down-1440x900.png` });
  await page.getByRole('button', { name: /Tools/ }).first().click();
  await page.locator('.tk-rmenu').waitFor();
  await page.screenshot({ path: `${out}/reader-menu-1440x900.png` });
  assert.deepEqual(errors, [], 'page errors on a wide screen');
  results.push({ size: size.key, scrolledTo: down });
  await context.close();
}

// Phone, dark.
{
  const size = sizes.find((entry) => entry.key === '390x844');
  const { context, page } = await open(size, { appearance: 'dark' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/reader-dark-390x844.png` });
  await context.close();
}

await browser.close();
console.log(JSON.stringify({ status: 'PASS', results }, null, 2));
