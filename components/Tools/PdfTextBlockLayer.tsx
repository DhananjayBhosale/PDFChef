import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { PdfTextAlign, PdfTextBlock, PdfTextLine } from '../../services/pdfTextBlocks';
import {
  fitTextMetrics,
  measureTextWidth,
  resolveFont,
  type FontOverride,
  type PdfFontDescriptor,
  type ResolvedFont,
} from '../../services/pdfFontResolution';

/**
 * The editing surface of the inline PDF text editor.
 *
 * One transparent `contentEditable` sits over each reconstructed paragraph. Because its text is
 * transparent, the user reads the canvas underneath — the document's real rendering — while the
 * browser supplies the caret, drag selection, double-tap-to-select-word, the iOS magnifier, the
 * Android selection handles and IME. Reimplementing any of that by hand is exactly what makes
 * touch PDF editors feel wrong, so none of it is reimplemented here.
 */

export interface BlockEditState {
  blockId: string;
  pageIndex: number;
  text: string;
  fontOverride?: FontOverride;
  color?: string;
  /** Font size in points, when the user has overridden the document's own size. */
  fontSize?: number;
  /** The edited text split by the faces it is drawn with, so a redraw keeps them. */
  segments?: StyledSegment[][];
  /** Text-free render of the block's area, used to hide the original text once it changes. */
  patch?: string;
  patchColor?: string;
  patchFlat?: boolean;
  /** False while the paragraph's page has never been rendered, so its colours are assumed. */
  sampledColors?: boolean;
  reflowing: boolean;
}

export interface ResolvedBlock {
  block: PdfTextBlock;
  /** The paragraph's dominant face, used for its own metrics and for anything typed fresh. */
  font: ResolvedFont;
  descriptor: PdfFontDescriptor | undefined;
  /** Every face the paragraph uses, so a bold lead-in stays bold in the overlay and on export. */
  fontsByKey: Map<string, ResolvedFont>;
  /** Per-line, per-run spacing corrections that put every glyph back where the PDF drew it. */
  runFits: Array<Array<{ wordSpacing: number; letterSpacing: number }>>;
  /**
   * How the overlay should lay the paragraph out, which is not always how the PDF did.
   *
   * Centring or right-aligning only lands on the glyphs when each line's rendered width matches
   * the width the PDF drew. Where the spacing correction cannot close that gap — a row of dot
   * leaders is the usual culprit — the whole shortfall is dumped on the left edge instead, so the
   * paragraph falls back to laying out from the left, which is the edge a reader is anchored to.
   */
  overlayAlign: PdfTextAlign;
  /** Vertical touch padding that never reaches into a neighbouring paragraph. */
  hitPadding: number;
  /** Used to settle which paragraph wins a tap where two of them overlap. */
  area: number;
}

interface Props {
  blocks: PdfTextBlock[];
  fonts: Map<string, PdfFontDescriptor>;
  edits: Record<string, BlockEditState>;
  activeBlockId: string | null;
  displayScale: number;
  /** False while a shape or text-box insert is armed, so page taps are not stolen. */
  enabled: boolean;
  coarsePointer: boolean;
  onActivate: (blockId: string | null) => void;
  onChange: (blockId: string, text: string, segments: StyledSegment[][]) => void;
  onBeginChange: (blockId: string) => void;
}

/**
 * Computed font size iOS requires before it will leave a focused editable at the page's own scale.
 * Below it, Safari zooms the whole page to the element, which fights the editor's own zoom.
 */
const MINIMUM_COMPUTED_FONT_PX = 16;
/** Minimum comfortable target height on touch, per WCAG 2.2 target size. */
const TOUCH_TARGET = 44;
const POINTER_TARGET = 28;

/**
 * The paragraph overlay's own stacking band.
 *
 * Paragraphs are ordered among themselves by size so the smaller box wins a tap where two overlap,
 * but the band is bounded: a dense page has hundreds of them, and everything the reader placed on
 * the page themselves — annotations, shapes, form fields — has to stay above all of it.
 */
