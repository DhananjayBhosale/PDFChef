import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument, PDFDict, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib';
import JSZip from 'jszip';

const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const source = await PDFDocument.create();
const font = await source.embedFont(StandardFonts.Courier);
for (let index = 0; index < 3; index += 1) {
  const page = source.addPage([320, 480]);
  page.drawText(`PAGE-${index + 1}`, { x: 40, y: 380, size: 18, font });
  page.drawRectangle({ x: 40, y: 300, width: 150, height: 40, color: rgb(0, 0, 0) });
  const field = source.getForm().createTextField(`Field${index + 1}`);
  field.setText(`Answer ${index + 1}`);
  field.addToPage(page, { x: 40, y: 220, width: 150, height: 24, font });
}
const input = Array.from(await source.save());
const blanks = await PDFDocument.create();
for (let index = 0; index < 3; index += 1) {
  const page = blanks.addPage([320, 480]);
  if (index !== 1) {
    page.drawText(`PAGE-${index + 1}`, { x: 40, y: 380, size: 18 });
    page.drawRectangle({ x: 40, y: 300, width: 150, height: 40 });
    const field = blanks.getForm().createTextField(`Field${index + 1}`);
    field.setText(`Answer ${index + 1}`);
    field.addToPage(page, { x: 40, y: 220, width: 150, height: 24 });
  }
}
const blankInput = Array.from(await blanks.save());
const large = await PDFDocument.create();
for (let index = 0; index < 3; index += 1) {
  const page = large.addPage([320, 480]);
  page.drawText(`PART-${index + 1}`);
  // Valid, deliberately uncompressed page comments exercise the actual byte limit.
  page.node.addContentStream(large.context.register(large.context.stream(`%${'x'.repeat(600_000)}\n`)));
}
const largeInput = Array.from(await large.save());
const rotated = await PDFDocument.create();
for (const angle of [0, 90, 180, 270]) {
  const page = rotated.addPage([500, 600]);
  page.setCropBox(10, 20, 300, 400);
  page.setRotation(degrees(angle));
}
const rotatedInput = Array.from(await rotated.save());
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  const page = await browser.newPage();
  page.on('console', message => {
    if (message.text().startsWith('Checking ')) console.log(message.text());
  });
  await page.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
    autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false, onboardingComplete: true,
  })));
  await page.goto(baseUrl);
  const result = await page.evaluate(async ({ input, blankInput, largeInput, rotatedInput }) => {
    const d = await import('/services/pdfDocument.ts');
    const b = await import('/services/pdfBrowser.ts');
    const { convertPDFToDocx } = await import('/services/docxExport.ts');
    const { renderBusinessDocument } = await import('/services/documents/businessDocument.ts');
    const asFile = data => new File([new Uint8Array(data)], 'synthetic.pdf', { type: 'application/pdf' });
    const file = asFile(input);
    const outputs = {};
    const record = async (label, bytes) => {
      console.log(`Checking ${label}`);
      const pdf = await b.loadDisposablePDFDocument(asFile(bytes));
      try {
        const text = [];
        for (let i = 1; i <= pdf.numPages; i += 1) {
          text.push((await (await pdf.getPage(i)).getTextContent()).items.map(item => item.str ?? '').join(' '));
        }
        outputs[label] = { bytes: Array.from(bytes), text };
      } finally { await pdf.destroy(); }
    };
    await record('merge', await d.mergePDFs([file, file]));
    await record('extract', await d.extractPages(file, [0, 2]));
    await record('delete', await d.deletePagesFromPDF(file, [1]));
    await record('reorder', await d.reorderPDFPages(file, [2, 0, 1]));
    await record('rotate', await d.rotateSpecificPages(file, [{ pageIndex: 1, rotation: 90 }]));
    await record('flatten', await d.flattenPDF(file));
    await record('repair', await d.repairPDF(file));
    await record('crop', await d.cropPDFMargins(file, { top: 10, right: 10, bottom: 10, left: 10 }));
    // A second crop must keep applying the requested percentage on a small visible box.
    const cropped = await d.cropPDFMargins(file, { top: 40, right: 40, bottom: 40, left: 40 });
    await record('smallCrop', await d.cropPDFMargins(asFile(cropped), { top: 40, right: 40, bottom: 40, left: 40 }));
    await record('rotatedCrop', await d.cropPDFMargins(asFile(rotatedInput), { top: 20, right: 0, bottom: 0, left: 0 }));
    const noBlanks = await d.removeBlankPagesFromPDF(asFile(blankInput));
    await record('removeBlank', noBlanks.bytes);
    console.log('Checking split');
    const split = await d.splitPDFByPagesPerFile(file, 2);
    const single = await d.splitPDFByPagesPerFile(file, 3);
    await record('singleSplit', new Uint8Array(await single.blob.arrayBuffer()));
    console.log('Checking size split');
    const sizeSplit = await d.splitPDFByMaximumSize(asFile(largeInput), 1);
    const refused = [];
    for (const [label, run] of [
      ['extract empty', () => d.extractPages(file, [])],
      ['extract outside document', () => d.extractPages(file, [3])],
      ['delete all', () => d.deletePagesFromPDF(file, [0, 1, 2])],
      ['duplicate reorder', () => d.reorderPDFPages(file, [0, 0, 1])],
      ['damaged input', () => d.repairPDF(asFile([0, 1, 2]))],
      ['cancelled merge', () => d.mergePDFs([file, file], AbortSignal.abort())],
      ['cancelled split', () => d.splitPDFByPagesPerFile(file, 1, [], undefined, AbortSignal.abort())],
    ]) {
      try { await run(); } catch { refused.push(label); }
    }
    const canvas = document.createElement('canvas');
    canvas.width = 900; canvas.height = 300;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 900, 300);
    ctx.fillStyle = '#000'; ctx.font = '48px Arial';
    ctx.fillText('PDF CHEF TEST 12345', 40, 130);
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const image = new File([png], 'scan.png', { type: 'image/png' });
    const created = await d.createPDFFromImages([image, image]);
    await record('create', created);
    const layout = await d.createPDFFromLayout([{ width: 900, height: 300, elements: [
      { file: image, x: 0, y: 0, width: 1, height: 1 },
    ] }]);
    await record('imageLayout', layout);
    const imagesPdf = await b.loadDisposablePDFDocument(asFile(layout));
    let imageCheck;
    try {
      console.log('Checking embedded images');
      const assets = await b.extractEmbeddedImagesFromPDF(imagesPdf);
      const rendered = await b.renderPageAsImage(imagesPdf, 0, { format: 'image/jpeg', scale: 1, quality: 0.8 });
      imageCheck = { count: assets.length, width: assets[0]?.width, height: assets[0]?.height,
        outputType: rendered.blob.type, outputWidth: rendered.width, outputHeight: rendered.height };
      for (const asset of assets) URL.revokeObjectURL(asset.objectUrl);
      URL.revokeObjectURL(rendered.objectUrl);
    } finally { await imagesPdf.destroy(); }
    const docx = await convertPDFToDocx(file);
    for (const kind of ['invoice', 'receipt', 'quote']) {
      await record(kind, await renderBusinessDocument({
        kind, reference: 'TEST-1042', issuedOn: '12 September 2026', currency: 'INR',
        from: { name: 'Test Business' }, to: { name: 'Test Customer' }, taxRate: 18,
        items: [{ description: 'Service', quantity: 2, unitPrice: 100 }],
      }));
    }
    return { outputs, imageCheck, removedPages: noBlanks.removedPages, refused,
      split: Array.from(new Uint8Array(await split.blob.arrayBuffer())), partCount: split.partCount,
      singleArchive: single.isArchive, sizeSplit: Array.from(new Uint8Array(await sizeSplit.blob.arrayBuffer())),
      sizeParts: sizeSplit.partCount, docx: Array.from(new Uint8Array(await docx.arrayBuffer())) };
  }, { input, blankInput, largeInput, rotatedInput });

  for (const [label, expected] of Object.entries({
    merge: [1, 2, 3, 1, 2, 3], extract: [1, 3], delete: [1, 3], reorder: [3, 1, 2],
    rotate: [1, 2, 3], flatten: [1, 2, 3], repair: [1, 2, 3], crop: [1, 2, 3],
    removeBlank: [1, 3], singleSplit: [1, 2, 3],
  })) {
    const data = result.outputs[label];
    const pdf = await PDFDocument.load(new Uint8Array(data.bytes), { updateMetadata: false });
    assert.equal(pdf.getPageCount(), expected.length, label);
    assert.deepEqual(data.text.map(text => Number(/PAGE-(\d)/.exec(text)?.[1])), expected, label);
    if (label === 'flatten') {
      assert.equal(pdf.getForm().getFields().length, 0);
      data.text.forEach((text, i) => assert.ok(text.includes(`Answer ${i + 1}`), 'flatten must preserve visible answers'));
    } else {
      assert.equal(pdf.getForm().getFields().length, expected.length, `${label} lost form definitions`);
      for (const page of pdf.getPages()) {
        for (const ref of page.node.Annots()?.asArray() ?? []) {
          assert.equal(pdf.context.lookup(ref, PDFDict).get(PDFName.of('P')), page.ref, `${label} widget points to an old page`);
        }
      }
    }
    if (['extract', 'delete', 'removeBlank'].includes(label)) {
      const fields = pdf.context.enumerateIndirectObjects().flatMap(([, object]) =>
        object instanceof PDFDict ? [object.get(PDFName.of('T'))?.decodeText?.()] : []);
      assert.ok(!fields.includes('Field2'), `${label} retains a removed field in unused objects`);
    }
    if (label === 'rotate') assert.deepEqual(pdf.getPages().map(page => page.getRotation().angle), [0, 90, 0]);
    if (label === 'crop') assert.deepEqual(pdf.getPage(0).getCropBox(), { x: 32, y: 48, width: 256, height: 384 });
    checks.push(`${label}: saved page order, content and fields`);
  }
  assert.deepEqual(result.removedPages, [2]);
  const smallCrop = (await PDFDocument.load(new Uint8Array(result.outputs.smallCrop.bytes))).getPage(0).getCropBox();
  assert.ok(Math.abs(smallCrop.width - 12.8) < 0.01 && Math.abs(smallCrop.height - 19.2) < 0.01,
    'repeated cropping must not impose an unrelated minimum box size');
  const rotatedCrop = await PDFDocument.load(new Uint8Array(result.outputs.rotatedCrop.bytes));
  assert.deepEqual(rotatedCrop.getPages().map(page => page.getCropBox()), [
    { x: 10, y: 20, width: 300, height: 320 },
    { x: 70, y: 20, width: 240, height: 400 },
    { x: 10, y: 100, width: 300, height: 320 },
    { x: 10, y: 20, width: 240, height: 400 },
  ], 'Top must mean the visible top at each page rotation');
  checks.push('crop: repeated small crops and visible edges at all quarter-turn rotations');
  assert.equal(result.singleArchive, false);
  assert.equal(result.partCount, 2);
  const parts = await JSZip.loadAsync(new Uint8Array(result.split));
  for (const [index, entry] of Object.values(parts.files).entries()) {
    const pdf = await PDFDocument.load(await entry.async('uint8array'));
    assert.equal(pdf.getPageCount(), index === 0 ? 2 : 1);
    assert.deepEqual(pdf.getForm().getFields().map(field => field.getName()), index === 0 ? ['Field1', 'Field2'] : ['Field3']);
  }
  assert.equal(result.sizeParts, 3);
  for (const entry of Object.values((await JSZip.loadAsync(new Uint8Array(result.sizeSplit))).files)) {
    const bytes = await entry.async('uint8array');
    assert.ok(bytes.length <= 1024 * 1024);
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  }
  checks.push('split: multiple parts, single PDF, actual size cap');
  assert.equal(result.refused.length, 7, result.refused.join(', '));
  checks.push('invalid selections, damaged input and cancelled work refused');
  assert.deepEqual(result.imageCheck, { count: 1, width: 900, height: 300, outputType: 'image/jpeg', outputWidth: 900, outputHeight: 300 });
  assert.equal(result.outputs.create.text.length, 2);
  assert.equal(result.outputs.imageLayout.text.length, 1);
  checks.push('Create PDF, image layout, PDF to image and embedded image extraction');
  const docx = await JSZip.loadAsync(new Uint8Array(result.docx));
  const xml = await docx.file('word/document.xml').async('text');
  for (const n of [1, 2, 3]) assert.ok(xml.includes(`PAGE-${n}`));
  checks.push('PDF to Word: valid DOCX with all page text');
  for (const kind of ['invoice', 'receipt', 'quote']) {
    const text = result.outputs[kind].text.join(' ');
    assert.ok(text.includes(kind.toUpperCase()) && text.includes('TEST-1042') && text.includes('INR 236.00'), text);
    checks.push(`${kind}: readable PDF with correct reference and tax total`);
  }
  const routes = await page.evaluate(async () => (await import('/components/Tools/toolCatalog.ts')).tools.map(({ path, name }) => ({ path, name })));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const tool of routes) {
    console.log(`Checking route ${tool.path}`);
    await page.goto(`${baseUrl}${tool.path}`);
    await page.locator('h1').first().waitFor();
    assert.equal(await page.getByText('Something went wrong', { exact: true }).count(), 0, tool.name);
  }
  assert.deepEqual(errors, []);
  checks.push(`all ${routes.length} tool routes render without runtime errors`);
  await page.goto(`${baseUrl}/ocr`);
  console.log('Checking OCR');
  await page.getByRole('radio', { name: 'Scanned pages', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'synthetic-scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(result.outputs.imageLayout.bytes),
  });
  await page.getByRole('button', { name: 'Download .txt', exact: true }).waitFor({ timeout: 60000 });
  assert.match(await page.locator('body').innerText(), /PDF CHEF TEST 12345/);
  checks.push('Extract Text: local OCR reads a synthetic image-only PDF');
  console.log(JSON.stringify({ status: 'PASS', checks }, null, 2));
} finally {
  await browser.close();
}
