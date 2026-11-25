// Path to 9, part 2, checked in the browser:
//   1. Remove hidden info lists the file's hidden info, then shows each item removed; Remove blank
//      pages marks the blank pages on the grid before it runs
//   2. Page Numbers: format presets, and positions in words
//   3. Edit PDF says what an add, move, delete, undo and redo did; choosing a paragraph moves nothing
//   4. Home's "Recently used" row, and no row without history
//   5. Sign's reset returns to the starting view; a photos PDF is named after its first photo;
//      Batch Unlock asks for a password only for locked files; leaving a running Batch cancels it;
//      onboarding says results are kept
//
// Run against a preview of a fresh build:
//   PDF_CHEF_URL=http://127.0.0.1:4173 node scripts/verify-path-to-9-part2.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, PDFName } from 'pdf-lib';
import { ensureFixtures, fixtureFiles, loadFixture, newContext, photo, qaPdf, settle } from './lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const phone = { width: 390, height: 844, phone: true };
const tablet = { width: 768, height: 1024, phone: false };
const desktop = { width: 1440, height: 900, phone: false };

await ensureFixtures(chromium);
// Made from qa-sample.pdf for this run only.
const scratch = await mkdtemp(join(tmpdir(), 'pdf-chef-part2-'));
const withInfo = join(scratch, 'qa-with-info.pdf');
const withBlank = join(scratch, 'qa-with-blank.pdf');
{
  const doc = await PDFDocument.load(await readFile(qaPdf), { updateMetadata: false });
  doc.setTitle('Quarterly plan');
  doc.setAuthor('QA Author');
  doc.setSubject('QA subject');
  doc.setKeywords(['qa', 'sample']);
  doc.setCreator('QA Writer 2');
  doc.setProducer('QA PDF Maker 7');
  doc.setCreationDate(new Date('2024-03-05T10:00:00Z'));
  doc.setModificationDate(new Date('2025-06-07T12:00:00Z'));
  const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
  await writeFile(withInfo, await doc.save());
  const blank = await PDFDocument.load(await readFile(qaPdf));
  const [first] = blank.getPages();
  blank.insertPage(1, [first.getWidth(), first.getHeight()]);
  await writeFile(withBlank, await blank.save());
}

const browser = await chromium.launch({ headless: true });
let failures = 0;

