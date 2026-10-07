import { LocalizedError } from './i18n/errors.ts';
import english from './i18n/en-US.ts';
import { t } from './i18n/core.ts';
/**
 * Browser ports of the Android app's option parsing, clamping and layout maths, so the same
 * input produces the same output on both surfaces.
 *
 * Each export names the Kotlin declaration it mirrors. When a number here looks arbitrary it is
 * because it is not ours: it is the app's, and changing it on one side only is the bug this
 * module exists to prevent.
 */

/** `MAX_PDF_TEXT_LENGTH` in `processors/PdfToolProcessorSupport.kt`. */
export const MAX_PDF_TEXT_LENGTH = 140;

/** `sanitizePdfText` in `processors/OfflinePdfToolOptions.kt`. */
export const sanitizePdfText = (text: string): string =>
  text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * `outputBaseName` in `data/repository/OfflinePdfRepository.kt`.
 *
 * Splits on the *last* dot, so `report.v2.pdf` keeps `report.v2` instead of losing the middle,
 * and replaces everything outside `[A-Za-z0-9._-]` so the name survives any filesystem.
 */
export const outputBaseName = (sourceDisplayName: string): string => {
  const lastDot = sourceDisplayName.lastIndexOf('.');
  const withoutExtension = lastDot > 0 ? sourceDisplayName.slice(0, lastDot) : sourceDisplayName;
  const base = withoutExtension.trim() === '' ? 'document' : withoutExtension;
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
};

/**
 * `createOutputFile` in `data/repository/OfflinePdfRepository.kt`:
 * `${tool.storageSlug}_${timestamp}_${baseName}.${extension}`.
 *
 * The slug and timestamp are what make an app export identifiable after the fact, which is the
 * same reason a browser download needs them — `watermarked-file.pdf` collides with itself the
 * second time you run the tool.
 */
export const androidExportFileName = (
  storageSlug: string,
  sourceDisplayName: string,
  extension: string,
): string => `${storageSlug}_${Date.now()}_${outputBaseName(sourceDisplayName)}.${extension}`;

/**
 * `createOutputDirectory` in `data/repository/OfflinePdfRepository.kt`. The app writes a folder;
 * a browser can only hand back one file, so the same name becomes the zip name.
 */
export const androidExportDirectoryName = (
  sourceDisplayName: string,
  suffix: 'split_pdfs' | 'images' | 'files',
): string => `${outputBaseName(sourceDisplayName)}_${suffix}`;

/** `buildPageExportLabel` in `processors/OfflinePdfToolOptions.kt`. Takes 0-based indices. */
export const buildPageExportLabel = (pageIndices: number[]): string => {
  if (pageIndices.length === 0) return 'pages';
  const oneBased = pageIndices.map((index) => index + 1);
  if (oneBased.length === 1) return `page_${oneBased[0]}`;
  const contiguous = oneBased.every((value, index) => index === 0 || value === oneBased[index - 1] + 1);
  return contiguous
    ? `pages_${oneBased[0]}-${oneBased[oneBased.length - 1]}`
    : `pages_${oneBased.join('_')}`;
};

// ---------------------------------------------------------------------------
// Page selection — `resolvePageSelection` / `resolvePageOrder`
// ---------------------------------------------------------------------------

/** `resolvePageSelection` in `processors/PdfToolProcessorSupport.kt`. Returns 0-based indices. */
export const resolvePageSelection = (
  selectedPages: number[],
  totalPages: number,
  label: string,
): number[] => {
  if (selectedPages.length === 0) throw new LocalizedError("android-parity.must.include.at.least.one.page.7d294c", { v0: label });
  const resolved: number[] = [];
  for (const page of selectedPages) {
    if (!(page >= 1 && page <= totalPages)) {
      throw new LocalizedError("android-parity.page.is.out.of.range.1.2ceeda", { v0: page, v1: totalPages });
    }
    if (!resolved.includes(page - 1)) resolved.push(page - 1);
  }
  if (resolved.length === 0) throw new LocalizedError("android-parity.must.include.at.least.one.page.7d294c", { v0: label });
  return resolved;
};

/** `resolveOptionalPageSelection` in `processors/PdfToolProcessorSupport.kt`: empty means all. */
export const resolveOptionalPageSelection = (
  selectedPages: number[],
  totalPages: number,
  label: string,
): number[] => {
  if (selectedPages.length === 0) {
    return Array.from({ length: totalPages }, (_, index) => index);
  }
  return resolvePageSelection(selectedPages, totalPages, label).sort((a, b) => a - b);
};

