import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';

const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, 'output', 'android-parity-verification');
const qaPdfPath = path.join(projectRoot, 'qa-sample.pdf');
const formPdfPath = path.join(projectRoot, 'output', 'form-fixture.pdf');
const androidPptxPath = process.env.PDF_CHEF_PPTX_FIXTURE
  || '/Users/dhananjaybhosale/AndroidStudioProjects/PDFTools/app/src/androidTest/assets/pptx/representative-16x9.pptx';

const docxFixture = async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>PDF Chef Word parity verification</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph with café and résumé.</w:t></w:r></w:p><w:p><w:r><w:t>Page one complete.</w:t><w:br w:type="page"/><w:t>Page two begins here.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
};

const saveDownload = async (download, prefix) => {
  const suggested = download.suggestedFilename();
  const target = path.join(outputDir, `${prefix}-${suggested}`);
  await download.saveAs(target);
  return target;
};

const saveCurrentOutput = async (page, prefix) => {
  const outputCard = page.locator('aside').filter({ hasText: 'Result ready' });
  await outputCard.getByText('Result ready').waitFor({ timeout: 120_000 });
  const downloadPromise = page.waitForEvent('download');
  await outputCard.getByRole('button', { name: 'Save' }).click();
  return saveDownload(await downloadPromise, prefix);
};

const inspectPdf = async (filePath, minimumPages = 1) => {
  const bytes = await fs.readFile(filePath);
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF', `${filePath} is not a PDF`);
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= minimumPages, `${filePath} has too few pages`);
  return pdf;
};

await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
await page.addInitScript(() => {
  localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
    autoDownload: false,
    keepLocalHistory: true,
    confirmLargeJobs: false,
    largeFileWarningMb: 80,
    onboardingComplete: true,
  }));
});

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(error.message));

