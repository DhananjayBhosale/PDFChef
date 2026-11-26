import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls in `root` that can take focus now, in order. */
export const focusablesIn = (root: HTMLElement | null): HTMLElement[] => {
  const items: HTMLElement[] = [];
  root?.querySelectorAll<HTMLElement>(FOCUSABLE).forEach((item) => {
    if (item.getClientRects().length > 0) items.push(item);
  });
  return items;
};

/**
 * Tab and Shift+Tab stay inside `root`: from the last control to the first, and back. With
 * `pullIn`, focus that is outside `root` (or a dialog with no control) comes into it; a sheet
 * that opens a menu outside its own panel leaves that off.
 */
export const keepTabInside = (event: KeyboardEvent, root: HTMLElement | null, pullIn = false) => {
  if (event.key !== 'Tab' || !root) return;
  const items = focusablesIn(root);
  if (items.length === 0) {
    if (pullIn) { event.preventDefault(); root.focus(); }
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (pullIn && !root.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

/**
 * What every full-screen dialog does with the keyboard, in one place (the large PDF preview, the
 * large page preview and the compression preview each had a copy): focus moves in when it opens,
 * Tab stays inside, Escape closes, and focus goes back to what opened it.
 *
 * Android Back arrives as an Escape sent to the document, and only a handled one stops it from
 * leaving the tool underneath: so the listener is on the document and the event is prevented.
 */
export const useDialogFocus = (
  panel: RefObject<HTMLElement | null>,
  onClose: () => void,
  {
    initial,
    opener,
    lockScroll = true,
  }: {
    /** Takes focus on open; otherwise the first control, or the panel itself. */
    initial?: RefObject<HTMLElement | null>;
    /** Takes focus back on close; otherwise whatever had it when the dialog opened. */
    opener?: RefObject<HTMLElement | null>;
    /** Stops the page behind from scrolling. */
    lockScroll?: boolean;
  } = {},
) => {
  // Read through a ref: a new onClose each render must not run the effect again, which would
  // move focus back to the first control after every key.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = opener?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    (initial?.current || focusablesIn(panel.current)[0] || panel.current)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      keepTabInside(event, panel.current, true);
    };
    const { overflow } = document.body.style;
    if (lockScroll) document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (lockScroll) document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [initial, lockScroll, opener, panel]);
};