/** `resolvePageOrder` in `processors/PdfToolProcessorSupport.kt`. Takes 1-based, returns 0-based. */
export const resolvePageOrder = (pageOrder: number[], totalPages: number): number[] => {
  if (pageOrder.length === 0) throw new LocalizedError("android-parity.page.order.is.required.example.3.1.2034af");
  const order = pageOrder.map((page) => {
    if (!(page >= 1 && page <= totalPages)) {
      throw new LocalizedError("android-parity.page.is.out.of.range.1.2ceeda", { v0: page, v1: totalPages });
    }
    return page - 1;
  });
  if (order.length !== totalPages) {
    throw new LocalizedError("android-parity.order.must.include.all.pages.exactly.once.1b6db3", { v0: totalPages });
  }
  if (new Set(order).size !== totalPages) {
    throw new LocalizedError("android-parity.duplicate.pages.found.in.order.each.page.4ba5e3");
  }
  return order;
};

/** `remainingPageIndices` in `pageselection/PageSelectionSupport.kt`. */
export const remainingPageIndices = (totalPages: number, removedPageIndices: Set<number>): number[] =>
  Array.from({ length: totalPages }, (_, index) => index).filter((index) => !removedPageIndices.has(index));

// ---------------------------------------------------------------------------
// Watermark — `watermark/WatermarkRenderSupport.kt`
// ---------------------------------------------------------------------------

export const DEFAULT_WATERMARK_TEXT = 'CONFIDENTIAL';
export const DEFAULT_WATERMARK_SIZE = 50;
export const DEFAULT_WATERMARK_OPACITY = 0.3;
export const DEFAULT_WATERMARK_ROTATION_DEGREES = -45;
export const WATERMARK_MIN_SIZE = 8;
export const WATERMARK_MAX_SIZE = 200;
export const DEFAULT_WATERMARK_COLOR_HEX = '#000000';
export const DEFAULT_WATERMARK_X_PERCENT = 0.5;
export const DEFAULT_WATERMARK_Y_PERCENT = 0.5;
export const WATERMARK_MIN_OPACITY = 0.05;
export const WATERMARK_MIN_ROTATION_DEGREES = -360;
export const WATERMARK_MAX_ROTATION_DEGREES = 360;

/** `sanitizeWatermarkText`: trimmed and capped, so a pasted essay cannot become a watermark. */
export const sanitizeWatermarkText = (raw: string): string => raw.trim().slice(0, MAX_PDF_TEXT_LENGTH);

const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export interface WatermarkPlacementState {
  xPercent: number;
  yPercent: number;
}

export interface WatermarkLayout {
  text: string;
  fontSize: number;
  rotationDegrees: number;
  centerX: number;
  centerY: number;
  offsetX: number;
  offsetY: number;
  baselineX: number;
  baselineY: number;
  textWidth: number;
  rotatedWidth: number;
  rotatedHeight: number;
  placement: WatermarkPlacementState;
}

/** `clampWatermarkCenter`: a mark wider than the page centres instead of hanging off an edge. */
const clampWatermarkCenter = (requestedCenter: number, pageExtent: number, contentExtent: number): number => {
  const safeContentExtent = Math.max(0, finiteOr(contentExtent, 0));
  if (safeContentExtent >= pageExtent) return pageExtent / 2;
  const halfExtent = safeContentExtent / 2;
  return clamp(requestedCenter, halfExtent, pageExtent - halfExtent);
};

/** `sanitizeWatermarkPlacement`: clamps against the *rotated* bounding box, not the raw text box. */
export const sanitizeWatermarkPlacement = (
  placement: WatermarkPlacementState,
  pageWidth: number,
  pageHeight: number,
  rotatedWidth: number,
  rotatedHeight: number,
): WatermarkPlacementState => {
  const safePageWidth = Math.max(1, pageWidth);
  const safePageHeight = Math.max(1, pageHeight);
  const requestedX = clamp(finiteOr(placement.xPercent, DEFAULT_WATERMARK_X_PERCENT), 0, 1);
  const requestedY = clamp(finiteOr(placement.yPercent, DEFAULT_WATERMARK_Y_PERCENT), 0, 1);
  return {
    xPercent: clampWatermarkCenter(requestedX * safePageWidth, safePageWidth, rotatedWidth) / safePageWidth,
    yPercent: clampWatermarkCenter(requestedY * safePageHeight, safePageHeight, rotatedHeight) / safePageHeight,
  };
};

