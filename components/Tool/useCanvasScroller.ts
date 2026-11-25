import { useCallback, useRef } from 'react';

/**
 * The tool screen's canvas is the element that scrolls (the page itself never moves),
 * so a drag that auto-scrolls needs it by reference. Put `attach` on any element inside
 * the body and pass `ref` to `useDragReorder({ scrollContainerRef })`.
 */
export const useCanvasScroller = () => {
  const ref = useRef<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    ref.current = node ? node.closest<HTMLElement>('.tk-canvas') : null;
  }, []);
  return { ref, attach };
};
