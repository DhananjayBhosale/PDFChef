import type { PdfTextBlock, PdfTextLine, PdfTextRun } from './pdfTextBlocks';
import type { PdfSpaceRect } from './pdfNativeTextPlanning';

/**
 * Turn an edited paragraph back into the smallest set of PDF changes that reproduces it.
 *
 * Two outcomes are possible and the difference matters to the user:
 *
 * - `direct` rewrites the original PDF text objects in place. Nothing is painted over, the
 *   document's own fonts keep drawing the text, and the result stays searchable and selectable.
 * - `reflow` repaints the paragraph's area from a text-free render of the page and redraws the
 *   whole paragraph. Needed whenever the edit changes the shape of the paragraph — a new line, a
 *   deleted line break, or text that no longer fits the space the original occupied.
 *
 * Direct is always preferred. This module's job is to work out honestly when it is not possible.
 *
 * Rotated and skewed paragraphs can be edited directly but cannot be redrawn: neither the repaint
 * nor the redraw follows the baseline's angle, so the result would be visibly wrong. Those edits
 * are refused rather than saved incorrectly.
 */

export interface BlockRunEdit {
  itemIndex: number;
  /** The complete original text of the source item, replaced wholesale. */
  sourceText: string;
  sourcePdfRect: PdfSpaceRect;
  replacementText: string;
}

export type BlockEditPlan =
  | { mode: 'unchanged' }
  | { mode: 'direct'; runEdits: BlockRunEdit[] }
  | { mode: 'reflow'; reason: string }
  /** The edit cannot be saved at all. Only rotated paragraphs that would need a redraw hit this. */
  | { mode: 'blocked'; reason: string };

export interface BlockEditPlanOptions {
  /**
   * Width of `text` when drawn at `fontSize`, in the same pixel space as the block's geometry.
   * Injected so this module stays pure; the editor passes a measurement bound to the resolved font.
   */
  measure?: (text: string, fontSize: number, fontKey: string) => number;
  /** Reading-space coordinate past which text would leave the page. */
  maxU?: number;
  /** False when the original run's font cannot draw its replacement. */
  canDraw?: (text: string, fontKey: string) => boolean;
}

/** Blocks tilted more than this cannot be compared against an axis-aligned page limit. */
const AXIS_ALIGNED_TOLERANCE = 0.02;

interface RunSpan {
  run: PdfTextRun;
  /** Character range of this run inside its line's text. */
  start: number;
  end: number;
}

const runSpans = (line: PdfTextLine): RunSpan[] => {
  let offset = 0;
  return line.runs.map((run) => {
    const span = { run, start: offset, end: offset + run.text.length };
    offset = span.end;
    return span;
  });
};

const commonPrefixLength = (first: string, second: string) => {
  const limit = Math.min(first.length, second.length);
  let index = 0;
  while (index < limit && first[index] === second[index]) index += 1;
  return index;
};

const commonSuffixLength = (first: string, second: string, prefixLength: number) => {
  const limit = Math.min(first.length, second.length) - prefixLength;
  let index = 0;
  while (
    index < limit
    && first[first.length - index - 1] === second[second.length - index - 1]
  ) index += 1;
  return index;
};

interface LineChange {
  runEdits: BlockRunEdit[];
  reason?: string;
}

