import assert from 'node:assert/strict';
import test from 'node:test';
import type { GlyphInk, Rgb } from '../../services/pdfGlyphInks.ts';
import { highlightPatches, measureTextHighlight, type HighlightBox } from '../../services/pdfTextHighlight.ts';

const YELLOW: Rgb = [255, 255, 0];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const SCALE = 2;

/**
 * A 200 x 100 page rendered at twice its size. A two-line paragraph sits on a Word-style highlight,
 * one band per line from 9 above the baseline to 3 below, as wide as the text. A margin note sits
 * to the right of the second line and the next paragraph starts at y 44.
 */
const renderPage = ({ highlight = true, tint, soft = false }: { highlight?: boolean; tint?: Rgb; soft?: boolean } = {}) => {
  const width = 200 * SCALE;
  const height = 100 * SCALE;
  const data = new Uint8ClampedArray(width * height * 4);
  const fill = (x0: number, y0: number, x1: number, y1: number, [r, g, b]: Rgb) => {
    for (let y = y0 * SCALE; y < y1 * SCALE; y += 1) {
      for (let x = x0 * SCALE; x < x1 * SCALE; x += 1) data.set([r, g, b, 255], (y * width + x) * 4);
    }
  };
  fill(0, 0, 200, 100, WHITE);
  if (tint) fill(0, 0, 200, 40, tint);
  const lines = [{ baseline: 20, end: 110 }, { baseline: 32, end: 60 }];
  lines.forEach(({ baseline, end }) => {
    if (highlight) fill(10, baseline - 9, end, baseline + 3, YELLOW);
    for (let x = 11; x < end; x += 5) fill(x, baseline - 7, x + 1, baseline, BLACK);
  });
  // Half a canvas pixel more of highlight under the last line, drawn as a half-strength row.
  if (soft) for (let x = 10 * SCALE; x < 60 * SCALE; x += 1) data.set([255, 255, 128, 255], (35 * SCALE * width + x) * 4);
  fill(150, 24, 160, 34, BLACK);
  fill(10, 44, 150, 50, BLACK);
  return { data, width, height };
};

const block = {
  left: 10, top: 12, ascent: 8, width: 100, measure: 100,
  lines: [
    { v: 20, u0: 10, u1: 110, fontSize: 10, text: '', runs: [] },
    { v: 32, u0: 10, u1: 60, fontSize: 10, text: '', runs: [] },
  ],
};
const inksOn = (background: Rgb): Array<Array<GlyphInk | null>> => {
  const ink: GlyphInk = { color: BLACK, strength: 510, background };
  return [[ink, null, ink], [ink, ink]];
};
const measure = (page: ReturnType<typeof renderPage>, background: Rgb = YELLOW) =>
  measureTextHighlight(page.data, page.width, page.height, block as never, SCALE, inksOn(background));

test('a highlight is read with the bare paper around it, and stops short of the page\'s other content', () => {
  const highlight = measure(renderPage());
  assert.ok(highlight);
  assert.equal(highlight.color, '#ffff00');
  assert.deepEqual([highlight.above, highlight.below, highlight.padLeft, highlight.padRight], [9, 3, 0, 0]);
  assert.deepEqual(highlight.bands, [
    { left: 0, right: 100, top: -1, bottom: 11 },
    { left: 0, right: 50, top: 11, bottom: 23 },
  ]);
  assert.deepEqual(highlight.room, [
    { left: 100, right: 190, top: -1, bottom: 11 },
    // Up to the margin note.
    { left: 50, right: 140, top: 11, bottom: 23 },
    // Down to the next paragraph.
    { left: 0, right: 100, top: 23, bottom: 32 },
  ]);
});

test('a highlight\'s soft edge is measured to a fraction of a pixel', () => {
  const highlight = measure(renderPage({ soft: true }));
  assert.ok(highlight && Math.abs(highlight.below - 3.25) < 0.01, `below: ${highlight?.below}`);
  // The soft edge is the highlight's own, not something on the page to keep clear of.
  assert.deepEqual(highlight.room.at(-1), { left: 0, right: 100, top: 23, bottom: 32 });
});

