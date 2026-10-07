import english from './i18n/en-US.ts';
export const PDF_TEXT_OVERFLOW_MESSAGE = english["error.pdfTextOverflow"];

/** Both rectangles use PDF coordinates: [left, bottom, right, top]. */
export const boundsFitWithinCropBox = (
  bounds: readonly number[],
  cropBox: readonly number[],
  tolerance = 0.25,
): boolean => {
  if (
    bounds.length !== 4
    || cropBox.length !== 4
    || !bounds.every(Number.isFinite)
    || !cropBox.every(Number.isFinite)
    || !Number.isFinite(tolerance)
    || tolerance < 0
  ) return false;

  const left = Math.min(bounds[0], bounds[2]);
  const bottom = Math.min(bounds[1], bounds[3]);
  const right = Math.max(bounds[0], bounds[2]);
  const top = Math.max(bounds[1], bounds[3]);
  const cropLeft = Math.min(cropBox[0], cropBox[2]);
  const cropBottom = Math.min(cropBox[1], cropBox[3]);
  const cropRight = Math.max(cropBox[0], cropBox[2]);
  const cropTop = Math.max(cropBox[1], cropBox[3]);

  return cropRight > cropLeft
    && cropTop > cropBottom
    && left >= cropLeft - tolerance
    && bottom >= cropBottom - tolerance
    && right <= cropRight + tolerance
    && top <= cropTop + tolerance;
};
