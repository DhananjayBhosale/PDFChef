import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import { useZoom } from '../../hooks/useZoom';
import { ZoomControls } from '../UI/ZoomControls';
import { Portal } from '../UI/Primitives';

/**
 * A page preview shown on the whole screen, to look closely (owner 2026-11-15: Page Numbers'
 * preview could not be zoomed). Zoom with − / +, or with two fingers; the page scrolls when
 * larger than the screen. ✕, Escape or the dim area closes it, and focus goes back to the opener.
 */
export const LargePagePreview: React.FC<{
  onClose: () => void;
  /** The page's own size, for its shape. */
  width: number;
  height: number;
  opener?: React.RefObject<HTMLElement | null>;
  /** One short line under the page (Watermark: how to place the text, and where it is). */
  foot?: React.ReactNode;
  children: React.ReactNode;
}> = ({ onClose, width, height, opener, foot, children }) => {
  useI18n();
  const { zoom, zoomIn, zoomOut, resetZoom, setExactZoom } = useZoom(1, 1, 4, 0.5);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  // Two fingers also pan: the view scrolls by the move of their centre (overnight 2026-11-24, s8-03).
  // Watermark and Crop lock one-finger moves on the page for their own drags.
  const viewRef = useRef<HTMLDivElement>(null);
  const centre = useRef<{ x: number; y: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Read through a ref: a new onClose each render must not run the effect again, which moved focus
  // to Close after every key on an edge (overnight 2026-11-24, s1-03).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const back = opener?.current;
    closeRef.current?.focus();
    // Every control in the dialog, the edge handles too (s1-02), as the large PDF preview counts them.
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items: HTMLElement[] = [];
      dialogRef.current.querySelectorAll<HTMLElement>(selector).forEach((item) => {
        if (item.getClientRects().length > 0) items.push(item);
      });
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      back?.focus();
    };
  }, [opener]);

  const spread = () => {
    const [a, b]: Array<{ x: number; y: number }> = Array.from(pointers.current.values());
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const middle = () => {
    const [a, b]: Array<{ x: number; y: number }> = Array.from(pointers.current.values());
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  };
  const onPointerDown = (event: React.PointerEvent) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      pinch.current = { distance: spread(), zoom: zoomRef.current };
      centre.current = middle();
    }
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && pinch.current.distance > 0) setExactZoom(pinch.current.zoom * (spread() / pinch.current.distance));
    const next = centre.current && middle();
    if (next && centre.current && viewRef.current) {
      viewRef.current.scrollLeft -= next.x - centre.current.x;
      viewRef.current.scrollTop -= next.y - centre.current.y;
      centre.current = next;
    }
  };
  const onPointerEnd = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) {
      pinch.current = null;
      centre.current = null;
    }
  };

  const title = t('watermark-pdf.large.preview.6b8047');
  return (
    <Portal>
      <div className="tk-largepreview chef-safe-x chef-safe-bottom">
        <button type="button" className="tk-largepreview-dim" onClick={onClose} aria-label={t('watermark-pdf.close.large.preview.10665d')} tabIndex={-1} />
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} className="tk-largepreview-box">
          <div className="tk-largepreview-bar">
            <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} min={1} max={4} compact />
            <button ref={closeRef} type="button" onClick={onClose} className="tk-iconbtn chef-pressable" aria-label={t('watermark-pdf.close.large.preview.10665d')}>
              <X aria-hidden size={20} />
            </button>
          </div>
          <div
            ref={viewRef}
            className="tk-largepreview-view"
            // Capture: a page that drags something itself (Watermark's text) stops the event, and
            // two fingers must still zoom (pass 3).
            onPointerDownCapture={onPointerDown}
            onPointerMoveCapture={onPointerMove}
            onPointerUpCapture={onPointerEnd}
            onPointerCancelCapture={onPointerEnd}
          >
            <div className="tk-largepreview-page" style={{ width: `calc(min(100%, (100dvh - 7rem) * ${width / height}) * ${zoom})`, aspectRatio: `${width} / ${height}` }}>
              {children}
            </div>
          </div>
          {foot && <p className="tk-largepreview-foot">{foot}</p>}
        </div>
      </div>
    </Portal>
  );
};
