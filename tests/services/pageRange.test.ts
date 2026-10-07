import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBoundedPageRange } from '../../services/pageRange.ts';

test('parses, deduplicates, and orders pages as zero-based indexes', () => {
  assert.deepEqual(parseBoundedPageRange('5, 2-4, 3', 8), [1, 2, 3, 4]);
});

test('rejects an out-of-bounds range before expanding it', () => {
  const started = performance.now();
  assert.throws(
    () => parseBoundedPageRange('1-999999999', 20),
    /outside this PDF/,
  );
  assert.ok(performance.now() - started < 50, 'rejection should not depend on the requested range size');
});

test('rejects reversed, zero, malformed, and excessively fragmented input', () => {
  assert.throws(() => parseBoundedPageRange('8-3', 10), /low to high/);
  assert.throws(() => parseBoundedPageRange('0', 10), /outside this PDF/);
  assert.throws(() => parseBoundedPageRange('2,wat', 10), /not a valid page or range/);
  assert.throws(() => parseBoundedPageRange(Array.from({ length: 257 }, () => '1').join(','), 10), /too (?:long|many groups)/);
});

test('inclusive ranges accept pasted dashes and localized digits without changing page positions', () => {
  for (const input of ['187-230', '187–230', '187—230', '187−230', '١٨٧-٢٣٠', '۱۸۷-۲۳۰', '१८७-२३०', '１８７－２３０']) {
    const pages = parseBoundedPageRange(input, 300);
    assert.equal(pages.length, 44, input);
    assert.equal(pages[0], 186, input);
    assert.equal(pages.at(-1), 229, input);
  }
  assert.deepEqual(parseBoundedPageRange('1、5，10-20', 300), [0, 4, ...Array.from({ length: 11 }, (_, i) => i + 9)]);
  assert.deepEqual(parseBoundedPageRange('١،٥،١٠-٢٠', 300), [0, 4, ...Array.from({ length: 11 }, (_, i) => i + 9)]);
});

test('localized notation keeps input limits and rejects ambiguous thousands or decimal marks', () => {
  assert.throws(() => parseBoundedPageRange('１'.repeat(513), 300), /too long/);
  for (const input of ['1,000', '١٬٠٠٠', '١٫٥', '1〜5', '1～5']) {
    assert.throws(() => parseBoundedPageRange(input, 300), input);
  }
  assert.throws(() => parseBoundedPageRange('१८७–३०१', 300), /outside this PDF/);
  assert.throws(() => parseBoundedPageRange('２３０－１８７', 300), /low to high/);
});