const PARAGRAPH_LAYER_BASE = 2;
const PARAGRAPH_LAYER_SPAN = 96;
const PARAGRAPH_ACTIVE_LAYER = 150;

export const useResolvedBlocks = (
  blocks: PdfTextBlock[],
  fonts: Map<string, PdfFontDescriptor>,
  edits: Record<string, BlockEditState>,
  coarsePointer: boolean,
): ResolvedBlock[] => useMemo(() => {
  const minimumTarget = coarsePointer ? TOUCH_TARGET : POINTER_TARGET;

  return blocks.map((block, index) => {
    const descriptor = fonts.get(block.fontKey);
    const edit = edits[block.id];
    const font = descriptor
      ? resolveFont(descriptor, edit?.text ?? block.text, edit?.fontOverride)
      : {
        mode: 'substituted' as const,
        cssFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
        cssWeight: '400',
        cssStyle: 'normal',
        klass: 'sans-serif' as const,
        reason: 'this run has no font information',
        missingGlyphs: [],
      };

    // Paragraphs routinely mix faces — a bold lead-in, an italic term, a different size. Each run
    // is resolved on its own so the overlay lands on the same pixels the page already shows.
    const fontsByKey = new Map<string, ResolvedFont>();
    block.lines.forEach((line: PdfTextLine) => line.runs.forEach((run) => {
      if (!run.fontKey || fontsByKey.has(run.fontKey)) return;
      const runDescriptor = fonts.get(run.fontKey);
      fontsByKey.set(run.fontKey, runDescriptor
        ? resolveFont(runDescriptor, run.text, edit?.fontOverride)
        : font);
    }));

    const runFits = block.lines.map((line: PdfTextLine) => line.runs.map((run) => fitTextMetrics(
      run.text,
      run.u1 - run.u0,
      fontsByKey.get(run.fontKey) ?? font,
      run.fontSize,
    )));

    const reproducesItsWidth = block.lines.every((line: PdfTextLine, lineIndex) => (
      line.runs.every((run, runIndex) => {
        const target = run.u1 - run.u0;
        if (!(target > 0) || !run.text.trim()) return true;
        const runFont = fontsByKey.get(run.fontKey) ?? font;
        const fit = runFits[lineIndex][runIndex];
        const spaces = (run.text.match(/ /g) || []).length;
        const drawn = measureTextWidth(run.text, runFont, run.fontSize)
          + fit.wordSpacing * spaces
          + fit.letterSpacing * run.text.length;
        return Math.abs(drawn - target) <= Math.max(1.5, run.fontSize * 0.25);
      })
    ));
    const overlayAlign: PdfTextAlign = reproducesItsWidth ? block.align : 'left';

    // Grow the tap target towards whatever sits above and below, but never past halfway. The
    // neighbours that matter are the ones sharing horizontal space: in a table the next paragraph
    // in reading order is usually the cell beside this one, which is no constraint at all, while
    // the cell underneath it is.
    let gapAbove = Number.POSITIVE_INFINITY;
    let gapBelow = Number.POSITIVE_INFINITY;
    blocks.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      const shared = Math.min(block.left + block.width, other.left + other.width)
        - Math.max(block.left, other.left);
      if (shared <= 0) return;
      if (other.top + other.height <= block.top) {
        gapAbove = Math.min(gapAbove, block.top - (other.top + other.height));
      } else if (other.top >= block.top + block.height) {
        gapBelow = Math.min(gapBelow, other.top - (block.top + block.height));
      } else {
        // Already sharing space with this one: taking any more would only make it worse.
        gapAbove = 0;
        gapBelow = 0;
      }
    });
    const wanted = Math.max(0, (minimumTarget - block.height) / 2);
    const hitPadding = Math.max(0, Math.min(wanted, gapAbove / 2, gapBelow / 2));

    return { block, font, descriptor, fontsByKey, runFits, overlayAlign, hitPadding, area: block.width * block.height };
  });
}, [blocks, coarsePointer, edits, fonts]);

