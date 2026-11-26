// Sharp zoom (components/Tool/SharpPageLayer.tsx): a zoomed page is drawn again, at the screen's
// own resolution, only where it is in sight. Checked on a desktop at pixel ratio 1 and 2 and on a
// phone at ratio 3 with touch:
//   - at 400% the detail canvas has the screen's pixels (the page's own drawing alone has not),
//     covers what is in sight, shows the same part of the page as the drawing under it, and stays
//     under the pixel budget (6 million on a phone, 12 million on a desktop);
//   - after a scroll the new area is sharp too, and two pages on screen share the budget;
//   - back at 100%, and in a hidden tab, the canvas is gone;
//   - the canvas takes no pointer events and sits under every overlay (Watermark's text, Edit
//     PDF's paragraphs), in Read PDF, Edit PDF, Sign, Make Fillable and the large page preview;
//   - the two large previews keep Tab inside, close on Escape and give focus back;
//   - the pages moved by a CSS transform rather than scrolled (the large PDF preview at 500%, PDF to
//     Image and Compare's two panes at 400%) get the same detail, also after a drag, with backing
//     pixels close to the screen's own and none at 100%.
// Uses qa-sample.pdf only.
//
//   PDF_CHEF_URL=http://127.0.0.1:4173 node scripts/verify-sharp-zoom.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { qaPdf, settingsKey } from './lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const out = process.env.PDF_CHEF_SHARP_OUTPUT || 'output/web/sharp-zoom';
await mkdir(out, { recursive: true });

const devices = {
  'desktop-1x': { width: 1280, height: 800, dpr: 1, phone: false },
  'desktop-2x': { width: 1280, height: 800, dpr: 2, phone: false },
  'phone-3x': { width: 390, height: 844, dpr: 3, phone: true },
};
const budgetOf = (device) => (device.phone ? { maxPixels: 6_000_000, maxSide: 4096 } : { maxPixels: 12_000_000, maxSide: 8192 });
const sharp = 'canvas[data-sharp-zoom]';
const results = [];
const browser = await chromium.launch({ headless: true });

