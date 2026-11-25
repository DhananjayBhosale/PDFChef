import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openResultSheet, root } from './lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const captureDir = resolve(process.env.RESULT_ACTIONS_CAPTURE_DIR || resolve(root, 'output/web/result-actions'));
const browser = await chromium.launch({ headless: true });

const newPage = async (autoDownload, keepLocalHistory, shareAvailable = false) => {
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 390, height: 844 } });
  await page.addInitScript(({ autoDownload, keepLocalHistory, shareAvailable }) => {
    delete window.showSaveFilePicker;
    if (shareAvailable) {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async ({ files }) => { window.__sharedName = files[0].name; },
      });
    }
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload, keepLocalHistory, confirmLargeJobs: false,
      largeFileWarningMb: 80, onboardingComplete: true, interfaceFont: 'inter',
    }));
  }, { autoDownload, keepLocalHistory, shareAvailable });
  return page;
};

// The result sheet shows only what still applies: Download until a copy is saved, and
// Keep in Recent until the result is in Recent, then Show in Recent.
const assertActions = async (dialog, present, absent) => {
  for (const label of present) {
    assert.equal(await dialog.getByRole('button', { name: label, exact: true }).count(), 1, `${label} action missing`);
  }
  for (const label of absent) {
    assert.equal(await dialog.getByRole('button', { name: label, exact: true }).count(), 0, `${label} action must be hidden`);
  }
};

/** Line 2 of the result strip: the size, and where the result is kept. */
const stripLine = (page) => page.locator('.chef-result-card .type-footnote').first().innerText();

/** Runs Flatten on a one-page PDF and waits for the result strip. */
const flattenOnce = async (page, label = 'Lock the answers and save') => {
  const source = await PDFDocument.create();
  source.addPage([300, 400]).drawText('Q1 result sheet');
  await page.locator('input[type=file]').setInputFiles({
    name: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()),
  });
  await page.getByRole('button', { name: label }).click();
  await page.locator('.chef-result-card').waitFor({ timeout: 60_000 });
};

/** A download link that cannot start: the automatic download fails. */
const blockDownloads = () => {
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function blocked() {
    if (this.download) throw new DOMException('Download blocked', 'NotAllowedError');
    return click.call(this);
  };
};

