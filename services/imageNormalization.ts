/**
 * How a picked image is resized and re-encoded before any tool uses it.
 *
 * A phone photo can be 50 megapixels, which is a 200 MB canvas and a multi-second encode on a
 * low-memory device. Fitted onto an A4 page, 3,000 px on the long edge is still about 270 dpi,
 * so photographed documents keep their small text while the pixel count drops by an order of
 * magnitude. Nothing is ever upscaled.
 */
export const MAX_IMAGE_EDGE_PX = 3000;

export interface ImageNormalizationPlan {
  width: number;
  height: number;
  outputType: 'image/jpeg' | 'image/png';
  /** Encoder quality; absent for PNG, which is lossless. */
  quality?: number;
  /** Painted under the image first, so pixels without alpha support do not come out black. */
  fill: string | null;
}

/**
 * JPEG stays JPEG and PNG stays PNG, so signatures and screenshots keep their transparency.
 * Every other format becomes a JPEG on white: pdf-lib embeds only JPEG and PNG, and a PNG of a
 * photo would be far larger than the original.
 */
export const planImageNormalization = (
  sourceWidth: number,
  sourceHeight: number,
  mimeType: string,
): ImageNormalizationPlan => {
  const longEdge = Math.max(sourceWidth, sourceHeight);
  const ratio = longEdge > MAX_IMAGE_EDGE_PX ? MAX_IMAGE_EDGE_PX / longEdge : 1;
  const width = Math.max(1, Math.round(sourceWidth * ratio));
  const height = Math.max(1, Math.round(sourceHeight * ratio));
  if (mimeType === 'image/jpeg') return { width, height, outputType: 'image/jpeg', quality: 0.94, fill: null };
  if (mimeType === 'image/png') return { width, height, outputType: 'image/png', fill: null };
  return { width, height, outputType: 'image/jpeg', quality: 0.92, fill: '#ffffff' };
};
