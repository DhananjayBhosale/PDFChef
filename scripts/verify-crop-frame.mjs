// Crop's live frame (plan 2.13) and its sentence show the same four numbers, both ways.
// Checks: dragging an edge changes the sentence; typing a value moves the frame; edges stop
// at 40%; the handles answer the keyboard; a corner moves two edges; and the saved crop box
// matches what the frame showed; typing 12 key by key into Top keeps the phone editor open.
// Uses qa-sample.pdf only.
//
//   PDF_CHEF_URL=http://127.0.0.1:4173 node scripts/verify-crop-frame.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { newContext, qaPdf, sizes } from './lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const out = process.env.PDF_CHEF_CROP_OUTPUT || 'output/web/crop-frame';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];

const slider = (page, edge) => page.locator(`[data-crop-handle="${edge}"]`);
const valueOf = async (page, edge) => Number(await slider(page, edge).getAttribute('aria-valuenow'));
const values = async (page) => ({
  top: await valueOf(page, 'top'), right: await valueOf(page, 'right'),
  bottom: await valueOf(page, 'bottom'), left: await valueOf(page, 'left'),
});
const slot = (page, name) => page.getByRole('button', { name: new RegExp(`^${name}, `) });
const pageRect = (page) => page.locator('.tk-crop-page').boundingBox();
const centre = async (locator) => {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const closeEditor = async (page) => {
  await page.keyboard.press('Escape');
  await page.locator('.tk-scrim:not([hidden])').waitFor({ state: 'detached' });
};

/** Drags from a handle's centre by a share of the page (0.05 = 5%). */
async function drag(page, handle, shareX, shareY, { screenshot } = {}) {
  const rect = await pageRect(page);
  const from = await centre(slider(page, handle));
  const to = { x: from.x + rect.width * shareX, y: from.y + rect.height * shareY };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
    if (screenshot && step === steps / 2) await page.screenshot({ path: screenshot });
  }
  await page.mouse.up();
}

