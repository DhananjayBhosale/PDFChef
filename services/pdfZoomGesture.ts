export const clampPdfZoom = (zoom: number, min: number, max: number) =>
  Math.min(max, Math.max(min, zoom));

export const pdfZoomFromWheel = (
  currentZoom: number,
  deltaY: number,
  min: number,
  max: number,
) => clampPdfZoom(currentZoom * Math.exp(-deltaY * 0.01), min, max);

export const pdfZoomFromPinch = (
  startZoom: number,
  startDistance: number,
  currentDistance: number,
  min: number,
  max: number,
) => {
  if (startDistance <= 0 || currentDistance <= 0) return clampPdfZoom(startZoom, min, max);
  return clampPdfZoom(startZoom * (currentDistance / startDistance), min, max);
};

export const pdfZoomScrollOffset = (
  currentScroll: number,
  pointerOffset: number,
  previousZoom: number,
  nextZoom: number,
) => {
  if (previousZoom <= 0 || previousZoom === nextZoom) return currentScroll;
  return Math.max(0, (currentScroll + pointerOffset) * (nextZoom / previousZoom) - pointerOffset);
};

export const pdfPageFromScrollBoundary = ({
  currentPage,
  pageCount,
  zoom,
  deltaX,
  deltaY,
  atStart,
  atEnd,
}: {
  currentPage: number;
  pageCount: number;
  zoom: number;
  deltaX: number;
  deltaY: number;
  atStart: boolean;
  atEnd: boolean;
}) => {
  if (zoom <= 1 || pageCount < 2 || Math.abs(deltaY) < 4 || Math.abs(deltaY) <= Math.abs(deltaX)) {
    return currentPage;
  }
  if (deltaY > 0 && atEnd) return Math.min(pageCount - 1, currentPage + 1);
  if (deltaY < 0 && atStart) return Math.max(0, currentPage - 1);
  return currentPage;
};

/** How far a finger has to travel, in CSS pixels, before a swipe at the page's edge turns the page. */
export const PAGE_SWIPE_MIN_PX = 56;

/**
 * Turn the page with one finger. At fit zoom the page never scrolls, so a vertical swipe never
 * reached the next page. A swipe turns it only when it started with the page already at that edge
 * and moved mostly up or down, so an ordinary scroll is never taken over.
 */
export const pdfPageFromSwipe = ({
  currentPage,
  pageCount,
  deltaX,
  deltaY,
  startedAtStart,
  startedAtEnd,
}: {
  currentPage: number;
  pageCount: number;
  /** Finger travel; negative deltaY is a swipe up, towards the next page. */
  deltaX: number;
  deltaY: number;
  startedAtStart: boolean;
  startedAtEnd: boolean;
}) => {
  if (pageCount < 2 || Math.abs(deltaY) < PAGE_SWIPE_MIN_PX || Math.abs(deltaY) <= 2 * Math.abs(deltaX)) {
    return currentPage;
  }
  if (deltaY < 0 && startedAtEnd) return Math.min(pageCount - 1, currentPage + 1);
  if (deltaY > 0 && startedAtStart) return Math.max(0, currentPage - 1);
  return currentPage;
};
