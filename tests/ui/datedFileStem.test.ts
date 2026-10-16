import assert from 'node:assert/strict';
import test from 'node:test';
import { datedFileStem, renameKeepingExtension } from '../../components/UI/format.ts';

// Create PDF used to save "scanned-1791983367256.pdf" with no chance to name it first.
test('Create PDF names a file by what it is and the day it was made', () => {
  assert.equal(datedFileStem('Scanned PDF', new Date(2026, 9, 14, 18, 5), 'en-US'), 'Scanned PDF 14 October');
  assert.equal(datedFileStem('Scanned PDF', new Date(2026, 9, 7), 'en-GB'), 'Scanned PDF 7 October');
  assert.equal(datedFileStem('Gescanntes PDF', new Date(2026, 9, 7), 'de-DE'), 'Gescanntes PDF 7. Oktober');
  const stem = datedFileStem('Scanned PDF', new Date(2026, 9, 14), 'en-US');
  assert.equal(renameKeepingExtension(stem, '.pdf', 'fallback.pdf'), 'Scanned PDF 14 October.pdf');
  assert.equal(renameKeepingExtension('Rent receipt', '.pdf', 'fallback.pdf'), 'Rent receipt.pdf');
  assert.equal(renameKeepingExtension('   ', '.pdf', 'fallback.pdf'), 'fallback.pdf');
});
