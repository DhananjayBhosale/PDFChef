import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import JSZip from 'jszip';

// These regressions use the current source modules exposed by the Vite dev server.
const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const outputDir = process.env.PDF_CHEF_CONVERSION_OUTPUT || 'output/conversion-form-integrity';
await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
await page.addInitScript(() => {
  delete window.showSaveFilePicker;
  localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
    autoDownload: true, keepLocalHistory: false, confirmLargeJobs: false, onboardingComplete: true,
  }));
});
const results = [];
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.2, `${message}: ${actual} vs ${expected}`);
try {
  const para = (text, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  const fixtures = [
    ['inline', '<w:p><w:r><w:t>ONE</w:t><w:br w:type="page"/><w:t>TWO</w:t></w:r></w:p>', 2],
    ['paragraph-before', para('ONE') + para('TWO', '<w:pageBreakBefore/>'), 2],
    ['section-next-page', para('ONE', '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>') + para('TWO'), 2],
    ['section-default', para('ONE', '<w:sectPr/>') + para('TWO'), 2],
    ['continuous', para('ONE', '<w:sectPr><w:type w:val="continuous"/></w:sectPr>') + para('TWO'), 1],
    ['disabled-before', para('ONE') + para('TWO', '<w:pageBreakBefore w:val="0"/>'), 1],
    ['before-first-paragraph', para('ONE', '<w:pageBreakBefore/>'), 1],
    ['combined-breaks', '<w:p><w:r><w:t>ONE</w:t><w:br w:type="page"/></w:r></w:p>' + para('TWO', '<w:pageBreakBefore/>'), 2],
  ];
  await page.goto(baseUrl);
  for (const [name, body, expectedPages] of fixtures) {
    const zip = new JSZip();
    zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
    const fixture = [...await zip.generateAsync({ type: 'uint8array' })];
    const bytes = await page.evaluate(async (fixture) => {
      const { convertDocxToPdf } = await import('/services/officeDocument.ts');
      return [...await convertDocxToPdf(new File([new Uint8Array(fixture)], 'breaks.docx'))];
    }, fixture);
    const pdf = await PDFDocument.load(new Uint8Array(bytes));
    assert.equal(pdf.getPageCount(), expectedPages, name);
    await fs.writeFile(path.join(outputDir, `${name}.pdf`), new Uint8Array(bytes));
    results.push({ name, pages: pdf.getPageCount() });
  }
  const pdf = await PDFDocument.create();
  pdf.addPage([595.28, 841.89]);
  const sample = { name: 'sample.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };

  await page.goto(`${baseUrl}/sign`);
  await page.locator('input[type=file]').setInputFiles(sample);
  await page.getByRole('button', { name: 'Add signature', exact: true }).click();
  await page.getByRole('radio', { name: 'Type', exact: true }).click();
  await page.getByLabel('Signature text', { exact: true }).fill('Dhananjay Bhosale');
  await page.getByRole('button', { name: 'Add Stamp', exact: true }).click();
  const stamp = page.getByRole('button', { name: 'Signature stamp. Drag to move, use arrow keys for precise movement.', exact: true });
  await stamp.waitFor();
  const geometry = () => stamp.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const page = element.parentElement.getBoundingClientRect();
    return { width: rect.width, height: rect.height, x: rect.x - page.x, y: rect.y - page.y, pageWidth: page.width, pageHeight: page.height };
  });
  const rotate = page.getByRole('button', { name: 'Rotate stamp 90°', exact: true });
  const initial = await geometry();
  for (let turns = 1; turns <= 4; turns += 1) {
    const previousStyle = await stamp.getAttribute('style');
    await rotate.click();
    await page.waitForFunction(({ previousStyle }) => document.querySelector('[aria-label="Signature stamp. Drag to move, use arrow keys for precise movement."]')?.getAttribute('style') !== previousStyle, { previousStyle });
    const current = await geometry();
    near(current.width, turns % 2 ? initial.height : initial.width, `turn${turns} width`);
    near(current.height, turns % 2 ? initial.width : initial.height, `turn${turns} height`);
    near(current.x + current.width / 2, initial.x + initial.width / 2, `turn${turns} centerX`);
    near(current.y + current.height / 2, initial.y + initial.height / 2, `turn${turns} centerY`);
  }
  await stamp.focus();
  for (let index = 0; index < 20; index += 1) {
    await stamp.press('Shift+ArrowRight');
    await stamp.press('Shift+ArrowDown');
  }
  const previousStyle = await stamp.getAttribute('style');
  await rotate.click();
  await page.waitForFunction(({ previousStyle }) => document.querySelector('[aria-label="Signature stamp. Drag to move, use arrow keys for precise movement."]')?.getAttribute('style') !== previousStyle, { previousStyle });
  const clamped = await geometry();
  assert.ok(clamped.x >= -0.1 && clamped.y >= -0.1);
  assert.ok(clamped.x + clamped.width <= clamped.pageWidth + 0.1);
  assert.ok(clamped.y + clamped.height <= clamped.pageHeight + 0.1);
  near(clamped.width, initial.height, 'edge rotation width');
  near(clamped.height, initial.width, 'edge rotation height');
  const signatureDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const signaturePath = path.join(outputDir, 'rotated-signature.pdf');
  await (await signatureDownload).saveAs(signaturePath);
  const signed = await PDFDocument.load(await fs.readFile(signaturePath));
  const contents = signed.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  const operators = streams.map(stream => new TextDecoder().decode(decodePDFRawStream(signed.context.lookup(stream)).decode())).join('\n');
  assert.ok(!/1 0 0 1 [\d.]+ -[\d.]+ cm/.test(operators), 'signature draw origin must stay on page');
  results.push({ name: 'signature-rotation', initial, clamped, operators });
  await page.screenshot({ path: path.join(outputDir, 'signature-rotation.png'), fullPage: true });

  await page.goto(`${baseUrl}/make-fillable`);
  await page.locator('input[type=file]').setInputFiles(sample);
  const preview = page.getByRole('img', { name: 'Page 1', exact: true });
  await preview.waitFor();
  const box = await preview.boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.37);
  await page.mouse.up();
  await page.locator('select').last().selectOption('dropdown');
  const create = page.getByRole('button', { name: 'Create fillable PDF', exact: true });
  assert.equal(await create.isDisabled(), true, 'changing to dropdown requires choices');
  const options = page.getByLabel('Options', { exact: true });
  await options.fill('Only choice');
  assert.equal(await create.isEnabled(), true, 'intentional single-choice field remains valid');
  await options.fill('First choice, First choice');
  assert.equal(await create.isDisabled(), true, 'duplicate choices rejected');
  await options.fill('First choice, , Last choice');
  assert.equal(await create.isDisabled(), true, 'blank choices rejected');
  await options.fill('First choice, Second choice');
  assert.equal(await create.isEnabled(), true);
  // Toggling type must not discard edited choices.
  await page.locator('select').last().selectOption('text');
  await page.locator('select').last().selectOption('dropdown');
  assert.equal(await options.inputValue(), 'First choice, Second choice');
  const formDownload = page.waitForEvent('download');
  await create.click();
  const formPath = path.join(outputDir, 'dropdown.pdf');
  await (await formDownload).saveAs(formPath);
  const form = (await PDFDocument.load(await fs.readFile(formPath))).getForm();
  assert.deepEqual(form.getDropdown('text_1').getOptions(), ['First choice', 'Second choice']);
  results.push({ name: 'placed-dropdown-choices', options: form.getDropdown('text_1').getOptions() });
  await page.screenshot({ path: path.join(outputDir, 'dropdown-options.png'), fullPage: true });
  await fs.writeFile(path.join(outputDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`PASS: ${fixtures.length} DOCX page-break cases, signature rotation/bounds/export, and placed-dropdown validation/export.`);
} finally {
  await browser.close();
}
