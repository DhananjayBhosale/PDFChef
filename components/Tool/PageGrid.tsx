import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useWide } from '../../hooks/useMediaQuery';

/**
 * Page grids that fill the canvas (plan 2.4). The grid measures the room it has and
 * picks the column count that makes every page as large as it can be while all of
 * them stay in view; when that would make tiles too small, it falls back to a fixed
 * tile and the canvas scrolls.
 */

import { computeGridFit, type GridFit } from './gridFit.ts';

export { computeGridFit, GRID_LABEL_HEIGHT, type GridFit, type GridFitInput } from './gridFit.ts';

/** Measures the grid's own width and the canvas height left under the grid's top. */
export const usePageGridFit = (
  ref: React.RefObject<HTMLElement>,
  count: number,
  aspect = 0.75,
  sizing: { minTile?: number; labelHeight?: number } = {},
): GridFit | null => {
  const { minTile, labelHeight } = sizing;
  const wide = useWide();
  const [fit, setFit] = useState<GridFit | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || count < 1) { setFit(null); return undefined; }
    const canvas = node.closest<HTMLElement>('.tk-canvas') ?? node.parentElement ?? node;
    const measure = () => {
      const style = getComputedStyle(canvas);
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      const canvasBox = canvas.getBoundingClientRect();
      const top = node.getBoundingClientRect().top - canvasBox.top + canvas.scrollTop;
      const next = computeGridFit({
        width: node.clientWidth,
        height: canvas.clientHeight - top - paddingBottom,
        count,
        aspect,
        wide,
        minTile,
        labelHeight,
      });
      setFit((current) => (current && current.columns === next.columns && current.tile === next.tile && current.gap === next.gap ? current : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(canvas);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [ref, count, aspect, wide, minTile, labelHeight]);
  return fit;
};

/** A grid of page tiles laid out by `usePageGridFit`; the tiles take `--tile-w`. */
export const PageGrid: React.FC<{
  count: number;
  aspect?: number;
  children: React.ReactNode;
  className?: string;
  /** Reports the tile width, so a tool can ask for sharper thumbnails. */
  onFit?: (fit: GridFit) => void;
  /** Gives the tile container a role (Reorder Pages is a list of draggable items). */
  role?: React.AriaRole;
  /** Smallest tile and the height under each image, for tiles that carry controls. */
  minTile?: number;
  labelHeight?: number;
  /** Also given the grid's box: two fingers spread on a page open it large (usePagePreview's pinchRef). */
  gestureRef?: (node: HTMLDivElement | null) => void;
}> = ({ count, aspect = 0.75, children, className, onFit, role, minTile, labelHeight, gestureRef }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const setBox = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    gestureRef?.(node);
  }, [gestureRef]);
  const fit = usePageGridFit(ref, count, aspect, { minTile, labelHeight });
  // Reported again when the tool's handler changes (it may only now know the page size).
  useLayoutEffect(() => {
    if (fit) onFit?.(fit);
  }, [fit, onFit]);
  const style = fit ? ({
    '--tile-w': `${fit.tile}px`,
    '--grid-cols': String(fit.columns),
    '--grid-gap': `${fit.gap}px`,
  } as React.CSSProperties) : undefined;
  return (
    <div ref={setBox} className={`tk-pagegrid-box${className ? ` ${className}` : ''}`}>
      <div className="tk-pagegrid" role={role} data-fit={fit ? (fit.fits ? 'fill' : 'scroll') : undefined} style={style}>
        {children}
      </div>
    </div>
  );
};
