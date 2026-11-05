/**
 * Regression, found on a phone: a text object whose last character is a blank reached past the
 * paragraph by that blank's width, so the save refused the paragraph. The object belongs to the
 * paragraph when its visible characters lie inside it.
 */
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const document = await PDFDocument.create();
const font = await document.embedFont(StandardFonts.Helvetica);
const page = document.addPage([600, 800]);
page.drawText('Hello world   ', { x: 50, y: 600, size: 12, font });
page.drawText('Neighbour', { x: 300, y: 600, size: 12, font });
const input = await document.save();
// The paragraph ends 1 pt after the last visible letter; the three blanks reach about 10 pt further.
const right = 50 + font.widthOfTextAtSize('Hello world', 12) + 1;

const textOf = async (bytes) => {
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)) });
  try {
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items;
    return items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
  } finally { await task.destroy(); }
};

const browser = await chromium.launch({ headless: true });
try {
  const tab = await browser.newPage();
  // The dev server, not the preview build: this check imports the editor's TypeScript module.
  await tab.goto(process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000');
  const result = await tab.evaluate(async ({ data, right }) => {
    const { clearNativePdfTextInAreas } = await import('/services/pdfNativeTextEditor.ts');
    try {
      const cleared = await clearNativePdfTextInAreas(new Uint8Array(data), [{ pageIndex: 0, pdfRect: [48, 595, right, 615] }]);
      return { bytes: Array.from(cleared.bytes), uncleared: cleared.uncleared };
    } catch (error) { return { error: error.message }; }
  }, { data: Array.from(input), right });
  assert.equal(result.error, undefined);
  assert.equal(result.uncleared, 0, 'the text object with a trailing blank was left in place');
  assert.equal(await textOf(new Uint8Array(result.bytes)), 'Neighbour');
  console.log('PASS a text object ending in blanks is cleared with its paragraph; its neighbour stays');
} finally { await browser.close(); }
