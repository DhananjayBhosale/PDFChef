import assert from 'node:assert/strict';
import test from 'node:test';
import { renameKeepingExtension } from '../../components/UI/format.ts';

// Cycle-2 QA: the result-sheet Rename saved ".pdf", "..pdf" and "trail..pdf" because it
// did not share Recent's rule. Both screens now use this one.
test('a result rename keeps the extension and never saves an empty or doubled name', () => {
  const pdf = (typed: string) => renameKeepingExtension(typed, '.pdf', 'Rotated.pdf');
  assert.equal(pdf('Invoice'), 'Invoice.pdf');
  assert.equal(pdf('Invoice.PDF'), 'Invoice.pdf');
  assert.equal(pdf('trail.'), 'trail.pdf');
  assert.equal(pdf('a/b\\c'), 'a-b-c.pdf');
  assert.equal(pdf('.pdf'), 'Rotated.pdf');
  assert.equal(pdf('.PDF'), 'Rotated.pdf');
  assert.equal(pdf('.'), 'Rotated.pdf');
  assert.equal(renameKeepingExtension('trail.', '.zip', 'pages.zip'), 'trail.zip');
  assert.equal(renameKeepingExtension('notes', '', 'legacy'), 'notes');
});
