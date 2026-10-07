/** Run against a built preview: node scripts/verify-edit-pdf-text-placement.mjs */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const document = await PDFDocument.create();
const page = document.addPage([595, 842]);
const font = await document.embedFont(StandardFonts.Helvetica);
page.drawText('Existing PDF text', { x: 72, y: 700, size: 16, font });
document.getForm().createTextField('existing-field').addToPage(page, {
  x: 72, y: 645, width: 220, height: 24,
});
const fixture = Buffer.from(await document.save());

const browser = await chromium.launch({ headless: true });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: mobile, hasTouch: mobile,
    });
    const editor = await context.newPage();
    const errors = [];
    editor.on('pageerror', error => errors.push(error.message));
    await editor.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false,
      largeFileWarningMb: 80, onboardingComplete: true, interfaceFont: 'inter',
    })));
    await editor.goto(`${baseUrl}/edit`);
    await editor.locator('input[type=file][accept=".pdf"]').setInputFiles({
      name: 'placement.pdf', mimeType: 'application/pdf', buffer: fixture,
    });
    const paragraph = editor.getByTestId('pdf-text-block').first();
    const field = editor.getByTestId('pdf-form-field').first();
    await paragraph.waitFor({ timeout: 60_000 });
    await field.waitFor({ timeout: 60_000 });
    await editor.getByRole('button', { name: 'Text', exact: true }).click();
    await editor.getByTestId('pdf-placement-target').waitFor();
    await editor.keyboard.press('Escape');
    await editor.getByTestId('pdf-placement-target').waitFor({ state: 'detached' });
    assert.equal(await editor.getByTestId('editor-element').count(), 0);

    const placeOver = async (target) => {
      await editor.getByRole('button', { name: 'Text', exact: true }).click();
      const placement = editor.getByTestId('pdf-placement-target');
      await placement.waitFor();
      assert.equal(await editor.getByTestId('editor-element').count(), target === paragraph ? 0 : 1);
      await target.scrollIntoViewIfNeeded();
      const bounds = await target.boundingBox();
      assert.ok(bounds);
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      const pageBefore = await editor.locator('[data-pdf-page="0"]').boundingBox();
      assert.ok(pageBefore);
      if (mobile) await editor.touchscreen.tap(x, y);
      else await editor.mouse.click(x, y);
      await placement.waitFor({ state: 'detached' });
      const placed = await editor.getByTestId('editor-element').last().boundingBox();
      const pageBounds = await editor.locator('[data-pdf-page="0"]').boundingBox();
      assert.ok(placed && pageBounds);
      assert.ok(Math.abs((placed.x - pageBounds.x) - (x - pageBefore.x - pageBounds.width * 0.03)) < 5,
        'text box missed the tapped X position');
      assert.ok(Math.abs((placed.y - pageBounds.y) - (y - pageBefore.y - pageBounds.height * 0.025)) < 5,
        `text box missed the tapped Y position: ${JSON.stringify({ placedY: placed.y, pageY: pageBounds.y, tapY: y, originalPageY: pageBefore.y })}`);
    };

    await placeOver(paragraph);
    assert.equal(await editor.getByTestId('pdf-paragraph-inspector').count(), 0);
    await editor.getByTestId('inline-text-editor').fill('New text box');
    await placeOver(field);
    assert.equal(await editor.getByTestId('editor-element').count(), 2);
    await editor.getByTestId('inline-text-editor').fill('Text above field');
    assert.equal(await field.inputValue(), '', 'placing text changed the PDF form field');

    let resolveOutput;
    const output = new Promise(resolve => { resolveOutput = resolve; });
    await editor.exposeFunction('capturePlacementPdf', bytes => resolveOutput(Uint8Array.from(bytes)));
    await editor.evaluate(() => window.addEventListener('pdfchef:output-ready', event =>
      event.detail.blob.arrayBuffer().then(buffer => window.capturePlacementPdf([...new Uint8Array(buffer)]))
    ));
    await editor.getByRole('button', { name: /^Save/ }).first().click();
    let timeout;
    const bytes = await Promise.race([
      output,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Save timed out: ${errors.join('; ')}`)), 30_000); }),
    ]).finally(() => clearTimeout(timeout));
    const task = pdfjs.getDocument({ data: bytes });
    const saved = await task.promise;
    const text = (await (await saved.getPage(1)).getTextContent()).items.map(item => item.str).join(' ');
    assert.match(text, /Existing PDF text/);
    assert.match(text, /New text box/);
    assert.match(text, /Text above field/);
    await task.destroy();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`✓ ${mobile ? 'mobile' : 'desktop'} placement over PDF text and a form field`);
  }
} finally {
  await browser.close();
}
