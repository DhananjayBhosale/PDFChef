import { LocalizedError } from './i18n/errors.ts';
import { t } from './i18n/core.ts';

/**
 * Whether a picked picture can be opened at all, and how to say so when it cannot.
 *
 * The size is read from the file's own header, which costs a few bytes, so a picture that would
 * need gigabytes to decode is turned away before the phone tries.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

/** 16,384 x 16,384 is a gigabyte of pixels. No phone decodes a picture past it. */
export const MAX_OPENABLE_IMAGE_PIXELS = 16_384 * 16_384;

/**
 * Android WebView refuses a PNG or WebP above about 1/128 of the phone's memory in pixels: 16 MP
 * on a 2 GB phone. A picture past this that still fails to open was most likely refused for size.
 */
const SIZE_REFUSAL_PIXELS = 16_000_000;

/** Enough of the file to reach a JPEG's size, which comes after the camera's EXIF block. */
export const IMAGE_HEADER_BYTES = 256 * 1024;

export type ImageProblem = 'unreadable' | 'too-large';

const u16be = (bytes: Uint8Array, at: number) => (bytes[at] << 8) | bytes[at + 1];
const u16le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8);
const u24le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
const u32be = (bytes: Uint8Array, at: number) => ((bytes[at] << 24) >>> 0) + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
const i32le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24);
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

export interface JpegFrame extends ImageDimensions {
  /** C0 baseline, C1 extended, C2 progressive; the rest are kinds few readers decode. */
  marker: number;
  components: number;
}

/** A JPEG's start-of-frame header: its size, kind and colour channels. */
export const readJpegFrame = (bytes: Uint8Array): JpegFrame | null => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    // Start of frame, any kind; C4, C8 and CC share the range but are other tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { marker, width: u16be(bytes, at + 7), height: u16be(bytes, at + 5), components: bytes[at + 9] };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    at += 2 + u16be(bytes, at + 2);
  }
  return null;
};

const jpegDimensions = (bytes: Uint8Array): ImageDimensions | null => {
  const frame = readJpegFrame(bytes);
  return frame && { width: frame.width, height: frame.height };
};

/** The stored size of a PNG, JPEG, GIF, WebP or BMP, before any EXIF turn; null for anything else. */
export const readImageDimensions = (bytes: Uint8Array): ImageDimensions | null => {
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') {
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes);
  if (bytes.length >= 10 && ascii(bytes, 0, 4) === 'GIF8') {
    return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }
  if (bytes.length >= 26 && ascii(bytes, 0, 2) === 'BM') {
    return { width: Math.abs(i32le(bytes, 18)), height: Math.abs(i32le(bytes, 22)) };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8X') return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
    if (chunk === 'VP8 ') return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
  }
  return null;
};

/** Refuse before decoding only what no phone could decode. */
export const problemBeforeDecode = (size: ImageDimensions | null): ImageProblem | null =>
  size && size.width * size.height > MAX_OPENABLE_IMAGE_PIXELS ? 'too-large' : null;

export const problemAfterFailedDecode = (size: ImageDimensions | null): ImageProblem =>
  size && size.width * size.height > SIZE_REFUSAL_PIXELS ? 'too-large' : 'unreadable';

export class ImageOpenError extends LocalizedError {
  readonly problem: ImageProblem;

  constructor(problem: ImageProblem) {
    super(problem === 'too-large'
      ? "image-intake.this.picture.is.too.large.to.open.c199e6"
      : "image-browser.image.could.not.be.decoded.7984a8");
    this.problem = problem;
  }
}

export const imageProblemOf = (error: unknown): ImageProblem =>
  error instanceof ImageOpenError ? error.problem : 'unreadable';

export interface SkippedImage {
  name: string;
  problem: ImageProblem;
}

const LISTED_NAMES = 3;

const listNames = (names: string[]) => names.length <= LISTED_NAMES
  ? names.join(', ')
  : t("image-intake.and.more.7610e3", {
    v0: names.slice(0, LISTED_NAMES).join(', '),
    v1: names.length - LISTED_NAMES,
  });

/** One notice that names every picture that was left out, and why. */
export const skippedImagesMessage = (skipped: readonly SkippedImage[]): string => {
  const tooLarge = skipped.filter((item) => item.problem === 'too-large').map((item) => item.name);
  const unreadable = skipped.filter((item) => item.problem !== 'too-large').map((item) => item.name);
  return [
    tooLarge.length
      ? t("image-intake.pictures.are.too.large.to.open.so.cacf65", { count: tooLarge.length, v1: listNames(tooLarge) })
      : '',
    unreadable.length
      ? t("image-intake.pictures.could.not.be.opened.so.they.eabd9f", { count: unreadable.length, v1: listNames(unreadable) })
      : '',
  ].filter(Boolean).join(' ');
};
