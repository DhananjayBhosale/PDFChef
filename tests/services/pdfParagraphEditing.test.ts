import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleLines,
  buildTextBlocks,
  detectTextDirection,
  positionTextItems,
  type PositionedTextSource,
} from '../../services/pdfTextBlocks.ts';
import {
  blockStyledSegments,
  findInStyledLines,
  planBlockEdit,
  preserveStyledTextEdit,
  replaceInStyledLines,
  styledLineText,
  wrapStyledText,
} from '../../services/pdfBlockEditPlanning.ts';
import {
  classifyFont,
  fitTextMetrics,
  resolveFont,
  substituteForStandardFont,
  unencodableCharacters,
} from '../../services/pdfFontResolution.ts';

/** Build an upright run at (x, baselineY) with the given advance width. */
const run = (
  itemIndex: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 12,
  fontKey = 'g_d0_f1',
): PositionedTextSource => ({
  itemIndex,
  text,
  x,
  y,
  width,
  fontSize,
  angle: 0,
  fontKey,
  blank: text.trim() === '',
  endsLine: false,
  sourcePdfRect: [x, 800 - y, x + width, 800 - y + fontSize],
});

test('runs on a shared baseline become one line with the spaces the PDF omitted', () => {
  const lines = assembleLines([
    run(0, 'Privacy', 72, 100, 44),
    run(1, 'first', 122, 100, 26),
    run(2, 'PDF', 152, 100, 24),
  ], 1, 0);

  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Privacy first PDF');
  // Two synthetic spaces plus the three real runs.
  assert.equal(lines[0].runs.length, 5);
  assert.deepEqual(
    lines[0].runs.map((entry) => entry.itemIndex),
    [0, -1, 1, -1, 2],
  );
});

test('a wide horizontal gap splits columns instead of inserting a space', () => {
  const lines = assembleLines([
    run(0, 'Left', 72, 100, 30),
    run(1, 'Right', 320, 100, 34),
  ], 1, 0);

  assert.deepEqual(lines.map((line) => line.text), ['Left', 'Right']);
});

test('a wide blank run between columns splits them, rather than reading as one space', () => {
  // PDF.js reports the space between two columns as one blank item spanning the whole gap, so the
  // runs on either side touch it and there is no gap left to measure between them.
  const blank = { ...run(1, ' ', 168, 100, 162), blank: true };
  const lines = assembleLines([
    run(0, 'Left column line one', 60, 100, 108),
    blank,
    run(2, 'Right column line one', 330, 100, 108),
  ], 1, 0);

  assert.deepEqual(lines.map((line) => line.text), ['Left column line one', 'Right column line one']);
  // The blank that spanned the gap is dropped rather than kept as a trailing space.
  assert.deepEqual(lines[0].runs.map((entry) => entry.text), ['Left column line one']);
});

test('a narrow blank run is the space it looks like and keeps the line together', () => {
  const blank = { ...run(1, ' ', 100, 100, 5), blank: true };
  const lines = assembleLines([
    run(0, 'Note:', 72, 100, 28),
    blank,
    run(2, 'the body text follows', 105, 100, 96),
  ], 1, 0);

  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Note: the body text follows');
});

test('consecutive lines with a steady pitch group into one paragraph', () => {
  const blocks = buildTextBlocks([
    run(0, 'The first line of the paragraph', 72, 100, 180),
    run(1, 'continues onto a second line', 72, 116, 172),
    run(2, 'and finishes on a third.', 72, 132, 150),
  ], 0);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 3);
  assert.equal(blocks[0].text, 'The first line of the paragraph\ncontinues onto a second line\nand finishes on a third.');
  assert.equal(blocks[0].align, 'left');
  assert.equal(blocks[0].leading, 16);
  // The block box starts an ascent above the first baseline.
  assert.ok(blocks[0].top < 100 && blocks[0].top > 80);
});

test('a heading and a body paragraph stay separate blocks', () => {
  const blocks = buildTextBlocks([
    run(0, 'Heading', 72, 100, 90, 24),
    run(1, 'Body text starts here', 72, 140, 130, 12),
    run(2, 'and wraps to a second line', 72, 156, 140, 12),
  ], 0);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'Heading');
  assert.equal(blocks[1].lines.length, 2);
});

test('two columns become two paragraphs, not eight orphaned lines', () => {
  // Lines arrive interleaved down the page, so a sequential walk would see every one as new.
  const items = [];
  for (let line = 0; line < 4; line += 1) {
    items.push(run(line * 2, `Left column line ${line + 1}`, 60, 100 + line * 14, 108, 10));
    items.push(run(line * 2 + 1, `Right column line ${line + 1}`, 330, 100 + line * 14, 108, 10));
  }
  const blocks = buildTextBlocks(items, 0);

  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.lines.length), [4, 4]);
  assert.match(blocks[0].text, /^Left column line 1\nLeft column line 2/);
  assert.match(blocks[1].text, /^Right column line 1\nRight column line 2/);
});

