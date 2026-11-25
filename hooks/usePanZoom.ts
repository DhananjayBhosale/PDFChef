import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import { useZoom } from './useZoom';
import { usePdfPinchZoom } from './usePdfPinchZoom';
import { clampPdfPan, pdfButtonZoomAnchor, pdfPanForZoom, type PdfPan, type PdfSize } from '../services/pdfZoomGesture';

/** The picture of the page inside a frame: its largest image or canvas. */
const pageIn = (frame: HTMLElement): HTMLElement | null => {
  let best: HTMLElement | null = null;
  let area = 0;
  frame.querySelectorAll<HTMLElement>('img, canvas').forEach((node) => {
    const size = node.offsetWidth * node.offsetHeight;
    if (size > area) { area = size; best = node; }
  });
  return best;
};

/** The page's size at zoom 1: its layout box, which a transform does not change. */
const pageSize = (frame: HTMLElement): PdfSize => {
  const page = pageIn(frame);
  return page ? { width: page.offsetWidth, height: page.offsetHeight } : { width: frame.clientWidth, height: frame.clientHeight };
};

/** Whether the page drawn at `zoom` is larger than its frame on either side: only then can it move. */
const overflows = (frame: HTMLElement, zoom: number) => {
  const page = pageIn(frame);
  if (!page) return false;
  const r = frame.getBoundingClientRect();
  return page.offsetWidth * zoom > r.width + 0.5 || page.offsetHeight * zoom > r.height + 0.5;
};

/**
 * Zoom for a page that is moved rather than scrolled (`translate(pan) scale(zoom)` about the centre
 * of its frame): the preview dialog, PDF to Image and Compare's two panes. One place for what
 * each had its own copy of, and for what none had:
 * - two fingers zoom about the fingers, and Ctrl+wheel (a trackpad pinch) about the pointer, through
 *   the reader's own gesture code (`usePdfPinchZoom`);
 * - − and + keep the page's top edge, and the edge its lines start from, in view (REVIEW.md item 12);
 * - one finger, the mouse or the wheel moves the page whenever it is larger than its frame, never
 *   past its own edges (REVIEW.md fable-2 item 1: not only above 100%).
 *
 * `gestureRef` goes on the element that takes the gestures; the frames are that element itself, or
 * the elements inside it marked `data-zoom-frame` (Compare: both pages move together).
 */
