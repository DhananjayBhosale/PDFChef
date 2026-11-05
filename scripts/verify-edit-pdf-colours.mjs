/**
 * Edited words keep their colour, on screen and in the saved PDF.
 *
 * PDF.js merges neighbouring runs that share a font into one text item whatever their colour, so
 * a red "Friday" inside a black sentence used to turn black the moment the sentence was edited,
 * and a redraw saved every word in one averaged ink. This drives the editor in a real browser and
 * reads each saved word's fill colour back out of the PDF's own drawing operators.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';

const BLACK = [0, 0, 0];
const RED = [219, 26, 26];
const GREEN = [13, 140, 51];
const BLUE = [26, 64, 217];

const createFixture = async () => {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = await document.embedFont(
    await readFile('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'), { subset: false },
  );
  const page = document.addPage([595, 842]);
  const runs = (y, parts) => {
    let x = 60;
    for (const [text, [r, g, b]] of parts) {
      page.drawText(text, { x, y, size: 13, font, color: rgb(r / 255, g / 255, b / 255) });
      x += font.widthOfTextAtSize(text, 13);
    }
  };
  runs(730, [['Please sign the contract by ', BLACK], ['Friday', RED], [' at noon.', BLACK]]);
  runs(690, [['Status: ', BLACK], ['Approved', GREEN], [', ', BLACK], ['Pending', BLUE], [', ', BLACK], ['Rejected', RED]]);
  runs(650, [['Partial word: Impor', BLACK], ['tant', RED], [' notice here.', BLACK]]);
  runs(610, [['A plain black line closes the page.', BLACK]]);
  return Buffer.from(await document.save());
};

const openEditor = async (context, fixture) => {
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false,
      largeFileWarningMb: 80, onboardingComplete: true, interfaceFont: 'inter',
    }));
  });
  await page.goto(`${baseUrl}/edit`);
  await page.locator('input[type=file][accept=".pdf"]').setInputFiles({
    name: 'colours.pdf', mimeType: 'application/pdf', buffer: fixture,
  });
  await page.locator('[data-testid="pdf-text-block"]').first().waitFor({ timeout: 60_000 });
  return { page, errors };
};

const installOutputCapture = async (page) => {
  const resolvers = [];
  await page.exposeFunction('capturePdfChefColourOutput', bytes => resolvers.shift()?.(bytes));
  await page.evaluate(() => {
    window.addEventListener('pdfchef:output-ready', event => {
      event.detail.blob.arrayBuffer()
        .then(buffer => window.capturePdfChefColourOutput(Array.from(new Uint8Array(buffer))));
    });
  });
  return () => new Promise(resolve => resolvers.push(resolve));
};

/** Every shown string in drawing order, with the fill colour it was drawn in. */
const readDrawnColours = async (bytes) => {
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes) });
  const document = await task.promise;
  const operators = await (await document.getPage(1)).getOperatorList();
  await task.destroy();
  const drawn = [];
  let fill = '#000000';
  operators.fnArray.forEach((operation, index) => {
    const args = operators.argsArray[index];
    if (operation === pdfjs.OPS.setFillRGBColor) fill = typeof args[0] === 'string' ? args[0] : `#${[...args].map(value => Number(value).toString(16).padStart(2, '0')).join('')}`;
    if (operation === pdfjs.OPS.showText) {
      const text = args[0].map(glyph => glyph?.unicode ?? '').join('');
      if (text.trim()) drawn.push({ text, fill });
    }
  });
  return drawn;
};

const hexToRgb = hex => [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 8);

/** Assert that `word` was drawn, entirely, in a colour close to `expected`. */
const assertDrawnIn = (drawn, word, expected, label) => {
  const pieces = drawn.filter(piece => piece.text.includes(word));
  assert.ok(pieces.length > 0, `${label}: "${word}" is missing from the saved page (${drawn.map(piece => piece.text).join(' | ')})`);
  pieces.forEach(piece => assert.ok(near(hexToRgb(piece.fill), expected),
    `${label}: "${word}" was saved in ${piece.fill}, expected about rgb(${expected.join(', ')})`));
};

const saveAndRead = async (page, nextOutput) => {
  const output = nextOutput();
  await page.getByRole('button', { name: /^Save/ }).first().click();
  const bytes = new Uint8Array(await Promise.race([
    output,
    page.getByRole('alert').waitFor({ timeout: 30_000 }).then(async () => {
      throw new Error(`Save reported: ${await page.getByRole('alert').innerText()}`);
    }),
  ]));
  return readDrawnColours(bytes);
};

