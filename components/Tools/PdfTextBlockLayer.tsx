import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  blockStyledSegments,
  planBlockEdit,
  preserveStyledTextEdit,
  segmentInks,
  splitByInk,
  styledTextEqual,
  type StyledSegment,
} from '../../services/pdfBlockEditPlanning';
export type { StyledSegment } from '../../services/pdfBlockEditPlanning';
import type { PdfTextAlign, PdfTextBlock, PdfTextLine } from '../../services/pdfTextBlocks';
import {
  capturePdfFocusAnchor,
  pdfCaretScroll,
  pdfEditingVisibleRect,
  pdfFocusAnchorScroll,
  pdfParagraphStartScroll,
  visualViewportClientRect,
  type PdfFocusAnchor,
} from '../../services/pdfEditingFocus';
import { normalizeParagraphLineBreaks } from '../../services/pdfParagraphLayout';
import { glyphInkColors, sampleGlyphInks } from '../../services/pdfGlyphInks';
import { highlightPatches, measureTextHighlight, type TextHighlight } from '../../services/pdfTextHighlight';
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
  /** Indexes in `text` of the breaks that only mark the PDF's wrapping (see `softLineBreaks`). */
  softBreaks?: number[];
  /** Text-free render of the block's area, used to hide the original text once it changes. */
  patch?: string;
  patchColor?: string;
  patchFlat?: boolean;
  /** False while the paragraph's page has never been rendered, so its colours are assumed. */
  sampledColors?: boolean;
  /** The reader chose `color` for the whole paragraph, even if it matches the page's own. */
  recolored?: boolean;
  reflowing: boolean;
}

/**
 * Whether an edit asks for a look of its own beyond its words. The colour sampled off the page is
 * recorded on every edit, so it counts only when the reader picked it or it differs.
 */
export const hasParagraphRestyle = (edit: BlockEditState | undefined, ink: string | undefined) => Boolean(edit) && (
  Boolean(edit!.fontOverride?.klass) || edit!.fontOverride?.bold != null || edit!.fontOverride?.italic != null
  || edit!.fontSize !== undefined || edit!.recolored === true
  || (edit!.color !== undefined && edit!.color !== ink)
);

/** A settled layout from the same plan used by Save. Editing keeps its explicit newlines. */
export interface BlockTextPreview {
  text: string;
  reflow: boolean;
  width: number;
  height: number;
  pieces: Array<{
    text: string; x: number; y: number; width: number; lineIndex: number;
    fontSize: number; font: ResolvedFont;
    /** The piece split by colour, where it mixes colours or differs from the paragraph's. */
    spans?: Array<{ text: string; color?: string }>;
  }>;
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
  previews?: Record<string, BlockTextPreview>;
  /** Colours read from the rendered page, so an edited paragraph keeps each word's colour. */
  colors?: Record<string, { glyphs?: string[][] }>;
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
        reason: t('font.missingInformation'),
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

    // A paragraph given a new face is redrawn in it, so it no longer has to fill the original
    // run widths. Squeezing bold text into the regular face's width runs the words together.
    const restyled = Boolean(edit?.fontOverride?.klass)
      || edit?.fontOverride?.bold != null || edit?.fontOverride?.italic != null;
    const runFits = block.lines.map((line: PdfTextLine) => line.runs.map((run) => (restyled
      ? { wordSpacing: 0, letterSpacing: 0 }
      : fitTextMetrics(run.text, run.u1 - run.u0, fontsByKey.get(run.fontKey) ?? font, run.fontSize))));