// ONLY=<words> runs just the checks whose name holds those words.
const only = process.env.ONLY ?? '';
const check = async (name, size, settings, run) => {
  if (!name.includes(only)) return;
  const context = await newContext(browser, size, settings);
  const page = await context.newPage();
  try {
    await run(page, context);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n  ${String(error?.stack ?? error).split('\n').slice(0, 6).join('\n  ')}`);
  } finally {
    await context.close();
  }
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const opener = (page, name) => page.locator('[aria-haspopup="dialog"][aria-controls]:visible').and(page.getByRole('button', { name: new RegExp(`^${escape(name)},`) })).first();
const said = (page) => page.locator('p.sr-only[role="status"][aria-live="polite"]');
const saysSoon = async (page, words) => {
  await page.waitForFunction((text) => [...document.querySelectorAll('p.sr-only[role="status"][aria-live="polite"]')]
    .some((node) => node.textContent.replace(/​/g, '') === text), words, { timeout: 5000 })
    .catch(async () => assert.fail(`not announced: "${words}" (live lines: ${JSON.stringify(await said(page).allTextContents())})`));
};

// ------------------------------------------------------------------ 1. show the result first

await check('1 Remove hidden info lists the hidden info, then shows each item removed', desktop, {}, async (page) => {
  await loadFixture(page, '/remove-metadata', [withInfo], { origin });
  const list = page.getByRole('region', { name: 'Hidden info in this file' });
  await list.waitFor();
  await list.getByText('Quarterly plan').waitFor();
  const labels = (await list.locator('dt').allTextContents()).map((text) => text.trim());
  assert.deepEqual(labels, ['Title', 'Author', 'Subject', 'Keywords', 'Made with', 'Saved as PDF by', 'Created', 'Last changed', 'XMP details']);
  assert.equal(await list.locator('[data-removed]').count(), 0);
  await page.getByRole('button', { name: 'Remove hidden info', exact: true }).click();
  await list.getByText('The saved file has none of it.').waitFor({ timeout: 20_000 });
  assert.equal(await list.locator('[data-removed]').count(), 9);
  assert.equal(await list.getByText('Removed', { exact: true }).count(), 9);
});

await check('1 Remove blank pages marks the blank page before running, and removes the marked pages', phone, {}, async (page) => {
  await loadFixture(page, '/remove-blank-pages', [withBlank], { origin });
  const tile = (n, verb) => page.getByRole('button', { name: `${verb} page ${n}`, exact: true });
  await tile(2, 'Restore').waitFor({ timeout: 20_000 });
  assert.equal(await tile(2, 'Restore').getAttribute('aria-pressed'), 'true');
  for (const n of [1, 3, 4]) assert.equal(await tile(n, 'Mark').getAttribute('aria-pressed'), 'false', `page ${n}`);
  await page.getByText('Page 2 will be removed.').waitFor();
  const run = page.getByRole('button', { name: 'Remove blank pages', exact: true });
  // Unmarked, nothing is removed: the action waits for a mark.
  await tile(2, 'Restore').click();
  await page.getByText('No blank pages found.').waitFor();
  assert.equal(await run.isDisabled(), true);
  await tile(2, 'Mark').click();
  await page.getByText('Page 2 will be removed.').waitFor();
  await run.click();
  await page.getByText('Removed pages: 2').waitFor({ timeout: 20_000 });
});

// ------------------------------------------------------------------ 2. Page Numbers

await check('2 Page Numbers: a format preset sets the format, and positions are words', phone, {}, async (page) => {
  await loadFixture(page, '/page-numbers', [qaPdf], { origin });
  const format = opener(page, 'Format');
  await format.click();
  const editor = page.locator(`[id="${await format.getAttribute('aria-controls')}"]`);
  for (const preset of ['1', 'Page 1', 'Page 1 of 3', '1 / 3']) await editor.getByRole('button', { name: preset, exact: true }).waitFor();
  await editor.getByRole('button', { name: 'Page 1 of 3', exact: true }).click();
  await editor.waitFor({ state: 'hidden', timeout: 3000 });
  await opener(page, 'Format').filter({ hasText: 'Page 1 of 3' }).waitFor();
  const position = page.getByRole('button', { name: /^Position, Bottom center/ }).first();
  await position.click();
  const where = page.locator(`[id="${await position.getAttribute('aria-controls')}"]`);
  for (const name of ['Top left', 'Top center', 'Top right', 'Bottom left', 'Bottom center', 'Bottom right']) await where.getByRole('button', { name, exact: true }).waitFor();
  assert.equal(await where.getByRole('button', { name: 'Bottom center', exact: true }).getAttribute('aria-pressed'), 'true');
  await where.getByRole('button', { name: 'Top right', exact: true }).click();
  await page.getByRole('button', { name: /^Position, Top right/ }).first().waitFor({ timeout: 3000 });
});

// ------------------------------------------------------------------ 3. Edit PDF

await check('3 Edit PDF announces add, move, delete, undo and redo', desktop, {}, async (page) => {
  await loadFixture(page, '/edit', [qaPdf], { origin });
  await page.getByText('Test PDF page 1').first().waitFor({ timeout: 20_000 });
  // A keyboard press of Text adds a box at once.
  await page.getByRole('button', { name: 'Text', exact: true }).focus();
  await page.keyboard.press('Enter');
  await saysSoon(page, 'Text added on page 1.');
  const box = page.locator('[data-testid="pdf-zoom-viewport"] [tabindex="0"][aria-label]').last();
  await box.focus();
  await page.keyboard.press('ArrowRight');
  await saysSoon(page, 'Moved right.');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await saysSoon(page, 'Deleted.');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saysSoon(page, 'Undone.');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saysSoon(page, 'Redone.');
});

for (const size of [desktop, tablet]) {
  await check(`3 Edit PDF: choosing a paragraph at the top of the page moves nothing (${size.width} px)`, size, {}, async (page) => {
    await loadFixture(page, '/edit', [qaPdf], { origin });
    const viewport = page.locator('[data-testid="pdf-zoom-viewport"]');
    for (const text of ['Test PDF page 1', 'This is QA content']) {
      const target = viewport.getByText(text, { exact: false }).first();
      await target.waitFor({ timeout: 20_000 });
      const before = (await target.boundingBox()).y;
      await target.click();
      await page.getByTestId('pdf-paragraph-inspector').waitFor();
      await page.waitForTimeout(400);
      const after = (await viewport.getByText(text, { exact: false }).first().boundingBox()).y;
      assert.ok(Math.abs(after - before) <= 1, `"${text}" moved ${Math.round(after - before)} px`);
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByTestId('pdf-paragraph-inspector').waitFor({ state: 'hidden' });
    }
  });
}

// ------------------------------------------------------------------ 4. Home

await check('4 Home shows recently used tools from local history, and no row without it', phone, { keepLocalHistory: true }, async (page) => {
  await page.goto(new URL('/', origin).toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor();
  await settle(page, 300);
  assert.equal(await page.getByRole('heading', { name: 'Recently used' }).count(), 0, 'no history, no row');
  await page.evaluate(() => {
    localStorage.setItem('pdfchef.workspace.recent-tools.v1', JSON.stringify([
      { path: '/watermark', lastUsedAt: Date.now() - 1000, uses: 3 },
      { path: '/rotate', lastUsedAt: Date.now() - 2000, uses: 1 },
    ]));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const row = page.getByRole('region', { name: 'Recently used' });
  await row.waitFor();
  const links = row.getByRole('link');
  assert.deepEqual((await links.allTextContents()).map((text) => text.trim()), ['Watermark PDF', 'Rotate Pages']);
  await links.first().click();
  await page.waitForURL((url) => url.pathname === '/watermark');
});

// ------------------------------------------------------------------ 5. smaller fixes

await check('5 Sign: resetting the zoom returns to the starting view, not 100%', phone, {}, async (page) => {
  await loadFixture(page, '/sign', [qaPdf], { origin });
  const percent = page.locator('span.tabular:visible').filter({ hasText: '%' }).first();
  await percent.waitFor({ timeout: 20_000 });
  const reset = page.getByRole('button', { name: 'Reset zoom to 100%' }).locator('visible=true').first();
  const start = (await percent.textContent()).trim();
  assert.equal(await reset.isDisabled(), true, 'at the starting view, reset has nothing to do');
  await page.getByRole('button', { name: 'Zoom in' }).locator('visible=true').first().click();
  await page.waitForFunction(([el, was]) => el.textContent.trim() !== was, [await percent.elementHandle(), start]);
  await reset.click();
  await page.waitForFunction(([el, was]) => el.textContent.trim() === was, [await percent.elementHandle(), start], { timeout: 3000 })
    .catch(async () => assert.fail(`reset went to ${await percent.textContent()}, not the starting ${start}`));
  assert.notEqual(start, '100%', 'a phone starts fitted to the width, so 100% would not be the starting view');
});

await check('5 Create PDF names the PDF after its first photo', phone, {}, async (page) => {
  await loadFixture(page, '/make-pdf', [photo('tall.jpg')], { origin });
  assert.equal(await page.locator('#make-pdf-name').inputValue(), 'tall');
});

await check('5 Batch Unlock asks for a password only when a file is locked', phone, {}, async (page) => {
  await loadFixture(page, '/batch', [qaPdf], { origin });
  await page.getByRole('combobox').first().selectOption('unlock');
  await page.getByText('No password', { exact: true }).waitFor({ timeout: 10_000 });
  const sentence = page.locator('.tk-sentence:not(.tk-measure)').first();
  await page.waitForFunction((el) => el.textContent.trim() === 'Run Unlock PDF on 1 PDF.', await sentence.elementHandle(), { timeout: 5000 });
  assert.equal(await page.getByRole('button', { name: /^Process 1 file/ }).isDisabled(), false);
  await page.locator('input[type=file]').first().setInputFiles(fixtureFiles.locked);
  await page.getByText('Locked', { exact: true }).waitFor({ timeout: 10_000 });
  await page.waitForFunction((el) => el.textContent.trim().endsWith('with no password yet.'), await sentence.elementHandle(), { timeout: 5000 });
  await page.locator('input[type="password"]').first().fill('pdfchef-qa');
  await page.waitForFunction((el) => el.textContent.trim() === 'Run Unlock PDF on 2 PDFs with a password for the 1 locked PDF.', await sentence.elementHandle(), { timeout: 5000 })
    .catch(async () => assert.fail(`sentence: ${await sentence.textContent()}`));
});

const copies = [];
for (let n = 1; n <= 12; n += 1) {
  copies.push(join(scratch, `qa-copy-${n}.pdf`));
  await writeFile(copies.at(-1), await readFile(qaPdf));
}
// Twelve files, rotated, with the processor slowed so the job is still running a moment later.
// A finished Batch's ZIP is kept in Recent, which is what these two read.
const startSlowBatch = async (page, context) => {
  await loadFixture(page, '/batch', copies, { origin });
  await page.getByRole('combobox').first().selectOption('rotate');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 12 });
  await page.getByRole('button', { name: /^Process 12 files/ }).click();
  await page.locator('[role="progressbar"]').first().waitFor({ timeout: 10_000 });
  return cdp;
};
const zipsInRecent = async (page) => {
  await page.locator('a[href="/recent"]:visible').first().click();
  await page.waitForURL((url) => url.pathname === '/recent');
  await settle(page, 800);
  return page.getByText(/^Batch Processing .*\.zip$/).count();
};

await check('5 a Batch left to run keeps its ZIP in Recent (the control for the next check)', phone, { keepLocalHistory: true }, async (page, context) => {
  const cdp = await startSlowBatch(page, context);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'), null, { timeout: 60_000 });
  // The new result's sheet opens by itself; close it, then leave.
  const sheet = page.getByRole('dialog').first();
  await sheet.waitFor({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden', timeout: 5000 });
  await page.locator('a[data-tk-tools]').click();
  const ask = page.getByRole('dialog', { name: 'Leave this tool and discard your files?' });
  if (await ask.isVisible().catch(() => false)) await ask.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/');
  assert.equal(await zipsInRecent(page), 1);
});

await check('5 leaving a running Batch cancels it: no ZIP arrives', phone, { keepLocalHistory: true }, async (page, context) => {
  const cdp = await startSlowBatch(page, context);
  await page.locator('a[data-tk-tools]').click();
  const ask = page.getByRole('dialog', { name: 'Leave this tool and discard your files?' });
  await ask.waitFor({ timeout: 5000 });
  await ask.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  // Long enough for the twelve files to finish, had the job kept running.
  await page.waitForTimeout(8000);
  assert.equal(await page.getByRole('dialog').count(), 0, 'a result sheet opened after leaving: the job kept running');
  assert.equal(await zipsInRecent(page), 0, 'a ZIP arrived after leaving');
});

await check('5 onboarding says results are kept, the default', phone, { onboardingComplete: false }, async (page) => {
  await page.goto(new URL('/', origin).toString(), { waitUntil: 'domcontentloaded' });
  await page.getByText('Results are kept in Recent on this device. You can turn this off in Settings.').waitFor({ timeout: 10_000 });
});

await browser.close();
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('path to 9, part 2: all checks passed');
