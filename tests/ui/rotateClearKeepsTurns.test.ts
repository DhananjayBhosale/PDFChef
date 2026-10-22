import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import english from '../../services/i18n/en-US.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'components/Tools/RotatePDF.tsx'), 'utf8');
const between = (start: string, end: string) => {
  const from = source.indexOf(start);
  assert.ok(from > -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
};

test('Clear in Rotate Pages drops the selection and keeps every turn (ORG-27)', () => {
  const clear = between("key: 'clear'", "key: 'reset'");
  assert.match(clear, /setSelectedPages\(\[\]\)/);
  assert.doesNotMatch(clear, /resetRotation|setPageRotations/);
  // Nothing selected means nothing to clear, whatever the pages have been turned to.
  assert.match(clear, /disabled: selectedPages\.length === 0,/);
  assert.equal(Object.hasOwn(english, 'rotate-pdf.selection.and.rotations.cleared.5f1e1a'), false);
});

test('Reset is still the control that puts every page back upright', () => {
  const reset = between('const resetRotation', 'const handleSave');
  assert.match(reset, /next\[i\] = 0/);
  assert.match(source, /\{ key: 'reset', label: t\("rotate-pdf\.reset\.daee76"\), hidden: !hasRotationChanges, onClick: resetRotation \}/);
});
