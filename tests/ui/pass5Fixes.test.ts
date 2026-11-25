import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import english from '../../services/i18n/en-US.ts';
import { fitMiddleName, middleNameParts } from '../../components/UI/format.ts';
import { PAGE_NUMBER_FORMAT_PRESETS } from '../../services/androidParity.ts';

// Pass 5 fixes (output/web/pass5-fixes/REPORT.md): the review's usability items.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
// A monospaced stand-in for the browser's measure: 7 px a character.
const mono = (text: string) => Array.from(text).length * 7;
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, slot: string) => values[slot] ?? `{${slot}}`);

test('item 4: the tail of a cut name starts at a word, so the date stays whole', () => {
  assert.deepEqual(middleNameParts('Merge PDF 16 Nov.pdf'), { head: 'Merge PDF', tail: ' 16 Nov.pdf' });
  assert.deepEqual(middleNameParts('qa-sample.pdf'), { head: 'qa-s', tail: 'ample.pdf' });
  // Never between the two halves of an emoji.
  assert.equal(middleNameParts(`ab${'😀'.repeat(6)}.pdf`).tail, '😀😀😀.pdf');
  assert.equal(middleNameParts('a.pdf').head, '');
});

test('item 4: a name that does not fit is cut in the middle, never inside the date', () => {
  const name = 'Merge PDF 16 Nov.pdf';
  assert.equal(fitMiddleName(name, mono(name), mono), null, 'a name that fits is left whole');
  assert.equal(fitMiddleName(name, 15 * 7, mono), 'Mer… 16 Nov.pdf');
  assert.equal(fitMiddleName(name, 13 * 7, mono), 'M… 16 Nov.pdf', 'a tail of whole words keeps one letter of the start');
  for (let room = 0; room < name.length; room += 1) {
    const shown = fitMiddleName(name, room * 7, mono);
    assert.ok(shown !== null && shown.endsWith('.pdf'), `room ${room}: ${shown}`);
    assert.doesNotMatch(shown, /…6 Nov/u, `room ${room}: "6 Nov" reads as the 6th`);
    assert.ok(mono(shown) <= room * 7 || shown === '….pdf', `room ${room}: ${shown} is too wide`);
  }
  // A short name in little room keeps its start and its end (Read PDF's title on a 360 px phone).
  assert.equal(fitMiddleName('qa-sample.pdf', 10 * 7, mono), 'qa-…le.pdf');
  assert.equal(fitMiddleName('Merge PDF 16 Nov.pdf', 14 * 7, mono), 'Me… 16 Nov.pdf');
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

test('items 1, 2, 7-10: the strip stays in its slot, Open PDF previews, and the cards fit', () => {
  // StrictMode's second mount registers the slot again (the strip covered Save PDF in development).
  assert.match(read('components/UI/resultSlot.ts'), /if \(latest\.current && !element\.current && enabledRef\.current\) register\(latest\.current\);/);
  // Open PDF on a tool screen shows the result over the tool instead of leaving it.
  const output = read('components/UI/OutputCenter.tsx');
  assert.match(output, /if \(!openTools && slotTarget\) \{[^}]*setPreviewFile\(file\);/s);
  assert.match(output, /<PDFPreviewModal/);
  assert.match(read('components/Tool/ConverterScreen.tsx'), /<FileCard icon=\{icon\} name=\{file\.name\} meta=\{formatBytes\(file\.size\)\} \/>/);
  assert.match(read('components/Tools/ViewPDF.tsx'), /<MiddleName name=\{openedPdf\.name\} \/>/);
  assert.doesNotMatch(read('components/Tool/tool.css'), /\.tk-rtitle-name \{[^}]*line-clamp/s);
  const merge = read('components/Tools/MergePDF.tsx');
  assert.match(merge, /locked = classifyPdfError\(error\) === 'locked';/);
  assert.match(merge, /file\.locked \? t\('batch\.unlock\.locked'\)/);
  assert.match(read('components/Tools/SignPDF.tsx'), /<ChangeFile label=\{t\('tool\.chooseAnotherFile'\)\} onClick=\{chooseAnother\}/);
  assert.match(read('components/Tool/Popover.tsx'), /export const PREVIEW_FLOOR_TALL = 0\.2;/);
  assert.match(read('components/Tools/PageNumbersPDF.tsx'), /previewFloor=\{PREVIEW_FLOOR_TALL\}/);
});
