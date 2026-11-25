import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'services/officeDocument.ts'), 'utf8');
const between = (start: string, end: string) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} is missing`);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to < 0 ? undefined : to);
};
const slideRoot = between('const slideRoot = ', '\n};');
const drawSlide = between('const drawSlide = async', '\n};');
const conversion = between('export const convertPptxToPdf', '\n};');
const firstSlide = between('export const renderPptxFirstSlide', '\n};');

// CRT-50: a 4:3 slide (960 x 720) was scaled to 1280 x 960 with a CSS transform. html2canvas
// clipped its shapes to the unscaled 960 x 720 box, so the right and bottom quarter came out blank.
// 16:9 slides were complete only because their scale is 1. The conversion and the first-slide
// preview (research r2, H3-03) share the same two helpers, so both keep the fix.
test('PowerPoint to PDF captures the whole slide at its own size and lets html2canvas scale it', () => {
  assert.match(slideRoot, /width: `\$\{width\}px`,\s*height: `\$\{height\}px`/);
  for (const part of [slideRoot, drawSlide, conversion, firstSlide]) {
    assert.doesNotMatch(part, /transform:\s*`scale\(/, 'the slide must not be scaled with a CSS transform');
  }

  const capture = drawSlide.slice(drawSlide.indexOf('html2canvas(root, {'));
  const options = capture.slice(0, capture.indexOf('});'));
  assert.match(options, /width: presentation\.width,/);
  assert.match(options, /height: presentation\.height,/);
  assert.match(options, /\bscale,/);
  assert.doesNotMatch(options, /scale: 1\b/);

  assert.match(conversion, /const scale = longEdge \/ Math\.max\(sourceWidth, sourceHeight\);/);
  assert.match(conversion, /slideRoot\(sourceWidth, sourceHeight\)/);
  assert.match(conversion, /drawSlide\(renderer, html2canvasModule\.default, presentation, index, scale, root\)/);
  assert.match(firstSlide, /slideRoot\(presentation\.width, presentation\.height\)/);
  assert.match(firstSlide, /const scale = longEdge \/ Math\.max\(presentation\.width, presentation\.height\);/);
  assert.match(firstSlide, /drawSlide\(renderer, html2canvasModule\.default, presentation, 0, scale, root\)/);
});