/**
 * `watermarkLayout`. `yPercent` is measured from the *bottom* of the page, as in PDF user space,
 * which is why the preview has to flip it rather than reuse it as a CSS `top`.
 */
export const watermarkLayout = (options: {
  pageWidth: number;
  pageHeight: number;
  text: string;
  fontSize: number;
  rotationDegrees: number;
  placement?: WatermarkPlacementState;
  pageLeft?: number;
  pageBottom?: number;
  measureTextWidth: (text: string, fontSize: number) => number;
}): WatermarkLayout | null => {
  const safeText = sanitizeWatermarkText(options.text);
  if (!safeText) return null;

  const safePageWidth = Math.max(1, options.pageWidth);
  const safePageHeight = Math.max(1, options.pageHeight);
  const safeFontSize = clamp(
    finiteOr(options.fontSize, DEFAULT_WATERMARK_SIZE),
    WATERMARK_MIN_SIZE,
    WATERMARK_MAX_SIZE,
  );
  const safeRotationDegrees = finiteOr(options.rotationDegrees, DEFAULT_WATERMARK_ROTATION_DEGREES);
  const textWidth = Math.max(0, finiteOr(options.measureTextWidth(safeText, safeFontSize), 0));

  const rotationRadians = (safeRotationDegrees * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(rotationRadians));
  const absSin = Math.abs(Math.sin(rotationRadians));
  const rotatedWidth = absCos * textWidth + absSin * safeFontSize;
  const rotatedHeight = absSin * textWidth + absCos * safeFontSize;

  const placement = sanitizeWatermarkPlacement(
    options.placement ?? { xPercent: DEFAULT_WATERMARK_X_PERCENT, yPercent: DEFAULT_WATERMARK_Y_PERCENT },
    safePageWidth,
    safePageHeight,
    rotatedWidth,
    rotatedHeight,
  );

  const centerX = (options.pageLeft ?? 0) + placement.xPercent * safePageWidth;
  const centerY = (options.pageBottom ?? 0) + placement.yPercent * safePageHeight;
  const offsetX = -textWidth / 2;
  const offsetY = -safeFontSize / 2;

  return {
    text: safeText,
    fontSize: safeFontSize,
    rotationDegrees: safeRotationDegrees,
    centerX,
    centerY,
    offsetX,
    offsetY,
    baselineX: centerX + offsetX,
    baselineY: centerY + offsetY,
    textWidth,
    rotatedWidth,
    rotatedHeight,
    placement,
  };
};

/**
 * The glyph origin that reproduces PDFBox's `Matrix.getRotateInstance(theta, centerX, centerY)`
 * followed by `newLineAtOffset(offsetX, offsetY)`.
 *
 * pdf-lib's `drawText({ rotate })` turns the text about the origin it is given, so passing the
 * centre would swing the mark away from where the preview shows it. Rotating the offset by hand
 * and handing pdf-lib the resulting origin puts the rotation back around the centre.
 */
export const rotatedTextOrigin = (layout: WatermarkLayout): { x: number; y: number } => {
  const radians = (layout.rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: layout.centerX + layout.offsetX * cos - layout.offsetY * sin,
    y: layout.centerY + layout.offsetX * sin + layout.offsetY * cos,
  };
};

// ---------------------------------------------------------------------------
// Page numbers — `pagenumbers/PageNumberPlacementSupport.kt`
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_NUMBER_FORMAT = 'Page 1';
export const DEFAULT_PAGE_NUMBER_FONT_SIZE = 10;
export const MIN_PAGE_NUMBER_FONT_SIZE = 6;
export const MAX_PAGE_NUMBER_FONT_SIZE = 36;
export const DEFAULT_PAGE_NUMBER_X_PERCENT = 0.5;
export const DEFAULT_PAGE_NUMBER_Y_PERCENT = 0.045;

export const sanitizePageNumberFormat = (raw: string): string => raw.trim().slice(0, MAX_PDF_TEXT_LENGTH);

