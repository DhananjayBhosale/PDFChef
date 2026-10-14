import assert from 'node:assert/strict';
import test from 'node:test';
import { finalNumberValue, liveNumberValue } from '../../components/UI/numberDraft.ts';

// Cycle-2 QA: typing "24" into the 8–72 Size box gave 72, because "2" snapped to 8 first.
test('a number box applies only in-range values while typing and clamps when left', () => {
  const typed = ['2', '24'].map((text) => liveNumberValue(text, 8, 72));
  assert.deepEqual(typed, [null, 24]);
  assert.equal(liveNumberValue('', 8, 72), null);
  assert.equal(liveNumberValue('-', -180, 180), null);
  assert.equal(liveNumberValue('-45', -180, 180), -45);
  assert.equal(finalNumberValue('3', 8, 72), 8);
  assert.equal(finalNumberValue('300', 8, 72), 72);
  assert.equal(finalNumberValue('', 8, 72), null);
  assert.equal(finalNumberValue('abc', 8, 72), null);
});
