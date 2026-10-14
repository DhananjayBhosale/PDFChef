import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, devices } from 'playwright';
import { PDFDocument, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import JSZip from 'jszip';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const output = process.env.PDF_CHEF_RANGE_OUTPUT || 'output/playwright/page-range-selection';
await mkdir(output, { recursive: true });
const results = [];
const requestedDevices = new Set((process.env.PDF_CHEF_RANGE_DEVICES || 'desktop,android,iphone').split(','));
const phases = new Set((process.env.PDF_CHEF_RANGE_PHASES || 'devices,interaction,preview,locales').split(','));
const source = await PDFDocument.create();
const font = await source.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 300; n += 1) {
  const page = source.addPage([300, 420]);
  page.drawText(`Source page ${n}`, { x: 24, y: 376, size: 15, font });
  if ([1, 187, 230].includes(n)) {
    const field = source.getForm().createTextField(`Field${n}`);
    field.setText(`Answer ${n}`);
    field.addToPage(page, { x: 24, y: 300, width: 180, height: 24, font });
  }
}
const fixture = { name: 'numbered-300.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()) };
const short = await PDFDocument.create();
(await short.copyPages(source, [0, 1, 2, 3])).forEach(page => short.addPage(page));
const shortFixture = { name: 'numbered-4.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await short.save()) };
const rangePages = Array.from({ length: 44 }, (_, i) => i + 187);

async function inspectPdf(bytes, expectedPages) {
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), expectedPages.length);
  for (const [i, number] of expectedPages.entries()) {
    const content = (pdf.getPage(i).node.Contents()?.asArray() ?? []).map(ref => {
      const stream = pdf.context.lookup(ref);
      return new TextDecoder().decode(decodePDFRawStream(stream).decode());
    }).join('\n');
    assert(content.includes(Buffer.from(`Source page ${number}`).toString('hex').toUpperCase()), `Output position ${i + 1} must contain source page ${number}`);
  }
  return pdf;
}

async function setup(browser, options = {}, locale = 'en-US') {
  const context = await browser.newContext({ ...options, acceptDownloads: true, serviceWorkers: 'block' });
  // Keep optional analytics/advertising requests out of the functional checks.
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(locale => {
    localStorage.setItem('pdfchef.locale.v1', locale);
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: false, onboardingComplete: true, confirmLargeJobs: false,
    }));
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
    delete window.showSaveFilePicker;
  }, locale);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { context, page };
}

const selector = page => page.locator('[data-page-range-selector]');
const field = page => selector(page).locator('input');
const selectedCount = page => page.locator('main [aria-pressed="true"]').count();
const onePdf = page => page.getByRole('button', { name: /^Extract \d+ pages? as one PDF$/ });
const primary = (page, tool) => page.getByRole('button', { name: tool === 'split' ? 'Save the split files' : /^Export \d+ selected pages?$/ });

async function open(page, tool, input = fixture) {
  await page.goto(`${origin}/${tool}`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file]').first().setInputFiles(input);
  await field(page).waitFor();
}
async function apply(page, value = '187-230', enter = false) {
  await field(page).fill(value);
  if (enter) await field(page).press('Enter');
  else await selector(page).getByRole('button').click();
  assert.equal(await selector(page).getByRole('alert').count(), 0);
  assert.equal(await field(page).evaluate(element => element === document.activeElement), false, 'Apply closes input focus');
}
async function download(page, action) {
  await action.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  for (const name of ['Rename', 'Save', 'Share', 'Download', 'Tools']) {
    assert.equal(await dialog.getByRole('button', { name, exact: true }).count(), 1, `${name} must remain in output menu`);
  }
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const result = await pending;
  const chunks = [];
  for await (const chunk of await result.createReadStream()) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  return { bytes, name: result.suggestedFilename() };
}
async function layout(page) {
  const value = await selector(page).evaluate(element => {
    const input = element.querySelector('input');
    const button = element.querySelector('button');
    return {
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      fontSize: parseFloat(getComputedStyle(input).fontSize),
      boxes: [input, button].map(control => {
        const box = control.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, height: box.height };
      }),
    };
  });
  assert(value.scrollWidth <= value.width + 1, 'No horizontal overflow');
  assert(value.fontSize >= 16, 'Mobile input avoids automatic focus zoom');
  for (const box of value.boxes) {
    assert(box.height >= 44 && box.width >= 44, 'Comfortable touch targets');
    assert(box.left >= -1 && box.right <= value.width + 1, 'Range controls fit the screen');
  }
}

