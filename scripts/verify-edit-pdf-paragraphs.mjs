/**
 * End-to-end verification for the paragraph-level PDF text editor.
 *
 * The editor reconstructs paragraphs from a page's loose text runs and edits them through one
 * transparent contentEditable per paragraph. This script drives that surface in a real browser and
 * checks the three promises it makes:
 *
 *  - paragraphs are reconstructed, not guessed at word level;
 *  - an edit that fits is written back into the PDF's own text objects, adding no image and no
 *    covering rectangle, so the result stays selectable and searchable;
 *  - an edit that does not fit is redrawn instead, and says so before the user saves.
 *
 * It also pins the mobile chrome: the paragraph controls and Save have to stay inside the visible
 * viewport once a paragraph takes focus, which is exactly when mobile browsers rescale the page.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';

const HEADING = 'Quarterly Report';
const BODY = [
  'Revenue grew by eleven percent across the quarter, driven mostly by',
  'renewals in the enterprise tier. Churn stayed level at two percent, which',
  'is the fourth consecutive quarter inside the target band.',
];
const SECOND = [
  'Support volume rose slightly after the March release. The team has',
  'since closed the backlog and median response is back under an hour.',
];
const BULLETS = ['• First bullet point about pricing', '• Second bullet point about packaging'];
const LEAD_IN = 'Note:';
const LEAD_BODY = 'this stretch is the body face and continues past the lead-in above.';
const COLUMNS = 4;
const WORD_PER_OBJECT = 'Each word here is its very own separate text object indeed';
const STAMPED = [
  'Confidential draft circulated for internal review only.',
  'The second line of the stamped block sits underneath it.',
];

const createFixture = async () => {
  const document = await PDFDocument.create();
  const body = await document.embedFont(StandardFonts.Helvetica);
  const heading = await document.embedFont(StandardFonts.HelveticaBold);
  const italic = await document.embedFont(StandardFonts.HelveticaOblique);
  const page = document.addPage([595, 842]);

  page.drawText(HEADING, { x: 72, y: 760, size: 22, font: heading, color: rgb(0.1, 0.1, 0.15) });
  BODY.forEach((line, index) => page.drawText(line, { x: 72, y: 720 - index * 16, size: 11, font: body, color: rgb(0.15, 0.15, 0.15) }));
  SECOND.forEach((line, index) => page.drawText(line, { x: 72, y: 650 - index * 16, size: 11, font: body, color: rgb(0.15, 0.15, 0.15) }));
  BULLETS.forEach((line, index) => page.drawText(line, { x: 72, y: 600 - index * 16, size: 11, font: body }));

  // A bold lead-in inside one paragraph, and a two-column block below it.
  page.drawText(LEAD_IN, { x: 72, y: 560, size: 11, font: heading });
  const italicStart = LEAD_BODY.indexOf('continues');
  const regularLead = LEAD_BODY.slice(0, italicStart);
  page.drawText(regularLead, { x: 105, y: 560, size: 11, font: body });
  page.drawText(LEAD_BODY.slice(italicStart), {
    x: 105 + body.widthOfTextAtSize(regularLead, 11), y: 560, size: 11, font: italic,
  });
  for (let line = 0; line < COLUMNS; line += 1) {
    page.drawText(`Left column line ${line + 1}`, { x: 72, y: 520 - line * 14, size: 10, font: body });
    page.drawText(`Right column line ${line + 1}`, { x: 340, y: 520 - line * 14, size: 10, font: body });
  }

  return Buffer.from(await document.save());
};

/**
 * A page that sets each word as its own text object and stores no spaces at all.
 *
 * This is how most typeset PDFs are built — a form drawing "1040" as four separately placed
 * digits, or anything from TeX — and it is the shape that defeats matching a visible word against
 * one text object. The paragraph's originals still have to leave the file when it is redrawn.
 */
const createWordPerObject = async () => {
  const document = await PDFDocument.create();
  const body = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  let x = 72;
  for (const word of WORD_PER_OBJECT.split(' ')) {
    page.drawText(word, { x, y: 700, size: 12, font: body });
    // Advance past the word plus a gap, leaving no space character anywhere in the file.
    x += body.widthOfTextAtSize(`${word} `, 12);
  }
  return Buffer.from(await document.save());
};

/**
 * A page carrying the kind of checkbox a real form uses: a few points across, with a neighbour
 * close by and a line of text beside it.
 */
const createTinyCheckboxes = async () => {
  const document = await PDFDocument.create();
  const body = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  const form = document.getForm();
  page.drawText('Tick the box that applies to you and then read the rest of this line.', {
    x: 72, y: 700, size: 11, font: body,
  });
  // Two boxes with room around them, as a form's classification row has, and two crowded together
  // so the cap that stops one field taking its neighbour's tap is exercised as well.
  ['first', 'second'].forEach((name, index) => {
    const box = form.createCheckBox(`roomy.${name}`);
    box.addToPage(page, { x: 72 + index * 90, y: 660, width: 8, height: 8 });
  });
  ['left', 'right'].forEach((name, index) => {
    const box = form.createCheckBox(`crowded.${name}`);
    box.addToPage(page, { x: 72 + index * 12, y: 620, width: 8, height: 8 });
  });
  return Buffer.from(await document.save());
};

/**
 * A page that draws part of itself through a form XObject.
 *
 * That is how a stamp, a watermark or an imposed page carries its text, and the objects inside one
 * are not reachable from the page. A redraw has to follow the page into the form to take the old
 * wording out, or the words the reader replaced are still in the file for a search to find.
 */
const createFormXObjectPage = async () => {
  const inner = await PDFDocument.create();
  const innerFont = await inner.embedFont(StandardFonts.Helvetica);
  const innerPage = inner.addPage([595, 842]);
  STAMPED.forEach((line, index) => innerPage.drawText(line, {
    x: 72, y: 700 - index * 20, size: 13, font: innerFont,
  }));

  const outer = await PDFDocument.create();
  const outerFont = await outer.embedFont(StandardFonts.Helvetica);
  const page = outer.addPage([595, 842]);
  page.drawText('A heading the page draws for itself.', { x: 72, y: 780, size: 13, font: outerFont });
  page.drawPage(await outer.embedPage(innerPage), { x: 0, y: 0, width: 595, height: 842 });
  return Buffer.from(await outer.save());
};

/** A page whose only content is a picture: nothing to edit, and the editor must say so. */
const createScan = async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==',
    'base64');
  page.drawImage(await document.embedPng(png), { x: 40, y: 40, width: 515, height: 762 });
  return Buffer.from(await document.save());
};

const errorsByPage = new WeakMap();

