import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  buildTextBlocks,
  positionTextItems,
  type PdfTextBlock,
  type PositionedTextSource,
} from './pdfTextBlocks';
import {
  buildFontDescriptor,
  loadFontkit,
  type PdfFontDescriptor,
} from './pdfFontResolution';
import type { PdfSpaceRect } from './pdfNativeTextPlanning';

export interface PageTextBlocks {
  blocks: PdfTextBlock[];
  fonts: Map<string, PdfFontDescriptor>;
  /** False for scanned pages, where the only way to get text is OCR. */
  hasTextLayer: boolean;
  /** Page size in PDF points, matching the scale-1 viewport the blocks are positioned in. */
  pageWidth: number;
  pageHeight: number;
}

/**
 * Unrotated PDF page-space bounds for one text item, derived from its own text matrix. The editor
 * needs these to find the same run again inside the real PDF when it saves.
 */
const sourceRectFromTransform = (
  itemTransform: number[],
  width: number,
  height: number,
): PdfSpaceRect | undefined => {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = itemTransform || [];
  if (![a, b, c, d, e, f].every(Number.isFinite)) return undefined;

  const advanceLength = Math.hypot(a, b);
  const advanceX = advanceLength > 0 ? (a / advanceLength) * width : width;
  const advanceY = advanceLength > 0 ? (b / advanceLength) * width : 0;
  const riseLength = Math.hypot(c, d);
  const riseHeight = Math.max(1, height || riseLength);
  const riseX = riseLength > 0 ? (c / riseLength) * riseHeight : 0;
  const riseY = riseLength > 0 ? (d / riseLength) * riseHeight : riseHeight;

  const corners = [
    [e, f],
    [e + advanceX, f + advanceY],
    [e + riseX, f + riseY],
    [e + advanceX + riseX, f + advanceY + riseY],
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);

  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/**
 * Rebuild a page's paragraphs and collect the fonts they use.
 *
 * Blocks are positioned in scale-1 viewport pixels, which for a PDF is the same as points, so the
 * caller can scale them to whatever zoom the page is displayed at without re-extracting.
 */
export const getPageTextBlocks = async (
  pdfDoc: any,
  pageIndex: number,
  { readFonts = false }: { readFonts?: boolean } = {},
): Promise<PageTextBlocks> => {
  const page = await pdfDoc.getPage(pageIndex + 1);
  // A page the reader is looking at gets its fonts read now: PDF.js publishes a font only while
  // building a page's drawing operations, and with the standard faces loaded from disk that no
  // longer happens as a side effect of rendering in time for this call. It costs a few
  // milliseconds a page, which is why a whole-document scan asks for it only where it matters.
  //
  // Failing at it is survivable and must stay that way. The descriptors simply stay 'pending',
  // which every caller already reads as "not known yet" rather than "not available", so nothing
  // is refused on the strength of the gap. Letting it throw would lose every paragraph on the
  // page instead, leaving a document that looks fine and silently cannot be edited.
  if (readFonts) await page.getOperatorList().catch(() => undefined);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent({
    includeMarkedContent: false,
    disableNormalization: false,
  });

  const items: PositionedTextSource[] = positionTextItems(
    textContent.items,
    viewport.transform,
    pdfjsLib.Util.transform,
    viewport.scale,
    sourceRectFromTransform,
  );

  const hasTextLayer = items.some((item) => item.text.trim() !== '');
  if (!hasTextLayer) {
    return {
      blocks: [],
      fonts: new Map(),
      hasTextLayer: false,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    };
  }

  const blocks = buildTextBlocks(items, pageIndex);

  // The embedded font programs only become readable once the page has rendered, and glyph coverage
  // cannot be checked at all until fontkit is present. Both are awaited here so every block in the
  // returned set resolves its typeface consistently.
  await loadFontkit();
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    await document.fonts.ready.catch(() => undefined);
  }

  const fonts = new Map<string, PdfFontDescriptor>();
  blocks.forEach((block) => block.lines.forEach((line) => line.runs.forEach((run) => {
    if (!run.fontKey || fonts.has(run.fontKey)) return;
    fonts.set(run.fontKey, buildFontDescriptor(page, run.fontKey, textContent.styles));
  })));

  return {
    blocks,
    fonts,
    hasTextLayer: true,
    pageWidth: viewport.width,
    pageHeight: viewport.height,
  };
};

/**
 * Read a page's real fonts and upgrade the descriptors in place.
 *
 * PDF.js publishes a font's program only while it builds a page's drawing operations, so a page
 * that was scanned for its text alone knows nothing about the faces it uses. Asking for the
 * operator list is what makes them appear — measured at 4-25 ms a page against these documents,
 * far short of a full render — and it is only worth doing where the answer would otherwise be a
 * guess: a paragraph about to be redrawn, or one about to be refused.
 */
export const resolvePageFonts = async (
  pdfDoc: any,
  pageIndex: number,
  fonts: Map<string, PdfFontDescriptor>,
): Promise<boolean> => {
  const pending = [...fonts.values()].filter((descriptor) => descriptor.resolution === 'pending');
  if (pending.length === 0) return false;

  const page = await pdfDoc.getPage(pageIndex + 1);
  await page.getOperatorList();
  const styles = (await page.getTextContent()).styles;

  let upgraded = false;
  pending.forEach((descriptor) => {
    const next = buildFontDescriptor(page, descriptor.key, styles);
    if (next.resolution !== 'read') return;
    fonts.set(descriptor.key, next);
    upgraded = true;
  });
  return upgraded;
};
