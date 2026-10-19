import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, degrees } from 'pdf-lib';
import {
  MAX_PAGE_CANVAS_PIXELS,
  getPdfPageVisualGeometry,
  getPdfPreviewLayoutSize,
  getPdfRenderScale,
} from '../../services/pdfPageGeometry.ts';
import { getVisualPageSize } from '../../services/pdfEditorGeometry.ts';

test('visible geometry intersects an oversized CropBox with the MediaBox before rotating', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 600]);
  page.setCropBox(-20, 30, 350, 700);
  page.setRotation(degrees(90));
  const geometry = getPdfPageVisualGeometry(page);
  assert.deepEqual(geometry, { cropX: 0, cropY: 30, cropWidth: 330, cropHeight: 570, rotation: 90 });
  assert.deepEqual(getVisualPageSize(geometry), { width: 570, height: 330 });
});

test('a disjoint CropBox falls back to the MediaBox as PDF.js does', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 600]);
  page.setCropBox(800, 900, 20, 30);
  assert.deepEqual(getPdfPageVisualGeometry(page), { cropX: 0, cropY: 0, cropWidth: 400, cropHeight: 600, rotation: 0 });
});

test('preview layout stays in PDF user units independently of UserUnit and raster scale', () => {
  const layout = getPdfPreviewLayoutSize({
    userUnit: 2,
    getViewport({ scale }) { return { width: 400 * 2 * scale, height: 600 * 2 * scale }; },
  });
  assert.deepEqual(layout, { width: 400, height: 600 });
});

const pageOf = (width: number, height: number) => ({
  getViewport({ scale }: { scale: number }) { return { width: width * scale, height: height * scale }; },
});

test('an A4 page still renders at scale 2', () => {
  assert.equal(getPdfRenderScale(pageOf(595, 842)), 2);
});

test('a poster-sized page is held at or under the canvas pixel cap', () => {
  const page = pageOf(2384, 3370);
  const scale = getPdfRenderScale(page);
  const { width, height } = page.getViewport({ scale });
  assert.ok(scale < 2);
  assert.ok(width * height <= MAX_PAGE_CANVAS_PIXELS);
  assert.ok(width * height > MAX_PAGE_CANVAS_PIXELS * 0.99, 'the cap is used, not wasted');
});

test('a tiny page never renders above scale 2', () => {
  assert.equal(getPdfRenderScale(pageOf(100, 100)), 2);
  assert.equal(getPdfRenderScale(pageOf(0, 0)), 2);
});
