import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { compareExtractedPageText, reserveArchiveName, textFromSelectionTargets } from '../../services/pdfToolResults.ts';

test('same-name batch inputs survive ZIP packaging including existing numbered names', async () => {
  const used = new Set<string>();
  const zip = new JSZip();
  for (const [index, name] of ['report.pdf', 'report.pdf', 'report (2).pdf', 'REPORT.PDF'].entries()) {
    zip.file(reserveArchiveName(name, used), String(index));
  }
  const archive = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(Object.keys(archive.files).length, 4);
  assert.deepEqual(await Promise.all(Object.values(archive.files).map((entry) => entry.async('string'))), ['0', '1', '2', '3']);
});

test('scans and a missing text layer do not count as matching wording', () => {
  assert.equal(compareExtractedPageText('', ''), 'unavailable');
  assert.equal(compareExtractedPageText('Text', ''), 'unavailable');
  assert.equal(compareExtractedPageText('Same', 'Same'), 'matches');
  assert.equal(compareExtractedPageText('a'.repeat(600) + 'changed', 'a'.repeat(600) + 'original'), 'differs');
});

test('copying extracted word targets preserves readable lines and separate columns', () => {
  const word = (text: string, left: number, top: number) => ({ text, left, top, width: 20, height: 10 });
  assert.equal(textFromSelectionTargets([
    word('Hello', 10, 10), word('world', 33, 10), word('Column', 200, 10),
    word('Next', 10, 30), word('line', 33, 30),
  ]), 'Hello world\nColumn\nNext line');
});
