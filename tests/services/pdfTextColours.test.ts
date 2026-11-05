import assert from 'node:assert/strict';
import test from 'node:test';

import { glyphInkColors, inkResidual, type GlyphInk, type Rgb } from '../../services/pdfGlyphInks.ts';
import {
  blockStyledSegments,
  planBlockEdit,
  preserveStyledTextEdit,
  replaceInStyledLines,
  segmentInks,
  splitByInk,
  styledTextEqual,
  withoutInks,
  type StyledSegment,
} from '../../services/pdfBlockEditPlanning.ts';
import { buildTextBlocks, type PositionedTextSource } from '../../services/pdfTextBlocks.ts';
import { layoutParagraphLines } from '../../services/pdfParagraphLayout.ts';

const PAPER: Rgb = [255, 255, 255];
const BLACK = '#000000';
const RED = '#dc1a1a';

/** A glyph whose body is `color`, as the editor reads it from the rendered page. */
const glyph = (color: Rgb): GlyphInk => ({
  color,
  strength: color.reduce((total, value, index) => total + Math.abs(value - PAPER[index]), 0),
});
const black = glyph([0, 0, 0]);
const red = glyph([220, 26, 26]);
const inksOf = (pattern: string) => [...pattern].map((mark) => (mark === 'r' ? red : mark === 'b' ? black : null));

const run = (itemIndex: number, text: string, x: number, width: number, y = 100): PositionedTextSource => ({
  itemIndex, text, x, y, width, fontSize: 12, angle: 0, fontKey: 'f1',
  blank: text.trim() === '', endsLine: false,
  sourcePdfRect: [x, 800 - y, x + width, 800 - y + 12],
});

test('a paragraph in one colour, edges and all, keeps the paragraph colour', () => {
  // Anti-aliased edges are the same ink blended with the paper, not a second colour.
  const grey = glyph([150, 150, 150]);
  assert.deepEqual(glyphInkColors([[black, grey, null, black, glyph([90, 90, 90])]], PAPER), { lines: null, dominant: BLACK });
  assert.ok(inkResidual([150, 150, 150], [0, 0, 0], PAPER) < 1);
});

test('a red word inside a black sentence keeps its own colour, character by character', () => {
  const result = glyphInkColors([inksOf('bb_rrr_bb')], PAPER);
  assert.ok(result);
  assert.equal(result.dominant, BLACK);
  // The spaces around the red word belong to the black text, as they do in the document.
  assert.deepEqual(result.lines[0], [BLACK, BLACK, BLACK, RED, RED, RED, BLACK, BLACK, BLACK]);
  // Between two highlighted words, a space still goes with the paragraph's main colour.
  const blue = glyph([26, 64, 217]);
  assert.deepEqual(glyphInkColors([[black, black, black, red, null, blue]], PAPER)?.lines[0].slice(3),
    [RED, BLACK, '#1a40d9']);
});

test('a pale edge of a red glyph is still red, not a third colour', () => {
  const paleRed = glyph([238, 140, 140]);
  const result = glyphInkColors([[black, black, red, paleRed]], PAPER);
  assert.deepEqual(result?.lines[0], [BLACK, BLACK, RED, RED]);
});

test('characters before the first ink take the colour after them', () => {
  assert.deepEqual(glyphInkColors([inksOf('__rb')], PAPER)?.lines[0], [RED, RED, RED, BLACK]);
});

test('a paragraph mixing colours splits its runs where the colour changes', () => {
  const block = buildTextBlocks([run(0, 'by Friday ok', 72, 70)], 0)[0];
  const inks = [[...'by '].map(() => BLACK).concat([...'Friday'].map(() => RED), [...' ok'].map(() => BLACK))];
  assert.deepEqual(blockStyledSegments(block, inks)[0].map(({ text, color }) => ({ text, color })), [
    { text: 'by ', color: BLACK }, { text: 'Friday', color: RED }, { text: ' ok', color: BLACK },
  ]);
  // Without colours the segments are exactly what they always were.
  assert.deepEqual(blockStyledSegments(block), [[{ text: 'by Friday ok', fontKey: 'f1', fontSize: 12 }]]);
});

const sentence = (): StyledSegment[][] => [[
  { text: 'by ', fontKey: 'f1', color: BLACK },
  { text: 'Friday', fontKey: 'f1', color: RED },
  { text: ' ok', fontKey: 'f1', color: BLACK },
]];
const coloured = (lines: StyledSegment[][]) => lines[0].map(({ text, color }) => `${text}:${color === RED ? 'red' : 'black'}`);

