import assert from 'node:assert/strict';
import test from 'node:test';
import { isOnWatermark } from '../../services/androidParity.ts';

// C4 (2026-11-25): in the zoomed large preview only a drag that starts on the text moves it.
test('a point on the rotated watermark text counts as on it; blank page does not', () => {
  const layout = { centerX: 300, centerY: 400, textWidth: 200, fontSize: 40, rotationDegrees: 45 };
  assert.equal(isOnWatermark(layout, 300, 400), true);
  const along = (distance: number) => [300 + distance * Math.SQRT1_2, 400 + distance * Math.SQRT1_2] as const;
  assert.equal(isOnWatermark(layout, ...along(95)), true, 'near the end of the text, along its slope');
  assert.equal(isOnWatermark(layout, ...along(140)), false, 'past the end of the text');
  assert.equal(isOnWatermark(layout, 300 + 95, 400), false, 'beside the text, off its slope');
  assert.equal(isOnWatermark(layout, 50, 50), false, 'a corner of the page');
});