async function open(deviceKey, route) {
  const device = devices[deviceKey];
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    isMobile: device.phone,
    hasTouch: device.phone,
    locale: 'en-US',
  });
  await context.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ onboardingComplete: true, keepLocalHistory: false, autoDownload: false, confirmLargeJobs: false }));
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
  }, settingsKey);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}${route}`);
  await page.locator('input[type=file]').first().setInputFiles(qaPdf);
  return { context, page, errors, device };
}

/** Presses Zoom in until it stops; returns the number of presses. */
async function zoomToMax(scope) {
  const zoomIn = scope.getByRole('button', { name: 'Zoom in', exact: true }).first();
  let presses = 0;
  while (await zoomIn.isEnabled() && presses < 20) { await zoomIn.click(); presses += 1; }
  return presses;
}

/** Every detail canvas in `scope`, measured in the page. */
const measure = (page, scope = 'body') => page.evaluate(({ scope, sharp }) => {
  const root = document.querySelector(scope);
  const backing = (node) => (node instanceof HTMLCanvasElement ? node.width : node instanceof HTMLImageElement ? node.naturalWidth : 0);
  const through = (node) => {
    let left = 0; let top = 0; let right = window.innerWidth; let bottom = window.innerHeight;
    for (let parent = node.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = parent.getBoundingClientRect();
      left = Math.max(left, box.left); top = Math.max(top, box.top); right = Math.min(right, box.right); bottom = Math.min(bottom, box.bottom);
    }
    return { left, top, right, bottom };
  };
  // The same patch of both drawings, made small and grey, to compare what they show.
  const grey = (source, sx, sy, sw, sh) => {
    const canvas = document.createElement('canvas');
    canvas.width = 96; canvas.height = 96;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 96, 96);
    context.drawImage(source, sx, sy, sw, sh, 0, 0, 96, 96);
    const { data } = context.getImageData(0, 0, 96, 96);
    const values = new Float32Array(96 * 96);
    for (let index = 0; index < values.length; index += 1) values[index] = (data[index * 4] + data[index * 4 + 1] + data[index * 4 + 2]) / 3;
    return values;
  };
  const difference = (a, b) => { let sum = 0; for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index]); return sum / a.length; };
  const spread = (a) => { let min = 255; let max = 0; a.forEach((value) => { min = Math.min(min, value); max = Math.max(max, value); }); return max - min; };

  const canvases = Array.from(root.querySelectorAll(sharp)).map((canvas) => {
    const layer = canvas.parentElement;
    const base = layer.previousElementSibling;
    const rect = canvas.getBoundingClientRect();
    const pageBox = layer.getBoundingClientRect();
    const view = through(layer);
    const seen = { left: Math.max(pageBox.left, view.left), top: Math.max(pageBox.top, view.top), right: Math.min(pageBox.right, view.right), bottom: Math.min(pageBox.bottom, view.bottom) };
    const baseWidth = backing(base);
    const baseHeight = base instanceof HTMLCanvasElement ? base.height : base.naturalHeight;
    const scaleX = baseWidth / pageBox.width;
    const scaleY = baseHeight / pageBox.height;
    const patch = (shift) => grey(base, (rect.left - pageBox.left + shift) * scaleX, (rect.top - pageBox.top + shift) * scaleY, rect.width * scaleX, rect.height * scaleY);
    const own = grey(canvas, 0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      ratio: canvas.width / rect.width,
      baseRatio: baseWidth / pageBox.width,
      baseTag: base?.tagName ?? null,
      pointerEvents: getComputedStyle(canvas).pointerEvents,
      layerPointerEvents: getComputedStyle(layer).pointerEvents,
      covers: rect.left <= seen.left + 1 && rect.top <= seen.top + 1 && rect.right >= seen.right - 1 && rect.bottom >= seen.bottom - 1,
      inside: rect.left >= pageBox.left - 1 && rect.top >= pageBox.top - 1 && rect.right <= pageBox.right + 1 && rect.bottom <= pageBox.bottom + 1,
      contrast: spread(own),
      same: difference(own, patch(0)),
      // The same comparison against a patch of the page a little to the side: must be worse.
      shifted: difference(own, patch(Math.min(rect.width, rect.height) * 0.08)),
    };
  });
  return {
    dpr: Math.min(window.devicePixelRatio, 3),
    canvases,
    total: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
    layers: root.querySelectorAll('[data-sharp-zoom-layer]').length,
  };
}, { scope, sharp });

/** Waits until the detail covers what is in sight again (after a zoom or a scroll), then measures. */
async function settled(page, scope = 'body') {
  await page.waitForTimeout(250);
  await page.waitForFunction(({ scope, sharp }) => document.querySelector(scope)?.querySelector(sharp), { scope, sharp }, { timeout: 8000 });
  let state = await measure(page, scope);
  for (let tries = 0; tries < 30 && !state.canvases.every((canvas) => canvas.covers); tries += 1) {
    await page.waitForTimeout(200);
    state = await measure(page, scope);
  }
  return state;
}

/** Scrolls the reader so the first ink of page 1 (its first line of text) is near the view's top left. */
const scrollToInk = (page, viewport) => page.evaluate((selector) => {
  const scroller = document.querySelector(selector);
  const base = document.querySelector('#viewer-page-1 canvas');
  const small = document.createElement('canvas');
  small.width = 200;
  small.height = Math.round((200 * base.height) / base.width);
  const context = small.getContext('2d', { willReadFrequently: true });
  context.drawImage(base, 0, 0, small.width, small.height);
  const { data } = context.getImageData(0, 0, small.width, small.height);
  let left = small.width; let top = -1;
  for (let y = 0; y < small.height && (top < 0 || y < top + 6); y += 1) {
    for (let x = 0; x < small.width; x += 1) {
      if (data[(y * small.width + x) * 4] < 160) { if (top < 0) top = y; left = Math.min(left, x); }
    }
  }
  const box = base.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  scroller.scrollLeft += box.left + (left / small.width) * box.width - view.left - 24;
  scroller.scrollTop += box.top + (Math.max(0, top) / small.height) * box.height - view.top - view.height * 0.2;
  return top >= 0;
}, viewport);

function checkSharp(state, device, label, { fullRatio = true, needInk = false } = {}) {
  const budget = budgetOf(device);
  assert.ok(state.canvases.length >= 1, `${label}: a detail canvas is up`);
  if (needInk) assert.ok(state.canvases.some((canvas) => canvas.contrast > 40), `${label}: the canvas shows some of the page's text`);
  for (const canvas of state.canvases) {
    assert.equal(canvas.pointerEvents, 'none', `${label}: the canvas takes no pointer events`);
    assert.equal(canvas.layerPointerEvents, 'none', `${label}: the layer takes no pointer events`);
    assert.ok(['CANVAS', 'IMG'].includes(canvas.baseTag), `${label}: the layer sits directly above the page's own drawing (${canvas.baseTag})`);
    assert.ok(canvas.covers, `${label}: the canvas covers the part of the page in sight`);
    assert.ok(canvas.inside, `${label}: the canvas stays inside the page`);
    assert.ok(canvas.ratio > canvas.baseRatio * 1.05, `${label}: sharper than the drawing under it (${canvas.ratio.toFixed(2)} against ${canvas.baseRatio.toFixed(2)})`);
    assert.ok(Math.max(canvas.width, canvas.height) <= budget.maxSide, `${label}: no side over ${budget.maxSide}`);
    if (canvas.contrast > 40) {
      assert.ok(canvas.same < 12, `${label}: the canvas shows the same part of the page as the drawing under it (difference ${canvas.same.toFixed(1)})`);
      assert.ok(canvas.same < canvas.shifted, `${label}: and not a part beside it (${canvas.same.toFixed(1)} against ${canvas.shifted.toFixed(1)})`);
    }
  }
  if (fullRatio) {
    const best = Math.max(...state.canvases.map((canvas) => canvas.ratio));
    assert.ok(best >= 0.95 * state.dpr, `${label}: backing pixels per CSS pixel ${best.toFixed(2)}, the screen has ${state.dpr}`);
  }
  assert.ok(state.total <= budget.maxPixels, `${label}: ${state.total} pixels in all, the budget is ${budget.maxPixels}`);
}

