import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateTargetSize,
  getAdaptiveConfig,
  getInterpolatedConfig,
  projectCompressedSize,
  samplePageIndices,
} from '../../services/pdfCompressionConfig.ts';

test('compression presets stay within their intended quality order', () => {
  const extreme = getAdaptiveConfig('extreme', false);
  const recommended = getAdaptiveConfig('recommended', false);
  const less = getAdaptiveConfig('less', false);

  assert.ok(extreme.projectedDPI < recommended.projectedDPI);
  assert.ok(recommended.projectedDPI < less.projectedDPI);
  assert.ok(extreme.quality < recommended.quality);
  assert.ok(recommended.quality < less.quality);
});

test('text-heavy settings retain a safer quality floor', () => {
  const imageRich = getAdaptiveConfig('extreme', false);
  const textHeavy = getAdaptiveConfig('extreme', true);

  assert.equal(textHeavy.projectedDPI, 96);
  assert.ok(textHeavy.projectedDPI > imageRich.projectedDPI);
  assert.ok(textHeavy.quality > imageRich.quality);
});

test('slider and estimates remain bounded and deterministic', () => {
  assert.deepEqual(getInterpolatedConfig(0, false), {
    scale: 0.5,
    quality: 0.5,
    projectedDPI: 72,
  });
  assert.equal(getInterpolatedConfig(100, true).projectedDPI, 300);
  assert.equal(calculateTargetSize(1_000, 'recommended', false), 600);
  assert.equal(calculateTargetSize(1_000, 'recommended', true), 720);
});

test('a projection is built from pages that were actually encoded', () => {
  // 10 pages at a measured 50 KB each, plus the container the exporter writes.
  const projected = projectCompressedSize({ bytesPerPage: 50_000, pageCount: 10, sampledPages: 2 });
  assert.equal(projected, 50_000 * 10 + 220 * 10 + 900);

  // Nothing sampled means nothing promised, rather than a zero-byte prediction
  // or a guess dressed up as a measurement.
  assert.equal(projectCompressedSize({ bytesPerPage: 0, pageCount: 10, sampledPages: 0 }), 0);
  assert.equal(projectCompressedSize({ bytesPerPage: 50_000, pageCount: 0, sampledPages: 2 }), 0);
});

test('sampled pages are spread across the document, never just the first', () => {
  assert.deepEqual(samplePageIndices(1), [0]);
  assert.deepEqual(samplePageIndices(2), [0, 1]);
  // First, middle and last, so a title page cannot stand in for the whole file.
  assert.deepEqual(samplePageIndices(9), [0, 4, 8]);
  assert.deepEqual(samplePageIndices(100), [0, 50, 99]);
  assert.deepEqual(samplePageIndices(100, 2), [0, 99]);
  assert.deepEqual(samplePageIndices(0), []);
});

test('a measured projection tracks quality where the old ratio table could not', () => {
  // The point of measuring: a scanned page and a text page of the same file size
  // no longer receive the same prediction.
  const scan = projectCompressedSize({ bytesPerPage: 180_000, pageCount: 4, sampledPages: 2 });
  const text = projectCompressedSize({ bytesPerPage: 12_000, pageCount: 4, sampledPages: 2 });
  assert.ok(scan > text * 5);
});
