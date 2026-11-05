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
  /** The colour of every character of every original line, when the paragraph mixes colours. */
  inks?: string[][];
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
  // The same splice would also carry a red word into a black run's colour. Within one run, the
  // save rewrites a touched word in a single text object, so a word drawn in two colours (which
  // PDF.js reports as one run) cannot be written in place either.
  const inks = options.inks?.[block.lines.indexOf(line)];
  if (inks) {
    let wordStart = changeStart;
    let wordEnd = changeEnd;
    while (wordStart > first.start && !/\s/.test(originalText[wordStart - 1])) wordStart -= 1;
    while (wordEnd < last.end && !/\s/.test(originalText[wordEnd])) wordEnd += 1;
    const [from, to] = fallbackTouched.length > 1 ? [first.start, last.end] : [wordStart, wordEnd];
    if (new Set(inks.slice(from, to)).size > 1) {
      return { runEdits: [], reason: 'the edit spans different text colours that must be preserved' };
    }
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
  // Colour is not a face: an in-place rewrite keeps each text object's own colour.
  if (nextText === block.text && (!options.segments
    || styledTextEqual(blockStyledSegments(block), options.segments, block.fontSize, false))) return { mode: 'unchanged' };

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
    if (!styledTextEqual(directStyles, options.segments, block.fontSize, false)) {
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
  /**
   * The colour this stretch is drawn in, set only where a paragraph mixes colours. Absent, the
   * paragraph's own colour applies.
   */
  color?: string;
}

const sameStyle = (first: StyledSegment, second: StyledSegment) => first.fontKey === second.fontKey
  && first.fontSize === second.fontSize && first.color === second.color;

/** Compare appearance independently of how the browser split adjacent equal-style spans. */
export const styledTextEqual = (
  first: StyledSegment[][],
  second: StyledSegment[][],
  defaultSize: number,
  compareColor = true,
) => {
  const normalize = (lines: StyledSegment[][]) => lines.map(line => {
    const merged: StyledSegment[] = [];
    line.forEach(segment => {
      if (!segment.text) return;
      const next = { text: segment.text, fontKey: segment.fontKey, fontSize: segment.fontSize ?? defaultSize,
        color: compareColor ? segment.color : undefined };
      const last = merged.at(-1);
      if (last && sameStyle(last, next)) last.text += segment.text;
      else merged.push(next);
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
  measure: (text: string, fontKey: string, segment: StyledSegment) => number,
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
      if (last && sameStyle(last, segment)) last.text += text;
      else current.push({ ...segment, text });
      width += advance;
    };

    // Split on spaces but keep them, so a wrap point is a real word boundary and the spacing
    // inside a segment survives. A word whose letters change face part-way is still one word.
    const words: Array<Array<{ text: string; segment: StyledSegment }>> = [];
    line.forEach((segment) => {
      segment.text.split(/(\s+)/).filter(Boolean).forEach((piece) => {
        const blank = /^\s+$/.test(piece);
        const last = words.at(-1);
        if (!blank && last && !/^\s+$/.test(last.at(-1)!.text)) last.push({ text: piece, segment });
        else words.push([{ text: piece, segment }]);
      });
    });
    words.forEach((word) => {
      const blank = /^\s+$/.test(word[0].text);
      const advances = word.map(({ text, segment }) => measure(text, segment.fontKey, segment));
      const advance = advances.reduce((sum, value) => sum + value, 0);
      if (current.length > 0 && !blank && maxWidth > 0 && width + advance > maxWidth) finish();
      if (current.length === 0 && blank) return;
      word.forEach(({ text: piece, segment }, index) => {
        // A URL or a long replacement without spaces still has to fit the explicit line model.
        // Split by Unicode character rather than UTF-16 units so surrogate pairs stay intact.
        if (!blank && maxWidth > 0 && advance > maxWidth) {
          let chunk = '';
          for (const character of piece) {
            const candidate = chunk + character;
            if (chunk && width + measure(candidate, segment.fontKey, segment) > maxWidth) {
              push(chunk, segment, measure(chunk, segment.fontKey, segment));
              finish();
              chunk = character;
            } else if (!chunk && current.length > 0 && width + measure(candidate, segment.fontKey, segment) > maxWidth) {
              finish();
              chunk = candidate;
            } else chunk = candidate;
          }
          if (chunk) push(chunk, segment, measure(chunk, segment.fontKey, segment));
        } else push(piece, segment, advances[index]);
      });
    });

    finish();
  });

  return wrapped.length > 0 ? wrapped : [[]];
};

/** The plain-text form of a wrapped line, for measuring and for drawing as one run. */
export const styledLineText = (line: StyledSegment[]) => line.map((segment) => segment.text).join('');

const LIST_MARKER = /^\s*(?:[\u2022\u25e6\u25aa\u2023\u00b7*\u2013\u2014-]|\d{1,3}[.)])\s/;

/**
 * Where a paragraph's line breaks only mark the PDF wrapping its text, as the indexes of those `\n`
 * characters. A phone's dock field shows them as spaces, so the paragraph reads as one text there,
 * while the saved text keeps them.
 *
 * A break is the writer's own when a line on either side is empty, the line ends with a hyphen, the
 * next line starts a list item, or (while the text still has the PDF's lines) the next line's first
 * word would have fitted on the line. A paragraph whose line count changed has no soft breaks left.
 */
export const softLineBreaks = (text: string, block?: Pick<PdfTextBlock, 'lines' | 'measure'>): number[] => {
  const lines = text.split('\n');
  const geometry = block && block.lines.length === lines.length ? block.lines : null;
  // Once lines were added or removed there is nothing left to tell wrapping from a typed break,
  // so every break is kept as it is.
  if (block && !geometry) return [];
  const left = geometry ? Math.min(...geometry.map((line) => line.u0)) : 0;
  const wordWouldFit = (index: number) => {
    if (!geometry) return false;
    const next = geometry[index + 1];
    const perLetter = (next.u1 - next.u0) / Math.max(1, next.text.length);
    const word = lines[index + 1].trimStart().split(/\s/)[0] ?? '';
    return geometry[index].u1 - left + perLetter * (word.length + 1) <= (block?.measure ?? 0);
  };
  const soft: number[] = [];
  let at = 0;
  lines.forEach((line, index) => {
    at += line.length;
    if (index < lines.length - 1) {
      const next = lines[index + 1];
      const hard = !line.trim() || !next.trim() || /[-\u2010\u00ad]$/.test(line) || LIST_MARKER.test(next)
        || Boolean(geometry?.[index + 1]?.startsListItem) || wordWouldFit(index);
      if (!hard) soft.push(at);
    }
    at += 1;
  });
  return soft;
};

/** Carry soft line breaks (see `softLineBreaks`) through one edit; any the edit replaced are gone. */
export const moveSoftBreaks = (
  soft: number[],
  before: string,
  after: string,
  selection?: { start: number; end: number } | null,
): number[] => {
  const anchored = selection && selection.start >= 0 && selection.end >= selection.start
    && selection.end <= before.length && after.length >= selection.start + before.length - selection.end
    && after.startsWith(before.slice(0, selection.start)) && after.endsWith(before.slice(selection.end));
  const prefix = anchored ? selection.start : commonPrefixLength(before, after);
  const end = before.length - (anchored ? before.length - selection.end : commonSuffixLength(before, after, prefix));
  const shift = after.length - before.length;
  return soft.filter((at) => at < prefix || at >= end).map((at) => (at < prefix ? at : at + shift));
};

/**
 * A paragraph's soft breaks after its text changes from `before` to `after`. Without a record yet,
 * they are guessed from `before`, which still has the PDF's lines. A break typed in is never soft.
 */
export const carrySoftBreaks = (
  soft: number[] | undefined,
  block: Pick<PdfTextBlock, 'lines' | 'measure'>,
  before: string,
  after: string,
  selection?: { start: number; end: number } | null,
): number[] => moveSoftBreaks(soft ?? softLineBreaks(before, block), before, after, selection)
  .filter((at) => after[at] === '\n');

/**
 * Wrap a redrawn paragraph to its width the way a reader expects, keeping the breaks its author made.
 *
 * Lines above the first one that no longer fits stay exactly as they are. From that line on, a
 * break is kept when it was a real one: it is not in `soft` (or, without `soft`, the next line's
 * first word would have fitted on it), it ends with a hyphen, or either line is empty. Every other
 * break was only where the old line ran
 * out of room, so those lines are joined and wrapped again. Without this, a word added on a
 * phone pushed its line past the margin and the reader had to break lines by hand.
 */
export const flowStyledLines = (
  lines: StyledSegment[][],
  measure: (text: string, segment: StyledSegment) => number,
  maxWidth: number,
  /** Where known, the text indexes of the breaks that only mark the PDF's wrapping. */
  soft?: readonly number[],
  tolerance = 0.5,
): StyledSegment[][] => {
  if (!(maxWidth > 0) || lines.length === 0) return lines;
  const widthOf = (line: StyledSegment[]) => {
    let end = line.length - 1;
    while (end >= 0 && !line[end].text.trim()) end -= 1;
    return line.slice(0, end + 1).reduce((total, segment, index) => total
      + measure(index === end ? segment.text.replace(/\s+$/, '') : segment.text, segment), 0);
  };
  const first = lines.findIndex((line) => widthOf(line) > maxWidth + tolerance);
  if (first < 0) return lines;
  const firstWord = (line: StyledSegment[]) => {
    const segment = line.find((candidate) => candidate.text.trim());
    const word = segment?.text.trimStart().split(/\s/)[0] ?? '';
    return segment && word ? { word, segment } : null;
  };
  const fitsNextWord = (line: StyledSegment[], next: StyledSegment[]) => {
    const start = firstWord(next);
    const last = line.at(-1);
    if (!start || !last) return false;
    return widthOf(line) + measure(' ', last) + measure(start.word, start.segment) <= maxWidth + tolerance;
  };
  const softAt = soft ? new Set(soft) : null;
  const breakAt: number[] = [];
  lines.reduce((at, line, index) => { breakAt[index] = at + styledLineText(line).length; return breakAt[index] + 1; }, 0);
  const result = lines.slice(0, first);
  let flow: StyledSegment[] = [];
  const flush = () => {
    result.push(...wrapStyledText([flow], (text, _fontKey, segment) => measure(text, segment), maxWidth));
    flow = [];
  };
  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index];
    const text = styledLineText(line);
    const previous = flow.at(-1);
    if (previous && text && !/\s$/.test(previous.text) && !/^\s/.test(text)) flow.push({ ...previous, text: ' ' });
    flow.push(...line.map((segment) => ({ ...segment })));
    const next = lines[index + 1];
    const hard = !next || !text.trim() || !styledLineText(next).trim()
      || /[-\u2010\u00ad]$/.test(text.trimEnd())
      || (softAt ? !softAt.has(breakAt[index]) : fitsNextWord(line, next));
    if (hard) flush();
  }
  return result;
};

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
    if (last && sameStyle(last, piece)) last.text += part;
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
      if (last && sameStyle(last, segment)) last.text += text;
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

