/**
 * Keep a highlight under a paragraph that grows.
 *
 * Documents draw a highlight as a filled rectangle behind the words: part of the page, not of the
 * text. Redrawing a longer paragraph removes the words and leaves that rectangle where it was, so
 * the added words landed on bare paper. The highlight is read off the rendered page instead, and
 * the redraw fills the new text's extent with it, but only where the page showed bare paper, so
 * nothing else on the page is ever painted over.
 */

import type { GlyphInk, Rgb } from './pdfGlyphInks';
import type { PdfTextBlock } from './pdfTextBlocks';

/** A rectangle relative to the paragraph's box (its left edge and top), in page units. */
export interface HighlightBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TextHighlight {
  color: string;
  /** How far the highlight reaches above and below each line's baseline. */
  above: number;
  below: number;
  /** How far it reaches before a line's first character and after its last. */
  padLeft: number;
  padRight: number;
  /** The highlight as the page draws it, one box per line. */
  bands: HighlightBox[];
  /** Bare paper beside and below it: the only place the highlight of a longer paragraph may grow. */
  room: HighlightBox[];
  /** One pixel of the rendered page, in page units: how far an edge read off it can be off. */
  pixel: number;
}

/** Sum of channel differences within which two pixels are the same colour. */
const SAME = 30;
/** A row or column of a line's band is highlight when at least this share of it is; ink is the rest. */
const COVERED = 0.25;

const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
const difference = (first: Rgb, second: Rgb) =>
  Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]) + Math.abs(first[2] - second[2]);

/**
 * Read the highlight an upright paragraph sits on, or null when it does not sit on one.
 *
 * It sits on one when every character with ink has the same colour behind it, and that colour
 * stops close around each line. A colour that carries on, such as a tinted page or a table cell,
 * is not a highlight: text that grows over it is already on it.
 */
