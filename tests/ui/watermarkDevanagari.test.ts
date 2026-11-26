import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A Hindi watermark.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('a Hindi watermark is drawn with Edit PDF\'s Devanagari writer, and a phone keeps its error on screen (mobile-01, mobile-02)', () => {
  const service = read('services/pdfDocument.ts');
  // The font name lives beside the Devanagari writer, so Watermark's screen can read it without pdf-lib.
  assert.match(read('services/pdfDevanagari.ts'), /export const WATERMARK_DEVANAGARI_FONT: DevanagariFontId = 'MuktaBold';/);
  const watermark = service.slice(service.indexOf('export const addWatermarkToPDF'));
  assert.match(watermark, /new DevanagariPdfWriter\(pdfDoc\)/);
  assert.match(watermark, /writer\.drawLine\(page,/);
  assert.match(watermark, /writer\?\.finish\(\);/);
  // Opacity reaches the shaped text through its own graphics state.
  assert.match(read('services/pdfDevanagari.ts'), /setGraphicsState\(page\.node\.newExtGState\('GS', state\)\)/);
  const screen = read('components/Tools/WatermarkPDF.tsx');
  assert.match(screen, /const canSave = [^;]*!textPending;/);
  assert.match(screen, /notice=\{!wide && textValidationMessage \? <Notice tone="error" id="watermark-text-error" role="alert">/);
});
