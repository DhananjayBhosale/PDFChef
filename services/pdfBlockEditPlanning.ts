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
  /** Actual editor styles; repeated text alone cannot identify which source run was edited. */
  segments?: StyledSegment[][];
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
  // A direct splice moves all surviving text into the first source object. If the selection
  // crosses a face or size boundary, that would also restyle its untouched suffix (and any
  // unchanged runs between separate replacements). Keep the editor's styled segments instead.
  if (fallbackTouched.some(({ run }) => (
    run.fontKey !== first.run.fontKey || run.fontSize !== first.run.fontSize
  ))) {
    return { runEdits: [], reason: 'the edit spans different text styles that must be preserved' };
  }
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
      // The PDF advance is authoritative. A substitute face can be much wider than the
      // original even before editing; only the measured change should consume extra room.
      const previousText = originalText.slice(first.start, last.end);
      const required = last.run.u1 - first.run.u0
        + measure(rebuiltText, first.run.fontSize, first.run.fontKey)
        - measure(previousText, first.run.fontSize, first.run.fontKey);
      if (required > available + 0.5) {
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
  if (nextText === block.text && (!options.segments
    || styledTextEqual(blockStyledSegments(block), options.segments, block.fontSize))) return { mode: 'unchanged' };

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

  if (options.segments) {
    const replacements = new Map(runEdits.map(edit => [edit.itemIndex, edit.replacementText]));
    const directStyles = block.lines.map(line => line.runs.map(run => ({
      text: replacements.get(run.itemIndex) ?? run.text, fontKey: run.fontKey, fontSize: run.fontSize,
    })));
    if (!styledTextEqual(directStyles, options.segments, block.fontSize)) {
      return cannotRedraw('the original text objects would change the edited text’s font or size');
    }
  }
  if (runEdits.length === 0) return { mode: 'unchanged' };
  return { mode: 'direct', runEdits };
};

export interface StyledSegment {
  text: string;
  fontKey: string;
  /** Original point size, retained when the paragraph needs a redraw. */
  fontSize?: number;
}

/** Compare appearance independently of how the browser split adjacent equal-style spans. */
export const styledTextEqual = (first: StyledSegment[][], second: StyledSegment[][], defaultSize: number) => {
  const normalize = (lines: StyledSegment[][]) => lines.map(line => {
    const merged: StyledSegment[] = [];
    line.forEach(segment => {
      if (!segment.text) return;
      const size = segment.fontSize ?? defaultSize;
      const last = merged.at(-1);
      if (last?.fontKey === segment.fontKey && last.fontSize === size) last.text += segment.text;
      else merged.push({ text: segment.text, fontKey: segment.fontKey, fontSize: size });
    });
    return merged;
  });
  return JSON.stringify(normalize(first)) === JSON.stringify(normalize(second));
};

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

    const push = (text: string, segment: StyledSegment, advance: number) => {
      const last = current[current.length - 1];
      if (last && last.fontKey === segment.fontKey && last.fontSize === segment.fontSize) last.text += text;
      else current.push({ ...segment, text });
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
        // A URL or a long replacement without spaces still has to fit the explicit line model.
        // Split by Unicode character rather than UTF-16 units so surrogate pairs stay intact.
        if (!blank && maxWidth > 0 && advance > maxWidth) {
          let chunk = '';
          for (const character of piece) {
            const candidate = chunk + character;
            if (chunk && measure(candidate, segment.fontKey) > maxWidth) {
              push(chunk, segment, measure(chunk, segment.fontKey));
              finish();
              chunk = character;
            } else chunk = candidate;
          }
          if (chunk) push(chunk, segment, measure(chunk, segment.fontKey));
        } else push(piece, segment, advance);
      });
    });

    finish();
  });

  return wrapped.length > 0 ? wrapped : [[]];
};

/** The plain-text form of a wrapped line, for measuring and for drawing as one run. */
export const styledLineText = (line: StyledSegment[]) => line.map((segment) => segment.text).join('');

