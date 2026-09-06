/**
 * Async iteration over a `ReadableStream`, where the engine does not provide it.
 *
 * PDF.js reads a page's text with `for await (const chunk of stream)`. Chromium, Gecko and desktop
 * Safari all implement `ReadableStream.prototype[Symbol.asyncIterator]`; iOS WebKit does not, so on
 * every iPhone and iPad that loop throws `undefined is not a function` before a single text item is
 * returned. Nothing else fails — the page still renders — so the editor simply finds no paragraphs
 * and quietly behaves as though every document were a scan.
 *
 * This is the shape the streams specification defines for `ReadableStream.prototype.values`, kept
 * to the parts PDF.js relies on: read until done, release the lock, and cancel the stream if the
 * loop is left early.
 */
export const installReadableStreamAsyncIteration = () => {
  if (typeof ReadableStream === 'undefined') return;
  const prototype = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
  if (typeof prototype[Symbol.asyncIterator] === 'function') return;

  function values(this: ReadableStream, { preventCancel = false }: { preventCancel?: boolean } = {}) {
    const reader = this.getReader();
    const iterator = {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result;
        } catch (error) {
          reader.releaseLock();
          throw error;
        }
      },
      async return(value?: unknown) {
        if (preventCancel) {
          reader.releaseLock();
        } else {
          const cancelled = reader.cancel(value);
          reader.releaseLock();
          await cancelled;
        }
        return { done: true as const, value };
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }

  const descriptor = { value: values, writable: true, configurable: true, enumerable: false };
  Object.defineProperty(prototype, Symbol.asyncIterator, descriptor);
  if (typeof prototype.values !== 'function') Object.defineProperty(prototype, 'values', descriptor);
};
