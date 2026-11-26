import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  clampPdfZoom,
  pdfZoomFromPinch,
  pdfZoomFromWheel,
  pdfZoomScrollOffset,
} from '../services/pdfZoomGesture';
import { MAX_ZOOM } from './useZoom';

export type PdfZoomAt = (zoom: number, clientX: number, clientY: number) => void;

interface PdfPinchZoomOptions {
  zoom: number;
  setZoom: (zoom: number) => void;
  min?: number;
  max?: number;
  /**
   * A page that is not scrolled but moved (`translate` and `scale`, usePanZoom) takes the zoom and
   * its point itself; the gestures are the same.
   */
  zoomAt?: PdfZoomAt;
}

interface WebKitGestureEvent extends Event {
  clientX?: number;
  clientY?: number;
  scale: number;
}

const touchDistance = (touches: TouchList) => {
  const first = touches.item(0);
  const second = touches.item(1);
  if (!first || !second) return 0;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
};

const touchMidpoint = (touches: TouchList) => {
  const first = touches.item(0);
  const second = touches.item(1);
  if (!first || !second) return null;
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2,
  };
};

export const usePdfPinchZoom = ({ zoom, setZoom, min = 0.5, max = MAX_ZOOM, zoomAt }: PdfPinchZoomOptions) => {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const zoomRef = useRef(zoom);
  const pinchStartRef = useRef({ distance: 0, zoom });
  const gestureStartZoomRef = useRef(zoom);
  const frameRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
  const suppressClicksUntilRef = useRef(0);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // The page grows in the render that follows setZoom. Scrolling before then is clamped to the
  // old, smaller page, which slid the point under the pointer away (to the left edge at 4x). So
  // the offset waits for the larger page: right after that render commits, or on a later frame
  // when the zoom reaches the page through a child that renders afterwards.
  const applyPendingScroll = useCallback(() => {
    const pending = pendingScrollRef.current;
    if (!viewport || !pending) return true;
    viewport.scrollLeft = pending.left;
    viewport.scrollTop = pending.top;
    const reached = Math.abs(viewport.scrollLeft - pending.left) <= 1 && Math.abs(viewport.scrollTop - pending.top) <= 1;
    if (reached) pendingScrollRef.current = null;
    return reached;
  }, [viewport]);

  useLayoutEffect(() => {
    applyPendingScroll();
  }, [applyPendingScroll, zoom]);

  const applyZoom = useCallback((requestedZoom: number, clientX: number, clientY: number) => {
    if (!viewport) return;
    const previousZoom = zoomRef.current;
    const nextZoom = clampPdfZoom(requestedZoom, min, max);
    if (Math.abs(nextZoom - previousZoom) < 0.001) return;
    if (zoomAt) {
      zoomRef.current = nextZoom;
      zoomAt(nextZoom, clientX, clientY);
      return;
    }

    const bounds = viewport.getBoundingClientRect();
    const pointerX = Math.max(0, Math.min(bounds.width, clientX - bounds.left));
    const pointerY = Math.max(0, Math.min(bounds.height, clientY - bounds.top));
    const nextScrollLeft = pdfZoomScrollOffset(viewport.scrollLeft, pointerX, previousZoom, nextZoom);
    const nextScrollTop = pdfZoomScrollOffset(viewport.scrollTop, pointerY, previousZoom, nextZoom);

    zoomRef.current = nextZoom;
    pendingScrollRef.current = { left: nextScrollLeft, top: nextScrollTop };
    setZoom(nextZoom);

    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    // A few frames at most: an offset the page can never reach (a pointer at its far edge) stops here.
    let framesLeft = 8;
    const settle = () => {
      frameRef.current = null;
      if (applyPendingScroll() || --framesLeft <= 0) {
        pendingScrollRef.current = null;
        return;
      }
      frameRef.current = requestAnimationFrame(settle);
    };
    frameRef.current = requestAnimationFrame(settle);
  }, [applyPendingScroll, max, min, setZoom, viewport, zoomAt]);

  useEffect(() => {
    if (!viewport) return undefined;

    const markPinching = () => {
      suppressClicksUntilRef.current = performance.now() + 250;
      viewport.dataset.pdfPinching = 'true';
    };
    const finishPinching = () => {
      window.setTimeout(() => {
        if (performance.now() >= suppressClicksUntilRef.current) {
          delete viewport.dataset.pdfPinching;
        }
      }, 260);
    };
    // A plain scroll or a one-finger pan after a zoom is the reader taking over: the zoom's
    // anchor stops chasing its offset. Otherwise an offset the page cannot reach (a pointer
    // near the far edge) is retried for several frames and undoes the reader's first scroll.
    const releaseAnchor = () => {
      pendingScrollRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        releaseAnchor();
        return;
      }
      if (event.deltaY === 0) return;
      event.preventDefault();
      applyZoom(pdfZoomFromWheel(zoomRef.current, event.deltaY, min, max), event.clientX, event.clientY);
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) releaseAnchor();
      if (event.touches.length !== 2) return;
      event.preventDefault();
      pinchStartRef.current = { distance: touchDistance(event.touches), zoom: zoomRef.current };
      markPinching();
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const midpoint = touchMidpoint(event.touches);
      if (!midpoint) return;
      event.preventDefault();
      markPinching();
      applyZoom(
        pdfZoomFromPinch(
          pinchStartRef.current.zoom,
          pinchStartRef.current.distance,
          touchDistance(event.touches),
          min,
          max,
        ),
        midpoint.x,
        midpoint.y,
      );
    };
    const handleTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) finishPinching();
    };
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartZoomRef.current = zoomRef.current;
      markPinching();
    };
    const handleGestureChange = (event: Event) => {
      const gesture = event as WebKitGestureEvent;
      event.preventDefault();
      markPinching();
      const bounds = viewport.getBoundingClientRect();
      applyZoom(
        gestureStartZoomRef.current * gesture.scale,
        gesture.clientX ?? bounds.left + bounds.width / 2,
        gesture.clientY ?? bounds.top + bounds.height / 2,
      );
    };
    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
      finishPinching();
    };
    const suppressPostPinchClick = (event: MouseEvent) => {
      if (performance.now() >= suppressClicksUntilRef.current) return;
      event.preventDefault();
      event.stopPropagation();
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    viewport.addEventListener('touchstart', handleTouchStart, { passive: false });
    viewport.addEventListener('touchmove', handleTouchMove, { passive: false });
    viewport.addEventListener('touchend', handleTouchEnd, { passive: true });
    viewport.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    viewport.addEventListener('gesturestart', handleGestureStart, { passive: false });
    viewport.addEventListener('gesturechange', handleGestureChange, { passive: false });
    viewport.addEventListener('gestureend', handleGestureEnd, { passive: false });
    viewport.addEventListener('click', suppressPostPinchClick, true);

    return () => {
      viewport.removeEventListener('wheel', handleWheel);
      viewport.removeEventListener('touchstart', handleTouchStart);
      viewport.removeEventListener('touchmove', handleTouchMove);
      viewport.removeEventListener('touchend', handleTouchEnd);
      viewport.removeEventListener('touchcancel', handleTouchEnd);
      viewport.removeEventListener('gesturestart', handleGestureStart);
      viewport.removeEventListener('gesturechange', handleGestureChange);
      viewport.removeEventListener('gestureend', handleGestureEnd);
      viewport.removeEventListener('click', suppressPostPinchClick, true);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      delete viewport.dataset.pdfPinching;
    };
  }, [applyZoom, max, min, viewport]);

  return setViewport;
};
