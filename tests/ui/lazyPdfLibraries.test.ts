import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// PDF.js and pdf-lib load on first use.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('a tool screen loads PDF.js and pdf-lib on first use, not with its drop zone (mobile-02)', () => {
  // Compress loads its preview, which needs PDF.js at once, only when it is opened.
  const lazyOnly = new Set(['components/Tools/ReadabilityPreview.tsx']);
  assert.match(read('components/Tools/CompressPDF.tsx'), /React\.lazy\(\(\) => import\('\.\/ReadabilityPreview'\)/);
  const screens = ['components/Tools', 'components/Tool', 'components/UI', 'components/Layout', 'components/Pages']
    .flatMap((folder) => readdirSync(resolve(root, folder)).filter((name) => /\.tsx?$/.test(name)).map((name) => `${folder}/${name}`))
    .filter((path) => !lazyOnly.has(path));
  const eager = /^import (?!type )[^;]*from '(?:\.\.\/)+services\/(?:pdfBrowser|pdfDocument)'|^import (?!type )[^;]*from '(?:pdf-lib|pdfjs-dist[^']*)'/m;
  assert.deepEqual(screens.filter((path) => eager.test(read(path))), []);
  assert.match(read('services/pdfLazy.ts'), /const browser = \(\) => import\('\.\/pdfBrowser'\)/);
  assert.match(read('components/Tools/OCRPDF.tsx'), /await import\('tesseract\.js'\)/);
});
