import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capturePdfFocusAnchor,
  pdfCaretScroll,
  pdfEditingVisibleRect,
  pdfFocusAnchorScroll,
  pdfParagraphStartScroll,
} from '../../services/pdfEditingFocus.ts';

test('touch auto-zoom keeps a selected page point at the same visible position', () => {
  const page = { left: -80, top: -200, right: 920, bottom: 1200 };
  const point = { x: 160, y: 280 };
  const anchor = capturePdfFocusAnchor(page, point);
  const zoomed = { left: -80, top: -200, right: 1200, bottom: 1592 };
  const visible = { left: 8, top: 120, right: 382, bottom: 640 };
  const scroll = pdfFocusAnchorScroll(anchor, zoomed, visible);
  assert.ok(Math.abs(scroll.left - 67.2) < 0.001);
  assert.ok(Math.abs(scroll.top - 134.4) < 0.001);
  assert.equal(zoomed.left + anchor.pageX * (zoomed.right - zoomed.left) - scroll.left, point.x);
  assert.equal(zoomed.top + anchor.pageY * (zoomed.bottom - zoomed.top) - scroll.top, point.y);
});

test('a keyboard and inspector clamp the anchor into the usable PDF viewport', () => {
  const page = { left: 8, top: -300, right: 758, bottom: 760 };
  const anchor = capturePdfFocusAnchor(page, { x: 200, y: 510 });
  const visible = { left: 8, top: 120, right: 382, bottom: 330 };
  const scroll = pdfFocusAnchorScroll(anchor, page, visible);
  assert.equal(scroll.left, 0);
  assert.equal(scroll.top, 204);
  assert.equal(anchor.clientY - scroll.top, visible.bottom - 24);
  assert.equal(anchor.pageY, 810 / 1060, 'focus scrolling does not alter PDF-relative text position');
});

test('caret avoidance leaves visible text alone and only reveals the active line', () => {
  const visible = { left: 8, top: 120, right: 382, bottom: 330 };
  assert.deepEqual(pdfCaretScroll({ left: 100, top: 200, right: 101, bottom: 220 }, visible), { left: 0, top: 0 });
  assert.deepEqual(pdfCaretScroll({ left: 100, top: 310, right: 101, bottom: 330 }, visible), { left: 0, top: 24 });
  assert.deepEqual(pdfCaretScroll({ left: 12, top: 110, right: 13, bottom: 130 }, visible), { left: -20, top: -34 });
});

// EDT-16: on a 360x784 phone the keyboard shrinks the window, the document scrolled, and the
// lowest paragraph's caret was placed on top of the fixed "Edit PDF" title.
test('the fixed header is not part of the space a caret can be scrolled into', () => {
  const screen = { left: 0, top: 0, right: 360, bottom: 470 };
  const header = { left: 0, top: 0, right: 360, bottom: 96 };
  const bar = { left: 0, top: 300, right: 360, bottom: 470 };
  // The PDF box has scrolled up under the header along with the document.
  const container = { left: 8, top: 40, right: 352, bottom: 420 };
  const visible = pdfEditingVisibleRect(container, screen, header, bar);
  assert.deepEqual(visible, { left: 8, top: 96, right: 352, bottom: 300 });
  // A caret just under the box's own top edge is still behind the header, so it moves down.
  assert.ok(pdfCaretScroll({ left: 100, top: 60, right: 101, bottom: 80 }, visible!).top < 0);
  // The anchor of a tapped paragraph is kept below the header too.
  const page = { left: 8, top: 40, right: 352, bottom: 526 };
  const anchor = capturePdfFocusAnchor(page, { x: 100, y: 60 });
  assert.equal(anchor.clientY - pdfFocusAnchorScroll(anchor, page, visible!).top, 96 + 24);
});

test('a header or bar that does not cover the PDF box leaves it alone', () => {
  const screen = { left: 0, top: 0, right: 360, bottom: 784 };
  const container = { left: 8, top: 150, right: 352, bottom: 600 };
  const header = { left: 0, top: 0, right: 360, bottom: 96 };
  const bar = { left: 0, top: 640, right: 360, bottom: 784 };
  assert.deepEqual(pdfEditingVisibleRect(container, screen, header, bar), container);
  assert.deepEqual(pdfEditingVisibleRect(container, screen, null, null), container);
  // Chrome that covers everything leaves nowhere to scroll to.
  assert.equal(pdfEditingVisibleRect(container, screen, { ...header, bottom: 400 }, { ...bar, top: 380 }), null);
});

// EDT-09: focus zoom kept the tapped word in place, which pushed the start of every line off the
// left edge, and it stayed that way.
test('after focus zoom the start of the paragraph comes back into view', () => {
  const visible = { left: 8, top: 120, right: 352, bottom: 330 };
  // The paragraph fits: all of it is shown.
  assert.equal(pdfParagraphStartScroll({ left: -100, top: 0, right: 200, bottom: 0 }, { left: 150, top: 0, right: 151, bottom: 0 }, visible), -132);
  // Wider than the screen: its start is shown as long as the caret stays on screen.
  assert.equal(pdfParagraphStartScroll({ left: -163, top: 0, right: 600, bottom: 0 }, { left: 170, top: 0, right: 171, bottom: 0 }, visible), -157);
  assert.equal(pdfParagraphStartScroll({ left: -60, top: 0, right: 600, bottom: 0 }, { left: 170, top: 0, right: 171, bottom: 0 }, visible), -92);
  // A start already on screen, or a caret already past the right edge, is left alone.
  assert.equal(pdfParagraphStartScroll({ left: 20, top: 0, right: 600, bottom: 0 }, { left: 170, top: 0, right: 171, bottom: 0 }, visible), 0);
  assert.equal(pdfParagraphStartScroll({ left: -60, top: 0, right: 600, bottom: 0 }, { left: 400, top: 0, right: 401, bottom: 0 }, visible), 0);
});
