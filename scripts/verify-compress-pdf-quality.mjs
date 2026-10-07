import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true });

const pdfImageSize = async bytes => {
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getForm().getTextField('Name').getText(), 'Ada');
  const images = document.context.enumerateIndirectObjects()
    .map(([, object]) => object)
    .filter(object => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
  assert.equal(images.length, 1);
  const image = images[0];
  const dimensions = ['Width', 'Height'].map(key => image.dict.lookup(PDFName.of(key), PDFNumber).asNumber());
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes) });
  try {
    const pdf = await task.promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    assert.ok(content.items.some(item => item.str.includes('Selectable text survives')));
  } finally {
    await task.destroy();
  }
  return dimensions;
};

try {
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: true, keepLocalHistory: false, confirmLargeJobs: false,
      largeFileWarningMb: 80, onboardingComplete: true, interfaceFont: 'inter',
    }));
  });
  await page.goto(`${origin}/compress`);
  const images = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1400;
    canvas.height = 1000;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 1;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      pixels.data[index] = seed & 255;
      pixels.data[index + 1] = (seed >>> 8) & 255;
      pixels.data[index + 2] = (seed >>> 16) & 255;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return {
      jpeg: canvas.toDataURL('image/jpeg', 0.95).split(',')[1],
      png: canvas.toDataURL('image/png').split(',')[1],
    };
  });
  const makeSource = async format => {
    const source = await PDFDocument.create();
    const first = source.addPage([612, 792]);
    const image = format === 'png'
      ? await source.embedPng(Buffer.from(images.png, 'base64'))
      : await source.embedJpg(Buffer.from(images.jpeg, 'base64'));
    first.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    first.drawText('Selectable text survives', { x: 40, y: 700, size: 18 });
    const field = source.getForm().createTextField('Name');
    field.setText('Ada');
    field.addToPage(first, { x: 40, y: 600, width: 160, height: 26 });
    return Buffer.from(await source.save({ useObjectStreams: false }));
  };
  const sourceBytes = await makeSource('jpeg');

  const quality = page.getByRole('slider', { name: 'Compression quality' });
  const selectable = page.getByRole('switch', { name: 'Keep text selectable' });
  const compress = page.getByRole('button', { name: 'Compress', exact: true });
  const outputs = [];
  for (const preset of ['Low', 'High']) {
    await page.locator('input[type=file]').setInputFiles({
      name: 'selectable-with-photo.pdf', mimeType: 'application/pdf', buffer: sourceBytes,
    });
    await quality.waitFor();
    await selectable.check();
    assert.equal(await quality.count(), 1, 'Quality slider must remain when text is selectable');
    await page.getByRole('button', { name: preset, exact: true }).click();
    await selectable.uncheck();
    assert.equal(await quality.count(), 1, 'Quality slider must remain after disabling selectable text');
    await selectable.check();
    assert.equal(await page.getByRole('button', { name: preset, exact: true }).getAttribute('aria-pressed'), 'true');
    await compress.click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    outputs.push({ preset, bytes: bytes.length, dimensions: await pdfImageSize(bytes) });
  }
  assert.ok(outputs[0].bytes < outputs[1].bytes, 'Low selectable-text quality must make a smaller PDF');
  assert.deepEqual(outputs[0].dimensions, [700, 500]);
  assert.deepEqual(outputs[1].dimensions, [1400, 1000]);

  const pngSource = await makeSource('png');
  await page.locator('input[type=file]').setInputFiles({
    name: 'selectable-with-png.pdf', mimeType: 'application/pdf', buffer: pngSource,
  });
  await selectable.check();
  await page.getByRole('button', { name: 'Low', exact: true }).click();
  await compress.click();
  const pngDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const pngDownload = await pngDownloadPromise;
  const pngStream = await pngDownload.createReadStream();
  const pngChunks = [];
  for await (const chunk of pngStream) pngChunks.push(chunk);
  const pngOutput = Buffer.concat(pngChunks);
  assert.ok(pngOutput.length < pngSource.length, 'Low selectable-text quality must shrink an opaque PNG');
  assert.deepEqual(await pdfImageSize(pngOutput), [700, 500]);
  const pngDocument = await PDFDocument.load(pngOutput);
  const pngImage = pngDocument.context.enumerateIndirectObjects()
    .map(([, object]) => object)
    .find(object => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
  assert.equal(pngImage.dict.get(PDFName.of('Filter'))?.toString(), '/DCTDecode');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'mobile.pdf', mimeType: 'application/pdf', buffer: sourceBytes,
  });
  await selectable.check();
  assert.equal(await quality.isVisible(), true, 'Mobile app layout must keep quality available');
  console.log(JSON.stringify({ status: 'PASS', outputs: outputs.map(({ preset, bytes, dimensions }) => ({ preset, bytes, dimensions })), pngBytes: pngOutput.length }, null, 2));
} finally {
  await browser.close();
}