    const reproducesItsWidth = restyled || block.lines.every((line: PdfTextLine, lineIndex) => (
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
  const text = normalizeParagraphLineBreaks(element.innerText).replace(/\n$/, '');
  return allowNonBreakingSpace ? text : text.replace(/\u00a0/g, ' ');
};

/** Colours stay hidden with the rest of the text until the paragraph is changed. */
const paintInk = (span: HTMLElement, color: string) => {
  span.dataset.color = color;
  span.style.color = `var(--pdf-hidden-ink, ${color})`;
};

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
  baseFontSize: number,
  inks?: Array<Array<string | undefined> | undefined>,
) => {
  const fragment = document.createDocumentFragment();
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) fragment.append(document.createTextNode('\n'));
    let offset = 0;
    line.runs.forEach((run, runIndex) => {
      const span = document.createElement('span');
      // A run can mix colours. Each colour gets its own inner span, so the run span keeps the
      // face and position while a red word inside it stays red and what is typed there with it.
      const parts = splitByInk(run.text, inks?.[lineIndex]?.slice(offset, offset + run.text.length));
      offset += run.text.length;
      if (parts.length === 1 && parts[0].color) {
        paintInk(span, parts[0].color);
        span.textContent = run.text;
      } else if (parts.some((part) => part.color)) {
        span.append(...parts.map((part) => {
          if (!part.color) return document.createTextNode(part.text);
          const inner = document.createElement('span');
          paintInk(inner, part.color);
          inner.textContent = part.text;
          return inner;
        }));
      } else {
        span.textContent = run.text;
      }
      span.dataset.font = run.fontKey;
      span.dataset.fontSize = String(run.fontSize);
      if (fits) {
        span.dataset.pdfLine = String(lineIndex);
        span.dataset.pdfRun = String(runIndex);
      }
      const font = fonts.get(run.fontKey) ?? fallback;
      span.style.fontFamily = font.cssFamily;
      span.style.fontWeight = font.cssWeight;
      span.style.fontStyle = font.cssStyle;
      span.style.fontSize = `${run.fontSize / baseFontSize}em`;
      const fit = fits?.[lineIndex]?.[runIndex];
      if (fit?.wordSpacing) span.style.wordSpacing = `${fit.wordSpacing / run.fontSize}em`;
      if (fit?.letterSpacing) span.style.letterSpacing = `${fit.letterSpacing / run.fontSize}em`;
      fragment.append(span);
    });
  });
  // Chromium needs a final sentinel to place a caret on an intentional empty last line.
  if (lines.length > 1 && lines[lines.length - 1].text === '') fragment.append(document.createTextNode('\n'));
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
  fallbackFontSize?: number,
): StyledSegment[][] => {
  const lines: StyledSegment[][] = [[]];
  const append = (raw: string, fontKey: string, fontSize?: number, color?: string) => {
    const normalized = normalizeParagraphLineBreaks(raw);
    const text = allowNonBreakingSpace ? normalized : normalized.replace(/\u00a0/g, ' ');
    if (!text) return;
    text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (!part) return;
      const current = lines[lines.length - 1];
      const last = current[current.length - 1];
      if (last && last.fontKey === fontKey && last.fontSize === fontSize && last.color === color) last.text += part;
      else current.push(color ? { text: part, fontKey, fontSize, color } : { text: part, fontKey, fontSize });
    });
  };

  const walk = (node: Node, inheritedKey: string, inheritedSize?: number, inheritedColor?: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent ?? '', inheritedKey, inheritedSize, inheritedColor);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      lines.push([]);
      return;
    }
    const key = node.dataset.font || inheritedKey;
    const size = Number(node.dataset.fontSize);
    const color = node.dataset.color || inheritedColor;
    node.childNodes.forEach((child) => walk(child, key, size > 0 ? size : inheritedSize, color));
  };

  element.childNodes.forEach((child) => walk(child, fallbackKey, fallbackFontSize));
  // Remove exactly one caret sentinel, never the intentional blank lines before it.
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
};

const hasDamagedStyleSpans = (element: HTMLElement) => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const run = node.parentElement?.closest('[data-font]');
    if (node.textContent?.trim() && (!run || run === element || !element.contains(run))) return true;
  }
  const runs = [...element.querySelectorAll<HTMLElement>('[data-pdf-line][data-pdf-run]')];
  const keys = runs.map(run => `${run.dataset.pdfLine}:${run.dataset.pdfRun}`);
  return new Set(keys).size !== keys.length;
};

