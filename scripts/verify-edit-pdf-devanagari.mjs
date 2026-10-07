/** Run against a built preview: node --experimental-strip-types scripts/verify-edit-pdf-devanagari.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { DevanagariPdfWriter, loadDevanagariFonts, measureDevanagariText } from '../services/pdfDevanagari.ts';

const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const hindiOriginal = 'नमस्ते दुनिया, यह एक परीक्षण है।';
const englishOriginal = 'Original English line for replacement.';
const replacement = 'नमस्ते भारत, कृपया यह नया लेख पढ़ें।';

await loadDevanagariFonts(async id => new Uint8Array(readFileSync(
  new URL(`../assets/fonts/pdf-edit/${id.replace(/(Regular|Bold)$/, '-$1')}.ttf`, import.meta.url),
)));

const fixture = async (english, fontId = 'MuktaRegular') => {
  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  if (english) {
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText(englishOriginal, { x: 72, y: 700, size: 18, font });
  } else {
    const writer = new DevanagariPdfWriter(document);
    await writer.drawLine(page, [{
      text: hindiOriginal, fontId, x: 72, y: 700,
      width: measureDevanagariText(hindiOriginal, fontId, 18),
    }], 18, rgb(0, 0, 0), 0);
    writer.finish();
    const neighbor = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('Account 2026', { x: 370, y: 700, size: 12, font: neighbor });
  }
  return Buffer.from(await document.save());
};

const browser = await chromium.launch({ headless: true });
try {
  for (const { english, fontId } of [
    { english: false, fontId: 'MuktaRegular' },
    { english: false, fontId: 'MartelBold' },
    { english: true, fontId: 'MuktaRegular' },
  ]) {
    const page = await browser.newPage();
    const errors = [];
    const warnings = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
    await page.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false,
      largeFileWarningMb: 80, onboardingComplete: true, interfaceFont: 'inter',
    })));
    await page.goto(`${baseUrl}/edit`);
    await page.locator('input[type=file][accept=".pdf"]').setInputFiles({
      name: 'text.pdf', mimeType: 'application/pdf', buffer: await fixture(english, fontId),
    });
    const paragraph = page.getByTestId('pdf-text-block').first();
    await paragraph.waitFor({ timeout: 60_000 });
    assert.ok((await paragraph.innerText()).includes(english ? englishOriginal : hindiOriginal));
    await paragraph.fill(replacement);
    await page.waitForFunction(() => /will be redrawn/i.test(
      document.querySelector('[data-testid="pdf-paragraph-provenance"]')?.textContent ?? '',
    ), null, { timeout: 20_000 });
    const provenance = await page.getByTestId('pdf-paragraph-provenance').innerText();
    assert.match(provenance, english ? /Mukta/ : new RegExp(`Drawn with ${fontId.startsWith('Martel') ? 'Martel' : 'Mukta'}`));

    let resolveOutput;
    const output = new Promise(resolve => { resolveOutput = resolve; });
    await page.exposeFunction('captureDevanagariPdf', bytes => resolveOutput(Uint8Array.from(bytes)));
    await page.evaluate(() => window.addEventListener('pdfchef:output-ready', event =>
      event.detail.blob.arrayBuffer().then(buffer => window.captureDevanagariPdf([...new Uint8Array(buffer)]))
    ));
    await page.getByRole('button', { name: /^Save/ }).first().click();
    let timeout;
    const bytes = await Promise.race([
      output,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Save timed out: ${errors.join('; ')}`)), 30_000); }),
    ]).finally(() => clearTimeout(timeout));
    const task = pdfjs.getDocument({ data: bytes });
    const pdf = await task.promise;
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map(item => item.str).join('');
    assert.ok(text.includes(replacement), `Replacement missing: ${text}`);
    assert.ok(!text.includes(english ? englishOriginal : hindiOriginal), `Old wording remains: ${text}; ${warnings.join('; ')}`);
    if (!english) assert.ok(text.includes('Account 2026'), `Adjacent text was removed: ${text}`);
    await task.destroy();
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`✓ ${english ? 'English to Devanagari' : `Devanagari with embedded ${fontId}`} Save`);
  }
} finally {
  await browser.close();
}
