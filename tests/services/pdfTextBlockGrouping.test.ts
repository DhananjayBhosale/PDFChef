import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTextBlocks, type PositionedTextSource } from '../../services/pdfTextBlocks.ts';

const run = (
  itemIndex: number, text: string, x: number, y: number, width: number,
  fontSize = 10, fontKey = 'body',
): PositionedTextSource => ({
  itemIndex, text, x, y, width, fontSize, fontKey,
  angle: 0, blank: false, endsLine: false,
});

test('an indented sequence of narrow rows stays separate from its heading and later prose', () => {
  // Synthetic geometry: drawn markers need not exist in the extractable text layer. These rows
  // share paragraph-like leading and overlapping bounds, but have their own narrow text column.
  const rows = ['Red', 'Tan', 'Ash', 'Fir', 'Ox', 'Elm'];
  const items = [
    run(0, 'Feature summary', 201, 274, 50, 8.8, 'heading'),
    ...rows.map((text, index) => run(index + 1, text, 219.5, 292 + index * 19.75, 16 - index * 0.8, 9.8, 'list')),
    run(7, 'A separate sentence explains the result of this feature.', 201, 415, 196, 9.9),
    run(8, 'It continues on a second line.', 201, 434.75, 140, 9.9),
  ];

  const blocks = buildTextBlocks(items, 1);
  assert.deepEqual(blocks.map(block => block.lines.length), [1, 1, 1, 1, 1, 1, 1, 2]);
  assert.equal(blocks[0].text, 'Feature summary');
  assert.deepEqual(blocks.slice(1, 7).map(block => block.text), rows);
  assert.match(blocks[7].text, /^A separate sentence.*\nIt continues/);
  assert.deepEqual(blocks[7].lines.map(line => [line.u0, line.v]), [[201, 415], [201, 434.75]]);
});

test('ordinary paragraphs retain a short final line and mixed runs', () => {
  const blocks = buildTextBlocks([
    run(0, 'An ordinary paragraph with', 72, 100, 130),
    run(1, 'emphasis', 206, 100, 45, 10, 'bold'),
    run(2, 'continues with another full line of body text', 72, 114, 190),
    run(3, 'ends.', 72, 128, 23),
  ], 0);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 3);
  assert.deepEqual(blocks[0].lines[0].runs.filter(entry => entry.itemIndex >= 0).map(entry => entry.fontKey), ['body', 'bold']);
  assert.deepEqual(blocks[0].lines.map(line => line.v), [100, 114, 128]);
});

test('narrow text with no contrasting surrounding geometry remains one paragraph', () => {
  const blocks = buildTextBlocks([
    run(0, 'We', 72, 100, 15),
    run(1, 'can', 72, 114, 17),
    run(2, 'do', 72, 128, 13),
    run(3, 'it.', 72, 142, 10),
  ], 0);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 4);
});

test('short endings alone do not split an ordinary paragraph', () => {
  const blocks = buildTextBlocks([
    run(0, 'A full line starts a deliberately tapered paragraph', 72, 100, 230),
    run(1, 'and', 72, 114, 17),
    run(2, 'ends', 72, 128, 22),
    run(3, 'here.', 72, 142, 24),
  ], 0);
  assert.equal(blocks.length, 1);
});

test('hanging indents and justified paragraphs retain their original grouping', () => {
  const blocks = buildTextBlocks([
    run(0, 'A hanging paragraph begins', 72, 100, 175),
    run(1, 'and continues at the body margin', 84, 114, 163),
    run(2, 'with its final line.', 84, 128, 90),
    run(3, 'A justified paragraph begins here', 72, 170, 180),
    run(4, 'and continues at the same measure', 72, 184, 180),
    run(5, 'and keeps the original line edges', 72, 198, 180),
  ], 0);

  assert.deepEqual(blocks.map(block => block.lines.length), [3, 3]);
  assert.equal(blocks[0].padLeft, 12);
  assert.equal(blocks[0].textIndent, -12);
  assert.equal(blocks[1].align, 'justify');
});

