import type { PdfSpaceRect } from './pdfNativeTextPlanning';

/**
 * Paragraph reconstruction for the inline PDF text editor.
 *
 * PDF files store text as isolated drawing calls, so a sentence usually arrives as a dozen
 * unrelated runs and a paragraph has no representation at all. Everything here rebuilds that
 * missing structure geometrically so the editor can offer paragraph-level editing instead of
 * the word-at-a-time targets the previous editor exposed.
 *
 * All grouping happens in reading space (u, v): u runs along the baseline, v runs across it.
 * Working in that space keeps rotated and skewed pages on the same code path as upright ones.
 */

/** Same-orientation grouping tolerance, radians. */
const ANGLE_TOLERANCE = 0.02;
/** Same visual line, as a multiple of font size. */
const LINE_V_TOLERANCE = 0.42;
/** Horizontal gap that implies a missing space character. */
const SPACE_GAP = 0.17;
/** Horizontal gap that implies a column or tab break rather than a space. */
const SPLIT_GAP = 1.9;
/** Maximum font-size drift inside one paragraph. */
const PARA_FONT_SIZE_TOLERANCE = 0.12;
/** Line pitch bounds for lines of the same paragraph, as multiples of font size. */
const PARA_LEADING_MIN = 0.55;
const PARA_LEADING_MAX = 2.45;
/** Horizontal alignment tolerance between consecutive paragraph lines. */
const PARA_X_TOLERANCE = 2.2;
/** Allowed drift of one line's pitch from the paragraph's median pitch. */
const LEADING_CONSISTENCY = 0.34;
/** Typical ascent/descent as a fraction of font size, used for the block box only. */
const BLOCK_ASCENT = 0.82;
const BLOCK_DESCENT = 0.26;

/**
 * A gap wide enough to be worth considering a column boundary. Well above a word space, well below
 * the gap that splits a line on its own, so it only matters when the boundary also recurs.
 */
const COLUMN_CANDIDATE_GAP = 0.55;
/** Points, in reading space: how far two rows' column edges may drift and still be the same edge. */
const COLUMN_EDGE_TOLERANCE = 2.5;
/** A boundary has to appear on at least this many rows before it counts as a column. */
const COLUMN_MIN_ROWS = 2;
/** Font-size ratio between neighbours on a line that marks them as different page elements. */
const SIZE_CHANGE_SPLIT = 1.6;

/** A line that is nothing but a list marker: the bullet column of a properly set list. */
const BULLET_ONLY_PATTERN = /^\s*(?:[•▪◦‣·*\u2013\u2014-]|\d{1,3}[.)]|\(?[a-z]{1,2}[.)]|[ivxIVX]{1,4}[.)])\s*$/;
/** How far left of its text a marker may sit and still belong to it, as a multiple of font size. */
const MARKER_REACH = 6;

/** At least one character a reader could recognise; C0 controls and U+FFFD do not count. */
const READABLE_TEXT = /[^\u0000-\u001f\u007f\ufffd]/;

/** Rough advance for a run whose own width the file did not report. */
const estimatedAdvance = (text: string, fontSize: number) => text.length * fontSize * 0.5;

const BULLET_PATTERN = /^\s*(?:\d{1,3}[.)]|\(?[a-z]{1,2}[.)]|[ivxIVX]{1,4}[.)]|[•▪◦‣·*–—-])\s/;

export interface PdfTextRun {
  text: string;
  fontKey: string;
  fontSize: number;
  u0: number;
  u1: number;
  /** Index into the page's `getTextContent().items`, or -1 for a synthesised space. */
  itemIndex: number;
  /** Character range this run occupies inside its source item's `str`. */
  charStart: number;
  charEnd: number;
  /** Unrotated PDF page-space bounds of the complete source item. */
  sourcePdfRect?: PdfSpaceRect;
  /** Complete text of the source item, needed to rewrite it in place on save. */
  sourceText?: string;
}

