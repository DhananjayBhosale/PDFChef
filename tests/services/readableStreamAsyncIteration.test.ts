import assert from 'node:assert/strict';
import test from 'node:test';
import { installReadableStreamAsyncIteration } from '../../services/readableStreamAsyncIteration.ts';

/**
 * PDF.js reads a page's text with `for await (const chunk of stream)`. iOS WebKit ships
 * `ReadableStream` without async iteration, so on iPhone and iPad that loop throws and the editor
 * finds no paragraphs in any document at all. These cover the shim that restores it.
 */

/** A stream whose async iteration has been removed, standing in for the iOS engine. */
const withoutAsyncIteration = () => {
  const original = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);
  const originalValues = Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'values');
  delete (ReadableStream.prototype as unknown as Record<PropertyKey, unknown>)[Symbol.asyncIterator];
  delete (ReadableStream.prototype as unknown as Record<PropertyKey, unknown>).values;
  return () => {
    if (original) Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, original);
    if (originalValues) Object.defineProperty(ReadableStream.prototype, 'values', originalValues);
  };
};

/** The shim is what makes these iterable, which the ambient types do not know about. */
type IterableStream = ReadableStream & AsyncIterable<unknown>;

const streamOf = (...chunks: unknown[]) => new ReadableStream({
  start(controller) {
    chunks.forEach((chunk) => controller.enqueue(chunk));
    controller.close();
  },
}) as IterableStream;

test('an engine without stream async iteration can iterate one after the shim', async () => {
  const restore = withoutAsyncIteration();
  try {
    assert.equal(
      typeof (ReadableStream.prototype as unknown as Record<PropertyKey, unknown>)[Symbol.asyncIterator],
      'undefined',
      'the test needs an engine that is missing the feature',
    );
    installReadableStreamAsyncIteration();

    const seen: unknown[] = [];
    for await (const chunk of streamOf('a', 'b', 'c')) seen.push(chunk);
    assert.deepEqual(seen, ['a', 'b', 'c']);
  } finally {
    restore();
  }
});

test('leaving the loop early cancels the stream rather than holding its lock', async () => {
  const restore = withoutAsyncIteration();
  try {
    installReadableStreamAsyncIteration();
    let cancelled: unknown = null;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue('first'); controller.enqueue('second'); },
      cancel(reason) { cancelled = reason ?? 'cancelled'; },
    }) as IterableStream;

    for await (const chunk of stream) {
      assert.equal(chunk, 'first');
      break;
    }

    assert.ok(cancelled, 'breaking out of the loop left the stream open');
    assert.equal(stream.locked, false, 'the reader kept its lock after the loop ended');
  } finally {
    restore();
  }
});

test('an engine that already iterates streams is left alone', () => {
  const marker = function* () {};
  const original = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    value: marker, writable: true, configurable: true,
  });
  try {
    installReadableStreamAsyncIteration();
    assert.equal(
      (ReadableStream.prototype as unknown as Record<PropertyKey, unknown>)[Symbol.asyncIterator],
      marker,
      'the shim replaced an implementation the engine already had',
    );
  } finally {
    if (original) Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, original);
  }
});
