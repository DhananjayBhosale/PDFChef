import { useLayoutEffect, useRef } from 'react';

/**
 * Sets `data-long` on the returned element while the name inside it (`selector`) needs more
 * lines than its two-line clamp gives, so the layout can give the name a line of its own
 * (research r2, mobile-04). Measured in the ordinary layout, with the attribute removed, each
 * time the element's width, the name or the fonts change; a wider screen puts the name back.
 */
export const useLongName = <T extends HTMLElement>(
  selector: string,
  name: string | undefined,
  /** Whether the name is too long where it is now; by default, when it needs more lines than it has. */
  tooLong: (text: HTMLElement) => boolean = (text) => text.scrollHeight > text.clientHeight + 1,
) => {
  const ref = useRef<T>(null);
  const tooLongRef = useRef(tooLong);
  tooLongRef.current = tooLong;
  useLayoutEffect(() => {
    const box = ref.current;
    const text = box?.querySelector<HTMLElement>(selector);
    if (!box || !text) return undefined;
    let width = -1;
    const check = (force = false) => {
      if (!force && box.clientWidth === width) return;
      width = box.clientWidth;
      box.removeAttribute('data-long');
      if (tooLongRef.current(text)) box.setAttribute('data-long', '');
    };
    check(true);
    let live = true;
    void document.fonts?.ready.then(() => { if (live) check(true); });
    if (typeof ResizeObserver === 'undefined') return () => { live = false; };
    const observer = new ResizeObserver(() => check());
    observer.observe(box);
    return () => { live = false; observer.disconnect(); };
  }, [selector, name]);
  return ref;
};
