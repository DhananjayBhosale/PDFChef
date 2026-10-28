import assert from 'node:assert/strict';
import test from 'node:test';
import { jpegExifOrientation } from '../../services/jpegOrientation.ts';

/** SOI, an optional APP1 Exif segment holding one orientation entry, then start of scan. */
const jpeg = (orientation?: number, littleEndian = false) => {
  const parts: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    const tiff = new DataView(new ArrayBuffer(8 + 2 + 12 + 4));
    tiff.setUint16(0, littleEndian ? 0x4949 : 0x4d4d);
    tiff.setUint16(2, 42, littleEndian);
    tiff.setUint32(4, 8, littleEndian);
    tiff.setUint16(8, 1, littleEndian);
    tiff.setUint16(10, 0x0112, littleEndian);
    tiff.setUint16(12, 3, littleEndian);
    tiff.setUint32(14, 1, littleEndian);
    tiff.setUint16(18, orientation, littleEndian);
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...new Uint8Array(tiff.buffer)];
    parts.push(0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body);
  }
  parts.push(0xff, 0xda, 0, 2);
  return new Uint8Array(parts);
};

test('a JPEG without EXIF, or marked upright, reads as upright', () => {
  assert.equal(jpegExifOrientation(jpeg()), 1);
  assert.equal(jpegExifOrientation(jpeg(1)), 1);
});

test('turned and flipped JPEGs report their orientation in either byte order', () => {
  assert.equal(jpegExifOrientation(jpeg(6)), 6);
  assert.equal(jpegExifOrientation(jpeg(3, true)), 3);
});

test('bytes that are not a readable JPEG are unknown', () => {
  assert.equal(jpegExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(jpegExifOrientation(jpeg(6).subarray(0, 20)), null);
});
