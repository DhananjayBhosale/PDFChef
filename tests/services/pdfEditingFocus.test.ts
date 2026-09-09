import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePdfFocusAnchor, pdfCaretScroll, pdfFocusAnchorScroll } from '../../services/pdfEditingFocus.ts';

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