test('short rows are detected within their own column', () => {
  const items = [run(0, 'A heading', 72, 100, 70, 10, 'heading')];
  for (let index = 0; index < 4; index += 1) {
    items.push(run(1 + index * 2, ['Red', 'Tan', 'Ash', 'Fir'][index], 84, 120 + index * 20, 17, 10, 'list'));
    items.push(run(2 + index * 2, `The other column continues on line ${index + 1}`, 300, 120 + index * 20, 190));
  }
  items.push(run(9, 'A separate explanation follows the list.', 72, 200, 190));
  const blocks = buildTextBlocks(items, 0);

  assert.equal(blocks.filter(block => block.left === 84).length, 4);
  const otherColumn = blocks.find(block => block.left === 300);
  assert.equal(otherColumn?.lines.length, 4);
});

// Found on a phone with a Google Docs export: every bullet item merged into one paragraph that
// contained its "●" bullets, and any edit that moved a line was then refused.
test('a Google Docs bullet list gives each item its own paragraph, without its bullet', () => {
  const items: PositionedTextSource[] = [];
  const item = (index: number, lines: string[], y: number) => {
    items.push(run(items.length, '●', 90, y, 7.2, 12, 'bullet'));
    items.push(run(items.length, ' ', 97.2, y, 0.9, 12, 'body'));
    lines.forEach((text, line) => items.push(run(items.length, text, 108, y + line * 14, 300, 12, 'body')));
  };
  items.push(run(0, 'The list below has three items.', 72, 72, 200, 12, 'body'));
  item(0, ['First item'], 100);
  item(1, ['Second item that wraps onto', 'a second line'], 114);
  item(2, ['Third item'], 142);
  items.push(run(items.length, 'A paragraph after the list.', 72, 170, 180, 12, 'body'));

  const blocks = buildTextBlocks(items, 0);
  assert.deepEqual(blocks.map((block) => block.text), [
    'The list below has three items.',
    'First item',
    'Second item that wraps onto\na second line',
    'Third item',
    'A paragraph after the list.',
  ]);
});

test('a symbol-font bullet and a numbered marker are split off the same way', () => {
  const blocks = buildTextBlocks([
    run(0, '', 90, 100, 5, 11, 'symbol'),
    run(1, 'Private-use bullet item', 108, 100, 140, 11, 'body'),
    run(2, '2.', 90, 114, 9, 11, 'body'),
    run(3, 'Numbered item', 108, 114, 90, 11, 'body'),
  ], 0);
  assert.deepEqual(blocks.map((block) => block.text), ['Private-use bullet item', 'Numbered item']);
});

test('a dash followed by only a word space keeps its place in the text', () => {
  const blocks = buildTextBlocks([
    run(0, 'A sentence that runs on and then', 72, 100, 200, 12, 'body'),
    run(1, '\u2013', 72, 114, 6, 12, 'body'),
    run(2, 'carries on after a dash.', 81, 114, 150, 12, 'body'),
  ], 0);
  assert.ok(blocks.some((block) => block.text.includes('\u2013')), blocks.map((block) => block.text).join(' | '));
});

// Found on a phone: a heading set a little apart took the first line of the paragraph under it,
// and the rest became a paragraph of its own. A highlighted run crossing that false edge then
// could not be removed, so the edited paragraph could not be saved.
test('a heading set apart from its paragraph does not take the paragraph\'s first line', () => {
  const blocks = buildTextBlocks([
    run(0, 'Nothing Headphone (1):', 72, 100, 110, 10, 'bold'),
    run(1, 'The full review and news embargo will be in effect until', 72, 116.25, 300),
    run(2, '18.30 BST / 19.30 CEST / 13.30 EDT / 23.00 IST, or when the', 72, 126.25, 300),
    run(3, '(whichever comes first), or at an alternative date or time', 72, 136.25, 300),
    run(4, 'time.', 72, 146.25, 24),
  ], 0);

  assert.deepEqual(blocks.map(block => block.lines.length), [1, 4]);
  assert.equal(blocks[0].text, 'Nothing Headphone (1):');
  assert.match(blocks[1].text, /^The full review.*\n18\.30 BST/);
});