/**
 * What lies at the middle of `overlay`, top first: 'overlay' and 'detail' (a detail canvas). Hit
 * testing skips what takes no pointer events, so both take them for this one question.
 */
const stackAt = (page, scope, overlay) => page.evaluate(({ scope, overlay, sharp }) => {
  const root = document.querySelector(scope);
  const node = root.querySelector(overlay);
  if (!node) return null;
  const canvases = Array.from(root.querySelectorAll(sharp));
  const box = node.getBoundingClientRect();
  const frame = root.querySelector('.tk-largepreview-view')?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const x = (Math.max(box.left, frame.left) + Math.min(box.right, frame.right)) / 2;
  const y = (Math.max(box.top, frame.top) + Math.min(box.bottom, frame.bottom)) / 2;
  const before = node.style.pointerEvents;
  node.style.pointerEvents = node instanceof SVGElement ? 'bounding-box' : 'auto';
  canvases.forEach((canvas) => { canvas.style.pointerEvents = 'auto'; });
  const hits = document.elementsFromPoint(x, y)
    .map((hit) => (canvases.includes(hit) ? 'detail' : hit === node || node.contains(hit) ? 'overlay' : null))
    .filter((hit, index, all) => hit && hit !== all[index - 1]);
  canvases.forEach((canvas) => { canvas.style.pointerEvents = 'none'; });
  node.style.pointerEvents = before;
  return hits;
}, { scope, overlay, sharp });