/** Put the caret `offset` characters into the text node that contains `needle`. */
const placeCaretIn = (page, needle, offset) => page.evaluate(({ needle, offset }) => {
  for (const element of document.querySelectorAll('[data-testid="pdf-text-block"]')) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.textContent.indexOf(needle);
      if (at < 0) continue;
      element.focus();
      const range = document.createRange();
      range.setStart(node, at + offset);
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return true;
    }
  }
  return false;
}, { needle, offset });

/** The colour the browser is drawing a word in while it is being edited. */
const shownColour = (page, needle) => page.evaluate((needle) => {
  for (const element of document.querySelectorAll('[data-testid="pdf-text-block"]')) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes(needle)) return getComputedStyle(node.parentElement).color;
    }
  }
  return null;
}, needle);
const cssRgb = value => (value?.match(/\d+/g) ?? []).slice(0, 3).map(Number);

const fixture = await createFixture();
const browser = await chromium.launch({ headless: true });

try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 366, height: 800, mobile: true }]) {
    const label = viewport.mobile ? 'phone' : 'desktop';
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      ...(viewport.mobile ? { hasTouch: true, isMobile: true } : {}),
    });
    const { page, errors } = await openEditor(context, fixture);
    const nextOutput = await installOutputCapture(page);

    // A red word inside a black sentence: typing in it keeps it red, and the rest stays black.
    assert.ok(await placeCaretIn(page, 'Friday', 3), 'found the red word');
    await page.keyboard.insertText('ab');
    assert.ok(near(cssRgb(await shownColour(page, 'Friabday')), RED), `${label}: the edited red word is not shown red`);
    assert.ok(near(cssRgb(await shownColour(page, 'Please sign')), BLACK), `${label}: the black text around it changed colour`);

    // A line of three colours: adding to the last word keeps all three.
    assert.ok(await placeCaretIn(page, 'Rejected', 'Rejected'.length), 'found the status line');
    await page.keyboard.insertText('!');
    assert.ok(near(cssRgb(await shownColour(page, 'Rejected!')), RED), `${label}: the last status lost its colour`);
    assert.ok(near(cssRgb(await shownColour(page, 'Approved')), GREEN), `${label}: the first status lost its colour`);

    // A word that changes colour part-way through keeps both halves.
    assert.ok(await placeCaretIn(page, 'tant', 1), 'found the partly red word');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText('e');

    // Leaving the paragraph shows the settled preview, which draws the same colours.
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pdf-block-preview"] tspan').length > 0,
      undefined, { timeout: 20_000 });

    const drawn = await saveAndRead(page, nextOutput);
    assertDrawnIn(drawn, 'Friabday', RED, label);
    assertDrawnIn(drawn, 'Please sign the contract by', BLACK, label);
    assertDrawnIn(drawn, 'at noon.', BLACK, label);
    assertDrawnIn(drawn, 'Approved', GREEN, label);
    assertDrawnIn(drawn, 'Pending', BLUE, label);
    assertDrawnIn(drawn, 'Rejected!', RED, label);
    assertDrawnIn(drawn, 'tent', RED, label);
    assertDrawnIn(drawn, 'Impor', BLACK, label);
    assertDrawnIn(drawn, 'A plain black line', BLACK, label);
    assert.deepEqual(errors, [], `${label}: console errors`);
    console.log(`PASS ${label}: edited words keep their own colours while typing, in the preview and in the saved PDF`);
    await context.close();
  }

  // A colour picked for the paragraph is a deliberate choice and applies to every word in it.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, errors } = await openEditor(context, fixture);
    const nextOutput = await installOutputCapture(page);
    assert.ok(await placeCaretIn(page, 'Approved', 0), 'found the status line');
    await page.getByLabel('More colors', { exact: true }).fill('#1a40d9');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const drawn = await saveAndRead(page, nextOutput);
    for (const word of ['Status:', 'Approved', 'Pending', 'Rejected']) assertDrawnIn(drawn, word, BLUE, 'recoloured');
    assertDrawnIn(drawn, 'Friday', RED, 'untouched paragraph');
    assert.deepEqual(errors, [], 'console errors while recolouring');
    console.log('PASS a colour picked for a paragraph applies to all of it, and nowhere else');
    await context.close();
  }
} finally {
  await browser.close();
}

console.log('Verified that Edit PDF keeps each word\'s colour.');