export const measureTextHighlight = (
  data: Uint8ClampedArray,
  pageWidth: number,
  pageHeight: number,
  block: Pick<PdfTextBlock, 'lines' | 'top' | 'ascent' | 'left' | 'width' | 'measure'>,
  canvasScale: number,
  inks: Array<Array<GlyphInk | null>>,
): TextHighlight | null => {
  const backgrounds = inks.flat().flatMap((ink) => (ink?.background ? [ink.background] : []));
  if (backgrounds.length === 0) return null;
  const color = [0, 1, 2].map((channel) => (
    backgrounds.reduce((total, background) => total + background[channel], 0) / backgrounds.length
  )) as Rgb;
  if (backgrounds.some((background) => difference(background, color) > SAME)) return null;

  const near = (offset: number, [r, g, b]: Rgb) => Math.abs(data[offset] - r)
    + Math.abs(data[offset + 1] - g) + Math.abs(data[offset + 2] - b) <= SAME;
  /** Share of the canvas rectangle in the highlight's colour; nothing off the canvas is. */
  const covered = (x0: number, x1: number, y0: number, y1: number) => {
    let inside = 0;
    let total = 0;
    for (let y = Math.max(0, y0); y < Math.min(pageHeight, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(pageWidth, x1); x += 1) {
        total += 1;
        if (near((y * pageWidth + x) * 4, color)) inside += 1;
      }
    }
    return total > 0 ? inside / total : 0;
  };
  const px = (value: number) => Math.round(value * canvasScale);

  const u0 = Math.min(...block.lines.map((line) => line.u0));
  const rows = block.lines.map((line) => ({
    baseline: block.top + block.ascent + line.v - block.lines[0].v,
    start: block.left + line.u0 - u0,
    end: block.left + line.u1 - u0,
    em: line.fontSize,
  }));
  const first = rows[0];
  const last = rows[rows.length - 1];

  // Above the first line and below the last, where no other line of the paragraph is in the way.
  // These are whole canvas pixels; the soft edge refines them once the paper's colour is known.
  let top = px(first.baseline);
  const topLimit = px(first.baseline - first.em * 2);
  // Text on plain paper, the usual case, ends here: the colour behind it carries on above.
  if (covered(px(first.start), px(first.end), topLimit, topLimit + 1) >= COVERED) return null;
  while (top > topLimit && covered(px(first.start), px(first.end), top - 1, top) >= COVERED) top -= 1;
  let bottom = px(last.baseline);
  const bottomLimit = px(last.baseline + last.em * 1.2);
  while (bottom < bottomLimit && covered(px(last.start), px(last.end), bottom, bottom + 1) >= COVERED) bottom += 1;
  if (top <= Math.max(0, topLimit) || bottom >= Math.min(pageHeight, bottomLimit)) return null;
  // A highlight covers the letters themselves, not only a strip under them.
  if (first.baseline - top / canvasScale < first.em * 0.5) return null;

  const edges = rows.map((row) => {
    const bandTop = px(row.baseline) - (px(first.baseline) - top);
    const bandBottom = px(row.baseline) + (bottom - px(last.baseline));
    let right = px(row.end);
    const rightLimit = px(row.end + row.em);
    while (right < rightLimit && covered(right, right + 1, bandTop, bandBottom) >= COVERED) right += 1;
    let left = px(row.start);
    const leftLimit = px(row.start - row.em);
    while (left > leftLimit && covered(left - 1, left, bandTop, bandBottom) >= COVERED) left -= 1;
    return right >= Math.min(pageWidth, rightLimit) || left <= Math.max(0, leftLimit)
      ? null : { left, right, top: bandTop, bottom: bandBottom };
  });
  if (edges.some((edge) => !edge)) return null;
  const lineEdges = edges as Array<{ left: number; right: number; top: number; bottom: number }>;

  // The paper is what the last line's highlight gives way to.
  const lastEdge = lineEdges[lineEdges.length - 1];
  const paperCounts = new Map<number, [number, number, number, number]>();
  for (let y = lastEdge.top; y < lastEdge.bottom; y += 1) {
    for (let x = lastEdge.right + 1; x < Math.min(pageWidth, lastEdge.right + 1 + px(last.em * 0.5)); x += 1) {
      const offset = (y * pageWidth + x) * 4;
      const [r, g, b] = [data[offset], data[offset + 1], data[offset + 2]];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const entry = paperCounts.get(key) ?? [0, 0, 0, 0];
      paperCounts.set(key, [entry[0] + 1, entry[1] + r, entry[2] + g, entry[3] + b]);
    }
  }
  let commonest: [number, number, number, number] | null = null;
  for (const entry of paperCounts.values()) if (!commonest || entry[0] > commonest[0]) commonest = entry;
  if (!commonest) return null;
  const paper: Rgb = [commonest[1] / commonest[0], commonest[2] / commonest[0], commonest[3] / commonest[0]];
  if (difference(paper, color) <= SAME) return null;

  // Where a pixel lies between the paper and the highlight, and how far off that line it is.
  const direction = color.map((value, index) => value - paper[index]);
  const length = direction.reduce((total, value) => total + value * value, 0);
  const blend = (x: number, y: number) => {
    const offset = (y * pageWidth + x) * 4;
    const dr = data[offset] - paper[0];
    const dg = data[offset + 1] - paper[1];
    const db = data[offset + 2] - paper[2];
    const along = Math.max(0, Math.min(1, (dr * direction[0] + dg * direction[1] + db * direction[2]) / length));
    return { along, off: Math.hypot(dr - along * direction[0], dg - along * direction[1], db - along * direction[2]) };
  };
  /** How much of a pixel row or column on the highlight's soft edge the highlight covers. */
  const share = (x0: number, x1: number, y0: number, y1: number) => {
    let total = 0;
    let count = 0;
    for (let y = Math.max(0, y0); y < Math.min(pageHeight, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(pageWidth, x1); x += 1) {
        total += blend(x, y).along;
        count += 1;
      }
    }
    return count > 0 ? total / count : 0;
  };
  /** Bare paper, or the soft edge where the highlight meets it, and nothing of the page's own. */
  const bare = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = Math.max(0, y0); y < Math.min(pageHeight, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(pageWidth, x1); x += 1) {
        if (blend(x, y).off > 12) return false;
      }
    }
    return true;
  };

  const above = first.baseline - (top - share(px(first.start), px(first.end), top - 1, top)) / canvasScale;
  const below = (bottom + share(px(last.start), px(last.end), bottom, bottom + 1)) / canvasScale - last.baseline;
  const bands = lineEdges.map((edge, index): HighlightBox => ({
    left: (edge.left - share(edge.left - 1, edge.left, edge.top, edge.bottom)) / canvasScale - block.left,
    right: (edge.right + share(edge.right, edge.right + 1, edge.top, edge.bottom)) / canvasScale - block.left,
    top: rows[index].baseline - above - block.top,
    bottom: rows[index].baseline + below - block.top,
  }));

  const room: HighlightBox[] = lineEdges.map((edge, index) => {
    const rowTop = Math.floor((rows[index].baseline - above) * canvasScale);
    const rowBottom = Math.ceil((rows[index].baseline + below) * canvasScale);
    let x = edge.right;
    while (x < pageWidth && bare(x, x + 1, rowTop, rowBottom)) x += 1;
    return {
      left: edge.right / canvasScale - block.left,
      right: x / canvasScale - block.left,
      top: rowTop / canvasScale - block.top,
      bottom: rowBottom / canvasScale - block.top,
    };
  });
  const spanLeft = Math.max(0, Math.min(...lineEdges.map((edge) => edge.left)));
  const spanRight = Math.min(pageWidth, Math.max(
    ...lineEdges.map((edge) => edge.right),
    px(block.left + Math.max(block.width, block.measure)) + (lastEdge.right - px(last.end)),
  ));
  let y = bottom;
  const belowLimit = Math.min(pageHeight, bottom + px(last.em * 10));
  while (y < belowLimit && bare(spanLeft, spanRight, y, y + 1)) y += 1;
  room.push({
    left: spanLeft / canvasScale - block.left,
    right: spanRight / canvasScale - block.left,
    top: bottom / canvasScale - block.top,
    bottom: y / canvasScale - block.top,
  });

  const lastBand = bands[bands.length - 1];
  return {
    color: toHex(color),
    above,
    below,
    padLeft: Math.max(0, last.start - block.left - lastBand.left),
    padRight: Math.max(0, lastBand.right - (last.end - block.left)),
    bands,
    room: room.filter((box) => box.right > box.left && box.bottom > box.top),
    pixel: 1 / canvasScale,
  };
};