const openEditor = async (context, fixture) => {
  const page = await context.newPage();
  const consoleErrors = [];
  errorsByPage.set(page, consoleErrors);
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.message));

  await page.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false,
      keepLocalHistory: false,
      confirmLargeJobs: false,
      largeFileWarningMb: 80,
      onboardingComplete: true,
      interfaceFont: 'inter',
    }));
  });

  await page.goto(`${baseUrl}/edit`);
  await page.locator('input[type=file][accept=".pdf"]').setInputFiles({
    name: 'report.pdf', mimeType: 'application/pdf', buffer: fixture,
  });
  // A scanned page never produces a paragraph, so the wait is on the rendered page itself.
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  return { page, consoleErrors };
};

const waitForParagraphs = (page) =>
  page.locator('[data-testid="pdf-text-block"]').first().waitFor({ timeout: 60_000 });

/**
 * Wait for the editor to work out what a save would do.
 *
 * Planning a paragraph measures every word of it, so it settles a moment after the last keystroke
 * rather than running on each one. Reading the sentence before then gets the previous answer.
 */
const waitForPlan = async (page, outcome = 'goes straight into the document|will be redrawn|cannot be changed') => {
  await page.waitForFunction(
    pattern => new RegExp(pattern, 'i').test(
      document.querySelector('[data-testid="pdf-paragraph-provenance"]')?.textContent ?? '',
    ),
    outcome,
    { timeout: 20_000 },
  );
  return page.getByTestId('pdf-paragraph-provenance').innerText();
};

/** Capture the bytes the editor produces without going through a download. */
const installOutputCapture = async (page) => {
  const resolvers = [];
  await page.exposeFunction('capturePdfChefParagraphOutput', bytes => resolvers.shift()?.(bytes));
  await page.evaluate(() => {
    window.addEventListener('pdfchef:output-ready', event => {
      event.detail.blob.arrayBuffer()
        .then(buffer => window.capturePdfChefParagraphOutput(Array.from(new Uint8Array(buffer))));
    });
  });
  return () => new Promise(resolve => resolvers.push(resolve));
};

const saveAndRead = async (page, nextOutput, pageCount = 1) => {
  const output = nextOutput();
  await page.getByRole('button', { name: /^Save/ }).first().click();
  const bytes = new Uint8Array(await Promise.race([
    output,
    page.getByRole('alert').waitFor({ timeout: 30_000 })
      .then(async () => { throw new Error(
        `Save reported: ${await page.getByRole('alert').innerText()}\n${(errorsByPage.get(page) ?? []).join('\n')}`,
      ); }),
  ]));
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes) });
  const document = await task.promise;
  const first = await document.getPage(1);
  const operators = await first.getOperatorList();
  const items = (await first.getTextContent()).items;
  const pages = [];
  for (let index = 1; index <= Math.min(pageCount, document.numPages); index += 1) {
    pages.push((await (await document.getPage(index)).getTextContent()).items.map(item => item.str).join(''));
  }
  await task.destroy();
  return { bytes, text: pageCount === 1 ? pages[0] : pages, operators, items };
};

/** Find one run in a PDF by its text, and report the matrix it is drawn with. */
const readRunAppearance = async (bytes, pattern) => {
  // pdf.js takes ownership of the buffer it is handed, so every read gets its own copy.
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes) });
  const document = await task.promise;
  const page = await document.getPage(1);
  const item = (await page.getTextContent()).items.find(entry => pattern.test(entry.str));
  await task.destroy();
  return item ? { text: item.str, transform: item.transform } : null;
};

/** Put a collapsed caret `offset` characters into a paragraph's first line. */
const placeCaret = (page, index, offset) => page.evaluate(({ index, offset }) => {
  const element = document.querySelectorAll('[data-testid="pdf-text-block"]')[index];
  element.focus();
  const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}, { index, offset });

/** Replace `count` characters at the start of the focused paragraph. */
const retypeStart = (page, index, count, replacement) => page.evaluate(({ index, count }) => {
  const element = document.querySelectorAll('[data-testid="pdf-text-block"]')[index];
  element.focus();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, count);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}, { index, count }).then(() => page.keyboard.insertText(replacement));

/** Read actual painted glyph rows, independently of CSS line-height or the editor's line model. */
const paragraphGeometry = (paragraph) => paragraph.evaluate(element => {
  const box = element.getBoundingClientRect();
  const page = element.closest('[role="group"][aria-label^="Page "]');
  const pageBox = page.getBoundingClientRect();
  const scale = pageBox.height / 842;
  const rows = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    for (let index = 0; index < node.length; index += 1) {
      if (/\s/.test(node.textContent[index])) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const top = (rect.top - pageBox.top) / scale;
      const bottom = (rect.bottom - pageBox.top) / scale;
      const row = rows.find(candidate => Math.abs(candidate.top - top) < 0.25);
      if (row) row.text += node.textContent[index];
      else rows.push({ top, bottom, text: node.textContent[index] });
    }
  }
  // Chromium leaves one final newline as a caret placeholder after Enter at the end.
  const text = element.innerText.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return {
    text,
    newlines: (text.match(/\n/g) ?? []).length,
    rows,
    top: (box.top - pageBox.top) / scale,
    height: box.height / scale,
    whiteSpace: getComputedStyle(element).whiteSpace,
    overflowWrap: getComputedStyle(element).overflowWrap,
    wordBreak: getComputedStyle(element).wordBreak,
    editable: element.isContentEditable,
  };
});

const assertSameGeometry = (before, after, label) => {
  assert.equal(after.newlines, before.newlines, `${label}: an explicit newline appeared`);
  assert.equal(after.rows.length, before.rows.length, `${label}: Chromium introduced a visual line`);
  assert.equal(after.whiteSpace, 'pre', `${label}: existing text enabled incidental CSS wrapping`);
  assert.equal(after.overflowWrap, 'normal', `${label}: overflow-wrap may split PDF lines`);
  assert.equal(after.wordBreak, 'normal', `${label}: word-break may split PDF lines`);
  assert.ok(after.editable, `${label}: existing text stopped being contentEditable`);
  assert.ok(Math.abs(after.top - before.top) <= 0.25, `${label}: the PDF-relative block top moved`);
  assert.ok(Math.abs(after.height - before.height) <= 0.25, `${label}: the block height changed`);
  before.rows.forEach((row, index) => {
    assert.ok(Math.abs(after.rows[index].top - row.top) <= 0.25, `${label}: line ${index + 1} top moved`);
    assert.ok(Math.abs(after.rows[index].bottom - row.bottom) <= 0.25, `${label}: line ${index + 1} baseline moved`);
  });
};

const spanAppearance = (paragraph) => paragraph.evaluate(element =>
  [...element.querySelectorAll('span')].map(span => {
    const style = getComputedStyle(span);
    return {
      text: span.textContent,
      font: span.dataset.font,
      family: style.fontFamily,
      weight: style.fontWeight,
      italic: style.fontStyle,
      wordSpacing: style.wordSpacing,
      letterSpacing: style.letterSpacing,
    };
  }));

