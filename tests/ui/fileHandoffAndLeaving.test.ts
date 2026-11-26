import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A loaded file: handed to another tool, dropped on a tool, and guarded on leaving.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('a locked-file error links to Unlock PDF and hands the file on (mobile-06)', () => {
  const errorText = read('components/UI/ErrorText.tsx');
  assert.match(errorText, /name: \(\) => t\('tool-catalog\.unlock\.pdf\.893947'\),\s*to: '\/unlock'/);
  assert.match(errorText, /'error\.pdfLocked', 'compress-pdf\.this\.pdf\.is\.encrypted\.unlock\.it\.first\.7621b1'/);
  assert.match(errorText, /navigate\(step\.to, \{ state: \{ useOpenedPdf: true, openedPdfId: opened\.id \} \}\)/);
  assert.match(read('components/Tool/parts.tsx'), /<ErrorText text=\{status\.error\} \/>/);
  assert.match(read('components/UI/StatusToast.tsx'), /failed \? <ErrorText text=\{message\} \/> : message/);
  assert.match(read('components/UI/FileUpload.tsx'), /rememberPickedFile\(/);
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

test('item 2: one blocker asks on Back as the links do, and not after a save', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.equal(screen.match(/useBlocker\(/g)?.length, 1);
  assert.match(screen, /if \(currentLocation\.pathname === nextLocation\.pathname\) return false;/);
  assert.match(screen, /historyAction === NavigationType\.Replace && nextLocation\.pathname === '\/'/);
  assert.match(screen, /return asks && wouldLose\(\);/);
  assert.match(screen, /getStripSaved/);
  for (const file of ['hooks/useConfirmDiscard.tsx', 'components/Tools/EditPDF.tsx']) assert.doesNotMatch(read(file), /useBlocker/, file);
});