/**
 * Read an edited paragraph back out of the DOM as plain text.
 *
 * Browsers substitute a non-breaking space when you type a space at the end of a line, so a
 * paragraph the document wrote with ordinary spaces would come back subtly different and read as
 * an edit that was never made. Where the original never used one, they are read back as spaces.
 */
const readBlockText = (element: HTMLElement, allowNonBreakingSpace: boolean) => {
  const text = element.innerText.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return allowNonBreakingSpace ? text : text.replace(/\u00a0/g, ' ');
};

/** A stretch of paragraph text that is drawn with one face. */
export interface StyledSegment {
  text: string;
  fontKey: string;
}

/**
 * Write a paragraph's runs into the editable, one span per run.
 *
 * React must never own these children. Re-rendering them replaces the text nodes the selection
 * points at, which collapses the caret to the start of the paragraph on every keystroke, so the
 * content is built by hand here and left alone while the user types.
 *
 * One span per run rather than per line is what keeps a bold lead-in bold: the caret lands on the
 * right glyph, and anything typed inside that span inherits the face the browser is already
 * drawing there — which is what a reader expects and what the export then reproduces.
 */
const writeBlockContent = (
  element: HTMLElement,
  lines: PdfTextLine[],
  fonts: Map<string, ResolvedFont>,
  fallback: ResolvedFont,
  fits: Array<Array<{ wordSpacing: number; letterSpacing: number }>> | null,
) => {
  const fragment = document.createDocumentFragment();
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) fragment.append(document.createTextNode('\n'));
    line.runs.forEach((run, runIndex) => {
      const span = document.createElement('span');
      span.textContent = run.text;
      span.dataset.font = run.fontKey;
      const font = fonts.get(run.fontKey) ?? fallback;
      span.style.fontFamily = font.cssFamily;
      span.style.fontWeight = font.cssWeight;
      span.style.fontStyle = font.cssStyle;
      const fit = fits?.[lineIndex]?.[runIndex];
      if (fit?.wordSpacing) span.style.wordSpacing = `${fit.wordSpacing}px`;
      if (fit?.letterSpacing) span.style.letterSpacing = `${fit.letterSpacing}px`;
      fragment.append(span);
    });
  });
  element.replaceChildren(fragment);
};

/**
 * Read the paragraph back as styled segments.
 *
 * After an edit the spans no longer match the PDF's runs — the browser has split, merged and
 * extended them as the user typed — but each one still carries the face it was drawn with, which
 * is exactly what a redraw needs.
 */
export const readStyledSegments = (
  element: HTMLElement,
  fallbackKey: string,
  allowNonBreakingSpace = true,
): StyledSegment[][] => {
  const lines: StyledSegment[][] = [[]];
  const append = (raw: string, fontKey: string) => {
    const text = allowNonBreakingSpace ? raw : raw.replace(/\u00a0/g, ' ');
    if (!text) return;
    text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (!part) return;
      const current = lines[lines.length - 1];
      const last = current[current.length - 1];
      if (last && last.fontKey === fontKey) last.text += part;
      else current.push({ text: part, fontKey });
    });
  };

  const walk = (node: Node, inheritedKey: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent ?? '', inheritedKey);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      lines.push([]);
      return;
    }
    const key = node.dataset.font || inheritedKey;
    node.childNodes.forEach((child) => walk(child, key));
  };

  element.childNodes.forEach((child) => walk(child, fallbackKey));
  // A trailing empty line is the browser's, not the user's.
  while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
};

