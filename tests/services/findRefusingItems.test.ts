import assert from 'node:assert/strict';
import test from 'node:test';
import { findRefusingItems } from '../../services/findRefusingItems.ts';

const failsWith = (bad: Set<number>) => {
  const calls: number[][] = [];
  const holds = async (group: number[]) => {
    calls.push(group);
    return !group.some((item) => bad.has(item));
  };
  return { calls, holds };
};

// Found on a phone: one paragraph out of 27 could not be rewritten, and the save redrew all 27.
test('one refusing item among many is found in a few trials', async () => {
  const items = Array.from({ length: 27 }, (_, index) => index);
  const { calls, holds } = failsWith(new Set([19]));
  assert.deepEqual(await findRefusingItems(items, holds), [19]);
  assert.ok(calls.length <= 10, `${calls.length} trials`);
});

test('every refusing item is found, and the others are left alone', async () => {
  const items = Array.from({ length: 12 }, (_, index) => index);
  const { holds } = failsWith(new Set([0, 7, 11]));
  assert.deepEqual(await findRefusingItems(items, holds), [0, 7, 11]);
});

test('a single item known to fail needs no trial', async () => {
  const { calls, holds } = failsWith(new Set([4]));
  assert.deepEqual(await findRefusingItems([4], holds), [4]);
  assert.equal(calls.length, 0);
});

test('a failure that only a combination causes reports the whole set', async () => {
  const holds = async () => true;
  assert.deepEqual(await findRefusingItems([1, 2, 3], holds), [1, 2, 3]);
});

test('groups left untried when the trials run out are reported whole', async () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  const { holds } = failsWith(new Set([6]));
  assert.deepEqual(await findRefusingItems(items, holds, 1), [4, 5, 6, 7]);
});
