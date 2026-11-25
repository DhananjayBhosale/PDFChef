import assert from 'node:assert/strict';
import test from 'node:test';
import { keptPdfName } from '../../components/UI/format.ts';

// s7-02 (overnight 2026-11-24): Batch Compress kept an unshrinkable PDF under its raw name, so a
// file picked as "no-extension" or "  leading and trailing.pdf  " went into the ZIP without ".pdf".
test('a PDF kept unchanged by Batch Compress always ends in .pdf, with no outer spaces', () => {
  assert.equal(keptPdfName('Invoice.pdf'), 'Invoice.pdf');
  assert.equal(keptPdfName('Scan.PDF'), 'Scan.pdf');
  assert.equal(keptPdfName('no-extension'), 'no-extension.pdf');
  assert.equal(keptPdfName('  leading and trailing.pdf  '), 'leading and trailing.pdf');
  assert.equal(keptPdfName('report.v2.pdf'), 'report.v2.pdf');
  assert.equal(keptPdfName('   '), 'document.pdf');
  assert.ok(keptPdfName(`${'a'.repeat(300)}.pdf`).length <= 180);
});
