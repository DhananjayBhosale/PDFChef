import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamicTypeScale } from '../../services/platform/capacitor/iosDynamicType.ts';

test("the phone's text size scales the iPhone app's text, up to double", () => {
  assert.equal(dynamicTypeScale(17), 1); // iOS default
  assert.equal(dynamicTypeScale(14), 0.82); // smallest
  assert.equal(dynamicTypeScale(23), 1.35); // largest before the accessibility sizes
  assert.equal(dynamicTypeScale(53), 2); // AX5 stops at double
  assert.equal(dynamicTypeScale(Number.NaN), 1);
  assert.equal(dynamicTypeScale(0), 1);
});
