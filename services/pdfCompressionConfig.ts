export type CompressionLevel = 'extreme' | 'recommended' | 'less';

export interface AdaptiveConfig {
  scale: number;
  quality: number;
  projectedDPI: number;
}

export const getAdaptiveConfig = (
  level: CompressionLevel,
  isTextHeavy: boolean,
): AdaptiveConfig => {
  const dpiMap: Record<CompressionLevel, number> = {
    extreme: 72,
    recommended: 144,
    less: 200,
  };
  const targetDPI = isTextHeavy ? Math.max(dpiMap[level], 96) : dpiMap[level];
  const baseQuality = level === 'extreme' ? 0.5 : level === 'recommended' ? 0.75 : 0.9;

  return {
    scale: Math.min(1, targetDPI / 144),
    quality: isTextHeavy ? Math.min(0.95, baseQuality + 0.08) : baseQuality,
    projectedDPI: targetDPI,
  };
};

export const getInterpolatedConfig = (
  sliderValue: number,
  isTextHeavy: boolean,
): AdaptiveConfig => {
  const minDPI = isTextHeavy ? 96 : 72;
  const maxDPI = 300;
  const dpi = minDPI + (sliderValue / 100) * (maxDPI - minDPI);

  return {
    scale: Math.min(1, dpi / 144),
    quality: 0.5 + (sliderValue / 200),
    projectedDPI: Math.round(dpi),
  };
};

export const calculateTargetSize = (
  originalSize: number,
  level: CompressionLevel,
  isTextHeavy: boolean,
): number => {
  const baseRatio = level === 'extreme' ? 0.3 : level === 'recommended' ? 0.6 : 0.9;
  const ratio = isTextHeavy ? Math.min(0.95, baseRatio + 0.12) : baseRatio;
  return Math.round(originalSize * ratio);
};

/**
 * The three preset ratios above, read as points on a curve so a slider between
 * them has a size to show at every stop rather than only at three of them.
 *
 * The anchors are the shipped presets, so a slider parked on a preset reports
 * exactly what that preset has always reported. Between and beyond them the
 * ratio is linear in DPI and clamped, which keeps it monotonic: moving the
 * slider towards Low can never predict a larger file.
 */
const RATIO_ANCHORS: ReadonlyArray<readonly [dpi: number, ratio: number]> = [
  [72, 0.3],
  [144, 0.6],
  [200, 0.9],
  [300, 0.98],
];

export const estimateCompressionRatio = (projectedDPI: number, isTextHeavy: boolean): number => {
  const first = RATIO_ANCHORS[0];
  const last = RATIO_ANCHORS[RATIO_ANCHORS.length - 1];

  let base: number;
  if (projectedDPI <= first[0]) base = first[1];
  else if (projectedDPI >= last[0]) base = last[1];
  else {
    const upperIndex = RATIO_ANCHORS.findIndex(([dpi]) => dpi >= projectedDPI);
    const [lowDPI, lowRatio] = RATIO_ANCHORS[upperIndex - 1];
    const [highDPI, highRatio] = RATIO_ANCHORS[upperIndex];
    base = lowRatio + ((projectedDPI - lowDPI) / (highDPI - lowDPI)) * (highRatio - lowRatio);
  }

  // Text and fonts compress poorly, so a text-heavy document keeps the same
  // penalty the presets already applied to it.
  return isTextHeavy ? Math.min(0.95, base + 0.12) : base;
};

export const estimateCompressedSize = (
  originalSize: number,
  config: AdaptiveConfig,
  isTextHeavy: boolean,
): number => Math.round(originalSize * estimateCompressionRatio(config.projectedDPI, isTextHeavy));

/* ------------------------------------------------- Measured estimates --- */

/**
 * The container the rasterised pages are written into: one PDF object per page
 * plus a fixed trailer. Small next to the images, but on a 200-page document it
 * is the difference between an estimate that lands and one that reads low.
 */
export const PDF_CONTAINER_OVERHEAD_BYTES = 900;
export const PDF_PER_PAGE_OVERHEAD_BYTES = 220;

export interface CompressionSizeMeasurement {
  /** Mean bytes the real encoder produced for the pages it actually sampled. */
  bytesPerPage: number;
  pageCount: number;
  sampledPages: number;
}

/**
 * Project a whole-document size from pages that were genuinely encoded.
 *
 * The ratio table this replaces was an average over someone else's corpus, so a
 * scanned page and a text page were predicted the same way and both were wrong.
 * Measuring a page through the export's own encoder and multiplying by the page
 * count describes *this* document instead.
 */
export const projectCompressedSize = ({
  bytesPerPage,
  pageCount,
  sampledPages,
}: CompressionSizeMeasurement): number => {
  if (!(bytesPerPage > 0) || !(pageCount > 0) || !(sampledPages > 0)) return 0;
  return Math.round(
    bytesPerPage * pageCount + PDF_PER_PAGE_OVERHEAD_BYTES * pageCount + PDF_CONTAINER_OVERHEAD_BYTES,
  );
};

/** Which pages to encode for a sample: the first, the middle, and the last. */
export const samplePageIndices = (pageCount: number, maxSamples = 3): number[] => {
  if (pageCount <= 0) return [];
  const wanted = Math.max(1, Math.min(maxSamples, pageCount));
  const picks = new Set<number>();
  for (let index = 0; index < wanted; index += 1) {
    // Spread the picks across the document so a title page or a trailing blank
    // cannot stand in for the whole thing.
    picks.add(Math.min(pageCount - 1, Math.round((index * (pageCount - 1)) / Math.max(1, wanted - 1))));
  }
  return [...picks].sort((first, second) => first - second);
};
