import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

// Run against the Vite development server, which exposes the real service modules.
const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: true, keepLocalHistory: false, onboardingComplete: true,
    }));
  });
  await page.goto(`${baseUrl}/make-pdf`);
  const fixtures = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 20;
    const context = canvas.getContext('2d');
    context.fillStyle = 'red';
    context.fillRect(0, 0, 20, 20);
    context.fillStyle = 'blue';
    context.fillRect(20, 0, 20, 20);
    return {
      png: canvas.toDataURL('image/png').split(',')[1],
      jpeg: canvas.toDataURL('image/jpeg').split(',')[1],
    };
  });
  const integrity = await page.evaluate(async (png) => {
    const { createPDFFromImages, createPDFFromLayout } = await import('/services/pdfDocument.ts');
    const good = new File([Uint8Array.from(atob(png), char => char.charCodeAt(0))], 'good.png', { type: 'image/png' });
    const corrupt = new File(['broken image bytes'], 'broken.png', { type: 'image/png' });
    const unsupported = new File(['unsupported'], 'unsupported.webp', { type: 'image/webp' });
    const rejects = async (operation) => { try { await operation(); return false; } catch { return true; } };
    const layout = (files) => [{ width: 595, height: 842, elements: files.map(file => ({ file, x: 0, y: 0, width: 0.5, height: 0.5 })) }];
    return {
      corruptPhotos: await rejects(() => createPDFFromImages([good, corrupt])),
      unsupportedPhotos: await rejects(() => createPDFFromImages([good, unsupported])),
      corruptLayout: await rejects(() => createPDFFromLayout(layout([good, corrupt]))),
      unsupportedLayout: await rejects(() => createPDFFromLayout(layout([good, unsupported]))),
      validPhotos: Array.from(await createPDFFromImages([good, good])),
      validLayout: Array.from(await createPDFFromLayout(layout([good, good]))),
    };
  }, fixtures.png);
  for (const key of ['corruptPhotos', 'unsupportedPhotos', 'corruptLayout', 'unsupportedLayout']) {
    assert.equal(integrity[key], true, `${key}: must reject instead of saving missing images`);
  }
  assert.equal((await PDFDocument.load(new Uint8Array(integrity.validPhotos))).getPageCount(), 2);
  assert.equal((await PDFDocument.load(new Uint8Array(integrity.validLayout))).getPageCount(), 1);

  // APP1 EXIF orientation=6: stored landscape pixels must display as portrait.
  const exifPayload = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const app1Header = Buffer.alloc(4);
  app1Header.writeUInt16BE(0xffe1, 0);
  app1Header.writeUInt16BE(exifPayload.length + 2, 2);
  const jpeg = Buffer.from(fixtures.jpeg, 'base64');
  const orientedJpeg = Buffer.concat([jpeg.subarray(0, 2), app1Header, exifPayload, jpeg.subarray(2)]);
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'camera-orientation-6.jpg', mimeType: 'image/jpeg', buffer: orientedJpeg });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export 1-page PDF', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const output = await PDFDocument.load(Buffer.concat(chunks));
  const images = output.context.enumerateIndirectObjects().map(([, object]) => object)
    .filter(object => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  assert.equal(images.length, 1);
  assert.equal(images[0].dict.get(PDFName.of('Width')).asNumber(), 20, 'EXIF orientation must be baked into exported pixels');
  assert.equal(images[0].dict.get(PDFName.of('Height')).asNumber(), 40);
  console.log('PASS: image export rejects partial output, retains valid pages, and respects camera EXIF orientation.');
} finally {
  await browser.close();
}
