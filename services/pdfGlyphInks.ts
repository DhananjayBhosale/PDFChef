/**
 * Tell apart the colours a paragraph is drawn in, one character at a time.
 *
 * PDF.js merges neighbouring runs that share a font into one text item even when their colours
 * differ, so "Please sign by Friday" with a red "Friday" reaches the editor as a single run. The
 * rendered page still shows the difference, so each character's colour is read from its pixels.
 *
 * Anti-aliasing blends a glyph's ink with the paper behind it. Every such pixel lies on the line
 * from the paper to the ink, so two characters are the same colour when one lies on the other's
 * line, however light its edges are. A different colour leaves that line.
 */

import type { PdfTextBlock } from './pdfTextBlocks';

export type Rgb = [number, number, number];

export interface GlyphInk {
  /** Mean of the character's strongest pixels: its glyph body rather than its edges. */
  color: Rgb;
  /** How far that colour is from what is behind the character, as a sum of channel differences. */
  strength: number;
  /** What is right behind the character, such as a highlight; the paragraph's paper if unset. */
  background?: Rgb;
}

/** Below this a character has too little ink to say what colour it is, like a space. */
const WEAK_INK = 90;
/** Furthest a character may sit from a colour's paper-to-ink line and still be that colour. */
const SAME_INK = 36;

const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;

/** Distance from `color` to the line running from the paper to `ink`. */
export const inkResidual = (color: Rgb, ink: Rgb, paper: Rgb) => {
  const direction = ink.map((value, index) => value - paper[index]);
  const offset = color.map((value, index) => value - paper[index]);
  const length = direction.reduce((total, value) => total + value * value, 0);
  const along = length > 0
    ? Math.max(0, Math.min(1.2, offset.reduce((total, value, index) => total + value * direction[index], 0) / length))
    : 0;
  return Math.hypot(...offset.map((value, index) => value - along * direction[index]));
};

/**
 * Find the paragraph's main colour, and give every character of every line a colour when it has
 * more than one. Null when no character has enough ink to tell.
 *
 * Strong characters settle the palette first, so a pale comma cannot found a colour of its own.
 * Each colour is the body of its strongest character. A character without ink, like a space,
 * takes the colour of the ink around it; between two different colours it goes with the
 * paragraph's main one, which is where documents put the spaces around a highlighted word.
 */
export const glyphInkColors = (
  lines: Array<Array<GlyphInk | null>>,
  paper: Rgb,
): { lines: string[][] | null; dominant: string } | null => {
  const clusters: Array<{ ink: GlyphInk; members: number }> = [];
  const assignment = lines.map((line) => line.map(() => -1));
  const order = lines.flatMap((line, lineIndex) => line.flatMap((ink, index) => (
    ink && ink.strength >= WEAK_INK ? [{ ink, lineIndex, index }] : []
  ))).sort((first, second) => second.ink.strength - first.ink.strength);

  order.forEach(({ ink, lineIndex, index }) => {
    let best = -1;
    let bestResidual = SAME_INK;
    clusters.forEach((cluster, clusterIndex) => {
      // Against the character's own background: black on a highlight blends towards the
      // highlight, not towards the paper.
      const residual = inkResidual(ink.color, cluster.ink.color, ink.background ?? paper);
      if (residual < bestResidual) {
        best = clusterIndex;
        bestResidual = residual;
      }
    });
    if (best < 0) {
      clusters.push({ ink, members: 0 });
      best = clusters.length - 1;
    }
    clusters[best].members += 1;
    assignment[lineIndex][index] = best;
  });

  if (clusters.length === 0) return null;
  // The body of the strongest character: a mean over the whole paragraph would take in the soft
  // edges, and on a highlight their blend with it, and read black as a lighter or tinted colour.
  if (clusters.length === 1) return { lines: null, dominant: toHex(clusters[0].ink.color) };
  const colors = clusters.map((cluster) => toHex(cluster.ink.color));
  const dominantIndex = clusters.reduce((winner, cluster, index) => (
    cluster.members > clusters[winner].members ? index : winner
  ), 0);

  return {
    dominant: colors[dominantIndex],
    lines: assignment.map((line) => line.map((cluster, index) => {
      if (cluster >= 0) return colors[cluster];
      let before = -1;
      for (let candidate = index - 1; candidate >= 0 && before < 0; candidate -= 1) before = line[candidate];
      const after = line.find((candidate, candidateIndex) => candidateIndex > index && candidate >= 0) ?? -1;
      if (before >= 0 && (after < 0 || after === before)) return colors[before];
      return colors[before < 0 && after >= 0 ? after : dominantIndex];
    })),
  };
};

/**
 * Read each character's own ink from an upright paragraph's pixels.
 *
 * The run's advance is shared out by the characters' relative widths, and only the middle of
 * each character's slot is read, so a neighbour's anti-aliased edge does not tint it.
 */
