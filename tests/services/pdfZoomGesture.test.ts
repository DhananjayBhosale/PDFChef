import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampPdfZoom,
  pdfZoomFromPinch,
  pdfZoomFromWheel,
  pdfZoomScrollOffset,
  pdfPageFromScrollBoundary,
  pdfPageFromSwipe,
} from '../../services/pdfZoomGesture.ts';

test('trackpad pinch wheel deltas zoom smoothly and remain bounded', () => {
  assert.ok(pdfZoomFromWheel(1, -20, 0.5, 2) > 1);
  assert.ok(pdfZoomFromWheel(1, 20, 0.5, 2) < 1);
  assert.equal(pdfZoomFromWheel(2, -200, 0.5, 2), 2);
  assert.equal(pdfZoomFromWheel(0.5, 200, 0.5, 2), 0.5);
});

test('touch pinch follows the distance ratio and clamps invalid input', () => {
  assert.equal(pdfZoomFromPinch(1, 100, 150, 0.5, 2), 1.5);
  assert.equal(pdfZoomFromPinch(1, 100, 25, 0.5, 2), 0.5);
  assert.equal(pdfZoomFromPinch(1, 0, 150, 0.5, 2), 1);
  assert.equal(clampPdfZoom(Number.POSITIVE_INFINITY, 0.5, 2), 2);
});

test('zoom keeps the point beneath the gesture anchored in a scroll viewport', () => {
  assert.equal(pdfZoomScrollOffset(100, 200, 1, 1.5), 250);
  assert.equal(pdfZoomScrollOffset(100, 200, 1.5, 1), 0);
  assert.equal(pdfZoomScrollOffset(100, 200, 1, 1), 100);
});

test('ordinary vertical scrolling changes pages only at a zoomed page boundary', () => {
  const base = { currentPage: 1, pageCount: 4, zoom: 2, deltaX: 0, deltaY: 80 };
  assert.equal(pdfPageFromScrollBoundary({ ...base, atStart: false, atEnd: true }), 2);
  assert.equal(pdfPageFromScrollBoundary({ ...base, deltaY: -80, atStart: true, atEnd: false }), 0);
  assert.equal(pdfPageFromScrollBoundary({ ...base, atStart: false, atEnd: false }), 1);
  assert.equal(pdfPageFromScrollBoundary({ ...base, zoom: 1, atStart: false, atEnd: true }), 1);
  assert.equal(pdfPageFromScrollBoundary({ ...base, deltaX: 100, atStart: false, atEnd: true }), 1);
  assert.equal(pdfPageFromScrollBoundary({ ...base, currentPage: 3, atStart: false, atEnd: true }), 3);
});

// Found on a phone: at fit zoom the page never scrolls, so swiping never reached the next page.
test('a one-finger swipe at the page edge turns the page, and an ordinary scroll does not', () => {
  const base = { currentPage: 1, pageCount: 3, deltaX: 4, deltaY: -80, startedAtStart: true, startedAtEnd: true };
  assert.equal(pdfPageFromSwipe(base), 2);
  assert.equal(pdfPageFromSwipe({ ...base, deltaY: 80 }), 0);
  assert.equal(pdfPageFromSwipe({ ...base, startedAtEnd: false }), 1, 'the page was still scrolling');
  assert.equal(pdfPageFromSwipe({ ...base, deltaY: -40 }), 1, 'too short');
  assert.equal(pdfPageFromSwipe({ ...base, deltaX: 60 }), 1, 'mostly sideways');
  assert.equal(pdfPageFromSwipe({ ...base, currentPage: 2 }), 2, 'already the last page');
});