const planLineChange = (
  line: PdfTextLine,
  nextText: string,
  block: PdfTextBlock,
  options: BlockEditPlanOptions,
): LineChange => {
  const spans = runSpans(line);
  const originalText = line.text;
  const prefix = commonPrefixLength(originalText, nextText);
  const suffix = commonSuffixLength(originalText, nextText, prefix);
  const changeStart = prefix;
  const changeEnd = originalText.length - suffix;
  const replacementMiddle = nextText.slice(prefix, nextText.length - suffix);

  const touched = spans.filter((span) => (
    changeEnd > changeStart
      // A replacement or deletion touches every run its character range overlaps.
      ? span.start < changeEnd && span.end > changeStart
      // A pure insertion touches the run the caret sits inside, preferring the run to its left so
      // typing at a word's end extends that word rather than starting the next one.
      : span.start < changeStart && span.end >= changeStart
  ));

  const fallbackTouched = touched.length === 0
    ? spans.filter((span) => span.start <= changeStart && span.end >= changeStart)
    : touched;

  if (fallbackTouched.length === 0) {
    return { runEdits: [], reason: 'the edited text could not be traced back to this page’s text objects' };
  }

  if (fallbackTouched.some((span) => span.run.itemIndex < 0)) {
    return {
      runEdits: [],
      reason: 'the edit falls on spacing that the PDF creates by positioning rather than by a space character',
    };
  }

  const first = fallbackTouched[0];
  const last = fallbackTouched[fallbackTouched.length - 1];
  const rebuiltText = originalText.slice(first.start, changeStart)
    + replacementMiddle
    + originalText.slice(changeEnd, last.end);

  const measure = options.measure;
  if (measure && rebuiltText) {
    const nextUntouched = spans.find((span) => span.start >= last.end && span.run.text.trim() !== '');
    const axisAligned = Math.abs(block.angle) <= AXIS_ALIGNED_TOLERANCE;
    const limitU = nextUntouched
      ? nextUntouched.run.u0
      : axisAligned && Number.isFinite(options.maxU ?? NaN)
        ? options.maxU!
        : Number.POSITIVE_INFINITY;
    const available = limitU - first.run.u0;
    if (Number.isFinite(available)) {
      const required = measure(rebuiltText, first.run.fontSize, first.run.fontKey);
      if (required > available) {
        return {
          runEdits: [],
          // Naming the space matters: a document that positions every glyph separately leaves a
          // fraction of an em, so the reader needs to know that shortening or replacing still
          // works even though adding does not.
          reason: nextUntouched
            ? `the new text needs more room than the ${Math.max(0, available).toFixed(1)} points before the next word, and this PDF fixes each word's position`
            : 'the new text would run off the edge of the page',
        };
      }
    }
  }

  const runEdits: BlockRunEdit[] = [];
  fallbackTouched.forEach((span, index) => {
    const sourcePdfRect = span.run.sourcePdfRect;
    const sourceText = span.run.sourceText;
    if (!sourcePdfRect || sourceText === undefined) return;
    const replacementText = index === 0 ? rebuiltText : '';
    if (replacementText === sourceText) return;
    runEdits.push({
      itemIndex: span.run.itemIndex,
      sourceText,
      sourcePdfRect,
      replacementText,
    });
  });

  if (runEdits.length !== fallbackTouched.filter((span, index) => (
    (index === 0 ? rebuiltText : '') !== span.run.sourceText
  )).length) {
    return { runEdits: [], reason: 'one of the affected text runs has no PDF coordinates' };
  }

  return { runEdits };
};

export const planBlockEdit = (
  block: PdfTextBlock,
  nextText: string,
  options: BlockEditPlanOptions = {},
): BlockEditPlan => {
  if (nextText === block.text) return { mode: 'unchanged' };

  const rotated = Math.abs(block.angle) > AXIS_ALIGNED_TOLERANCE;
  const cannotRedraw = (reason: string): BlockEditPlan => (rotated
    ? { mode: 'blocked', reason: `${reason}, and rotated or skewed text cannot be redrawn` }
    : { mode: 'reflow', reason });

  const nextLines = nextText.split('\n');
  if (nextLines.length !== block.lines.length) {
    return cannotRedraw(nextLines.length > block.lines.length
      ? 'the paragraph gained a line'
      : 'the paragraph lost a line');
  }

  const runEdits: BlockRunEdit[] = [];
  for (let index = 0; index < block.lines.length; index += 1) {
    const line = block.lines[index];
    if (line.text === nextLines[index]) continue;
    const change = planLineChange(line, nextLines[index], block, options);
    if (change.reason) return cannotRedraw(change.reason);
    for (const edit of change.runEdits) {
      const run = line.runs.find((candidate) => candidate.itemIndex === edit.itemIndex);
      if (run && options.canDraw && !options.canDraw(edit.replacementText, run.fontKey)) {
        return cannotRedraw('the original font for this text cannot draw the replacement');
      }
    }
    runEdits.push(...change.runEdits);
  }

  if (runEdits.length === 0) return { mode: 'unchanged' };
  return { mode: 'direct', runEdits };
};

export interface StyledSegment {
  text: string;
  fontKey: string;
}

/**
 * Wrap edited text to the paragraph's original measure, keeping each stretch with the face it is
 * drawn in. Used by the redraw path so a paragraph that grew keeps both the shape the document
 * established and the mix of faces it was written with.
 *
 * `measure` is given the face's key so a bold word is measured as bold rather than as the
 * paragraph's body face, which is what stops a wrapped line from overshooting its margin.
 */
