import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

const base = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4207';
const output = process.env.PDF_CHEF_PREVIEW_OUTPUT || 'output/preview-lifecycle';
const phases = new Set((process.env.PDF_CHEF_PREVIEW_PHASES || 'pan,workers,compression').split(','));
await mkdir(output, { recursive: true });
const source = await PDFDocument.create();
for (let index = 0; index < 4; index++) source.addPage([144, 216]).drawText(`Page ${index + 1}`, { x: 12, y: 160, size: 16 });
const bytes = [...await source.save()];
const fixture = { name: 'preview-lifecycle.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) };
const browser = await chromium.launch();
const results = [];
const pass = (name, details) => { results.push({ name, ...details }); console.log(`PASS ${name}`); };

async function setup() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, hasTouch: true, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('pdfchef.locale.v1', 'en-US');
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true, keepLocalHistory: false, autoDownload: false, confirmLargeJobs: false }));
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
    const listeners = new Map(), onceWrappers = new Map();
    const add = window.addEventListener, remove = window.removeEventListener;
    window.addEventListener = function (type, listener, options) {
      if (type.startsWith('pointer')) { const set = listeners.get(type) || new Set(); set.add(listener); listeners.set(type, set); }
      if (type.startsWith('pointer') && options?.once) {
        const original = listener;
        listener = function (event) {
          listeners.get(type)?.delete(original);
          onceWrappers.delete(original);
          return typeof original === 'function' ? original.call(this, event) : original.handleEvent(event);
        };
        onceWrappers.set(original, listener);
      }
      return add.call(this, type, listener, options);
    };
    window.removeEventListener = function (type, listener, options) {
      listeners.get(type)?.delete(listener);
      const wrapped = onceWrappers.get(listener) || listener;
      onceWrappers.delete(listener);
      return remove.call(this, type, wrapped, options);
    };
    let baseline = new Map();
    window.__markPanListeners = () => { baseline = new Map([...listeners].map(([type, set]) => [type, new Set(set)])); };
    window.__panListeners = () => ['pointermove', 'pointerup', 'pointercancel'].map(type => [...(listeners.get(type) || [])].filter(listener => !baseline.get(type)?.has(listener)).length);
    window.addEventListener('pointerdown', event => { window.__lastPointerId = event.pointerId; }, true);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { context, page };
}

async function expectNoPdfWorkers(page) {
  const workers = page.workers().filter(worker => worker.url().includes('pdf.worker'));
  // PDF.js destroy can resolve before Playwright receives the worker-close event.
  await Promise.all(workers.map(worker => worker.waitForEvent('close', { timeout: 5000 })));
  assert.equal(page.workers().filter(worker => worker.url().includes('pdf.worker')).length, 0);
}

