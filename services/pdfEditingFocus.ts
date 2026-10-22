export interface FocusRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PdfFocusAnchor {
  /** Coordinates on the PDF page, unaffected by editor zoom or scroll. */
  pageX: number;
  pageY: number;
  clientX: number;
  clientY: number;
}

const inside = (value: number, start: number, end: number) => {
  const margin = Math.min(24, Math.max(0, (end - start) / 4));
  return Math.max(start + margin, Math.min(end - margin, value));
};

export const capturePdfFocusAnchor = (
  page: FocusRect,
  point: { x: number; y: number },
): PdfFocusAnchor => ({
  pageX: (point.x - page.left) / Math.max(1, page.right - page.left),
  pageY: (point.y - page.top) / Math.max(1, page.bottom - page.top),
  clientX: point.x,
  clientY: point.y,
});

/** Scroll deltas only: the PDF text's position and geometry never change. */
export const pdfFocusAnchorScroll = (anchor: PdfFocusAnchor, page: FocusRect, visible: FocusRect) => ({
  left: page.left + anchor.pageX * (page.right - page.left) - inside(anchor.clientX, visible.left, visible.right),
  top: page.top + anchor.pageY * (page.bottom - page.top) - inside(anchor.clientY, visible.top, visible.bottom),
});

/**
 * The part of the PDF box the reader can actually see while typing: inside the visual viewport,
 * below the fixed header and above the fixed bottom bar. Either bar covers the box whenever the
 * document itself has scrolled or the visual viewport has moved, so neither can be assumed away.
 */
export const pdfEditingVisibleRect = (
  container: FocusRect,
  viewport: FocusRect,
  header: FocusRect | null,
  bottomBar: FocusRect | null,
): FocusRect | null => {
  const visible = {
    left: Math.max(container.left, viewport.left),
    top: Math.max(container.top, viewport.top),
    right: Math.min(container.right, viewport.right),
    bottom: Math.min(container.bottom, viewport.bottom),
  };
  const spans = (bar: FocusRect) => bar.right > visible.left && bar.left < visible.right;
  if (header && spans(header) && header.top < visible.bottom && header.bottom > visible.top) {
    visible.top = header.bottom;
  }
  if (bottomBar && spans(bottomBar) && bottomBar.bottom > visible.top) {
    visible.bottom = Math.min(visible.bottom, bottomBar.top);
  }
  return visible.bottom > visible.top && visible.right > visible.left ? visible : null;
};

/**
 * After focus zoom, bring a paragraph's cut-off line start back into view: all of it when the
 * paragraph fits, otherwise as much as keeps the caret on screen. Only ever scrolls towards the
 * start, and leaves a start that is already on screen alone.
 */
export const pdfParagraphStartScroll = (block: FocusRect, caret: FocusRect, visible: FocusRect) => {
  if (block.left >= visible.left) return 0;
  const margin = Math.min(24, Math.max(0, (visible.right - visible.left) / 4));
  return Math.min(0, Math.max(block.left - (visible.left + margin), caret.right - (visible.right - margin)));
};

/** Reveal the active caret, without trying to fit the entire paragraph above the keyboard. */
export const pdfCaretScroll = (caret: FocusRect, visible: FocusRect) => ({
  left: caret.left < inside(caret.left, visible.left, visible.right)
    ? caret.left - inside(caret.left, visible.left, visible.right)
    : Math.max(0, caret.right - inside(caret.right, visible.left, visible.right)),
  top: caret.top < inside(caret.top, visible.top, visible.bottom)
    ? caret.top - inside(caret.top, visible.top, visible.bottom)
    : Math.max(0, caret.bottom - inside(caret.bottom, visible.top, visible.bottom)),
});