const caretOffset = (paragraph) => paragraph.evaluate(element => {
  const selection = getSelection();
  if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return -1;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
});

const undoTyping = (page) => page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');

const normalizedLine = text => text.replace(/\s+/g, ' ').trim();
const exportedLines = items => {
  const rows = new Map();
  for (const item of items) {
    if (!item.str) continue;
    const baseline = item.transform[5].toFixed(2);
    const row = rows.get(baseline) ?? [];
    row.push(item);
    rows.set(baseline, row);
  }
  return [...rows.values()].map(row => normalizedLine(
    row.sort((left, right) => left.transform[4] - right.transform[4]).map(item => item.str).join(''),
  ));
};

/** Twelve pages that all say the same thing, for checking find and replace across a document. */
const createMultipage = async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 12; index += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`Page ${index + 1} heading`, { x: 72, y: 760, size: 18, font });
    for (let line = 0; line < 3; line += 1) {
      page.drawText(`Page ${index + 1} body line ${line + 1} with enough words to form a paragraph.`,
        { x: 72, y: 720 - line * 16, size: 11, font });
    }
  }
  return Buffer.from(await document.save());
};

/** The PostScript name each of these strings ends up drawn with in the saved file. */
const readFaces = async (bytes, texts) => {
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), fontExtraProperties: true, useSystemFonts: false });
  const document = await task.promise;
  const page = await document.getPage(1);
  const items = (await page.getTextContent()).items;
  // Font objects are only published once the page's drawing operations have been resolved.
  await page.getOperatorList();
  const names = texts.map((text) => {
    const item = items.find(entry => entry.str.includes(text));
    if (!item) return '';
    try {
      return page.commonObjs.get(item.fontName)?.name ?? item.fontName;
    } catch {
      return item.fontName;
    }
  });
  await task.destroy();
  return names;
};

const imageOperatorSet = new Set([
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintImageMaskXObject,
].filter(operation => typeof operation === 'number'));

const fixture = await createFixture();
const multipage = await createMultipage();
const browser = await chromium.launch({ headless: true });

