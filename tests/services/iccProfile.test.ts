import assert from 'node:assert/strict';
import test from 'node:test';
import { isSRGBProfile } from '../../services/iccProfile.ts';

const SRGB = [[0.4361, 0.2225, 0.0139], [0.3851, 0.7169, 0.0971], [0.1431, 0.0606, 0.7141]];
const DISPLAY_P3 = [[0.5151, 0.2412, -0.0011], [0.292, 0.6922, 0.0419], [0.1571, 0.0666, 0.7841]];

/** A minimal RGB matrix/curve profile: three XYZ primaries sharing one tone curve. */
const profile = (primaries: number[][], curve: number[], space = 'RGB ') => {
  const bytes = new Uint8Array(132 + 6 * 12 + 3 * 20 + curve.length * 4);
  const view = new DataView(bytes.buffer);
  const write = (at: number, text: string) => [...text].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  write(16, space);
  view.setUint32(128, 6);
  const curveAt = 132 + 6 * 12 + 3 * 20;
  ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'].forEach((tag, index) => {
    const entry = 132 + index * 12;
    write(entry, tag);
    view.setUint32(entry + 4, index < 3 ? 132 + 6 * 12 + index * 20 : curveAt);
  });
  primaries.forEach((xyz, index) => {
    const at = 132 + 6 * 12 + index * 20;
    write(at, 'XYZ ');
    xyz.forEach((value, axis) => view.setInt32(at + 8 + axis * 4, Math.round(value * 65536)));
  });
  curve.forEach((word, index) => view.setUint32(curveAt + index * 4, word));
  return bytes;
};
const curv = (...words: number[]) => [0x63757276, 0, ...words];
const gamma = (value: number) => curv(1, Math.round(value * 256) << 16);
// parametricCurveType function 3 with the sRGB constants, as s15Fixed16 numbers.
const srgbPara = [0x70617261, 0, 3 << 16, ...[2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045]
  .map(value => Math.round(value * 65536) >>> 0)];

test('an embedded sRGB profile counts as sRGB', () => {
  assert.equal(isSRGBProfile(profile(SRGB, gamma(2.2))), true);
  assert.equal(isSRGBProfile(profile(SRGB, srgbPara)), true);
});

test('wider gamuts, other tone curves and non-RGB profiles keep their pictures untouched', () => {
  assert.equal(isSRGBProfile(profile(DISPLAY_P3, gamma(2.2))), false);
  assert.equal(isSRGBProfile(profile(SRGB, gamma(1.8))), false);
  assert.equal(isSRGBProfile(profile(SRGB, curv(0))), false);
  assert.equal(isSRGBProfile(profile(SRGB, gamma(2.2), 'GRAY')), false);
});

test('a truncated or empty profile is not trusted', () => {
  assert.equal(isSRGBProfile(profile(SRGB, gamma(2.2)).subarray(0, 180)), false);
  assert.equal(isSRGBProfile(new Uint8Array(0)), false);
});
