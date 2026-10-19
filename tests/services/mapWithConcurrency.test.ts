import assert from 'node:assert/strict';
import test from 'node:test';
import { mapWithConcurrency } from '../../services/mapWithConcurrency.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

test('results come back in input order even when later items finish first', async () => {
  const delays = [30, 5, 20, 1, 10];
  const results = await mapWithConcurrency(delays, 2, async (delay, index) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return `${index}:${delay}`;
  });
  assert.deepEqual(results, ['0:30', '1:5', '2:20', '3:1', '4:10']);
});

test('never runs more than the limit at once', async () => {
  let running = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 9 }, (_, index) => index), 2, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await tick();
    await tick();
    running -= 1;
  });
  assert.equal(peak, 2);
});

test('a failing item rejects the whole map, as Promise.all did', async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('bad item');
      return item;
    }),
    /bad item/,
  );
});

test('an empty list resolves to an empty list', async () => {
  assert.deepEqual(await mapWithConcurrency([], 2, async (item) => item), []);
});