try {
  // Real PDFs commonly store a visible line as separate words or glyphs. A fitting edit must
  // keep their embedded font, with no substitute face or background cover in the saved PDF.
  for (const glyphs of [false, true]) {
    const document = await PDFDocument.create();
    document.registerFontkit(fontkit);
    const font = await document.embedFont(await readFile('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
    const sheet = document.addPage([595, 842]);
    const original = 'Device note';
    const replacement = 'Device tone';
    let x = 72;
    for (const part of glyphs ? [...original] : ['Device ', 'note']) {
      sheet.drawText(part, { x, y: 720, size: 16, font });
      x += font.widthOfTextAtSize(part, 16);
    }
    sheet.drawText('The next line stays here.', { x: 72, y: 690, size: 16, font });
    const bytes = Buffer.from(await document.save());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, bytes);
    await waitForParagraphs(page);
    const paragraph = page.getByTestId('pdf-text-block').first();
    await paragraph.click();
    const before = await paragraphGeometry(paragraph);
    const fontsBefore = await spanAppearance(paragraph);
    if (!glyphs) await page.evaluate(() => {
      window.__deferredPreviewCallbacks = [];
      window.requestIdleCallback = callback => window.__deferredPreviewCallbacks.push(callback);
    });
    await retypeStart(page, 0, original.length, replacement);
    assertSameGeometry(before, await paragraphGeometry(paragraph), 'embedded fragmented run');
    assert.deepEqual((await spanAppearance(paragraph)).map(({family, font}) => ({family, font})),
      fontsBefore.map(({family, font}) => ({family, font})), 'typing changed the embedded overlay font');
    const nextOutput = await installOutputCapture(page);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    if (!glyphs) await page.waitForFunction(() => window.__deferredPreviewCallbacks.length > 0);
    const result = await saveAndRead(page, nextOutput);
    assert.ok(result.text.includes(replacement), 'fragmented replacement was not saved');
    assert.deepEqual(await readFaces(result.bytes, [replacement, 'The next']),
      await readFaces(bytes, [original, 'The next']), 'Save substituted the embedded font');
    for (const [oldText, newText] of [[original, replacement], ['The next', 'The next']]) {
      const oldRun = await readRunAppearance(bytes, new RegExp(oldText));
      const newRun = await readRunAppearance(result.bytes, new RegExp(newText));
      oldRun.transform.forEach((value, index) => {
        assert.ok(Math.abs(value - newRun.transform[index]) < 0.02, 'Save changed a baseline, size or transform');
      });
    }
    assert.equal(result.operators.fnArray.some(operation => imageOperatorSet.has(operation)), false);
    assert.deepEqual(consoleErrors, []);
    console.log(`PASS ${glyphs ? 'glyph' : 'word'} objects retain their embedded font and baselines through typing, Done and Save`);
    if (!glyphs) console.log('PASS direct Save completes while the preview-render queue is paused');
    await context.close();
  }

  for (const align of ['center', 'right']) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const sheet = document.addPage([595, 842]);
    const originalLines = ['Centered text label', 'Second line'];
    originalLines.forEach((text, index) => sheet.drawText(text, {
      x: 72 + (240 - font.widthOfTextAtSize(text, 12)) / (align === 'center' ? 2 : 1),
      y: 720 - index * 16, size: 12, font,
    }));
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, Buffer.from(await document.save()));
    await waitForParagraphs(page);
    const paragraph = page.getByTestId('pdf-text-block').first();
    await paragraph.click();
    assert.equal(await paragraph.evaluate(element => getComputedStyle(element).textAlign), align);
    await placeCaret(page, 0, 8);
    await page.keyboard.press('Enter');
    await waitForPlan(page);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const preview = page.getByTestId('pdf-block-preview');
    await preview.waitFor();
    const geometry = await preview.evaluate(svg => {
      const box = svg.getBoundingClientRect();
      const page = svg.closest('[data-pdf-page]').getBoundingClientRect();
      return { left: (box.left - page.left) / (page.width / 595), width: svg.viewBox.baseVal.width,
        pieces: [...svg.querySelectorAll('[data-preview-line]')].map(piece => ({
          text: piece.textContent, x: Number(piece.getAttribute('x')),
          width: Number(piece.getAttribute('textLength')),
        })) };
    });
    assert.equal(geometry.pieces.length, 3, `${align}: Enter did not create exactly one row`);
    const divisor = align === 'center' ? 2 : 1;
    geometry.pieces.forEach(piece => assert.ok(
      Math.abs(piece.x + piece.width / divisor - geometry.width / divisor) < 0.02,
      `${align}: Done lost the paragraph alignment`,
    ));
    const nextOutput = await installOutputCapture(page);
    const result = await saveAndRead(page, nextOutput);
    for (const piece of geometry.pieces) {
      const item = result.items.find(item => item.str.trim() === piece.text.trim());
      assert.ok(item, `${align}: saved row is missing`);
      // PDF.js may omit a leading space from extraction, moving the reported origin to the ink.
      const prefix = piece.text.slice(0, Math.max(0, piece.text.indexOf(item.str)));
      const prefixWidth = font.widthOfTextAtSize(prefix, 12);
      assert.ok(Math.abs(item.transform[4] - geometry.left - piece.x - prefixWidth) < 0.25,
        `${align}: saved row differs from the aligned preview`);
    }
    assert.deepEqual(consoleErrors, []);
    console.log(`PASS ${align} alignment survives Enter, Done and exported line placement`);
    await context.close();
  }

  // Extending an amount must not acquire a newline when finishing or saving the edit.
  {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const sheet = document.addPage([595, 842]);
    sheet.drawText('2099 Dr', { x: 480, y: 700, size: 12, font });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, Buffer.from(await document.save()));
    await waitForParagraphs(page);
    const paragraph = page.getByTestId('pdf-text-block').first();
    for (let step = 0; step < 4; step += 1) {
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    }
    await paragraph.click();
    const original = await paragraphGeometry(paragraph);
    // Chromium can replace a whole run with an untagged span, dropping its calibrated baseline.
    await retypeStart(page, 0, 7, '3099 Dr');
    assertSameGeometry(original, await paragraphGeometry(paragraph), 'whole-run replacement');
    assert.equal(await caretOffset(paragraph), 7, 'repairing a replaced run reset the caret');
    await undoTyping(page);
    assertSameGeometry(original, await paragraphGeometry(paragraph), 'undo whole-run replacement');
    assert.equal((await paragraphGeometry(paragraph)).text, original.text, 'Undo did not restore the replaced text');
    const outline = page.getByTestId('pdf-block-outline');
    await outline.waitFor();
    const target = await paragraph.boundingBox();
    const frame = await outline.boundingBox();
    assert.ok(frame.y > target.y + 2, 'the visible outline included the expanded touch target above the text');
    assert.ok(frame.y + frame.height < target.y + target.height - 2,
      'the touch target must also extend below the visible text outline');
    await placeCaret(page, 0, 7);
    await page.keyboard.insertText(' fdagadga');
    await waitForPlan(page);
    assertSameGeometry(original, await paragraphGeometry(paragraph), 'extended amount while typing');
    const warning = page.getByTestId('pdf-block-overflow');
    await warning.waitFor();
    const warningBox = await warning.boundingBox();
    const viewportBox = await page.getByTestId('pdf-zoom-viewport').boundingBox();
    assert.ok(warningBox.x >= viewportBox.x && warningBox.x + warningBox.width <= viewportBox.x + viewportBox.width,
      `the overflow hint is clipped at the right edge: ${JSON.stringify({ warningBox, viewportBox })}`);
    const nextOutput = await installOutputCapture(page);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const preview = page.getByTestId('pdf-block-preview');
    await preview.waitFor();
    const pieces = await preview.locator('[data-preview-line]').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent, line: Number(node.dataset.previewLine),
      baseline: Number(node.getAttribute('y')), x: Number(node.getAttribute('x')),
    })));
    assert.equal(new Set(pieces.map(piece => piece.line)).size, 1, 'Done wrapped the extended amount without Enter');
    assert.equal(pieces.map(piece => piece.text).join(''), '2099 Dr fdagadga');
    const previewTop = await preview.evaluate(svg => {
      const page = svg.closest('[role="group"][aria-label^="Page "]').getBoundingClientRect();
      return (svg.getBoundingClientRect().top - page.top) / (page.height / 842);
    });
    assert.ok(Math.abs(previewTop + pieces[0].baseline - 142) < 0.25, 'Done moved the original amount baseline');
    const saved = await saveAndRead(page, nextOutput);
    const amount = saved.items.find(item => item.str.includes('2099'));
    assert.equal(amount?.str, '2099 Dr fdagadga', 'Save split the amount onto another line');
    assert.ok(Math.abs(amount.transform[5] - 700) < 0.25, 'Save moved the original amount baseline');
    assert.ok(Math.abs(amount.transform[4] - 480) < 0.25, 'Save moved the original amount horizontally');
    assert.deepEqual(consoleErrors, []);
    await context.close();
    console.log('PASS extended amount stays on its original line and baseline after Done and Save');
  }

  // A statement column has alternating wrapped-line and row gaps, with rules through its box.
  // Keep this synthetic: statements used to report the bug contain private financial details.
  {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const sheet = document.addPage([595, 842]);
    const baselines = [700, 681, 666, 647, 632, 613, 598];
    const words = ['Details', 'Market purchase', 'City branch', 'Market purchase', 'City branch', 'Market purchase', 'City branch'];
    baselines.forEach((y, index) => sheet.drawText(words[index], { x: 220, y, size: 12, font }));
    const ruleY = 694;
    for (const y of [706, ruleY, 660, 626, 592]) {
      sheet.drawLine({ start: { x: 60, y }, end: { x: 490, y }, thickness: 1 });
    }
    const table = Buffer.from(await document.save());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, table);
    await waitForParagraphs(page);
    const paragraph = page.getByTestId('pdf-text-block').first();
    await paragraph.click();
    const before = await paragraphGeometry(paragraph);
    assert.equal(before.rows.length, baselines.length);
    before.rows.forEach((row, index) => assert.ok(
      Math.abs((row.top - before.rows[0].top) - (baselines[0] - baselines[index])) < 0.3,
      `statement row ${index + 1}: the caret layer replaced PDF spacing with a uniform line pitch`,
    ));
    const wordPoint = await paragraph.locator('span[data-pdf-line="5"]').first().evaluate(span => {
      const range = document.createRange();
      range.setStart(span.firstChild, 7); range.setEnd(span.firstChild, 15);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.dblclick(wordPoint.x, wordPoint.y);
    assert.equal(await page.evaluate(() => getSelection().toString()), 'purchase',
      'double-clicking the visible word selected text from a different PDF row');
    await retypeStart(page, 0, 7, 'Detailx');
    assertSameGeometry(before, await paragraphGeometry(paragraph), 'table replacement');
    const nextOutput = await installOutputCapture(page);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForFunction(() => {
      const patch = document.querySelector('[data-testid="pdf-block-patch"]');
      return patch && getComputedStyle(patch).backgroundImage !== 'none';
    });
    const rulePixel = await page.evaluate(async ({ x, y }) => {
      const patch = document.querySelector('[data-testid="pdf-block-patch"]');
      const editor = document.querySelector('[data-testid="pdf-text-block"]');
      const page = editor.closest('[data-pdf-page]');
      const scale = page.getBoundingClientRect().height / 842;
      const box = patch.getBoundingClientRect();
      const origin = page.getBoundingClientRect();
      const url = getComputedStyle(patch).backgroundImage.slice(5, -2);
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const px = (origin.left + x * scale - box.left) / box.width * image.width;
      const py = (origin.top + y * scale - box.top) / box.height * image.height;
      return [...context.getImageData(Math.round(px), Math.round(py), 1, 1).data];
    }, { x: 240, y: 842 - ruleY });
    assert.ok(rulePixel[0] < 100, 'editing painted over the table rule in the preview');
    const direct = await saveAndRead(page, nextOutput);
    assert.match(direct.text, /Detailx/);

    // Force a redraw too: after deleting only text, export must retain the original vector rules.
    await paragraph.click();
    await retypeStart(page, 0, 7, 'A substantially longer description for this table column');
    await waitForPlan(page);
    const redrawn = await saveAndRead(page, nextOutput);
    const untouchedRows = redrawn.items.filter(item => ['Market purchase', 'City branch'].includes(item.str));
    assert.deepEqual(untouchedRows.map(item => Math.round(item.transform[5])), baselines.slice(1),
      'redrawing the edited heading moved untouched table rows');
    const reopened = await openEditor(context, Buffer.from(redrawn.bytes));
    await waitForParagraphs(reopened.page);
    const pixel = await reopened.page.locator('canvas').first().evaluate((canvas, y) => {
      const scale = canvas.width / 595;
      return [...canvas.getContext('2d').getImageData(Math.round(300 * scale), Math.round(y * scale), 1, 1).data];
    }, 842 - ruleY);
    assert.ok(pixel[0] < 100, 'redraw export painted a rectangle over the table rule');
    assert.deepEqual(consoleErrors, []);
    await context.close();
    console.log('PASS statement row positions and table rules survive direct edits, Done and redraw export');
  }
  // --- Fitting replacements keep every PDF row; Enter is the only added hard break ------------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, fixture);
    await waitForParagraphs(page);
    const paragraph = page.getByTestId('pdf-text-block').nth(1);
    await paragraph.click();
    await page.evaluate(() => document.fonts.ready);
    const before = await paragraphGeometry(paragraph);
    const originalSpans = await spanAppearance(paragraph);
    assert.equal(before.rows.length, BODY.length, 'the fixture must start with the original PDF rows');
    assert.equal(before.newlines, BODY.length - 1);

    await retypeStart(page, 1, 'Revenue'.length, 'Profits');
    assertSameGeometry(before, await paragraphGeometry(paragraph), 'equal-length replacement');
    assert.equal(await caretOffset(paragraph), 'Profits'.length, 'a replacement reset the caret');
    assert.deepEqual((await spanAppearance(paragraph)).slice(1), originalSpans.slice(1),
      'editing the first run changed an untouched line or its spacing correction');

    await retypeStart(page, 1, 'Profits'.length, 'Sales');
    assertSameGeometry(before, await paragraphGeometry(paragraph), 'short fitting replacement');
    assert.equal(await caretOffset(paragraph), 'Sales'.length, 'a shorter replacement reset the caret');
    console.log('PASS equal-length and shorter edits preserve explicit rows, glyph positions, height and caret');

    const enterParagraph = page.getByTestId('pdf-text-block').nth(2);
    await enterParagraph.click();
    const original = await paragraphGeometry(enterParagraph);
    for (const atEnd of [false, true]) {
      if (atEnd) {
        await enterParagraph.evaluate(element => {
          element.focus();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        });
      } else await placeCaret(page, 2, 7);
      await page.keyboard.press('Enter');
      const entered = await paragraphGeometry(enterParagraph);
      assert.equal(entered.newlines, original.newlines + 1,
        `Enter ${atEnd ? 'at the end' : 'inside text'} must create exactly one intentional newline`);
      assert.equal(entered.whiteSpace, 'pre', 'Enter must not enable browser wrapping');
      assert.ok(entered.editable, 'Enter disabled paragraph editing');
      await undoTyping(page);
      await page.waitForFunction(({ index, text }) =>
        document.querySelectorAll('[data-testid="pdf-text-block"]')[index]
          ?.innerText.replace(/\n$/, '') === text,
      { index: 2, text: original.text });
      const restored = await paragraphGeometry(enterParagraph);
      assert.equal(restored.text, original.text, 'Undo failed to remove the deliberate newline');
      assertSameGeometry(original, restored, 'undo Enter');
    }
    console.log('PASS Enter inside a line and at paragraph end adds one newline; Undo restores its geometry');

    const mixed = page.getByTestId('pdf-text-block').nth(5);
    await mixed.click();
    const facesBefore = await spanAppearance(mixed);
    assert.ok(new Set(facesBefore.map(span => span.font)).size >= 3,
      'the mixed-style fixture must include bold, regular and italic PDF faces');
    await placeCaret(page, 5, 1);
    await page.keyboard.type('x');
    const facesAfter = await spanAppearance(mixed);
    assert.deepEqual(facesAfter.slice(1), facesBefore.slice(1),
      'editing the bold run flattened an untouched font, style or spacing correction');
    assert.equal(await caretOffset(mixed), 2, 'editing a mixed-style run reset the caret');
    console.log('PASS typing in one run retains untouched regular and italic faces and spacing');

    await undoTyping(page);
    await retypeStart(page, 5, LEAD_IN.length, 'Memo:');
    const repairedFaces = await spanAppearance(mixed);
    assert.equal(repairedFaces[0].font, facesBefore[0].font, 'replacing the entire bold run lost its font');
    assert.equal(repairedFaces[0].family, facesBefore[0].family);
    assert.deepEqual(repairedFaces.slice(1), facesBefore.slice(1), 'repair flattened untouched mixed fonts');
    assert.equal(await caretOffset(mixed), 5, 'repairing a styled run lost the caret');
    await undoTyping(page);

    // Real Chromium IME events: an in-progress composition must retain its browser-owned node.
    await placeCaret(page, 5, 1);
    const originalNode = await mixed.locator('span').first().elementHandle();
    const ime = await context.newCDPSession(page);
    await ime.send('Input.imeSetComposition', { text: 'x', selectionStart: 1, selectionEnd: 1 });
    assert.ok(await originalNode.evaluate(node => node.isConnected), 'composition replaced the native text node');
    await ime.send('Input.insertText', { text: 'x' });
    assert.match(await mixed.innerText(), /^Nxote:/, 'IME commit lost or duplicated the composed character');
    assert.equal(await caretOffset(mixed), 2, 'IME commit reset the caret');
    await ime.detach();
    await undoTyping(page);
    assert.equal((await mixed.innerText()).split(' ')[0], LEAD_IN, 'Undo did not restore the IME edit');
    console.log('PASS full-run replacement retains styling and caret; native IME composition and Undo remain functional');

    assert.deepEqual(consoleErrors, [], 'console errors during explicit-line regression checks');
    await context.close();
  }

  // --- Paragraph reconstruction and a direct, in-place edit -------------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, fixture);

    await waitForParagraphs(page);
    const blocks = await page.locator('[data-testid="pdf-text-block"]').evaluateAll(
      elements => elements.map(element => element.innerText),
    );
    assert.deepEqual(blocks, [
      HEADING,
      BODY.join('\n'),
      SECOND.join('\n'),
      BULLETS[0],
      BULLETS[1],
      `${LEAD_IN} ${LEAD_BODY}`,
      Array.from({ length: COLUMNS }, (_, line) => `Left column line ${line + 1}`).join('\n'),
      Array.from({ length: COLUMNS }, (_, line) => `Right column line ${line + 1}`).join('\n'),
    ], 'paragraphs were not reconstructed as whole paragraphs');
    console.log('PASS paragraphs reconstructed from loose text runs, columns kept apart');

    // Each run keeps the face the PDF drew it in. When the document's own faces are available the
    // overlay uses them directly, so the lead-in is bold because its face is bold rather than
    // because a weight was synthesised on top of the body face — either way the two must differ.
    const leadIn = await page.locator('[data-testid="pdf-text-block"]').nth(5).evaluate(element =>
      [...element.querySelectorAll('span')].map(span => ({
        text: span.textContent,
        face: span.dataset.font,
        family: getComputedStyle(span).fontFamily,
        weight: getComputedStyle(span).fontWeight,
      })));
    const body = leadIn[leadIn.length - 1];
    assert.equal(leadIn[0].text, LEAD_IN);
    assert.notEqual(leadIn[0].face, body.face, 'the lead-in and the body were read as one face');
    assert.ok(
      leadIn[0].family !== body.family || leadIn[0].weight !== body.weight,
      `the lead-in is drawn exactly like the body: ${JSON.stringify(leadIn[0])} vs ${JSON.stringify(body)}`,
    );
    console.log('PASS a paragraph that mixes faces keeps each one');

    const untouched = await page.locator('[data-testid="pdf-text-block"]').first().evaluate(
      element => getComputedStyle(element).color,
    );
    assert.equal(untouched, 'rgba(0, 0, 0, 0)', 'an unedited paragraph must let the page show through');
    console.log('PASS unedited paragraphs stay transparent over the rendered page');

    // Typing one character at a time is the case that breaks if anything re-renders the editable's
    // children: the selection points at the text node that gets replaced, so the caret snaps back
    // to the start and the word comes out reversed.
    await waitForParagraphs(page);
    await page.locator('[data-testid="pdf-text-block"]').nth(1).click();
    await placeCaret(page, 1, 7);
    for (const character of 'ABCDE') {
      await page.keyboard.type(character);
      await page.waitForTimeout(60);
    }
    const typed = await page.locator('[data-testid="pdf-text-block"]').nth(1).evaluate(
      element => element.innerText.split('\n')[0],
    );
    assert.match(typed, /^RevenueABCDE grew by eleven percent/, `typing did not land in order: ${typed}`);
    const caret = await page.evaluate(() => {
      const element = document.querySelectorAll('[data-testid="pdf-text-block"]')[1];
      const selection = getSelection();
      const probe = document.createRange();
      probe.selectNodeContents(element);
      probe.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
      return probe.toString().length;
    });
    assert.equal(caret, 12, 'the caret did not stay where the typing left it');
    console.log('PASS typing one character at a time keeps its order and the caret');

    // Back to the original so the direct-edit checks below start from a known paragraph.
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('Backspace');

    const nextOutput = await installOutputCapture(page);
    await page.locator('[data-testid="pdf-text-block"]').nth(1).click();
    await retypeStart(page, 1, 'Revenue'.length, 'Profits');
    // The earlier ABCDE insertion had a redraw plan; wait for this fitting edit's new answer.
    const provenance = await waitForPlan(page, 'goes straight into the document');
    assert.match(provenance, /goes straight into the document/i, `expected a direct edit, got: ${provenance}`);
    console.log('PASS an edit that fits is planned as a direct rewrite');

    const direct = await saveAndRead(page, nextOutput);
    assert.match(direct.text, /Profits grew by eleven percent/, 'the edited word is missing from the saved PDF');
    assert.match(direct.text, /is the fourth consecutive quarter/, 'untouched lines were lost');
    assert.match(direct.text, new RegExp(HEADING), 'the heading was lost');

    assert.equal(
      direct.operators.fnArray.some(operation => imageOperatorSet.has(operation)),
      false,
      'a direct edit must not paint an image patch over the page',
    );
    console.log('PASS the saved PDF keeps the text as text, with no image patch');

    // A direct rewrite must not restyle what it touches: the run keeps the size and the transform
    // the document gave it, which is what makes the edit invisible next to its neighbours.
    const appearance = await readRunAppearance(direct.bytes, /^Profits/);
    const original = await readRunAppearance(fixture, /^Revenue/);
    assert.ok(appearance && original, 'the edited run could not be located in either file');
    assert.deepEqual(
      appearance.transform.slice(0, 4).map(value => Number(value.toFixed(4))),
      original.transform.slice(0, 4).map(value => Number(value.toFixed(4))),
      'the direct edit changed the text matrix, so the run was restyled',
    );
    assert.ok(
      Math.abs(appearance.transform[5] - original.transform[5]) < 0.01,
      'the direct edit moved the baseline',
    );
    console.log('PASS the rewritten run keeps its original size, style and baseline');

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    const reverted = await page.locator('[data-testid="pdf-text-block"]').nth(1).innerText();
    assert.ok(reverted.startsWith('Profits') || reverted.startsWith('Revenue'), 'paragraph text became unreadable');

    assert.deepEqual(consoleErrors, [], 'console errors during the direct edit');
    await context.close();
  }

  // --- An edit that outgrows its space is redrawn, and says so ---------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, fixture);
    const nextOutput = await installOutputCapture(page);

    await waitForParagraphs(page);
    const paragraph = page.getByTestId('pdf-text-block').nth(2);
    await paragraph.click();
    const before = await paragraphGeometry(paragraph);
    const blockId = await paragraph.getAttribute('data-block-id');
    await page.evaluate(() => {
      const element = document.querySelectorAll('[data-testid="pdf-text-block"]')[2];
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.insertText(' Additional details.');
    const provenance = await waitForPlan(page);
    assert.match(provenance, /will be redrawn/i, `expected a redraw, got: ${provenance}`);
    assert.match(provenance, /will not wrap automatically/i, 'the editor must explain that it preserves explicit lines');
    assertSameGeometry(before, await paragraphGeometry(paragraph), 'focused overflow');
    assert.match(await page.getByTestId('pdf-block-overflow').innerText(), /Press Enter for a new line/i,
      'horizontal overflow must leave the line-break decision with the user');
    await paragraph.evaluate(element => element.blur());
    const preview = page.locator(`[data-testid="pdf-block-preview"][data-preview-block-id="${blockId}"]`);
    await preview.waitFor();
    const previewLines = await preview.locator('[data-preview-line]').evaluateAll(pieces => {
      const lines = new Map();
      pieces.forEach(piece => {
        const line = Number(piece.getAttribute('data-preview-line'));
        lines.set(line, (lines.get(line) ?? '') + piece.textContent);
      });
      return [...lines.entries()].sort(([left], [right]) => left - right).map(([, text]) => text);
    });
    assert.equal(previewLines.length, before.rows.length, 'Done must not introduce soft lines');
    assertSameGeometry(before, await paragraphGeometry(paragraph), 'finished overflow');
    console.log('PASS longer text keeps its explicit rows after Done, with horizontal overflow stated');

    const reflowed = await saveAndRead(page, nextOutput);
    assert.match(reflowed.text, /Additional details\./, 'the appended text is missing from the saved PDF');
    assert.match(reflowed.text, new RegExp(HEADING), 'redrawing one paragraph disturbed the rest of the page');
    const savedLines = exportedLines(reflowed.items);
    for (const line of previewLines) {
      assert.ok(savedLines.includes(normalizedLine(line)),
        `the preview line differs from the exported PDF: ${JSON.stringify(line)}; exported ${JSON.stringify(savedLines)}`);
    }
    console.log('PASS blur preview and exported PDF use identical deterministic line breaks');

    assert.deepEqual(consoleErrors, [], 'console errors during the redraw');
    await context.close();
  }

  // --- A redraw keeps every face the paragraph was written with --------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, fixture);
    const nextOutput = await installOutputCapture(page);

    await waitForParagraphs(page);
    const mixed = page.locator('[data-testid="pdf-text-block"]').nth(5);
    await mixed.click();
    await page.evaluate(() => {
      const element = document.querySelectorAll('[data-testid="pdf-text-block"]')[5];
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.insertText(' Added clause.');
    assert.match(await waitForPlan(page), /will be redrawn/i);

    const redrawn = await saveAndRead(page, nextOutput);
    assert.match(redrawn.text, /Added clause\./);
    // The originals are removed rather than covered, so the old words are not still searchable.
    assert.equal(
      (redrawn.text.match(new RegExp(LEAD_BODY.slice(0, 24), 'g')) ?? []).length,
      1,
      'the paragraph was drawn over its original instead of replacing it',
    );

    const faces = await readFaces(redrawn.bytes, [LEAD_IN, LEAD_BODY.slice(0, 20)]);
    // A redraw writes with the standard faces — the document's own program is deliberately not
    // re-embedded — but it still has to pick the bold one for the stretch that was bold.
    assert.ok(/Bold/i.test(faces[0] ?? ''), `the bold lead-in was redrawn as ${faces[0]}`);
    assert.ok(!/Bold/i.test(faces[1] ?? ''), `the body stretch was redrawn as ${faces[1]}`);
    assert.equal(
      redrawn.operators.fnArray.some(operation => imageOperatorSet.has(operation)),
      false,
      'a paragraph on a flat background must be repainted with a vector fill, not a raster patch',
    );
    console.log('PASS a redraw keeps bold bold, removes the original, and stays vector');

    assert.deepEqual(consoleErrors, [], 'console errors during the styled redraw');
    await context.close();
  }

  // --- Find and replace reaches pages the reader has never opened ------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, multipage);
    const nextOutput = await installOutputCapture(page);

    await waitForParagraphs(page);
    await page.getByRole('button', { name: 'Find' }).click();
    await page.getByLabel('Find in this PDF').fill('body line 2');
    await page.waitForFunction(
      () => /of \d+/.test(document.querySelector('[data-testid="pdf-find-count"]')?.textContent ?? ''),
      null,
      { timeout: 30_000 },
    );
    assert.equal(await page.getByTestId('pdf-find-count').innerText(), '1 of 12', 'find did not reach every page');

    await page.getByRole('button', { name: 'Next match' }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => getSelection()?.toString()), 'body line 2',
      'stepping to a match must leave it selected and ready to type over');
    console.log('PASS find reaches every page and selects the match it lands on');

    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await page.getByLabel('Replace with').fill('BODY LINE TWO');
    await page.getByRole('button', { name: 'All' }).click();
    await page.waitForTimeout(800);
    assert.match(await page.locator('[role="status"]').first().innerText(), /Replaced 12 matches/);

    const replaced = await saveAndRead(page, nextOutput, 12);
    assert.equal(replaced.text.filter(text => /BODY LINE TWO/.test(text)).length, 12);
    assert.equal(replaced.text.filter(text => /body line 2/.test(text)).length, 0,
      'the old text survived on some page');
    console.log('PASS replace all reaches every page and the saved PDF agrees');

    assert.deepEqual(consoleErrors, [], 'console errors during find and replace');
    await context.close();
  }

  // --- A scanned page explains itself ----------------------------------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, await createScan());

    assert.equal(await page.locator('[data-testid="pdf-text-block"]').count(), 0);
    const notice = await page.locator('[role="status"]').first().innerText();
    assert.match(notice, /is a picture, so its words cannot be edited/i);
    assert.match(notice, /text box/i, 'a page that cannot be edited must say what to do instead');
    assert.match(notice, /Extract Text/, 'the notice must name the tool that reads a scan');
    assert.equal(await page.getByRole('link', { name: 'Extract Text' }).count(), 1, 'the notice must link to the text tool');
    console.log('PASS a scanned page says why it cannot be edited and points at the fix');

    assert.deepEqual(consoleErrors, [], 'console errors on a scanned page');
    await context.close();
  }

  // --- Mobile: the controls stay reachable once a paragraph takes focus -------------------------
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    });
    const { page, consoleErrors } = await openEditor(context, fixture);

    await waitForParagraphs(page);
    const before = await page.evaluate(() => {
      const element = document.querySelectorAll('[data-testid="pdf-text-block"]')[1];
      const scale = element.getBoundingClientRect().height / element.offsetHeight;
      return Number.parseFloat(getComputedStyle(element).fontSize) * scale;
    });
    assert.ok(before < 16, 'the fixture must start with body text too small to edit by thumb');

    await page.locator('[data-testid="pdf-text-block"]').nth(1).tap();
    await page.getByTestId('pdf-paragraph-inspector').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);

    const after = await page.evaluate(() => {
      const element = document.querySelectorAll('[data-testid="pdf-text-block"]')[1];
      const scale = element.getBoundingClientRect().height / element.offsetHeight;
      return Number.parseFloat(getComputedStyle(element).fontSize) * scale;
    });
    assert.ok(after >= 15.5, `focusing a paragraph must raise it to a usable size, got ${after.toFixed(1)}px`);
    console.log(`PASS focusing a paragraph raises it from ${before.toFixed(1)}px to ${after.toFixed(1)}px`);

    // A fixed bar resolves against the layout viewport, which grows when the browser rescales the
    // page around the focused paragraph. Both controls have to stay on screen regardless.
    const reachable = await page.evaluate(() => {
      const visible = document.documentElement.clientHeight;
      const measure = (element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, visible };
      };
      const inspector = measure(document.querySelector('[data-testid="pdf-paragraph-inspector"]'));
      const saveButton = [...document.querySelectorAll('button')]
        .find(button => button.textContent.trim().startsWith('Save'));
      const save = saveButton ? measure(saveButton) : null;
      return { inspector, save };
    });
    assert.ok(
      reachable.inspector.bottom <= reachable.inspector.visible,
      `paragraph controls fell below the visible viewport (${Math.round(reachable.inspector.bottom)} > ${reachable.inspector.visible})`,
    );
    assert.ok(reachable.save, 'the Save control was not found');
    assert.ok(
      reachable.save.top >= 0 && reachable.save.bottom <= reachable.save.visible,
      'Save left the visible viewport',
    );
    console.log('PASS paragraph controls and Save stay on screen while a paragraph is focused');

    const touch = await page.locator('[data-testid="pdf-text-block"]').nth(1).evaluate(element => ({
      touchAction: getComputedStyle(element).touchAction,
      caretColor: getComputedStyle(element).caretColor,
      editable: element.getAttribute('contenteditable'),
    }));
    assert.equal(touch.touchAction, 'pan-x pan-y', 'one-finger scrolling and pinch zoom must keep working over a paragraph');
    assert.equal(touch.editable, 'plaintext-only', 'the overlay must refuse rich text');
    assert.notEqual(touch.caretColor, 'rgba(0, 0, 0, 0)', 'the caret must be visible against the page');
    console.log('PASS the overlay leaves scrolling and selection to the platform');

    assert.deepEqual(consoleErrors, [], 'console errors on mobile');
    await context.close();
  }
  // --- A paragraph the PDF drew one word at a time still leaves the file when redrawn ----------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, await createWordPerObject());
    const nextOutput = await installOutputCapture(page);
    await waitForParagraphs(page);

    // Append enough to force the redraw path, which is where the originals have to be removed.
    await page.evaluate(() => {
      const element = document.querySelectorAll('[data-testid="pdf-text-block"]')[0];
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.insertText(' Added.');
    await waitForPlan(page);

    const redrawn = await saveAndRead(page, nextOutput);
    assert.match(redrawn.text, /Added\./, 'the redrawn paragraph is missing');
    // Exactly one copy: the redraw's. A second would mean the words the PDF drew are still in the
    // file under the new ones, where search and copy would keep finding them.
    const probe = WORD_PER_OBJECT.slice(0, 30).replace(/\s+/g, '');
    assert.equal(
      redrawn.text.replace(/\s+/g, '').split(probe).length - 1,
      1,
      'a paragraph drawn one word at a time was painted over instead of removed',
    );
    console.log('PASS a word-per-object paragraph is removed, not painted over');

    assert.deepEqual(consoleErrors, [], 'console errors on the word-per-object redraw');
    await context.close();
  }
  // --- A form's own checkboxes answer a finger that lands near them, not only on them ----------
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const { page, consoleErrors } = await openEditor(context, await createTinyCheckboxes());
    await page.locator('[data-testid="pdf-form-field"]').first().waitFor({ timeout: 60_000 });

    const boxes = page.locator('input[type=checkbox][data-testid="pdf-form-field"]');
    assert.equal(await boxes.count(), 4, 'the fixture is meant to have four checkboxes');
    const session = await context.newCDPSession(page);
    // A point-sized touch: a wide one lets the engine's own touch adjustment snap to the nearest
    // control, which would pass whether or not the field itself answers where the finger landed.
    const tapAt = async (x, y) => {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 0.5, radiusY: 0.5, force: 1 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(120);
    };

    const roomy = await boxes.nth(0).boundingBox();
    assert.ok(roomy && roomy.width < 24, `the fixture's checkbox should be tiny, was ${roomy?.width}px`);
    // Just past its own edge, where a finger aiming at something this small often lands.
    await tapAt(roomy.x + roomy.width + 3, roomy.y + roomy.height / 2);
    assert.deepEqual(
      await boxes.evaluateAll(list => list.map(element => element.checked)),
      [true, false, false, false],
      'a near miss must reach the box it was aimed at, and only that one',
    );
    console.log('PASS a tiny form checkbox answers a finger that lands beside it');

    // Between two crowded boxes the region is capped, so neither may claim the other's half.
    const left = await boxes.nth(2).boundingBox();
    const right = await boxes.nth(3).boundingBox();
    await tapAt((left.x + left.width + right.x) / 2 - 1, left.y + left.height / 2);
    const crowded = await boxes.evaluateAll(list => list.map(element => element.checked));
    assert.equal(crowded[3], false, 'a field took a tap that fell on its neighbour\'s side of the gap');
    console.log('PASS crowded fields split the gap between them rather than overlapping');

    assert.deepEqual(consoleErrors, [], 'console errors while tapping form fields');
    await context.close();
  }
  // --- Text the page draws through a form leaves the file when the paragraph is redrawn --------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, consoleErrors } = await openEditor(context, await createFormXObjectPage());
    const nextOutput = await installOutputCapture(page);
    await waitForParagraphs(page);

    const stamped = page.locator('[data-testid="pdf-text-block"]')
      .filter({ hasText: 'Confidential draft' }).first();
    await stamped.waitFor({ timeout: 30_000 });
    await stamped.evaluate((element) => {
      element.focus();
      const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
      const at = node.textContent.indexOf('Confidential');
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 'Confidential'.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.insertText('Unclassified');
    await waitForPlan(page);

    const saved = await saveAndRead(page, nextOutput);
    assert.match(saved.text, /Unclassified draft/, 'the correction is missing from the saved file');
    assert.doesNotMatch(
      saved.text.replace(/\s+/g, ' '),
      /Confidential draft/,
      'the wording inside the form XObject survived the redraw, where a search would still find it',
    );
    console.log('PASS text drawn through a form XObject is removed, not left underneath');

    assert.deepEqual(consoleErrors, [], 'console errors on the form XObject redraw');
    await context.close();
  }
} finally {
  await browser.close();
}

console.log('Verified the paragraph editor: reconstruction, direct rewrite, redraw fallback and mobile reachability.');