export const sanitizePageNumberFontSize = (raw: number): number =>
  Number.isFinite(raw)
    ? clamp(raw, MIN_PAGE_NUMBER_FONT_SIZE, MAX_PAGE_NUMBER_FONT_SIZE)
    : DEFAULT_PAGE_NUMBER_FONT_SIZE;

/**
 * `buildPageNumberText`.
 *
 * `{n}`/`{total}` win when present. Otherwise the *first* run of digits becomes the page number
 * and the *second* becomes the total, which is what makes the default-looking `Page 1 of 1`
 * behave as a template rather than leaving a stale total behind on every page.
 */
export const buildPageNumberText = (format: string, pageNumber: number, totalPages: number): string => {
  const safeFormat = sanitizePageNumberFormat(format) || DEFAULT_PAGE_NUMBER_FORMAT;

  if (safeFormat.includes('{n}') || safeFormat.includes('{total}')) {
    return safeFormat
      .replaceAll('{n}', String(pageNumber))
      .replaceAll('{total}', String(totalPages))
      .slice(0, MAX_PDF_TEXT_LENGTH);
  }

  const matches = [...safeFormat.matchAll(/\d+/g)];
  if (matches.length > 0) {
    let rebuilt = '';
    let lastIndex = 0;
    matches.forEach((match, index) => {
      const start = match.index ?? 0;
      rebuilt += safeFormat.slice(lastIndex, start);
      rebuilt += index === 0 ? String(pageNumber) : index === 1 ? String(totalPages) : match[0];
      lastIndex = start + match[0].length;
    });
    rebuilt += safeFormat.slice(lastIndex);
    return rebuilt.slice(0, MAX_PDF_TEXT_LENGTH);
  }

  return `${safeFormat} ${pageNumber}`.slice(0, MAX_PDF_TEXT_LENGTH);
};

export interface PageNumberPlacementState {
  xPercent: number;
  yPercent: number;
}

export interface PageNumberLayout {
  text: string;
  fontSize: number;
  centerX: number;
  centerY: number;
  baselineX: number;
  baselineY: number;
  textWidth: number;
  boxWidth: number;
  boxHeight: number;
  placement: PageNumberPlacementState;
}

/** `sanitizePageNumberPlacement`: keeps the whole label on the page at its own measured size. */
export const sanitizePageNumberPlacement = (options: {
  placement: PageNumberPlacementState;
  pageWidth: number;
  pageHeight: number;
  text: string;
  fontSize?: number;
  measureTextWidth: (text: string, fontSize: number) => number;
}): PageNumberPlacementState => {
  const safePageWidth = Math.max(1, options.pageWidth);
  const safePageHeight = Math.max(1, options.pageHeight);
  const safeFontSize = sanitizePageNumberFontSize(options.fontSize ?? DEFAULT_PAGE_NUMBER_FONT_SIZE);
  const safeText = sanitizePageNumberFormat(options.text) || '1';
  const rawTextWidth = Math.max(safeFontSize, options.measureTextWidth(safeText, safeFontSize));
  const textWidth = Math.min(rawTextWidth, safePageWidth);
  const halfWidth = textWidth / 2;
  const halfHeight = safeFontSize / 2;
  const centerX = clamp(clamp(options.placement.xPercent, 0, 1) * safePageWidth, halfWidth, safePageWidth - halfWidth);
  const centerY = clamp(clamp(options.placement.yPercent, 0, 1) * safePageHeight, halfHeight, safePageHeight - halfHeight);
  return { xPercent: centerX / safePageWidth, yPercent: centerY / safePageHeight };
};

/** `pageNumberLayout`. `yPercent` is from the bottom; `baselineY` sits half a line above centre. */
export const pageNumberLayout = (options: {
  pageWidth: number;
  pageHeight: number;
  text: string;
  placement: PageNumberPlacementState;
  fontSize?: number;
  measureTextWidth: (text: string, fontSize: number) => number;
}): PageNumberLayout | null => {
  const safeText = sanitizePageNumberFormat(options.text);
  if (!safeText) return null;

  const safeFontSize = sanitizePageNumberFontSize(options.fontSize ?? DEFAULT_PAGE_NUMBER_FONT_SIZE);
  const placement = sanitizePageNumberPlacement({
    placement: options.placement,
    pageWidth: options.pageWidth,
    pageHeight: options.pageHeight,
    text: safeText,
    fontSize: safeFontSize,
    measureTextWidth: options.measureTextWidth,
  });
  const safePageWidth = Math.max(1, options.pageWidth);
  const safePageHeight = Math.max(1, options.pageHeight);
  const textWidth = Math.min(
    Math.max(safeFontSize, options.measureTextWidth(safeText, safeFontSize)),
    safePageWidth,
  );
  const centerX = placement.xPercent * safePageWidth;
  const centerY = placement.yPercent * safePageHeight;

  return {
    text: safeText,
    fontSize: safeFontSize,
    centerX,
    centerY,
    baselineX: centerX - textWidth / 2,
    baselineY: centerY + safeFontSize / 2,
    textWidth,
    boxWidth: textWidth,
    boxHeight: safeFontSize,
    placement,
  };
};