test('text on plain paper, on a tint that carries on, or only partly highlighted has no highlight to grow', () => {
  assert.equal(measure(renderPage({ highlight: false }), WHITE), null);
  assert.equal(measure(renderPage({ highlight: false, tint: [230, 236, 245] }), [230, 236, 245]), null);
  const partly = inksOn(YELLOW);
  partly[1][1] = { color: BLACK, strength: 765, background: WHITE };
  const page = renderPage();
  assert.equal(measureTextHighlight(page.data, page.width, page.height, block as never, SCALE, partly), null);
});

const lines = (secondWidth: number, third?: number) => [
  { text: 'The Recipient shall hold', x: 0, y: 8, width: 100, lineIndex: 0 },
  { text: 'confidence', x: 0, y: 20, width: secondWidth, lineIndex: 1 },
  ...(third ? [{ text: 'Each party agrees.', x: 0, y: 32, width: third, lineIndex: 2 }] : []),
];
const rounded = (boxes: HighlightBox[]) => boxes.map((box) => Object.fromEntries(
  Object.entries(box).map(([key, value]) => [key, Math.round(value * 1000) / 1000]),
));
const covers = (boxes: HighlightBox[], x: number, y: number) =>
  boxes.some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);

test('a longer paragraph is highlighted over its new words, never over anything else', () => {
  const highlight = measure(renderPage())!;
  // Text that still fits the old highlight changes nothing, a full first line included.
  assert.deepEqual(highlightPatches(highlight, lines(40)), []);
  // A longer last line: the added words at the old line's height, a little past their measured end,
  // and reaching back into the old highlight on its line and the line above.
  assert.deepEqual(rounded(highlightPatches(highlight, lines(80))), [
    { left: 50, right: 80.4, top: 11, bottom: 23 },
    { left: 50, right: 80.4, top: 10.25, bottom: 11 },
    { left: 49.25, right: 50, top: 11, bottom: 23 },
  ]);
  // Grown past the margin note: the note keeps its place.
  assert.deepEqual(rounded(highlightPatches(highlight, lines(170)))[0], { left: 50, right: 140, top: 11, bottom: 23 });
  // A new line: highlighted down to the next paragraph, not over it.
  assert.deepEqual(rounded(highlightPatches(highlight, lines(40, 60))), [
    { left: 0, right: 60.3, top: 23, bottom: 32 },
    { left: 0, right: 50, top: 22.25, bottom: 23 },
  ]);
});

test('no paper shows where the new highlight meets the old, even when its edge was read a little long', () => {
  // Found on a phone: the old highlight's edge was read 0.22 pt past where the page draws it, and
  // the gap between the two showed as a white line.
  const highlight = measure(renderPage())!;
  const misread = {
    ...highlight,
    bands: highlight.bands.map((band, index) => (index === 1 ? { ...band, right: band.right + 0.22, bottom: band.bottom + 0.22 } : band)),
    room: highlight.room.map((room, index) => (
      index === 1 ? { ...room, left: room.left + 0.22 } : index === 2 ? { ...room, top: room.top + 0.22 } : room)),
  };
  // The page draws the old highlight of the second line over x 0–50 and y 11–23.
  const longer = highlightPatches(misread, lines(80));
  for (let x = 50; x <= 80; x += 0.05) assert.ok(covers(longer, x, 17), `paper at x ${x.toFixed(2)}`);
  const below = highlightPatches(misread, lines(40, 60));
  for (let y = 23; y <= 32; y += 0.05) assert.ok(covers(below, 25, y), `paper at y ${y.toFixed(2)}`);
});

test('a longer line keeps its last letters on the highlight when a viewer draws them a little wider', () => {
  // Apple's Helvetica drew a 488 pt line 1.8 pt longer than its published widths.
  const highlight = measure(renderPage())!;
  const [patch] = highlightPatches(highlight, lines(130));
  assert.ok(patch.right >= 130 * 1.004, `ends at ${patch.right}`);
  // The margin is for text that grew, so a line that fits gets none.
  assert.deepEqual(highlightPatches(highlight, lines(50)), []);
});