const BlockEditor: React.FC<{
  resolved: ResolvedBlock & { stackOrder: number };
  edit: BlockEditState | undefined;
  isActive: boolean;
  displayScale: number;
  enabled: boolean;
  onActivate: (blockId: string | null) => void;
  onChange: (blockId: string, text: string, segments: StyledSegment[][]) => void;
  onBeginChange: (blockId: string) => void;
}> = ({ resolved, edit, isActive, displayScale, enabled, onActivate, onChange, onBeginChange }) => {
  const { block, font, fontsByKey, runFits, overlayAlign, hitPadding, stackOrder } = resolved;
  const editableRef = useRef<HTMLDivElement>(null);
  const committedText = useRef(edit?.text ?? block.text);
  const typingSession = useRef(false);
  const isDirty = Boolean(edit) && (edit?.text ?? block.text) !== block.text;
  const text = edit?.text ?? block.text;
  const hasOutgrownItsBox = isDirty && text.split('\n').length > block.lines.length;
  const fontSizePx = (edit?.fontSize ?? block.fontSize) * displayScale;
  const lineHeightPx = Math.max(fontSizePx, block.leading * displayScale);
  /**
   * Ratio that lifts this paragraph's *computed* font size to the 16px iOS insists on.
   *
   * Zooming the page already makes the text legible, but that zoom is a transform on an ancestor
   * and leaves the computed size alone — and the computed size is what iOS reads before deciding
   * to zoom a focused editable itself. Its zoom then lands on top of the editor's own, magnifying
   * the page far past what was asked for and panning the fixed toolbar half off the screen.
   *
   * So the paragraph is laid out in units `iosZoomGuard` times larger and scaled back down by the
   * same factor. Every length below is multiplied, so this is a change of units and nothing else:
   * the paragraph draws on exactly the pixels it did before.
   */
  const iosZoomGuard = fontSizePx > 0 ? Math.max(1, MINIMUM_COMPUTED_FONT_PX / fontSizePx) : 1;
  const unit = (length: number) => length * iosZoomGuard;
  // Never fall through to the paper colour: that paints the text out in the same shade as the
  // patch behind it, which is how a rotated paragraph — the one case with no sampled colours —
  // disappeared the moment it was edited.
  const inkColor = edit?.color ?? '#111111';

  const written = useRef(false);
  const renderRef = useRef({ fontsByKey, runFits, font });
  renderRef.current = { fontsByKey, runFits, font };

  // The browser owns these children while the user types. They are only rewritten when the text
  // changed from somewhere else — the first render, an undo, a redo, or a revert.
  useLayoutEffect(() => {
    const element = editableRef.current;
    if (!element) return;
    if (written.current && committedText.current === text) return;
    committedText.current = text;
    written.current = true;
    const current = renderRef.current;
    // Once a paragraph has been edited its lines are the user's, so it is rewritten as plain lines
    // in the paragraph's own face rather than reasserting the PDF's original run boundaries.
    const lines: PdfTextLine[] = text === block.text
      ? block.lines
      : text.split('\n').map((line) => ({
        v: 0,
        u0: 0,
        u1: 0,
        fontSize: block.fontSize,
        runs: [{ text: line, fontKey: block.fontKey, fontSize: block.fontSize, u0: 0, u1: 0, itemIndex: -1, charStart: 0, charEnd: line.length }],
        text: line,
      }));
    writeBlockContent(
      element,
      lines,
      current.fontsByKey,
      current.font,
      text === block.text ? current.runFits : null,
    );
  }, [block, isDirty, text]);

  // Spacing corrections put every glyph of the original back where the PDF drew it. Once the
  // paragraph has been edited the line is the user's, so the corrections are dropped — by clearing
  // the styles in place rather than rebuilding, which would take the caret with it.
  useLayoutEffect(() => {
    const element = editableRef.current;
    if (!element || !isDirty) return;
    element.querySelectorAll('span').forEach((span) => {
      span.style.wordSpacing = '';
      span.style.letterSpacing = '';
    });
  }, [isDirty]);

  const handleInput = useCallback(() => {
    const element = editableRef.current;
    if (!element) return;
    if (!typingSession.current) {
      typingSession.current = true;
      onBeginChange(block.id);
    }
    const keepsNonBreakingSpace = block.text.includes('\u00a0');
    const next = readBlockText(element, keepsNonBreakingSpace);
    committedText.current = next;
    onChange(block.id, next, readStyledSegments(element, block.fontKey, keepsNonBreakingSpace));
  }, [block.id, onBeginChange, onChange]);

  return (
    <div
      className="absolute"
      style={{
        left: block.left * displayScale,
        top: (block.top - hitPadding) * displayScale,
        transform: block.angle ? `rotate(${block.angle}rad)` : undefined,
        transformOrigin: '0 0',
        // Two things decide who wins a tap where paragraphs overlap. A paragraph that has grown
        // past the space it came from drops beneath its untouched neighbours rather than
        // swallowing their taps — but only if it actually grew: an edit that kept its shape, which
        // is what a replace-all produces, has to stay as reachable as it was before. Among the
        // rest, the smaller box goes on top, because a table cell sitting inside a column's bounds
        // is the one the reader is aiming at. The whole range stays under the annotations and form
        // fields the reader placed there themselves.
        zIndex: isActive ? PARAGRAPH_ACTIVE_LAYER : hasOutgrownItsBox ? 1 : stackOrder,
      }}
    >
      {isDirty && (
        <div
          aria-hidden
          data-testid="pdf-block-patch"
          className="pointer-events-none absolute"
          style={{
            left: 0,
            top: hitPadding * displayScale,
            width: Math.max(block.width, block.measure) * displayScale,
            height: block.height * displayScale,
            backgroundColor: edit?.patch ? undefined : (edit?.patchColor ?? '#ffffff'),
            backgroundImage: edit?.patch ? `url(${edit.patch})` : undefined,
            backgroundSize: '100% 100%',
          }}
        />
      )}
      <div
        ref={editableRef}
        data-testid="pdf-text-block"
        data-block-id={block.id}
        className="chef-pdf-paragraph"
        data-dirty={isDirty ? 'true' : 'false'}
        role="textbox"
        aria-multiline="true"
        aria-label={`Paragraph on page ${block.pageIndex + 1}: ${block.text.slice(0, 80)}`}
        contentEditable={enabled ? 'plaintext-only' : false}
        suppressContentEditableWarning
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        translate="no"
        dir={block.direction}
        tabIndex={enabled ? 0 : -1}
        onFocus={() => onActivate(block.id)}
        onBlur={() => { typingSession.current = false; }}
        onInput={handleInput}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            event.currentTarget.blur();
            onActivate(null);
          }
        }}
        onPaste={(event) => {
          // Pasting rich text into a transparent overlay would smuggle markup into the PDF.
          event.preventDefault();
          const plain = event.clipboardData.getData('text/plain');
          if (plain) document.execCommand('insertText', false, plain);
        }}
        style={{
          // Positioned rather than in flow so the enlarged units below stay a drawing detail. A
          // scaled element still occupies its *unscaled* box in layout, and letting that box size
          // the wrapper would add invented empty space under every paragraph — enough of it to
          // stop the page scrolling. Both children are placed from this wrapper's origin, so the
          // wrapper collapsing to nothing changes no position.
          position: 'absolute',
          left: 0,
          top: 0,
          // Laid out in the enlarged units described at `iosZoomGuard` and scaled back here, so the
          // computed font size clears iOS's threshold while the paragraph keeps its exact size.
          transform: iosZoomGuard > 1 ? `scale(${1 / iosZoomGuard})` : undefined,
          transformOrigin: '0 0',
          minWidth: unit(Math.max(block.width, block.measure) * displayScale),
          minHeight: unit(Math.max(block.height, lineHeightPx)),
          paddingTop: unit(hitPadding * displayScale),
          paddingBottom: unit(hitPadding * displayScale),
          // An indent is a left-edge idea. Applied under centring or right alignment it adds to the
          // offset CSS is already computing, moving the text off its glyphs by half the indent.
          paddingLeft: overlayAlign === 'left' || overlayAlign === 'justify'
            ? unit(block.padLeft * displayScale) || undefined
            : undefined,
          textIndent: (overlayAlign === 'left' || overlayAlign === 'justify') && block.textIndent
            ? unit(block.textIndent * displayScale)
            : undefined,
          fontFamily: font.cssFamily,
          fontWeight: font.cssWeight,
          fontStyle: font.cssStyle,
          fontSize: `${unit(fontSizePx)}px`,
          lineHeight: `${unit(lineHeightPx)}px`,
          textAlign: overlayAlign,
          direction: block.direction,
          // Untouched paragraphs stay invisible so the canvas below is what the user reads.
          color: isDirty ? inkColor : 'transparent',
          caretColor: inkColor,
          // A paragraph only starts wrapping once it has been edited; before that its lines are
          // exactly the lines the PDF drew and must not be re-broken by browser metrics.
          whiteSpace: isDirty ? 'pre-wrap' : 'pre',
          outline: 'none',
          cursor: 'text',
          // One-finger drags still scroll and pinch still zooms; a tap places the caret and a
          // long press hands over to the platform's own selection handles.
          touchAction: 'pan-x pan-y',
          WebkitUserSelect: 'text',
          userSelect: 'text',
          boxShadow: isActive
            ? `0 0 0 ${unit(2)}px var(--accent-rest, #2563eb)`
            : undefined,
          borderRadius: unit(2),
          pointerEvents: enabled ? 'auto' : 'none',
        }}
      />
    </div>
  );
};