/** Restore style metadata when plaintext-only editing removes or duplicates run spans. */
export const preserveStyledTextEdit = (
  previous: StyledSegment[][],
  text: string,
  fallback: StyledSegment,
  selection?: { start: number; end: number } | null,
): StyledSegment[][] => {
  const source = previous.map(styledLineText).join('\n');
  // Use the browser's pre-input target range when available. Equal text on both sides of a
  // selection makes a prefix/suffix diff ambiguous, even though the actual selection is known.
  const anchored = selection && selection.start >= 0 && selection.end >= selection.start
    && selection.end <= source.length && text.length >= selection.start + source.length - selection.end
    && text.startsWith(source.slice(0, selection.start)) && text.endsWith(source.slice(selection.end));
  const prefix = anchored ? selection.start : commonPrefixLength(source, text);
  const suffix = anchored ? source.length - selection.end : commonSuffixLength(source, text, prefix);
  const end = source.length - suffix;
  let cursor = 0;
  const spans = previous.flatMap((line, index) => (
    index < previous.length - 1 ? [...line, { ...(line.at(-1) ?? fallback), text: '\n' }] : line
  )).map(segment => {
    const span = { segment, start: cursor, end: cursor + segment.text.length };
    cursor = span.end;
    return span;
  });
  // Replacement inherits its first selected character; insertion at a boundary extends the
  // preceding run. Prefix and suffix retain their original faces and point sizes exactly.
  const inherited = (prefix === end
    ? spans.find(span => span.start < prefix && span.end >= prefix)
    : spans.find(span => span.start <= prefix && span.end > prefix))?.segment ?? spans[0]?.segment ?? fallback;
  const pieces: StyledSegment[] = [];
  const copy = (start: number, finish: number) => spans.forEach(span => {
    const from = Math.max(start, span.start), to = Math.min(finish, span.end);
    if (to > from) pieces.push({ ...span.segment, text: span.segment.text.slice(from - span.start, to - span.start) });
  });
  copy(0, prefix);
  pieces.push({ ...inherited, text: text.slice(prefix, text.length - suffix) });
  copy(end, source.length);
  const lines: StyledSegment[][] = [[]];
  pieces.forEach(piece => piece.text.split('\n').forEach((part, index) => {
    if (index > 0) lines.push([]);
    if (!part) return;
    const line = lines[lines.length - 1];
    const last = line.at(-1);
    if (last?.fontKey === piece.fontKey && last.fontSize === piece.fontSize) last.text += part;
    else line.push({ ...piece, text: part });
  }));
  return lines;
};

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
    const original = styledLineText(line);
    const haystack = foldCase(original, caseSensitive);
    // Unicode lowercasing can expand a character (İ -> i + combining dot). Search the complete
    // folded string so contextual casing still works, then map its positions back to the PDF's
    // original UTF-16 offsets before highlighting or replacing any text.
    const offsets: Array<{ start: number; end: number }> = [];
    if (haystack.length !== original.length) {
      let start = 0;
      for (const character of original) {
        const end = start + character.length;
        for (let index = 0; index < foldCase(character, caseSensitive).length; index += 1) {
          offsets.push({ start, end });
        }
        start = end;
      }
    }
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      matches.push({
        line: lineIndex,
        start: offsets[at]?.start ?? at,
        end: offsets[at + needle.length - 1]?.end ?? at + needle.length,
      });
      from = at + needle.length;
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
    const push = (text: string, segment: StyledSegment) => {
      if (!text) return;
      const last = rebuilt[rebuilt.length - 1];
      if (last && last.fontKey === segment.fontKey && last.fontSize === segment.fontSize) last.text += text;
      else rebuilt.push({ ...segment, text });
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
          push(segment.text.slice(offset, match.start - segmentStart), segment);
          push(replacement, segment);
          replaced += 1;
        }
        // A match may run past this segment; drop only the part that lies inside it.
        offset = Math.max(offset, Math.min(segment.text.length, match.end - segmentStart));
        if (match.end > segmentEnd) break;
        pending += 1;
      }

      push(segment.text.slice(offset), segment);
      cursor = segmentEnd;
    });

    return rebuilt.length > 0 ? rebuilt : [{ text: '', fontKey: line[0]?.fontKey ?? '' }];
  });

  return { lines: next, replaced };
};

/** The paragraph's runs as styled segments, for a paragraph nobody has edited yet. */
export const blockStyledSegments = (block: PdfTextBlock): StyledSegment[][] =>
  block.lines.map((line) => line.runs.map((run) => ({ text: run.text, fontKey: run.fontKey, fontSize: run.fontSize })));