for (const key of ['390x844', '1440x900']) {
  const size = sizes.find((entry) => entry.key === key);
  const context = await newContext(browser, size);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/crop`);
  await page.locator('input[type=file]').first().setInputFiles(qaPdf);
  await page.locator('.tk-crop-img').waitFor();
  await page.waitForFunction(() => document.querySelector('.tk-crop-page')?.style.visibility !== 'hidden');
  await page.screenshot({ path: `${out}/crop-loaded-${key}.png` });
  // Phones: each edge is a slot of the sentence with its own editor. Desktop (T-10): the value in
  // the sentence is plain text and the edge's field is beside it, so read and type there.
  const wide = size.width >= 1024;
  const edgeSays = async (name) => (wide
    ? `${name}, ${await page.getByRole('spinbutton', { name: new RegExp(`^${name}`) }).inputValue()}%`
    : slot(page, name).getAttribute('aria-label'));
  const openEdge = async (name) => { if (!wide) await slot(page, name).click(); };
  const closeEdge = async () => { if (wide) await page.keyboard.press('Tab'); else await closeEditor(page); };

  // Five percent on every edge: one "All edges" slot.
  assert.deepEqual(await values(page), { top: 5, right: 5, bottom: 5, left: 5 });
  assert.equal(await slot(page, 'All edges').getAttribute('aria-label'), 'All edges, 5%');

  // Drag the top edge down 5% of the page: the sentence names each edge and Top reads 10%.
  await drag(page, 'top', 0, 0.05, { screenshot: `${out}/crop-mid-drag-${key}.png` });
  assert.equal(await valueOf(page, 'top'), 10);
  assert.equal(await edgeSays('Top'), 'Top, 10%');
  await openEdge('Top');
  assert.equal(await page.getByRole('spinbutton', { name: /^Top/ }).inputValue(), '10');
  await page.screenshot({ path: `${out}/crop-editor-${key}.png` });
  if (!wide) await closeEditor(page);

  // Type 20 for Left: the frame's left edge moves to 20% of the page.
  await openEdge('Left');
  await page.getByRole('spinbutton', { name: /^Left/ }).fill('20');
  await closeEdge();
  assert.equal(await valueOf(page, 'left'), 20);
  const rect = await pageRect(page);
  const frame = await page.locator('[data-crop-frame]').boundingBox();
  assert.ok(Math.abs((frame.x - rect.x) / rect.width - 0.2) < 0.01, `frame left at ${(frame.x - rect.x) / rect.width}`);
  assert.ok(Math.abs((frame.y - rect.y) / rect.height - 0.1) < 0.01, `frame top at ${(frame.y - rect.y) / rect.height}`);

  // An edge stops at 40%, however far it is dragged.
  await drag(page, 'right', -0.6, 0);
  assert.equal(await valueOf(page, 'right'), 40);
  assert.equal(await edgeSays('Right'), 'Right, 40%');

  // The keyboard: arrows by 1, Shift by 5, Home and End.
  await slider(page, 'right').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await valueOf(page, 'right'), 39);
  await page.keyboard.press('Shift+ArrowLeft');
  assert.equal(await valueOf(page, 'right'), 34);
  await page.keyboard.press('Home');
  assert.equal(await valueOf(page, 'right'), 0);
  await page.keyboard.press('ArrowUp');
  assert.equal(await valueOf(page, 'right'), 1);
  await page.keyboard.press('End');
  assert.equal(await valueOf(page, 'right'), 40);
  await page.keyboard.press('Home');
  assert.equal(await edgeSays('Right'), 'Right, 0%');

  // A corner moves its two edges: bottom-right, up and left by 5%.
  await drag(page, 'bottomRight', -0.05, -0.05);
  const afterCorner = await values(page);
  assert.deepEqual(afterCorner, { top: 10, right: 5, bottom: 10, left: 20 });

  // Save: the crop box keeps what the frame showed.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Crop PDF', exact: true }).click();
  const download = page.getByRole('button', { name: 'Download', exact: true });
  const saved = await Promise.race([
    downloadPromise,
    download.waitFor({ timeout: 60_000 }).then(async () => { await download.click(); return downloadPromise; }),
  ]);
  const chunks = [];
  for await (const chunk of await saved.createReadStream()) chunks.push(chunk);
  const document = await PDFDocument.load(Buffer.concat(chunks));
  for (const entry of document.getPages()) {
    const media = entry.getMediaBox();
    const crop = entry.getCropBox();
    const expect = {
      x: media.width * 0.2, y: media.height * 0.1,
      width: media.width * (1 - 0.25), height: media.height * (1 - 0.2),
    };
    for (const field of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(crop[field] - expect[field]) < 0.5, `crop ${field} ${crop[field]} vs ${expect[field]}`);
    }
  }

  assert.deepEqual(errors, [], `page errors at ${key}`);
  results.push({ size: key, margins: afterCorner, cropBox: document.getPage(0).getCropBox() });
  await context.close();
}

// Phone, dark.
{
  const size = sizes.find((entry) => entry.key === '390x844');
  const context = await newContext(browser, size, { appearance: 'dark' });
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${origin}/crop`);
  await page.locator('input[type=file]').first().setInputFiles(qaPdf);
  await page.locator('.tk-crop-img').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/crop-dark-390x844.png` });

  // "All edges" editor (A-006): typing 1 then 2 into Top keeps the editor open, and Top reads 12.
  await slot(page, 'All edges').click();
  const top = page.getByRole('spinbutton', { name: /^Top/ });
  await top.selectText();
  await top.press('1');
  await top.press('2');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.tk-scrim:not([hidden])').count(), 1, 'editor still open after typing 12');
  assert.equal(await top.inputValue(), '12');
  await closeEditor(page);
  assert.equal(await valueOf(page, 'top'), 12);
  results.push({ size: '390x844 dark', typedTop: 12 });
  await context.close();
}

// The large preview (overnight 2026-11-24, s1-02 and s1-03): Tab from Close reaches the four edge
// handles and stays in the dialog, and two arrow presses on one edge both apply, focus staying on it.
{
  const size = sizes.find((entry) => entry.key === '1440x900');
  const context = await newContext(browser, size);
  const page = await context.newPage();
  await page.goto(`${origin}/crop`);
  await page.locator('input[type=file]').first().setInputFiles(qaPdf);
  await page.locator('.tk-crop-img').waitFor();
  await page.getByRole('button', { name: 'Large preview', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-crop-handle="top"]').waitFor();
  await page.waitForTimeout(400);
  const where = () => page.evaluate(() => {
    const active = document.activeElement;
    if (!active?.closest('[role="dialog"]')) return 'outside';
    return active.getAttribute('data-crop-handle') ?? active.getAttribute('aria-label') ?? active.tagName;
  });
  const reached = [];
  for (let press = 0; press < 10; press += 1) {
    await page.keyboard.press('Tab');
    reached.push(await where());
  }
  for (const edge of ['top', 'right', 'bottom', 'left']) assert.ok(reached.includes(edge), `Tab never reaches the ${edge} edge: ${reached.join(', ')}`);
  assert.ok(!reached.includes('outside'), `Tab left the dialog: ${reached.join(', ')}`);
  const top = dialog.locator('[data-crop-handle="top"]');
  await top.focus();
  const start = Number(await top.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  assert.equal(Number(await top.getAttribute('aria-valuenow')), start - 2, 'both arrow presses apply');
  assert.equal(await where(), 'top', 'focus stays on the edge');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  results.push({ size: '1440x900 large preview', tabReached: [...new Set(reached)], topAfterTwoArrows: start - 2 });
  await context.close();
}

await browser.close();
console.log(JSON.stringify({ status: 'PASS', results }, null, 2));
