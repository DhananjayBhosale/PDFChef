import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument, PDFDict, PDFName, rgb } from 'pdf-lib';

const source = await PDFDocument.create();
source.setTitle('Original title');
source.setAuthor('Original author');
source.setSubject('Original subject');
const first = source.addPage();
first.drawText('Readable words on one line', { x: 40, y: 700 });
const field = source.getForm().createTextField('Customer');
field.setText('Ada');
field.addToPage(first, { x: 40, y: 600, width: 180, height: 25 });
first.node.addAnnot(source.context.register(source.context.obj({
  Type: 'Annot', Subtype: 'Text', Rect: [40, 400, 60, 420], Contents: 'Remove this comment',
})));
for (let index = 0; index < 8; index += 1) source.addPage().drawText(`Page ${index + 2}`);
const bytes = await source.save({ useObjectStreams: false });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false, onboardingComplete: true,
    }));
  });
  await page.goto(process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000');
  const result = await page.evaluate(async (input) => {
    const document = await import('/services/pdfDocument.ts');
    const pdfBrowser = await import('/services/pdfBrowser.ts');
    const results = await import('/services/pdfToolResults.ts');
    const file = new File([new Uint8Array(input)], 'fixture.pdf', { type: 'application/pdf' });
    const metadata = await document.setPDFMetadata(file, { title: 'Replacement' }, { clearAll: true });
    const emptyTitle = await document.setPDFMetadata(file, { title: '' });
    const annotations = await document.removePDFAnnotations(file);
    const compressed = await pdfBrowser.compressPDFAdaptive(file, 'recommended', () => {}, false, undefined, false);
    const protectedBytes = await document.protectPDF(file, 'test-password');
    const encryptedRefusals = [];
    for (const operation of ['repairPDF', 'removePDFAnnotations', 'removePDFMetadata', 'sanitizePDF']) {
      try { await document[operation](new File([protectedBytes], 'protected.pdf')); }
      catch { encryptedRefusals.push(operation); }
    }
    const opened = await pdfBrowser.loadPDFDocument(file);
    let extractedText;
    try {
      const words = await pdfBrowser.getPageSelectableTextLines(opened, 0);
      extractedText = results.textFromSelectionTargets(words);
    } finally { await opened.destroy(); }
    return {
      metadata: Array.from(metadata), emptyTitle: Array.from(emptyTitle), annotations: Array.from(annotations),
      compressed: Array.from(compressed.data), encryptedRefusals, extractedText,
    };
  }, Array.from(bytes));

  const read = (data) => PDFDocument.load(new Uint8Array(data), { updateMetadata: false });
  const edited = await read(result.metadata);
  assert.equal(edited.getTitle(), 'Replacement');
  assert.equal(edited.getAuthor(), '');
  assert.equal(edited.getSubject(), '');
  const cleared = await read(result.emptyTitle);
  assert.equal(cleared.getTitle(), '');
  assert.equal(cleared.getAuthor(), 'Original author');
  const cleaned = await read(result.annotations);
  assert.equal(cleaned.getForm().getTextField('Customer').getText(), 'Ada');
  const remainingAnnotations = cleaned.getPage(0).node.Annots();
  assert.equal(remainingAnnotations.size(), 1);
  assert.equal(remainingAnnotations.lookup(0, PDFDict).get(PDFName.of('Subtype')), PDFName.of('Widget'));
  assert.ok(result.compressed.length < bytes.length, 'text-preserving optimization should shrink this unoptimized fixture');
  const compact = await read(result.compressed);
  assert.equal(compact.getPageCount(), source.getPageCount());
  assert.equal(compact.getForm().getTextField('Customer').getText(), 'Ada');
  assert.deepEqual(result.encryptedRefusals, ['repairPDF', 'removePDFAnnotations', 'removePDFMetadata', 'sanitizePDF']);
  assert.ok(result.extractedText.includes('Readable words on one line'), result.extractedText);

  const scans = [];
  for (const color of [rgb(1, 0, 0), rgb(0, 0, 1)]) {
    const scan = await PDFDocument.create();
    scan.addPage().drawRectangle({ x: 40, y: 600, width: 200, height: 100, color });
    scans.push(Buffer.from(await scan.save()));
  }
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000'}/compare`);
    await page.locator('input[type=file]').nth(0).setInputFiles({ name: 'red-scan.pdf', mimeType: 'application/pdf', buffer: scans[0] });
    await page.getByText('Document A ready.', { exact: true }).waitFor();
    await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'blue-scan.pdf', mimeType: 'application/pdf', buffer: scans[1] });
    await page.getByRole('button', { name: 'Save the summary', exact: true }).click();
    await page.getByRole('heading', { name: 'Comparison summary ready' }).waitFor();
    const summary = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Comparison summary ready' }) });
    assert.ok((await summary.textContent()).includes('These pages need visual comparison'));
    assert.ok(!(await summary.textContent()).includes('100% match'));
  }
  console.log(JSON.stringify({ status: 'PASS', checks: ['metadata clear then edit', 'explicit blank metadata', 'form widget preservation', 'selectable-text compression', 'encrypted transform refusal', 'readable extraction lines', 'desktop/mobile scan comparison UI'], originalBytes: bytes.length, compressedBytes: result.compressed.length }, null, 2));
} finally {
  await browser.close();
}
