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

  // A photo tagged with an sRGB profile and more pixels than a Letter page shows at 144 DPI:
  // Medium must re-encode it and cap it at 11 in x 144. The same photo tagged Display P3 must
  // be left as it is, since a DeviceRGB copy would shift its colours.
  const iccProfile = primaries => {
    const bytes = new Uint8Array(132 + 6 * 12 + 3 * 20 + 16);
    const view = new DataView(bytes.buffer);
    const write = (at, text) => [...text].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
    write(16, 'RGB ');
    view.setUint32(128, 6);
    const curveAt = 132 + 6 * 12 + 3 * 20;
    ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'].forEach((tag, index) => {
      write(132 + index * 12, tag);
      view.setUint32(136 + index * 12, index < 3 ? 132 + 6 * 12 + index * 20 : curveAt);
    });
    primaries.forEach((xyz, index) => {
      write(132 + 6 * 12 + index * 20, 'XYZ ');
      xyz.forEach((value, axis) => view.setInt32(132 + 6 * 12 + index * 20 + 8 + axis * 4, Math.round(value * 65536)));
    });
    write(curveAt, 'curv');
    view.setUint32(curveAt + 8, 1);
    view.setUint16(curveAt + 12, Math.round(2.2 * 256));
    return bytes;
  };
  const SRGB = [[0.4361, 0.2225, 0.0139], [0.3851, 0.7169, 0.0971], [0.1431, 0.0606, 0.7141]];
  const DISPLAY_P3 = [[0.5151, 0.2412, -0.0011], [0.292, 0.6922, 0.0419], [0.1571, 0.0666, 0.7841]];
  const largeJpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 3000;
    canvas.height = 2000;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#b03a2e');
    gradient.addColorStop(1, '#1f618d');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < 4000; index += 1) {
      context.fillStyle = `hsl(${(index * 37) % 360} 60% 50%)`;
      context.fillRect((index * 7919) % canvas.width, (index * 104729) % canvas.height, 24, 24);
    }
    return canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
  });
  const makeIccSource = async primaries => {
    const source = await PDFDocument.create();
    const first = source.addPage([612, 792]);
    const image = await source.embedJpg(Buffer.from(largeJpeg, 'base64'));
    first.drawImage(image, { x: 0, y: 0, width: 612, height: 408 });
    first.drawText('Selectable text survives', { x: 40, y: 700, size: 18 });
    const field = source.getForm().createTextField('Name');
    field.setText('Ada');
    field.addToPage(first, { x: 40, y: 600, width: 160, height: 26 });
    await image.embed();
    const profile = source.context.register(source.context.flateStream(iccProfile(primaries), { N: 3 }));
    source.context.lookup(image.ref).dict.set(PDFName.of('ColorSpace'), source.context.obj([PDFName.of('ICCBased'), profile]));
    return Buffer.from(await source.save({ useObjectStreams: false }));
  };
  const compressMedium = async (fileName, buffer) => {
    await page.locator('input[type=file]').setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer });
    await selectable.check();
    await page.getByRole('button', { name: 'Medium', exact: true }).click();
    await compress.click();
    // With nothing to gain the result says so instead of offering Save; that means unchanged.
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await save.or(page.getByText('Already as small as it gets')).first().waitFor();
    if (!(await save.isVisible())) return null;
    const downloadPromise = page.waitForEvent('download');
    await save.click();
    const chunks = [];
    for await (const chunk of await (await downloadPromise).createReadStream()) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const iccSource = await makeIccSource(SRGB);
  const iccOutput = await compressMedium('selectable-with-srgb-photo.pdf', iccSource);
  assert.ok(iccOutput && iccOutput.length < iccSource.length / 2, 'Medium must shrink an sRGB-tagged oversized photo');
  assert.deepEqual(await pdfImageSize(iccOutput), [1584, 1056]);
  const p3Output = await compressMedium('selectable-with-p3-photo.pdf', await makeIccSource(DISPLAY_P3));
  if (p3Output) assert.deepEqual(await pdfImageSize(p3Output), [3000, 2000], 'A Display P3 photo must keep its pixels and profile');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'mobile.pdf', mimeType: 'application/pdf', buffer: sourceBytes,
  });
  await selectable.check();
  assert.equal(await quality.isVisible(), true, 'Mobile app layout must keep quality available');
  console.log(JSON.stringify({ status: 'PASS', outputs: outputs.map(({ preset, bytes, dimensions }) => ({ preset, bytes, dimensions })), pngBytes: pngOutput.length, icc: { from: iccSource.length, to: iccOutput.length } }, null, 2));
} finally {
  await browser.close();
}
