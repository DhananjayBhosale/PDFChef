import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, devices } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4191';
const output = process.env.PDF_CHEF_PREVIEW_OUTPUT || 'output/pdf-preview-progress';
await mkdir(output, { recursive: true });
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 48; n++) pdf.addPage([300, 420]).drawText(`Preview control page ${n}`, { x: 24, y: 370, size: 16, font });
const fixture = { name: 'previews-48.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };
const results = [];
const phases = new Set((process.env.PDF_CHEF_PREVIEW_CASES || 'tools,failure,locales,api,iphone').split(','));
const browser = await chromium.launch();
const engines = [browser];
const contexts = [];
async function setup(options = {}, locale = 'en-US', engine = browser) {
  const context = await engine.newContext({ viewport: { width: 390, height: 844 }, ...options, serviceWorkers: 'block' });
  contexts.push(context);
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(locale => {
    localStorage.setItem('pdfchef.locale.v1', locale);
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true, keepLocalHistory: false, autoDownload: false, confirmLargeJobs: false }));
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
  }, locale);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on('dialog', dialog => dialog.accept());
  return { context, page };
}
async function open(page, route, file = fixture) {
  await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file]').first().setInputFiles(file);
}
async function holdWorker(context) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route(/pdf\.worker[^?]*(?:\?v=[^&]+)?$/i, async route => { await gate; await route.continue().catch(() => {}); });
  return release;
}
async function opening(page) {
  const progress = page.getByRole('progressbar');
  await progress.waitFor();
  assert.equal(await progress.getAttribute('value'), null, 'Opening must not invent a percentage');
  assert(await progress.getAttribute('aria-labelledby'), 'Progress is labeled');
}
async function completed(page, route, count = 48) {
  const previews = route === '/reorder' ? page.locator('main [role=list] img') : page.locator('main img');
  await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count, { selector: route === '/reorder' ? 'main [role=list] img' : 'main img', count }, { timeout: 120_000 });
  assert.equal(await previews.count(), count);
  assert.equal(await page.locator('[data-pdf-loading-progress]').count(), 0, 'Finished work hides the loading card');
}
async function layout(page) {
  const values = await page.locator('[data-pdf-loading-progress]').first().evaluate(element => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
  }));
  assert(values.scroll <= values.width + 1 && values.left >= -1 && values.right <= values.width + 1, 'Progress fits narrow screens');
}
function pass(message) { results.push(message); console.log(`PASS ${message}`); }