const subtract = (box: HighlightBox, cut: HighlightBox): HighlightBox[] => {
  if (cut.left >= box.right || cut.right <= box.left || cut.top >= box.bottom || cut.bottom <= box.top) return [box];
  const parts: HighlightBox[] = [];
  if (cut.top > box.top) parts.push({ ...box, bottom: cut.top });
  if (cut.bottom < box.bottom) parts.push({ ...box, top: cut.bottom });
  const top = Math.max(box.top, cut.top);
  const bottom = Math.min(box.bottom, cut.bottom);
  if (cut.left > box.left) parts.push({ left: box.left, right: cut.left, top, bottom });
  if (cut.right < box.right) parts.push({ left: cut.right, right: box.right, top, bottom });
  return parts;
};

/** Slivers thinner than this come from rounding, not from text that grew. */
const SLIVER = 1;
/**
 * How much wider than measured a piece of text may be drawn. A standard font that is not embedded
 * is drawn with the viewer's own copy: Apple's and poppler's Helvetica run up to about 0.4% wider
 * than its published widths, which put a longer line's full stop on bare paper.
 */
const WIDER = 0.005;

const isSliver = (box: HighlightBox) => box.right - box.left < SLIVER || box.bottom - box.top < SLIVER;

/**
 * The highlight a redrawn paragraph needs on top of what the page already draws: each new line's
 * extent, less the old highlight, kept to the bare paper beside and below it. Empty when the text
 * still fits the old highlight.
 */
export const highlightPatches = (
  highlight: TextHighlight,
  pieces: Array<{ text: string; x: number; y: number; width: number; lineIndex: number }>,
): HighlightBox[] => {
  const lines = new Map<number, HighlightBox & { wider: number }>();
  pieces.forEach((piece) => {
    if (!piece.text.trim()) return;
    const left = piece.x - highlight.padLeft;
    const right = piece.x + piece.width + highlight.padRight;
    const wider = piece.width * WIDER;
    const line = lines.get(piece.lineIndex);
    lines.set(piece.lineIndex, line
      ? { ...line, left: Math.min(line.left, left), ...(right > line.right ? { right, wider } : {}) }
      : { left, right, top: piece.y - highlight.above, bottom: piece.y + highlight.below, wider });
  });
  const patches = [...lines.values()]
    .flatMap(({ wider, ...line }) => highlight.bands
      .reduce<HighlightBox[]>((parts, band) => parts.flatMap((part) => subtract(part, band)), [line])
      // Only where the text outgrew the old highlight: a line that still fits is left as it was.
      .filter((part) => !isSliver(part))
      .map((part) => (part.right === line.right ? { ...part, right: part.right + wider } : part)))
    .flatMap((part) => highlight.room.map((room) => ({
      left: Math.max(part.left, room.left),
      right: Math.min(part.right, room.right),
      top: Math.max(part.top, room.top),
      bottom: Math.min(part.bottom, room.bottom),
    })))
    .filter((box) => !isSliver(box));

  // Each patch reaches back into the old highlight it continues. Both edges are read off a rendered
  // page to within a pixel, and a hair of paper left between them shows as a white seam. Inside the
  // old highlight are only this paragraph's own words, which are drawn again on top.
  const reach = Math.max(0.5, 1.5 * highlight.pixel);
  const meets = (edge: number, other: number) => Math.abs(edge - other) <= reach;
  const joins = patches.flatMap((patch) => highlight.bands.flatMap((band) => {
    const top = Math.max(patch.top, band.top);
    const bottom = Math.min(patch.bottom, band.bottom);
    const left = Math.max(patch.left, band.left);
    const right = Math.min(patch.right, band.right);
    const sideBySide = bottom - top >= SLIVER;
    const stacked = right - left >= SLIVER;
    return [
      sideBySide && meets(patch.left, band.right) && { left: band.right - reach, right: patch.left, top, bottom },
      sideBySide && meets(patch.right, band.left) && { left: patch.right, right: band.left + reach, top, bottom },
      stacked && meets(patch.top, band.bottom) && { left, right, top: band.bottom - reach, bottom: patch.top },
      stacked && meets(patch.bottom, band.top) && { left, right, top: patch.bottom, bottom: band.top + reach },
    ].filter((join): join is HighlightBox => Boolean(join));
  }));
  return [...patches, ...joins];
};
