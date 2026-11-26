/**
 * Sharp zoom: the arithmetic of the detail layer (`components/Tool/SharpPageLayer.tsx`).
 *
 * A page preview is drawn once and then enlarged with CSS, so past about 300% it is soft. Drawing
 * the whole page again cannot fix that: an A4 page at 400% on a phone is 27 million pixels, over
 * the 16.7 million one canvas may hold on iOS. So only the part of the page that is on screen is
 * drawn again, at the screen's own resolution, into one canvas laid over the page. That canvas is
 * never larger than the screen, whatever the zoom.
 *
 * No DOM here: rectangles in, a plan out.
 */

export interface SharpZoomBudget {
  /** The most backing pixels all detail canvases on screen may hold together. */
  maxPixels: number;
  /** The longest side one detail canvas may have. */
  maxSide: number;
}

/** A rectangle in CSS pixels. */
export interface SharpRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SharpPlan {
  /** The part of the page to draw, in CSS pixels from the page's own top left corner. */
  clip: { x: number; y: number; width: number; height: number };
  /** The part of the page in sight, before the margin, in the same coordinates. */
  visible: { x: number; y: number; width: number; height: number };
  /** Backing pixels per CSS pixel of the detail canvas. */
  pixelRatio: number;
  /** The detail canvas's backing size. */
  width: number;
  height: number;
  /** The page's width on screen when this was planned. */
  pageWidth: number;
}

/** Phones and tablets: 6 million pixels is 24 MB. Far under the iOS limit of 16,777,216 per canvas. */
export const SHARP_ZOOM_PHONE: SharpZoomBudget = { maxPixels: 6_000_000, maxSide: 4096 };
/** Desktop: 12 million pixels is 48 MB. */
export const SHARP_ZOOM_DESKTOP: SharpZoomBudget = { maxPixels: 12_000_000, maxSide: 8192 };
/** How long zoom and scroll must rest before the detail is drawn. */
export const SHARP_ZOOM_SETTLE_MS = 180;

/** A screen denser than this gains nothing the eye can see. */
const MAX_PIXEL_RATIO = 3;
/** The page must need this much more than its base drawing before the detail turns on... */
const TURN_ON = 1.2;
/** ...and it stays on down to this much, so a zoom at the edge does not flicker. */
const TURN_OFF = 1.05;
/** Drawn beyond what is in sight, so a small scroll shows no soft edge. CSS pixels. */
const MARGIN = 64;

export const sharpZoomBudget = (phone: boolean): SharpZoomBudget => (phone ? SHARP_ZOOM_PHONE : SHARP_ZOOM_DESKTOP);

/**
 * What to draw for one page, or null when the base drawing is sharp enough or the page is out of
 * sight.
 *
 * `page` is the page as shown (CSS transforms included) and `view` the part of the window it can
 * show through; both in the same coordinates. `baseWidth` is the width in backing pixels of the
 * drawing the page already has. `windowArea` shares the budget between the pages on screen: each
 * gets the part of `maxPixels` that its visible area is of the window, so together they stay
 * under it. `active` is whether a detail canvas is up now.
 */
export const planSharpRender = ({
  page,
  view,
  baseWidth,
  dpr,
  budget,
  windowArea,
  active = false,
}: {
  page: SharpRect;
  view: SharpRect;
  baseWidth: number;
  dpr: number;
  budget: SharpZoomBudget;
  windowArea: number;
  active?: boolean;
}): SharpPlan | null => {
  if (!(page.width > 0) || !(page.height > 0) || !(baseWidth > 0)) return null;
  const ratio = Math.min(dpr > 0 ? dpr : 1, MAX_PIXEL_RATIO);
  const enough = baseWidth * (active ? TURN_OFF : TURN_ON);
  if (page.width * ratio <= enough) return null;

  const left = Math.max(page.left, view.left);
  const top = Math.max(page.top, view.top);
  const right = Math.min(page.left + page.width, view.left + view.width);
  const bottom = Math.min(page.top + page.height, view.top + view.height);
  if (!(right > left) || !(bottom > top)) return null;
  const visible = { x: left - page.left, y: top - page.top, width: right - left, height: bottom - top };

  const x = Math.max(0, Math.floor(visible.x - MARGIN));
  const y = Math.max(0, Math.floor(visible.y - MARGIN));
  const clip = {
    x,
    y,
    width: Math.min(page.width, Math.ceil(visible.x + visible.width + MARGIN)) - x,
    height: Math.min(page.height, Math.ceil(visible.y + visible.height + MARGIN)) - y,
  };

  const share = windowArea > 0 ? Math.min(1, (visible.width * visible.height) / windowArea) : 1;
  const fit = Math.min(
    1,
    Math.sqrt((budget.maxPixels * share) / (clip.width * clip.height * ratio * ratio)),
    budget.maxSide / (Math.max(clip.width, clip.height) * ratio),
  );
  const pixelRatio = ratio * fit;
  // A sliver of a page, or a tight budget, can leave no more detail than the base already has.
  if (page.width * pixelRatio <= enough) return null;

  return {
    clip,
    visible,
    pixelRatio,
    width: Math.max(1, Math.floor(clip.width * pixelRatio)),
    height: Math.max(1, Math.floor(clip.height * pixelRatio)),
    pageWidth: page.width,
  };
};

/** True when the canvas drawn for `current` already shows everything `next` asks for, as sharply. */
export const sharpPlanCovers = (current: SharpPlan, next: SharpPlan): boolean =>
  Math.abs(current.pageWidth - next.pageWidth) < 0.5
  && current.pixelRatio >= next.pixelRatio * 0.98
  && next.visible.x >= current.clip.x - 0.5
  && next.visible.y >= current.clip.y - 0.5
  && next.visible.x + next.visible.width <= current.clip.x + current.clip.width + 0.5
  && next.visible.y + next.visible.height <= current.clip.y + current.clip.height + 0.5;

/**
 * The PDF.js viewport that draws a plan's clip into its canvas: the scale, and the offsets that
 * move the clip's corner to the canvas's corner. `unitWidth` is the page's width at scale 1.
 */
export const sharpViewport = (plan: SharpPlan, unitWidth: number) => ({
  scale: (plan.pageWidth * plan.pixelRatio) / unitWidth,
  offsetX: -plan.clip.x * plan.pixelRatio,
  offsetY: -plan.clip.y * plan.pixelRatio,
});

/** The backing scale a drawing needs to be sharp at `cssWidth` on this screen (grid thumbnails). */
export const neededRenderScale = (cssWidth: number, dpr: number, pageWidthPoints: number) =>
  (cssWidth * (dpr || 1)) / pageWidthPoints;
