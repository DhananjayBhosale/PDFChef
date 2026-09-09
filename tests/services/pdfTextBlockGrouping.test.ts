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