try {
  if (phases.has('pan')) for (const route of ['/reorder', '/pdf-to-jpg']) {
    const { context, page } = await setup();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + route);
    await page.locator('input[type=file]').setInputFiles(fixture);
    if (route === '/reorder') {
      await page.getByRole('button', { name: 'Preview page 1', exact: true }).click();
      await page.getByRole('dialog').locator('img').waitFor();
    } else await page.locator('canvas').waitFor();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const viewport = page.locator('div.cursor-grab');
    const image = viewport.locator(':scope > div[style]').last();
    const bounds = await viewport.boundingBox();
    await image.getAttribute('style');
    await page.evaluate(() => window.__markPanListeners());
    const beforeListeners = await page.evaluate(() => window.__panListeners());
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    const start = async () => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 20, y + 15); };
    const checkStopped = async label => {
      const end = await image.getAttribute('style');
      await page.mouse.move(x + 70, y + 45); await page.waitForTimeout(50);
      assert.equal(await image.getAttribute('style'), end, `${route}: ${label} keeps image still`);
      assert.deepEqual(await page.evaluate(() => window.__panListeners()), beforeListeners, `${route}: ${label} removes listeners`);
    };
    await start(); await page.mouse.up(); await checkStopped('pointerup');
    await start();
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__lastPointerId })));
    await page.mouse.up(); await checkStopped('pointercancel');
    await start();
    await viewport.evaluate(element => element.releasePointerCapture(window.__lastPointerId));
    await page.mouse.up(); await checkStopped('lostpointercapture');
    await start(); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up(); await checkStopped('blur');

    const cdp = await context.newCDPSession(page);
    const beforeTouch = await image.getAttribute('style');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 30, y: y + 25 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.notEqual(await image.getAttribute('style'), beforeTouch, `${route}: touch pan moves the page`);
    await checkStopped('touchend');
    await cdp.detach();

    await start();
    if (route === '/reorder') await page.keyboard.press('Escape');
    else await page.locator('a[href="/"]').first().evaluate(element => element.click());
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.__panListeners()), beforeListeners, `${route}: unmount removes listeners`);
    await page.mouse.up();
    assert.deepEqual(errors, [], `${route}: gestures cause no browser exceptions`);
    pass(`${route}: pan release, cancellation, blur, touch and unmount`, {});
    await context.close();
  }

  if (phases.has('workers')) {
    const { context, page } = await setup();
    await page.goto(base + '/split');
    for (let iteration = 0; iteration < 3; iteration++) {
      await page.locator('input[type=file]').setInputFiles(fixture);
      await page.locator('main img').first().waitFor();
      await page.getByRole('button', { name: 'Change', exact: true }).click();
      await page.locator('input[type=file]').waitFor({ state: 'attached' });
      await expectNoPdfWorkers(page);
    }
    const result = await page.evaluate(async bytes => {
      const { getPdfPagePreviews, loadPDFDocument } = await import('/services/pdfBrowser.ts');
      const file = new File([Uint8Array.from(bytes)], 'shared.pdf', { type: 'application/pdf' });
      const shared = await loadPDFDocument(file);
      const successful = await getPdfPagePreviews(file, { limit: 2 });
      successful.forEach(url => URL.revokeObjectURL(url));
      const sharedPageStillUsable = (await shared.getPage(1)).pageNumber === 1;
      const created = [], revoked = [];
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
      URL.createObjectURL = blob => { const url = create(blob); created.push(url); return url; };
      URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
      let aborted = false, lastPageAborted = false;
      try {
        const controller = new AbortController();
        try { await getPdfPagePreviews(file, { signal: controller.signal, onProgress: progress => { if (progress.completed === 1) controller.abort(); } }); }
        catch (error) { aborted = error.name === 'AbortError'; }
        const lastPageController = new AbortController();
        try { await getPdfPagePreviews(file, { limit: 1, signal: lastPageController.signal, onProgress: progress => { if (progress.completed === 1) lastPageController.abort(); } }); }
        catch (error) { lastPageAborted = error.name === 'AbortError'; }
      } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
      const sharedAfterAbort = (await shared.getPage(2)).pageNumber === 2;
      await shared.destroy();
      return { sharedPageStillUsable, sharedAfterAbort, aborted, lastPageAborted, created: created.length, revoked: revoked.length };
    }, bytes);
    assert.deepEqual(result, { sharedPageStillUsable: true, sharedAfterAbort: true, aborted: true, lastPageAborted: true, created: 2, revoked: 2 });
    await expectNoPdfWorkers(page);
    pass('Preview batches release workers and preserve separate shared consumers', result);
    await context.close();
  }

  if (phases.has('compression')) {
    const { context, page } = await setup();
    await page.goto(base);
    const rows = await page.evaluate(async bytes => {
      const api = await import('/services/pdfBrowser.ts');
      const file = new File([Uint8Array.from(bytes)], 'dpi.pdf', { type: 'application/pdf' });
      const rows = [];
      for (const value of [0, 32, 100]) {
        const config = api.getInterpolatedConfig(value, false);
        const preview = await api.generatePreviewPair(file, config);
        const image = new Image(); image.src = preview.compressed; await image.decode();
        const measurement = await api.measureCompressedSize(file, config, { maxSamples: 1 });
        const exported = await api.compressPDFAdaptive(file, 'recommended', () => {}, false, config, true);
        rows.push({ value, scale: config.scale, dimensions: [image.naturalWidth, image.naturalHeight], jpeg: preview.compressed.split(',')[1], measured: measurement.bytesPerPage, bytes: [...exported.data] });
      }
      // Same JPEG quality must not reuse a sample encoded at a different raster scale.
      const low = { scale: 0.5, quality: 0.8, projectedDPI: 72 }, high = { ...low, scale: 1, projectedDPI: 144 };
      const samples = [await api.measureCompressedSize(file, low, { maxSamples: 1 }), await api.measureCompressedSize(file, high, { maxSamples: 1 })];
      await (await api.loadPDFDocument(file)).destroy();
      return { rows, samples: samples.map(sample => sample.bytesPerPage) };
    }, bytes);
    for (const row of rows.rows) {
      const document = await PDFDocument.load(Uint8Array.from(row.bytes));
      const images = document.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')).map(([, object]) => object);
      assert(images.length > 0);
      const first = images[0];
      const dimensions = [first.dict.get(PDFName.of('Width')).asNumber(), first.dict.get(PDFName.of('Height')).asNumber()];
      assert.deepEqual(row.dimensions, dimensions, 'Preview/export raster dimensions match');
      assert.equal(dimensions[0], Math.floor(144 * row.scale * 1.5), 'Established export resolution is preserved');
      const jpeg = Buffer.from(row.jpeg, 'base64');
      assert.deepEqual(Buffer.from(first.getContents()), jpeg, 'Preview JPEG bytes equal the first exported page');
      assert.equal(row.measured, jpeg.length, 'Size estimate samples the same encoder');
      delete row.bytes; delete row.jpeg; row.exportDimensions = dimensions;
    }
    assert.notEqual(rows.samples[0], rows.samples[1], 'Measurement cache keys include raster scale');
    pass('Compression preview, export and size sample use one raster encoder', rows);
    await context.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
