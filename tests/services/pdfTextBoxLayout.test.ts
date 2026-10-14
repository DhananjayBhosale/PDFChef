import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { layoutTextBox, TEXT_BOX_PADDING_X } from '../../services/pdfTextBoxLayout.ts';

test('wraps new text using the exact export font advances without changing point size', async () => {
  const document = await PDFDocument.create();
  for (const fontFamily of ['Helvetica', 'TimesRoman', 'Courier']) {
    for (const fontWeight of [400, 700]) {
      for (const fontStyle of ['normal', 'italic'] as const) {
        const content = 'This sentence should wrap inside the new text box and stay within its visible border.';
        const layout = layoutTextBox({ content, fontFamily, fontWeight, fontStyle, fontSize: 16 }, 172, 400);
        const font = await document.embedFont(StandardFonts[layout.fontKey]);
        assert.ok(layout.lines.length > 1);
        assert.equal(layout.lines.map(line => line.text).join(' '), content);
        assert.equal(layout.fontSize, 16);
        assert.equal(layout.overflow, false);
        for (const line of layout.lines) {
          assert.equal(line.width, Array.from(line.text).reduce((sum, glyph) => sum + font.widthOfTextAtSize(glyph, 16), 0));
          assert.ok(line.width <= 172 - TEXT_BOX_PADDING_X * 2);
        }
      }
    }
  }
});

test('keeps explicit blank lines and expands tabs consistently', () => {
  const layout = layoutTextBox({ content: 'First\r\n\r\n\tLast\u2028end', fontSize: 12 }, 180, 200);
  assert.deepEqual(layout.lines.map(line => line.text), ['First', '', '    Last', 'end']);
  assert.ok(Math.abs(layout.lines[3].baseline - (4 + 12 + 3 * 14.4)) < 0.00001);
});

test('breaks a long unspaced word without dropping characters', () => {
  const content = 'https://example.com/a/long/path/without/any/spaces';
  const layout = layoutTextBox({ content, fontSize: 16 }, 90, 400);
  assert.equal(layout.lines.map(line => line.text).join(''), content);
  assert.ok(layout.lines.every(line => line.width <= 78));
  assert.equal(layout.overflow, false);
});

test('overflow remains recoverable by enlarging the box with unchanged text and size', () => {
  const text = { content: 'A long sentence that needs many rows in this narrow new text box.', fontSize: 16 };
  const small = layoutTextBox(text, 130, 35);
  const enlarged = layoutTextBox(text, 130, small.requiredHeight);
  assert.equal(small.overflow, true);
  assert.equal(enlarged.overflow, false);
  assert.deepEqual(small.lines, enlarged.lines);
  assert.equal(enlarged.fontSize, 16);
  assert.equal(layoutTextBox({ content: 'W', fontSize: 72 }, 20, 200).overflow, true);
});

test('unsupported text is refused rather than silently omitted, and empty boxes need no ink', () => {
  assert.throws(() => layoutTextBox({ content: '📄' }, 200, 200), /cannot encode/);
  assert.deepEqual(layoutTextBox({ content: '' }, 0, 0).lines, []);
  assert.equal(layoutTextBox({ content: '' }, 0, 0).overflow, false);
});
