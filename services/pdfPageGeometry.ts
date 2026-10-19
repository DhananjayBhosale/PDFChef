import type { PDFPage } from 'pdf-lib';
import { normalizePageRotation, type PdfPageVisualGeometry } from './pdfEditorGeometry.ts';

/** PDF.js displays the intersection of CropBox and MediaBox, in the page's rotation. */
export const getPdfPageVisualGeometry = (page: PDFPage): PdfPageVisualGeometry => {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x = Math.max(media.x, crop.x);
  const y = Math.max(media.y, crop.y);
  const width = Math.min(media.x + media.width, crop.x + crop.width) - x;
  const height = Math.min(media.y + media.height, crop.y + crop.height) - y;
  const visible = width > 0 && height > 0 ? { x, y, width, height } : media;
  return {
    cropX: visible.x,
    cropY: visible.y,
    cropWidth: visible.width,
    cropHeight: visible.height,
    rotation: normalizePageRotation(page.getRotation().angle),
  };
};

/** The most pixels one page canvas may hold; PDF.js's own viewer uses this cap on phones. */
export const MAX_PAGE_CANVAS_PIXELS = 5_242_880;

/**
 * The scale a page is drawn at: 2 for sharp zooming, lowered only when that many pixels would
 * not fit under the canvas cap. An A4 page at scale 2 is about two megapixels, so ordinary pages
 * are unchanged; a poster-sized page is drawn softer rather than as a canvas of tens of megabytes.
 */
export const getPdfRenderScale = (
  page: { getViewport: (options: { scale: number }) => { width: number; height: number } },
  maxScale = 2,
) => {
  const { width, height } = page.getViewport({ scale: 1 });
  const area = width * height;
  if (!(area > 0)) return maxScale;
  return Math.min(maxScale, Math.sqrt(MAX_PAGE_CANVAS_PIXELS / area));
};

/** Page layout uses PDF user units; raster resolution and /UserUnit must not change the overlay. */
export const getPdfPreviewLayoutSize = (page: {
  userUnit?: number;
  getViewport: (options: { scale: number }) => { width: number; height: number };
}) => {
  const viewport = page.getViewport({ scale: 1 / (page.userUnit || 1) });
  return { width: viewport.width, height: viewport.height };
};