/** `resolvePageNumberRange` in `processors/PdfToolProcessorSupport.kt`. */
export const resolvePageNumberRange = (
  startPage: number | null,
  endPage: number | null,
  totalPages: number,
): { startPage: number; endPage: number } => {
  const start = startPage ?? 1;
  const end = endPage ?? totalPages;
  if (!(start >= 1 && start <= totalPages)) {
    throw new LocalizedError("android-parity.start.page.is.out.of.range.1.dea5c9", { v0: start, v1: totalPages });
  }
  if (!(end >= 1 && end <= totalPages)) {
    throw new LocalizedError("android-parity.end.page.is.out.of.range.1.927fe9", { v0: end, v1: totalPages });
  }
  if (start > end) throw new LocalizedError("android-parity.start.page.must.be.less.than.or.28c57b");
  return { startPage: start, endPage: end };
};

// ---------------------------------------------------------------------------
// Page rotation — `pagerotation/PageRotationSupport.kt`
// ---------------------------------------------------------------------------

export const MIN_PAGE_ROTATION_DEGREES = -180;
export const MAX_PAGE_ROTATION_DEGREES = 180;
export const FINE_PAGE_ROTATION_STEP_DEGREES = 0.5;
const ROTATION_ZERO_EPSILON = 0.05;
const QUARTER_TURN_EPSILON = 0.05;

export const wrapPageRotationDegrees = (rawDegrees: number): number => {
  let normalized = rawDegrees % 360;
  if (normalized > MAX_PAGE_ROTATION_DEGREES) normalized -= 360;
  if (normalized < MIN_PAGE_ROTATION_DEGREES) normalized += 360;
  return normalized;
};

export const sanitizePageRotationDegrees = (rawDegrees: number): number => {
  if (!Number.isFinite(rawDegrees)) return 0;
  const snapped = Math.round(wrapPageRotationDegrees(rawDegrees) * 10) / 10;
  return Math.abs(snapped) <= ROTATION_ZERO_EPSILON ? 0 : snapped;
};

export const formatPageRotationDegrees = (rawDegrees: number): string => {
  const degrees = sanitizePageRotationDegrees(rawDegrees);
  const whole = Math.round(degrees);
  return Math.abs(degrees - whole) <= ROTATION_ZERO_EPSILON ? `${whole}°` : `${degrees.toFixed(1)}°`;
};

/**
 * `pageRotationMetadataDegreesOrNull`: a quarter turn can be expressed as `/Rotate` and keeps the
 * page's own content intact. Anything else has to be redrawn, so it returns null.
 */
export const pageRotationMetadataDegreesOrNull = (rawDegrees: number): number | null => {
  const degrees = sanitizePageRotationDegrees(rawDegrees);
  const roundedQuarterTurn = Math.round(degrees / 90) * 90;
  if (Math.abs(degrees - roundedQuarterTurn) > QUARTER_TURN_EPSILON) return null;
  return ((roundedQuarterTurn % 360) + 360) % 360;
};

/** `pageRotationFitScale`: shrinks a freely rotated page so its corners stay inside the sheet. */
export const pageRotationFitScale = (width: number, height: number, rawDegrees: number): number => {
  if (width <= 0 || height <= 0) return 1;
  const degrees = sanitizePageRotationDegrees(rawDegrees);
  if (degrees === 0) return 1;
  const radians = (degrees * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(radians));
  const absSin = Math.abs(Math.sin(radians));
  return clamp(
    Math.min(width / (width * absCos + height * absSin), height / (width * absSin + height * absCos)),
    0.01,
    1,
  );
};

