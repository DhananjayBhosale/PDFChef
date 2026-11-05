import assert from 'node:assert/strict';
import test from 'node:test';
import { glyphInkColors, sampleGlyphInks, type GlyphInk, type Rgb } from '../../services/pdfGlyphInks.ts';

// Found on a phone: on a yellow-highlighted line, a character whose sampling window missed its
// strokes was read as yellow ink, and the preview then drew it yellow on yellow, invisibly.
test('a character on a highlight that shows only the highlight has no ink of its own', () => {
  const width = 24;
  const height = 14;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x: number, y: number, [r, g, b]: number[]) => data.set([r, g, b, 255], (y * width + x) * 4);
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < 20; x += 1) paint(x, y, [255, 255, 0]);
  for (let y = 0; y < 12; y += 1) {
    paint(4, y, [0, 0, 0]); // A's stroke, inside its window
    paint(5, y, [0, 0, 0]);
    paint(10, y, [0, 0, 0]); // B's strokes, both outside the middle of its slot
    paint(19, y, [0, 0, 0]);
  }
  const block = {
    left: 0, top: 0, ascent: 10,
    lines: [{ v: 0, u0: 0, u1: 20, fontSize: 10, text: 'AB',
      runs: [{ text: 'AB', fontKey: 'f', fontSize: 10, u0: 0, u1: 20, itemIndex: 0, charStart: 0, charEnd: 2 }] }],
  };
  const [[a, b]] = sampleGlyphInks(data, width, height, block as never, 1, [255, 255, 255], () => 1);
  assert.ok(a && a.color.every((channel) => channel < 40), `A reads as black: ${JSON.stringify(a)}`);
  assert.equal(b, null, `B must not take the highlight as its ink: ${JSON.stringify(b)}`);
});

// Found on a phone: bold digits on a highlight fill most of their own sampling window, so their
// ink was taken for the background and the highlight around it for the ink.
test('a bold character that fills its window on a highlight still reads as its own ink', () => {
  const width = 24;
  const height = 14;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x: number, y: number, [r, g, b]: number[]) => data.set([r, g, b, 255], (y * width + x) * 4);
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < 20; x += 1) paint(x, y, [239, 239, 0]);
  for (let y = 3; y < 10; y += 1) for (let x = 2; x < 8; x += 1) paint(x, y, [0, 0, 0]);
  const block = {
    left: 0, top: 0, ascent: 10,
    lines: [{ v: 0, u0: 0, u1: 10, fontSize: 10, text: '0',
      runs: [{ text: '0', fontKey: 'f', fontSize: 10, u0: 0, u1: 10, itemIndex: 0, charStart: 0, charEnd: 1 }] }],
  };
  const [[zero]] = sampleGlyphInks(data, width, height, block as never, 1, [255, 255, 255], () => 1);
  assert.ok(zero && zero.color.every((channel) => channel < 40), `0 reads as black: ${JSON.stringify(zero)}`);
});

// Found on a phone: on a highlighted line the window of an "n" caught only the soft edge of its
// strokes, (199,199,0) against the highlight's (239,239,0). Measured against white paper that
// looked like a strong yellow ink, and the preview drew the letter yellow on yellow.
test('black text on a highlight, soft edges and all, stays one colour with the rest', () => {
  const highlight: Rgb = [239, 239, 0];
  const onHighlight = (color: Rgb): GlyphInk => ({
    color,
    strength: color.reduce((total, value, index) => total + Math.abs(value - highlight[index]), 0),
    background: highlight,
  });
  const black: GlyphInk = { color: [0, 0, 0], strength: 765, background: [255, 255, 255] };
  assert.deepEqual(glyphInkColors([[black, black, onHighlight([0, 0, 0]), onHighlight([199, 199, 0]), onHighlight([91, 91, 0]), black]],
    [255, 255, 255]), { lines: null, dominant: '#000000' });
});
