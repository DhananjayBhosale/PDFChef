import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

// Pass 5, the owner: "PDFs are always zoomable". The apps' WebView never zooms the screen, so every
// place that shows a PDF page needs the app's own way to enlarge it (REVIEW.md section 2a).

test('a first-page preview opens the large preview: a tap, its eye, or two fingers', () => {
  const preview = read('components/Tool/FilePreview.tsx');
  assert.match(preview, /className="tk-filepreview-page tk-filepreview-open"/);
  assert.match(preview, /onClick=\{\(\) => setLarge\(true\)\}/);
  assert.match(preview, /usePinchToOpen/);
  assert.match(preview, /<PDFPreviewModal/);
});

test('every page grid gives each page Reorder\'s eye, and two fingers open the page under them', () => {
  const tools: Array<[string, RegExp]> = [
    ['components/Tools/SplitPDF.tsx', /<PageGrid/],
    ['components/Tools/DeletePages.tsx', /<PageGrid/],
    ['components/Tools/ExtractPages.tsx', /<PageGrid/],
    ['components/Tools/RotatePDF.tsx', /<PageGrid/],
    ['components/Tools/PdfAdvancedTools.tsx', /<PageGrid/],
  ];
  for (const [path, grid] of tools) {
    const source = read(path);
    assert.match(source, grid, path);
    assert.match(source, /usePagePreview\(/, path);
    assert.match(source, /gestureRef=\{preview\.pinchRef\}/, path);
    assert.match(source, /data-peek-page=\{index\}/, path);
    assert.match(source, /\{preview\.peek\(index\)\}/, path);
    assert.match(source, /\{preview\.modal\}/, path);
  }
});

test('Extract Text page cards, and Merge and Batch rows, open their page large', () => {
  const ocr = read('components/Tools/OCRPDF.tsx');
  assert.match(ocr, /ref=\{pagePreview\.pinchRef\}/);
  assert.match(ocr, /pagePreview\.peek\(page\.pageNumber - 1\)/);
  const row = read('components/Tool/QueueRow.tsx');
  assert.match(row, /<PeekButton page=\{1\} label=\{t\('queue-row\.preview\.file'/);
  assert.match(row, /\{preview\.modal\}/);
});

test('Crop and Header & Footer have Watermark\'s expand button and open their live page large', () => {
  const source = read('components/Tools/PdfAdvancedTools.tsx');
  assert.match(source, /tools=\{previewFailed \? undefined : <ExpandButton ref=\{largeCropOpener\}/);
  assert.match(source, /<div className="tk-largecrop">\s*<CropFrame/);
  assert.match(source, /tools=\{<ExpandButton ref=\{largeOpener\}/);
  assert.equal((source.match(/<LargePagePreview /g) ?? []).length, 2);
  // A second finger on the crop frame is a pinch: the edge being dragged goes back.
  assert.match(read('components/Tool/CropFrame.tsx'), /onPointerDownCapture=\{cancelOnSecondFinger\}/);
});

test('Make Fillable zooms its page with − % + and two fingers, and a second finger never draws', () => {
  const source = read('components/Tools/MakeFillable.tsx');
  assert.match(source, /usePdfPinchZoom\(\{ zoom, setZoom: setExactZoom, min: 1, max: MAX_ZOOM \}\)/);
  assert.match(source, /<ZoomControls className="tk-fill-zoom"/);
  assert.match(source, /if \(!event\.isPrimary\) \{ dragStart\.current = null; return; \}/);
});

test('the moved-page previews pinch about the fingers through the reader\'s gesture code', () => {
  const hook = read('hooks/usePanZoom.ts');
  assert.match(hook, /usePdfPinchZoom\(\{ zoom, setZoom: setExactZoom, min, max, zoomAt: gestureZoomAt \}\)/);
  assert.match(hook, /pdfButtonZoomAnchor/);
  for (const path of ['components/UI/PDFPreviewModal.tsx', 'components/Tools/PDFToImage.tsx', 'components/Tools/ComparePDF.tsx']) {
    assert.match(read(path), /usePanZoom\(/, path);
  }
  assert.match(read('components/Tools/ImageToPDF.tsx'), /usePdfPinchZoom\(/);
});

// Pass 6a (output/web/review-fable-2/REVIEW.md section 4, items 1, 2, 3, 7, 12, 15 and 20).
test('the large preview fits the whole page at 100% and moves a page larger than its frame', () => {
  const modal = read('components/UI/PDFPreviewModal.tsx');
  assert.match(modal, /relative flex min-h-0 flex-1 items-center justify-center overflow-hidden/);
  assert.match(modal, /className="flex h-full w-full items-center justify-center"/);
  const hook = read('hooks/usePanZoom.ts');
  assert.match(hook, /!overflows\(frame, zoomRef\.current\)\) return;/);
  assert.match(hook, /root\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
});

test('Create PDF photos, Compare panes, Watermark, Page Numbers, Reorder and queue rows open large', () => {
  const make = read('components/Tools/MakePDF.tsx');
  assert.match(make, /gestureRef=\{photoPinchRef\}/);
  assert.match(make, /<PeekButton page=\{index \+ 1\} onOpen=\{\(\) => openPhoto\(index\)\} \/>/);
  assert.match(make, /<PDFPreviewModal file=\{largePhoto\.file\} image=\{largePhoto\.url\}/);
  const compare = read('components/Tools/ComparePDF.tsx');
  assert.match(compare, /usePanZoom\(\{ max: MAX_ZOOM \}\)/);
  assert.match(compare, /onOpen=\{\(\) => entry\.large\.open\(pageIndex\)\}/);
  assert.match(compare, /\{!wide && summary\}/);
  assert.match(read('components/Tools/WatermarkPDF.tsx'), /<div ref=\{previewPinchRef\} className="tk-pinchbox">/);
  assert.match(read('components/Tools/PageNumbersPDF.tsx'), /<div ref=\{previewPinchRef\} className="tk-pinchbox">/);
  const reorder = read('components/Tools/ReorderPDF.tsx');
  assert.match(reorder, /if \(draggingRef\.current\) return;/);
  assert.equal((reorder.match(/data-peek-page=\{item\.originalIndex\}/g) ?? []).length, 2);
  assert.match(read('components/Tool/QueueRow.tsx'), /<div ref=\{attachMain\} className="tk-qrow-main" data-peek-page="0">/);
});

test('Crop and Header & Footer keep the expand button in the pager row', () => {
  const source = read('components/Tools/PdfAdvancedTools.tsx');
  assert.match(source, /foot=\{previewFailed \? undefined : <PagePager index=\{previewIndex\}/);
  assert.match(source, /foot=\{<PagePager index=\{index\} total=\{total\} onChange=\{setIndex\} \/>\}/);
});

test('Read PDF, Image to PDF and Sign zoom to 400%, and Sign reads its fitted view as 100%', () => {
  // One limit for every screen (hooks/useZoom.ts); the large PDF preview alone goes to 500%.
  const limits = read('hooks/useZoom.ts');
  assert.match(limits, /export const MAX_ZOOM = 4;/);
  assert.match(limits, /export const LARGE_PREVIEW_MAX_ZOOM = 5;/);
  assert.match(read('components/UI/PDFPreviewModal.tsx'), /usePanZoom\(\{ min: 0\.5, max: LARGE_PREVIEW_MAX_ZOOM \}\)/);
  assert.match(read('components/Tools/ViewPDF.tsx'), /useZoom\(1, 0\.5, MAX_ZOOM, 0\.25\)/);
  assert.match(read('components/Tools/ImageToPDF.tsx'), /useZoom\(1\.0, 0\.5, MAX_ZOOM, 0\.25\)/);
  const sign = read('components/Tools/SignPDF.tsx');
  assert.match(sign, /useZoom\(1, 0\.5, MAX_ZOOM\)/);
  assert.match(sign, /usePdfPinchZoom\(\{ zoom: view, setZoom: setExactZoom, max: MAX_ZOOM \}\)/);
  for (const path of ['components/Tools/ViewPDF.tsx', 'components/Tools/ImageToPDF.tsx', 'components/Tools/SignPDF.tsx', 'components/Tools/EditPDF.tsx', 'components/Tools/MakeFillable.tsx', 'components/Tool/LargePagePreview.tsx']) {
    assert.doesNotMatch(read(path), /_MAX_ZOOM = \d|max: 4\b|max=\{4\}/, `${path} keeps no limit of its own`);
  }
});

test('PDF to Image zooms its page to 400%, as Compare does (overnight 2026-11-24, B13)', () => {
  const source = read('components/Tools/PDFToImage.tsx');
  assert.match(source, /usePanZoom\(\{ max: MAX_ZOOM \}\)/);
  assert.match(source, /<ZoomControls zoom=\{zoom\} onZoomIn=\{zoomIn\} onZoomOut=\{zoomOut\} onReset=\{resetZoom\} max=\{MAX_ZOOM\} \/>/);
});