export const PdfTextBlockLayer: React.FC<Props> = ({
  blocks,
  fonts,
  edits,
  activeBlockId,
  displayScale,
  enabled,
  coarsePointer,
  onActivate,
  onChange,
  onBeginChange,
}) => {
  const resolvedBlocks = useResolvedBlocks(blocks, fonts, edits, coarsePointer);
  const stacked = useMemo(() => {
    const byArea = [...resolvedBlocks].sort((first, second) => second.area - first.area);
    const last = Math.max(1, byArea.length - 1);
    const order = new Map(byArea.map((entry, index) => [
      entry.block.id,
      PARAGRAPH_LAYER_BASE + Math.round((index / last) * PARAGRAPH_LAYER_SPAN),
    ]));
    return resolvedBlocks.map((resolved) => ({
      resolved,
      stackOrder: order.get(resolved.block.id) ?? PARAGRAPH_LAYER_BASE,
    }));
  }, [resolvedBlocks]);

  return (
    <>
      {stacked.map(({ resolved, stackOrder }) => (
        <BlockEditor
          key={resolved.block.id}
          resolved={{ ...resolved, stackOrder }}
          edit={edits[resolved.block.id]}
          isActive={activeBlockId === resolved.block.id}
          displayScale={displayScale}
          enabled={enabled}
          onActivate={onActivate}
          onChange={onChange}
          onBeginChange={onBeginChange}
        />
      ))}
    </>
  );
};

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')).join('')}`;

