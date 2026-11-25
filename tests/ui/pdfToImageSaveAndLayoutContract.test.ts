import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'components/Tools/PDFToImage.tsx'), 'utf8');
const between = (start: string, end: string) => {
  const from = source.indexOf(start);
  assert.ok(from > -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
};

// CNV-19: "Done!" showed and Convert came back while a zip was still being written for up to 80 s.
test('PDF to Image stays busy until the file is written, then says Done', () => {
  assert.doesNotMatch(source, /\bdownloadBlob\(/, 'fire-and-forget delivery reports Done before the file exists');
  const save = between('const saveResult = async', 'const handlePageExport');
  const saving = save.indexOf('isProcessing: true');
  const written = save.indexOf('await deliverBlob(blob, name, mimeType)');
  const done = save.indexOf('t("pdfto-image.done.b4e19e")');
  assert.ok(saving > -1 && written > saving, 'Saving is shown before the delivery starts');
  assert.ok(done > written, 'Done is shown only after the delivery resolves');
  assert.match(save, /message: t\("pdfto-image\.saving\.23e392"\)/);
  // Done is said in one place, after the file is written.
  assert.equal(source.split('t("pdfto-image.done.b4e19e")').length - 1, 1);
});

test('every PDF to Image result goes through the awaited save', () => {
  const pages = between('const handlePageExport = async', 'const selectedEmbeddedImages');
  assert.match(pages, /await saveResult\(\s*blob,/);
  assert.match(pages, /await saveResult\(content, toolOutputName\('images', file\.name, 'zip'\)\)/);
  const embedded = between('const downloadEmbeddedImages = async', 'const handleEmbeddedExport');
  assert.match(embedded, /await saveResult\(images\[0\]\.blob,/);
  assert.match(embedded, /await saveResult\(content, toolOutputName\('images', file\.name, 'zip'\)\)/);
  // The single-image save is inside the try, so a failed write is reported.
  assert.ok(embedded.indexOf('try {') < embedded.indexOf('await saveResult(images[0].blob,'));
});

test('Convert and the per-image Download stay disabled while a save is running', () => {
  const convert = between('onClick={handlePrimaryAction}', '>');
  assert.match(convert, /status\.isProcessing \|\|/);
  const download = between('onClick={() => void downloadEmbeddedImages([image])}', '>');
  assert.match(download, /disabled=\{status\.isProcessing\}/);
});

// NAV-39: a 64dvh-tall page in a 237 px box showed only the blank middle of the page.
test('the PDF to Image preview fits the whole page inside its box', () => {
  const preview = between('const PageImagePreview', 'export const PDFToImage');
  assert.doesNotMatch(preview, /max-h-\[\d+[a-z]*\]/, 'a fixed height cap can be taller than the preview box');
  assert.match(preview, /<figure className="absolute inset-0">/);
  assert.match(preview, /className="absolute inset-0 m-auto block max-h-full max-w-full /);
  // T-13: the zoom sits in the preview frame's own row above the stage, so the page box fills it.
  assert.match(source, /<PreviewFrame tools=\{<ZoomControls /);
  assert.match(source, /className="absolute inset-0"\s*style=\{zoom === 1 \? undefined/);
});

// NAV-39: Quality and Resolution side by side were wider than the card on a 360 px screen.
// In the sentence layout each slider is the whole body of its own slot editor (phones) or of its
// own row beside the page (desktop, owner decision 1, A-008), so each takes a row.
test('the PDF to Image sliders each sit in their own slot editor', () => {
  const quality = between('const qualityEditor = (', 'const scaleEditor = (');
  const scale = between('const scaleEditor = (', 'const settingSlot = ');
  assert.equal(quality.split('<ChefSliderField').length - 1, 1);
  assert.equal(scale.split('<ChefSliderField').length - 1, 1);
  for (const slot of [quality, scale]) {
    assert.doesNotMatch(slot, /grid-cols-2/);
    assert.doesNotMatch(slot, /col-span-2/);
  }
  assert.match(source, /\.\.\.settingSlot\('quality', qualityEditor\)/);
  assert.match(source, /\.\.\.settingSlot\('scale', scaleEditor\)/);
  assert.match(source, /<div data-setting="quality" className="tk-side-setting">\{qualityEditor\}<\/div>/);
  assert.match(source, /<div data-setting="scale" className="tk-side-setting">\{scaleEditor\}<\/div>/);
});
