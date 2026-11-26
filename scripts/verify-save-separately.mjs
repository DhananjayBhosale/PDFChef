// "Save N files separately" on a Split result (plan 2.5, 6.2).
//
//   PDF_CHEF_URL=http://127.0.0.1:4194 node scripts/verify-save-separately.mjs
//
// Checks, in Chromium with showDirectoryPicker removed (the downloads path of Firefox,
// Safari and Android browsers):
//  - with automatic saving off, nothing is downloaded, and the button "Save 3 files separately"
//    is on the result strip and in the result sheet;
//  - pressing it gives three downloads named "<ZIP name without .zip>-<entry>", in order,
//    each a PDF, with "Saving n of 3" while it runs and the status line after;
//  - a split that gives one PDF has no such button, and no save choice;
//  - the save choice (owner decision 2026-11-17): "Saves 3 separate PDFs." by default, and with
//    automatic saving on "Save the split files" gives three PDF downloads and no ZIP; switched to
//    "Saves one ZIP with 3 PDFs." it gives one ZIP; the choice is remembered after a reload;
//  - the untouched choice (overnight A10, 'auto'): 12 parts read "Saves one ZIP with 12 PDFs." and
//    save one ZIP; once the person picks "Separate PDFs" it stays so at 12 parts (after a reload)
//    and at 3, and the 12 parts arrive as 12 PDFs. The line and the save agree each time;
//  - on a phone, one page split by maximum size keeps "Max file size" in the sentence, and the value
//    opens its editor (overnight A7, s3-03).
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { newContext, qaPdf, root, settle, sizes } from './lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4194';
const output = resolve(root, process.env.PDF_CHEF_SEPARATE_OUTPUT || 'output/web/build/phase-3-4/save-separately');
await mkdir(output, { recursive: true });
const results = [];
const size = (key) => sizes.find((item) => item.key === key);

const browser = await chromium.launch({ headless: true });

async function openSplit(page, file = qaPdf) {
  await page.goto(`${origin}/split`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file]').first().setInputFiles(file);
  // The page grid is drawn once the file is read ("Pages to include" is a slot button on a
  // phone and plain text beside the grid on desktop since T-10, so wait for a page instead).
  await page.getByRole('button', { name: 'Save the split files', exact: true }).waitFor();
  await page.locator('.tk-pagegrid [role="button"], .tk-pagegrid button').first().waitFor();
  await settle(page, 600);
}

/** The save choice line under the sentence, as it reads. */
const choiceLine = (page) => page.getByRole('group', { name: 'How to save the parts', exact: true })
  .locator('.tk-sentence:not(.tk-measure)');
const lineText = async (page) => (await choiceLine(page).textContent()).replace(/\s+/g, ' ').trim();

/** Switches the save choice: a tap on the words on a phone, the radio beside the sentence on desktop. */
async function choose(page, key, option) {
  if (size(key).phone) {
    const checked = await page.getByRole('radio', { name: option, exact: true }).isChecked();
    if (!checked) await choiceLine(page).locator('.tk-word-toggle').click();
  } else {
    await page.getByRole('radio', { name: option, exact: true }).click();
  }
  await settle(page, 200);
  assert.equal(await page.getByRole('radio', { name: option, exact: true }).getAttribute('aria-checked')
    ?? String(await page.getByRole('radio', { name: option, exact: true }).isChecked()), 'true', `${option} is chosen`);
}

