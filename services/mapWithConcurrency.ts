/**
 * Maps items a few at a time instead of all at once, keeping the results in input order.
 *
 * Decoding every picked photo together is what runs a phone out of memory; two at a time keeps
 * the pipeline busy without holding every decoded image at once.
 */
export const mapWithConcurrency = async <Input, Output>(
  items: Input[],
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> => {
  const results = new Array<Output>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};