// ---------------------------------------------------------------------------
// Compression — `data/model/CompressionProfile.kt`
// ---------------------------------------------------------------------------

export interface CompressionProfile {
  quality: number;
  estimateRatio: number;
  previewScale: number;
  previewJpegQuality: number;
  minScale: number;
  maxScale: number;
  maxPageDimension: number;
  jpegQuality: number;
}

const LOW_COMPRESSION_ANCHOR: CompressionProfile = {
  quality: 0,
  estimateRatio: 0.22,
  previewScale: 0.45,
  previewJpegQuality: 35,
  minScale: 0.5,
  maxScale: 1.0,
  maxPageDimension: 900,
  jpegQuality: 0.35,
};

const MEDIUM_COMPRESSION_ANCHOR: CompressionProfile = {
  quality: 0.5,
  estimateRatio: 0.58,
  previewScale: 0.78,
  previewJpegQuality: 72,
  minScale: 0.75,
  maxScale: 1.35,
  maxPageDimension: 1_600,
  jpegQuality: 0.72,
};

const HIGH_COMPRESSION_ANCHOR: CompressionProfile = {
  quality: 1,
  estimateRatio: 0.82,
  previewScale: 1,
  previewJpegQuality: 88,
  minScale: 0.85,
  maxScale: 1.45,
  maxPageDimension: 1_900,
  jpegQuality: 0.88,
};

const lerp = (start: number, end: number, progress: number) => start + (end - start) * progress;

/** `CompressionProfile.fromQuality`: the slider interpolates between three tuned anchors. */
export const compressionProfileFromQuality = (rawQuality: number): CompressionProfile => {
  const quality = clamp(finiteOr(rawQuality, 0.5), 0, 1);
  const [start, end, progress] =
    quality <= MEDIUM_COMPRESSION_ANCHOR.quality
      ? ([LOW_COMPRESSION_ANCHOR, MEDIUM_COMPRESSION_ANCHOR, quality / 0.5] as const)
      : ([MEDIUM_COMPRESSION_ANCHOR, HIGH_COMPRESSION_ANCHOR, (quality - 0.5) / 0.5] as const);

  return {
    quality,
    estimateRatio: lerp(start.estimateRatio, end.estimateRatio, progress),
    previewScale: lerp(start.previewScale, end.previewScale, progress),
    previewJpegQuality: Math.round(lerp(start.previewJpegQuality, end.previewJpegQuality, progress)),
    minScale: lerp(start.minScale, end.minScale, progress),
    maxScale: lerp(start.maxScale, end.maxScale, progress),
    maxPageDimension: lerp(start.maxPageDimension, end.maxPageDimension, progress),
    jpegQuality: lerp(start.jpegQuality, end.jpegQuality, progress),
  };
};

/** `CompressionProfile.estimatedOutputBytes`. */
export const estimatedCompressedBytes = (profile: CompressionProfile, originalSizeBytes: number): number => {
  const estimate = Math.trunc(originalSizeBytes * profile.estimateRatio);
  return Math.max(estimate, Math.min(originalSizeBytes, 180_000));
};

/** `parseCompressionQuality`: the app's level words map onto the same 0-1 slider. */
export const compressionQualityForLevel = (level: 'extreme' | 'recommended' | 'less'): number => {
  if (level === 'extreme') return 0;
  if (level === 'less') return 1;
  return 0.5;
};

/** `compressionQualityLabel`. */
export const compressionQualityLabel = (quality: number): string => {
  const normalized = clamp(quality, 0, 1);
  if (Math.abs(normalized - 0) <= 0.08) return t("android-parity.low.f793de");
  if (Math.abs(normalized - 0.5) <= 0.08) return t("android-parity.medium.8e588c");
  if (Math.abs(normalized - 1) <= 0.08) return t("android-parity.high.c4ebc6");
  return normalized < 0.5 ? 'Low-Medium' : 'Medium-High';
};

/** `compressionQualityPercent`. */
export const compressionQualityPercent = (quality: number): number => Math.round(clamp(quality, 0, 1) * 100);

/**
 * `calculateCompressScale` in `CompressionEngine.kt`: how far a page has to be scaled for its
 * longest side to land on the profile's target dimension, bounded by the profile's own limits.
 */
