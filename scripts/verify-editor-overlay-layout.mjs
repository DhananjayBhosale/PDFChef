import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { chromium } from 'playwright';

const output = process.env.PDF_CHEF_GEOMETRY_OUTPUT || 'output/editor-overlay-layout';
const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4195';
await mkdir(output, { recursive: true });
const source = await PDFDocument.create(); source.addPage([612, 792]);
const sourceBytes = await source.save();
const browser = await chromium.launch();
const results = [];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < .001, `${actual} != ${expected}`);
async function parse(bytes) {
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` });
  return { task, document: await task.promise };
}
try {
  if (process.env.PDF_CHEF_GEOMETRY_CASE !== 'unsupported') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ autoDownload: false, keepLocalHistory: false, onboardingComplete: true, confirmLargeJobs: false })));
  const page = await context.newPage();
  const captured = [];
  await page.exposeFunction('__captureLayoutOutput', bytes => captured.push(bytes));
  await page.addInitScript(() => window.addEventListener('pdfchef:output-ready', async event => window.__captureLayoutOutput([...new Uint8Array(await event.detail.blob.arrayBuffer())])));
  await page.goto(`${baseUrl}/edit`);
  await page.locator('input[type=file][accept=".pdf"]').setInputFiles({ name: 'blank.pdf', mimeType: 'application/pdf', buffer: Buffer.from(sourceBytes) });
  await page.locator('[data-pdf-page="0"] canvas').waitFor();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('[data-pdf-page="0"]').click({ position: { x: 100, y: 100 } });
  const editor = page.getByTestId('inline-text-editor');
  const content = 'This sentence should wrap inside the new text box and stay within its visible border when the edited PDF is saved.';
  await editor.fill(content);
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await page.getByText('This text box is too small. Enlarge it or shorten the text before saving.', { exact: true }).waitFor();
  assert.equal(captured.length, 0);
  assert.equal(await editor.inputValue(), content);
  assert.equal(await editor.evaluate(element => getComputedStyle(element).overflowY), 'auto');
  const resize = page.getByRole('button', { name: 'Resize selected element with arrow keys' });
  await resize.press('Shift+ArrowDown'); await resize.press('Shift+ArrowDown'); await resize.press('Shift+ArrowDown');
  await page.locator('[data-pdf-page="0"]').click({ position: { x: 400, y: 420 } });
  const preview = await page.getByTestId('text-box-preview').locator('text').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, x: +node.getAttribute('x'), baseline: +node.getAttribute('y'), width: +node.getAttribute('textLength') })));
  assert.ok(preview.length > 1);
  assert.equal(preview.map(line => line.text).join(' '), content);
  await page.screenshot({ path: `${output}/text-box-preview.png`, fullPage: true });
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await page.getByRole('heading', { name: 'Result ready', exact: true }).waitFor();
  assert.equal(captured.length, 1);
  await writeFile(`${output}/text-box-saved.pdf`, Uint8Array.from(captured[0]));
  const parsed = await parse(captured[0]);
  const items = (await (await parsed.document.getPage(1)).getTextContent()).items.filter(item => item.str);
  assert.deepEqual(items.map(item => item.str), preview.map(line => line.text));
  for (let index = 0; index < items.length; index++) {
    near(items[index].width, preview[index].width);
    near(Math.hypot(items[index].transform[0], items[index].transform[1]), 16);
    near(items[0].transform[5] - items[index].transform[5], preview[index].baseline - preview[0].baseline);
  }
  await parsed.task.destroy();
  results.push({ case: 'text box refuses overflow, stays editable, then enlarged preview and export have identical rows and 16pt size', lines: preview.length });

  // Library-level fixtures exercise page rotation, unusual CropBox and /UserUnit
  // independently of UI gestures. The resulting PDF is parsed and rendered below.
  const rotatedSource = await PDFDocument.create();
  for (const angle of [0, 90, 180, 270]) {
    const p = rotatedSource.addPage([600, 800]); p.setCropBox(-40, -20, 680, 870); p.setRotation(degrees(angle));
    p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  }
  const fixtureBytes = [...await rotatedSource.save()];
  const generated = await page.evaluate(async bytes => {
    const { savePDFWithAnnotations, cropPDFMargins } = await import('/services/pdfDocument.ts');
    const f = new File([Uint8Array.from(bytes)], 'rotated.pdf', { type: 'application/pdf' });
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 100, 100); ctx.fillStyle = 'blue'; ctx.fillRect(100, 0, 100, 100);
    const landscape = canvas.toDataURL();
    canvas.width = 90; canvas.height = 240; ctx.fillStyle = 'green'; ctx.fillRect(0, 0, 90, 240);
    const portrait = canvas.toDataURL();
    const elements = Array.from({ length: 4 }, (_, pageIndex) => [
      { id: `landscape${pageIndex}`, type: 'image', pageIndex, x: .1, y: .1, width: .3, height: .2, rotation: 30, content: landscape },
      { id: `portrait${pageIndex}`, type: 'image', pageIndex, x: .55, y: .1, width: .3, height: .2, rotation: -25, content: portrait },
      { id: `text${pageIndex}`, type: 'text', pageIndex, x: .2, y: .5, width: .4, height: .2, rotation: 30, content: 'Rotated text keeps its direction and size.', fontSize: 16 },
      { id: `rectangle${pageIndex}`, type: 'rectangle', pageIndex, x: .1, y: .78, width: .3, height: .08, rotation: 30, content: '', color: '#000000' },
      { id: `ellipse${pageIndex}`, type: 'ellipse', pageIndex, x: .55, y: .78, width: .3, height: .08, rotation: -25, content: '', color: '#000000' },
    ]).flat();
    const annotations = [...await savePDFWithAnnotations(f, elements)];
    const crop = [...await cropPDFMargins(f, { top: 10, right: 20, bottom: 5, left: 15 })];
    const unsupported = await savePDFWithAnnotations(f, [{ ...elements[2], content: '📄' }]).then(() => null, error => ({ name: error.name, key: error.translationKey }));
    return { annotations, crop, unsupported };
  }, fixtureBytes);
  assert.deepEqual(generated.unsupported, { name: 'PdfTextBoxError', key: 'error.pdfTextBoxUnsupported' });
  await writeFile(`${output}/rotated-overlays.pdf`, Uint8Array.from(generated.annotations));
  await writeFile(`${output}/cropped-visible-pages.pdf`, Uint8Array.from(generated.crop));
  const overlays = await parse(generated.annotations);
  for (let index = 0; index < 4; index++) {
    const p = await overlays.document.getPage(index + 1);
    const viewport = p.getViewport({ scale: 1 / p.userUnit });
    const operators = await p.getOperatorList();
    const images = []; const shapes = []; let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
    operators.fnArray.forEach((op, i) => {
      if (op === pdfjs.OPS.save) stack.push(ctm);
      if (op === pdfjs.OPS.restore) ctm = stack.pop();
      if (op === pdfjs.OPS.transform) ctm = pdfjs.Util.transform(ctm, operators.argsArray[i]);
      if (op === pdfjs.OPS.paintImageXObject) images.push(pdfjs.Util.transform(viewport.transform, ctm));
      if (op === pdfjs.OPS.constructPath) shapes.push(pdfjs.Util.transform(viewport.transform, ctm));
    });
    assert.equal(images.length, 2);
    assert.equal(shapes.length, 2);
    shapes.forEach((matrix, shapeIndex) => near(Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI, shapeIndex === 0 ? 30 : -25));
    for (let imageIndex = 0; imageIndex < 2; imageIndex++) {
      const matrix = images[imageIndex];
      const ratio = imageIndex === 0 ? 2 : 90 / 240;
      near(Math.hypot(matrix[0], matrix[1]) / Math.hypot(matrix[2], matrix[3]), ratio);
      near(Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI, imageIndex === 0 ? 30 : -25);
      near(matrix[4] + .5 * matrix[0] + .5 * matrix[2], viewport.width * (imageIndex === 0 ? .25 : .7));
      near(matrix[5] + .5 * matrix[1] + .5 * matrix[3], viewport.height * .2);
    }
    const textItems = (await p.getTextContent()).items.filter(item => item.str);
    for (const item of textItems) {
      const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
      near(Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI, 30);
      near(Math.hypot(matrix[0], matrix[1]), 16);
    }
  }
  await overlays.task.destroy();
  const cropped = await PDFDocument.load(Uint8Array.from(generated.crop));
  const boxes = cropped.getPages().map(p => p.getCropBox());
  assert.deepEqual(boxes, [
    { x: 90, y: 40, width: 390, height: 680 },
    { x: 60, y: 120, width: 510, height: 520 },
    { x: 120, y: 80, width: 390, height: 680 },
    { x: 30, y: 160, width: 510, height: 520 },
  ]);
  results.push({ case: 'landscape/portrait aspect fit, centering, text/image/shape rotation direction and 16pt text on all quarter-turn pages with UserUnit2 and oversize CropBox', pages: 4 });
  results.push({ case: 'crop percentages trim actual visible MediaBox intersection on all page rotations', boxes });
  await context.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await mobile.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ autoDownload: false, keepLocalHistory: false, onboardingComplete: true, confirmLargeJobs: false })));
  const phone = await mobile.newPage();
  await phone.goto(`${baseUrl}/edit`);
  await phone.locator('input[type=file][accept=".pdf"]').setInputFiles({ name: 'large-units.pdf', mimeType: 'application/pdf', buffer: Buffer.from(fixtureBytes) });
  await phone.locator('[data-pdf-page="0"] canvas').waitFor();
  await phone.getByRole('button', { name: 'Text', exact: true }).click();
  await phone.locator('[data-pdf-page="0"]').click({ position: { x: 80, y: 80 } });
  await phone.getByTestId('inline-text-editor').fill('Mobile note');
  assert.equal(await phone.getByTestId('inline-text-editor').evaluate(node => getComputedStyle(node).fontSize), '32px');
  await phone.locator('[data-pdf-page="0"]').click({ position: { x: 220, y: 240 } });
  const mobilePreview = phone.getByTestId('text-box-preview');
  const viewBox = (await mobilePreview.getAttribute('viewBox')).split(' ').map(Number);
  near(viewBox[2], 600 * .28); near(viewBox[3], 800 * .07);
  assert.equal(await mobilePreview.locator('text').textContent(), 'Mobile note');
  assert.equal(await mobilePreview.locator('text').getAttribute('font-size'), '16');
  await phone.screenshot({ path: `${output}/mobile-userunit-preview.png`, fullPage: true });
  results.push({ case: '390px touch editor preserves PDF font size and wrapping units for UserUnit2', viewBox });
  await mobile.close();
  }

  const fallbackContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await fallbackContext.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ autoDownload: false, keepLocalHistory: false, onboardingComplete: true, confirmLargeJobs: false })));
  const fallbackPage = await fallbackContext.newPage();
  let fallbackOutputs = 0;
  await fallbackPage.exposeFunction('__countFallbackOutput', () => { fallbackOutputs++; });
  await fallbackPage.addInitScript(() => window.addEventListener('pdfchef:output-ready', () => window.__countFallbackOutput()));
  await fallbackPage.goto(`${baseUrl}/edit`);
  await fallbackPage.locator('input[type=file][accept=".pdf"]').setInputFiles({ name: 'fallback.pdf', mimeType: 'application/pdf', buffer: Buffer.from(sourceBytes) });
  await fallbackPage.locator('[data-pdf-page="0"] canvas').waitFor();
  await fallbackPage.getByRole('button', { name: 'Text', exact: true }).click();
  await fallbackPage.locator('[data-pdf-page="0"]').click({ position: { x: 80, y: 80 } });
  const unsupportedText = 'Keep this note 📄';
  await fallbackPage.getByTestId('inline-text-editor').fill(unsupportedText);
  await fallbackPage.locator('[data-pdf-page="0"]').click({ position: { x: 220, y: 240 } });
  const fallbackPreview = fallbackPage.getByTestId('text-box-preview');
  assert.equal(await fallbackPreview.innerText(), unsupportedText);
  assert.equal(await fallbackPreview.getAttribute('aria-label'), unsupportedText);
  await fallbackPage.screenshot({ path: `${output}/unsupported-visible-preview.png`, fullPage: true });
  await fallbackPage.getByRole('button', { name: /^Save/ }).first().click();
  await fallbackPage.getByText('This text box contains characters its font cannot save. Remove those characters before saving.', { exact: true }).waitFor();
  assert.equal(fallbackOutputs, 0);
  assert.equal(await fallbackPage.getByTestId('inline-text-editor').inputValue(), unsupportedText);
  results.push({ case: 'unsupported added text stays visible when deselected; Save refuses without export or losing editable text', text: unsupportedText });
  await fallbackContext.close();
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
