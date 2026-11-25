import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import english from '../../services/i18n/en-US.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const compress = read('components/Tools/CompressPDF.tsx');
const batch = read('components/Tools/BatchPDF.tsx');
const browser = read('services/pdfBrowser.ts');

// REG-20: by default Compress turned every page into a picture, so text could no longer be
// searched or copied, while Help said the default keeps selectable text.
test('Compress PDF keeps text selectable unless the person turns it off', () => {
  // On by default; a choice the person made is kept for the next visit (path to 9, item 5).
  assert.match(compress, /const \[keepText, setKeepText\] = useRemembered<boolean>\('keepText', true\);/);
  // Picking files or clearing them must not undo a choice the person made.
  assert.deepEqual([...compress.matchAll(/setKeepText\b/g)].length, 2, 'setKeepText is only declared and wired to the switch');
  // The switch is the sentence's one-tap word (owner decision 1, A-004), still named "Keep text selectable".
  assert.match(compress, /role="switch"\s*aria-checked=\{keepText\}\s*aria-label=\{switchLabel\}\s*onClick=\{\(\) => setKeepText\(\(current\) => !current\)\}/);
  assert.match(compress, /const switchLabel = t\("compress-pdf\.keep\.text\.selectable\.89e827"\);/);
  // The switch decides flattening; nothing else does.
  assert.match(compress, /effectiveConfig,\s*!keepText,/);
});

test('the compressor keeps text when no choice is passed', () => {
  const start = browser.indexOf('export const compressPDFAdaptive = async (');
  const signature = browser.slice(start, browser.indexOf(') => {', start));
  assert.ok(start >= 0 && /\bflatten = false,/.test(signature), signature);
});

test('Batch compress keeps text selectable', () => {
  const call = batch.match(/compressPDFAdaptive\(([^;]*?)\);/s)?.[1] ?? '';
  const args = call.replace(/\/\/[^\n]*/g, '').split(',').map((value) => value.trim()).filter(Boolean);
  assert.equal(args[5], 'false', 'sixth argument (flatten) is false');
});

test('Help still matches the default', () => {
  assert.match(english['help-page.not.by.default.pages.and.selectable.text.058c9f'], /^Not by default\. Pages and selectable text stay intact\./);
});

test('a text-only PDF that cannot shrink names the switch that trades text for size', () => {
  const key = 'compress-pdf.to.make.it.smaller.turn.off.pages.4ef0d4';
  const message = english[key];
  assert.equal(createHash('sha256').update(message).digest('hex').slice(0, 6), '4ef0d4');
  assert.match(message, /turn off “\{v0\}”/);
  assert.match(message, /pictures/);
  // Shown only on the "already as small as it gets" result, only when text was kept, and it
  // quotes the switch's own label so the two always read the same. Since T-01 that result is
  // the tool's notice line (the old result card is gone), so the hint is a line of the notice.
  assert.match(
    compress,
    /\{keepText && \(\s*<span[^>]*>\{t\("compress-pdf\.to\.make\.it\.smaller\.turn\.off\.pages\.4ef0d4", \{ v0: t\("compress-pdf\.keep\.text\.selectable\.89e827"\) \}\)\}/,
  );
  const skippedStart = compress.indexOf(': skipped ? (');
  assert.ok(skippedStart >= 0, 'the notice has a branch for a file that cannot shrink');
  const skippedBranch = compress.slice(skippedStart, compress.indexOf(': null;', skippedStart));
  assert.match(skippedBranch, /compress-pdf\.already\.as\.small\.as\.it\.gets\.c4d3a1/);
  assert.match(skippedBranch, /compress-pdf\.to\.make\.it\.smaller\.turn\.off\.pages\.4ef0d4/);
});
