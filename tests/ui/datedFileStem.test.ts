import assert from 'node:assert/strict';
import test from 'node:test';
import {
  datedFileStem,
  datedOutputName,
  renameKeepingExtension,
  shortDayMonth,
  toolOutputName,
} from '../../components/UI/format.ts';

// Outputs used to be named like "rotate_pages_1791979049682_Invoice.pdf" or "66.pdf".
test('a result with no single source is named by what it is and the day, with a short month', () => {
  assert.equal(datedFileStem('Scanned PDF', new Date(2026, 9, 14, 18, 5), 'en-US'), 'Scanned PDF 14 Oct');
  assert.equal(datedFileStem('Scanned PDF', new Date(2026, 8, 7), 'en-GB'), 'Scanned PDF 7 Sep');
  assert.equal(shortDayMonth(new Date(2026, 9, 7), 'de-DE'), '7 Okt');
  assert.equal(datedOutputName('Merge PDF', 'pdf', new Date(2026, 9, 13), 'en-US'), 'Merge PDF 13 Oct.pdf');
  const stem = datedFileStem('Scanned PDF', new Date(2026, 9, 14), 'en-US');
  assert.equal(renameKeepingExtension(stem, '.pdf', 'fallback.pdf'), 'Scanned PDF 14 Oct.pdf');
  assert.equal(renameKeepingExtension('Rent receipt', '.pdf', 'fallback.pdf'), 'Rent receipt.pdf');
  assert.equal(renameKeepingExtension('   ', '.pdf', 'fallback.pdf'), 'fallback.pdf');
});

test('a result from one file puts the tool before the name it already had', () => {
  assert.equal(toolOutputName('compress', 'Invoice March (final) v2.pdf', 'pdf'), 'compress-Invoice March (final) v2.pdf');
  assert.equal(toolOutputName('split', 'report.v2.pdf', 'zip'), 'split-report.v2.zip');
  assert.equal(toolOutputName('sign', 'रिपोर्ट हिंदी नाम.pdf', 'pdf'), 'sign-रिपोर्ट हिंदी नाम.pdf');
  assert.equal(toolOutputName('rotate', 'a/b.pdf', 'pdf'), 'rotate-a-b.pdf');
  assert.equal(toolOutputName('edit', '.pdf', 'pdf'), 'edit-document.pdf');
  assert.equal(toolOutputName('text', 'notes', 'txt'), 'text-notes.txt');
  const long = toolOutputName('rotate', `${'a'.repeat(178)}😀.pdf`, 'pdf');
  assert.equal(long.length, 180, 'Android refuses names over 180 units');
  assert.ok(long.endsWith('a.pdf'), 'a cut never splits an emoji');
});
