import assert from 'node:assert/strict';
import test from 'node:test';
import { clampPdfPan, pdfButtonZoomAnchor, pdfPanForZoom } from '../../services/pdfZoomGesture.ts';

// Pass 5 ("PDFs are always zoomable"): the preview dialog, PDF to Image and Compare move their page
// (translate and scale) instead of scrolling it; two fingers zoom about the fingers there.
test('a pinch on a moved page keeps the point under the fingers where it is', () => {
  const pointer = { x: 60, y: -40 };
  const pan = pdfPanForZoom({ x: 0, y: 0 }, pointer, 1, 2);
  // The page point under the fingers was (pointer - pan) / zoom before, and is the same after.
  assert.deepEqual({ x: (pointer.x - pan.x) / 2, y: (pointer.y - pan.y) / 2 }, { x: 60, y: -40 });
  assert.deepEqual(pdfPanForZoom({ x: 10, y: 20 }, pointer, 2, 2), { x: 10, y: 20 }, 'no zoom change, no move');
  assert.deepEqual(pdfPanForZoom({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, 3), { x: 0, y: 0 }, 'a pinch at the centre stays centred');
});

test('a zoomed page never moves past its own edges, and a page no larger than its frame stays centred', () => {
  const page = { width: 300, height: 400 };
  const frame = { width: 300, height: 500 };
  // At 2x the page is 600 x 800: 150 px of room each side across, 150 px up and down.
  assert.deepEqual(clampPdfPan({ x: 999, y: -999 }, page, frame, 2), { x: 150, y: -150 });
  assert.deepEqual(clampPdfPan({ x: 40, y: 30 }, page, frame, 2), { x: 40, y: 30 });
  // At 1.2x the page is 360 x 480: wider than the frame, but not taller, so it cannot move up or down.
  assert.deepEqual(clampPdfPan({ x: 500, y: 500 }, page, frame, 1.2), { x: 30, y: 0 });
});

// REVIEW.md item 12: − and + zoomed about the middle, so at 200% the top lines were off screen.
test('the zoom buttons keep the page top edge, and its line-start edge, in view', () => {
  const view = { start: 0, end: 800 };
  assert.equal(pdfButtonZoomAnchor({ start: 100, end: 700 }, view), 100, 'top edge in view: it stays put');
  assert.equal(pdfButtonZoomAnchor({ start: -300, end: 1200 }, view), 400, 'moved past the top edge: the middle of the view');
  assert.equal(pdfButtonZoomAnchor({ start: 900, end: 1500 }, view), 800, 'never about a point outside the view');
  // Right to left: the lines start at the right edge.
  assert.equal(pdfButtonZoomAnchor({ start: 100, end: 700 }, view, true), 700);
  assert.equal(pdfButtonZoomAnchor({ start: -500, end: 1200 }, view, true), 400);
  // Zooming about the anchor from the frame's centre leaves the top edge where it was.
  const frameCentre = 400;
  const pageTop = 100;
  const pan = pdfPanForZoom({ x: 0, y: 0 }, { x: 0, y: pdfButtonZoomAnchor({ start: pageTop, end: 700 }, view) - frameCentre }, 1, 2);
  assert.equal(frameCentre + pan.y + (pageTop - frameCentre) * 2, pageTop);
});
