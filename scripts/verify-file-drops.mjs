import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PDFDocument, PDFName } from 'pdf-lib';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3015';
const pdf = await PDFDocument.create();
pdf.addPage([600, 800]).drawText('Page-wide drop regression', { x: 60, y: 700 });
const pdfBytes = Buffer.from(await pdf.save());
const fixture = { name: 'drop-document.pdf', type: 'application/pdf', base64: pdfBytes.toString('base64') };
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true, keepLocalHistory: false, autoDownload: false })));
  const go = async (path) => {
    await page.goto(origin + path);
    await page.locator('h1').first().waitFor();
  };
  const drop = async (files, selector = 'h1') => {
    const result = await page.locator(selector).first().evaluate((target, inputs) => {
      const transfer = new DataTransfer();
      for (const input of inputs) {
        const bytes = Uint8Array.from(atob(input.base64), char => char.charCodeAt(0));
        transfer.items.add(new File([bytes], input.name, { type: input.type }));
      }
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(over);
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(event);
      return { over: over.defaultPrevented, drop: event.defaultPrevented };
    }, files);
    assert.deepEqual(result, { over: true, drop: true }, 'External file navigation must be prevented');
  };
  await go('/');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 80;
    const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 240, 80);
    context.fillStyle = 'black'; context.font = 'italic 32px serif'; context.fillText('Signature', 12, 48);
    return { name: 'signature.PNG', type: '', base64: canvas.toDataURL('image/png').split(',')[1] };
  });
  await drop([{ ...fixture, type: '' }]);
  await page.waitForURL('**/view');
  await page.getByText('drop-document.pdf', { exact: true }).first().waitFor();
  console.log('PASS: home-page PDF drop outside the upload box opens the reader, including missing MIME.');

  await go('/merge');
  await page.locator('[data-file-upload]').waitFor();
  await drop([fixture, { ...fixture, name: 'second.pdf' }]);
  await page.getByText('second.pdf', { exact: true }).waitFor();
  assert.equal(await page.getByText('drop-document.pdf', { exact: true }).count(), 1);
  assert.match(page.url(), /\/merge$/);
  console.log('PASS: multi-file page drop stays in Merge and imports each PDF once.');

  await go('/compare');
  await page.locator('[data-file-upload]').nth(1).waitFor();
  await drop([{ ...fixture, name: 'document-b.pdf' }], 'section:has(h2:text-is("Document B")) [data-file-upload]');
  await page.getByText('document-b.pdf', { exact: true }).first().waitFor();
  await drop([{ ...fixture, name: 'document-a.pdf' }], 'section:has(h2:text-is("Document A")) [data-file-upload]');
  await page.getByText('document-a.pdf', { exact: true }).first().waitFor();
  console.log('PASS: targeted drops preserve the separate Compare upload slots.');

  await go('/sign');
  await page.locator('[data-file-upload]').waitFor();
  await drop([image], '[data-file-upload]');
  await page.getByAltText('Pending signature stamp 1').waitFor();
  await drop([fixture]);
  await page.getByText('Stamp 1', { exact: true }).waitFor();
  await drop([image], '[data-testid="pdf-zoom-viewport"]');
  await page.getByText('Stamp 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add signature', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await drop([image], '[role=dialog]');
  await page.getByText('Stamp 3', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.match(page.url(), /\/sign$/);
  console.log('PASS: images dropped before a PDF, on the document, or in the signature dialog become stamps.');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const output = page.locator('aside').filter({ hasText: 'Result ready' });
  await output.getByText('Result ready').waitFor();
  const downloading = page.waitForEvent('download');
  await output.getByRole('button', { name: 'Save', exact: true }).click();
  const result = await PDFDocument.load(await readFile(await (await downloading).path()));
  assert.equal(result.getPageCount(), 1);
  const objects = result.getPages()[0].node.Resources().lookup(PDFName.of('XObject'));
  assert(objects && objects.keys().length >= 3, 'All dropped stamps must reach PDF export');
  console.log('PASS: exported PDF contains all three signature image objects.');

  await go('/sign');
  await page.locator('[data-file-upload]').waitFor();
  await drop([fixture, image], '[data-file-upload]');
  await page.getByText('Stamp 1', { exact: true }).waitFor();
  assert.equal(await page.getByText('Stamp 2', { exact: true }).count(), 0);
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/file-drop-signature.png' });
  console.log('PASS: a combined PDF + image drop imports both exactly once.');

  await drop([{ name: 'broken.png', type: 'image/png', base64: Buffer.from('not an image').toString('base64') }]);
  await page.getByText('This signature picture could not be read. Try a JPG or PNG instead.').waitFor();
  assert.equal(await page.getByText('Stamp 1', { exact: true }).count(), 1);
  await go('/merge');
  await page.locator('[data-file-upload]').waitFor();
  await drop([image]);
  await page.getByRole('alert').filter({ hasText: 'This file is not supported here' }).waitFor();
  assert.match(page.url(), /\/merge$/);
  const textDrop = await page.locator('h1').evaluate(target => {
    const transfer = new DataTransfer(); transfer.setData('text/plain', 'text selection');
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    target.dispatchEvent(event); return event.defaultPrevented;
  });
  assert.equal(textDrop, false);
  await page.locator('input[type=file]').setInputFiles({ name: fixture.name, mimeType: fixture.type, buffer: pdfBytes });
  await page.getByText(fixture.name, { exact: true }).waitFor();
  assert.equal(page.context().pages().length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: invalid images and unsupported files stay in the app; route cleanup, text drag, and file pickers remain functional.');
} finally { await browser.close(); }