// ------------------------------------------------------------------ Read PDF
for (const deviceKey of Object.keys(devices)) {
  const { context, page, errors, device } = await open(deviceKey, '/view');
  const label = `Read PDF ${deviceKey}`;
  const viewport = '[data-testid="pdf-zoom-viewport"]';
  await page.waitForFunction(() => document.querySelector('#viewer-page-1 canvas')?.width > 0);
  await page.waitForTimeout(700);
  assert.equal(await page.locator(sharp).count(), 0, `${label}: no detail canvas at 100%`);

  await zoomToMax(page);
  assert.equal(await page.locator(viewport).getAttribute('data-pdf-zoom'), '4.000', `${label}: 400%`);
  let state = await settled(page);
  checkSharp(state, device, `${label} at 400%`);
  // The page's own drawing alone fails the same test: this is the blur the layer removes.
  assert.ok(state.canvases[0].baseRatio < 0.95 * state.dpr, `${label}: the base drawing alone is soft at 400% (${state.canvases[0].baseRatio.toFixed(2)})`);

  // Into the text, for the screenshots and for a patch with something in it.
  assert.equal(await scrollToInk(page, viewport), true, `${label}: the page has text`);
  state = await settled(page);
  checkSharp(state, device, `${label} after a scroll`, { needInk: true });
  const alignment = state.canvases.map((canvas) => ({ difference: Number(canvas.same.toFixed(1)), shiftedDifference: Number(canvas.shifted.toFixed(1)) }));
  await page.screenshot({ path: `${out}/read-400-after-${deviceKey}.png` });
  const hide = await page.addStyleTag({ content: `${sharp} { visibility: hidden !important; }` });
  await page.screenshot({ path: `${out}/read-400-before-${deviceKey}.png` });
  await hide.evaluate((node) => node.remove());

  // The end of page 1 and the start of page 2 together: both sharp, one budget.
  await page.evaluate((selector) => {
    const scroller = document.querySelector(selector);
    const second = document.querySelector('#viewer-page-2').getBoundingClientRect();
    scroller.scrollTop += second.top - scroller.getBoundingClientRect().top - scroller.clientHeight / 2;
  }, viewport);
  state = await settled(page);
  await page.waitForFunction((sharp) => document.querySelectorAll(sharp).length === 2, sharp, { timeout: 8000 });
  state = await settled(page);
  assert.equal(state.canvases.length, 2, `${label}: two pages in sight, two canvases`);
  checkSharp(state, device, `${label} with two pages in sight`, { fullRatio: !device.phone });

  // A hidden tab gives the canvases back; they return with the tab.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.locator(sharp).count(), 0, `${label}: no canvas in a hidden tab`);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settled(page);

  await page.getByRole('button', { name: /Reset zoom to 100%/ }).first().click();
  await page.waitForFunction((sharp) => !document.querySelector(sharp), sharp, { timeout: 1000 });
  assert.deepEqual(errors, [], `${label}: no page errors`);
  results.push({ surface: label, canvasesAt400: state.canvases.length, pixels: state.total, alignment });
  await context.close();
}

// ------------------------------------------- Watermark: the large page preview
for (const deviceKey of ['desktop-2x', 'phone-3x']) {
  const { context, page, errors, device } = await open(deviceKey, '/watermark');
  const label = `Watermark large preview ${deviceKey}`;
  await page.locator('.tk-wm-surface img').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(600);
  assert.equal(await page.locator(sharp).count(), 0, `${label}: the small preview has no detail canvas`);
  const opener = page.getByRole('button', { name: 'Large preview', exact: true }).first();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Large preview' });
  await dialog.waitFor();
  await zoomToMax(dialog);
  let state = await settled(page, '.tk-largepreview');
  // The watermark text, in the middle of the view.
  await dialog.locator('svg text').evaluate((text) => text.scrollIntoView({ block: 'center', inline: 'center' }));
  state = await settled(page, '.tk-largepreview');
  checkSharp(state, device, `${label} at 400%`);
  const top = await stackAt(page, '.tk-largepreview', 'svg text');
  assert.deepEqual(top.slice(0, 2), ['overlay', 'detail'], `${label}: the watermark text is above the detail canvas`);
  await page.screenshot({ path: `${out}/watermark-large-400-${deviceKey}.png` });

  // Keys: Tab stays in the dialog, Escape closes it, focus returns to the button that opened it.
  if (!device.phone) {
    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, `${label}: Tab ${press + 1} stays inside`);
    }
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator(sharp).count(), 0, `${label}: closing the preview removes the canvas`);
  assert.equal(await opener.evaluate((node) => node === document.activeElement), true, `${label}: focus is back on Large preview`);
  assert.deepEqual(errors, [], `${label}: no page errors`);
  results.push({ surface: label, pixels: state.total });
  await context.close();
}

