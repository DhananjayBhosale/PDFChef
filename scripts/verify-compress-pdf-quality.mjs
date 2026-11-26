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
    // The app-store welcome is a modal; left up, it sits over the quality presets.
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
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
  // "Keep text selectable" is the sentence's one-tap switch word (owner decision 1, A-004): one tap sets it.
  const setSelectable = async (on) => {
    await selectable.waitFor();
    if (on) await selectable.check(); else await selectable.uncheck();
    assert.equal(await selectable.getAttribute('aria-checked'), on ? 'true' : 'false');
    // The switch keeps its words on or off (decision 2026-11-15); the sentence around it changes (pass 5, item 3).
    assert.equal((await selectable.innerText()).trim(), 'keep the text selectable');
  };
  // Save opens the "PDF exported" sheet; close it before the next file.
  // The file stays loaded after a run (T-01), so Clear brings the drop zone back for the next one.
  const closeExported = async () => {
    const sheet = page.getByRole('dialog').filter({ hasText: 'PDF exported' });
    await sheet.waitFor();
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.locator('input[type=file]').waitFor({ state: 'attached' });
  };
  // T-01: a finished run is saved like every tool's result. With "Download automatically" on
  // (this check's settings) Compress itself downloads and the sheet says "PDF exported"; the
  // old "Ready to save" card and its Save button are gone.
  const compressAndDownload = async () => {
    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await compress.click();
    return downloadPromise;
  };
  const outputs = [];
  for (const preset of ['Low', 'High']) {
    await page.locator('input[type=file]').setInputFiles({
      name: 'selectable-with-photo.pdf', mimeType: 'application/pdf', buffer: sourceBytes,
    });
    await quality.waitFor();
    await setSelectable(true);
    assert.equal(await quality.count(), 1, 'Quality slider must remain when text is selectable');
    await page.getByRole('button', { name: preset, exact: true }).click();
    await setSelectable(false);
    assert.equal(await quality.count(), 1, 'Quality slider must remain after disabling selectable text');
    await setSelectable(true);
    assert.equal(await page.getByRole('button', { name: preset, exact: true }).getAttribute('aria-pressed'), 'true');
    const download = await compressAndDownload();
    await closeExported();
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
  await setSelectable(true);
  await page.getByRole('button', { name: 'Low', exact: true }).click();
  const pngDownload = await compressAndDownload();
  await closeExported();
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
    await setSelectable(true);
    await page.getByRole('button', { name: 'Medium', exact: true }).click();
    // With nothing to gain the notice says so instead of a result; that means unchanged.
    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 }).catch(() => null);
    await compress.click();
    const skipped = page.getByText('Already as small as it gets');
    const first = await Promise.race([downloadPromise, skipped.waitFor({ timeout: 120_000 }).then(() => 'skipped')]);
    if (first === 'skipped' || !first) {
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await page.locator('input[type=file]').waitFor({ state: 'attached' });
      return null;
    }
    const chunks = [];
    for await (const chunk of await first.createReadStream()) chunks.push(chunk);
    await closeExported();
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
  await setSelectable(true);
  // On a phone the quality is a value in the sentence whose card holds the slider (owner decision 2026-11-15).
  await page.getByRole('button', { name: /^Quality, / }).click();
  assert.equal(await quality.isVisible(), true, 'Mobile app layout must keep quality available');
  // s5-01 (overnight A4): automatic download off and Recent off, two PDFs, one run. Nothing saves or
  // keeps the results by themselves, so each would replace the last on the strip: the run gives one
  // ZIP with both, saved from the result sheet without running again.
  const both = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await both.addInitScript(() => {
    delete window.showSaveFilePicker;
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false,
      largeFileWarningMb: 80, onboardingComplete: true, interfaceFont: 'inter',
    }));
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
  });
  const early = [];
  both.on('download', (download) => early.push(download));
  await both.goto(`${origin}/compress`);
  await both.locator('input[type=file]').setInputFiles([
    { name: 'photo-a.pdf', mimeType: 'application/pdf', buffer: sourceBytes },
    { name: 'photo-b.pdf', mimeType: 'application/pdf', buffer: pngSource },
  ]);
  await both.getByRole('button', { name: 'Compress', exact: true }).click();
  const bothSheet = both.getByRole('dialog').filter({ hasText: /\.zip/ });
  await bothSheet.waitFor({ timeout: 120_000 });
  await both.waitForTimeout(1_000);
  assert.equal(early.length, 0, 'nothing is saved by itself');
  const zipDownload = both.waitForEvent('download', { timeout: 30_000 });
  await bothSheet.getByRole('button', { name: /^Download( as one ZIP)?$/ }).click();
  const zipFile = await zipDownload;
  assert.match(zipFile.suggestedFilename(), /\.zip$/, 'one ZIP');
  const zipChunks = [];
  for await (const chunk of await zipFile.createReadStream()) zipChunks.push(chunk);
  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(Buffer.concat(zipChunks));
  const entries = Object.keys(archive.files).sort();
  assert.deepEqual(entries, ['compress-photo-a.pdf', 'compress-photo-b.pdf'], 'both results are in the ZIP');
  for (const entry of entries) {
    const head = Buffer.from(await archive.file(entry).async('uint8array')).subarray(0, 5).toString();
    assert.equal(head, '%PDF-', `${entry} is a PDF`);
  }
  await both.close();

  console.log(JSON.stringify({ status: 'PASS', outputs: outputs.map(({ preset, bytes, dimensions }) => ({ preset, bytes, dimensions })), pngBytes: pngOutput.length, icc: { from: iccSource.length, to: iccOutput.length }, multiFileZip: ['compress-photo-a.pdf', 'compress-photo-b.pdf'] }, null, 2));
} finally {
  await browser.close();
}