test('a full-width heading above two columns does not weld them together', () => {
  const items = [run(0, 'A heading that spans both columns', 60, 80, 380, 16)];
  for (let line = 0; line < 3; line += 1) {
    items.push(run(1 + line * 2, `Left body line ${line + 1}`, 60, 110 + line * 14, 108, 10));
    items.push(run(2 + line * 2, `Right body line ${line + 1}`, 330, 110 + line * 14, 108, 10));
  }
  const blocks = buildTextBlocks(items, 0);

  assert.equal(blocks.length, 3, 'expected the heading and one paragraph per column');
  assert.equal(blocks[0].text, 'A heading that spans both columns');
  assert.deepEqual(blocks.slice(1).map((block) => block.lines.length), [3, 3]);
});

test('a short last line stays with the paragraph it ends', () => {
  const blocks = buildTextBlocks([
    run(0, 'A full width line of body text that runs the measure', 72, 100, 300),
    run(1, 'another full width line of the same paragraph here', 72, 116, 300),
    run(2, 'a short last line.', 72, 132, 90),
  ], 0);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 3);
});

test('a bullet starts a new block even when the pitch is unchanged', () => {
  const blocks = buildTextBlocks([
    run(0, 'Intro line one', 72, 100, 90),
    run(1, '• First bullet', 72, 116, 88),
  ], 0);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].text, '• First bullet');
});

test('a list whose bullets sit in their own column becomes one block per item', () => {
  // Six items sharing a left edge and a pitch look exactly like a six-line paragraph. The markers
  // beside them are the only thing that says they are not.
  const items = [];
  for (let item = 0; item < 4; item += 1) {
    items.push(run(item * 2, '\u2022', 60, 100 + item * 16, 6, 10));
    items.push(run(item * 2 + 1, `List item ${item + 1} with some words in it`, 78, 100 + item * 16, 150, 10));
  }
  const blocks = buildTextBlocks(items, 0);

  // The markers group into their own column block; the items are what is left.
  const textBlocks = blocks.filter((block) => block.text.split('\n').some((line) => line.trim() !== '\u2022'));
  assert.equal(textBlocks.length, 4, 'each list item should stand on its own');
  assert.deepEqual(textBlocks.map((block) => block.lines.length), [1, 1, 1, 1]);

  // Without the markers, the same four lines are one paragraph.
  const plain = buildTextBlocks(
    Array.from({ length: 4 }, (_, item) => run(item, `List item ${item + 1} with some words in it`, 78, 100 + item * 16, 150, 10)),
    0,
  );
  assert.equal(plain.length, 1);
  assert.equal(plain[0].lines.length, 4);
});

test('a bullet keeps its wrapped continuation but not the paragraph after it', () => {
  const wrapped = buildTextBlocks([
    run(0, '• A bullet whose text runs on', 72, 100, 150),
    run(1, 'and wraps under its own text', 82, 116, 145),
  ], 0);
  assert.equal(wrapped.length, 1, 'an indented continuation belongs to its bullet');
  assert.equal(wrapped[0].lines.length, 2);

  const separate = buildTextBlocks([
    run(0, '• A bullet whose text runs on', 72, 100, 150),
    run(1, 'A new paragraph at the same margin', 72, 116, 160),
  ], 0);
  assert.equal(separate.length, 2, 'a line back at the marker margin starts something new');
});

test('rotated runs group in reading space rather than page space', () => {
  const rotated = (itemIndex: number, text: string, x: number, y: number, width: number) => ({
    ...run(itemIndex, text, x, y, width),
    angle: -Math.PI / 2,
  });
  // A vertical caption: baselines advance upward, successive lines move right.
  const blocks = buildTextBlocks([
    rotated(0, 'Vertical caption', 40, 300, 96),
    rotated(1, 'second line here', 56, 300, 92),
  ], 0);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 2);
  assert.ok(Math.abs(blocks[0].angle + Math.PI / 2) < 1e-9);
});

test('positionTextItems reads font size from the transform, not the reported height', () => {
  const identity = [1, 0, 0, -1, 0, 800];
  const transform = (a: number[], b: number[]) => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];

  const [item] = positionTextItems(
    [{ str: 'Scaled', transform: [18, 0, 0, 18, 72, 700], width: 60, height: 0, fontName: 'g_d0_f1' }],
    identity,
    transform,
    1,
  );

  assert.equal(item.fontSize, 18);
  assert.equal(item.x, 72);
  assert.equal(item.y, 100);
  assert.equal(item.angle, 0);
});

const paragraph = () => buildTextBlocks([
  run(0, 'Privacy', 72, 100, 44),
  run(1, 'first', 122, 100, 26),
  run(2, 'PDF', 152, 100, 24),
  run(3, 'tools', 72, 116, 30),
], 0)[0];

