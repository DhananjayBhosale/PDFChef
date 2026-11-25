import assert from 'node:assert/strict';
import test from 'node:test';
import { clampMargin, cropForm, dragMargins, handleEdges, keyMargin, type CropMargins } from '../../components/Tool/cropMath.ts';

const five: CropMargins = { top: 5, right: 5, bottom: 5, left: 5 };

test('margins are whole numbers from 0 to 40', () => {
  assert.equal(clampMargin(12.4), 12);
  assert.equal(clampMargin(12.6), 13);
  assert.equal(clampMargin(-3), 0);
  assert.equal(clampMargin(55), 40);
  assert.equal(clampMargin(Number.NaN), 0);
});

test('an edge handle moves only its own edge, toward the middle as it goes in', () => {
  // A 400 x 800 px page: 40 px across is 10%, 40 px down is 5%.
  assert.deepEqual(dragMargins(five, 'top', 0, 40, 400, 800), { ...five, top: 10 });
  assert.deepEqual(dragMargins(five, 'bottom', 0, -40, 400, 800), { ...five, bottom: 10 });
  assert.deepEqual(dragMargins(five, 'left', 40, 0, 400, 800), { ...five, left: 15 });
  assert.deepEqual(dragMargins(five, 'right', -40, 0, 400, 800), { ...five, right: 15 });
  // Sideways movement does not move the top edge.
  assert.deepEqual(dragMargins(five, 'top', 200, 0, 400, 800), five);
});

test('a drag stops at 0 and at 40, however far it goes', () => {
  assert.equal(dragMargins(five, 'top', 0, 10_000, 400, 800).top, 40);
  assert.equal(dragMargins(five, 'top', 0, -10_000, 400, 800).top, 0);
  assert.equal(dragMargins(five, 'right', -10_000, 0, 400, 800).right, 40);
});

test('a corner moves its two edges together', () => {
  assert.deepEqual(handleEdges('bottomRight'), ['bottom', 'right']);
  assert.deepEqual(dragMargins(five, 'bottomRight', -20, -40, 400, 800), { top: 5, right: 10, bottom: 10, left: 5 });
  assert.deepEqual(dragMargins(five, 'topLeft', 20, 40, 400, 800), { top: 10, right: 5, bottom: 5, left: 10 });
});

test('a page drawn with no size does not move the frame', () => {
  assert.deepEqual(dragMargins(five, 'top', 0, 40, 0, 0), five);
});

test('slider keys: arrows by 1, Shift by 5, Page keys by 5, Home and End to the limits', () => {
  assert.equal(keyMargin(5, 'ArrowUp'), 6);
  assert.equal(keyMargin(5, 'ArrowRight'), 6);
  assert.equal(keyMargin(5, 'ArrowDown'), 4);
  assert.equal(keyMargin(5, 'ArrowLeft', true), 0);
  assert.equal(keyMargin(38, 'ArrowUp', true), 40);
  assert.equal(keyMargin(5, 'PageUp'), 10);
  assert.equal(keyMargin(5, 'PageDown'), 0);
  assert.equal(keyMargin(5, 'Home'), 0);
  assert.equal(keyMargin(5, 'End'), 40);
  assert.equal(keyMargin(5, 'Enter'), null);
});

test('the sentence form follows the four numbers', () => {
  assert.equal(cropForm({ top: 0, right: 0, bottom: 0, left: 0 }), 'none');
  assert.equal(cropForm(five), 'same');
  assert.equal(cropForm({ ...five, top: 10 }), 'each');
});
