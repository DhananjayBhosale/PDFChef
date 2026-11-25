/**
 * The page-grid fit (plan 2.4), kept free of React so unit tests can run it.
 * The grid picks the column count that makes every page as large as it can be
 * while all of them stay in view; when that would make tiles too small, it falls
 * back to a fixed tile and the canvas scrolls.
 */

export interface GridFitInput {
  /** Inner width of the canvas. */
  width: number;
  /** Inner height left for the grid. */
  height: number;
  count: number;
  /** Tile image width ÷ height. */
  aspect: number;
  wide: boolean;
  /** Smallest tile, when the tile carries controls (Create PDF's move and remove buttons). */
  minTile?: number;
  /** Height under each image (the page label, or a row of buttons). */
  labelHeight?: number;
}

export interface GridFit {
  columns: number;
  /** Tile width in px. */
  tile: number;
  gap: number;
  /** True when every page is in view without scrolling. */
  fits: boolean;
}

/** Height of a tile's page label under the image. */
export const GRID_LABEL_HEIGHT = 28;

export const computeGridFit = ({ width, height, count, aspect, wide, minTile, labelHeight = GRID_LABEL_HEIGHT }: GridFitInput): GridFit => {
  const gap = wide ? 16 : 12;
  const min = Math.max(wide ? 132 : 96, minTile ?? 0);
  const max = wide ? 420 : Math.max(0, width);
  const n = Math.max(1, Math.floor(count));
  let best: { columns: number; tile: number } | null = null;
  for (let columns = 1; columns <= Math.min(n, 12); columns += 1) {
    const rows = Math.ceil(n / columns);
    const byWidth = (width - gap * (columns - 1)) / columns;
    const byHeight = ((height - gap * (rows - 1)) / rows - labelHeight) * aspect;
    const tile = Math.min(max, byWidth, byHeight);
    if (tile >= min && (!best || tile > best.tile)) best = { columns, tile };
  }
  if (best) return { columns: best.columns, tile: Math.floor(best.tile), gap, fits: true };
  if (wide) {
    const tile = Math.max(168, min);
    const columns = Math.max(1, Math.min(n, Math.floor((width + gap) / (tile + gap))));
    return { columns, tile, gap, fits: false };
  }
  const columns = Math.max(1, Math.min(3, n, Math.floor((width + gap) / (min + gap))));
  return { columns, tile: Math.max(0, Math.floor((width - gap * (columns - 1)) / columns)), gap, fits: false };
};