const browsers = [];
let regressionBrowser;
try {
  for (const [engine, device, name] of [[chromium, null, 'desktop'], [chromium, 'Pixel 7', 'android'], [webkit, 'iPhone 13', 'iphone']]) {
    if (!phases.has('devices') || !requestedDevices.has(name)) continue;
    const browser = await engine.launch({ headless: true });
    browsers.push(browser);
    if (engine === chromium) regressionBrowser = browser;
    for (const tool of ['split', 'extract']) {
      const { context, page } = await setup(browser, device ? devices[device] : { viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await open(page, tool);
      assert.equal(await field(page).inputValue(), '', 'Range starts empty');
      if (tool === 'split') assert.equal(await page.getByLabel('Pages per output PDF').inputValue(), '1');
      else assert.equal(await primary(page, tool).isDisabled(), true);
      await apply(page, '187-230', name === 'iphone');
      await page.locator('main [aria-pressed]').first().waitFor();
      assert.equal(await selectedCount(page), 44);
      await layout(page);
      const action = tool === 'split' ? onePdf(page) : primary(page, tool);
      assert.equal(await action.isEnabled(), true);
      const actionBox = await action.boundingBox();
      const gridBox = await page.locator('main [aria-pressed]').first().boundingBox();
      assert(actionBox.y < gridBox.y, 'One-PDF export is before the grid');
      await page.screenshot({ path: `${output}/${name}-${tool}.png` });
      const liveRegion = await selector(page).getByRole('status').elementHandle();
      await field(page).fill('1-5');
      await selector(page).getByRole('status').waitFor();
      assert.equal(await liveRegion.evaluate(element => element.isConnected && element.textContent.includes('Tap Select')), true, 'Pending announcement updates an existing live region');
      assert.equal(await primary(page, tool).isDisabled(), true, 'Unapplied input blocks primary export');
      if (tool === 'split') assert.equal(await onePdf(page).isDisabled(), true, 'One-PDF action remains visible but disabled');
      await field(page).fill('');
      assert.equal(await action.isEnabled(), true, 'Clearing a draft restores the applied selection');
      const result = await download(page, action);
      assert(result.name.endsWith('.pdf'));
      const pdf = await inspectPdf(result.bytes, rangePages);
      assert.deepEqual(pdf.getForm().getFields().map(f => f.getName()).sort(), ['Field187', 'Field230']);
      await writeFile(`${output}/${name}-${tool}-187-230.pdf`, result.bytes);
      assert.deepEqual(errors, [], 'No unexpected browser errors');
      results.push(`${name} ${tool}: 44-page output content/order/forms, pending guard, touch layout, final menu`);
      console.log(`PASS ${results.at(-1)}`);
      await context.close();
    }
  }

  const browser = regressionBrowser || await chromium.launch({ headless: true });
  if (!regressionBrowser) browsers.push(browser);
  for (const tool of phases.has('interaction') ? ['split', 'extract'] : []) {
    const { context, page } = await setup(browser, { viewport: { width: 320, height: 740 } });
    await open(page, tool);
    await apply(page);
    await page.locator('main [aria-pressed]').first().waitFor();
    await field(page).fill('1-2');
    await field(page).dispatchEvent('compositionstart');
    await field(page).press('Enter');
    assert.equal(await selectedCount(page), 44, 'IME composition must not apply an unfinished range');
    await field(page).dispatchEvent('compositionend');
    await field(page).press('Enter');
    assert.equal(await selectedCount(page), 2);
    await apply(page);
    for (const invalid of ['230-187', '0', '301', 'abc']) {
      await field(page).fill(invalid);
      await selector(page).getByRole('button').click();
      await selector(page).getByRole('alert').waitFor();
      assert.equal(await field(page).getAttribute('aria-invalid'), 'true');
      assert.equal(await selectedCount(page), 44, 'Invalid range does not mutate the selection');
      assert.equal(await primary(page, tool).isDisabled(), true);
    }
    await apply(page);
    await page.getByRole('button', { name: /^Page 187,/ }).click();
    assert.equal(await selectedCount(page), 43);
    assert.equal(await field(page).inputValue(), '', 'Manual selection clears the applied range text');
    await field(page).fill('1-3');
    await page.getByRole('button', { name: tool === 'split' ? 'Use all pages' : 'Clear', exact: true }).click();
    assert.equal(await field(page).inputValue(), '');
    assert.equal(await selectedCount(page), tool === 'split' ? 300 : 0);
    if (tool === 'split') assert.equal(await primary(page, tool).isEnabled(), true);
    await apply(page, '1-300');
    assert.equal(await onePdf(page).count(), 0, 'Split does not offer an unnecessary copy of all pages');
    await apply(page, '1,5,10-20');
    assert.equal(await selectedCount(page), 13);
    await layout(page);
    await page.screenshot({ path: `${output}/narrow-${tool}.png` });
    if (tool === 'split') {
      await page.getByLabel('Pages per output PDF').fill('2');
      const result = await download(page, primary(page, tool));
      const zip = await JSZip.loadAsync(result.bytes);
      const files = Object.values(zip.files).filter(f => !f.dir);
      assert.equal(files.length, 7, 'Existing pages-per-file split remains available');
      const order = [1, 5, ...Array.from({ length: 11 }, (_, i) => i + 10)];
      for (const [i, file] of files.entries()) await inspectPdf(await file.async('uint8array'), order.slice(i * 2, i * 2 + 2));
      await page.getByRole('radio', { name: 'Max file size', exact: true }).click();
      assert.equal(await page.getByLabel('Maximum file size (MB)').inputValue(), '10');
      await inspectPdf((await download(page, primary(page, tool))).bytes, order);
      await page.getByRole('button', { name: 'Change', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Choose another PDF', exact: true }).click();
    }
    await page.locator('input[type=file]').first().setInputFiles(shortFixture);
    await field(page).waitFor();
    assert.equal(await field(page).inputValue(), '', 'Changing the PDF resets range state');
    if (tool === 'split') {
      await page.getByRole('radio', { name: 'Pages per file', exact: true }).click();
      await page.getByLabel('Pages per output PDF').fill('1');
      const zip = await JSZip.loadAsync((await download(page, primary(page, tool))).bytes);
      assert.equal(Object.values(zip.files).filter(f => !f.dir).length, 4, 'All-page split default still exports every page');
    }
    results.push(`${tool}: invalid input, manual/bulk/reset, full/mixed ranges, 320px, existing split modes`);
    console.log(`PASS ${results.at(-1)}`);
    await context.close();
  }

  for (const [tool, mode] of phases.has('preview') ? [['split', 'failure'], ['extract', 'delay'], ['extract', 'failure']] : []) {
    const { context, page } = await setup(browser, { viewport: { width: 390, height: 844 } });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let requests = 0;
    await context.route('**/*pdf.worker*', async route => {
      requests += 1;
      if (mode === 'delay') { await held; await route.continue(); }
      else await route.abort('failed');
    });
    try {
      await open(page, tool);
      if (mode === 'delay') await page.getByRole('progressbar').waitFor();
      else await page.getByText(tool === 'split' ? 'Page previews are unavailable' : /Page previews are unavailable\./).waitFor();
      assert(requests > 0, 'Real PDF.js worker request was delayed/failed');
      await apply(page);
      await inspectPdf((await download(page, tool === 'split' ? onePdf(page) : primary(page, tool))).bytes, rangePages);
      if (mode === 'delay') {
        release();
        await page.locator('main [aria-pressed]').first().waitFor();
        assert.equal(await selectedCount(page), 44, 'Late previews preserve the range');
      } else if (tool === 'split') {
        await page.getByRole('button', { name: /Retry previews/ }).click();
        await page.getByText('Page previews are unavailable', { exact: true }).waitFor();
        assert.equal(await field(page).inputValue(), '187-230', 'Retry keeps the applied range');
        assert.equal(await onePdf(page).isEnabled(), true);
      }
      results.push(`${tool}: actual range export during preview ${mode}; selection survives completion/retry`);
      console.log(`PASS ${results.at(-1)}`);
    } finally { release(); await context.close(); }
  }

  for (const [locale, notation] of phases.has('locales') ? [['de-DE', '187–230'], ['hi-IN', '१८७-२३०'], ['ar-SA', '١٨٧-٢٣٠'], ['ja-JP', '１８７－２３０']] : []) {
    const { context, page } = await setup(browser, { ...devices['Pixel 7'], viewport: { width: 320, height: 740 } }, locale);
    await open(page, 'split');
    await apply(page, notation);
    await page.locator('main [aria-pressed]').first().waitFor();
    assert.equal(await selectedCount(page), 44);
    await layout(page);
    assert.deepEqual(await selector(page).locator('bdi').allTextContents(), ['187-230', '1,5,10-20']);
    for (const example of await selector(page).locator('bdi').all()) {
      assert.deepEqual(await example.evaluate(element => ({ direction: getComputedStyle(element).direction, whitespace: getComputedStyle(element).whiteSpace })), { direction: 'ltr', whitespace: 'nowrap' });
    }
    await page.screenshot({ path: `${output}/${locale}-320px.png` });
    results.push(`${locale}: localized range, 320px layout${locale === 'ar-SA' ? ', RTL' : ''}`);
    console.log(`PASS ${results.at(-1)}`);
    await context.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ status: 'PASS', devices: [...requestedDevices], phases: [...phases], checks: results }, null, 2));
} finally {
  await Promise.all(browsers.map(browser => browser.close()));
}
