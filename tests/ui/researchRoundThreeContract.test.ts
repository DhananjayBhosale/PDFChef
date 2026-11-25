import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Research round 3 (output/web/ui-redesign/audit/research-r3): fixes whose loss no other unit check
 * would notice. The browser checks for them are in that round's fix-scripts/.
 */

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

test('an overlay keyboard keeps an open editor above it (mobile-01)', () => {
  const popover = read('components/Tool/Popover.tsx');
  assert.match(popover, /viewport\.offsetTop \+ viewport\.height/);
  assert.match(popover, /window\.visualViewport\?\.addEventListener\('resize', schedule\)/);
});

test('a file dropped on a loaded tool stays in that tool (desktop-01, desktop-05, desktop-06)', () => {
  // Single-file tools: the drop takes the Change path, and the zone it brings back takes the file.
  assert.match(read('components/Tool/ToolTop.tsx'), /useReplaceOnDrop\(\{ onReplace: onClick, busy: disabled \|\| cancels \}\)/);
  assert.match(read('components/UI/FileUpload.tsx'), /const handed = takeHandedDrop\(window\.location\.pathname\);/);
  // Read PDF opens a dropped PDF only where no tool accepts it.
  assert.match(read('hooks/useFileDrop.tsx'), /if \(pdf && \(dropZoneShown\(\) \|\| !candidates\.some\(\(candidate\) => candidate\.accept\)\)\)/);
  // Multi-file tools add it to their list.
  assert.match(read('components/Tools/MergePDF.tsx'), /useFileDrop\(\{ accept: files\.length \? '\.pdf' : '', onFiles: handleFilesSelected \}\)/);
  assert.match(read('components/Tools/BatchPDF.tsx'), /useFileDrop\(\{ accept: queueEmpty \? '' : '\.pdf,application\/pdf', onFiles: addFiles \}\)/);
  assert.match(read('components/Tools/ImageToPDF.tsx'), /useFileDrop\(\{ accept: pages\.length \? 'image\/\*' : '', onFiles: handleFilesSelected \}\)/);
  // Compare: two dropped PDFs fill A and B.
  assert.match(read('components/Tools/ComparePDF.tsx'), /onFilesSelected=\{\(files\) => takeFiles\('left', files\)\}/);
});

test('a loaded file is guarded by the browser\'s own leave prompt, with no strings of ours (desktop-03)', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.match(screen, /if \(holdsWork === undefined && dropZoneShown\(\)\) return;/);
  assert.match(screen, /window\.addEventListener\('beforeunload', onBeforeUnload\)/);
  for (const path of ['components/Tools/MakePDF.tsx', 'components/Tools/VerifySignaturesPDF.tsx']) {
    assert.match(read(path), /holdsWork=\{false\}/, path);
  }
  // Invoice, Receipt and Quote ask once something is typed and not saved (overnight 2026-11-24, s1-01).
  assert.match(read('components/Tools/BusinessDocumentBuilder.tsx'), /holdsWork=\{work !== savedWork\}/);
});

test('Reorder Pages moves by keyboard and says where the page went (desktop-02)', () => {
  const reorder = read('components/Tools/ReorderPDF.tsx');
  assert.match(reorder, /aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"/);
  assert.match(reorder, /setMoved\(t\('reorder\.moved', \{ v0: item\.originalIndex \+ 1, v1: to \+ 1, v2: items\.length \}\)\)/);
  assert.match(read('services/i18n/en-US.ts'), /"reorder\.moved": "Page \{v0\} moved to place \{v1\} of \{v2\}\."/);
});

test('the tool header is the page\'s banner, outside <main> (desktop-10)', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.ok(screen.indexOf('<ToolTop title={title}') < screen.indexOf('<main className={`tk-tool'));
  assert.match(read('components/Layout/AppShell.tsx'), /const MainBox = \(tabbed \? 'main' : 'div'\) as 'main';/);
});

test('a result line gives its size only, and the sheet starts on its main action (H3-02, desktop-08)', () => {
  const output = read('components/UI/OutputCenter.tsx');
  assert.doesNotMatch(output, /available\.until\.dismissed/);
  assert.doesNotMatch(read('services/i18n/en-US.ts'), /available until dismissed/);
  assert.match(output, /<div data-sheet-primary-focus="">\{primaryAction\}<\/div>/);
});

test('an all-blank file leaves no main action that cannot produce output (h4-03)', () => {
  // Remove blank pages marks the blank pages before it runs (path to 9, part 2): an all-blank file
  // has every page marked, and the action stays off while every page is marked.
  const tools = read('components/Tools/PdfAdvancedTools.tsx');
  assert.match(tools, /const allMarked = totalPages > 0 && marked\.length >= totalPages;/);
  assert.match(tools, /disabled=\{status\.isProcessing \|\| scanning \|\| marked\.length === 0 \|\| allMarked \|\| Boolean\(previewError\)\}/);
});

test('Unlock does not say a password is required next to a wrong-password error (H2-02)', () => {
  assert.match(read('components/Tools/UnlockPDF.tsx'), /\{!status\.error && <span id="unlock-password-required"/);
});
