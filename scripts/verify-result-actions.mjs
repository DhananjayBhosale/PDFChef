import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
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

const assertActions = async dialog => {
  for (const label of ['Rename', 'Save', 'Share', 'Download', 'Tools']) {
    assert.equal(await dialog.getByRole('button', { name: label, exact: true }).count(), 1, `${label} action missing`);
  }
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

  const createActions = createPage.getByRole('dialog');
  await createActions.waitFor();
  assert.match(await createActions.innerText(), /PDF exported/);
  await assertActions(createActions);
  await createActions.getByRole('button', { name: 'Rename', exact: true }).click();
  const rename = createPage.getByRole('dialog');
  await rename.getByRole('textbox', { name: 'File name' }).fill('gallery-export');
  await rename.getByRole('button', { name: 'Save name' }).click();
  const renamedActions = createPage.getByRole('dialog');
  await renamedActions.getByRole('button', { name: 'Download', exact: true }).waitFor();
  await renamedActions.getByRole('button', { name: 'Share', exact: true }).click();
  assert.equal(await createPage.evaluate(() => window.__sharedName), 'gallery-export.pdf');
  const namedDownload = createPage.waitForEvent('download');
  await renamedActions.getByRole('button', { name: 'Download', exact: true }).click();
  assert.equal((await namedDownload).suggestedFilename(), 'gallery-export.pdf');
  await renamedActions.getByRole('button', { name: 'Tools', exact: true }).click();
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
  await assertActions(flattenActions);
  await flattenActions.getByRole('button', { name: 'Rename', exact: true }).click();
  const flattenRename = flattenPage.getByRole('dialog');
  await flattenRename.getByRole('textbox', { name: 'File name' }).fill('renamed-flatten-result');
  await flattenRename.getByRole('button', { name: 'Save name' }).click();
  const renamedFlattenActions = flattenPage.getByRole('dialog');
  await renamedFlattenActions.getByText(/renamed-flatten-result\.pdf/).waitFor();
  await renamedFlattenActions.getByRole('button', { name: 'Save', exact: true }).click();
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
  await compressPage.getByRole('switch', { name: 'Keep text selectable' }).check();
  await compressPage.getByRole('button', { name: 'Compress', exact: true }).click();
  await compressPage.getByText('Ready to save').waitFor().catch(async error => {
    throw new Error(`Compress result did not become saveable: ${(await compressPage.locator('body').innerText()).slice(0, 2000)}`, { cause: error });
  });
  const compressName = compressPage.getByRole('textbox', { name: 'File name' });
  await compressName.fill('');
  assert.equal(await compressPage.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
  await compressName.fill('renamed/before save');
  assert.equal(await compressName.inputValue(), 'renamed-before save');
  await compressPage.getByRole('button', { name: 'Save', exact: true }).click();
  const compressedActions = compressPage.getByRole('dialog');
  await compressedActions.waitFor();
  assert.match(await compressedActions.innerText(), /renamed-before save\.pdf/);
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

  console.log(JSON.stringify({ status: 'PASS', createPdfPages: 2, menuActions: 5, secondTool: 'Flatten PDF', compressRename: true }));
} finally {
  await browser.close();
}