export interface BlockColors {
  ink: string;
  paper: string;
  /** True when everything that is not ink is the same colour, so a plain fill reproduces it. */
  flat: boolean;
}

/**
 * Read each paragraph's ink and paper colour straight off the rendered page.
 *
 * The caret has to be visible against the document, and an edited paragraph has to be painted out
 * in the paper's own colour rather than a guessed white, so both come from the pixels themselves.
 * One `getImageData` covers the whole page because per-block reads are the expensive part.
 */
export const samplePageBlockColors = (
  canvas: HTMLCanvasElement,
  blocks: PdfTextBlock[],
  canvasScale: number,
): Record<string, BlockColors> => {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) return {};

  let page: ImageData;
  try {
    page = context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    // A canvas tainted by a cross-origin image cannot be read. Callers fall back to defaults.
    return {};
  }

  const { data, width: pageWidth } = page;
  const colors: Record<string, BlockColors> = {};

  blocks.forEach((block) => {
    // A rotated block states its box along its own baseline, so the pixels it covers are the
    // bounding box of that rotated rectangle. Sampling it upright would read the wrong part of the
    // page — and reading nothing at all left the paragraph with no ink colour to draw with.
    const cos = Math.cos(block.angle);
    const sin = Math.sin(block.angle);
    const corners = [[0, 0], [block.width, 0], [0, block.height], [block.width, block.height]]
      .map(([u, v]) => [
        block.left + u * cos - v * sin,
        block.top + u * sin + v * cos,
      ]);
    const left = Math.max(0, Math.round(Math.min(...corners.map(([x]) => x)) * canvasScale));
    const top = Math.max(0, Math.round(Math.min(...corners.map(([, y]) => y)) * canvasScale));
    const right = Math.min(canvas.width, Math.round(Math.max(...corners.map(([x]) => x)) * canvasScale));
    const bottom = Math.min(canvas.height, Math.round(Math.max(...corners.map(([, y]) => y)) * canvasScale));
    if (right <= left || bottom <= top) return;

    // Paper is the most common colour in the paragraph's box.
    const histogram = new Map<number, number>();
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * pageWidth + x) * 4;
        const key = ((data[offset] >> 3) << 10) | ((data[offset + 1] >> 3) << 5) | (data[offset + 2] >> 3);
        histogram.set(key, (histogram.get(key) || 0) + 1);
      }
    }
    let paperKey = 0;
    let paperCount = -1;
    histogram.forEach((count, key) => {
      if (count > paperCount) {
        paperCount = count;
        paperKey = key;
      }
    });
    const paperR = ((paperKey >> 10) & 31) << 3;
    const paperG = ((paperKey >> 5) & 31) << 3;
    const paperB = (paperKey & 31) << 3;

    // Ink is the mean of the pixels furthest from the paper, which is the glyph body rather than
    // the anti-aliased edge that a simple darkest-pixel search would land on.
    let maxDistance = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * pageWidth + x) * 4;
        const distance = Math.abs(data[offset] - paperR)
          + Math.abs(data[offset + 1] - paperG)
          + Math.abs(data[offset + 2] - paperB);
        if (distance > maxDistance) maxDistance = distance;
      }
    }

    const paper = toHex(paperR, paperG, paperB);
    if (maxDistance < 60) {
      colors[block.id] = { ink: '#000000', paper, flat: true };
      return;
    }

    // Ink is everything far from the paper; anything in between is an anti-aliased glyph edge.
    // A background counts as flat only when nothing sits in the middle band, because a gradient or
    // a picture behind the text would show up exactly there.
    const threshold = maxDistance * 0.55;
    const flatBand = Math.max(24, maxDistance * 0.12);
    let inkR = 0;
    let inkG = 0;
    let inkB = 0;
    let inkCount = 0;
    let betweenCount = 0;
    let total = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * pageWidth + x) * 4;
        const distance = Math.abs(data[offset] - paperR)
          + Math.abs(data[offset + 1] - paperG)
          + Math.abs(data[offset + 2] - paperB);
        total += 1;
        if (distance < threshold) {
          if (distance > flatBand) betweenCount += 1;
          continue;
        }
        inkR += data[offset];
        inkG += data[offset + 1];
        inkB += data[offset + 2];
        inkCount += 1;
      }
    }

    colors[block.id] = {
      ink: inkCount > 0
        ? toHex(Math.round(inkR / inkCount), Math.round(inkG / inkCount), Math.round(inkB / inkCount))
        : '#000000',
      paper,
      // Glyph edges alone stay well under a tenth of a text block's area.
      flat: total > 0 && betweenCount / total < 0.1,
    };
  });

  return colors;
};