export const usePanZoom = ({ min = 1, max = 2, step = 0.25 }: { min?: number; max?: number; step?: number } = {}) => {
  const { zoom, setExactZoom } = useZoom(1, min, max, step);
  const [pan, setPan] = useState<PdfPan>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const rootRef = useRef<HTMLElement | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const stopPanRef = useRef<(() => void) | null>(null);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  const frames = useCallback((): HTMLElement[] => {
    const root = rootRef.current;
    if (!root) return [];
    const marked: HTMLElement[] = [];
    root.querySelectorAll<HTMLElement>('[data-zoom-frame]').forEach((node) => marked.push(node));
    return marked.length ? marked : [root];
  }, []);

  const frameAt = useCallback((x: number, y: number) => {
    const all = frames();
    return all.find((frame) => {
      const r = frame.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }) ?? all[0] ?? null;
  }, [frames]);

  const commit = useCallback((nextZoom: number, nextPan: PdfPan) => {
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setExactZoom(nextZoom);
    setPan(nextPan);
  }, [setExactZoom]);

  /** Zooms about a point on the screen, keeping it where it is. */
  const zoomAt = useCallback((requested: number, clientX: number, clientY: number) => {
    const next = Math.min(max, Math.max(min, requested));
    const frame = frameAt(clientX, clientY);
    if (!frame) { commit(next, { x: 0, y: 0 }); return; }
    const r = frame.getBoundingClientRect();
    const pointer = { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
    const moved = pdfPanForZoom(panRef.current, pointer, zoomRef.current, next);
    commit(next, clampPdfPan(moved, pageSize(frame), { width: r.width, height: r.height }, next));
  }, [commit, frameAt, max, min]);

  // Fingers and the trackpad move the page as they go: `moving` turns any easing off meanwhile.
  const [gesturing, setGesturing] = useState(false);
  const quietRef = useRef<number | null>(null);
  const markMoving = useCallback(() => {
    setGesturing(true);
    if (quietRef.current !== null) window.clearTimeout(quietRef.current);
    quietRef.current = window.setTimeout(() => { quietRef.current = null; setGesturing(false); }, 160);
  }, []);
  const gestureZoomAt = useCallback((requested: number, clientX: number, clientY: number) => {
    markMoving();
    zoomAt(requested, clientX, clientY);
  }, [markMoving, zoomAt]);
  useEffect(() => () => { if (quietRef.current !== null) window.clearTimeout(quietRef.current); }, []);

  const setGestureViewport = usePdfPinchZoom({ zoom, setZoom: setExactZoom, min, max, zoomAt: gestureZoomAt });
  const gestureRef = useCallback((node: HTMLElement | null) => {
    rootRef.current = node;
    setRoot(node);
    setGestureViewport(node);
  }, [setGestureViewport]);

  const stepBy = useCallback((direction: 1 | -1) => {
    const current = zoomRef.current;
    const next = direction > 0
      ? Math.min(max, (Math.floor(current / step + 1e-6) + 1) * step)
      : Math.max(min, (Math.ceil(current / step - 1e-6) - 1) * step);
    const frame = frames()[0];
    const page = frame ? pageIn(frame) : null;
    if (!frame || !page) { commit(next, next <= 1 ? { x: 0, y: 0 } : panRef.current); return; }
    const view = frame.getBoundingClientRect();
    const box = page.getBoundingClientRect();
    const fromEnd = getComputedStyle(frame).direction === 'rtl';
    zoomAt(
      next,
      pdfButtonZoomAnchor({ start: box.left, end: box.right }, { start: view.left, end: view.right }, fromEnd),
      pdfButtonZoomAnchor({ start: box.top, end: box.bottom }, { start: view.top, end: view.bottom }),
    );
  }, [commit, frames, max, min, step, zoomAt]);

  const zoomIn = useCallback(() => stepBy(1), [stepBy]);
  const zoomOut = useCallback(() => stepBy(-1), [stepBy]);
  const reset = useCallback(() => {
    stopPanRef.current?.();
    commit(1, { x: 0, y: 0 });
  }, [commit]);

  // After any zoom change the page stays over its frame; once it fits again it is centred and
  // nothing is left to move.
  useEffect(() => {
    const frame = frames()[0];
    if (!frame) return;
    if (!overflows(frame, zoom)) stopPanRef.current?.();
    const r = frame.getBoundingClientRect();
    const next = clampPdfPan(panRef.current, pageSize(frame), { width: r.width, height: r.height }, zoom);
    if (next.x !== panRef.current.x || next.y !== panRef.current.y) {
      panRef.current = next;
      setPan(next);
    }
  }, [frames, zoom]);

  // Whether the page can be moved now: measured after each render (a zoom, a new page), when an
  // image inside loads, and when the frame changes size.
  const [movable, setMovable] = useState(false);
  useLayoutEffect(() => {
    setMovable(frames().some((frame) => overflows(frame, zoom)));
  });
  useEffect(() => {
    if (!root) return undefined;
    const measure = () => setMovable(frames().some((frame) => overflows(frame, zoomRef.current)));
    root.addEventListener('load', measure, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(root);
    return () => {
      root.removeEventListener('load', measure, true);
      observer?.disconnect();
    };
  }, [frames, root]);

  // The wheel (or two fingers on a trackpad) moves a page larger than its frame. At the page's
  // edge it scrolls what is around it, as before; Ctrl+wheel zooms (usePdfPinchZoom).
  useEffect(() => {
    if (!root) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || root.dataset.pdfPinching) return;
      const frame = frameAt(event.clientX, event.clientY);
      if (!frame || !overflows(frame, zoomRef.current)) return;
      const r = frame.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? r.height : 1;
      const sideways = event.shiftKey && event.deltaX === 0;
      const dx = (sideways ? event.deltaY : event.deltaX) * unit;
      const dy = (sideways ? 0 : event.deltaY) * unit;
      const next = clampPdfPan({ x: panRef.current.x - dx, y: panRef.current.y - dy }, pageSize(frame), { width: r.width, height: r.height }, zoomRef.current);
      if (Math.abs(next.x - panRef.current.x) < 0.5 && Math.abs(next.y - panRef.current.y) < 0.5) return;
      event.preventDefault();
      markMoving();
      panRef.current = next;
      setPan(next);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [frameAt, markMoving, root]);

  useEffect(() => () => stopPanRef.current?.(), []);

  /** One finger or the mouse moves a page larger than its frame; a second finger is a pinch and ends the move. */
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!event.isPrimary) { stopPanRef.current?.(); return; }
    const frame = event.currentTarget;
    if ((event.pointerType === 'mouse' && event.button !== 0) || !overflows(frame, zoomRef.current)) return;
    stopPanRef.current?.();
    const pointerId = event.pointerId;
    frame.setPointerCapture?.(pointerId);
    setPanning(true);
    const startX = event.clientX - panRef.current.x;
    const startY = event.clientY - panRef.current.y;
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId || rootRef.current?.dataset.pdfPinching) return;
      const r = frame.getBoundingClientRect();
      panRef.current = clampPdfPan({ x: move.clientX - startX, y: move.clientY - startY }, pageSize(frame), { width: r.width, height: r.height }, zoomRef.current);
      setPan(panRef.current);
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', stop);
      frame.removeEventListener('lostpointercapture', onUp);
      stopPanRef.current = null;
      if (frame.hasPointerCapture?.(pointerId)) frame.releasePointerCapture(pointerId);
      setPanning(false);
    };
    const onUp = (up: PointerEvent) => { if (up.pointerId === pointerId) stop(); };
    stopPanRef.current = stop;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', stop);
    frame.addEventListener('lostpointercapture', onUp);
  }, []);

  const transform = zoom === 1 && pan.x === 0 && pan.y === 0 ? undefined : `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  // While the page fits, one finger still scrolls what is around it; larger, it moves the page.
  const touchAction: React.CSSProperties['touchAction'] = zoom > 1 || movable ? 'none' : 'pan-x pan-y';

  return { zoom, pan, panning, movable, moving: panning || gesturing, zoomIn, zoomOut, reset, gestureRef, onPointerDown, transform, touchAction, min, max };
};
