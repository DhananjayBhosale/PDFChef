import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PAGE_NUMBER_FORMAT, buildPageNumberText } from '../../services/androidParity.ts';

test('digits typed in a page number format print as typed (ORG-30)', () => {
  assert.equal(buildPageNumberText('2026 Report {n}', 7, 12), '2026 Report 7');
  assert.equal(buildPageNumberText('Chapter 3 - {n}', 7, 12), 'Chapter 3 - 7');
  assert.equal(buildPageNumberText('2026 Report {n} of {total}', 7, 12), '2026 Report 7 of 12');
  // Without a token the digits are text too; the page number goes after them.
  assert.equal(buildPageNumberText('2026 Report 1', 7, 12), '2026 Report 1 7');
  assert.equal(buildPageNumberText('Chapter 3 - 1', 7, 12), 'Chapter 3 - 1 7');
});

test('the default and the token formats print what they printed before', () => {
  // The default used to be "Page 1", read as a template. It is now spelled with the token.
  assert.equal(DEFAULT_PAGE_NUMBER_FORMAT, 'Page {n}');
  assert.equal(buildPageNumberText(DEFAULT_PAGE_NUMBER_FORMAT, 3, 10), 'Page 3');
  assert.equal(buildPageNumberText('', 3, 10), 'Page 3');
  assert.equal(buildPageNumberText('   ', 3, 10), 'Page 3');
  assert.equal(buildPageNumberText('Page', 3, 10), 'Page 3');
  assert.equal(buildPageNumberText('Page {n} of {total}', 3, 10), 'Page 3 of 10');
  assert.equal(buildPageNumberText('{n}/{total}', 3, 10), '3/10');
  assert.equal(buildPageNumberText('of {total}', 3, 10), 'of 10');
});

test('a page number label stays within the PDF text limit', () => {
  const long = 'x'.repeat(200);
  assert.equal(buildPageNumberText(long, 3, 10).length, 140);
  assert.equal(buildPageNumberText(`${'x'.repeat(130)} {n}`, 123456789, 10).length, 140);
});