export const calculateCompressScale = (
  pageWidth: number,
  pageHeight: number,
  profile: CompressionProfile,
): number => {
  const longestSide = Math.max(1, Math.max(pageWidth, pageHeight));
  return clamp(profile.maxPageDimension / longestSide, profile.minScale, profile.maxScale);
};

/** Shared with `CompressionEngine.kt`, so a skipped image is skipped for the same reason. */
export const MIN_IMAGE_STREAM_BYTES = 8_000;
export const MIN_IMAGE_SAVINGS_BYTES = 8_192;
export const MIN_IMAGE_SAVINGS_RATIO = 0.08;

// ---------------------------------------------------------------------------
// Image export — `parseImageExportOptions` in `processors/OfflinePdfToolOptions.kt`
// ---------------------------------------------------------------------------

export const DEFAULT_IMAGE_EXPORT_FORMAT = 'jpg';
export const DEFAULT_IMAGE_EXPORT_QUALITY = 85;
export const DEFAULT_IMAGE_EXPORT_SCALE = 1.2;
export const MIN_IMAGE_EXPORT_QUALITY = 1;
export const MAX_IMAGE_EXPORT_QUALITY = 100;
export const MIN_IMAGE_EXPORT_SCALE = 0.75;
export const MAX_IMAGE_EXPORT_SCALE = 3;

export const sanitizeImageExportQuality = (raw: number): number =>
  clamp(Math.round(finiteOr(raw, DEFAULT_IMAGE_EXPORT_QUALITY)), MIN_IMAGE_EXPORT_QUALITY, MAX_IMAGE_EXPORT_QUALITY);

export const sanitizeImageExportScale = (raw: number): number =>
  clamp(finiteOr(raw, DEFAULT_IMAGE_EXPORT_SCALE), MIN_IMAGE_EXPORT_SCALE, MAX_IMAGE_EXPORT_SCALE);

/**
 * `PdfToJpgToolProcessor`: `page_07.jpg`, zero padded to at least two digits so a directory
 * listing sorts the way the document reads.
 */
export const imageExportPageFileName = (
  pageIndex: number,
  extension: string,
  highestPageIndex: number,
): string => {
  const width = Math.max(2, String(highestPageIndex + 1).length);
  return `page_${String(pageIndex + 1).padStart(width, '0')}.${extension}`;
};

/**
 * `PdfToJpgToolProcessor.writePageBitmap`: the requested scale rides on top of the adaptive scale
 * for a medium-quality profile, then the product is bounded again at render time.
 */
export const imageExportRenderScale = (
  pageWidth: number,
  pageHeight: number,
  requestedScale: number,
): number => {
  const adaptive = calculateCompressScale(pageWidth, pageHeight, compressionProfileFromQuality(0.5));
  return clamp(adaptive * sanitizeImageExportScale(requestedScale), 0.75, 4);
};

/** `parseImageExportOptions`: the app knows three output formats and defaults to JPEG. */
export const imageExportExtension = (mimeType: string): 'png' | 'webp' | 'jpg' => {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
};

// ---------------------------------------------------------------------------
// Shared user-facing failures, so both surfaces explain a refusal the same way
// ---------------------------------------------------------------------------

/** `ProtectPdfToolProcessor`. */
export const PASSWORD_REQUIRED_MESSAGE = english["android-parity.password.is.required.to.protect.a.pdf.5153a4"];
export const PASSWORD_TOO_SHORT_MESSAGE = english["android-parity.password.must.be.at.least.4.characters.cf116c"];
export const MIN_PROTECT_PASSWORD_LENGTH = 4;

/** `UnlockPdfToolProcessor`. */
export const UNLOCK_PASSWORD_REQUIRED_MESSAGE = english["android-parity.password.is.required.to.unlock.the.pdf.be2e2e"];
export const UNLOCK_FAILED_MESSAGE = english["android-parity.unable.to.unlock.pdf.check.password.and.5aefc8"];

/** `DeletePagesToolProcessor`. */
export const DELETE_ALL_PAGES_MESSAGE = english["android-parity.you.cannot.delete.all.pages.58dee9"];
export const MAX_DELETE_PAGES_INPUT_BYTES = 128 * 1024 * 1024;
export const DELETE_PAGES_TOO_LARGE_MESSAGE =
  english["android-parity.this.pdf.is.too.big.to.remove.b67882"];

export const NO_PAGES_MESSAGE = english["android-parity.selected.pdf.has.no.pages.3882f9"];