export interface PdfTextLine {
  v: number;
  u0: number;
  u1: number;
  fontSize: number;
  runs: PdfTextRun[];
  text: string;
  /** True when a bullet or number sits in its own column to the left of this line. */
  startsListItem?: boolean;
}

export type PdfTextAlign = 'left' | 'center' | 'right' | 'justify';

/**
 * Whether a paragraph reads right to left.
 *
 * PDF.js hands back characters in logical order, so an Arabic or Hebrew paragraph looks like any
 * other string — but an overlay laid out left to right would put the caret at the wrong end of it
 * and reverse what the user sees while typing. Counting strong directional characters is enough:
 * a paragraph is right-to-left when more of them are.
 */
const RTL_STRONG = /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0780-\u07bf\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const LTR_STRONG = /[A-Za-z\u00c0-\u024f\u0370-\u058f\u0900-\u109f\u1e00-\u1fff]/;

export const detectTextDirection = (text: string): 'ltr' | 'rtl' => {
  let rtl = 0;
  let ltr = 0;
  for (const character of text) {
    if (RTL_STRONG.test(character)) rtl += 1;
    else if (LTR_STRONG.test(character)) ltr += 1;
  }
  return rtl > ltr ? 'rtl' : 'ltr';
};

export interface PdfTextBlock {
  id: string;
  pageIndex: number;
  angle: number;
  lines: PdfTextLine[];
  /** Lines joined with newlines: exactly what the editable overlay shows. */
  text: string;
  /** Axis-aligned position of the block's first baseline box, in viewport pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  fontKey: string;
  align: PdfTextAlign;
  /** Reading direction, so the overlay puts the caret at the end the reader expects. */
  direction: 'ltr' | 'rtl';
  /** Median baseline-to-baseline distance in pixels. */
  leading: number;
  ascent: number;
  /** Widest line, in pixels: the width the edited text should keep. */
  measure: number;
  /** Extra left inset when the paragraph's later lines are indented past the first. */
  padLeft: number;
  textIndent: number;
}

