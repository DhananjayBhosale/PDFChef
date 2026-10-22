import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { localizeError } from '../../services/i18n/errors.ts';
import {
  ImageOpenError,
  imageProblemOf,
  problemAfterFailedDecode,
  problemBeforeDecode,
  readImageDimensions,
  readJpegFrame,
  skippedImagesMessage,
} from '../../services/imageIntake.ts';

const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((part) =>
  typeof part === 'string' ? [...part].map((char) => char.charCodeAt(0)) : part));
const u16be = (value: number) => [value >> 8, value & 0xff];
const u16le = (value: number) => [value & 0xff, value >> 8];
const u24le = (value: number) => [value & 0xff, (value >> 8) & 0xff, value >> 16];
const u32be = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const i32le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];

const png = (width: number, height: number) =>
  bytes([0x89], 'PNG\r\n\x1a\n', u32be(13), 'IHDR', u32be(width), u32be(height), [8, 6, 0, 0, 0]);

/** A camera JPEG: a large EXIF block first, then a progressive frame header. */
const cameraJpeg = (width: number, height: number) => {
  const exif = new Array(60_000).fill(0);
  return bytes([0xff, 0xd8, 0xff, 0xe1], u16be(exif.length + 2), exif,
    [0xff, 0xc2], u16be(17), [8], u16be(height), u16be(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
};

test('a picture size is read from the file header, for every format a phone picks', () => {
  assert.deepEqual(readImageDimensions(png(30_000, 30_000)), { width: 30_000, height: 30_000 });
  assert.deepEqual(readImageDimensions(bytes('GIF89a', u16le(640), u16le(480), [0, 0, 0])), { width: 640, height: 480 });
  // A top-down BMP stores its height as a negative number.
  assert.deepEqual(readImageDimensions(bytes('BM', new Array(16).fill(0), i32le(800), i32le(-600), [1, 0, 24, 0])), { width: 800, height: 600 });
  const webp = (chunk: string, body: number[]) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [0, 0, 0, 0], body, new Array(8).fill(0));
  assert.deepEqual(readImageDimensions(webp('VP8X', [0, 0, 0, 0, ...u24le(4095), ...u24le(2047)])), { width: 4096, height: 2048 });
  const lossless = (1023) | (767 << 14);
  assert.deepEqual(readImageDimensions(webp('VP8L', [0x2f, ...i32le(lossless)])), { width: 1024, height: 768 });
  assert.deepEqual(readImageDimensions(webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(1920), ...u16le(1080)])), { width: 1920, height: 1080 });
  assert.equal(readImageDimensions(bytes('not a picture at all, just some text')), null);
});

test('a JPEG frame is found after the EXIF block, with its kind and colour channels', () => {
  const photo = new Uint8Array(readFileSync(new URL('../fixtures/photos/wide.jpg', import.meta.url)));
  assert.deepEqual(readJpegFrame(photo), { marker: 0xc0, width: 40, height: 20, components: 3 });
  assert.deepEqual(readJpegFrame(cameraJpeg(30_000, 20_000)), { marker: 0xc2, width: 30_000, height: 20_000, components: 3 });
  assert.deepEqual(readImageDimensions(cameraJpeg(30_000, 20_000)), { width: 30_000, height: 20_000 });
  // Cut off before the frame header: no size rather than a wrong one.
  assert.equal(readJpegFrame(cameraJpeg(30_000, 20_000).slice(0, 1000)), null);
});

test('a 30000 x 30000 picture is refused as too large before it is decoded', () => {
  assert.equal(problemBeforeDecode({ width: 30_000, height: 30_000 }), 'too-large');
  assert.equal(problemBeforeDecode({ width: 8192, height: 6144 }), null);
  assert.equal(problemBeforeDecode(null), null);
});

test('a picture that fails to open is called too large only when its size explains it', () => {
  assert.equal(problemAfterFailedDecode({ width: 6000, height: 4000 }), 'too-large');
  assert.equal(problemAfterFailedDecode({ width: 4000, height: 3000 }), 'unreadable');
  assert.equal(problemAfterFailedDecode(null), 'unreadable');
});

test('the open error says "too large" and keeps its reason', () => {
  const error = new ImageOpenError('too-large');
  assert.equal(localizeError(error), 'This picture is too large to open. Try a smaller copy.');
  assert.equal(imageProblemOf(error), 'too-large');
  assert.equal(imageProblemOf(new ImageOpenError('unreadable')), 'unreadable');
  assert.equal(imageProblemOf(new Error('decode failed')), 'unreadable');
});

test('one notice names every picture that was left out, and why', () => {
  assert.equal(
    skippedImagesMessage([{ name: 'huge.png', problem: 'too-large' }, { name: 'broken.heic', problem: 'unreadable' }]),
    '1 picture is too large to open, so it was left out: huge.png. Try a smaller copy. '
      + '1 picture could not be opened, so it was left out: broken.heic. Try a JPG or PNG copy.',
  );
  const many = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'].map((name) => ({ name, problem: 'too-large' as const }));
  assert.equal(
    skippedImagesMessage(many),
    '5 pictures are too large to open, so they were left out: a.png, b.png, c.png and 2 more. Try smaller copies.',
  );
  assert.equal(skippedImagesMessage([]), '');
});
