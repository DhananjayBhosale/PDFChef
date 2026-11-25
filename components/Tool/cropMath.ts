/**
 * The arithmetic of the crop frame (plan 2.13), kept apart from the component so it can
 * be tested without a browser. A margin is the distance of an edge from the page edge as
 * a percent of the page's width (left, right) or height (top, bottom), a whole number
 * from 0 to 40 (today's limits: at least 20% of the page always remains).
 */

export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type CropEdge = keyof CropMargins;
export type CropCorner = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft';
export type CropHandle = CropEdge | CropCorner;

export const CROP_MIN = 0;
export const CROP_MAX = 40;
export const CROP_EDGES: readonly CropEdge[] = ['top', 'right', 'bottom', 'left'];

export const clampMargin = (value: number) =>
  Math.max(CROP_MIN, Math.min(CROP_MAX, Math.round(Number.isFinite(value) ? value : 0)));

/** The edges a handle moves: an edge moves itself, a corner its two edges. */
export const handleEdges = (handle: CropHandle): CropEdge[] => {
  switch (handle) {
    case 'topLeft': return ['top', 'left'];
    case 'topRight': return ['top', 'right'];
    case 'bottomRight': return ['bottom', 'right'];
    case 'bottomLeft': return ['bottom', 'left'];
    default: return [handle];
  }
};

/**
 * The margins after dragging `handle` by (dx, dy) screen pixels over a page drawn
 * `width` × `height` pixels, from the margins the drag started with. Left and right are
 * sides of the page, so they do not mirror in right-to-left languages.
 */
export const dragMargins = (
  start: CropMargins,
  handle: CropHandle,
  dx: number,
  dy: number,
  width: number,
  height: number,
): CropMargins => {
  const next = { ...start };
  const dxPercent = width > 0 ? (dx / width) * 100 : 0;
  const dyPercent = height > 0 ? (dy / height) * 100 : 0;
  for (const edge of handleEdges(handle)) {
    if (edge === 'top') next.top = clampMargin(start.top + dyPercent);
    if (edge === 'bottom') next.bottom = clampMargin(start.bottom - dyPercent);
    if (edge === 'left') next.left = clampMargin(start.left + dxPercent);
    if (edge === 'right') next.right = clampMargin(start.right - dxPercent);
  }
  return next;
};

/** A slider key on an edge handle: arrows by 1, Shift + arrow by 5, Home and End to the limits. */
export const keyMargin = (value: number, key: string, shift = false): number | null => {
  const step = shift ? 5 : 1;
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight': return clampMargin(value + step);
    case 'ArrowDown':
    case 'ArrowLeft': return clampMargin(value - step);
    case 'PageUp': return clampMargin(value + 5);
    case 'PageDown': return clampMargin(value - 5);
    case 'Home': return CROP_MIN;
    case 'End': return CROP_MAX;
    default: return null;
  }
};

/** Which sentence the four numbers make (plan 2.13). */
export const cropForm = (margins: CropMargins): 'none' | 'same' | 'each' => {
  const values = CROP_EDGES.map((edge) => margins[edge]);
  if (values.every((value) => value === 0)) return 'none';
  return values.every((value) => value === values[0]) ? 'same' : 'each';
};