export interface PositionedTextSource {
  itemIndex: number;
  text: string;
  /** Viewport-space origin of the run's baseline start. */
  x: number;
  y: number;
  /** Rendered advance width in viewport pixels. */
  width: number;
  fontSize: number;
  angle: number;
  fontKey: string;
  blank: boolean;
  /** The PDF ends a line after this run. */
  endsLine: boolean;
  sourcePdfRect?: PdfSpaceRect;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const toReadingSpace = (x: number, y: number, cos: number, sin: number) => ({
  u: x * cos + y * sin,
  v: -x * sin + y * cos,
});

const toPageSpace = (u: number, v: number, cos: number, sin: number) => ({
  x: u * cos - v * sin,
  y: u * sin + v * cos,
});

const stableId = (parts: Array<string | number>) => {
  let hash = 2166136261;
  const value = parts.join(':');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

/**
 * Read PDF.js text items into viewport space. `fontSize` comes from the transform's rise vector
 * rather than `item.height`, because only the transform survives scaling and rotation.
 */
export const positionTextItems = (
  items: any[],
  viewportTransform: number[],
  transform: (a: number[], b: number[]) => number[],
  viewportScale: number,
  toPdfRect?: (itemTransform: number[], width: number, height: number) => PdfSpaceRect | undefined,
): PositionedTextSource[] => {
  const positioned: PositionedTextSource[] = [];

  items.forEach((item, itemIndex) => {
    if (typeof item?.str !== 'string') return;
    const matrix = transform(viewportTransform, item.transform);
    const fontSize = Math.hypot(matrix[2], matrix[3]);
    if (!(fontSize > 0)) return;
    const width = (item.width || 0) * viewportScale;
    const blank = item.str.trim() === '';
    if (blank && width <= 0) return;

    // Some producers put the line break inside the run's own text. It is a line ending, not a
    // character to lay out, so it is taken off here and remembered instead.
    const text = item.str.replace(/[\r\n]+$/, '').replace(/[\r\n]+/g, ' ');

    // Some producers write a text layer that decodes to control characters — a Type 3 font with no
    // usable mapping is the usual cause. Those are not words, and treating them as words fills the
    // page with invisible paragraphs over glyphs nobody can read.
    if (text && !READABLE_TEXT.test(text)) return;

    positioned.push({
      itemIndex,
      text,
      endsLine: Boolean(item.hasEOL) || /[\r\n]$/.test(item.str),
      x: matrix[4],
      y: matrix[5],
      // A reported advance of zero is missing information, not a run of no width. Left as zero it
      // makes every gap look like a column break and shatters the page into one block per glyph.
      width: width > 0 ? width : estimatedAdvance(text, fontSize),
      fontSize,
      angle: Math.atan2(matrix[1], matrix[0]),
      fontKey: item.fontName || '',
      blank,
      sourcePdfRect: toPdfRect?.(item.transform, item.width || 0, item.height || 0),
    });
  });

  return positioned;
};

interface ProjectedItem {
  source: PositionedTextSource;
  u0: number;
  u1: number;
  v: number;
  fontSize: number;
}

/**
 * Cluster runs onto shared baselines, then walk each baseline left to right inserting the space
 * characters that PDF generators routinely omit and splitting where the gap is wide enough to be
 * a column rather than a word break.
 */
export const assembleLines = (
  items: PositionedTextSource[],
  cos: number,
  sin: number,
): PdfTextLine[] => {
  const projected: ProjectedItem[] = items.map((source) => {
    const point = toReadingSpace(source.x, source.y, cos, sin);
    return {
      source,
      u0: point.u,
      u1: point.u + source.width,
      v: point.v,
      fontSize: source.fontSize,
    };
  });

  projected.sort((first, second) => first.v - second.v || first.u0 - second.u0);

  const clusters: Array<{ v: number; fontSize: number; parts: ProjectedItem[] }> = [];
  projected.forEach((item) => {
    const current = clusters[clusters.length - 1];
    // Measured against the smaller of the two: a 24 pt logotype beside 7 pt text would otherwise
    // open a 10 pt window and pull the whole page header onto one line.
    if (current && Math.abs(item.v - current.v) <= LINE_V_TOLERANCE * Math.min(item.fontSize, current.fontSize)) {
      current.parts.push(item);
      if (item.fontSize > current.fontSize) {
        current.fontSize = item.fontSize;
        current.v = item.v;
      }
      return;
    }
    clusters.push({ v: item.v, fontSize: item.fontSize, parts: [item] });
  });

  const lines: PdfTextLine[] = [];

  clusters.forEach((cluster) => {
    cluster.parts.sort((first, second) => first.u0 - second.u0);
    let current: PdfTextLine | null = null;
    let previous: ProjectedItem | null = null;
    // Gaps are measured from the last run that actually drew glyphs. PDF.js reports the space
    // between two columns as a single wide blank item, so comparing against the immediately
    // previous run would see no gap at all and weld the columns into one line.
    let lastVisible: ProjectedItem | null = null;

    const flush = () => {
      lastVisible = null;
      if (!current) return;
      while (current.runs.length && current.runs[current.runs.length - 1].text.trim() === '') {
        current.runs.pop();
      }
      if (current.runs.length === 0) {
        current = null;
        return;
      }
      current.text = current.runs.map((run) => run.text).join('');
      current.u1 = Math.max(...current.runs.map((run) => run.u1));
      if (current.text.trim()) lines.push(current);
      current = null;
    };

    cluster.parts.forEach((part) => {
      const fontSize = part.fontSize || cluster.fontSize;
      const separation = lastVisible ? part.u0 - lastVisible.u1 : 0;
      // Measured against the smaller face, so one display-size word cannot raise the bar for the
      // ordinary text beside it.
      const gapReference = lastVisible ? Math.min(fontSize, lastVisible.fontSize) : fontSize;
      // Text that changes size mid-line, with any real gap, is a different element on the page
      // rather than the rest of the sentence — a logotype beside a title, a heading beside its
      // body. Size alone is not enough: superscripts and small caps sit flush against their text.
      const sizeRatio = lastVisible
        ? Math.max(fontSize, lastVisible.fontSize) / Math.max(1e-6, Math.min(fontSize, lastVisible.fontSize))
        : 1;
      const changesSize = sizeRatio >= SIZE_CHANGE_SPLIT && separation >= 0.25 * gapReference;

      if (!current || (lastVisible && !part.source.blank && (separation > SPLIT_GAP * gapReference || changesSize))) {
        // flush() drops the blank run that spanned the gap, so the new line starts at real text.
        flush();
        current = { v: cluster.v, u0: part.u0, u1: part.u1, fontSize, runs: [], text: '' };
      }

      const line = current!;
      const lastRun = line.runs[line.runs.length - 1];

      if (previous && !previous.source.blank && separation > SPACE_GAP * gapReference) {
        if (lastRun && !/\s$/.test(lastRun.text) && !/^\s/.test(part.source.text)) {
          line.runs.push({
            text: ' ',
            fontKey: part.source.fontKey,
            fontSize,
            u0: previous.u1,
            u1: part.u0,
            itemIndex: -1,
            charStart: 0,
            charEnd: 0,
          });
        }
      }

      const mergeTarget = line.runs[line.runs.length - 1];
      if (
        mergeTarget
        && mergeTarget.itemIndex === part.source.itemIndex
        && mergeTarget.fontKey === part.source.fontKey
      ) {
        mergeTarget.text += part.source.text;
        mergeTarget.u1 = Math.max(mergeTarget.u1, part.u1);
        mergeTarget.charEnd += part.source.text.length;
      } else {
        line.runs.push({
          text: part.source.text,
          fontKey: part.source.fontKey,
          fontSize,
          u0: part.u0,
          u1: part.u1,
          itemIndex: part.source.itemIndex,
          charStart: 0,
          charEnd: part.source.text.length,
          sourcePdfRect: part.source.sourcePdfRect,
          sourceText: part.source.text,
        });
      }

      line.u1 = Math.max(line.u1, part.u1);
      previous = part;
      if (!part.source.blank) lastVisible = part;
      // The PDF said the line ends here, which is better evidence than any gap measurement.
      if (part.source.endsLine) {
        flush();
        previous = null;
      }
    });

    flush();
  });

  return lines;
};

/**
 * Split a page's lines into columns before looking for paragraphs.
 *
 * Lines arrive sorted top to bottom, so in a two-column layout they alternate between the columns
 * and a straight sequential walk sees every line as a new paragraph. Each line is therefore chained
 * to the column it actually continues: the one whose last line it sits under and shares horizontal
 * space with. Comparing against that column's most recent line rather than its whole extent is what
 * stops a full-width heading above the columns from welding them back together.
 */
const COLUMN_OVERLAP_RATIO = 0.5;

const groupLinesIntoColumns = (lines: PdfTextLine[]): PdfTextLine[][] => {
  const columns: Array<{ lines: PdfTextLine[]; last: PdfTextLine }> = [];

  lines.forEach((line) => {
    let best: { column: (typeof columns)[number]; ratio: number; gap: number } | null = null;

    columns.forEach((column) => {
      const overlap = Math.min(line.u1, column.last.u1) - Math.max(line.u0, column.last.u0);
      if (overlap <= 0) return;
      const narrower = Math.min(line.u1 - line.u0, column.last.u1 - column.last.u0);
      const ratio = narrower > 0 ? overlap / narrower : 0;
      if (ratio < COLUMN_OVERLAP_RATIO) return;
      const gap = line.v - column.last.v;
      if (gap < 0) return;
      if (!best || ratio > best.ratio + 1e-9 || (Math.abs(ratio - best.ratio) <= 1e-9 && gap < best.gap)) {
        best = { column, ratio, gap };
      }
    });

    if (best) {
      best.column.lines.push(line);
      best.column.last = line;
      return;
    }
    columns.push({ lines: [line], last: line });
  });

  return columns.map((column) => column.lines);
};

/**
 * Split table rows into cells.
 *
 * Columns in a real table are often set only a fraction of an em apart — closer than a wide space
 * in justified prose — so no gap threshold can tell them apart on one line alone. What does give
 * them away is that the same edge comes back on the next row, and the row after that. Boundaries
 * are therefore collected across the whole orientation and only acted on where they recur, which
 * leaves ordinary paragraphs, with their one-off wide spaces, untouched.
 */
const splitLinesAtColumns = (lines: PdfTextLine[]): PdfTextLine[] => {
  const candidates: Array<{ u: number; line: PdfTextLine }> = [];

  lines.forEach((line) => {
    line.runs.forEach((run, index) => {
      const next = line.runs[index + 1];
      if (!next || run.text.trim() !== '') return;
      const fontSize = Math.max(run.fontSize, next.fontSize) || line.fontSize;
      if (run.u1 - run.u0 < COLUMN_CANDIDATE_GAP * fontSize) return;
      candidates.push({ u: next.u0, line });
    });
  });
  if (candidates.length === 0) return lines;

  // Bucketed rather than chained: a form has edges every few points, and growing a cluster from
  // its neighbour walks the whole row into one boundary anchored at the leftmost of them.
  const buckets = new Map<number, { total: number; count: number; rows: Set<PdfTextLine> }>();
  candidates.forEach((candidate) => {
    const key = Math.round(candidate.u / COLUMN_EDGE_TOLERANCE);
    const bucket = buckets.get(key) ?? { total: 0, count: 0, rows: new Set<PdfTextLine>() };
    bucket.total += candidate.u;
    bucket.count += 1;
    bucket.rows.add(candidate.line);
    buckets.set(key, bucket);
  });

  const boundaries = [...buckets.values()]
    .filter((bucket) => bucket.rows.size >= COLUMN_MIN_ROWS)
    .map((bucket) => bucket.total / bucket.count);
  if (boundaries.length === 0) return lines;

  return lines.flatMap((line) => {
    const parts: PdfTextLine[] = [];
    let current: PdfTextRun[] = [];

    const flush = () => {
      while (current.length && current[current.length - 1].text.trim() === '') current.pop();
      while (current.length && current[0].text.trim() === '') current.shift();
      if (current.length === 0) return;
      parts.push({
        v: line.v,
        u0: current[0].u0,
        u1: Math.max(...current.map((run) => run.u1)),
        fontSize: line.fontSize,
        runs: current,
        text: current.map((run) => run.text).join(''),
      });
      current = [];
    };

    line.runs.forEach((run) => {
      if (current.length > 0 && boundaries.some((edge) => Math.abs(run.u0 - edge) <= COLUMN_EDGE_TOLERANCE)) flush();
      current.push(run);
    });
    flush();

    return parts.length > 0 ? parts : [line];
  });
};

/**
 * Mark the lines that begin a list item.
 *
 * A properly set list puts its bullets in their own column, so the marker is a separate run and the
 * line's own text starts at the words. Six such items share a left edge and a line pitch, which is
 * exactly what a six-line paragraph looks like — the marker beside them is the only thing that says
 * otherwise, so it is what gets used.
 */
const markListItems = (lines: PdfTextLine[]) => {
  const markers = lines.filter((line) => BULLET_ONLY_PATTERN.test(line.text));
  if (markers.length === 0) return lines;

  return lines.map((line) => {
    if (BULLET_ONLY_PATTERN.test(line.text)) return line;
    const marker = markers.find((candidate) => (
      Math.abs(candidate.v - line.v) <= 0.42 * Math.max(candidate.fontSize, line.fontSize)
      && candidate.u1 <= line.u0 + 1
      && line.u0 - candidate.u1 <= MARKER_REACH * line.fontSize
    ));
    return marker ? { ...line, startsListItem: true } : line;
  });
};

const linesShareParagraph = (
  previous: PdfTextLine,
  next: PdfTextLine,
  medianLeading: number,
) => {
  const maxFontSize = Math.max(previous.fontSize, next.fontSize);
  if (maxFontSize <= 0) return false;
  if (Math.abs(previous.fontSize - next.fontSize) / maxFontSize > PARA_FONT_SIZE_TOLERANCE) return false;

  const leading = next.v - previous.v;
  if (leading < PARA_LEADING_MIN * maxFontSize || leading > PARA_LEADING_MAX * maxFontSize) return false;

  // A paragraph keeps a steady line pitch. A sudden change of pitch is a new block, even when the
  // absolute pitch is still inside the permitted range.
  if (medianLeading > 0 && Math.abs(leading - medianLeading) > LEADING_CONSISTENCY * medianLeading) return false;

  if (next.u0 > previous.u1 || next.u1 < previous.u0) return false;
  if (BULLET_PATTERN.test(next.text) || next.startsListItem) return false;

  // A list item that wraps is indented past its own marker. A line that starts back at the marker's
  // own margin is the next thing on the page, not the rest of the bullet.
  if (
    (BULLET_PATTERN.test(previous.text) || previous.startsListItem)
    && next.u0 < previous.u0 + maxFontSize * 0.5
  ) return false;

  const tolerance = PARA_X_TOLERANCE * maxFontSize;
  const leftAligned = Math.abs(next.u0 - previous.u0) <= tolerance;
  const centreAligned = Math.abs((next.u0 + next.u1) / 2 - (previous.u0 + previous.u1) / 2) <= tolerance;
  const rightAligned = Math.abs(next.u1 - previous.u1) <= tolerance;

  return leftAligned || centreAligned || rightAligned;
};

const detectAlignment = (lines: PdfTextLine[]): PdfTextAlign => {
  if (lines.length < 2) return 'left';
  const fontSize = median(lines.map((line) => line.fontSize)) || 1;
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const leftSpread = spread(lines.map((line) => line.u0));
  const rightSpread = spread(lines.map((line) => line.u1));
  const centreSpread = spread(lines.map((line) => (line.u0 + line.u1) / 2));
  const tolerance = fontSize * 0.35;

  // Justified text pins both edges. Every other alignment pins exactly one.
  if (leftSpread <= tolerance && rightSpread <= tolerance && lines.length > 2) return 'justify';
  if (leftSpread <= tolerance && leftSpread <= centreSpread && leftSpread <= rightSpread) return 'left';
  if (rightSpread <= tolerance && rightSpread < leftSpread) return 'right';
  if (centreSpread <= tolerance && centreSpread < leftSpread) return 'center';
  return 'left';
};

const dominantFontKey = (lines: PdfTextLine[]) => {
  const weights = new Map<string, number>();
  lines.forEach((line) => line.runs.forEach((run) => {
    if (run.itemIndex < 0) return;
    weights.set(run.fontKey, (weights.get(run.fontKey) || 0) + run.text.length);
  }));
  let best = '';
  let bestWeight = -1;
  weights.forEach((weight, key) => {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = key;
    }
  });
  return best;
};

const createBlock = (
  lines: PdfTextLine[],
  pageIndex: number,
  angle: number,
  cos: number,
  sin: number,
): PdfTextBlock => {
  const uMin = Math.min(...lines.map((line) => line.u0));
  const uMax = Math.max(...lines.map((line) => line.u1));
  const fontSize = median(lines.map((line) => line.fontSize)) || lines[0].fontSize;
  const ascent = fontSize * BLOCK_ASCENT;
  const leadingValues = lines.slice(1).map((line, index) => line.v - lines[index].v);
  const leading = leadingValues.length ? median(leadingValues) : fontSize * 1.2;
  const vTop = lines[0].v - ascent;
  const vBottom = lines[lines.length - 1].v + lines[lines.length - 1].fontSize * BLOCK_DESCENT;
  const topLeft = toPageSpace(uMin, vTop, cos, sin);
  const firstLineIndent = lines[0].u0 - uMin;
  // Only lines after the first define the paragraph's own left edge, so a hanging or first-line
  // indent survives editing instead of collapsing to the widest line's margin.
  const bodyIndent = lines.length > 1 ? Math.min(...lines.slice(1).map((line) => line.u0)) - uMin : 0;

  return {
    id: `block-${pageIndex}-${stableId([
      Math.round(uMin * 100),
      Math.round(vTop * 100),
      Math.round(uMax * 100),
      lines.length,
      lines[0].text,
    ])}`,
    pageIndex,
    angle,
    lines,
    text: lines.map((line) => line.text).join('\n'),
    left: topLeft.x,
    top: topLeft.y,
    width: Math.max(1, uMax - uMin),
    height: Math.max(1, vBottom - vTop),
    fontSize,
    fontKey: dominantFontKey(lines),
    align: detectAlignment(lines),
    direction: detectTextDirection(lines.map((line) => line.text).join(' ')),
    leading,
    ascent,
    measure: Math.max(1, uMax - uMin),
    padLeft: Math.max(0, bodyIndent),
    // Clamped to the paragraph's own measure. Reading space runs backwards for a rotated block, so
    // clamping against a raw coordinate would floor the indent at the block's width instead.
    textIndent: clamp(firstLineIndent - Math.max(0, bodyIndent), -(uMax - uMin), uMax - uMin),
  };
};

/**
 * Group same-orientation runs into paragraphs. Items are bucketed by baseline angle first so a
 * rotated caption never merges with the body text that happens to sit beside it.
 */
export const buildTextBlocks = (
  items: PositionedTextSource[],
  pageIndex: number,
): PdfTextBlock[] => {
  const usable = items.filter((item) => item.text.trim() !== '' || item.width > 0);
  if (usable.length === 0) return [];

  const orientationGroups: Array<{ angle: number; items: PositionedTextSource[] }> = [];
  usable.forEach((item) => {
    const group = orientationGroups.find(
      (candidate) => Math.abs(candidate.angle - item.angle) <= ANGLE_TOLERANCE,
    );
    if (group) {
      group.items.push(item);
      return;
    }
    orientationGroups.push({ angle: item.angle, items: [item] });
  });

  const blocks: PdfTextBlock[] = [];

  orientationGroups.forEach((group) => {
    const angle = group.items.reduce((total, item) => total + item.angle, 0) / group.items.length;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const lines = markListItems(splitLinesAtColumns(assembleLines(group.items, cos, sin)));
    if (lines.length === 0) return;

    lines.sort((first, second) => first.v - second.v || first.u0 - second.u0);

    groupLinesIntoColumns(lines).forEach((columnLines) => {
      let current: PdfTextLine[] = [];
      let currentLeading = 0;

      const flush = () => {
        if (current.length === 0) return;
        blocks.push(createBlock(current, pageIndex, angle, cos, sin));
        current = [];
        currentLeading = 0;
      };

      columnLines.forEach((line) => {
        if (current.length === 0) {
          current = [line];
          return;
        }
        const previous = current[current.length - 1];
        if (!linesShareParagraph(previous, line, currentLeading)) {
          flush();
          current = [line];
          return;
        }
        current.push(line);
        const leadings = current.slice(1).map((entry, index) => entry.v - current[index].v);
        currentLeading = median(leadings);
      });

      flush();
    });
  });

  return blocks.sort((first, second) => first.top - second.top || first.left - second.left);
};
