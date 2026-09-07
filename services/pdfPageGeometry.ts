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

/** Page layout uses PDF user units; raster resolution and /UserUnit must not change the overlay. */
export const getPdfPreviewLayoutSize = (page: {
  userUnit?: number;
  getViewport: (options: { scale: number }) => { width: number; height: number };
}) => {
  const viewport = page.getViewport({ scale: 1 / (page.userUnit || 1) });
  return { width: viewport.width, height: viewport.height };
};