try {
  if (process.env.PDF_CHEF_HEAVY_PDF_PATH) {
    const { page } = await setup();
    const started = Date.now();
    await open(page, '/split', process.env.PDF_CHEF_HEAVY_PDF_PATH);
    await page.waitForFunction(() => {
      const bar = document.querySelector('[data-pdf-loading-progress] progress');
      return bar?.hasAttribute('value') && bar.value > 0 && bar.value < 100;
    });
    const snapshot = await page.getByRole('progressbar').evaluate(element => ({ value: element.value, text: element.getAttribute('aria-valuetext') }));
    const numbers = snapshot.text.match(/\d+/g).map(Number);
    assert.equal(numbers[1], 35);
    assert(Math.abs(snapshot.value - numbers[0] / numbers[1] * 100) < 0.001);
    await page.locator('[data-pdf-loading-progress]').scrollIntoViewIfNeeded();
    await layout(page);
    await page.screenshot({ path: `${output}/oneplus-mobile-progress.png` });
    await completed(page, '/split', 35);
    pass(`OnePlus 40 MB PDF: real ${snapshot.text}, accurate percentage, all 35 previews, ${Date.now() - started} ms`);
  }

  if (phases.has('tools')) for (const route of ['/split', '/delete-pages', '/rotate', '/reorder', '/make-fillable']) {
    const { context, page } = await setup();
    const release = await holdWorker(context);
    await open(page, route);
    await opening(page);
    await layout(page);
    release();
    if (route === '/make-fillable') {
      await page.locator('main img').first().waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-pdf-loading-progress]'));
    } else await completed(page, route);
    pass(`${route}: honest opening state, complete previews, mobile layout`);
    await context.close();
  }

  // A failed worker is a terminal error, not an endless progress animation.
  if (phases.has('failure')) {
    const { context, page } = await setup();
    await context.route(/pdf\.worker/i, route => new URL(route.request().url()).searchParams.has('url') ? route.continue() : route.abort());
    await open(page, '/split');
    await page.getByText('Page previews are unavailable', { exact: true }).waitFor();
    assert.equal(await page.getByRole('progressbar').count(), 0);
    await page.locator('[data-page-range-selector] input').fill('1-3');
    await page.locator('[data-page-range-selector] button').click();
    assert.equal(await page.getByRole('button', { name: 'Extract 3 pages as one PDF' }).isEnabled(), true);
    pass('Preview failure stops progress and preserves page-range export');
    await context.close();
  }

  // The shared modal must stop loading on a document-opening failure, too.
  if (phases.has('failure')) {
    const { context, page } = await setup();
    await open(page, '/reorder');
    await completed(page, '/reorder');
    await context.route(/pdf\.worker/i, route => new URL(route.request().url()).searchParams.has('url') ? route.continue() : route.abort());
    await page.getByRole('button', { name: /Preview page 1$/ }).click();
    await page.getByRole('dialog').getByText('Failed to load PDF.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').getByRole('progressbar').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    pass('Preview dialog opening failure displays the error and remains closable');
    await context.close();
  }

  if (phases.has('locales')) for (const locale of ['de-DE', 'hi-IN', 'ar-SA', 'ja-JP']) {
    const { context, page } = await setup({ viewport: { width: 320, height: 780 }, reducedMotion: 'reduce' }, locale);
    const release = await holdWorker(context);
    await open(page, '/split');
    await opening(page);
    await layout(page);
    const motion = await page.locator('.chef-preview-paper, .chef-preview-fill').evaluateAll(elements => elements.map(element => ({ animation: getComputedStyle(element).animationName, transition: getComputedStyle(element).transitionDuration })));
    assert(motion.every(style => style.animation === 'none' && style.transition === '0s'));
    await page.locator('[data-pdf-loading-progress]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${locale}-320px.png` });
    release();
    await completed(page, '/split');
    pass(`${locale}: 320px layout, reduced motion, localized loading`);
    await context.close();
  }

  // A real browser PDF.js render exercises completed counts and partial-URL cleanup.
  if (phases.has('api') && new URL(origin).hostname === '127.0.0.1' && process.env.PDF_CHEF_PREVIEW_API_TESTS !== 'false') {
    const { context, page } = await setup();
    await page.goto(origin + '/split', { waitUntil: 'domcontentloaded' });
    const outcome = await page.evaluate(async base64 => {
      const { getPdfPagePreviews } = await import('/services/pdfBrowser.ts');
      const file = new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], 'contract.pdf', { type: 'application/pdf' });
      const created = [], revoked = [], progress = [];
      const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
      const originalToBlob = HTMLCanvasElement.prototype.toBlob;
      URL.createObjectURL = blob => { const url = originalCreate(blob); created.push(url); return url; };
      URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
      let aborted = false, failed = false;
      try {
        const controller = new AbortController();
        try {
          await getPdfPagePreviews(file, { limit: 4, signal: controller.signal, onProgress: value => { progress.push(value); if (value.completed === 2) controller.abort(); } });
        } catch (error) { aborted = error.name === 'AbortError'; }
        const abortCreated = [...created], abortRevoked = [...revoked];
        let encodedPages = 0;
        HTMLCanvasElement.prototype.toBlob = function (...args) {
          if (++encodedPages === 2) throw new Error('controlled page failure');
          return originalToBlob.apply(this, args);
        };
        created.length = revoked.length = 0;
        try { await getPdfPagePreviews(file, { limit: 3 }); } catch (error) { failed = error.message === 'controlled page failure'; }
        return { aborted, failed, progress, abortCreated, abortRevoked, failureCreated: created, failureRevoked: revoked };
      } finally {
        URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
        HTMLCanvasElement.prototype.toBlob = originalToBlob;
      }
    }, fixture.buffer.toString('base64'));
    assert.equal(outcome.aborted, true);
    assert.deepEqual(outcome.progress, [0, 1, 2].map(completed => ({ completed, total: 4 })));
    assert.deepEqual(outcome.abortRevoked, outcome.abortCreated);
    assert.equal(outcome.abortCreated.length, 2);
    assert.equal(outcome.failed, true);
    assert.deepEqual(outcome.failureRevoked, outcome.failureCreated);
    assert.equal(outcome.failureCreated.length, 1);
    pass('Real preview API: bounded counts, cancellation and failure revoke every partial URL');
    await context.close();
  }

  if (phases.has('iphone')) {
    const iphone = await webkit.launch(); engines.push(iphone);
    const { context, page } = await setup(devices['iPhone 13'], 'en-US', iphone);
    const release = await holdWorker(context);
    await open(page, '/extract');
    await opening(page);
    await layout(page);
    await page.screenshot({ path: `${output}/iphone-opening.png` });
    release();
    await page.locator('main img').first().waitFor();
    assert.equal(await page.locator('main [aria-pressed]').count(), 48);
    await page.locator('[data-page-range-selector] input').fill('1-3');
    await page.locator('[data-page-range-selector] button').click();
    assert.equal(await page.getByRole('button', { name: 'Export 3 selected pages' }).isEnabled(), true);
    pass('iPhone WebKit Extract: opening feedback, lazy previews, page selection remains usable');
    await context.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ status: 'PASS', results }, null, 2));
} finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  await Promise.allSettled(engines.map(engine => engine.close()));
}
