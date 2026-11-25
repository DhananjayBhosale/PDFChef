import assert from 'node:assert/strict';
import test from 'node:test';
import { turnOutcome } from '../../components/Tool/values.ts';

test('no turn, or turns that come full circle, give no outcome line', () => {
  assert.equal(turnOutcome({}), null);
  assert.equal(turnOutcome({ 0: 0, 1: 360, 2: -360 }), null);
});

test('one kind of turn names its direction', () => {
  assert.deepEqual(turnOutcome({ 1: 90 }), { pages: [1], direction: 'right' });
  assert.deepEqual(turnOutcome({ 1: -90, 0: 270 }), { pages: [0, 1], direction: 'left' });
  assert.deepEqual(turnOutcome({ 2: 180, 0: -180 }), { pages: [0, 2], direction: 'flip' });
  assert.deepEqual(turnOutcome({ 3: 450 }), { pages: [3], direction: 'right' });
});

test('different turns read "as shown", and unturned pages are left out', () => {
  assert.deepEqual(turnOutcome({ 0: 0, 1: 90, 2: -90 }), { pages: [1, 2], direction: 'mixed' });
  assert.deepEqual(turnOutcome({ 0: 90, 1: 180 }), { pages: [0, 1], direction: 'mixed' });
});