test('editing one word rewrites only that PDF text object', () => {
  const block = paragraph();
  const plan = planBlockEdit(block, 'Privacy second PDF\ntools');

  assert.equal(plan.mode, 'direct');
  if (plan.mode !== 'direct') return;
  assert.equal(plan.runEdits.length, 1);
  assert.equal(plan.runEdits[0].itemIndex, 1);
  assert.equal(plan.runEdits[0].sourceText, 'first');
  assert.equal(plan.runEdits[0].replacementText, 'second');
});

test('an unchanged paragraph plans no work at all', () => {
  const block = paragraph();
  assert.equal(planBlockEdit(block, block.text).mode, 'unchanged');
});

test('adding or removing a line falls back to reflow', () => {
  const block = paragraph();
  assert.equal(planBlockEdit(block, 'Privacy first PDF\ntools\nextra').mode, 'reflow');
  assert.equal(planBlockEdit(block, 'Privacy first PDF tools').mode, 'reflow');
});

test('an edit that lands on positioned spacing falls back to reflow', () => {
  const block = paragraph();
  // Replacing the gap between two words targets a space the PDF never stored.
  const plan = planBlockEdit(block, 'Privacyfirst PDF\ntools');
  assert.equal(plan.mode, 'reflow');
});

test('text too long for the space before the next word falls back to reflow', () => {
  const block = paragraph();
  const measure = (text: string, fontSize: number) => text.length * fontSize * 0.6;
  const fits = planBlockEdit(block, 'Privacy at PDF\ntools', { measure });
  assert.equal(fits.mode, 'direct');

  const overflows = planBlockEdit(
    block,
    'Privacy absolutely enormous replacement PDF\ntools',
    { measure },
  );
  assert.equal(overflows.mode, 'reflow');
  if (overflows.mode !== 'reflow') return;
  assert.match(overflows.reason, /needs more room than the .* points before the next word/);
});

test('the last word on a line may grow until it would leave the page', () => {
  const block = paragraph();
  const measure = (text: string, fontSize: number) => text.length * fontSize * 0.6;
  assert.equal(planBlockEdit(block, 'Privacy first PDFs\ntools', { measure, maxU: 540 }).mode, 'direct');
  const overflows = planBlockEdit(
    block,
    `Privacy first ${'x'.repeat(90)}\ntools`,
    { measure, maxU: 540 },
  );
  assert.equal(overflows.mode, 'reflow');
  if (overflows.mode !== 'reflow') return;
  assert.match(overflows.reason, /off the edge of the page/);
});

test('deleting a word empties its own object and leaves neighbours alone', () => {
  const block = paragraph();
  const plan = planBlockEdit(block, 'Privacy PDF\ntools');

  assert.equal(plan.mode, 'reflow', 'removing a word also removes positioned spacing');

  const single = buildTextBlocks([run(0, 'Alpha Beta', 72, 100, 70)], 0)[0];
  const inner = planBlockEdit(single, 'Alpha Gamma');
  assert.equal(inner.mode, 'direct');
  if (inner.mode !== 'direct') return;
  assert.deepEqual(
    inner.runEdits.map(({ sourceText, replacementText }) => ({ sourceText, replacementText })),
    [{ sourceText: 'Alpha Beta', replacementText: 'Alpha Gamma' }],
  );
});

test('a rotated paragraph can be rewritten in place but never redrawn', () => {
  const rotated = buildTextBlocks([
    { ...run(0, 'Vertical caption here', 40, 300, 120), angle: -Math.PI / 2 },
  ], 0)[0];

  // Same-length rewrites still map onto the original text objects.
  const inPlace = planBlockEdit(rotated, 'Vertical caption there');
  assert.equal(inPlace.mode, 'direct');

  // Anything that would need a repaint is refused rather than drawn along the wrong axis.
  const blocked = planBlockEdit(rotated, 'Vertical caption here\nand a second line');
  assert.equal(blocked.mode, 'blocked');
  if (blocked.mode !== 'blocked') return;
  assert.match(blocked.reason, /rotated or skewed text cannot be redrawn/);

  // The same edit on upright text is an ordinary reflow.
  const upright = buildTextBlocks([run(0, 'Vertical caption here', 40, 300, 120)], 0)[0];
  assert.equal(planBlockEdit(upright, 'Vertical caption here\nand a second line').mode, 'reflow');
});

test('wrapping keeps the paragraph inside its original measure', () => {
  const measure = (text: string) => text.length * 6;
  const plain = (text: string) => [[{ text, fontKey: 'body' }]];
  assert.deepEqual(
    wrapStyledText(plain('one two three four five'), measure, 60).map(styledLineText),
    ['one two', 'three four', 'five'],
  );
  assert.deepEqual(wrapStyledText(plain('short'), measure, 60).map(styledLineText), ['short']);
});

