import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  layoutParagraphLines,
  measureParagraphText,
  normalizeParagraphLineBreaks,
  paragraphStandardFontKey,
} from '../../services/pdfParagraphLayout.ts';
import { styledLineText, wrapStyledText } from '../../services/pdfBlockEditPlanning.ts';
import { unencodableCharacters, type ResolvedFont } from '../../services/pdfFontResolution.ts';
import type { ParagraphFace } from '../../services/pdfDocument.ts';

const regular: ParagraphFace = { key: 'regular', family: 'Helvetica', bold: false, italic: false };
const bold: ParagraphFace = { ...regular, key: 'bold', bold: true };
const substitutedFont: ResolvedFont = {
  mode: 'substituted',
  cssFamily: 'Helvetica, Arial, sans-serif',
  cssWeight: '400',
  cssStyle: 'normal',
  klass: 'sans-serif',
  reason: null,
  missingGlyphs: [],
};
const options = { width: 200, fontSize: 12, lineHeight: 16, align: 'left' as const };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);

test('reflow measurement uses the exact export face for all twelve standard styles', async () => {
  const document = await PDFDocument.create();
  for (const family of ['Helvetica', 'TimesRoman', 'Courier'] as const) {
    for (const bold of [false, true]) {
      for (const italic of [false, true]) {
        const face = { family, bold, italic };
        const embedded = await document.embedFont(StandardFonts[paragraphStandardFontKey(face)]);
        near(measureParagraphText('AV home fine — £25', face, 12), embedded.widthOfTextAtSize('AV home fine — £25', 12));
      }
    }
  }
});

test('plain typography substitutions are measured and placed as the exported text', () => {
  const text = 'ﬁne\u2011grain\u2009text';
  const exported = 'fine-grain text';
  near(measureParagraphText(text, regular, 12), measureParagraphText(exported, regular, 12));
  const [piece] = layoutParagraphLines([[{ text, face: regular }]], options);
  assert.equal(piece.text, exported);
  near(piece.width, measureParagraphText(exported, regular, 12));
  assert.throws(() => measureParagraphText('漢', regular, 12), /encode/i);
});

test('layout retains explicit empty lines and uses the same baseline for all mixed-style pieces', () => {
  const positioned = layoutParagraphLines([
    [{ text: 'Strong ', face: bold }, { text: 'body', face: regular }],
    [],
    [{ text: 'Final', face: regular }],
  ], options);
  assert.deepEqual(positioned.map((piece) => piece.y), [12, 12, 44]);
  assert.deepEqual(positioned.map((piece) => piece.lineIndex), [0, 0, 2]);
  assert.deepEqual(positioned.map((piece) => piece.face.key), ['bold', 'regular', 'regular']);
  near(positioned[1].x, positioned[0].width);
});

test('center and right alignment use the measured whole-line width', () => {
  const line = [{ text: 'Bold ', face: bold }, { text: 'body', face: regular }];
  for (const align of ['center', 'right'] as const) {
    const positioned = layoutParagraphLines([line], { ...options, align });
    const width = positioned.reduce((total, piece) => total + piece.width, 0);
    near(positioned[0].x, (options.width - width) / (align === 'center' ? 2 : 1));
    near(positioned[1].x, positioned[0].x + positioned[0].width);
  }
});

test('justification stretches real word gaps without separating style fragments inside a word', () => {
  const positioned = layoutParagraphLines([
    [{ text: 'pre', face: bold }, { text: 'fix ', face: regular }, { text: 'word', face: bold }],
    [{ text: 'Last line', face: regular }],
  ], { ...options, align: 'justify' });
  const first = positioned.filter((piece) => piece.lineIndex === 0);
  assert.deepEqual(first.map((piece) => piece.text), ['pre', 'fix', ' ', 'word']);
  near(first[1].x, first[0].width);
  near(first[3].x + first[3].width, options.width);
  assert.equal(positioned[positioned.length - 1].x, 0);
  assert.equal(positioned[positioned.length - 1].text, 'Last line');
});

test('long replacements wrap using the same face advances used by preview and export placement', () => {
  const faces: Record<string, ParagraphFace> = { regular, bold };
  const measure = (text: string, key: string) => measureParagraphText(text, faces[key], 12);
  const width = 112;
  const wrapped = wrapStyledText([[{ text: 'A longer replacement ', fontKey: 'regular' }, { text: 'keeps its bold style', fontKey: 'bold' }]], measure, width);
  assert.ok(wrapped.length > 1);
  const lines = wrapped.map((line) => line.map((piece) => ({ text: piece.text, face: faces[piece.fontKey] })));
  const preview = layoutParagraphLines(lines, { ...options, width });
  assert.deepEqual(lines.map((line) => line.map((piece) => piece.text).join('')), wrapped.map(styledLineText));
  for (const piece of preview) {
    near(piece.width, measure(piece.text, piece.face.key));
    assert.ok(piece.x + piece.width <= width + 0.00001);
    near(piece.y, 12 + piece.lineIndex * 16);
  }
  assert.ok(preview.some((piece) => piece.face.bold));
});


test('pasted tabs have the same printable width in preview and export', () => {
  const [piece] = layoutParagraphLines([[{ text: 'a\tb', face: regular }]], options);
  assert.equal(piece.text, 'a    b');
  near(piece.width, measureParagraphText('a\tb', regular, 12));
});

test('all platform line separators become stable paragraph boundaries', () => {
  assert.equal(normalizeParagraphLineBreaks('first\rsecond\r\nthird\u2028fourth\u2029fifth'),
    'first\nsecond\nthird\nfourth\nfifth');
  for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
    assert.deepEqual(unencodableCharacters(separator, substitutedFont), []);
    assert.doesNotThrow(() => measureParagraphText(`before${separator}after`, regular, 12));
  }
});

test('every BMP character allowed by the standard-font guard can be measured', () => {
  for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (unencodableCharacters(character, substitutedFont).length > 0) continue;
    assert.doesNotThrow(
      () => measureParagraphText(character, regular, 12),
      `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} passed the guard but could not be measured`,
    );
  }
});
