/** Regression: deleting one reused form occurrence must never alter untouched occurrences. */
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const fixture = async (samePage, otherPage) => {
  const inner = await PDFDocument.create();
  const font = await inner.embedFont(StandardFonts.Helvetica);
  const innerPage = inner.addPage([250, 60]);
  innerPage.drawText('SHARED ORIGINAL', { x: 10, y: 25, size: 12, font });
  await inner.save(); // Flush the source font dictionary before embedding its page.
  const document = await PDFDocument.create();
  const [shared] = await document.embedPages([innerPage]);
  const first = document.addPage([600, 800]);
  first.drawPage(shared, { x: 50, y: 600 });
  if (samePage) first.drawPage(shared, { x: 50, y: 400 });
  if (otherPage) document.addPage([600, 800]).drawPage(shared, { x: 50, y: 600 });
  return document.save();
};
const textPages = async (bytes) => {
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)) });
  const pdf = await task.promise;
  try {
    const result = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      result.push((await page.getTextContent()).items.filter(item => 'str' in item).map(item => item.str).join(' '));
    }
    return result;
  } finally { await task.destroy(); }
};
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  // The dev server, not the preview build: this check imports the editor's
  // TypeScript module directly, which only Vite can serve.
  await page.goto(process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000');
  for (const [samePage, otherPage] of [[true, false], [false, true], [true, true], [false, false]]) {
    const input = await fixture(samePage, otherPage);
    const result = await page.evaluate(async (data) => {
      const { clearNativePdfTextInAreas } = await import('/services/pdfNativeTextEditor.ts');
      try {
        const result = await clearNativePdfTextInAreas(new Uint8Array(data), [{ pageIndex: 0, pdfRect: [50, 610, 300, 655] }]);
        return { bytes: Array.from(result.bytes), uncleared: result.uncleared };
      } catch (error) { return { error: error.message }; }
    }, Array.from(input));
    if (samePage || otherPage) {
      assert.match(result.error, /removing a shared form would change text outside the edited paragraph/);
      // A rejected engine attempt leaves the original input available for the editor's visual fallback.
      const original = await textPages(input);
      assert.equal(original[0].match(/SHARED ORIGINAL/g).length, samePage ? 2 : 1);
      if (otherPage) assert.equal(original[1], 'SHARED ORIGINAL');
      const fallback = await page.evaluate(async (data) => {
        const { savePDFWithAnnotations } = await import('/services/pdfDocument.ts');
        const bytes = await savePDFWithAnnotations(new File([new Uint8Array(data)], 'shared.pdf'), [], {}, [{
          mode: 'reflow', pageIndex: 0, x: 50 / 600, y: 145 / 800, width: 250 / 600, height: 45 / 800,
          runDeletions: [], backgroundColor: '#ffffff', backgroundFlat: false,
          lines: [[{ text: 'REVISED', face: { key: 'body', family: 'Helvetica', bold: false, italic: false } }]],
          fontSize: 12, lineHeight: 14, align: 'left', color: '#000000',
        }]);
        return Array.from(bytes);
      }, Array.from(input));
      const redrawn = await textPages(new Uint8Array(fallback));
      assert.equal(redrawn[0].match(/SHARED ORIGINAL/g).length, samePage ? 2 : 1);
      assert.match(redrawn[0], /REVISED/);
      if (otherPage) assert.equal(redrawn[1], 'SHARED ORIGINAL');
    } else {
      assert.equal(result.error, undefined);
      assert.equal(result.uncleared, 0);
      assert.deepEqual(await textPages(new Uint8Array(result.bytes)), ['']);
    }
    console.log(`PASS form clearance: same-page reuse=${samePage}, cross-page reuse=${otherPage}`);
  }
} finally { await browser.close(); }
