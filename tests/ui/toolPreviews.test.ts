import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Previews show only what they can stand behind.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('PowerPoint to PDF shows the first slide, with its file card if that fails (H3-03)', () => {
  assert.match(read('services/officeDocument.ts'), /export const renderPptxFirstSlide = async \(file: File, longEdge = 960\): Promise<string>/);
  assert.match(read('components/Tools/PowerPointToPDF.tsx'), /renderPreview=\{renderFirstSlide\}/);
  // The fallback is the same compact file card Word shows (pass 5, item 7).
  const converter = read('components/Tool/ConverterScreen.tsx');
  assert.match(converter, /render=\{renderPreview\} fallback=\{fileCard\}/);
  assert.match(converter, /const fileCard = \(?\s*<div className="tk-cardstage">\s*<FileCard icon=\{icon\}/);
});

test('the Compress preview shows no size it cannot stand behind (desktop-02)', () => {
  const browser = read('services/pdfBrowser.ts');
  // Keep-text mode has no honest estimate; pictures mode measures as the Compress screen does.
  assert.match(browser, /metrics: \{ estimatedTotalSize: 0 \}/);
  assert.match(browser, /const estimatedTotalSize = await measureProjectedSize\(file, config, \{ maxSamples: 2 \}\);/);
  assert.match(read('components/Tools/ReadabilityPreview.tsx'), /setSizeEstimate\(result\.metrics\.estimatedTotalSize > 0 \?/);
});