// One file out reads "Save the PDF" (review 2, item 4).
async function splitResult(key, perFile = '1', settings = {}, main = 'Save the split files') {
  const context = await newContext(browser, size(key), settings);
  await context.addInitScript(() => { delete window.showDirectoryPicker; delete window.showSaveFilePicker; });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const early = [];
  page.on('download', (download) => early.push(download));
  await openSplit(page);
  if (perFile !== '1') {
    await page.getByRole('button', { name: /^Pages per file,/ }).click();
    await page.getByLabel('Pages per output PDF', { exact: true }).fill(perFile);
    await page.keyboard.press('Escape');
    await page.locator('.tk-scrim:not([hidden])').waitFor({ state: 'detached' });
  }
  await page.getByRole('button', { name: main, exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet.waitFor();
  return { context, page, sheet, errors, early };
}

const separate = (scope) => scope.getByRole('button', { name: /^Save \d+ files separately$/ });

for (const [key, where] of [['390x844', 'strip'], ['1440x900', 'sheet']]) {
  const { context, page, sheet, errors, early } = await splitResult(key);
  await page.waitForTimeout(800);
  assert.equal(early.length, 0, 'automatic saving off: nothing is downloaded, in either choice');
  const zipName = (await sheet.innerText()).match(/(\S+\.zip)\b/)?.[1];
  assert(zipName, 'The result sheet names the ZIP');
  assert.equal(await separate(sheet).count(), 1, 'Save separately is in the sheet');
  assert.equal(await separate(sheet).innerText(), 'Save 3 files separately');
  assert.match(await sheet.innerText(), /allow it to download multiple files/, 'The browser note shows before saving');
  await page.screenshot({ path: `${output}/sheet-${key}.png` });

  // The strip under the sheet carries the same button.
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await sheet.waitFor({ state: 'detached' });
  const strip = page.locator('[data-separate="strip"]');
  assert.equal(await strip.count(), 1, 'Save separately is on the strip');
  assert.equal((await strip.innerText()).trim(), 'Save 3 files separately');
  const slotted = await page.locator('.chef-result-face[data-result-slotted]').count();
  assert.equal(slotted, 1, 'The strip sits in the tool’s action area');

  let scope = page.locator('.tk-separate-row[data-variant="strip"]');
  if (where === 'sheet') {
    await page.getByRole('button', { name: /^More actions for/ }).click();
    await sheet.waitFor();
    scope = sheet;
  }
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  const started = Date.now();
  await separate(scope).click();
  await page.locator('.tk-separate[aria-busy="true"]', { hasText: /^Saving 2 of 3$/ }).first().waitFor({ timeout: 5_000 });
  const deadline = Date.now() + 15_000;
  while (downloads.length < 3 && Date.now() < deadline) await page.waitForTimeout(100);
  const names = downloads.map((download) => download.suggestedFilename());
  const stem = zipName.replace(/\.zip$/i, '');
  assert.equal(downloads.length, 3, `three downloads (${names.join(', ')})`);
  assert.deepEqual(names, names.map((name) => name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), 'in order');
  for (const name of names) assert(name.startsWith(`${stem}-`) && name.endsWith('.pdf'), `${name} is named "<ZIP name>-<entry>"`);
  for (const download of downloads) {
    const head = (await readFile(await download.path())).subarray(0, 5).toString();
    assert.equal(head, '%PDF-', `${download.suggestedFilename()} is a PDF`);
  }
  const status = scope.locator('.tk-separate-status');
  await status.filter({ hasText: /3 files sent to your downloads/i }).waitFor({ timeout: 5_000 }).catch(async () => {
    throw new Error(`status line: "${await status.first().innerText().catch(() => '')}"`);
  });
  await page.screenshot({ path: `${output}/after-${where}-${key}.png` });
  assert.deepEqual(errors, [], 'no page errors');
  results.push(`${key} ${where}: button on strip and sheet; 3 downloads in ${Date.now() - started} ms: ${names.join(', ')}; "Saving 2 of 3"; status line`);
  console.log(`PASS ${results.at(-1)}`);
  await context.close();
}

{
  // Three pages per file on a three-page PDF: one PDF, no ZIP, no button.
  const { context, page, sheet } = await splitResult('390x844', '3', {}, 'Save the PDF');
  assert.equal(await separate(sheet).count(), 0, 'one PDF: no button in the sheet');
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await sheet.waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-separate]').count(), 0, 'one PDF: no button on the strip');
  assert.equal(await page.getByRole('group', { name: 'How to save the parts', exact: true }).count(), 0, 'one PDF: no save choice');
  results.push('one-PDF split: no Save separately button, no save choice');
  console.log(`PASS ${results.at(-1)}`);
  await context.close();
}

const pdfsOnly = async (downloads) => {
  for (const download of downloads) {
    const head = (await readFile(await download.path())).subarray(0, 5).toString();
    assert.equal(head, '%PDF-', `${download.suggestedFilename()} is a PDF`);
  }
};

async function waitFor(list, count, ms) {
  const deadline = Date.now() + ms;
  while (list.length < count && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
}

// Separate PDFs, the default: with automatic saving on, the parts arrive and the ZIP does not.
for (const key of ['390x844', '1440x900']) {
  const context = await newContext(browser, size(key), { autoDownload: true });
  await context.addInitScript(() => { delete window.showDirectoryPicker; delete window.showSaveFilePicker; });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await openSplit(page);
  assert.equal((await lineText(page)), 'Saves 3 separate PDFs.', 'the default names the exact count');
  await page.getByRole('button', { name: 'Save the split files', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet.waitFor();
  await waitFor(downloads, 3, 15_000);
  await page.waitForTimeout(1_000);
  const names = downloads.map((download) => download.suggestedFilename());
  assert.equal(downloads.length, 3, `three downloads, no ZIP (${names.join(', ')})`);
  assert(names.every((name) => name.endsWith('.pdf')), `no ZIP is downloaded (${names.join(', ')})`);
  await pdfsOnly(downloads);
  await sheet.locator('.tk-separate-status').filter({ hasText: /3 files sent to your downloads/i }).waitFor({ timeout: 5_000 });
  assert.equal(await sheet.getByRole('button', { name: 'Save 3 files separately', exact: true }).count(), 1, 'the sheet keeps the button');
  await page.screenshot({ path: `${output}/auto-separate-${key}.png` });
  assert.deepEqual(errors, [], 'no page errors');
  results.push(`${key} default separate + automatic saving: 3 PDF downloads, no ZIP: ${names.join(', ')}; status line`);
  console.log(`PASS ${results.at(-1)}`);
  await context.close();
}

// One ZIP: switched, saved as one ZIP, and remembered after a reload.
for (const key of ['390x844', '1440x900']) {
  const context = await newContext(browser, size(key), { autoDownload: true });
  await context.addInitScript(() => { delete window.showDirectoryPicker; delete window.showSaveFilePicker; });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await openSplit(page);
  await choose(page, key, 'One ZIP');
  assert.equal((await lineText(page)), 'Saves one ZIP with 3 PDFs.');
  await page.getByRole('button', { name: 'Save the split files', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await waitFor(downloads, 1, 15_000);
  await page.waitForTimeout(1_000);
  const names = downloads.map((download) => download.suggestedFilename());
  assert.equal(downloads.length, 1, `one download (${names.join(', ')})`);
  assert.match(names[0], /\.zip$/, 'the ZIP');
  await page.screenshot({ path: `${output}/auto-zip-${key}.png` });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openSplit(page);
  assert.equal((await lineText(page)), 'Saves one ZIP with 3 PDFs.', 'the choice is remembered');
  await choose(page, key, 'Separate PDFs');
  assert.equal((await lineText(page)), 'Saves 3 separate PDFs.');
  results.push(`${key} one ZIP: 1 download (${names[0]}); remembered after reload; switched back`);
  console.log(`PASS ${results.at(-1)}`);
  await context.close();
}

// The untouched choice (overnight A10): above 10 parts on the downloads path, one ZIP.
const twelvePages = resolve(output, 'twelve-pages.pdf');
{
  const source = await PDFDocument.load(await readFile(qaPdf));
  const doc = await PDFDocument.create();
  while (doc.getPageCount() < 12) {
    const pages = await doc.copyPages(source, source.getPageIndices());
    for (const copied of pages) if (doc.getPageCount() < 12) doc.addPage(copied);
  }
  await writeFile(twelvePages, await doc.save());
}

for (const key of ['390x844', '1440x900']) {
  const context = await newContext(browser, size(key), { autoDownload: true });
  await context.addInitScript(() => { delete window.showDirectoryPicker; delete window.showSaveFilePicker; });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const dialogs = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await openSplit(page, twelvePages);
  assert.equal(await lineText(page), 'Saves one ZIP with 12 PDFs.', 'untouched, 12 parts: one ZIP');
  assert.equal(await page.getByRole('radio', { name: 'One ZIP', exact: true }).isChecked(), true, 'the One ZIP radio is checked');
  await page.getByRole('button', { name: 'Save the split files', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await waitFor(downloads, 1, 15_000);
  await page.waitForTimeout(1_500);
  const names = downloads.map((download) => download.suggestedFilename());
  assert.equal(downloads.length, 1, `one download (${names.join(', ')})`);
  assert.match(names[0], /\.zip$/, 'the ZIP');
  assert.deepEqual(dialogs, [], 'no browser confirm');
  // A ZIP result's Download says what it gives (owner, 26 Nov 2026); a PDF result keeps "Download".
  const sheet = page.getByRole('dialog');
  assert.equal(await sheet.getByRole('button', { name: 'Download as one ZIP', exact: true }).count(), 1, 'the sheet offers "Download as one ZIP"');
  assert.equal(await sheet.getByRole('button', { name: 'Download', exact: true }).count(), 0, 'no plain "Download" for a ZIP');
  await page.screenshot({ path: `${output}/auto-twelve-zip-${key}.png` });
  assert.deepEqual(errors, [], 'no page errors');
  results.push(`${key} untouched, 12 parts: "Saves one ZIP with 12 PDFs."; 1 download (${names[0]})`);
  console.log(`PASS ${results.at(-1)}`);
  await context.close();
}

{
  const key = '390x844';
  const context = await newContext(browser, size(key), { autoDownload: true });
  await context.addInitScript(() => { delete window.showDirectoryPicker; delete window.showSaveFilePicker; });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Above 10 downloads the browser confirm still asks (P6, later): accept it.
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await openSplit(page, twelvePages);
  await choose(page, key, 'Separate PDFs');
  assert.equal(await lineText(page), 'Saves 12 separate PDFs.', 'picked: separate at 12');
  await page.getByRole('button', { name: 'Save the split files', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await waitFor(downloads, 12, 30_000);
  await page.waitForTimeout(1_500);
  const names = downloads.map((download) => download.suggestedFilename());
  assert.equal(downloads.length, 12, `twelve downloads, no ZIP (${names.join(', ')})`);
  assert(names.every((name) => name.endsWith('.pdf')), `no ZIP is downloaded (${names.join(', ')})`);
  await pdfsOnly(downloads);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openSplit(page, qaPdf);
  assert.equal(await lineText(page), 'Saves 3 separate PDFs.', 'picked: separate at 3');
  await openSplit(page, twelvePages);
  assert.equal(await lineText(page), 'Saves 12 separate PDFs.', 'picked: still separate at 12 after a reload');
  assert.equal(await page.getByRole('radio', { name: 'Separate PDFs', exact: true }).isChecked(), true, 'the Separate PDFs radio is checked');
  await page.screenshot({ path: `${output}/picked-separate-twelve-${key}.png` });
  assert.deepEqual(errors, [], 'no page errors');
  results.push(`${key} picked separate: 12 PDF downloads at 12 parts; stays separate at 3 and at 12 after a reload`);
  console.log(`PASS ${results.at(-1)}`);
  await context.close();
}

// s3-03 (overnight A7): on a phone, a one-page split by maximum size keeps its size value in the
// sentence, and the value opens its editor (the limit can still be changed).
{
  const context = await newContext(browser, size('390x844'));
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openSplit(page);
  await page.getByRole('button', { name: /^Pages per file,/ }).click();
  await page.getByRole('radio', { name: 'Max file size', exact: true }).first().click();
  await page.keyboard.press('Escape');
  await page.locator('.tk-scrim:not([hidden])').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /^Pages to include,/ }).click();
  await page.getByRole('textbox', { name: 'Page numbers or ranges', exact: true }).fill('2');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await settle(page, 300);
  if (await page.locator('.tk-scrim:not([hidden])').count()) {
    await page.keyboard.press('Escape');
    await page.locator('.tk-scrim:not([hidden])').waitFor({ state: 'detached' });
  }
  const sizeValue = page.getByRole('button', { name: /^Max file size,/ });
  assert.equal(await sizeValue.count(), 1, 'one page in max-size mode: the size value is in the sentence');
  await sizeValue.click();
  await page.getByLabel('Maximum file size (MB)', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Maximum file size (MB)', { exact: true }).isVisible(), true, 'the value opens its editor');
  await page.screenshot({ path: `${output}/one-page-by-size-390x844.png` });
  assert.deepEqual(errors, [], 'no page errors');
  results.push('390x844 one page, max file size: the size value is in the sentence and opens its editor');
  console.log(`PASS ${results.at(-1)}`);
  await context.close();
}

await browser.close();
await writeFile(`${output}/results.json`, `${JSON.stringify({ status: 'PASS', origin, checks: results }, null, 2)}\n`);
