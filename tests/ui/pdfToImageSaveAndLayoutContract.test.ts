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
  // The page box starts below the zoom controls (top-2 + 42 px, or top-4 from sm up).
  assert.match(source, /className="absolute inset-x-3 bottom-3 top-14 sm:top-16"\s*style=\{zoom === 1 \? undefined/);
});

// NAV-39: Quality and Resolution side by side were wider than the card on a 360 px screen.
test('the PDF to Image sliders take one row each', () => {
  const settings = between('t("pdfto-image.format.2f3436")', 'htmlFor="pdf-to-image-pages"');
  assert.doesNotMatch(settings, /grid-cols-2/);
  assert.doesNotMatch(settings, /col-span-2/);
});
