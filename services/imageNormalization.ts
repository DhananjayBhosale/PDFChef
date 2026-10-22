/**
 * How a picked image is resized and re-encoded before any tool uses it.
 *
 * A phone photo can be 50 megapixels, which is a 200 MB canvas and a multi-second encode on a
 * low-memory device. The cap is on the pixel count, not the long edge, so a long scrolling
 * screenshot keeps its width and text, and a 12 MP phone photo (up to 4080 x 3072) is left at its
 * full size. Larger photos come down to about 4,100 x 3,070, still over 350 dpi on an A4 page.
 * Nothing is ever upscaled.
 */
export const MAX_IMAGE_PIXELS = 12_600_000;

/**
 * Phones with about 4 GB of memory get a lower cap: about 3,050 x 2,290 for a 4:3 photo, still
 * over 250 dpi on an A4 page. Android reports a "4 GB" phone as under 4 GiB and a "6 GB" one as
 * about 5.5 GiB, so the line sits between them.
 */
export const LOW_MEMORY_IMAGE_PIXELS = 7_000_000;
const LOW_MEMORY_DEVICE_BYTES = 4.5 * 1024 ** 3;

/** The photo cap for a device with this much memory. Unknown memory keeps the full cap. */
export const imagePixelCapForMemory = (memoryBytes: number | null | undefined): number =>
  typeof memoryBytes === 'number' && memoryBytes > 0 && memoryBytes < LOW_MEMORY_DEVICE_BYTES
    ? LOW_MEMORY_IMAGE_PIXELS
    : MAX_IMAGE_PIXELS;

let deviceMemory: (() => Promise<number | null | undefined>) | null = null;
let devicePixelCap: Promise<number> | null = null;

/** The platform says how much memory the device has, so photos are sized to suit it. */
export const setDeviceMemorySource = (read: (() => Promise<number | null | undefined>) | null) => {
  deviceMemory = read;
  devicePixelCap = null;
};

/** The pixel cap for photos on this device, asked once per session. A failed ask keeps the full cap and asks again next time. */
export const photoPixelCap = (): Promise<number> => devicePixelCap ??= (async () => {
  try {
    return imagePixelCapForMemory(deviceMemory ? await deviceMemory() : null);
  } catch {
    devicePixelCap = null;
    return MAX_IMAGE_PIXELS;
  }
})();

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
  /** A smaller cap for pictures that only ever print small, such as a signature or a logo. */
  maxPixels = MAX_IMAGE_PIXELS,
): ImageNormalizationPlan => {
  const pixels = sourceWidth * sourceHeight;
  const ratio = pixels > maxPixels ? Math.sqrt(maxPixels / pixels) : 1;
  // Rounding down keeps a scaled image inside the cap.
  const width = Math.max(1, ratio < 1 ? Math.floor(sourceWidth * ratio) : sourceWidth);
  const height = Math.max(1, ratio < 1 ? Math.floor(sourceHeight * ratio) : sourceHeight);
  if (mimeType === 'image/jpeg') return { width, height, outputType: 'image/jpeg', quality: 0.94, fill: null };
  if (mimeType === 'image/png') return { width, height, outputType: 'image/png', fill: null };
  return { width, height, outputType: 'image/jpeg', quality: 0.92, fill: '#ffffff' };
};
