import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hides the reader's floating zoom while the pages scroll down (plan 2.3, phones only).
 *
 * - Hides after 24 px of downward scroll in `[data-testid="pdf-zoom-viewport"]`; shows
 *   again after 12 px upward. Sideways panning does not count.
 * - Always shown within 8 px of the top or the bottom, while a zoom control has focus,
 *   while `keepShown` is true (Search is open), and for 2 s after the zoom changes;
 *   scroll caused by a zoom change is ignored for 300 ms.
 * - Hidden means moved down and faded; the controls stay in the page and in the
 *   accessibility tree (not `inert`, not `display: none`). `show` brings them back, and
 *   the caller calls it when keyboard or screen-reader focus enters the controls.
 */

export const HIDE_AFTER = 24;
export const SHOW_AFTER = 12;
const EDGE = 8;
const ZOOM_GRACE = 300;
const ZOOM_SHOW = 2000;

export const useHideOnScroll = (
  container: React.RefObject<HTMLElement>,
  floating: React.RefObject<HTMLElement>,
  { enabled, zoom, keepShown, ready }: { enabled: boolean; zoom: number; keepShown: boolean; ready: unknown },
) => {
  const [hidden, setHidden] = useState(false);
  const zoomChangedAt = useRef(-Infinity);
  const firstZoom = useRef(true);

  useEffect(() => {
    if (firstZoom.current) { firstZoom.current = false; return; }
    zoomChangedAt.current = performance.now();
    setHidden(false);
  }, [zoom]);

  useEffect(() => { if (keepShown || !enabled) setHidden(false); }, [keepShown, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const scroller = container.current?.querySelector<HTMLElement>('[data-testid="pdf-zoom-viewport"]');
    if (!scroller) return undefined;
    let lastTop = scroller.scrollTop;
    let lastLeft = scroller.scrollLeft;
    let travel = 0;
    const onScroll = () => {
      const top = scroller.scrollTop;
      const left = scroller.scrollLeft;
      const dy = top - lastTop;
      const sideways = left !== lastLeft && dy === 0;
      lastTop = top;
      lastLeft = left;
      if (sideways) return;
      const since = performance.now() - zoomChangedAt.current;
      if (since < ZOOM_GRACE) { travel = 0; return; }
      const nearEdge = top <= EDGE || top + scroller.clientHeight >= scroller.scrollHeight - EDGE;
      const focused = floating.current?.contains(document.activeElement) ?? false;
      if (nearEdge || focused || keepShown || since < ZOOM_SHOW) {
        travel = 0;
        setHidden(false);
        return;
      }
      if (dy === 0) return;
      if (Math.sign(dy) !== Math.sign(travel)) travel = 0;
      travel += dy;
      if (travel >= HIDE_AFTER) setHidden(true);
      else if (travel <= -SHOW_AFTER) setHidden(false);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [container, floating, enabled, keepShown, ready]);

  const show = useCallback(() => setHidden(false), []);
  return { hidden: enabled && hidden, show };
};