/**
 * Bring a paragraph into view by scrolling the PDF's own box, not the page around it.
 *
 * `scrollIntoView` walks every scrollable ancestor, which on this screen means the document scrolls
 * too and the toolbar the reader just used disappears off the top. Only the viewport that holds the
 * page should move.
 */
export const scrollBlockIntoViewport = (container: HTMLElement, element: HTMLElement) => {
  const view = container.getBoundingClientRect();
  const target = element.getBoundingClientRect();
  const margin = 24;

  if (target.top < view.top + margin) {
    container.scrollTop -= view.top + margin - target.top;
  } else if (target.bottom > view.bottom - margin) {
    container.scrollTop += Math.min(
      target.bottom - view.bottom + margin,
      target.top - view.top - margin,
    );
  }

  if (target.left < view.left + margin) {
    container.scrollLeft -= view.left + margin - target.left;
  } else if (target.right > view.right - margin) {
    container.scrollLeft += Math.min(
      target.right - view.right + margin,
      target.left - view.left - margin,
    );
  }
};

/**
 * Keep the paragraph being edited above the on-screen keyboard. `scrollIntoView` alone puts the
 * caret behind the keyboard on both iOS and Android, because neither shrinks the layout viewport.
 */
export const useKeyboardSafeFocus = (
  scrollContainer: HTMLElement | null,
  activeBlockId: string | null,
) => {
  useEffect(() => {
    if (!activeBlockId || !scrollContainer) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollContainer.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(activeBlockId)}"]`);
      if (!element) return;
      const container = scrollContainer.getBoundingClientRect();
      const target = element.getBoundingClientRect();
      const visualBottom = window.visualViewport
        ? Math.min(container.bottom, window.visualViewport.offsetTop + window.visualViewport.height)
        : container.bottom;
      const margin = 24;
      if (target.bottom > visualBottom - margin) {
        scrollContainer.scrollTop += target.bottom - visualBottom + margin;
      } else if (target.top < container.top + margin) {
        scrollContainer.scrollTop -= container.top + margin - target.top;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeBlockId, scrollContainer]);
};