// ------------------- Crop, Page Numbers, Header & Footer: the same large preview
for (const [name, route, overlay] of [
  ['Crop', '/crop', '[data-crop-handle="top"]'],
  ['Page Numbers', '/page-numbers', 'svg text'],
  ['Header & Footer', '/header-footer', 'svg text'],
]) {
  const { context, page, errors, device } = await open('desktop-2x', route);
  const label = `${name} large preview desktop-2x`;
  const opener = page.getByRole('button', { name: 'Large preview', exact: true }).first();
  await opener.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Large preview"]')?.disabled, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator(sharp).count(), 0, `${label}: the small preview has no detail canvas`);
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Large preview' });
  await dialog.waitFor();
  await zoomToMax(dialog);
  let state = await settled(page, '.tk-largepreview');
  const hasOverlay = await dialog.locator(overlay).count();
  if (hasOverlay) {
    await dialog.locator(overlay).first().evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' }));
    state = await settled(page, '.tk-largepreview');
    const stack = await stackAt(page, '.tk-largepreview', overlay);
    assert.deepEqual(stack.slice(0, 2), ['overlay', 'detail'], `${label}: ${overlay} is above the detail canvas`);
  }
  checkSharp(state, device, `${label} at 400%`);
  await page.screenshot({ path: `${out}/${route.slice(1)}-large-400-desktop-2x.png` });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator(sharp).count(), 0, `${label}: closing the preview removes the canvas`);
  assert.deepEqual(errors, [], `${label}: no page errors`);
  results.push({ surface: label, overlayChecked: Boolean(hasOverlay), pixels: state.total });
  await context.close();
}

// ------------------------------------------------------------------ Edit PDF
{
  const { context, page, errors, device } = await open('desktop-2x', '/edit');
  const label = 'Edit PDF desktop-2x';
  const block = page.locator('[data-testid="pdf-text-block"]').first();
  await block.waitFor({ timeout: 60_000 });
  await zoomToMax(page);
  const state = await settled(page);
  checkSharp(state, device, `${label} at 400%`);
  const hit = await page.evaluate((sharp) => {
    const canvas = document.querySelector(sharp);
    canvas.style.pointerEvents = 'auto';
    const area = canvas.getBoundingClientRect();
    const blocks = Array.from(canvas.closest('[data-pdf-page]').querySelectorAll('[data-testid="pdf-text-block"]'));
    const found = blocks.map((node) => node.getBoundingClientRect()).find((box) => {
      const x = box.left + box.width / 2; const y = box.top + box.height / 2;
      return x > area.left && x < area.right && y > area.top && y < area.bottom && x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight;
    });
    const top = found ? document.elementFromPoint(found.left + found.width / 2, found.top + found.height / 2) : null;
    canvas.style.pointerEvents = 'none';
    return { found: Boolean(found), isCanvas: top === canvas };
  }, sharp);
  assert.equal(hit.found, true, `${label}: a paragraph lies over the detail canvas`);
  assert.equal(hit.isCanvas, false, `${label}: the paragraph is above the detail canvas`);
  await page.screenshot({ path: `${out}/edit-400-desktop-2x.png` });
  assert.deepEqual(errors, [], `${label}: no page errors`);
  results.push({ surface: label, pixels: state.total });
  await context.close();
}

// ---------------------------------------------------------------------- Sign
{
  const { context, page, errors, device } = await open('phone-3x', '/sign');
  const label = 'Sign PDF phone-3x';
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-testid="pdf-zoom-viewport"] canvas')).some((canvas) => canvas.width > 0), null, { timeout: 60_000 });
  await zoomToMax(page);
  const state = await settled(page);
  checkSharp(state, device, `${label} at 400%`);
  assert.deepEqual(errors, [], `${label}: no page errors`);
  results.push({ surface: label, pixels: state.total });
  await context.close();
}

