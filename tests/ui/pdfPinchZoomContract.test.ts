import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('shared PDF gesture hook handles trackpad, touchscreen, and Safari pinch events', () => {
  const hook = read('hooks/usePdfPinchZoom.ts');
  assert.match(hook, /event\.ctrlKey/);
  assert.match(hook, /touches\.length !== 2/);
  assert.match(hook, /gesturestart/);
  assert.match(hook, /gesturechange/);
  assert.match(hook, /passive: false/);
  assert.match(hook, /suppressPostPinchClick/);
});

test('reader, signer, and editor use the same pinch zoom viewport contract', () => {
  for (const path of [
    'components/Tools/ViewPDF.tsx',
    'components/Tools/SignPDF.tsx',
    'components/Tools/EditPDF.tsx',
  ]) {
    const source = read(path);
    assert.match(source, /usePdfPinchZoom/);
    assert.match(source, /data-testid="pdf-zoom-viewport"/);
    assert.match(source, /chef-pdf-zoom-viewport/);
  }
});

test('Edit PDF keeps zoomed scrolling inside the PDF box and changes pages at its boundaries', () => {
  const editor = read('components/Tools/EditPDF.tsx');
  assert.match(editor, /pdfPageFromScrollBoundary/);
  assert.match(editor, /event\.ctrlKey \|\| changingPage/);
  assert.match(editor, /viewport\.addEventListener\('wheel', handlePageBoundaryWheel, \{ passive: false \}\)/);
  assert.match(editor, /nextPage > targetPageIndex/);
  assert.match(editor, /viewport\.scrollTop <= 2/);
  assert.match(editor, /viewport\.scrollTop \+ viewport\.clientHeight >= viewport\.scrollHeight - 2/);
  assert.match(editor, /nextViewport\.scrollTop = movingForward/);
  assert.equal((editor.match(/overflow-x-auto overflow-y-auto/g) || []).length, 2);
  assert.doesNotMatch(editor, /overflow-y-clip/);
  assert.doesNotMatch(editor, /window\.scrollTo/);
});

test('the shared reader releases off-screen canvases and its PDF document', () => {
  const reader = read('components/Tools/ViewPDF.tsx');
  const browserService = read('services/pdfBrowser.ts');
  assert.match(reader, /setIsVisible\(entry\.isIntersecting\)/);
  assert.match(reader, /renderTask\?\.cancel\?\.\(\)/);
  assert.match(reader, /canvas\.width = 0/);
  assert.match(reader, /width=\{0\}/);
  assert.match(reader, /currentDocument\.destroy\(\)/);
  assert.match(reader, /aria-label=\{t\("view-pdf\.pdf\.password\.e5cca6"\)\}/);
  assert.match(reader, /loadDisposablePDFDocument\(openedPdf\.file\)/);
  assert.match(browserService, /export const loadDisposablePDFDocument/);
  assert.match(browserService, /caller exclusively owns and must destroy/);
  assert.match(browserService, /export const loadProtectedPDFDocument[\s\S]*await loadingTask\.destroy\(\)/);
  assert.match(reader, /passwordAttemptRef\.current !== passwordAttempt/);
  assert.match(reader, /activeOpenedPdfIdRef\.current !== openedPdfId/);
});

test('iOS signature verification is capability-gated and explicitly user initiated', () => {
  const reader = read('components/Tools/ViewPDF.tsx');
  const runtime = read('hooks/useWorkspaceRuntime.tsx');
  assert.match(reader, /pdfSignatureVerification/);
  assert.match(reader, /isEligible\(openedPdf\.file\)/);
  assert.match(reader, /aria-label=\{t\("view-pdf\.verify\.pdf\.signatures\.93bd01"\)\}/);
  assert.match(reader, /min-h-touch/);
  assert.doesNotMatch(runtime, /pdfSignatureVerification:\s*\{/);
});

test('full-screen PDF previews are named modal dialogs with contained focus', () => {
  for (const path of [
    'components/UI/PDFPreviewModal.tsx',
    'components/Tools/ReadabilityPreview.tsx',
  ]) {
    const source = read(path);
    assert.match(source, /role="dialog"/);
    assert.match(source, /aria-modal="true"/);
    assert.match(source, /aria-labelledby=\{titleId\}/);
    assert.match(source, /event\.key !== 'Tab'/);
    assert.match(source, /previous\?\.isConnected/);
  }
});

test('Extract Pages exposes one selection control per page', () => {
  const extract = read('components/Tools/ExtractPages.tsx');
  const thumbnail = read('components/UI/PageThumbnail.tsx');
  assert.match(extract, /if \(status\.isProcessing\) return/);
  assert.match(extract, /onToggle=\{\(\) => togglePage\(index\)\}/);
  assert.match(extract, /disabled=\{status\.isProcessing\}/);
  assert.match(thumbnail, /aria-disabled=\{disabled \|\| undefined\}/);
  assert.doesNotMatch(extract, /<button[\s\S]{0,500}<PageThumbnail/);
});
