import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_IMAGE_EDGE_PX, planImageNormalization } from '../../services/imageNormalization.ts';

test('a 50 megapixel photo is brought down to the long-edge cap, keeping its shape', () => {
  const plan = planImageNormalization(8192, 6144, 'image/jpeg');
  assert.equal(plan.width, MAX_IMAGE_EDGE_PX);
  assert.equal(plan.height, 2250);
  assert.ok(Math.abs(plan.width / plan.height - 8192 / 6144) < 0.001);
});

test('a portrait photo is capped on its tall side', () => {
  const plan = planImageNormalization(3000, 4000, 'image/jpeg');
  assert.deepEqual([plan.width, plan.height], [2250, MAX_IMAGE_EDGE_PX]);
});

test('a small image is never upscaled', () => {
  const plan = planImageNormalization(640, 480, 'image/png');
  assert.deepEqual([plan.width, plan.height], [640, 480]);
});

test('JPEG stays JPEG at the existing quality and PNG stays PNG without a fill', () => {
  assert.deepEqual(planImageNormalization(100, 100, 'image/jpeg'), {
    width: 100, height: 100, outputType: 'image/jpeg', quality: 0.94, fill: null,
  });
  assert.deepEqual(planImageNormalization(100, 100, 'image/png'), {
    width: 100, height: 100, outputType: 'image/png', fill: null,
  });
});

test('other formats become a JPEG drawn on white', () => {
  for (const type of ['image/webp', 'image/gif', 'image/bmp', 'image/avif', '']) {
    assert.deepEqual(planImageNormalization(100, 100, type), {
      width: 100, height: 100, outputType: 'image/jpeg', quality: 0.92, fill: '#ffffff',
    }, type);
  }
});