const BlockEditor: React.FC<{
  resolved: ResolvedBlock & { stackOrder: number };
  edit: BlockEditState | undefined;
  preview?: BlockTextPreview;
  inks?: string[][];
  highlight?: TextHighlight;
  isActive: boolean;
  displayScale: number;
  enabled: boolean;
  onActivate: (blockId: string | null) => void;
  onChange: (blockId: string, text: string, segments: StyledSegment[][]) => void;
  onBeginChange: (blockId: string) => void;
}> = ({ resolved, edit, preview, inks, highlight, isActive, displayScale, enabled, onActivate, onChange, onBeginChange }) => {
  useI18n();
  const { block, font, fontsByKey, runFits, overlayAlign, hitPadding, stackOrder } = resolved;
  const editableRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const committedText = useRef(edit?.text ?? block.text);
  const committedStyles = useRef(edit?.segments ?? blockStyledSegments(block, inks));
  // The segments and colours the editable last showed. Anything else arriving — undo, replace, a
  // colour picked in the inspector, or the page's colours being read — is written in afresh.
  const shownSegments = useRef(edit?.segments);
  const shownInks = useRef(inks);
  const hasEdit = Boolean(edit);
  const inputRange = useRef<{ start: number; end: number } | null>(null);
  const styleRepairNeeded = useRef(false);
  const typingSession = useRef(false);
  const isDirty = Boolean(edit) && ((edit?.text ?? block.text) !== block.text
    || Boolean(edit?.fontOverride) || edit?.fontSize !== undefined
    || (preview?.text === edit?.text && preview?.reflow === true));
  const text = edit?.text ?? block.text;
  const currentPreview = preview?.text === text ? preview : undefined;
  const showPreview = !focused && Boolean(currentPreview);
  const hasOutgrownItsBox = isDirty && (text.split('\n').length > block.lines.length
    || (currentPreview?.height ?? 0) > block.height + 1);
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

  // A text diff cannot identify the selected occurrence when a paragraph repeats the same
  // letters. Capture the browser's actual replacement range before it mutates the run spans.
  useEffect(() => {
    const element = editableRef.current;
    if (!element) return;
    const beforeInput = (event: InputEvent) => {
      inputRange.current = null;
      if (event.inputType.startsWith('history')) return;
      const selection = window.getSelection();
      const range = event.getTargetRanges?.()[0]
        ?? (selection?.rangeCount ? selection.getRangeAt(0) : null);
      if (!range || !element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
      const prefix = document.createRange();
      prefix.selectNodeContents(element);
      prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length;
      prefix.setEnd(range.endContainer, range.endOffset);
      inputRange.current = { start, end: prefix.toString().length };
    };
    element.addEventListener('beforeinput', beforeInput);
    return () => element.removeEventListener('beforeinput', beforeInput);
  }, []);

  // Keep ordinary typing in browser-owned nodes. Rebuild only external changes or a run whose
  // wrapper Chromium discarded during a full selection replacement, retaining the caret below.
  useLayoutEffect(() => {
    const element = editableRef.current;
    if (!element) return;
    const externalChange = !written.current || committedText.current !== text
      || shownSegments.current !== edit?.segments || (!hasEdit && shownInks.current !== inks);
    if (!externalChange) {
      if (composing || text.split('\n').length !== block.lines.length) return;
      if (!styleRepairNeeded.current && !hasDamagedStyleSpans(element)) return;
    }
    committedText.current = text;
    if (externalChange) { typingSession.current = false; inputRange.current = null; }
    written.current = true;
    const current = renderRef.current;
    const selection = window.getSelection();
    const offsetOf = (node: Node | null, offset: number) => {
      if (!node || !element.contains(node)) return null;
      const range = document.createRange();
      range.selectNodeContents(element);
      range.setEnd(node, offset);
      return range.toString().length;
    };
    const anchor = selection ? offsetOf(selection.anchorNode, selection.anchorOffset) : null;
    const focus = selection ? offsetOf(selection.focusNode, selection.focusOffset) : null;
    // Restore original run styles and spacing only where the edit still maps to those runs.
    const plan = planBlockEdit(block, text, { segments: edit?.segments });
    const replacements = plan.mode === 'direct'
      ? new Map(plan.runEdits.map((run) => [run.itemIndex, run.replacementText]))
      : new Map<number, string>();
    const direct = plan.mode === 'unchanged' || plan.mode === 'direct';
    const lines: PdfTextLine[] = direct
      ? block.lines.map((line) => ({ ...line, runs: line.runs.map((run) => ({
        ...run, text: replacements.get(run.itemIndex) ?? run.text,
      })) }))
      : (edit?.segments ?? text.split('\n').map((line) => [{ text: line, fontKey: block.fontKey }]))
        .map((segments) => ({
          v: 0, u0: 0, u1: 0, fontSize: block.fontSize,
          runs: segments.map((segment) => ({
            ...segment, fontSize: segment.fontSize ?? block.fontSize, u0: 0, u1: 0, itemIndex: -1,
            charStart: 0, charEnd: segment.text.length,
          })),
          text: segments.map((segment) => segment.text).join(''),
        }));
    writeBlockContent(element, lines, current.fontsByKey, current.font,
      direct ? current.runFits : null, block.fontSize,
      (edit?.segments ?? blockStyledSegments(block, inks)).map(segmentInks));
    committedStyles.current = readStyledSegments(element, block.fontKey, block.text.includes('\u00a0'), block.fontSize);
    shownSegments.current = edit?.segments;
    shownInks.current = inks;
    styleRepairNeeded.current = false;
    // Only while the paragraph has focus: a selection placed inside it takes focus back, and on
    // a phone the keyboard with it, after a swatch tap that had deliberately left it closed.
    if (anchor !== null && focus !== null && selection && document.activeElement === element) {
      const a = blockRange(element, Math.min(anchor, text.length), Math.min(anchor, text.length));
      const f = blockRange(element, Math.min(focus, text.length), Math.min(focus, text.length));
      if (a && f) selection.setBaseAndExtent(a.startContainer, a.startOffset, f.startContainer, f.startOffset);
    }
    if (!externalChange) {
      // The discarded wrapper may have been the only record of an edited bold/italic run.
      shownSegments.current = committedStyles.current;
      onChange(block.id, text, committedStyles.current);
    }
  }, [block, text, edit?.segments, hasEdit, inks, composing, onChange]);

  // PDF rows need not have a uniform pitch (a wrapped table cell is a common example).
  // Move the existing inline runs onto their real baselines without replacing text nodes or
  // taking selection/IME away from the browser. Font ascent also differs from the CSS line box.
  const keepsOriginalRows = text.split('\n').length === block.lines.length && edit?.fontSize === undefined;
  useLayoutEffect(() => {
    const element = editableRef.current;
    if (!element || composing) return;
    // Rotated text is already laid out in its rotated wrapper; screen-axis rectangles cannot
    // calibrate that reading space.
    if (Math.abs(block.angle) > 0.02) return;
    const spans = [...element.querySelectorAll<HTMLElement>('[data-pdf-line][data-pdf-run]')];
    if (!keepsOriginalRows) {
      spans.forEach(span => { span.style.left = ''; span.style.top = ''; });
      return;
    }
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const scale = box.width / Number.parseFloat(style.width);
    if (!(scale > 0)) return;
    const unit = Number.parseFloat(style.fontSize) / block.fontSize;
    const u0 = Math.min(...block.lines.map(line => line.u0));
    // Read every rectangle first, then apply offsets, avoiding a layout per run while typing.
    const offsets = spans.map(span => {
      const line = block.lines[Number(span.dataset.pdfLine)];
      const run = line?.runs[Number(span.dataset.pdfRun)];
      if (!run) return null;
      const font = getComputedStyle(span);
      const size = Number.parseFloat(font.fontSize);
      context.font = `${font.fontStyle} ${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
      const ascent = context.measureText('Hg').fontBoundingBoxAscent;
      if (!Number.isFinite(ascent)) return null;
      const rect = span.getBoundingClientRect();
      const x = box.left + (run.u0 - u0) * unit * scale;
      const baseline = box.top + (hitPadding + block.ascent + line.v - block.lines[0].v) * unit * scale;
      return { span,
        left: ((Number.parseFloat(font.left) || 0) + (x - rect.left) / scale) / size,
        top: ((Number.parseFloat(font.top) || 0) + (baseline - rect.top) / scale - ascent) / size,
      };
    });
    offsets.forEach(offset => {
      if (!offset) return;
      offset.span.style.position = 'relative';
      offset.span.style.left = `${offset.left}em`;
      offset.span.style.top = `${offset.top}em`;
    });
  }, [block, text, displayScale, keepsOriginalRows, hitPadding, showPreview, composing]);

  // The selection frame describes the text. The larger invisible target still accepts a finger
  // above or below it. Reading CSS sizes here also lets the frame grow with unwrapped typing.
  useLayoutEffect(() => {
    const element = editableRef.current;
    const outline = outlineRef.current;
    if (!element || !outline) return;
    const style = getComputedStyle(element);
    outline.style.width = `${Number.parseFloat(style.width) / iosZoomGuard}px`;
    outline.style.height = `${keepsOriginalRows ? block.height * displayScale
      : Number.parseFloat(style.height) / iosZoomGuard - hitPadding * displayScale * 2}px`;
  }, [isActive, text, showPreview, currentPreview, block.height, displayScale, iosZoomGuard, keepsOriginalRows, hitPadding]);

  const handleInput = useCallback(() => {
    const element = editableRef.current;
    if (!element) return;
    if (!typingSession.current) {
      typingSession.current = true;
      onBeginChange(block.id);
    }
    const keepsNonBreakingSpace = block.text.includes('\u00a0');
    const next = readBlockText(element, keepsNonBreakingSpace);
    const domSegments = readStyledSegments(element, block.fontKey, keepsNonBreakingSpace, block.fontSize);
    const segments = inputRange.current || hasDamagedStyleSpans(element)
      ? preserveStyledTextEdit(committedStyles.current, next,
        { text: '', fontKey: block.fontKey, fontSize: block.fontSize }, inputRange.current)
      : domSegments;
    inputRange.current = null;
    styleRepairNeeded.current = !styledTextEqual(domSegments, segments, block.fontSize);
    committedText.current = next;
    committedStyles.current = segments;
    shownSegments.current = segments;
    onChange(block.id, next, segments);
  }, [block, onBeginChange, onChange]);

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
      {isDirty && edit?.patch && (
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
      {isDirty && !edit?.patch && (
        <svg aria-hidden="true" data-testid="pdf-block-patch" className="pointer-events-none absolute"
          width={block.width * displayScale} height={block.height * displayScale}
          viewBox={`0 0 ${block.width} ${block.height}`} overflow="visible"
          style={{ left: 0, top: hitPadding * displayScale }}>
          {block.lines.flatMap((line, lineIndex) => line.runs.map((run, runIndex) => (
            <rect key={`${lineIndex}-${runIndex}`}
              x={run.u0 - Math.min(...block.lines.map(row => row.u0))}
              y={line.v - block.lines[0].v + block.ascent - run.fontSize * 0.82}
              width={Math.max(0, run.u1 - run.u0)} height={run.fontSize * 1.08}
              fill={edit?.patchColor ?? '#ffffff'} />
          )))}
        </svg>
      )}
      {/* While typing, the highlight a longer paragraph grows into, under the words. It follows the
          settled layout once that has caught up and still keeps the typed lines; after Done the
          preview draws it with its words. */}
      {focused && highlight && currentPreview
        && new Set(currentPreview.pieces.map((piece) => piece.lineIndex)).size <= text.split('\n').length && (
        <svg aria-hidden="true" className="pointer-events-none absolute" overflow="visible"
          width={currentPreview.width * displayScale} height={currentPreview.height * displayScale}
          viewBox={`0 0 ${currentPreview.width} ${currentPreview.height}`}
          style={{ left: 0, top: hitPadding * displayScale }}>
          {highlightPatches(highlight, currentPreview.pieces).map((box, index) => (
            <rect key={index} data-testid="pdf-block-highlight" x={box.left} y={box.top}
              width={box.right - box.left} height={box.bottom - box.top} fill={highlight.color} />
          ))}
        </svg>
      )}
      <div
        ref={editableRef}
        data-testid="pdf-text-block"
        data-block-id={block.id}
        className="chef-pdf-paragraph"
        data-dirty={isDirty ? 'true' : 'false'}
        role="textbox"
        aria-multiline="true"
        aria-label={t("pdf-text-block-layer.paragraph.on.page.b6bd50", { v0: block.pageIndex + 1, v1: block.text.slice(0, 80) })}
        contentEditable={enabled ? 'plaintext-only' : false}
        suppressContentEditableWarning
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        translate="no"
        dir={block.direction}
        tabIndex={enabled ? 0 : -1}
        onFocus={() => { setFocused(true); onActivate(block.id); }}
        onBlur={() => { typingSession.current = false; setFocused(false); }}
        onInput={handleInput}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
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
          height: keepsOriginalRows ? unit((block.height + hitPadding * 2) * displayScale) : undefined,
          minHeight: unit(((showPreview ? currentPreview!.height : block.height) + hitPadding * 2) * displayScale),
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
          // Untouched paragraphs stay invisible so the canvas below is what the user reads, and
          // so do the words that carry their own colour.
          color: isDirty && !showPreview ? inkColor : 'transparent',
          ['--pdf-hidden-ink' as string]: isDirty && !showPreview ? undefined : 'transparent',
          caretColor: inkColor,
          // Only the explicit line model may introduce a line. The focused native surface stays
          // intact; after blur the settled export layout supplies the rendered preview.
          whiteSpace: 'pre',
          overflowWrap: 'normal',
          wordBreak: 'normal',
          outline: 'none',
          cursor: 'text',
          // One-finger drags still scroll and pinch still zooms; a tap places the caret and a
          // long press hands over to the platform's own selection handles.
          touchAction: 'pan-x pan-y',
          WebkitUserSelect: 'text',
          userSelect: 'text',
          borderRadius: unit(2),
          pointerEvents: enabled ? 'auto' : 'none',
        }}
      />
      {isActive && (
        <div ref={outlineRef} aria-hidden="true" data-testid="pdf-block-outline" className="pointer-events-none absolute"
          style={{ left: 0, top: hitPadding * displayScale, borderRadius: 2,
            boxShadow: '0 0 0 2px var(--accent-rest, #2563eb)' }} />
      )}
      {showPreview && currentPreview && (
        <svg aria-hidden="true" data-testid="pdf-block-preview" data-preview-block-id={block.id}
          className="pointer-events-none absolute" overflow="visible"
          width={currentPreview.width * displayScale} height={currentPreview.height * displayScale}
          viewBox={`0 0 ${currentPreview.width} ${currentPreview.height}`}
          style={{ left: 0, top: hitPadding * displayScale }}>
          {highlight && highlightPatches(highlight, currentPreview.pieces).map((box, index) => (
            <rect key={`highlight-${index}`} data-testid="pdf-block-highlight" x={box.left} y={box.top}
              width={box.right - box.left} height={box.bottom - box.top} fill={highlight.color} />
          ))}
          {currentPreview.pieces.map((piece, index) => (
            <text key={index} data-preview-line={piece.lineIndex}
              direction={block.direction}
              x={piece.x + (block.direction === 'rtl' ? piece.width : 0)} y={piece.y} textLength={piece.width > 0 ? piece.width : undefined}
              lengthAdjust="spacingAndGlyphs" xmlSpace="preserve" fill={inkColor}
              fontFamily={piece.font.cssFamily} fontSize={piece.fontSize}
              fontWeight={piece.font.cssWeight} fontStyle={piece.font.cssStyle}>
              {piece.spans
                ? piece.spans.map((span, spanIndex) => <tspan key={spanIndex} fill={span.color}>{span.text}</tspan>)
                : piece.text}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
};

export const PdfTextBlockLayer: React.FC<Props> = ({
  blocks,
  fonts,
  edits,
  previews,
  colors,
  activeBlockId,
  displayScale,
  enabled,
  coarsePointer,
  onActivate,
  onChange,
  onBeginChange,
}) => {
  useI18n();
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
          preview={previews?.[resolved.block.id]}
          inks={colors?.[resolved.block.id]?.glyphs}
          highlight={colors?.[resolved.block.id]?.highlight}
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
  /** The colour of each character of each line, only when the paragraph mixes colours. */
  glyphs?: string[][];
  /** The highlight the whole paragraph sits on, when it does. */
  highlight?: TextHighlight;
}

let glyphMeasure: CanvasRenderingContext2D | null | undefined;
const glyphWidth = (character: string) => {
  if (glyphMeasure === undefined) {
    glyphMeasure = document.createElement('canvas').getContext('2d');
    if (glyphMeasure) glyphMeasure.font = '100px Helvetica, Arial, sans-serif';
  }
  return glyphMeasure?.measureText(character).width ?? 50;
};

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

    // PDF.js joins runs that share a font whatever their colour, so a red word inside a black
    // sentence is only visible here. Rotated text keeps the paragraph's single colour.
    const inks = Math.abs(block.angle) <= 0.02
      ? sampleGlyphInks(data, pageWidth, canvas.height, block, canvasScale, [paperR, paperG, paperB], glyphWidth)
      : null;
    const glyphs = inks ? glyphInkColors(inks, [paperR, paperG, paperB]) : null;
    const highlight = inks ? measureTextHighlight(data, pageWidth, canvas.height, block, canvasScale, inks) : null;
    colors[block.id] = {
      ink: glyphs?.dominant ?? (inkCount > 0
        ? toHex(Math.round(inkR / inkCount), Math.round(inkG / inkCount), Math.round(inkB / inkCount))
        : '#000000'),
      paper,
      // Glyph edges alone stay well under a tenth of a text block's area.
      flat: total > 0 && betweenCount / total < 0.1,
      ...(glyphs?.lines ? { glyphs: glyphs.lines } : {}),
      ...(highlight ? { highlight } : {}),
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
export const scrollBlockIntoViewport = (
  container: HTMLElement,
  element: Pick<Element, 'getBoundingClientRect'>,
  /** Where a bar drawn over the bottom of the viewport starts. */
  coveredFrom?: number,
) => {
  const box = container.getBoundingClientRect();
  const view = { top: box.top, left: box.left, right: box.right,
    bottom: coveredFrom && coveredFrom > box.top + 48 ? Math.min(box.bottom, coveredFrom) : box.bottom };
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

const focusedCaretRect = (element: HTMLElement): DOMRect | null => {
  // A text box's or form field's caret lives inside its control, out of reach of the document selection.
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
    return element.getBoundingClientRect();
  }
  const selection = window.getSelection();
  const range = document.createRange();
  if (selection?.focusNode && element.contains(selection.focusNode)) {
    range.setStart(selection.focusNode, selection.focusOffset);
    range.collapse(true);
    const caret = range.getBoundingClientRect();
    if (caret.height > 0) return caret;
  }
  const firstText = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
  if (!firstText) return null;
  range.setStart(firstText, 0);
  range.setEnd(firstText, Math.min(1, firstText.textContent?.length ?? 0));
  return range.getBoundingClientRect();
};

/**
 * Preserve the selected PDF point through focus zoom, then keep its caret between the fixed
 * header and the bar above the keyboard. Follows the paragraph being edited, or else the text box
 * being typed into.
 */
export const useKeyboardSafeFocus = (
  scrollContainer: HTMLElement | null,
  activeBlockId: string | null,
  zoom: number,
  bottomBar: HTMLElement | null,
  header: HTMLElement | null,
  selectedTextId: string | null,
  /** A phone zooms a focused form field to the screen's width; it is then shown whole. */
  wholeFields = false,
) => {
  const preserved = useRef<{ element: HTMLElement; page: HTMLElement; anchor: PdfFocusAnchor } | null>(null);
  const scheduleRef = useRef<((restoreAnchor: boolean) => void) | null>(null);
  const captureFocusAnchor = useCallback((element: HTMLElement, point?: { x: number; y: number }) => {
    // A pointer capture happens before focus, when the platform has not placed the caret yet.
    // Keep that exact point when onFocus subsequently asks to magnify the paragraph.
    if (!point && preserved.current?.element === element) return;
    const page = element.closest<HTMLElement>('[data-pdf-page]');
    if (!page) return;
    const target = focusedCaretRect(element) ?? element.getBoundingClientRect();
    preserved.current = {
      element,
      page,
      anchor: capturePdfFocusAnchor(page.getBoundingClientRect(), point ?? { x: target.left, y: target.top }),
    };
    scheduleRef.current?.(true);
  }, []);

  // A form field takes focus without the editor choosing it. It is followed the same way.
  const [focusedField, setFocusedField] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!scrollContainer) return undefined;
    const focused = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      setFocusedField(target.matches('[data-field-name]:is(textarea, select, input:not([type="checkbox"], [type="radio"]))') ? target : null);
    };
    const blurred = () => setFocusedField(null);
    scrollContainer.addEventListener('focusin', focused);
    scrollContainer.addEventListener('focusout', blurred);
    return () => {
      scrollContainer.removeEventListener('focusin', focused);
      scrollContainer.removeEventListener('focusout', blurred);
    };
  }, [scrollContainer]);

  useLayoutEffect(() => {
    const selector = activeBlockId
      ? `[data-block-id="${CSS.escape(activeBlockId)}"]`
      : selectedTextId ? `[data-element-id="${CSS.escape(selectedTextId)}"]` : null;
    if (!scrollContainer) return undefined;
    const element = selector ? scrollContainer.querySelector<HTMLElement>(selector) : focusedField;
    if (!element) return undefined;
    const originalPadding = scrollContainer.style.paddingBottom;
    const basePadding = Number.parseFloat(window.getComputedStyle(scrollContainer).paddingBottom) || 0;
    let frame = 0;
    let restorePending = false;
    const keepVisible = () => {
      frame = 0;
      // On a phone the paragraph is typed into a field in the dock. The page then keeps the whole
      // paragraph in view rather than a caret it does not hold.
      const active = document.activeElement as HTMLElement | null;
      const docked = Boolean(element.dataset.blockId) && active?.dataset.fieldFor === element.dataset.blockId;
      if ((active !== element && !docked) || scrollContainer.dataset.pdfPinching === 'true') return;
      const container = scrollContainer.getBoundingClientRect();
      const screen = visualViewportClientRect(window.visualViewport, { x: window.scrollX, y: window.scrollY },
        { width: window.innerWidth, height: window.innerHeight });
      const visible = pdfEditingVisibleRect(container, screen, header?.getBoundingClientRect() ?? null, bottomBar?.getBoundingClientRect() ?? null);
      if (!visible) return;
      // The last line on a page still needs room to move above an overlapping inspector.
      scrollContainer.style.paddingBottom = `${basePadding + Math.max(0, container.bottom - visible.bottom)}px`;
      const saved = preserved.current;
      if (restorePending && saved?.element === element) {
        const delta = pdfFocusAnchorScroll(saved.anchor, saved.page.getBoundingClientRect(), visible);
        scrollContainer.scrollLeft += delta.left;
        scrollContainer.scrollTop += delta.top;
        // Zooming around the tapped word pushes the start of each line off the left edge.
        const anchorCaret = focusedCaretRect(element);
        if (anchorCaret) {
          scrollContainer.scrollLeft += pdfParagraphStartScroll(element.getBoundingClientRect(), anchorCaret, visible);
        }
      }
      restorePending = false;
      if (docked || (wholeFields && !selector)) {
        // The whole width centred, or its line starts when it is wider; as much height as fits,
        // from its first line.
        const paragraph = element.getBoundingClientRect();
        const width = visible.right - visible.left;
        scrollContainer.scrollLeft += paragraph.right - paragraph.left <= width
          ? (paragraph.left + paragraph.right - visible.left - visible.right) / 2
          : paragraph.left - visible.left - 12;
        const margin = Math.min(24, Math.max(0, (visible.bottom - visible.top) / 4));
        scrollContainer.scrollTop += paragraph.top < visible.top + margin
          ? paragraph.top - visible.top - margin
          : Math.max(0, Math.min(paragraph.bottom - visible.bottom + margin, paragraph.top - visible.top - margin));
        return;
      }
      const caret = focusedCaretRect(element);
      if (!caret) return;
      const delta = pdfCaretScroll(caret, visible);
      scrollContainer.scrollLeft += delta.left;
      scrollContainer.scrollTop += delta.top;
    };
    const schedule = (restoreAnchor = false) => {
      restorePending ||= restoreAnchor;
      if (!frame) frame = window.requestAnimationFrame(keepVisible);
    };
    const resized = () => schedule(true);
    const selectionChanged = () => schedule();
    const releaseAnchor = () => { preserved.current = null; };
    const typed = () => { releaseAnchor(); schedule(); };
    scheduleRef.current = schedule;
    schedule(true);
    window.visualViewport?.addEventListener('resize', resized);
    window.visualViewport?.addEventListener('scroll', resized);
    document.addEventListener('selectionchange', selectionChanged);
    // A new text box takes focus after this effect has run.
    element.addEventListener('focus', selectionChanged);
    element.addEventListener('input', typed);
    element.addEventListener('blur', releaseAnchor);
    scrollContainer.addEventListener('touchmove', releaseAnchor, { passive: true });
    scrollContainer.addEventListener('wheel', releaseAnchor, { passive: true });
    const observer = new ResizeObserver(resized);
    observer.observe(scrollContainer);
    if (bottomBar) observer.observe(bottomBar);
    return () => {
      window.cancelAnimationFrame(frame);
      scheduleRef.current = null;
      observer.disconnect();
      scrollContainer.style.paddingBottom = originalPadding;
      window.visualViewport?.removeEventListener('resize', resized);
      window.visualViewport?.removeEventListener('scroll', resized);
      document.removeEventListener('selectionchange', selectionChanged);
      element.removeEventListener('focus', selectionChanged);
      element.removeEventListener('input', typed);
      element.removeEventListener('blur', releaseAnchor);
      scrollContainer.removeEventListener('touchmove', releaseAnchor);
      scrollContainer.removeEventListener('wheel', releaseAnchor);
    };
  }, [activeBlockId, bottomBar, focusedField, header, scrollContainer, selectedTextId, wholeFields, zoom]);
  return captureFocusAnchor;
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

const FIND_HIGHLIGHT = 'pdfchef-find';
const FIND_CURRENT_HIGHLIGHT = 'pdfchef-find-current';

/**
 * Mark every match on the page at once.
 *
 * The paragraphs are transparent over the rendered page, so a highlight painted behind them lands
 * squarely on the words the reader is looking at. It is done with the browser's highlight registry
 * rather than by wrapping the matches in elements, because the browser owns those child nodes
 * while the user types and rewriting them would take the caret with it.
 */
export const paintFindHighlights = (ranges: Range[], current?: Range | null) => {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightConstructor) return false;
  if (ranges.length === 0) registry.delete(FIND_HIGHLIGHT);
  else registry.set(FIND_HIGHLIGHT, new HighlightConstructor(...ranges));
  // The match Next and Previous land on is marked apart from the rest, because stepping no longer
  // moves the caret there: the find field keeps it, so the keyboard keeps typing the search.
  if (current) registry.set(FIND_CURRENT_HIGHLIGHT, new HighlightConstructor(current));
  else registry.delete(FIND_CURRENT_HIGHLIGHT);
  return true;
};

export const clearFindHighlights = () => {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  registry?.delete(FIND_HIGHLIGHT);
  registry?.delete(FIND_CURRENT_HIGHLIGHT);
};