test('wrapping keeps each stretch with the face it is drawn in', () => {
  // A bold word is wider than the body face, and the wrap has to account for that.
  const measure = (text: string, fontKey: string) => text.length * (fontKey === 'bold' ? 9 : 6);
  const wrapped = wrapStyledText([[
    { text: 'Note:', fontKey: 'bold' },
    { text: ' the body text continues here', fontKey: 'body' },
  ]], measure, 90);

  assert.deepEqual(wrapped.map(styledLineText), ['Note: the', 'body text', 'continues here']);
  assert.deepEqual(wrapped[0], [
    { text: 'Note:', fontKey: 'bold' },
    { text: ' the', fontKey: 'body' },
  ], 'the bold lead-in must not be absorbed into the body face');
  assert.deepEqual(wrapped[1].map((segment) => segment.fontKey), ['body']);
});

test('wrapping drops the space a line would otherwise start with', () => {
  const measure = (text: string) => text.length * 10;
  const wrapped = wrapStyledText([[{ text: 'alpha beta gamma', fontKey: 'body' }]], measure, 60);
  assert.deepEqual(wrapped.map(styledLineText), ['alpha', 'beta', 'gamma']);
});

test('font classification reads the PostScript name before the CSS fallback', () => {
  assert.equal(classifyFont({ psName: 'ABCDEF+Times-Roman', fallbackFamily: 'sans-serif' }), 'serif');
  assert.equal(classifyFont({ psName: 'ABCDEF+Courier', fallbackFamily: 'serif' }), 'monospace');
  assert.equal(classifyFont({ psName: '', fallbackFamily: 'monospace' }), 'monospace');
  assert.equal(classifyFont({ psName: 'Unknown-Face', fallbackFamily: 'serif' }), 'serif');
});

test('a font that is not embedded substitutes and says why', () => {
  const resolved = resolveFont({
    key: 'g_d0_f1',
    psName: 'Times-Roman',
    loadedName: '',
    fallbackFamily: 'serif',
    ascent: 0.75,
    descent: -0.22,
    vertical: false,
    bold: false,
    italic: true,
    isType3: false,
    embedded: false,
    data: null,
    resolution: 'read',
  }, 'Sample');

  assert.equal(resolved.mode, 'substituted');
  assert.equal(resolved.klass, 'serif');
  assert.equal(resolved.cssStyle, 'italic');
  assert.match(resolved.reason ?? '', /not embedded/);
});

test('width fitting prefers word spacing and only then falls back to letter spacing', () => {
  const font = {
    mode: 'substituted' as const,
    cssFamily: 'serif',
    cssWeight: '400',
    cssStyle: 'normal',
    klass: 'serif' as const,
    reason: null,
    missingGlyphs: [],
  };
  // Without a DOM canvas the measurement falls back to 0.5em per character.
  const text = 'one two three';
  const naturalWidth = text.length * 12 * 0.5;

  const spread = fitTextMetrics(text, naturalWidth + 4, font, 12);
  assert.ok(spread.wordSpacing > 0 && spread.letterSpacing === 0);

  const extreme = fitTextMetrics(text, naturalWidth + 400, font, 12);
  assert.ok(extreme.letterSpacing > 0, 'a delta too large for word spacing spills into letter spacing');
  assert.ok(extreme.letterSpacing <= 0.09 * 12 + 1e-9, 'letter spacing stays inside its cap');
});

const styled = (...lines: Array<Array<[string, string]>>) =>
  lines.map((line) => line.map(([text, fontKey]) => ({ text, fontKey })));

test('find reports every occurrence, per line, ignoring case by default', () => {
  const lines = styled(
    [['The cat sat on the ', 'body'], ['CAT', 'bold'], [' mat', 'body']],
    [['no match on this line', 'body']],
    [['cat and cat again', 'body']],
  );

  assert.deepEqual(findInStyledLines(lines, 'cat'), [
    { line: 0, start: 4, end: 7 },
    { line: 0, start: 19, end: 22 },
    { line: 2, start: 0, end: 3 },
    { line: 2, start: 8, end: 11 },
  ]);
  assert.deepEqual(findInStyledLines(lines, 'cat', true), [
    { line: 0, start: 4, end: 7 },
    { line: 2, start: 0, end: 3 },
    { line: 2, start: 8, end: 11 },
  ]);
  assert.deepEqual(findInStyledLines(lines, ''), []);
});

test('replace keeps each occurrence in the face it was drawn in', () => {
  const lines = styled([['The cat sat on the ', 'body'], ['CAT', 'bold'], [' mat', 'body']]);
  const { lines: next, replaced } = replaceInStyledLines(lines, 'cat', 'dog');

  assert.equal(replaced, 2);
  assert.equal(styledLineText(next[0]), 'The dog sat on the dog mat');
  // The bold occurrence stays bold, the body one stays body.
  assert.deepEqual(next[0], [
    { text: 'The dog sat on the ', fontKey: 'body' },
    { text: 'dog', fontKey: 'bold' },
    { text: ' mat', fontKey: 'body' },
  ]);
});

