import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import english from '../../services/i18n/en-US.ts';
import { setTemporaryLocale } from '../../services/i18n/core.ts';
import { joinSentences, sharedPictureNote } from '../../components/Tool/values.ts';
import { PAGE_NUMBER_FORMAT_PRESETS } from '../../services/androidParity.ts';

// Tool sentences and notes read as natural language with every count and locale.
// Fix round 2 (output/web/ui-redesign/audit/prompts/final-fix-2.md): the contracts behind each item.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, slot: string) => values[slot] ?? `{${slot}}`);

test('item 6: Extract Images says when one picture is used on several pages', () => {
  assert.equal(sharedPictureNote([{ pageNumbers: [1] }, { pageNumbers: [2] }]), '');
  assert.equal(sharedPictureNote([{ pageNumbers: [2, 2] }]), '', 'the same page twice is not sharing');
  assert.equal(sharedPictureNote([{ pageNumbers: [4, 1, 3, 2] }]), 'The same picture is used on pages ⁦1–4⁩, so it is saved once.');
  assert.equal(sharedPictureNote([{ pageNumbers: [1, 3] }]), 'The same picture is used on pages 1 and 3, so it is saved once.');
  assert.equal(sharedPictureNote([{ pageNumbers: [1, 2] }, { pageNumbers: [3, 4] }]), '2 pictures are used on more than one page. Each is saved once.');
  assert.equal(joinSentences('Found 1 embedded image.', ''), 'Found 1 embedded image.');
  assert.equal(joinSentences('A.', 'B.'), 'A. B.');
});

test('item 6: the note is translated, with the locale digits, and Japanese joins without a space', async () => {
  await setTemporaryLocale('ar-SA');
  try {
    assert.match(sharedPictureNote([{ pageNumbers: [1, 2, 3, 4] }]), /[١٤]/);
    assert.doesNotMatch(sharedPictureNote([{ pageNumbers: [1, 2, 3, 4] }]), /The same picture/);
  } finally {
    await setTemporaryLocale('en-US');
  }
  await setTemporaryLocale('ja-JP');
  try {
    assert.equal(joinSentences('一。', '二。'), '一。二。');
  } finally {
    await setTemporaryLocale('en-US');
  }
});

test('items 3 and 6: the sentences read as English with every count', () => {
  const strings = english as Record<string, string | Record<string, string>>;
  const plain = (key: string) => {
    const value = strings[key];
    assert.equal(typeof value, 'string', key);
    return value as string;
  };
  // The switch keeps its words on or off (decision 2026-11-15); only the frame around it changes.
  assert.equal(
    fill(plain('sentence.compress.pictures'), { files: '1 PDF', quality: 'medium', text: plain('sentence.compress.text.keep') }),
    'Compress 1 PDF at medium quality and do not keep the text selectable.',
  );
  assert.equal(strings['sentence.compress.text.keeping'], undefined);
  assert.match(read('components/Tools/CompressPDF.tsx'), /const textPhrase = t\('sentence\.compress\.text\.keep'\);/);
  // Review 2, item 4: one page is saved as its own PDF, with no size in brackets.
  assert.equal(fill(plain('sentence.split.onePageAlone'), { pages: 'page 1' }), 'Save page 1 as its own PDF.');
  assert.equal(strings['sentence.split.size.pagesPerFile'], undefined);
  assert.equal(fill(plain('sentence.pdfToImage.losslessOne'), { what: 'page 2', format: 'PNG', scale: '1.2×' }), 'Save page 2 as a PNG picture at 1.2× size.');
  assert.equal(fill(plain('sentence.pdfToImage.embeddedOne'), { what: 'the only stored picture' }), 'Save the only stored picture as a PNG file.');
  const size = { size: '10 pt' };
  assert.equal(fill(plain('sentence.headerFooter'), { header: '“Draft”', footer: '“Page 1”', ...size }), 'Add the header “Draft” and the footer “Page 1” in 10 pt.');
  // Review 2, item 6: what is added comes first.
  assert.equal(fill(plain('sentence.headerFooter.addFooter'), { header: plain('sentence.headerFooter.header.none'), footer: '“Page 1”', ...size }), 'Add the footer “Page 1” in 10 pt, with no header.');
  assert.equal(fill(plain('sentence.headerFooter.addHeader'), { header: '“Draft”', footer: plain('sentence.headerFooter.footer.none'), ...size }), 'Add the header “Draft” in 10 pt, with no footer.');
  assert.equal(fill(plain('sentence.headerFooter.addNumbers'), { header: plain('sentence.headerFooter.header.none'), footer: plain('sentence.headerFooter.footer.numbers'), ...size }), 'Add page numbers in 10 pt, with no header.');
  assert.equal(fill(plain('sentence.headerFooter.neither'), { header: plain('sentence.headerFooter.header.unset'), footer: plain('sentence.headerFooter.footer.unset'), ...size }), 'Choose a header or a footer to add in 10 pt.');
  assert.equal(strings['sentence.headerFooter.none'], undefined, 'the old "none" value is gone');
  // The tools pick the frame that matches their state.
  assert.match(read('components/Tools/CompressPDF.tsx'), /template=\{keepText \? 'sentence\.compress' : 'sentence\.compress\.pictures'\}/);
  assert.match(read('components/Tools/SplitPDF.tsx'), /template=\{onePage \? 'sentence\.split\.onePageAlone'/);
  assert.match(read('components/Tools/PdfAdvancedTools.tsx'), /hasHeader && hasFooter \? 'sentence\.headerFooter'/);
});

test('item 5: Header & Footer offers the same footer formats as Page Numbers', () => {
  assert.deepEqual([...PAGE_NUMBER_FORMAT_PRESETS], ['{n}', 'Page {n}', 'Page {n} of {total}', '{n} / {total}']);
  assert.match(read('components/Tools/PageNumbersPDF.tsx'), /const FORMAT_PRESETS = PAGE_NUMBER_FORMAT_PRESETS;/);
  const tools = read('components/Tools/PdfAdvancedTools.tsx');
  assert.match(tools, /PAGE_NUMBER_FORMAT_PRESETS/);
  assert.match(tools, /interpolateHeaderFooterText\(preset, 1, /);
});
