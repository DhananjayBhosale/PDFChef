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

/** Reveal the active caret, without trying to fit the entire paragraph above the keyboard. */
export const pdfCaretScroll = (caret: FocusRect, visible: FocusRect) => ({
  left: caret.left < inside(caret.left, visible.left, visible.right)
    ? caret.left - inside(caret.left, visible.left, visible.right)
    : Math.max(0, caret.right - inside(caret.right, visible.left, visible.right)),
  top: caret.top < inside(caret.top, visible.top, visible.bottom)
    ? caret.top - inside(caret.top, visible.top, visible.bottom)
    : Math.max(0, caret.bottom - inside(caret.bottom, visible.top, visible.bottom)),
});