test('typing inside or at the end of a red word keeps it red', () => {
  const fallback = { text: '', fontKey: 'f1' };
  assert.deepEqual(coloured(preserveStyledTextEdit(sentence(), 'by Friiday ok', fallback, { start: 6, end: 6 })),
    ['by :black', 'Friiday:red', ' ok:black']);
  assert.deepEqual(coloured(preserveStyledTextEdit(sentence(), 'by Fridays ok', fallback, { start: 9, end: 9 })),
    ['by :black', 'Fridays:red', ' ok:black']);
  // Replacing the whole word inherits the colour of its first character.
  assert.deepEqual(coloured(preserveStyledTextEdit(sentence(), 'by Monday ok', fallback, { start: 3, end: 9 })),
    ['by :black', 'Monday:red', ' ok:black']);
});

test('find and replace keeps a coloured word coloured', () => {
  const { lines } = replaceInStyledLines(sentence(), 'Friday', 'Monday');
  assert.deepEqual(coloured(lines), ['by :black', 'Monday:red', ' ok:black']);
});

test('colour counts as a change of style, except to an in-place rewrite', () => {
  const plain = withoutInks(sentence());
  assert.deepEqual(plain, [[{ text: 'by Friday ok', fontKey: 'f1' }]]);
  assert.equal(styledTextEqual(sentence(), plain, 12), false);
  assert.equal(styledTextEqual(sentence(), plain, 12, false), true);
  assert.deepEqual(segmentInks(sentence()[0])?.slice(2, 4), [BLACK, RED]);
  assert.equal(segmentInks(plain[0]), undefined);
  assert.deepEqual(splitByInk('abc', [RED, RED, undefined]), [{ text: 'ab', color: RED }, { text: 'c' }]);
});

test('an in-place edit keeps working on a coloured paragraph', () => {
  const block = buildTextBlocks([run(0, 'by Friday ok', 72, 70)], 0)[0];
  const inks = [[...block.lines[0].text].map((_, index) => (index >= 3 && index < 9 ? RED : BLACK))];
  const segments = preserveStyledTextEdit(blockStyledSegments(block, inks), 'by Fridax ok',
    { text: '', fontKey: 'f1' }, { start: 8, end: 9 });
  assert.equal(planBlockEdit(block, 'by Fridax ok', { segments, inks }).mode, 'direct');
});

test('an in-place edit that would pour one colour into another is redrawn instead', () => {
  // "Impor" and a red "tant" are separate runs with no gap, so the line reads "Important".
  const block = buildTextBlocks([run(0, 'Impor', 72, 30), run(1, 'tant', 102, 22)], 0)[0];
  assert.equal(block.lines[0].text, 'Important');
  const inks = [[...'Important'].map((_, index) => (index < 5 ? BLACK : RED))];
  // Replacing "rt" touches both runs, so the surviving "ant" would move into the black run.
  assert.equal(planBlockEdit(block, 'ImpoRTant').mode, 'direct');
  const plan = planBlockEdit(block, 'ImpoRTant', { inks });
  assert.equal(plan.mode, 'reflow');
  if (plan.mode === 'reflow') assert.match(plan.reason, /colours/);
  // An edit inside the red run alone stays in place.
  assert.equal(planBlockEdit(block, 'Importent', { inks }).mode, 'direct');
});

test('a word drawn in two colours inside one merged run is redrawn, as the save will do', () => {
  // PDF.js hands "Impor" and a red "tant" over as one run when they share a font.
  const block = buildTextBlocks([run(0, 'Partial Important note', 72, 120)], 0)[0];
  const inks = [[...block.lines[0].text].map((_, index) => (index >= 13 && index < 17 ? RED : BLACK))];
  const plan = planBlockEdit(block, 'Partial Importent note', { inks });
  assert.equal(plan.mode, 'reflow');
  if (plan.mode === 'reflow') assert.match(plan.reason, /colours/);
  // A word in one colour, even right beside the mixed one, still goes straight into the PDF.
  assert.equal(planBlockEdit(block, 'Partial Important notes', { inks }).mode, 'direct');
  assert.equal(planBlockEdit(block, 'Partiel Important note', { inks }).mode, 'direct');
});

test('a redrawn paragraph lays each stretch out with its own colour', () => {
  const face = { key: 'f1', family: 'Helvetica' as const, bold: false, italic: false };
  const pieces = layoutParagraphLines([[
    { text: 'by ', face, color: BLACK },
    { text: 'Friday', face, color: RED },
    { text: ' ok', face },
  ]], { width: 200, fontSize: 12, lineHeight: 14, align: 'left' });
  assert.deepEqual(pieces.map(({ text, color }) => [text, color]), [['by ', BLACK], ['Friday', RED], [' ok', undefined]]);
});
