/** General Edit PDF regression: original fonts and per-run sizes survive typing, Done and Save. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { chromium } from 'playwright';

const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const canonicalName = name => name.replace(/^[A-Z]{6}\+/, '').replace(/-\d+$/, '');
const readAppearance = async bytes => {
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), fontExtraProperties: true,
    standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    await page.getOperatorList();
    return (await page.getTextContent()).items.filter(item => item.str?.trim()).map(item => ({
      text: item.str.trim(), size: Math.hypot(item.transform[2], item.transform[3]),
      x: item.transform[4], y: item.transform[5], width: item.width,
      name: canonicalName(page.commonObjs.get(item.fontName).name),
    }));
  } finally { await task.destroy(); }
};

const fixture = async ({ style = 'Regular', family, mixed = false, subset = false }) => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const load = async nextStyle => family
    ? doc.embedFont(StandardFonts[family])
    : doc.embedFont(await readFile(`node_modules/pdfjs-dist/standard_fonts/LiberationSans-${nextStyle}.ttf`), { subset });
  const regular = await load(style);
  const bold = mixed ? await load('Bold') : regular;
  const page = doc.addPage([612, 792]);
  const runs = mixed ? [
    { text: 'Lead ', size: 14, font: bold },
    { text: 'Body', size: 11, font: regular },
    { text: ' small', size: 10, font: regular },
  ] : [{ text: 'Device note', size: 15.96, font: regular }];
  let x = 72;
  for (const run of runs) {
    page.drawText(run.text, { x, y: 700, font: run.font, size: run.size });
    x += run.font.widthOfTextAtSize(run.text, run.size);
  }
  page.drawText('Untouched paragraph and more.', { x: 72, y: 630, font: regular, size: 12 });
  const widths = new Map([regular, bold].map(font => [canonicalName(font.name), font]));
  return { bytes: Buffer.from(await doc.save()), original: runs.map(run => run.text).join(''),
    measure: (text, size, name) => widths.get(name).widthOfTextAtSize(text, size),
  };
};

const cases = [
  ...['Regular', 'Bold', 'Italic', 'BoldItalic'].map(style => ({ label: `embedded ${style}`, style })),
  ...['Helvetica', 'TimesRoman', 'Courier'].map(family => ({ label: `standard ${family}`, family })),
  { label: 'embedded mixed sizes and faces', mixed: true },
  { label: 'standard mixed sizes', family: 'Helvetica', mixed: true },
  { label: 'embedded explicit newline', action: 'newline' },
  { label: 'embedded direct replacement', action: 'replace' },
  { label: 'embedded new Unicode glyph', action: 'unicode' },
  { label: 'subset missing glyph fallback', subset: true, action: 'missing' },
  { label: 'embedded mixed sizes colour only', mixed: true, action: 'colour' },
  { label: 'embedded mixed sizes size only', mixed: true, action: 'size' },
  { label: 'standard mixed sizes colour only', family: 'Helvetica', mixed: true, action: 'colour' },
  { label: 'embedded regular bold restored', action: 'restore-bold' },
  { label: 'embedded bold restored', style: 'Bold', action: 'restore-bold' },
  { label: 'embedded regular italic restored', action: 'restore-italic' },
  { label: 'embedded italic restored', style: 'Italic', action: 'restore-italic' },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const item of cases.filter(item => !process.env.PDF_CHEF_FONT_CHECKS_ONLY && (!process.env.PDF_CHEF_FONT_CASE || item.label === process.env.PDF_CHEF_FONT_CASE))) {
    const { bytes, original, measure } = await fixture(item);
    const before = await readAppearance(bytes);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false, onboardingComplete: true,
    })));
    let receive;
    const output = new Promise(resolve => { receive = resolve; });
    await page.exposeFunction('__receiveFontOutput', receive);
    await page.addInitScript(() => window.addEventListener('pdfchef:output-ready', async event => {
      window.__receiveFontOutput(Array.from(new Uint8Array(await event.detail.blob.arrayBuffer())));
    }));
    await page.goto(`${baseUrl}/edit`);
    await page.locator('input[type=file][accept=".pdf"]').setInputFiles({ name: 'fonts.pdf', mimeType: 'application/pdf', buffer: bytes });
    const target = page.getByTestId('pdf-text-block').filter({ hasText: original });
    await target.waitFor({ timeout: 45000 });
    const blockId = await target.getAttribute('data-block-id');
    const paragraph = page.locator(`[data-testid="pdf-text-block"][data-block-id="${blockId}"]`);
    const spanSizes = () => paragraph.locator('span[data-font-size]').evaluateAll(spans => spans.map(span => Number(span.dataset.fontSize)));
    const originalSizes = await spanSizes();
    await paragraph.evaluate((element, action) => {
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      if (action !== 'replace') range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, item.action);
    const formattingOnly = ['colour', 'size', 'restore-bold', 'restore-italic'].includes(item.action);
    const changeColour = async () => page.getByLabel('Text color', { exact: true }).evaluate(element => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, '#b91c1c');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (formattingOnly) {
      await page.getByTestId('pdf-paragraph-inspector').waitFor();
      if (item.action === 'size') await page.getByRole('button', { name: 'Increase text size', exact: true }).click();
      else {
        if (item.action.startsWith('restore-')) {
          const toggle = page.getByRole('button', { name: item.action === 'restore-bold' ? 'Bold' : 'Italic', exact: true });
          await toggle.click();
          await toggle.click();
        }
        await changeColour();
      }
    } else {
      if (item.action === 'newline') await page.keyboard.press('Enter');
      await page.keyboard.insertText(item.action === 'replace' ? 'Device tone' : item.action === 'unicode' ? ' Ω' : item.action === 'missing' ? ' zebra' : ' and more');
    }
    const inserted = formattingOnly ? original : item.action === 'replace' ? 'Device tone' : item.action === 'unicode' ? ' Ω' : item.action === 'missing' ? ' zebra' : ' and more';
    const sizeRatio = item.action === 'size' ? (before[0].size + 0.5) / before[0].size : 1;
    await page.getByTestId('pdf-paragraph-provenance').waitFor();
    assert.deepEqual(await spanSizes(), originalSizes, `${item.label}: typing changed run sizes`);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const preview = page.getByTestId('pdf-block-preview');
    await preview.waitFor();
    if (!item.family && item.action !== 'replace' && item.action !== 'missing') {
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="pdf-block-preview"] text')]
        .every(piece => piece.getAttribute('font-family').includes('PDF Chef Embedded')));
    }
    const pieces = await preview.locator('text').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent.trim(), raw: node.textContent, size: Number(node.getAttribute('font-size')),
      width: Number(node.getAttribute('textLength')),
    })).filter(piece => piece.text));
    if (item.mixed) {
      assert.equal(pieces.length, 3, `${item.label}: Done flattened the runs`);
      for (const [index, size] of [14, 11, 10].entries()) assert.ok(Math.abs(pieces[index].size - size * sizeRatio) < 0.001, `${item.label}: Done changed relative run sizes`);
    } else assert.ok(pieces.every(piece => Math.abs(piece.size - 15.96 * sizeRatio) < 0.001));
    await page.getByRole('button', { name: /^Save/ }).first().click();
    let timeout;
    let result;
    try {
      result = await Promise.race([output, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${item.label}: Save timed out`)), 45000);
      })]);
    } finally { clearTimeout(timeout); }
    const after = await readAppearance(result);
    const changed = after.filter(run => run.text !== 'Untouched paragraph and more.');
    assert.ok(changed.map(run => run.text).join(' ').includes(inserted.trim()), `${item.label}: the edit was not saved`);
    for (const [index, run] of changed.entries()) {
      const expected = item.mixed ? before[index] : before[0];
      assert.equal(run.name, item.action === 'missing' ? 'Helvetica' : expected.name, `${item.label}: Save substituted the original font`);
      assert.ok(Math.abs(run.size - expected.size * sizeRatio) < 0.001, `${item.label}: Save changed the font size`);
      const piece = pieces.find(piece => piece.text === run.text);
      if (piece && !item.family && item.action !== 'replace' && item.action !== 'missing') {
        // PDF.js omits leading/trailing spaces from its extracted ink bounds.
        assert.ok(Math.abs(piece.width - measure(piece.raw, piece.size, run.name)) < 0.03,
          `${item.label}: preview uses different font advances`);
        assert.ok(Math.abs(run.width - measure(run.text, run.size, run.name)) < 0.03,
          `${item.label}: export uses different font advances`);
      }
      if (item.action !== 'newline' && item.action !== 'size') assert.ok(Math.abs(run.y - expected.y) < 0.01, `${item.label}: Save moved the baseline`);
      if (item.action === 'size') assert.ok(Math.abs(run.y - changed[0].y) < 0.01, `${item.label}: Save split a shared baseline`);
    }
    const untouchedBefore = before.find(run => run.text === 'Untouched paragraph and more.');
    const untouchedAfter = after.find(run => run.text === 'Untouched paragraph and more.');
    assert.equal(untouchedAfter.name, untouchedBefore.name);
    for (const key of ['size', 'x', 'y', 'width']) assert.ok(Math.abs(untouchedAfter[key] - untouchedBefore[key]) < 0.001,
      `${item.label}: an unrelated paragraph changed its ${key}`);
    assert.deepEqual(errors, []);
    console.log(`PASS ${item.label}: typing, Done and Save preserve ${item.action === 'missing' ? 'size with a drawable fallback' : 'original font and sizes'}`);
    await context.close();
  }
  if (!process.env.PDF_CHEF_FONT_CASE) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: false, onboardingComplete: true,
    })));
    const { bytes } = await fixture({ mixed: true });
    const fontCount = () => page.evaluate(() => [...document.fonts].filter(face => face.family.includes('PDF Chef Embedded')).length);
    for (const exit of ['navigation', 'close']) {
      await page.goto(`${baseUrl}/edit`);
      await page.locator('input[type=file][accept=".pdf"]').setInputFiles({ name: 'lifecycle.pdf', mimeType: 'application/pdf', buffer: bytes });
      const paragraph = page.getByTestId('pdf-text-block').filter({ hasText: 'Lead Body small' });
      await paragraph.waitFor();
      await paragraph.focus();
      await page.waitForFunction(() => [...document.fonts].some(face => face.family.includes('PDF Chef Embedded')));
      assert.equal(await fontCount(), 2);
      if (exit === 'navigation') await page.getByRole('link', { name: /^PDF Chef/ }).first().click();
      else {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: 'Close editor', exact: true }).click();
      }
      await page.waitForFunction(() => ![...document.fonts].some(face => face.family.includes('PDF Chef Embedded')));
      assert.equal(await fontCount(), 0, `${exit}: browser font faces leaked after leaving the document`);
    }
    console.log('PASS document font lifecycle: navigation and Close remove browser font faces');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/edit`);
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await readFile('tests/fixtures/fonts/NotoSansHebrew.ttf'));
    doc.addPage([612, 792]).drawText('אבג 123 text', { x: 72, y: 700, font, size: 16 });
    await page.locator('input[type=file][accept=".pdf"]').setInputFiles({ name: 'rtl.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
    const paragraph = page.getByTestId('pdf-text-block').filter({ hasText: /[א-ת]/ }).first();
    await paragraph.waitFor();
    await paragraph.focus();
    await page.getByLabel('Text color', { exact: true }).evaluate(element => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, '#b91c1c');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.getByTestId('pdf-paragraph-provenance').filter({ hasText: /cannot be changed/ }).waitFor();
    await page.evaluate(() => {
      window.__fontGuardOutput = false;
      window.addEventListener('pdfchef:output-ready', () => { window.__fontGuardOutput = true; });
    });
    await page.getByRole('button', { name: /^Save/ }).first().click();
    await page.getByRole('status').filter({ hasText: /cannot be changed/ }).waitFor();
    assert.equal(await page.evaluate(() => window.__fontGuardOutput), false, 'Unsupported bidirectional redraw must not produce a PDF');
    console.log('PASS covered Hebrew with digits and Latin: unsafe redraw is refused before export');
    await context.close();
  }
} finally { await browser.close(); }