test('replace can be limited to the one occurrence the user is looking at', () => {
  const lines = styled([['cat and cat again', 'body']]);
  const { lines: next, replaced } = replaceInStyledLines(lines, 'cat', 'dog', false, { line: 0, start: 8, end: 11 });

  assert.equal(replaced, 1);
  assert.equal(styledLineText(next[0]), 'cat and dog again');
});

test('replace handles a term that straddles two faces', () => {
  // "cat" is split across a bold "ca" and a body "t"; the replacement takes the leading face.
  const lines = styled([['the ', 'body'], ['ca', 'bold'], ['t sat', 'body']]);
  const { lines: next, replaced } = replaceInStyledLines(lines, 'cat', 'dog');

  assert.equal(replaced, 1);
  assert.equal(styledLineText(next[0]), 'the dog sat');
  assert.deepEqual(next[0].map((segment) => segment.fontKey), ['body', 'bold', 'body']);
});

test('a paragraph nobody has edited yet still exposes its runs as segments', () => {
  const block = buildTextBlocks([
    run(0, 'Alpha', 72, 100, 30),
    run(1, 'Beta', 110, 100, 26),
  ], 0)[0];

  const segments = blockStyledSegments(block);
  assert.equal(segments.length, 1);
  assert.equal(styledLineText(segments[0]), 'Alpha Beta');
  assert.deepEqual(findInStyledLines(segments, 'Beta'), [{ line: 0, start: 6, end: 10 }]);
  assert.ok(segments[0].every(segment => segment.fontSize === 12));
});

test('find and replace retains adjacent sizes within the same font', () => {
  const { lines } = replaceInStyledLines([[
    { text: 'Heading ', fontKey: 'regular', fontSize: 16 },
    { text: 'Body', fontKey: 'regular', fontSize: 12 },
  ]], 'Body', 'Longer body');
  assert.deepEqual(lines[0], [
    { text: 'Heading ', fontKey: 'regular', fontSize: 16 },
    { text: 'Longer body', fontKey: 'regular', fontSize: 12 },
  ]);
});

test('a standard face reports the characters it has no glyph for', () => {
  const substituted = {
    mode: 'substituted' as const,
    cssFamily: 'serif',
    cssWeight: '400',
    cssStyle: 'normal',
    klass: 'serif' as const,
    reason: null,
    missingGlyphs: [],
  };

  assert.deepEqual(unencodableCharacters('Café Zürich — naïve', substituted), []);
  assert.deepEqual(unencodableCharacters('Plain ASCII 123 "quoted"', substituted), []);
  assert.deepEqual(unencodableCharacters('Total €50 and “curly” quotes', substituted), []);
  assert.deepEqual(unencodableCharacters('日本語', substituted), ['日', '本', '語']);
  assert.deepEqual(unencodableCharacters('emoji 🙂 here', substituted), ['🙂']);
  // The list is capped: it exists to name the problem, not to enumerate it.
  assert.equal(unencodableCharacters('日本語한국어中文字', substituted).length, 6);
});

test('a right-to-left paragraph is marked as one so the caret lands at the right end', () => {
  assert.equal(detectTextDirection('The quick brown fox'), 'ltr');
  assert.equal(detectTextDirection('مرحبا بالعالم'), 'rtl');
  assert.equal(detectTextDirection('שלום עולם'), 'rtl');
  // A number or a Latin brand name inside Arabic does not flip the paragraph.
  assert.equal(detectTextDirection('مرحبا PDF 2026 بالعالم'), 'rtl');
  assert.equal(detectTextDirection('1234 5678'), 'ltr');

  const blocks = buildTextBlocks([run(0, 'مرحبا بالعالم', 72, 100, 90)], 0);
  assert.equal(blocks[0].direction, 'rtl');
});

test('ordinary typography is written as its plain equivalent, not refused', () => {
  const substituted = {
    mode: 'substituted' as const,
    cssFamily: 'serif',
    cssWeight: '400',
    cssStyle: 'normal',
    klass: 'serif' as const,
    reason: null,
    missingGlyphs: [],
  };

  // A non-breaking hyphen between model numbers is what real documents are full of.
  assert.deepEqual(unencodableCharacters('Pixel 11\u2011Pro', substituted), []);
  assert.equal(substituteForStandardFont('Pixel 11\u2011Pro').text, 'Pixel 11-Pro');
  assert.equal(substituteForStandardFont('12\u2009mm').text, '12 mm');
  assert.equal(substituteForStandardFont('the \ufb01rst \ufb02ag').text, 'the first flag');
  assert.equal(substituteForStandardFont('5\u2032 6\u2033').text, "5' 6\"");
  assert.equal(substituteForStandardFont('plain text').changed, false);

  // A footnote star. Papers put one beside an author's name, and a paragraph that is nothing but
  // that star used to make the whole save impossible.
  assert.equal(substituteForStandardFont('\u2217').text, '*');
  assert.deepEqual(unencodableCharacters('\u2217', substituted), []);
  assert.equal(substituteForStandardFont('1\u20442 and a\u223cb').text, '1/2 and a~b');
  assert.equal(substituteForStandardFont('wide\u2003gap').text, 'wide gap');

  // Something with no plain equivalent still has to be reported.
  assert.deepEqual(unencodableCharacters('日本語', substituted), ['日', '本', '語']);
});