// -------------------------------------------------------------- Make Fillable
{
  const { context, page, errors, device } = await open('desktop-2x', '/make-fillable');
  const label = 'Make Fillable desktop-2x';
  const image = page.locator('img.tk-fill-img').first();
  await image.waitFor({ timeout: 60_000 });
  const source = await image.getAttribute('src');
  assert.equal(await page.locator('[data-sharp-zoom-layer]').count(), 0, `${label}: nothing is opened a second time at 100%`);
  await zoomToMax(page);
  const state = await settled(page);
  checkSharp(state, device, `${label} at 400%`);
  assert.equal(await image.getAttribute('src'), source, `${label}: the page picture itself is not replaced`);
  await page.getByRole('button', { name: /Reset zoom to 100%/ }).first().click();
  await page.waitForFunction((sharp) => !document.querySelector(sharp), sharp, { timeout: 1000 });
  assert.deepEqual(errors, [], `${label}: no page errors`);
  results.push({ surface: label, pixels: state.total });
  await context.close();
}

/** Detail at the screen's own resolution, not more: backing size ≈ size on screen × pixel ratio. */
function checkNotOver(state, label) {
  for (const canvas of state.canvases) {
    assert.ok(canvas.ratio <= state.dpr * 1.02, `${label}: backing pixels per CSS pixel ${canvas.ratio.toFixed(2)}, no more than the screen's ${state.dpr}`);
  }
}

/** Drags the page by (dx, dy) from the middle of `frame` (desktop mouse). */
async function drag(page, frame, dx, dy) {
  const box = await page.locator(frame).first().boundingBox();
  const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(x + (dx * step) / 8, y + (dy * step) / 8);
  await page.mouse.up();
}

// --------------------------- The large PDF preview (Delete Pages): a CSS-transform pan, up to 500%
for (const deviceKey of ['desktop-2x', 'phone-3x']) {
  const { context, page, errors, device } = await open(deviceKey, '/delete-pages');
  const label = `Large PDF preview ${deviceKey}`;
  const scope = '[role="dialog"][aria-modal="true"]';
  const opener = page.getByRole('button', { name: 'Preview page 1', exact: true }).first();
  await opener.waitFor({ timeout: 60_000 });
  await opener.click();
  const dialog = page.locator(scope);
  await dialog.locator('img').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  assert.equal(await dialog.locator(sharp).count(), 0, `${label}: no detail canvas at 100%`);
  await zoomToMax(dialog);
  assert.equal(await page.locator('[data-preview-zoom]').getAttribute('data-preview-zoom'), '5', `${label}: 500%`);
  let state = await settled(page, scope);
  checkSharp(state, device, `${label} at 500%`);
  checkNotOver(state, `${label} at 500%`);
  assert.ok(state.canvases[0].baseRatio < 0.95 * state.dpr, `${label}: the page picture alone is soft at 500% (${state.canvases[0].baseRatio.toFixed(2)})`);
  const shot = `${out}/preview-modal-500-after-${deviceKey}.png`;
  await page.screenshot({ path: shot });
  const hide = await page.addStyleTag({ content: `${sharp} { visibility: hidden !important; }` });
  await page.screenshot({ path: `${out}/preview-modal-500-before-${deviceKey}.png` });
  await hide.evaluate((node) => node.remove());
  if (!device.phone) {
    await drag(page, '[data-preview-zoom]', -260, -180);
    state = await settled(page, scope);
    checkSharp(state, device, `${label} after a drag`);
    checkNotOver(state, `${label} after a drag`);
  }
  await dialog.getByRole('button', { name: /Reset zoom to 100%/ }).first().click();
  await page.waitForFunction((sharp) => !document.querySelector(sharp), sharp, { timeout: 1500 });
  assert.deepEqual(errors, [], `${label}: no page errors`);
  results.push({ surface: label, pixels: state.total, ratio: Number(state.canvases[0].ratio.toFixed(2)) });
  await context.close();
}

