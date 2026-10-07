import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  layoutParagraphLines,
  measureParagraphText,
  normalizeParagraphLineBreaks,
  paragraphLineOrigins,
  paragraphStandardFontKey,
} from '../../services/pdfParagraphLayout.ts';
import { styledLineText, wrapStyledText } from '../../services/pdfBlockEditPlanning.ts';
import { unencodableCharacters, type ResolvedFont } from '../../services/pdfFontResolution.ts';
import type { ParagraphFace } from '../../services/pdfDocument.ts';
import type { PdfTextBlock } from '../../services/pdfTextBlocks.ts';

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

test('redraw keeps different sizes even when adjacent runs use the same face', () => {
  const lines = [[
    { text: 'Heading ', face: regular, fontSize: 15.96 },
    { text: 'body ', face: regular, fontSize: 12 },
    { text: 'small', face: regular, fontSize: 10 },
  ]];
  for (const align of ['left', 'justify'] as const) {
    const pieces = layoutParagraphLines(align === 'justify' ? [...lines, [{ text: 'Last', face: regular }]] : lines,
      { ...options, align });
    const firstLine = pieces.filter(piece => piece.lineIndex === 0);
    assert.deepEqual(firstLine.map(piece => piece.fontSize), align === 'justify' ? [15.96, 15.96, 12, 12, 10] : [15.96, 12, 10]);
    for (const piece of firstLine) {
      near(piece.width, measureParagraphText(piece.text, piece.face, piece.fontSize));
    }
    assert.deepEqual([...new Set(pieces.filter(piece => piece.lineIndex === 0).map(piece => piece.fontSize))], [15.96, 12, 10]);
  }
});

test('an extended amount retains its explicit row and original baseline despite exceeding the old width', () => {
  const lines = [[{ text: '2099 Dr fdagadga', face: regular }]];
  const [piece] = layoutParagraphLines(lines, {
    ...options, width: 42, align: 'right', lineOrigins: [{ x: 0, y: 9.5 }],
  });
  assert.equal(piece.text, lines[0][0].text);
  assert.equal(piece.lineIndex, 0);
  near(piece.x, 0);
  near(piece.y, 9.5);
  assert.ok(piece.width > 42, 'long text should extend sideways instead of wrapping');
});

test('redraw retains irregular PDF baselines and indents, while Enter creates only one explicit row', () => {
  const block = {
    fontSize: 12, ascent: 9.5, leading: 19, padLeft: 0, textIndent: 0,
    lines: [{ u0: 220, v: 100 }, { u0: 224, v: 119 }, { u0: 220, v: 134 }],
  } as PdfTextBlock;
  const original = paragraphLineOrigins(block, 3, 12);
  assert.deepEqual(original, [{ x: 0, y: 9.5 }, { x: 4, y: 28.5 }, { x: 0, y: 43.5 }]);
  const lines = ['Extended amount still here', 'Second row', 'Third row'].map(text => [{ text, face: regular }]);
  const positioned = layoutParagraphLines(lines, { ...options, width: 42, lineOrigins: original });
  assert.deepEqual(positioned.map(({ x, y }) => ({ x, y })), original);
  const entered = [...lines, [{ text: 'Intentional new row', face: bold }]];
  const afterEnter = layoutParagraphLines(entered, {
    ...options, width: 42, lineOrigins: paragraphLineOrigins(block, entered.length, 12),
  });
  assert.equal(afterEnter.length, positioned.length + 1);
  near(afterEnter[0].y, original[0].y);
  assert.deepEqual(paragraphLineOrigins(block, 3, 12), original, 'Undo restores original row geometry');
});

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

test('Enter retains center and right alignment while unchanged row counts retain PDF origins', () => {
  for (const align of ['center', 'right'] as const) {
    const block = {
      fontSize: 12, ascent: 9.5, leading: 16, padLeft: 20, textIndent: -20, align,
      lines: [{ u0: 100, v: 100 }, { u0: 120, v: 116 }],
    } as PdfTextBlock;
    assert.deepEqual(paragraphLineOrigins(block, 2, 12), [{ x: 0, y: 9.5 }, { x: 20, y: 25.5 }]);
    const lines = ['First part', 'Second part', 'Last row'].map(text => [{ text, face: regular }]);
    const pieces = layoutParagraphLines(lines, {
      ...options, align, lineOrigins: paragraphLineOrigins(block, 3, 12),
    });
    pieces.forEach((piece, index) => {
      near(piece.x, (options.width - piece.width) / (align === 'center' ? 2 : 1));
      near(piece.y, 9.5 + index * 16);
    });
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