test('a line ending the PDF states is trusted over any gap measurement', () => {
  // Some producers put the break inside the run's own text and set the end-of-line flag with it.
  const first = { ...run(0, 'First list item', 72, 100, 90), endsLine: true };
  const second = { ...run(1, 'Second list item', 72, 100, 95) };
  const lines = assembleLines([first, second], 1, 0);

  assert.deepEqual(lines.map((line) => line.text), ['First list item', 'Second list item']);
});

test('a newline inside a run is a line ending, not a character to lay out', () => {
  const identity = [1, 0, 0, -1, 0, 800];
  const transform = (a: number[], b: number[]) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const [item] = positionTextItems(
    [{ str: 'A line of text\n', transform: [12, 0, 0, 12, 72, 700], width: 80, height: 0, fontName: 'f1' }],
    identity, transform, 1,
  );

  assert.equal(item.text, 'A line of text');
  assert.equal(item.endsLine, true);
});

test('one wide gap in ordinary prose is a space, not a column boundary', () => {
  // A single line with an em-quad indent must not invent a column for the whole paragraph.
  const blocks = buildTextBlocks([
    run(0, 'A heading', 72, 100, 60, 11),
    run(1, 'Body text that follows normally', 72, 116, 170, 11),
    run(2, 'and keeps going on the next line', 72, 132, 175, 11),
    { ...run(3, ' ', 200, 148, 9, 11), blank: true },
    run(4, 'after one wide gap only here', 209, 148, 150, 11),
  ], 0);

  const texts = blocks.map((block) => block.text.replace(/\n/g, ' | '));
  assert.ok(
    texts.some((text) => /Body text that follows normally \| and keeps going/.test(text)),
    `the body paragraph was broken up: ${JSON.stringify(texts)}`,
  );
});

test('column boundaries only count where they come back on another row', () => {
  // Two rows sharing the same two edges: a table. One row with the same gap: prose.
  const table = buildTextBlocks([
    run(0, 'Alpha one', 60, 100, 50, 10),
    { ...run(1, ' ', 110, 100, 8, 10), blank: true },
    run(2, 'Beta one', 118, 100, 46, 10),
    run(3, 'Alpha two', 60, 116, 50, 10),
    { ...run(4, ' ', 110, 116, 8, 10), blank: true },
    run(5, 'Beta two', 118, 116, 46, 10),
  ], 0);
  assert.equal(table.length, 2, 'a recurring edge is a column');
  assert.deepEqual(table.map((block) => block.text), ['Alpha one\nAlpha two', 'Beta one\nBeta two']);

  const prose = buildTextBlocks([
    run(0, 'Alpha one', 60, 100, 50, 10),
    { ...run(1, ' ', 110, 100, 8, 10), blank: true },
    run(2, 'Beta one', 118, 100, 46, 10),
    run(3, 'Alpha two continues without a gap', 60, 116, 110, 10),
  ], 0);
  assert.equal(prose.length, 1, 'an edge seen once is a space');
  assert.match(prose[0].text, /^Alpha one Beta one/);
});

test('a numbered list is split by its markers just as a bulleted one is', () => {
  const items = [];
  for (let item = 0; item < 3; item += 1) {
    items.push(run(item * 2, `${item + 1}.`, 60, 100 + item * 16, 10, 10));
    items.push(run(item * 2 + 1, `Numbered item ${item + 1} of the list`, 82, 100 + item * 16, 140, 10));
  }
  const blocks = buildTextBlocks(items, 0);
  const bodies = blocks.filter((block) => /Numbered item/.test(block.text));
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map((block) => block.lines.length), [1, 1, 1]);
});

test('a marker far from its text is not treated as that line’s marker', () => {
  // A page number in the far margin must not turn every body line into a list item.
  const blocks = buildTextBlocks([
    run(0, '1.', 40, 100, 8, 10),
    run(1, 'Body line one of a plain paragraph', 400, 100, 150, 10),
    run(2, 'body line two of the same paragraph', 400, 116, 152, 10),
  ], 0);
  const body = blocks.find((block) => /Body line one/.test(block.text));
  assert.ok(body, 'the body paragraph is missing');
  assert.equal(body.lines.length, 2, 'a distant marker split a paragraph it does not belong to');
});