const results = [];
try {
  await page.goto(`${baseUrl}/word-to-pdf`);
  await page.getByRole('heading', { name: 'Word to PDF' }).waitFor();
  await page.locator('input[type=file]').setInputFiles({
    name: 'parity-verification.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await docxFixture(),
  });
  await page.getByRole('button', { name: 'Save PDF' }).click();
  const wordPath = await saveCurrentOutput(page, 'word');
  const wordPdf = await inspectPdf(wordPath, 2);
  results.push({ tool: 'Word to PDF', status: 'PASS', pages: wordPdf.getPageCount(), file: path.basename(wordPath) });

  await page.goto(`${baseUrl}/powerpoint-to-pdf`);
  await page.getByRole('heading', { name: 'PowerPoint to PDF' }).waitFor();
  await page.locator('input[type=file]').setInputFiles(androidPptxPath);
  await page.getByRole('button', { name: 'Save PDF' }).click();
  const pptPath = await saveCurrentOutput(page, 'powerpoint');
  const pptPdf = await inspectPdf(pptPath);
  const pptPage = pptPdf.getPage(0).getSize();
  assert.ok(pptPage.width > pptPage.height, '16:9 presentation did not stay landscape');
  results.push({ tool: 'PowerPoint to PDF', status: 'PASS', pages: pptPdf.getPageCount(), landscape: true, file: path.basename(pptPath) });

  await page.goto(`${baseUrl}/make-fillable`);
  await page.getByRole('heading', { name: /^Make Fillable/ }).waitFor();
  await page.locator('input[type=file]').setInputFiles(formPdfPath);
  const preview = page.getByRole('img', { name: 'Page 1' });
  await preview.waitFor({ state: 'visible', timeout: 60_000 });
  const box = await preview.boundingBox();
  assert.ok(box, 'fillable PDF preview did not render');
  await page.mouse.move(box.x + box.width * 0.54, box.y + box.height * 0.20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.26, { steps: 8 });
  await page.mouse.up();
  await page.getByText('1 new field').waitFor();
  await page.getByRole('button', { name: 'Create fillable PDF' }).click();
  const formPath = await saveCurrentOutput(page, 'forms');
  const formPdf = await inspectPdf(formPath);
  const sourceFormPdf = await PDFDocument.load(await fs.readFile(formPdfPath));
  const sourceFieldCount = sourceFormPdf.getForm().getFields().length;
  assert.equal(formPdf.getForm().getFields().length, sourceFieldCount + 1, 'fillable output does not preserve existing fields and add one new AcroForm field');
  results.push({ tool: 'Make Fillable', status: 'PASS', fields: formPdf.getForm().getFields().length, preservedFields: sourceFieldCount, file: path.basename(formPath) });

  await page.goto(`${baseUrl}/edit`);
  await page.getByRole('heading', { name: /Edit PDF/ }).waitFor();
  await page.locator('input[type=file][accept=".pdf"]').setInputFiles(qaPdfPath);
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByLabel('Shape type').selectOption('rectangle');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await page.getByText('Selected rectangle').waitFor();
  await page.getByRole('button', { name: 'Undo added element change' }).click();
  await page.getByRole('button', { name: 'Redo added element change' }).click();
  const editorImageBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to create editor image fixture.');
    context.fillStyle = '#2563eb';
    context.fillRect(0, 0, 64, 32);
    context.fillStyle = '#ffffff';
    context.fillRect(8, 8, 48, 16);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('input[type=file][accept*=".png"]').setInputFiles({
    name: 'editor-fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.from(editorImageBase64, 'base64'),
  });
  await page.getByText('Selected image').waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const editPath = await saveCurrentOutput(page, 'edit');
  const editPdf = await inspectPdf(editPath);
  results.push({ tool: 'Edit PDF graphics and history', status: 'PASS', pages: editPdf.getPageCount(), file: path.basename(editPath) });

  const exactPassword = ' pass ';
  await page.goto(`${baseUrl}/protect`);
  await page.getByRole('heading', { name: 'Protect PDF' }).waitFor();
  await page.locator('input[type=file]').setInputFiles(qaPdfPath);
  await page.getByLabel('Set Password').fill(exactPassword);
  await page.getByLabel('Confirm Password').fill(exactPassword);
  await page.getByRole('button', { name: 'Protect with password' }).click();
  const protectedPath = await saveCurrentOutput(page, 'protect');
  const protectedBytes = await fs.readFile(protectedPath);
  assert.equal(protectedBytes.subarray(0, 4).toString(), '%PDF', 'protected output is not a PDF');
  assert.ok(protectedBytes.includes(Buffer.from('/Encrypt')), 'protected output has no PDF encryption dictionary');

  await page.goto(`${baseUrl}/unlock`);
  await page.getByRole('heading', { name: 'Unlock PDF' }).waitFor();
  await page.locator('input[type=file]').setInputFiles(protectedPath);
  await page.getByLabel('Enter Password').fill(exactPassword);
  await page.getByRole('button', { name: 'Unlock PDF' }).click();
  const unlockedPath = await saveCurrentOutput(page, 'unlock');
  const unlockedPdf = await inspectPdf(unlockedPath);
  results.push({ tool: 'Protect and Unlock exact password', status: 'PASS', pages: unlockedPdf.getPageCount(), passwordBoundarySpaces: true, file: path.basename(unlockedPath) });

  await page.goto(`${baseUrl}/batch`);
  await page.getByRole('heading', { name: 'Batch processing' }).waitFor();
  await page.getByLabel('Operation').selectOption('rotate');
  await page.locator('input[type=file]').setInputFiles([qaPdfPath, formPdfPath]);
  await page.getByRole('button', { name: /Process 2 files/ }).click();
  const batchPath = await saveCurrentOutput(page, 'batch');
  const archive = await JSZip.loadAsync(await fs.readFile(batchPath));
  const outputNames = Object.keys(archive.files).filter((name) => !archive.files[name].dir);
  assert.equal(outputNames.filter((name) => name.endsWith('.pdf')).length, 2, 'batch archive does not contain two PDFs');
  results.push({ tool: 'Batch processing', status: 'PASS', outputs: outputNames, file: path.basename(batchPath) });

  await page.goto(`${baseUrl}/history`);
  await page.getByRole('heading', { name: 'Recent' }).waitFor();
  await page.getByText('parity-verification.pdf').waitFor();
  await page.screenshot({ path: path.join(outputDir, 'history.png'), fullPage: true });
  results.push({ tool: 'Recent', status: 'PASS' });

  assert.equal(consoleErrors.length, 0, `Browser errors:\n${consoleErrors.join('\n')}`);
  await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'PASS', results }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => undefined);
  const pageText = await page.locator('body').innerText().catch(() => 'Unable to read page text.');
  console.error(JSON.stringify({ status: 'FAIL', url: page.url(), consoleErrors, pageText }, null, 2));
  throw error;
} finally {
  await browser.close();
}