export const wrapStyledText = (
  lines: StyledSegment[][],
  measure: (text: string, fontKey: string) => number,
  maxWidth: number,
): StyledSegment[][] => {
  const wrapped: StyledSegment[][] = [];

  lines.forEach((line) => {
    let current: StyledSegment[] = [];
    let width = 0;

    // A line never ends on the space that pushed it over the margin, and never starts on one.
    const finish = () => {
      while (current.length > 0) {
        const last = current[current.length - 1];
        last.text = last.text.replace(/\s+$/, '');
        if (last.text) break;
        current.pop();
      }
      wrapped.push(current);
      current = [];
      width = 0;
    };

    const push = (text: string, fontKey: string, advance: number) => {
      const last = current[current.length - 1];
      if (last && last.fontKey === fontKey) last.text += text;
      else current.push({ text, fontKey });
      width += advance;
    };

    line.forEach((segment) => {
      // Split on spaces but keep them, so a wrap point is a real word boundary and the spacing
      // inside a segment survives.
      segment.text.split(/(\s+)/).filter(Boolean).forEach((piece) => {
        const blank = /^\s+$/.test(piece);
        const advance = measure(piece, segment.fontKey);
        if (current.length > 0 && !blank && maxWidth > 0 && width + advance > maxWidth) finish();
        if (current.length === 0 && blank) return;
        push(piece, segment.fontKey, advance);
      });
    });

    finish();
  });

  return wrapped.length > 0 ? wrapped : [[]];
};

/** The plain-text form of a wrapped line, for measuring and for drawing as one run. */
export const styledLineText = (line: StyledSegment[]) => line.map((segment) => segment.text).join('');

/** One occurrence of a search term inside a paragraph. */
export interface StyledMatch {
  /** Index of the wrapped line the match starts on. */
  line: number;
  /** Character offset of the match within that line. */
  start: number;
  end: number;
}

const foldCase = (value: string, caseSensitive: boolean) => (caseSensitive ? value : value.toLowerCase());

/**
 * Find every occurrence of `query` in a paragraph, line by line.
 *
 * Matches do not cross a line break, because a PDF's line breaks are positions on the page rather
 * than places a word was hyphenated: a term split across two lines is two different runs of glyphs
 * and replacing it as one would move text the user never touched.
 */
export const findInStyledLines = (
  lines: StyledSegment[][],
  query: string,
  caseSensitive = false,
): StyledMatch[] => {
  if (!query) return [];
  const needle = foldCase(query, caseSensitive);
  const matches: StyledMatch[] = [];

  lines.forEach((line, lineIndex) => {
    const haystack = foldCase(styledLineText(line), caseSensitive);
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      matches.push({ line: lineIndex, start: at, end: at + query.length });
      from = at + query.length;
    }
  });

  return matches;
};

/**
 * Replace occurrences of `query`, keeping every stretch with the face it is drawn in. The
 * replacement inherits the face of the first character it covers, which is what makes replacing a
 * bold term leave a bold term behind.
 */
export const replaceInStyledLines = (
  lines: StyledSegment[][],
  query: string,
  replacement: string,
  caseSensitive = false,
  only?: StyledMatch,
): { lines: StyledSegment[][]; replaced: number } => {
  if (!query) return { lines, replaced: 0 };
  let replaced = 0;

  const next = lines.map((line, lineIndex) => {
    const matches = findInStyledLines([line], query, caseSensitive)
      .filter((match) => !only || (only.line === lineIndex && only.start === match.start));
    if (matches.length === 0) return line;

    const rebuilt: StyledSegment[] = [];
    const push = (text: string, fontKey: string) => {
      if (!text) return;
      const last = rebuilt[rebuilt.length - 1];
      if (last && last.fontKey === fontKey) last.text += text;
      else rebuilt.push({ text, fontKey });
    };

    let cursor = 0;
    let pending = 0;
    line.forEach((segment) => {
      const segmentStart = cursor;
      const segmentEnd = cursor + segment.text.length;
      let offset = 0;

      while (pending < matches.length && matches[pending].start < segmentEnd) {
        const match = matches[pending];
        if (match.start >= segmentStart) {
          push(segment.text.slice(offset, match.start - segmentStart), segment.fontKey);
          push(replacement, segment.fontKey);
          replaced += 1;
        }
        // A match may run past this segment; drop only the part that lies inside it.
        offset = Math.max(offset, Math.min(segment.text.length, match.end - segmentStart));
        if (match.end > segmentEnd) break;
        pending += 1;
      }

      push(segment.text.slice(offset), segment.fontKey);
      cursor = segmentEnd;
    });

    return rebuilt.length > 0 ? rebuilt : [{ text: '', fontKey: line[0]?.fontKey ?? '' }];
  });

  return { lines: next, replaced };
};

/** The paragraph's runs as styled segments, for a paragraph nobody has edited yet. */
export const blockStyledSegments = (block: PdfTextBlock): StyledSegment[][] =>
  block.lines.map((line) => line.runs.map((run) => ({ text: run.text, fontKey: run.fontKey })));