test('a font nobody has read yet refuses nothing and says so', () => {
  // PDF.js only parses a font while building a page's drawing operations, so a page that has only
  // had its text extracted reports no font at all. Treating that as "not embedded" would refuse
  // edits the document's own face could have made.
  const unread = {
    key: 'g_d0_f1',
    psName: '',
    loadedName: '',
    fallbackFamily: 'sans-serif',
    ascent: 0.75,
    descent: -0.22,
    vertical: false,
    bold: false,
    italic: false,
    isType3: false,
    embedded: false,
    data: null,
    resolution: 'pending' as const,
  };

  const resolved = resolveFont(unread, 'Sample ○ text');
  assert.equal(resolved.mode, 'substituted');
  assert.match(resolved.reason ?? '', /have not been read yet/);
  // "○" is outside WinAnsi, but the document's own font may well draw it.
  assert.deepEqual(unencodableCharacters('Sample ○ text', resolved, unread), []);
  // Once the page has been read, the same character is judged on the evidence.
  assert.deepEqual(
    unencodableCharacters('Sample ○ text', resolved, { ...unread, resolution: 'read' }),
    ['○'],
  );
});

test('a replacement checks the font of its actual run, even for letters already elsewhere in the paragraph', () => {
  const [block] = buildTextBlocks([
    run(0, 'Label:', 72, 100, 35, 12, 'heading'),
    run(1, ' boat', 107, 100, 35, 12, 'body'),
  ], 0);
  const checked: Array<[string, string]> = [];
  const plan = planBlockEdit(block, block.text.replace('Label:', 'Boat:'), {
    canDraw: (text, fontKey) => {
      checked.push([text, fontKey]);
      return fontKey !== 'heading';
    },
  });
  assert.equal(plan.mode, 'reflow');
  assert.deepEqual(checked, [['Boat:', 'heading']]);
});

test('missing glyphs in a rotated run refuse redraw instead of writing horizontal text', () => {
  const [block] = buildTextBlocks([
    { ...run(0, 'Label', 72, 100, 35), angle: Math.PI / 4 },
  ], 0);
  const plan = planBlockEdit(block, 'Boat', { canDraw: () => false });
  assert.equal(plan.mode, 'blocked');
});

test('reflow encoding checks the edited result against the standard export face', () => {
  const standard = resolveFont({
    key: 'body', psName: 'Helvetica', loadedName: '', fallbackFamily: 'sans-serif',
    ascent: 0.75, descent: -0.22, vertical: false, bold: false, italic: false,
    isType3: false, embedded: false, data: null, resolution: 'read',
  }, 'Hello');
  assert.deepEqual(unencodableCharacters('Hello 世界', standard), ['世', '界']);
  assert.deepEqual(unencodableCharacters('Hello', standard), []);
});

test('fitting substitutions use the original run advance even with substituted browser metrics', () => {
  const [block] = buildTextBlocks([
    run(0, 'A home on the hill', 72, 100, 90),
    run(1, 'Another ordinary line', 72, 116, 100),
  ], 0);
  const measure = (text: string) => text.length * 10;
  const plan = planBlockEdit(block, block.text.replace('home', 'hone'), { measure, maxU: 172 });
  assert.equal(plan.mode, 'direct');
  if (plan.mode !== 'direct') return;
  assert.deepEqual(plan.runEdits.map(edit => edit.itemIndex), [0]);
  assert.equal(block.lines[0].v, 100);
  assert.equal(block.lines[1].v, 116);
});

test('an overlong unbroken replacement wraps deterministically without adding hard newlines', () => {
  const input = [[{ text: 'abcdefghij', fontKey: 'body' }]];
  const wrapped = wrapStyledText(input, text => text.length * 6, 24);
  assert.deepEqual(wrapped.map(styledLineText), ['abcd', 'efgh', 'ij']);
  assert.equal(input[0][0].text, 'abcdefghij');
});

test('case-insensitive find and replace keeps offsets in the original Unicode text', () => {
  const lines = styled([['İstanbul ', 'body'], ['test and test', 'bold']]);
  assert.deepEqual(findInStyledLines(lines, 'test'), [
    { line: 0, start: 9, end: 13 },
    { line: 0, start: 18, end: 22 },
  ]);
  const all = replaceInStyledLines(lines, 'test', 'X');
  assert.equal(all.replaced, 2);
  assert.deepEqual(all.lines[0], [
    { text: 'İstanbul ', fontKey: 'body' },
    { text: 'X and X', fontKey: 'bold' },
  ]);
  assert.equal(styledLineText(replaceInStyledLines(lines, 'test', 'X', false,
    { line: 0, start: 18, end: 22 }).lines[0]), 'İstanbul test and X');
  // The query itself may expand; a folded match must still cover the original characters.
  assert.deepEqual(findInStyledLines(styled([['i\u0307 İ 😀TEST', 'body']]), 'İ'), [
    { line: 0, start: 0, end: 2 }, { line: 0, start: 3, end: 4 },
  ]);
  assert.equal(styledLineText(replaceInStyledLines(styled([['İ 😀TEST', 'body']]), 'test', 'X').lines[0]), 'İ 😀X');
  assert.equal(styledLineText(replaceInStyledLines(styled([['İA', 'body']]), 'A', 'X').lines[0]), 'İX');
  assert.deepEqual(findInStyledLines(lines, 'test', true), [
    { line: 0, start: 9, end: 13 }, { line: 0, start: 18, end: 22 },
  ]);
});

