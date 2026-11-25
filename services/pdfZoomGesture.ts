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

export interface PdfPan { x: number; y: number }
export interface PdfSize { width: number; height: number }

/**
 * A page drawn with `translate(pan) scale(zoom)` about the centre of its frame: the pan that keeps
 * the point under `pointer` (measured from the frame's centre) where it is while the zoom changes.
 * A pinch zooms about the fingers, a Ctrl+wheel about the pointer.
 */
export const pdfPanForZoom = (pan: PdfPan, pointer: PdfPan, previousZoom: number, nextZoom: number): PdfPan => {
  if (previousZoom <= 0 || previousZoom === nextZoom) return pan;
  const ratio = nextZoom / previousZoom;
  return { x: pointer.x - ratio * (pointer.x - pan.x), y: pointer.y - ratio * (pointer.y - pan.y) };
};

/**
 * Keeps a zoomed page over its frame: no pan past the page's own edges, and none on an axis where
 * the page is no larger than the frame (it stays centred there). `page` is its size at zoom 1.
 */
export const clampPdfPan = (pan: PdfPan, page: PdfSize, frame: PdfSize, zoom: number): PdfPan => {
  const maxX = Math.max(0, (page.width * zoom - frame.width) / 2);
  const maxY = Math.max(0, (page.height * zoom - frame.height) / 2);
  return { x: Math.min(maxX, Math.max(-maxX, pan.x)), y: Math.min(maxY, Math.max(-maxY, pan.y)) };
};

/**
 * Where a zoom button zooms about, on one axis (REVIEW.md item 12: zooming about the middle showed
 * the empty middle of the page). While the page's top edge, or the edge its lines start from, is in
 * view, that edge stays where it is, so the first lines stay on screen; once the person has moved
 * away from it, the zoom keeps the middle of what they are looking at. `fromEnd` is the line-start
 * edge of a right-to-left interface. Client coordinates.
 */
export const pdfButtonZoomAnchor = (
  page: { start: number; end: number },
  view: { start: number; end: number },
  fromEnd = false,
) => {
  if (fromEnd) return page.end <= view.end + 1 ? Math.max(view.start, page.end) : (view.start + view.end) / 2;
  return page.start >= view.start - 1 ? Math.min(view.end, page.start) : (view.start + view.end) / 2;
};
