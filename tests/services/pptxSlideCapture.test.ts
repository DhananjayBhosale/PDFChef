import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'services/officeDocument.ts'), 'utf8');
const conversion = source.slice(source.indexOf('export const convertPptxToPdf'));

// CRT-50: a 4:3 slide (960 x 720) was scaled to 1280 x 960 with a CSS transform. html2canvas
// clipped its shapes to the unscaled 960 x 720 box, so the right and bottom quarter came out blank.
// 16:9 slides were complete only because their scale is 1.
test('PowerPoint to PDF captures the whole slide at its own size and lets html2canvas scale it', () => {
  assert.ok(conversion.length > 0, 'convertPptxToPdf is missing');
  assert.match(conversion, /const scale = longEdge \/ Math\.max\(sourceWidth, sourceHeight\);/);
  assert.doesNotMatch(conversion, /transform:\s*`scale\(/, 'the slide must not be scaled with a CSS transform');
  assert.match(conversion, /width: `\$\{sourceWidth\}px`,\s*height: `\$\{sourceHeight\}px`/);

  const capture = conversion.slice(conversion.indexOf('html2canvasModule.default(root, {'));
  const options = capture.slice(0, capture.indexOf('});'));
  assert.match(options, /width: sourceWidth,/);
  assert.match(options, /height: sourceHeight,/);
  assert.match(options, /\bscale,/);
  assert.doesNotMatch(options, /scale: 1\b/);
});