try {
  const createPage = await newPage(true, true, true);
  await createPage.goto(`${origin}/make-pdf`);
  const images = await createPage.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 160;
    const context = canvas.getContext('2d');
    context.fillStyle = '#274f8a';
    context.fillRect(0, 0, 120, 160);
    context.fillStyle = '#fff';
    context.fillRect(15, 20, 90, 25);
    return {
      png: canvas.toDataURL('image/png').split(',')[1],
      webp: canvas.toDataURL('image/webp').split(',')[1],
    };
  });
  await createPage.locator('input[multiple]').setInputFiles([
    { name: 'gallery.png', mimeType: 'image/png', buffer: Buffer.from(images.png, 'base64') },
    { name: 'gallery.webp', mimeType: 'image/webp', buffer: Buffer.from(images.webp, 'base64') },
  ]);
  const initialDownload = createPage.waitForEvent('download');
  await createPage.getByRole('button', { name: /Export.*PDF/i }).click();
  const exported = await initialDownload;
  const exportedStream = await exported.createReadStream();
  const chunks = [];
  for await (const chunk of exportedStream) chunks.push(chunk);
  assert.equal((await PDFDocument.load(Buffer.concat(chunks))).getPageCount(), 2);

  // Q1: downloaded and kept in Recent, nothing is left to do, so the sheet stays closed. More
  // actions opens the same sheet, whose line says where the PDF is kept. (Line 2 of the strip
  // keeps the size only: in German at 360 px the place was cut away, see the capture below.)
  await createPage.getByRole('button', { name: /^More actions for / }).waitFor();
  await createPage.waitForTimeout(500);
  assert.equal(await createPage.getByRole('dialog').count(), 0, 'a downloaded result kept in Recent opens no sheet');
  assert.doesNotMatch(await stripLine(createPage), /kept in Recent/);
  const createActions = createPage.getByRole('dialog');
  await openResultSheet(createPage);
  assert.match(await createActions.innerText(), /PDF exported/);
  assert.match(await createActions.innerText(), / · kept in Recent/);
  // Already downloaded and kept in Recent: a second Download or Keep would duplicate it.
  await assertActions(createActions,
    ['Share', 'Open PDF', 'Rename', 'Use in another tool', 'Show in Recent'],
    ['Download', 'Keep in Recent']);
  await createActions.getByRole('button', { name: 'Rename', exact: true }).click();
  const rename = createPage.getByRole('dialog');
  await rename.getByRole('textbox', { name: 'File name' }).fill('gallery-export');
  await rename.getByRole('button', { name: 'Save name' }).click();
  const renamedActions = createPage.getByRole('dialog');
  await renamedActions.getByText(/gallery-export\.pdf/).waitFor();
  await renamedActions.getByRole('button', { name: 'Share', exact: true }).click();
  assert.equal(await createPage.evaluate(() => window.__sharedName), 'gallery-export.pdf');
  await renamedActions.getByRole('button', { name: 'Use in another tool', exact: true }).click();
  await createPage.waitForURL(`${origin}/view`);
  await createPage.getByRole('menu', { name: 'Use a PDF tool' }).waitFor();
  assert.equal(await createPage.getByRole('menuitem', { name: 'Compress PDF' }).count(), 1);

  const flattenPage = await newPage(false, false);
  await flattenPage.goto(`${origin}/flatten`);
  const source = await PDFDocument.create();
  source.addPage([300, 400]).drawText('Result actions survive another tool');
  await flattenPage.locator('input[type=file]').setInputFiles({
    name: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()),
  });
  await flattenPage.getByRole('button', { name: 'Lock the answers and save' }).click();
  const flattenActions = flattenPage.getByRole('dialog');
  await flattenActions.waitFor();
  assert.match(await flattenActions.innerText(), /Result ready/);
  // Nothing saved yet: Download leads, and the result can still be kept in Recent.
  await assertActions(flattenActions,
    ['Download', 'Open PDF', 'Rename', 'Use in another tool', 'Keep in Recent'],
    ['Show in Recent']);
  await flattenActions.getByRole('button', { name: 'Rename', exact: true }).click();
  const flattenRename = flattenPage.getByRole('dialog');
  await flattenRename.getByRole('textbox', { name: 'File name' }).fill('renamed-flatten-result');
  await flattenRename.getByRole('button', { name: 'Save name' }).click();
  const renamedFlattenActions = flattenPage.getByRole('dialog');
  await renamedFlattenActions.getByText(/renamed-flatten-result\.pdf/).waitFor();
  const namedDownload = flattenPage.waitForEvent('download');
  await renamedFlattenActions.getByRole('button', { name: 'Download', exact: true }).click();
  assert.equal((await namedDownload).suggestedFilename(), 'renamed-flatten-result.pdf');
  await renamedFlattenActions.getByRole('button', { name: 'Keep in Recent', exact: true }).click();
  await renamedFlattenActions.getByRole('button', { name: 'Show in Recent' }).waitFor();
  await renamedFlattenActions.getByRole('button', { name: 'Show in Recent' }).click();
  await flattenPage.waitForURL(`${origin}/recent`);
  await flattenPage.getByText('renamed-flatten-result.pdf').waitFor();

  const compressPage = await newPage(false, true, true);
  await compressPage.goto(`${origin}/compress`);
  const compressible = await PDFDocument.create();
  for (let index = 0; index < 10; index += 1) {
    compressible.addPage().drawText(`Compressible page ${index + 1}`);
  }
  await compressPage.locator('input[type=file]').setInputFiles({
    name: 'source.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from(await compressible.save({ useObjectStreams: false })),
  });
  // The switch is the sentence's one-tap word (owner decision 1, A-004).
  await compressPage.getByRole('switch', { name: 'Keep text selectable' }).check();
  await compressPage.getByRole('button', { name: 'Compress', exact: true }).click();
  // T-01: a finished run is saved like every other tool's result, so the result sheet opens
  // with Download first (the old "Ready to save" card with its own name field is gone).
  const compressedActions = compressPage.getByRole('dialog');
  await compressedActions.waitFor().catch(async error => {
    throw new Error(`Compress result sheet did not open: ${(await compressPage.locator('body').innerText()).slice(0, 2000)}`, { cause: error });
  });
  assert.match(await compressedActions.innerText(), /compress-source\.pdf/);
  await compressedActions.getByRole('button', { name: 'Rename', exact: true }).click();
  const compressName = compressPage.getByRole('textbox', { name: 'File name' });
  await compressName.fill('renamed/before save');
  assert.equal(await compressName.inputValue(), 'renamed-before save');
  await compressName.fill('renamed-before save');
  await compressPage.getByRole('button', { name: 'Save name' }).click();
  assert.match(await compressPage.getByRole('dialog').innerText(), /renamed-before save\.pdf/);
  await compressedActions.getByRole('button', { name: 'Rename', exact: true }).click();
  const resultRenameInput = compressPage.getByRole('textbox', { name: 'File name' });
  await resultRenameInput.fill('');
  await resultRenameInput.focus();
  await compressPage.keyboard.type('abc');
  assert.equal(await resultRenameInput.inputValue(), 'abc');
  assert.equal(await resultRenameInput.evaluate(element => document.activeElement === element), true);
  await resultRenameInput.fill('renamed after save.bin');
  await compressPage.getByRole('button', { name: 'Save name' }).click();
  const finalCompressedActions = compressPage.getByRole('dialog');
  assert.match(await finalCompressedActions.innerText(), /renamed after save\.bin\.pdf/);
  await finalCompressedActions.getByRole('button', { name: 'Share', exact: true }).click();
  assert.equal(await compressPage.evaluate(() => window.__sharedName), 'renamed after save.bin.pdf');

  // Q1: the sheet still opens by itself whenever the person must act. Automatic download off is
  // covered above (Flatten with Recent off, Compress with Recent on).
  // Downloaded but kept nowhere: the strip cannot say where it is, so the sheet opens.
  const downloadOnly = await newPage(true, false);
  await downloadOnly.goto(`${origin}/flatten`);
  const downloadOnlyFile = downloadOnly.waitForEvent('download');
  await flattenOnce(downloadOnly);
  await downloadOnlyFile;
  const downloadOnlyActions = downloadOnly.getByRole('dialog');
  await downloadOnlyActions.waitFor();
  assert.match(await downloadOnlyActions.innerText(), /PDF exported/);

  // A failed automatic download, with Recent on: the sheet opens and says so.
  const failing = await newPage(true, true);
  await failing.addInitScript(blockDownloads);
  await failing.goto(`${origin}/flatten`);
  await flattenOnce(failing);
  const failedActions = failing.getByRole('dialog');
  await failedActions.waitFor();
  assert.match(await failedActions.innerText(), /Result ready/);
  assert.match(await failing.locator('.chef-result-card').innerText(), /Saving did not complete/);
  assert.equal(await failedActions.getByRole('button', { name: 'Download', exact: true }).count(), 1, 'a failed save offers Download');

  // German at 360 px: the strip, captured for the morning; nothing on line 2 is cut.
  const german = await browser.newPage({ acceptDownloads: true, viewport: { width: 360, height: 780 }, locale: 'de-DE' });
  await german.addInitScript(() => {
    delete window.showSaveFilePicker;
    localStorage.setItem('pdfchef.locale.v1', 'de-DE');
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: true, keepLocalHistory: true, confirmLargeJobs: false,
      largeFileWarningMb: 80, onboardingComplete: true, interfaceFont: 'inter',
    }));
  });
  await german.goto(`${origin}/flatten`);
  await flattenOnce(german, 'Antworten sperren und speichern');
  await german.waitForTimeout(500);
  assert.equal(await german.getByRole('dialog').count(), 0, 'German: a downloaded result kept in Recent opens no sheet');
  const germanLine = await stripLine(german);
  const germanCut = await german.locator('.chef-result-card .type-footnote').first()
    .evaluate((line) => line.scrollWidth > line.clientWidth);
  assert.equal(germanCut, false, `German line 2 is cut: ${germanLine}`);
  await mkdir(captureDir, { recursive: true });
  await german.locator('.chef-result-card').screenshot({ path: resolve(captureDir, 'strip-de-DE-360.png') });

  console.log(JSON.stringify({
    status: 'PASS', createPdfPages: 2, menuActions: 5, secondTool: 'Flatten PDF', compressRename: true,
    sheetClosedWhenPlaced: true, sheetOpensWhenActing: ['download only', 'automatic download off', 'failed download'],
    germanLine, germanCut,
  }));
} finally {
  await browser.close();
}
