import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SHARP_ZOOM_DESKTOP,
  SHARP_ZOOM_PHONE,
  planSharpRender,
  sharpPlanCovers,
  sharpViewport,
  sharpZoomBudget,
} from '../../services/pdfSharpZoom.ts';

// Sharp zoom: a zoomed page is drawn again only where it is in sight, into one canvas that never
// outgrows the screen. An A4 page (595 pt wide) is drawn at scale 2 to begin with: 1190 px.
const A4_BASE = 1190;
const phone = { left: 0, top: 0, width: 390, height: 844 };
const phoneArea = phone.width * phone.height;
/** An A4 page that fits 366 px at 100%, shown at `zoom`, with its top left at `left`, `top`. */
const a4 = (zoom: number, left = 0, top = 0) => ({ left, top, width: 366 * zoom, height: 366 * zoom * (842 / 595) });
const planPhone = (zoom: number, extra: Partial<Parameters<typeof planSharpRender>[0]> = {}) =>
  planSharpRender({ page: a4(zoom), view: phone, baseWidth: A4_BASE, dpr: 3, budget: SHARP_ZOOM_PHONE, windowArea: phoneArea, ...extra });

test('a page at 100% keeps its own drawing', () => {
  assert.equal(planPhone(1), null);
  assert.equal(planSharpRender({ page: { left: 0, top: 0, width: 595, height: 842 }, view: { left: 0, top: 0, width: 1280, height: 800 }, baseWidth: A4_BASE, dpr: 2, budget: SHARP_ZOOM_DESKTOP, windowArea: 1280 * 800 }), null);
});

test('the detail turns on above 120% of the base and stays on down to 105%', () => {
  // 366 px * 3 = 1098 backing px at 100%; the base has 1190. 1.2 * 1190 = 1428 is zoom 1.30.
  assert.equal(planPhone(1.25), null);
  assert.notEqual(planPhone(1.35), null);
  // Coming back down, a canvas that is up stays until 1.05 * 1190 = 1250, zoom 1.14.
  assert.notEqual(planPhone(1.2, { active: true }), null);
  assert.equal(planPhone(1.1, { active: true }), null);
});

test('at 400% on a phone the canvas is the screen at full pixel ratio, far under the cap', () => {
  const plan = planPhone(4, { page: a4(4, -500, -900) });
  assert.ok(plan);
  assert.equal(plan.pixelRatio, 3, 'no scaling down: a phone screen is 3 million pixels');
  assert.deepEqual(plan.visible, { x: 500, y: 900, width: 390, height: 844 });
  // 64 px more on every side, as whole CSS pixels.
  assert.deepEqual(plan.clip, { x: 436, y: 836, width: 390 + 128, height: 844 + 128 });
  assert.equal(plan.width, (390 + 128) * 3);
  assert.equal(plan.height, (844 + 128) * 3);
  assert.ok(plan.width * plan.height <= SHARP_ZOOM_PHONE.maxPixels);
  // The whole page at this zoom would be 27 million pixels.
  assert.ok(a4(4).width * 3 * a4(4).height * 3 > 16_777_216);
});

test('the clip stops at the page edges', () => {
  const plan = planPhone(4, { page: a4(4, 100, 200) });
  assert.ok(plan);
  assert.equal(plan.clip.x, 0);
  assert.equal(plan.clip.y, 0);
  assert.equal(plan.clip.width, 290 + 64);
  const end = planPhone(4, { page: a4(4, 390 - 366 * 4, 0) });
  assert.ok(end);
  assert.equal(end.clip.x + end.clip.width, 366 * 4, 'never past the right edge');
});

test('a page out of sight has no plan', () => {
  assert.equal(planPhone(4, { page: a4(4, 0, 900) }), null);
  assert.equal(planPhone(4, { view: { left: 0, top: 0, width: 0, height: 0 } }), null);
});

test('a large desktop window is scaled down to the pixel budget', () => {
  const view = { left: 0, top: 0, width: 2560, height: 1440 };
  const plan = planSharpRender({ page: { left: -2000, top: -2000, width: 8000, height: 11000 }, view, baseWidth: A4_BASE, dpr: 2, budget: SHARP_ZOOM_DESKTOP, windowArea: view.width * view.height });
  assert.ok(plan);
  assert.ok(plan.pixelRatio < 2);
  assert.ok(plan.width * plan.height <= SHARP_ZOOM_DESKTOP.maxPixels);
  assert.ok(plan.width * plan.height > SHARP_ZOOM_DESKTOP.maxPixels * 0.98, 'and uses the budget it has');
});

test('a long thin clip is held to the longest side', () => {
  const view = { left: 0, top: 0, width: 5000, height: 300 };
  const plan = planSharpRender({ page: { left: 0, top: 0, width: 5000, height: 7000 }, view, baseWidth: A4_BASE, dpr: 3, budget: SHARP_ZOOM_PHONE, windowArea: view.width * view.height });
  assert.ok(plan);
  assert.ok(Math.max(plan.width, plan.height) <= SHARP_ZOOM_PHONE.maxSide);
});

test('two pages on screen share the budget by the room each takes', () => {
  // Read PDF at 400% on a tablet: the end of one page above the start of the next.
  const view = { left: 0, top: 0, width: 1024, height: 1366 };
  const windowArea = view.width * view.height;
  const page = { width: 4000, height: 5660 };
  const upper = planSharpRender({ page: { left: -1000, top: 683 - page.height, ...page }, view, baseWidth: A4_BASE, dpr: 2, budget: SHARP_ZOOM_PHONE, windowArea });
  const lower = planSharpRender({ page: { left: -1000, top: 695, ...page }, view, baseWidth: A4_BASE, dpr: 2, budget: SHARP_ZOOM_PHONE, windowArea });
  assert.ok(upper && lower);
  assert.ok(upper.width * upper.height + lower.width * lower.height <= SHARP_ZOOM_PHONE.maxPixels);
});

test('a budget too small to beat the base leaves the base alone', () => {
  assert.equal(planPhone(1.4, { budget: { maxPixels: 100_000, maxSide: 4096 } }), null);
});

test('a small scroll inside the margin needs no new drawing; a longer one does', () => {
  const first = planPhone(4, { page: a4(4, -500, -900) });
  const nudged = planPhone(4, { page: a4(4, -500, -940) });
  const moved = planPhone(4, { page: a4(4, -500, -1100) });
  const zoomed = planPhone(3.5, { page: a4(3.5, -500, -900) });
  assert.ok(first && nudged && moved && zoomed);
  assert.equal(sharpPlanCovers(first, nudged), true);
  assert.equal(sharpPlanCovers(first, moved), false);
  assert.equal(sharpPlanCovers(first, zoomed), false, 'another zoom is another drawing');
});

test('the viewport puts the clip corner on the canvas corner', () => {
  const plan = planPhone(4, { page: a4(4, -500, -900) });
  assert.ok(plan);
  const viewport = sharpViewport(plan, 595);
  // 1464 CSS px across 595 pt at 3 backing px per CSS px.
  assert.ok(Math.abs(viewport.scale - (1464 * 3) / 595) < 1e-9);
  assert.equal(viewport.offsetX, -436 * 3);
  assert.equal(viewport.offsetY, -836 * 3);
});

test('phones get 6 million pixels and desktops 12, both under the iOS canvas limit', () => {
  assert.deepEqual(sharpZoomBudget(true), { maxPixels: 6_000_000, maxSide: 4096 });
  assert.deepEqual(sharpZoomBudget(false), { maxPixels: 12_000_000, maxSide: 8192 });
  assert.ok(sharpZoomBudget(false).maxPixels < 16_777_216);
});