/** Group text into stretches of one colour, given the colour of each of its UTF-16 units. */
export const splitByInk = (text: string, inks: ReadonlyArray<string | undefined> | undefined) => {
  const parts: Array<{ text: string; color?: string }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const color = inks?.[index];
    const last = parts.at(-1);
    if (last && last.color === color) last.text += text[index];
    else parts.push(color ? { text: text[index], color } : { text: text[index] });
  }
  return parts;
};

/** The colour of each UTF-16 unit of a line, or undefined when no segment states one. */
export const segmentInks = (line: StyledSegment[]): Array<string | undefined> | undefined => (
  line.some((segment) => segment.color)
    ? line.flatMap((segment) => Array<string | undefined>(segment.text.length).fill(segment.color))
    : undefined
);

/** The same text with every colour removed, so the paragraph's own colour applies throughout. */
export const withoutInks = (lines: StyledSegment[][]): StyledSegment[][] => lines.map((line) => {
  const merged: StyledSegment[] = [];
  line.forEach(({ color: _color, ...segment }) => {
    const last = merged.at(-1);
    if (last && sameStyle(last, segment)) last.text += segment.text;
    else merged.push(segment);
  });
  return merged;
});

/**
 * The paragraph's runs as styled segments, for a paragraph nobody has edited yet. A run whose
 * characters are drawn in more than one colour is split where the colour changes.
 */
export const blockStyledSegments = (block: PdfTextBlock, inks?: string[][]): StyledSegment[][] =>
  block.lines.map((line, lineIndex) => {
    const lineInks = inks?.[lineIndex];
    let offset = 0;
    return line.runs.flatMap((run) => {
      const start = offset;
      offset += run.text.length;
      const style = { fontKey: run.fontKey, fontSize: run.fontSize };
      if (!lineInks || !run.text) return [{ text: run.text, ...style }];
      return splitByInk(run.text, lineInks.slice(start, offset)).map((part) => ({ ...part, ...style }));
    });
  });