export const sampleGlyphInks = (
  data: Uint8ClampedArray,
  pageWidth: number,
  pageHeight: number,
  block: Pick<PdfTextBlock, 'lines' | 'top' | 'ascent' | 'left'>,
  canvasScale: number,
  paper: Rgb,
  /** A character's relative advance, used to share out a run's width. */
  glyphWidth: (character: string) => number,
): Array<Array<GlyphInk | null>> => {
  const u0 = Math.min(...block.lines.map((line) => line.u0));
  return block.lines.map((line) => {
    const baseline = block.top + block.ascent + line.v - block.lines[0].v;
    return line.runs.flatMap((run) => {
      const characters = [...run.text];
      const widths = characters.map(glyphWidth);
      const total = widths.reduce((sum, width) => sum + width, 0);
      const advance = run.u1 - run.u0;
      let x = block.left + run.u0 - u0;
      return characters.flatMap((character, index) => {
        const width = total > 0 ? advance * widths[index] / total : advance / characters.length;
        const start = x;
        x += width;
        let ink: GlyphInk | null = null;
        if (character.trim()) {
          const left = Math.max(0, Math.floor((start + width * 0.2) * canvasScale));
          const right = Math.min(pageWidth, Math.max(left + 1, Math.ceil((start + width * 0.8) * canvasScale)));
          const top = Math.max(0, Math.floor((baseline - run.fontSize * 0.72) * canvasScale));
          const bottom = Math.min(pageHeight, Math.ceil((baseline - run.fontSize * 0.02) * canvasScale));
          // Measured against what is right behind the character, not the paragraph's paper: on a
          // highlighted word a slot that misses the strokes otherwise reads the highlight as ink,
          // and the character is then drawn in the highlight's own colour, invisibly. The
          // background is the commonest colour over the whole line height and half a neighbour
          // either side, so a bold glyph that fills its own window is not taken for it.
          const backgrounds = new Map<number, [number, number, number, number]>();
          const aroundLeft = Math.max(0, Math.floor((start - width * 0.5) * canvasScale));
          const aroundRight = Math.min(pageWidth, Math.ceil((start + width * 1.5) * canvasScale));
          const aroundTop = Math.max(0, Math.floor((baseline - run.fontSize * 0.95) * canvasScale));
          const aroundBottom = Math.min(pageHeight, Math.ceil((baseline + run.fontSize * 0.2) * canvasScale));
          // Every second pixel each way is enough to find the commonest colour.
          for (let py = aroundTop; py < aroundBottom; py += 2) {
            for (let px = aroundLeft; px < aroundRight; px += 2) {
              const offset = (py * pageWidth + px) * 4;
              const key = ((data[offset] >> 4) << 8) | ((data[offset + 1] >> 4) << 4) | (data[offset + 2] >> 4);
              const entry = backgrounds.get(key);
              if (entry) {
                entry[0] += 1;
                entry[1] += data[offset];
                entry[2] += data[offset + 1];
                entry[3] += data[offset + 2];
              } else {
                backgrounds.set(key, [1, data[offset], data[offset + 1], data[offset + 2]]);
              }
            }
          }
          let commonest: [number, number, number, number] | null = null;
          for (const entry of backgrounds.values()) if (!commonest || entry[0] > commonest[0]) commonest = entry;
          const local: Rgb = commonest
            ? [commonest[1] / commonest[0], commonest[2] / commonest[0], commonest[3] / commonest[0]]
            : paper;
          const fromLocal = (offset: number) => Math.abs(data[offset] - local[0])
            + Math.abs(data[offset + 1] - local[1]) + Math.abs(data[offset + 2] - local[2]);
          let strongest = 0;
          for (let py = top; py < bottom; py += 1) {
            for (let px = left; px < right; px += 1) {
              strongest = Math.max(strongest, fromLocal((py * pageWidth + px) * 4));
            }
          }
          if (strongest >= 60) {
            const sum = [0, 0, 0];
            let count = 0;
            for (let py = top; py < bottom; py += 1) {
              for (let px = left; px < right; px += 1) {
                const offset = (py * pageWidth + px) * 4;
                const distance = fromLocal(offset);
                // The glyph's body only: its anti-aliased edge is lighter than the ink it stands for.
                if (distance < strongest * 0.85) continue;
                sum[0] += data[offset];
                sum[1] += data[offset + 1];
                sum[2] += data[offset + 2];
                count += 1;
              }
            }
            const color = sum.map((value) => value / count) as Rgb;
            ink = {
              color,
              strength: Math.abs(color[0] - local[0]) + Math.abs(color[1] - local[1]) + Math.abs(color[2] - local[2]),
              background: local,
            };
          }
        }
        // One entry per UTF-16 unit, so the colours line up with the text's own indices.
        return Array<GlyphInk | null>(character.length).fill(ink);
      });
    });
  });
};