/** Turn a character range inside a paragraph into a DOM range over its text nodes. */
export const blockRange = (element: HTMLElement, from: number, to: number): Range | null => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let start: { node: Node; offset: number } | null = null;
  let end: { node: Node; offset: number } | null = null;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!start && offset + length >= from) start = { node, offset: from - offset };
    if (!end && offset + length >= to) {
      end = { node, offset: to - offset };
      break;
    }
    offset += length;
  }
  if (!start || !end) return null;

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
};

/**
 * Put the platform's own selection on a range inside a paragraph, so a found match arrives
 * already selected and can be typed straight over.
 */
export const selectRangeInBlock = (element: HTMLElement, from: number, to: number) => {
  const range = blockRange(element, from, to);
  const selection = window.getSelection();
  if (!range || !selection) return false;
  element.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};

const FIND_HIGHLIGHT = 'pdfchef-find';

/**
 * Mark every match on the page at once.
 *
 * The paragraphs are transparent over the rendered page, so a highlight painted behind them lands
 * squarely on the words the reader is looking at. It is done with the browser's highlight registry
 * rather than by wrapping the matches in elements, because the browser owns those child nodes
 * while the user types and rewriting them would take the caret with it.
 */
export const paintFindHighlights = (ranges: Range[]) => {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightConstructor) return false;
  if (ranges.length === 0) {
    registry.delete(FIND_HIGHLIGHT);
    return true;
  }
  registry.set(FIND_HIGHLIGHT, new HighlightConstructor(...ranges));
  return true;
};

export const clearFindHighlights = () => {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  registry?.delete(FIND_HIGHLIGHT);
};