// ----------------------------------------------------- PDF to Image: a CSS-transform pan, 400%
{
  const { context, page, errors, device } = await open('desktop-2x', '/pdf-to-jpg');
  const label = 'PDF to Image desktop-2x';
  await page.waitForFunction(() => document.querySelector('.tk-imgstage-view canvas')?.width > 0, null, { timeout: 60_000 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator(sharp).count(), 0, `${label}: no detail canvas at 100%`);
  await zoomToMax(page);
  let state = await settled(page, '.tk-imgstage-view');
  checkSharp(state, device, `${label} at 400%`);
  checkNotOver(state, `${label} at 400%`);
  await drag(page, '.tk-imgstage-view', 220, 160);
  state = await settled(page, '.tk-imgstage-view');
  checkSharp(state, device, `${label} after a drag`);
  await page.screenshot({ path: `${out}/pdf-to-image-400-desktop-2x.png` });
  await page.getByRole('button', { name: /Reset zoom to 100%/ }).first().click();
  await page.waitForFunction((sharp) => !document.querySelector(sharp), sharp, { timeout: 1500 });
  assert.deepEqual(errors, [], `${label}: no page errors`);
  results.push({ surface: label, pixels: state.total });
  await context.close();
}

// ------------------------------------------- Compare: two panes, one CSS-transform pan, 400%
{
  const { context, page, errors, device } = await open('desktop-2x', '/compare');
  const label = 'Compare desktop-2x';
  await page.locator('input[type=file]').nth(1).setInputFiles(qaPdf);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.tk-compare-page img')).filter((image) => image.naturalWidth > 0).length === 2, null, { timeout: 60_000 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator(sharp).count(), 0, `${label}: no detail canvas at 100%`);
  await zoomToMax(page);
  await page.waitForFunction((sharp) => document.querySelectorAll(sharp).length === 2, sharp, { timeout: 8000 });
  let state = await settled(page, '.tk-compare-panes');
  assert.equal(state.canvases.length, 2, `${label}: both panes have a detail canvas`);
  checkSharp(state, device, `${label} at 400%`);
  checkNotOver(state, `${label} at 400%`);
  await drag(page, '.tk-compare-page', 160, 200);
  state = await settled(page, '.tk-compare-panes');
  assert.equal(state.canvases.length, 2, `${label}: both panes still have one after a drag`);
  checkSharp(state, device, `${label} after a drag`);
  await page.screenshot({ path: `${out}/compare-400-desktop-2x.png` });
  await page.getByRole('button', { name: /Reset zoom to 100%/ }).first().click();
  await page.waitForFunction((sharp) => !document.querySelector(sharp), sharp, { timeout: 1500 });
  assert.deepEqual(errors, [], `${label}: no page errors`);
  results.push({ surface: label, pixels: state.total });
  await context.close();
}

// ------------------------------------- The large PDF preview's keys (Delete Pages)
{
  const { context, page, errors } = await open('desktop-1x', '/delete-pages');
  const label = 'Large PDF preview keys';
  const opener = page.getByRole('button', { name: 'Preview page 1', exact: true }).first();
  await opener.waitFor({ timeout: 60_000 });
  await opener.click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('img').waitFor({ timeout: 30_000 });
  assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, `${label}: focus moves into the dialog`);
  for (let press = 0; press < 8; press += 1) {
    await page.keyboard.press(press % 3 === 2 ? 'Shift+Tab' : 'Tab');
    assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, `${label}: Tab ${press + 1} stays inside`);
  }
  const zoomIn = dialog.getByRole('button', { name: 'Zoom in', exact: true });
  let presses = 0;
  while (await zoomIn.isEnabled() && presses < 30) { await zoomIn.click(); presses += 1; }
  assert.equal(await page.locator('[data-preview-zoom]').getAttribute('data-preview-zoom'), '5', `${label}: this dialog alone zooms to 500%`);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await opener.evaluate((node) => node === document.activeElement), true, `${label}: focus is back on the thumbnail's button`);
  assert.deepEqual(errors, [], `${label}: no page errors`);
  results.push({ surface: label, maxPercent: 500 });
  await context.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
console.log(`Sharp zoom checks passed. Screenshots: ${out}`);
