import assert from 'node:assert/strict';
import test from 'node:test';
import { MAXIMUM_FILENAME_LENGTH, filenameStemLimit, renameKeepingExtension, sanitizeFilenameStem } from '../../components/UI/format.ts';

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

// Release QA REG-31: Android stores : ? * " < > | as "_", so the app showed a name the file did
// not have. CRT-16 / NAV-17: names over 180 characters were refused with a raw error.
test('a rename uses the characters Android stores and fits the 180-character limit', () => {
  const pdf = (typed: string) => renameKeepingExtension(typed, '.pdf', 'Rotated.pdf');
  assert.equal(pdf('Tax 2026 / copy: v2'), 'Tax 2026 - copy_ v2.pdf');
  assert.equal(pdf('Chars a?b*c"d<e>f|g'), 'Chars a_b_c_d_e_f_g.pdf');
  assert.equal(pdf('tab\there'), 'tabhere.pdf');
  assert.equal(sanitizeFilenameStem('a:b'), 'a_b');
  const long = pdf('x'.repeat(300));
  assert.equal(long.length, MAXIMUM_FILENAME_LENGTH);
  assert.ok(long.endsWith('.pdf'));
  assert.equal(filenameStemLimit('.pdf'), 176);
  // A long name of emoji is cut between characters, never inside one.
  const emoji = pdf('😀'.repeat(120));
  assert.ok(emoji.length <= MAXIMUM_FILENAME_LENGTH && emoji.endsWith('😀.pdf'));
});