test('cross-run replacement redraws instead of moving an untouched suffix into a different style', () => {
  for (const [lastFont, lastSize] of [['bold', 12], ['regular', 14]] as const) {
    const block = buildTextBlocks([
      run(0, 'First ', 72, 100, 30, 12, 'regular'),
      run(1, 'BOLDTAIL', 102, 100, 60, lastSize, lastFont),
    ], 0)[0];
    const edited = replaceInStyledLines(blockStyledSegments(block), 'First BOLD', 'New', true);
    assert.deepEqual(edited.lines[0], [
      { text: 'New', fontKey: 'regular', fontSize: 12 },
      { text: 'TAIL', fontKey: lastFont, fontSize: lastSize },
    ]);
    assert.equal(planBlockEdit(block, 'NewTAIL', {
      measure: text => text.length * 5, maxU: 600, canDraw: () => true,
    }).mode, 'reflow', 'merging these runs would change the surviving suffix style');
  }
  const sameStyle = buildTextBlocks([
    run(0, 'First ', 72, 100, 30, 12, 'regular'),
    run(1, 'BOLDTAIL', 102, 100, 60, 12, 'regular'),
  ], 0)[0];
  assert.equal(planBlockEdit(sameStyle, 'NewTAIL').mode, 'direct');
});

test('a plaintext-only browser replacement restores the selected face and untouched suffix', () => {
  const previous = [[
    { text: 'First ', fontKey: 'regular', fontSize: 12 },
    { text: 'BOLDTAIL', fontKey: 'bold', fontSize: 14 },
  ]];
  const fallback = { text: '', fontKey: 'bold', fontSize: 14 };
  const repaired = preserveStyledTextEdit(previous, 'NewTAIL', fallback);
  assert.deepEqual(repaired, [[
    { text: 'New', fontKey: 'regular', fontSize: 12 },
    { text: 'TAIL', fontKey: 'bold', fontSize: 14 },
  ]]);
  assert.deepEqual(preserveStyledTextEdit(repaired, 'NewerTAIL', fallback), [[
    { text: 'Newer', fontKey: 'regular', fontSize: 12 },
    { text: 'TAIL', fontKey: 'bold', fontSize: 14 },
  ]]);
  assert.deepEqual(preserveStyledTextEdit(repaired, 'New\nTAIL', fallback), [
    [{ text: 'New', fontKey: 'regular', fontSize: 12 }],
    [{ text: 'TAIL', fontKey: 'bold', fontSize: 14 }],
  ]);
});

test('a repeated-text selection uses its actual range and rejects a differently styled direct splice', () => {
  const block = buildTextBlocks([
    run(0, 'abc', 72, 100, 18, 12, 'regular'),
    run(1, 'abc', 90, 100, 18, 12, 'bold'),
  ], 0)[0];
  const segments = preserveStyledTextEdit(blockStyledSegments(block), 'abc',
    { text: '', fontKey: 'regular', fontSize: 12 }, { start: 0, end: 4 });
  assert.deepEqual(segments, [[
    { text: 'a', fontKey: 'regular', fontSize: 12 },
    { text: 'bc', fontKey: 'bold', fontSize: 12 },
  ]]);
  assert.equal(planBlockEdit(block, 'abc', { segments }).mode, 'reflow');
  // Deleting the final bold occurrence really does leave the first regular occurrence intact.
  const deleteLast = preserveStyledTextEdit(blockStyledSegments(block), 'abc',
    { text: '', fontKey: 'regular', fontSize: 12 }, { start: 3, end: 6 });
  assert.deepEqual(deleteLast, [[{ text: 'abc', fontKey: 'regular', fontSize: 12 }]]);
  assert.equal(planBlockEdit(block, 'abc', { segments: deleteLast }).mode, 'direct');
  // If a browser omits a usable range, mismatched offsets must not change the result's text.
  assert.equal(preserveStyledTextEdit(blockStyledSegments(block), 'Newabc',
    { text: '', fontKey: 'regular', fontSize: 12 }, { start: 5, end: 6 })[0].map(run => run.text).join(''), 'Newabc');
});
