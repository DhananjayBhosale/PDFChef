import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Sign PDF and Reorder Pages: fitted view and handles.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('Sign and Reorder keep their handles apart (mobile-06, mobile-07, mobile-08)', () => {
  const sign = read('components/Tools/SignPDF.tsx');
  assert.match(sign, /nextSignature\.x = Math\.min\(nextSignature\.x \+ 0\.04, 1 - nextSignature\.width\);/);
  // Round 6 (gpt-terra): Remove sits outside the stamp's top-left corner, so a tap on the stamp never deletes it.
  assert.match(sign, /tk-sign-handle tk-sign-remove [^"]*absolute bottom-full right-full/);
  // Reorder's grid handle sits in the thumbnail's bottom corner, off the page's title.
  assert.match(read('components/Tool/tool.css'), /\.tk-rgrid \.tk-drag \{ inset-block-start: auto; inset-block-end: 4px; inset-inline-end: 4px;/);
});

test('item 9: Sign measures its fitted view again when the page view changes size', () => {
  const sign = read('components/Tools/SignPDF.tsx');
  assert.match(sign, /new ResizeObserver\(\(\) => fitToViewport\(\)\)/);
  // The zoom is held relative to the fitted view, so a view at the fit follows a new fit.
  assert.match(sign, /const zoom = view \* startZoom;/);
  assert.match(sign, /startZoomRef\.current = start;\n    setStartZoom\(start\);\n  \}, \[\]\);/);
});
