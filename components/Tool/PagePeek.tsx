import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, Maximize2 } from 'lucide-react';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import { PDFPreviewModal } from '../UI/PDFPreviewModal';

/**
 * Opening a page large, wherever a page is shown small (pass 5, REVIEW.md point 3: "PDFs are always
 * zoomable"). The apps' WebView does not zoom the screen, so every small page needs its own way to
 * the large preview, the one Reorder's eye opens (`PDFPreviewModal`: − and +, two fingers, Ctrl+wheel,
 * drag to move, and the file's other pages):
 * - `PeekButton`: Reorder's eye, for a page whose own tap already does something (select, mark, drag);
 * - `usePinchToOpen`: two fingers spread on a small page open it large, as a pinch would zoom it;
 * - `usePagePreview`: the preview's state and the dialog, so a tool adds one hook, not a copy.
 */

const PINCH_OPENS_AT = 1.15;

const spread = (touches: TouchList) => {
  const a = touches.item(0);
  const b = touches.item(1);
  return a && b ? Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) : 0;
};

/**
 * Two fingers spreading on the element call `onOpen` once, with the element that was under them
 * when they landed. The gesture is the page's (no zoom of the whole screen), and the tap that may
 * follow the fingers lifting is dropped, so it cannot close the preview it opened or select a page.
 */
export const usePinchToOpen = (onOpen: (target: Element | null) => void) => {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!node) return undefined;
    let startSpread = 0;
    let target: Element | null = null;
    let fired = false;
    let quietUntil = 0;
    const open = (at: Element | null) => {
      if (fired) return;
      fired = true;
      quietUntil = performance.now() + 450;
      onOpenRef.current(at);
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      startSpread = spread(event.touches);
      fired = false;
      const a = event.touches.item(0)!;
      const b = event.touches.item(1)!;
      target = document.elementFromPoint((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !startSpread) return;
      event.preventDefault();
      if (spread(event.touches) / startSpread >= PINCH_OPENS_AT) open(target);
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) startSpread = 0;
    };
    // Safari's own pinch events: kept from zooming the screen, and read the same way.
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      fired = false;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale: number; clientX?: number; clientY?: number };
      if (gesture.scale >= PINCH_OPENS_AT) {
        open(gesture.clientX !== undefined && gesture.clientY !== undefined ? document.elementFromPoint(gesture.clientX, gesture.clientY) : target);
      }
    };
    const dropTap = (event: MouseEvent) => {
      if (performance.now() >= quietUntil) return;
      event.preventDefault();
      event.stopPropagation();
    };
    node.addEventListener('touchstart', onTouchStart, { passive: false });
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('touchend', onTouchEnd, { passive: true });
    node.addEventListener('touchcancel', onTouchEnd, { passive: true });
    node.addEventListener('gesturestart', onGestureStart, { passive: false });
    node.addEventListener('gesturechange', onGestureChange, { passive: false });
    window.addEventListener('click', dropTap, true);
    return () => {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
      node.removeEventListener('gesturestart', onGestureStart);
      node.removeEventListener('gesturechange', onGestureChange);
      window.removeEventListener('click', dropTap, true);
    };
  }, [node]);

  return setNode;
};

/** Watermark's expand button, for a live preview: opens the large preview (`LargePagePreview`). */
export const ExpandButton = React.forwardRef<HTMLButtonElement, { onClick: () => void; disabled?: boolean }>(({ onClick, disabled }, ref) => {
  useI18n();
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="tk-iconbtn chef-pressable"
      aria-label={t('watermark-pdf.large.preview.6b8047')}
      title={t('watermark-pdf.large.preview.6b8047')}
    >
      <Maximize2 aria-hidden size={18} />
    </button>
  );
});
ExpandButton.displayName = 'ExpandButton';

/** Reorder's eye: opens one page large. Sits on the page, beside whatever a tap on the page does. */
export const PeekButton: React.FC<{ page: number; onOpen: () => void; className?: string; disabled?: boolean; label?: string }> = ({ page, onOpen, className, disabled, label }) => {
  useI18n();
  return (
    <button
      type="button"
      // The page under it may be a drag handle or a toggle: the eye is its own control.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
      disabled={disabled}
      aria-label={label ?? t('reorder-pdf.preview.page.ffb7e0', { v0: page })}
      className={`tk-peek chef-pressable${className ? ` ${className}` : ''}`}
    >
      <Eye aria-hidden size={14} />
    </button>
  );
};

/**
 * The large preview of a PDF's pages for one tool: `open(index)` shows it, `modal` is the dialog to
 * render, `pinchRef` goes on the element whose pages two fingers open (each page carries
 * `data-peek-page="<index>"`), and `peek(index)` is that page's eye.
 */
export const usePagePreview = (file: File | null | undefined, name?: string) => {
  const [index, setIndex] = useState<number | null>(null);
  const open = useCallback((page: number) => setIndex(page), []);
  const close = useCallback(() => setIndex(null), []);
  const pinchRef = usePinchToOpen((target) => {
    const page = Number(target?.closest('[data-peek-page]')?.getAttribute('data-peek-page'));
    if (Number.isInteger(page) && page >= 0) open(page);
  });
  useEffect(() => { setIndex(null); }, [file]);
  const modal = file && index !== null
    ? <PDFPreviewModal file={file} pageIndex={index} pageLabel={name ?? file.name} onClose={close} />
    : null;
  const peek = (page: number, options: { className?: string; disabled?: boolean } = {}) => (
    <PeekButton page={page + 1} onOpen={() => open(page)} className={options.className} disabled={options.disabled} />
  );
  return { open, close, modal, pinchRef, peek };
};
