import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOW_MEMORY_IMAGE_PIXELS,
  MAX_IMAGE_PIXELS,
  imagePixelCapForMemory,
  photoPixelCap,
  planImageNormalization,
  setDeviceMemorySource,
} from '../../services/imageNormalization.ts';

test('a 50 megapixel photo is brought under the pixel cap, keeping its shape', () => {
  const plan = planImageNormalization(8192, 6144, 'image/jpeg');
  assert.deepEqual([plan.width, plan.height], [4098, 3074]);
  assert.ok(plan.width * plan.height <= MAX_IMAGE_PIXELS);
  assert.ok(Math.abs(plan.width / plan.height - 8192 / 6144) < 0.001);
});

test('12 MP phone photos keep their full size, in either orientation', () => {
  for (const [width, height] of [[4000, 3000], [4032, 3024], [4080, 3072], [3072, 4080]]) {
    const plan = planImageNormalization(width, height, 'image/jpeg');
    assert.deepEqual([plan.width, plan.height], [width, height]);
  }
});

test('a long scrolling screenshot keeps its width until it passes the pixel cap', () => {
  const long = planImageNormalization(1080, 7000, 'image/png');
  assert.deepEqual([long.width, long.height], [1080, 7000]);
  const tall = planImageNormalization(1080, 20000, 'image/png');
  assert.ok(tall.width >= 800, `width ${tall.width}`);
  assert.ok(tall.width * tall.height <= MAX_IMAGE_PIXELS);
});

test('a signature or logo cap brings a 12 MP photo down to that cap, keeping its shape', () => {
  for (const cap of [2_000_000, 500_000]) {
    const plan = planImageNormalization(4000, 3000, 'image/jpeg', cap);
    assert.ok(plan.width * plan.height <= cap, `${plan.width} x ${plan.height} for ${cap}`);
    assert.ok(plan.width * plan.height > cap * 0.99, `${plan.width} x ${plan.height} for ${cap}`);
    assert.ok(Math.abs(plan.width / plan.height - 4 / 3) < 0.001);
  }
  const small = planImageNormalization(600, 200, 'image/png', 500_000);
  assert.deepEqual([small.width, small.height], [600, 200]);
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

test('phones with about 4 GB of memory get the lower photo cap; 6 GB and up keep the full one', () => {
  const GiB = 1024 ** 3;
  // What Android reports as total memory for 3, 4, 6 and 8 GB phones.
  assert.equal(imagePixelCapForMemory(2.7 * GiB), LOW_MEMORY_IMAGE_PIXELS);
  assert.equal(imagePixelCapForMemory(3.7 * GiB), LOW_MEMORY_IMAGE_PIXELS);
  assert.equal(imagePixelCapForMemory(5.5 * GiB), MAX_IMAGE_PIXELS);
  assert.equal(imagePixelCapForMemory(7.4 * GiB), MAX_IMAGE_PIXELS);
  for (const unknown of [null, undefined, 0, -1, Number.NaN]) {
    assert.equal(imagePixelCapForMemory(unknown), MAX_IMAGE_PIXELS);
  }
  const plan = planImageNormalization(4080, 3072, 'image/jpeg', LOW_MEMORY_IMAGE_PIXELS);
  assert.ok(plan.width * plan.height <= LOW_MEMORY_IMAGE_PIXELS);
  assert.ok(plan.width >= 3000, `width ${plan.width}`);
});

test('the photo cap asks the device once, and a failed ask keeps the full cap and asks again', async () => {
  let asks = 0;
  try {
    setDeviceMemorySource(async () => { asks += 1; return 3.7 * 1024 ** 3; });
    assert.equal(await photoPixelCap(), LOW_MEMORY_IMAGE_PIXELS);
    assert.equal(await photoPixelCap(), LOW_MEMORY_IMAGE_PIXELS);
    assert.equal(asks, 1);

    let fail = true;
    setDeviceMemorySource(async () => {
      asks += 1;
      if (fail) throw new Error('unavailable');
      return 7.4 * 1024 ** 3;
    });
    assert.equal(await photoPixelCap(), MAX_IMAGE_PIXELS);
    fail = false;
    assert.equal(await photoPixelCap(), MAX_IMAGE_PIXELS);
    assert.equal(asks, 3);

    setDeviceMemorySource(null);
    assert.equal(await photoPixelCap(), MAX_IMAGE_PIXELS);
  } finally {
    setDeviceMemorySource(null);
  }
});
