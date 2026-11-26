import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The result strip and the result sheet.
// Pass 5 fixes (output/web/pass5-fixes/REPORT.md): the review's usability items.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('items 1, 2, 7-10: the strip stays in its slot, Open PDF previews, and the cards fit', () => {
  // StrictMode's second mount registers the slot again (the strip covered Save PDF in development).
  assert.match(read('components/UI/resultSlot.ts'), /if \(latest\.current && !element\.current && enabledRef\.current\) register\(latest\.current\);/);
  // Open PDF on a tool screen shows the result over the tool instead of leaving it.
  const output = read('components/UI/OutputCenter.tsx');
  assert.match(output, /if \(!openTools && slotTarget\) \{[^}]*setPreviewFile\(file\);/s);
  assert.match(output, /<PDFPreviewModal/);
  assert.match(read('components/Tool/ConverterScreen.tsx'), /<FileCard icon=\{icon\} name=\{file\.name\} meta=\{formatBytes\(file\.size\)\} \/>/);
  assert.match(read('components/Tools/ViewPDF.tsx'), /<MiddleName name=\{openedPdf\.name\} \/>/);
  assert.doesNotMatch(read('components/Tool/tool.css'), /\.tk-rtitle-name \{[^}]*line-clamp/s);
  const merge = read('components/Tools/MergePDF.tsx');
  assert.match(merge, /locked = classifyPdfError\(error\) === 'locked';/);
  assert.match(merge, /file\.locked \? t\('batch\.unlock\.locked'\)/);
  assert.match(read('components/Tools/SignPDF.tsx'), /<ChangeFile label=\{t\('tool\.chooseAnotherFile'\)\} onClick=\{chooseAnother\}/);
  assert.match(read('components/Tool/Popover.tsx'), /export const PREVIEW_FLOOR_TALL = 0\.2;/);
  assert.match(read('components/Tools/PageNumbersPDF.tsx'), /previewFloor=\{PREVIEW_FLOOR_TALL\}/);
});

test('closing a result sheet that opened by itself returns focus to its More actions button (desktop-11)', () => {
  const sheet = read('components/UI/Primitives.tsx');
  assert.match(sheet, /if \(!previous \|\| previous === document\.body \|\| document\.activeElement !== previous\) returnFocusRefRef\.current\?\.current\?\.focus\(\);/);
  const output = read('components/UI/OutputCenter.tsx');
  assert.match(output, /returnFocusRef=\{moreButtonRef\}/);
  assert.match(output, /ref=\{moreButtonRef\}/);
});

test('a result line gives its size only, and the sheet starts on its main action (H3-02, desktop-08)', () => {
  const output = read('components/UI/OutputCenter.tsx');
  assert.doesNotMatch(output, /available\.until\.dismissed/);
  assert.doesNotMatch(read('services/i18n/en-US.ts'), /available until dismissed/);
  assert.match(output, /<div data-sheet-primary-focus="">\{primaryAction\}<\/div>/);
});
