// The final fix round's findings (output/web/ui-redesign/audit/prompts/final-fix.md) and fix round 2
// (final-fix-2.md, the checks at the end), one check each, on a phone (390×844) and a laptop (1440×900) unless a size is named. Each check passes on
// the fixed build and fails on the build the re-score reports describe (r8-dist).
//
//   PDF_CHEF_URL=http://127.0.0.1:4173 node tests/browser/finalFixChecks.mjs [--only=a,b] [--shots=dir] [--label=after]
//
// QA files only: qa-sample.pdf, tests/fixtures/ui, and a blank-page PDF made here with pdf-lib.
// Works on preview (built dist) or dev.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from 'pdf-lib';
import { ensureFixtures, fixtureFiles, loadFiles, loadFixture, newContext, photo, qaPdf, root, settle, tools } from '../../scripts/lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const only = arg('only')?.split(',').filter(Boolean) ?? null;
const label = arg('label') ?? 'run';
const shots = arg('shots') ? resolve(root, arg('shots')) : null;
if (shots) await mkdir(shots, { recursive: true });

const phone = { key: '390', width: 390, height: 844, phone: true };
const laptop = { key: '1440', width: 1440, height: 900, phone: false };
const browser = await chromium.launch({ headless: true });
const results = [];

const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: resolve(shots, `${label}-${name}.png`) }).catch(() => {});
};

const check = async (id, size, run) => {
  if (only && !only.includes(id)) return;
  const name = `${id} @${size.key}`;
  const context = await newContext(browser, size, size.settings ?? {});
  if (size.noPicker) await context.addInitScript(() => { delete window.showSaveFilePicker; });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  try {
    const detail = await run(page, size);
    results.push({ id, size: size.key, pass: true, detail });
    console.log(`ok   ${name}${detail ? ` · ${detail}` : ''}`);
  } catch (error) {
    results.push({ id, size: size.key, pass: false, detail: error.message.split('\n')[0] });
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
    await shot(page, `${id}-${size.key}-fail`);
  } finally {
    await context.close();
  }
};

const assertThat = (condition, message) => { if (!condition) throw new Error(message); };
const text = async (locator) => ((await locator.first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const sentenceText = (page) => text(page.locator('p.tk-sentence:not(.tk-measure), .tk-rows').first());
const noticeText = (page) => text(page.locator('.tk-notice').first());
const press = async (page, locator, size) => {
  if (size.phone) await locator.tap();
  else await locator.click();
};
/** On a phone a setting's control sits in its value's card (owner decision 2026-11-15): open the
 *  slot whose card holds `target`. Does nothing where the control is already on the screen. */
const reveal = async (page, target, size) => {
  if (await target.isVisible().catch(() => false)) return;
  // Another card still open (Batch's Operation, after its choice) is closed first.
  if (await page.locator('.tk-pop').filter({ visible: true }).count()) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  const openers = page.locator('.tk-sentence-group [aria-haspopup="dialog"][aria-controls]');
  for (let index = 0; index < await openers.count(); index += 1) {
    await press(page, openers.nth(index), size);
    await page.waitForTimeout(250);
    if (await target.isVisible().catch(() => false)) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  throw new Error('the control is in no slot\'s card');
};

/** A three-page PDF whose middle page is empty (Remove blank pages). */
const blankPdf = async () => {
  const path = resolve(tmpdir(), 'pdfchef-final-fix-blank.pdf');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const words of ['First page with text', null, 'Third page with text']) {
    const sheet = doc.addPage([595, 842]);
    if (words) sheet.drawText(words, { x: 60, y: 760, size: 18, font });
  }
  await writeFile(path, await doc.save());
  return path;
};

// 1. Delete Pages: a rejected range leaves the sentence on the marks and Save disabled.
for (const size of [phone, laptop]) {
  await check('delete-invalid', size, async (page) => {
    await loadFixture(page, '/delete-pages', [qaPdf], { origin });
    await press(page, page.getByRole('button', { name: 'Mark page 2' }), size);
    const field = page.getByRole('textbox', { name: 'Mark a page range' });
    await reveal(page, field, size);
    await field.fill('1,99');
    await press(page, page.getByRole('button', { name: 'Mark', exact: true }), size);
    await page.waitForTimeout(300);
    await shot(page, `delete-invalid-${size.key}`);
    const sentence = await sentenceText(page);
    const save = page.getByRole('button', { name: 'Save without those pages' });
    assertThat(!sentence.includes('1,99'), `sentence shows the rejected text: "${sentence}"`);
    assertThat(/page 2/.test(sentence), `sentence lost the committed mark: "${sentence}"`);
    assertThat(await save.isDisabled(), 'Save is enabled while the submitted range is rejected');
    // Correcting the range commits it and enables Save again.
    await reveal(page, field, size);
    await field.fill('1');
    await press(page, page.getByRole('button', { name: 'Mark', exact: true }), size);
    await page.waitForTimeout(200);
    assertThat(!(await save.isDisabled()), 'Save stays disabled after a valid range');
    return sentence;
  });
}

// 1b. Split and Extract: the same rejected range keeps the sentence on the committed selection.
for (const [route, saveName] of [['/split', 'Save the split files'], ['/extract', /^Export/]]) {
  for (const size of [phone, laptop]) {
    await check(`range-invalid${route.replace('/', '-')}`, size, async (page) => {
      await loadFixture(page, route, [qaPdf], { origin });
      const field = page.getByRole('textbox', { name: 'Page numbers or ranges' });
      await reveal(page, field, size);
      await field.fill('1,99');
      await press(page, page.getByRole('button', { name: 'Select', exact: true }), size);
      await page.waitForTimeout(300);
      await shot(page, `range-invalid${route.replace('/', '-')}-${size.key}`);
      const sentence = await sentenceText(page);
      assertThat(!sentence.includes('1,99'), `sentence shows the rejected text: "${sentence}"`);
      assertThat(await page.getByRole('button', { name: saveName }).first().isDisabled(), 'the main action is enabled while the range is rejected');
      return sentence;
    });
  }
}

// 2. Download automatically: a finished job downloads with no click, with and without a save picker.
for (const base of [phone, laptop]) {
  for (const noPicker of [false, true]) {
    const size = { ...base, noPicker, settings: { autoDownload: true } };
    await check(`auto-download${noPicker ? '-no-picker' : '-picker'}`, size, async (page) => {
      await loadFixture(page, '/flatten', [fixtureFiles.fillable], { origin });
      const hasPicker = await page.evaluate(() => 'showSaveFilePicker' in window);
      assertThat(hasPicker === !noPicker, `showSaveFilePicker present: ${hasPicker}`);
      const downloaded = page.waitForEvent('download', { timeout: 10_000 });
      await press(page, page.getByRole('button', { name: 'Lock the answers and save' }), size);
      const download = await downloaded.catch(() => null);
      assertThat(download, 'no download within 10 s of the finished job');
      return download.suggestedFilename();
    });
  }
}

// 3. An earlier result: after the marks change it is not offered as the current one-tap download;
//    after the file changes it is no longer the screen's result.
for (const size of [phone, laptop]) {
  await check('earlier-result', size, async (page) => {
    await loadFixture(page, '/delete-pages', [qaPdf], { origin });
    await press(page, page.getByRole('button', { name: 'Mark page 2' }), size);
    await press(page, page.getByRole('button', { name: 'Save without those pages' }), size);
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const strip = page.locator('.chef-result-face');
    const stripDownload = strip.getByRole('button', { name: /^Download / });
    assertThat(await stripDownload.isVisible(), 'the strip has no one-tap Download before any change');
    await press(page, page.getByRole('button', { name: 'Mark page 1' }), size);
    await page.waitForTimeout(400);
    await shot(page, `earlier-result-${size.key}`);
    assertThat(!(await stripDownload.isVisible().catch(() => false)), 'the strip still offers the old file as a one-tap Download');
    const stripText = await text(strip);
    assertThat(/Earlier result/.test(stripText), `the strip does not say the result is earlier: "${stripText}"`);
    // The sheet keeps every button.
    await press(page, strip.getByRole('button', { name: /^More actions for/ }), size);
    const sheet = page.getByRole('dialog');
    await sheet.waitFor();
    for (const name of ['Download', 'Rename', 'Use in another tool']) {
      assertThat(await sheet.getByRole('button', { name, exact: true }).count() > 0, `the sheet lost ${name}`);
    }
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    // A new file: the old result is not this screen's result any more.
    await press(page, page.getByRole('button', { name: 'Choose another file' }).first(), size);
    await page.locator('input[type=file]').first().setInputFiles(fixtureFiles.fillable);
    await settle(page, 600);
    await shot(page, `earlier-result-new-file-${size.key}`);
    const after = await text(strip);
    assertThat(!(await stripDownload.isVisible().catch(() => false)), 'after a new file the strip offers the old file as a one-tap Download');
    assertThat(!after || /Earlier result/.test(after), `after a new file the old result reads as current: "${after}"`);
    return stripText;
  });
}

// 5. Escape on a result sheet that opened by itself returns focus to the control that ran the job.
await check('sheet-escape-focus', laptop, async (page) => {
  await loadFixture(page, '/merge', [qaPdf, fixtureFiles.fillable], { origin });
  const save = page.getByRole('button', { name: 'Save the combined PDF' });
  await save.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.waitForTimeout(200);
  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    return active ? (active.getAttribute('aria-label') || active.textContent || active.tagName).trim() : '';
  });
  await shot(page, 'sheet-escape-focus-1440');
  assertThat(/Save the combined PDF|More actions for/.test(focused), `focus went to "${focused}"`);
  return focused;
});

// 6. Leaving after the result was saved does not ask.
for (const size of [phone, laptop]) {
  await check('leave-after-save', size, async (page) => {
    await loadFixture(page, '/merge', [qaPdf, fixtureFiles.fillable], { origin });
    await press(page, page.getByRole('button', { name: 'Save the combined PDF' }), size);
    const sheet = page.getByRole('dialog');
    await sheet.waitFor();
    const downloaded = page.waitForEvent('download');
    await press(page, sheet.getByRole('button', { name: 'Download', exact: true }), size);
    await downloaded;
    await page.waitForTimeout(300);
    if (await sheet.isVisible().catch(() => false)) await page.keyboard.press('Escape');
    await press(page, page.getByRole('link', { name: 'Tools' }).first(), size);
    await page.waitForTimeout(600);
    const asked = await page.getByRole('dialog', { name: /Leave this tool/ }).isVisible().catch(() => false);
    await shot(page, `leave-after-save-${size.key}`);
    assertThat(!asked, 'the leave question appeared after the result was saved');
    assertThat(new URL(page.url()).pathname === '/', `still on ${new URL(page.url()).pathname}`);
    return 'left without a question';
  });
}

// 6b. A loaded file with no saved result still asks.
await check('leave-unsaved-asks', laptop, async (page) => {
  await loadFixture(page, '/merge', [qaPdf, fixtureFiles.fillable], { origin });
  await page.getByRole('link', { name: 'Tools' }).first().click();
  await page.waitForTimeout(400);
  assertThat(await page.getByRole('dialog', { name: /Leave this tool/ }).isVisible(), 'no question with unsaved files');
  return 'asked';
});

// 7. Remove blank pages: unticking a found page says how many were found and how many go.
for (const size of [phone, laptop]) {
  await check('blank-untick', size, async (page) => {
    await loadFixture(page, '/remove-blank-pages', [await blankPdf()], { origin });
    await page.getByRole('button', { name: 'Restore page 2' }).waitFor({ timeout: 20_000 });
    await press(page, page.getByRole('button', { name: 'Restore page 2' }), size);
    await page.waitForTimeout(300);
    await shot(page, `blank-untick-${size.key}`);
    const notice = await noticeText(page);
    assertThat(!/No blank pages found/.test(notice), `notice: "${notice}"`);
    assertThat(/1 blank page found/.test(notice) && /0 will be removed/.test(notice), `notice does not count found and removed: "${notice}"`);
    return notice;
  });
}

// 9. Split: a typed range enables Save without Select.
for (const size of [phone, laptop]) {
  await check('split-typed', size, async (page) => {
    await loadFixture(page, '/split', [qaPdf], { origin });
    const field = page.getByRole('textbox', { name: 'Page numbers or ranges' });
    await reveal(page, field, size);
    await field.fill('1-2');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await shot(page, `split-typed-${size.key}`);
    const save = page.getByRole('button', { name: 'Save the split files' });
    assertThat(!(await save.isDisabled()), 'Save is disabled until Select');
    const sentence = await sentenceText(page);
    assertThat(/pages 1–2/.test(sentence), `sentence: "${sentence}"`);
    return sentence;
  });
}

// 10. Make Fillable on a phone: with New field open, a drag in the page's bottom tenth places a field.
await check('fillable-bottom-drag', phone, async (page) => {
  await loadFixture(page, '/make-fillable', [qaPdf], { origin });
  await page.getByRole('button', { name: 'Draw field on page' }).tap();
  await page.getByRole('button', { name: 'New field', exact: true }).tap();
  await page.getByRole('dialog', { name: 'New field' }).waitFor();
  await page.waitForTimeout(400);
  const image = page.locator('.tk-fill-img');
  const box = await image.boundingBox();
  await shot(page, 'fillable-bottom-drag-390-open');
  // From 85% to 95% of the page's height, as in the h1 probe.
  const from = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.85 };
  const to = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.95 };
  const hit = await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.tk-fill-img, .tk-fill-stage [class*="relative"]')), from);
  const cdp = await page.context().newCDPSession(page);
  const at = (point) => [{ x: point.x, y: point.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at({ x: from.x + ((to.x - from.x) * step) / 6, y: from.y + ((to.y - from.y) * step) / 6 }) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
  await shot(page, 'fillable-bottom-drag-390-after');
  const fields = await page.locator('.tk-fill-img ~ button[aria-pressed]').count();
  assertThat(hit, `the page's bottom (y ${Math.round(from.y)}) is under the New field card`);
  assertThat(fields === 1, `fields on the page after the drag: ${fields}`);
  return `page ${Math.round(box.y)}–${Math.round(box.y + box.height)}, field placed`;
});

// 11. Sign on a tablet in portrait: the first view shows the whole page width.
for (const size of [{ key: '768', width: 768, height: 1024, phone: true }, { key: '834', width: 834, height: 1194, phone: true }, laptop]) {
  await check('sign-fit', size, async (page) => {
    await loadFixture(page, '/sign', [qaPdf], { origin });
    const viewport = page.getByTestId('pdf-zoom-viewport');
    await viewport.locator('canvas').first().waitFor();
    await page.waitForTimeout(400);
    await shot(page, `sign-fit-${size.key}`);
    const { inner, page: sheet } = await viewport.evaluate((node) => {
      const own = node.getBoundingClientRect();
      const canvas = node.querySelector('canvas').getBoundingClientRect();
      return { inner: { left: own.left, right: own.left + node.clientWidth }, page: { left: canvas.left, right: canvas.right } };
    });
    assertThat(sheet.left >= inner.left - 1 && sheet.right <= inner.right + 1, `page ${Math.round(sheet.left)}–${Math.round(sheet.right)} in a viewport ${Math.round(inner.left)}–${Math.round(inner.right)}`);
    return `page ${Math.round(sheet.right - sheet.left)} px wide in ${Math.round(inner.right - inner.left)} px`;
  });
}

// 12. Edit PDF on a phone: starting to edit does not zoom the page.
await check('edit-zoom-phone', phone, async (page) => {
  await loadFixture(page, '/edit', [qaPdf], { origin });
  const zoomBox = page.getByTestId('pdf-zoom-viewport');
  const pageWidth = () => zoomBox.locator('canvas').first().evaluate((node) => Math.round(node.getBoundingClientRect().width));
  await zoomBox.locator('canvas').first().waitFor();
  await page.waitForTimeout(600);
  const before = await pageWidth();
  const paragraph = page.locator('[data-block-id]').first();
  await paragraph.tap();
  await page.waitForTimeout(800);
  const afterParagraph = await pageWidth();
  await shot(page, 'edit-zoom-phone-390-paragraph');
  assertThat(Math.abs(afterParagraph - before) <= 2, `page width ${before} → ${afterParagraph} on a paragraph tap`);
  return `${before} → ${afterParagraph}`;
});

// 13. Invoice: the number's hint fits on a laptop, and the Tax % hint stays after typing.
for (const size of [phone, laptop]) {
  await check('invoice-hints', size, async (page) => {
    await page.goto(new URL('/invoice', origin).toString());
    await page.locator('h1').first().waitFor();
    await page.waitForTimeout(500);
    const number = page.getByRole('textbox', { name: /Invoice number/ });
    const cut = await number.evaluate((input) => {
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas').getContext('2d');
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return canvas.measureText(input.placeholder).width > room + 1 ? `${input.placeholder} (${Math.round(canvas.measureText(input.placeholder).width)} px in ${Math.round(room)} px)` : '';
    });
    const tax = page.getByRole('textbox', { name: /^Tax %/ });
    await tax.fill('10');
    await number.scrollIntoViewIfNeeded();
    await shot(page, `invoice-hints-${size.key}`);
    const taxLabel = await tax.evaluate((input) => (input.closest('label')?.textContent || '').replace(/\s+/g, ' ').trim());
    assertThat(!cut, `the invoice number hint is cut: ${cut}`);
    assertThat(/leave (it )?blank/i.test(taxLabel), `the Tax % hint is gone after typing: "${taxLabel}"`);
    return taxLabel;
  });
}

// 14. Page Numbers on a laptop: one position looks chosen.
await check('page-numbers-position', laptop, async (page) => {
  await loadFixture(page, '/page-numbers', [qaPdf], { origin });
  const group = page.locator('.tk-side-setting[data-setting="position"]').getByRole('group', { name: 'Position' });
  await group.getByRole('button', { name: 'Top right' }).click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(80);
  await shot(page, 'page-numbers-position-1440');
  const tinted = await group.getByRole('button').evaluateAll((buttons) => buttons
    .filter((button) => getComputedStyle(button).backgroundColor !== getComputedStyle(buttons.find((other) => other.getAttribute('aria-pressed') !== 'true') ?? button).backgroundColor || button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent.trim()));
  assertThat(tinted.length === 1 && tinted[0] === 'Top right', `looks chosen: ${tinted.join(', ')}`);
  return tinted.join(', ');
});

// 8. Batch, Protect PDF on a locked file: the message points to Unlock PDF, not Repair PDF (h4 F4).
for (const size of [phone, laptop]) {
  await check('batch-locked', size, async (page) => {
    await ensureFixtures(chromium);
    await loadFixture(page, '/batch', [fixtureFiles.locked], { origin });
    await reveal(page, page.locator('select').first(), size);
    await page.locator('select').first().selectOption('protect');
    await reveal(page, page.locator('input[type="password"]').first(), size);
    await page.locator('input[type="password"]').first().fill('qa-new-password');
    // On a phone the password card is still open: a finger tap on the main action closes it and runs
    // the job (Playwright's own tap waits for the card to go, so tap the spot, as a finger does).
    const main = page.locator('.tk-primary').filter({ visible: true }).first();
    if (size.phone) {
      const box = await main.boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    } else await press(page, main, size);
    const said = page.getByText(/password-protected|could not be processed/).first();
    await said.waitFor({ timeout: 60_000 });
    await shot(page, `batch-locked-${size.key}`);
    const message = await text(said);
    assertThat(/Unlock PDF/.test(message) && !/Repair PDF/.test(message), `message: ${message}`);
    return message;
  });
}

// 3. No false "earlier result": a fresh result in each tool stays current while the person does
// nothing (a tool that changes its own sentence or file after a job must not mark it earlier).
const sweep = ['compress', 'merge', 'split', 'watermark', 'page-numbers', 'flatten', 'image-to-pdf', 'make-pdf',
  'pdf-to-jpg', 'pdf-to-word', 'word-to-pdf', 'powerpoint-to-pdf', 'metadata', 'repair', 'crop', 'extract-images',
  'remove-metadata', 'remove-annotations', 'sanitize', 'remove-blank-pages', 'batch', 'header-footer', 'extract', 'rotate', 'reorder', 'delete-pages'];
for (const tool of tools.filter((item) => sweep.includes(item.id))) {
  await check(`fresh-result-${tool.id}`, phone, async (page) => {
    await ensureFixtures(chromium);
    await loadFixture(page, tool.route, tool.id === 'remove-blank-pages' ? [await blankPdf()] : tool.files(), { origin });
    // A first choice where the main action needs one.
    const first = { extract: 'Select all', 'delete-pages': 'Mark page 2' }[tool.id];
    if (first) await page.getByRole('button', { name: first, exact: true }).first().tap();
    if (tool.id === 'remove-blank-pages') await page.locator('.tk-notice').filter({ hasText: /will be removed/ }).first().waitFor();
    const main = page.locator('.tk-primary').first();
    if (await main.isDisabled()) return 'skipped: the main action needs a choice first';
    // Compress makes a preview first, then saves: the main action is pressed until a result comes.
    const strip = page.locator('.chef-result-face').first();
    for (let press = 0; press < 3 && !(await strip.isVisible()); press += 1) {
      if (await main.isVisible() && await main.isEnabled()) await main.tap();
      await strip.waitFor({ timeout: 30_000 }).catch(() => {});
    }
    if (!(await strip.isVisible())) {
      if (['extract-images', 'compress'].includes(tool.id)) return `skipped, no result for this file: ${await noticeText(page)}`;
      throw new Error(`no result after the main action: ${await noticeText(page)}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2500);
    const line = await text(strip);
    assertThat(!/Earlier result/.test(line), `a fresh result reads as earlier: ${line}`);
    assertThat(await page.locator('.chef-result-download').count() === 1, 'the strip lost its one-tap Download');
    return line;
  });
}

// ------------------------------------------------------------------ Fix round 2 (final-fix-2.md)

/** Runs the tool's main action until the result strip shows, then closes the sheet. */
const makeResult = async (page, tool) => {
  const first = { extract: 'Select all', 'delete-pages': 'Mark page 2', reorder: 'Move page 1 down' }[tool.id];
  if (first) await page.getByRole('button', { name: first, exact: true }).first().click();
  if (tool.id === 'rotate') await page.locator('[data-turn="right"]').first().click();
  if (tool.id === 'remove-blank-pages') await page.locator('.tk-notice').filter({ hasText: /will be removed/ }).first().waitFor();
  const main = page.locator('.tk-primary').first();
  if (await main.isDisabled()) return false;
  const strip = page.locator('.chef-result-face').first();
  for (let round = 0; round < 3 && !(await strip.isVisible()); round += 1) {
    if (await main.isVisible() && await main.isEnabled()) await main.click();
    await strip.waitFor({ timeout: 30_000 }).catch(() => {});
  }
  if (!(await strip.isVisible())) return false;
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' }).catch(() => {});
  await page.waitForTimeout(800);
  return true;
};

// Item 1. "Earlier result" follows every input the result is made from, in every tool, with no
// list of settings per tool: one choice changed after the result marks it earlier.
/** A four-page PDF that shows one photo on every page (Extract Images; Compress can shrink it). */
const photoPdf = async () => {
  const path = resolve(tmpdir(), 'pdfchef-fix2-one-photo.pdf');
  const doc = await PDFDocument.create();
  const photo = await doc.embedJpg(await readFile(resolve(root, 'tests/fixtures/photos/wide.jpg')));
  for (let i = 0; i < 4; i += 1) doc.addPage([595, 842]).drawImage(photo, { x: 60, y: 400, width: 300, height: 200 });
  await writeFile(path, await doc.save());
  return path;
};
/** Two pages showing one uncompressed picture: Compress gives a result for it. */
const rawImagePdf = async () => {
  const path = resolve(tmpdir(), 'pdfchef-fix2-raw.pdf');
  const doc = await PDFDocument.create();
  const width = 500;
  const pixels = new Uint8Array(width * width * 3);
  for (let y = 0; y < width; y += 1) for (let x = 0; x < width; x += 1) pixels.set([x % 256, y % 256, (x + y) % 256], (y * width + x) * 3);
  const picture = doc.context.register(doc.context.stream(pixels, { Type: 'XObject', Subtype: 'Image', Width: width, Height: width, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  for (let i = 0; i < 2; i += 1) {
    const sheet = doc.addPage([595, 842]);
    const name = sheet.node.newXObject('Im', picture);
    sheet.pushOperators(pushGraphicsState(), concatTransformationMatrix(400, 0, 0, 400, 90, 300), drawObject(name), popGraphicsState());
  }
  await writeFile(path, await doc.save({ useObjectStreams: false }));
  return path;
};
const changeOne = {
  'image-to-pdf': (page) => page.getByRole('button', { name: 'Rotate image clockwise' }).first().click(),
  merge: (page) => page.getByRole('button', { name: /^Move qa-sample\.pdf down/ }).click(),
  rotate: (page) => page.locator('[data-turn="left"]').first().click(),
  reorder: (page) => page.getByRole('button', { name: 'Move page 2 down', exact: true }).first().click(),
  'page-numbers': (page) => page.locator('.tk-side-setting[data-setting="position"]').getByRole('button', { name: 'Top left' }).click(),
};
const earlierSweep = ['merge', 'page-numbers', 'split', 'watermark', 'rotate', 'extract', 'delete-pages', 'compress', 'pdf-to-jpg',
  'header-footer', 'crop', 'remove-blank-pages', 'reorder', 'image-to-pdf', 'make-pdf'];
for (const tool of tools.filter((item) => earlierSweep.includes(item.id))) {
  await check(`earlier-change-${tool.id}`, laptop, async (page) => {
    await ensureFixtures(chromium);
    const files = tool.id === 'remove-blank-pages' ? [await blankPdf()] : tool.id === 'compress' ? [await rawImagePdf()] : tool.files();
    await loadFixture(page, tool.route, files, { origin });
    await settle(page, 600);
    if (!(await makeResult(page, tool))) return 'skipped: no result for this file';
    const strip = page.locator('.chef-result-face').first();
    const before = await text(strip);
    assertThat(!/Earlier result/.test(before), `fresh result reads as earlier: ${before}`);
    let changed = 'named control';
    if (changeOne[tool.id]) await changeOne[tool.id](page);
    else {
      // The first choice on the screen that is not pressed (a page tile, a position, an option).
      const choice = page.locator('.tk-screen :is([aria-pressed="false"], [role="radio"][aria-checked="false"], [role="switch"], input[type="checkbox"])')
        .filter({ visible: true })
        .and(page.locator(':not(.chef-result-face *):not(.tk-top *):not([data-work-ignore] *)'));
      // Otherwise the first field: a new value typed, or another option chosen.
      const field = page.locator('.tk-screen :is(input[type="text"], input[type="number"], input:not([type]), textarea, select)')
        .filter({ visible: true })
        .and(page.locator(':not(.chef-result-face *):not(.tk-top *):not([data-work-ignore] *)'));
      if (await choice.count()) {
        changed = (await choice.first().getAttribute('aria-label')) || (await text(choice.first())) || 'a choice';
        await choice.first().click();
      } else if (await field.count()) {
        const target = field.first();
        changed = `field ${(await target.getAttribute('aria-label')) || (await target.getAttribute('name')) || ''}`.trim();
        if (await target.evaluate((node) => node.tagName === 'SELECT')) {
          const values = await target.evaluate((node) => [...node.options].map((option) => option.value));
          const current = await target.inputValue();
          await target.selectOption(values.find((value) => value !== current));
        } else {
          const current = await target.inputValue();
          await target.fill(/^\d+$/.test(current) ? String(Number(current) + 1) : `${current}x`);
          await page.keyboard.press('Tab');
        }
      } else return `skipped: no choice or field on screen (${before})`;
    }
    await page.waitForTimeout(700);
    const after = await text(strip);
    await shot(page, `earlier-change-${tool.id}-1440`);
    assertThat(/Earlier result/.test(after), `after "${changed}" the strip still reads as current: ${after}`);
    return `${changed} -> ${after}`;
  });
}

// Item 1. Merge: moving the file back makes the result current again; a look around (Tab, a click
// on the page's background, a scroll) never marks it earlier.
await check('earlier-merge-back', laptop, async (page) => {
  await loadFixture(page, '/merge', [qaPdf, fixtureFiles.fillable], { origin });
  assertThat(await makeResult(page, { id: 'merge' }), 'no Merge result');
  const strip = page.locator('.chef-result-face').first();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');
  await page.mouse.click(700, 120);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(600);
  const looked = await text(strip);
  assertThat(!/Earlier result/.test(looked), `a look around marks the result earlier: ${looked}`);
  await page.getByRole('button', { name: /^Move qa-sample\.pdf down/ }).click();
  await page.waitForTimeout(500);
  assertThat(/Earlier result/.test(await text(strip)), 'a reorder does not mark the result earlier');
  await page.getByRole('button', { name: /^Move qa-sample\.pdf up/ }).click();
  await page.waitForTimeout(500);
  const back = await text(strip);
  assertThat(!/Earlier result/.test(back), `the same order again still reads as earlier: ${back}`);
  return back;
});

// Item 2. The browser's Back asks as the Tools link does, and does not ask once the result is saved.
await check('back-asks', laptop, async (page) => {
  await page.goto(`${origin}/`);
  await settle(page, 400);
  await page.getByRole('link', { name: /^Merge PDF/ }).first().click();
  await settle(page, 600);
  await page.locator('input[type=file]').first().setInputFiles([qaPdf, fixtureFiles.fillable]);
  await settle(page, 1200);
  await page.goBack();
  const ask = page.getByRole('dialog', { name: /Leave this tool/ });
  await ask.waitFor({ timeout: 3000 }).catch(() => {});
  assertThat(await ask.isVisible(), 'Back left the tool with no question');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(300);
  assertThat(new URL(page.url()).pathname === '/merge', `Cancel did not stay: ${page.url()}`);
  // Saved: Back leaves without a question.
  await page.getByRole('button', { name: 'Save the combined PDF' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.waitFor();
  const downloaded = page.waitForEvent('download');
  await sheet.getByRole('button', { name: 'Download', exact: true }).click();
  await downloaded;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.goBack();
  await page.waitForTimeout(800);
  assertThat(!(await ask.isVisible().catch(() => false)), 'Back asks after the result was saved');
  assertThat(new URL(page.url()).pathname === '/', `Back did not leave after a save: ${page.url()}`);
  return 'asked, then left after the save';
});

// Item 3. After a file is added, focus is inside the tool, not on the header's Tools link.
for (const route of ['/edit', '/make-fillable', '/sign', '/metadata']) {
  await check(`focus-after-load${route.replace('/', '-')}`, laptop, async (page) => {
    await page.goto(`${origin}${route}`);
    await settle(page, 400);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.tk-canvas button').filter({ visible: true }).first().focus();
    await page.keyboard.press('Enter');
    await (await chooser).setFiles([qaPdf]);
    await settle(page, 1800);
    const where = await page.evaluate(() => {
      const element = document.activeElement;
      return {
        inTool: Boolean(element?.closest('.tk-screen')) && !element?.closest('.tk-top, header, nav'),
        name: `${element?.tagName}:${(element?.getAttribute('aria-label') || element?.textContent || '').trim().slice(0, 40)}`,
      };
    });
    assertThat(where.inTool, `focus is on ${where.name}`);
    return where.name;
  });
}

// Item 4. Clearing the file moves focus to the file picker and says what was removed.
for (const route of ['/compress', '/rotate']) {
  await check(`clear-focus${route.replace('/', '-')}`, laptop, async (page) => {
    await loadFixture(page, route, [qaPdf], { origin });
    await settle(page, 600);
    await page.locator('[data-tk-change]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const state = await page.evaluate(() => ({
      focus: `${document.activeElement?.tagName}:${(document.activeElement?.textContent || '').trim()}`,
      inCanvas: Boolean(document.activeElement?.closest('.tk-canvas')),
      said: [...document.querySelectorAll('[role=status],[aria-live]')].map((node) => node.textContent.trim()).filter(Boolean),
    }));
    assertThat(state.inCanvas && /Choose/.test(state.focus), `focus after Clear: ${state.focus}`);
    assertThat(state.said.some((line) => /qa-sample\.pdf removed\./.test(line)), `not announced: ${state.said.join(' | ')}`);
    return state.focus;
  });
}

// Item 5. Ctrl/Cmd+Enter runs the main action from anywhere; a disabled main action stays
// focusable, says why, and Ctrl+Enter leaves it alone.
await check('ctrl-enter-runs', laptop, async (page) => {
  await loadFixture(page, '/flatten', [fixtureFiles.fillable], { origin });
  await page.mouse.click(700, 140);
  await page.keyboard.press('Control+Enter');
  await page.locator('.chef-result-face').first().waitFor({ timeout: 20_000 });
  return 'result';
});
for (const [route, name] of [['/delete-pages', 'Save without those pages'], ['/protect', /Protect/]]) {
  await check(`main-disabled-reachable${route.replace('/', '-')}`, laptop, async (page) => {
    await loadFixture(page, route, [qaPdf], { origin });
    await settle(page, 600);
    const main = page.locator('.tk-primary').filter({ visible: true }).filter({ hasText: name }).first();
    const state = await main.evaluate((button) => ({
      disabledAttr: button.hasAttribute('disabled'),
      aria: button.getAttribute('aria-disabled'),
      why: (button.getAttribute('aria-describedby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean),
    }));
    assertThat(!state.disabledAttr && state.aria === 'true', `not focusable while off: ${JSON.stringify(state)}`);
    assertThat(state.why.length > 0, 'no reason is given');
    await main.focus();
    assertThat(await main.evaluate((button) => button === document.activeElement), 'cannot take focus');
    await page.keyboard.press('Control+Enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    assertThat(!(await page.locator('.chef-result-face').first().isVisible().catch(() => false)), 'the off action ran');
    return state.why.join(' / ').slice(0, 120);
  });
}

// Item 6. Extract Images says that one picture is used on four pages.
await check('extract-images-shared', laptop, async (page) => {
  await loadFixture(page, '/extract-images', [await photoPdf()], { origin });
  const note = page.getByText(/The same picture is used on pages\s*⁦?1–4⁩?, so it is saved once\./).first();
  await note.waitFor({ timeout: 20_000 });
  await shot(page, 'extract-images-shared-1440');
  return text(note);
});

// Item 7. The heavy-job warning: the app's own sheet; Cancel keeps the file, Continue runs.
for (const route of ['/rotate', '/compress', '/split']) {
  const size = { ...laptop, settings: { confirmLargeJobs: true, largeFileWarningMb: 0.001 } };
  await check(`heavy-job${route.replace('/', '-')}`, size, async (page) => {
    await loadFixture(page, route, [qaPdf], { origin });
    await settle(page, 600);
    if (route === '/rotate') await page.locator('[data-turn="right"]').first().click();
    const main = page.locator('.tk-primary').filter({ visible: true }).first();
    await main.click();
    const sheet = page.getByRole('dialog').filter({ hasText: /large/ });
    await sheet.waitFor({ timeout: 5000 });
    await shot(page, `heavy-job${route.replace('/', '-')}-1440`);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(400);
    assertThat(await page.getByText('qa-sample.pdf').first().isVisible(), 'Cancel dropped the file');
    assertThat(!(await page.locator('.chef-result-face').first().isVisible().catch(() => false)), 'Cancel ran the job');
    await main.click();
    await sheet.waitFor();
    await sheet.getByRole('button', { name: 'Continue' }).click();
    // Ran: a result, or Compress's "Already as small as it gets" for this small file.
    const ran = page.locator('.chef-result-face').or(page.locator('.tk-notice').filter({ hasText: /Already as small/ })).first();
    await ran.waitFor({ timeout: 30_000 }).catch(() => {});
    assertThat(await ran.isVisible(), 'Continue did not run the job');
    return 'Cancel kept the file; Continue ran';
  });
}

// Item 8. 400% zoom (a 1280×800 window): the tab bar takes no more than a quarter of the screen,
// and at a phone's normal size it is unchanged.
await check('zoom-400-tab-bar', laptop, async () => {
  const out = [];
  for (const [viewport, scale, limit] of [[{ width: 320, height: 200 }, 4, [0, 0.25]], [{ width: 390, height: 844 }, 3, [0.08, 0.09]]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
    await context.addInitScript(() => {
      localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true, keepLocalHistory: false, autoDownload: false, confirmLargeJobs: false }));
      sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
    });
    const page = await context.newPage();
    for (const route of ['/', '/recent', '/settings']) {
      await page.goto(`${origin}${route}`);
      await settle(page, 500);
      const share = await page.evaluate(() => +((innerHeight - document.querySelector('.chef-tab-bar').getBoundingClientRect().top) / innerHeight).toFixed(2));
      assertThat(share >= limit[0] && share <= limit[1], `${viewport.width}×${viewport.height} ${route}: the tab bar takes ${share}`);
      out.push(`${viewport.width}:${route}=${share}`);
    }
    await context.close();
  }
  return out.join(' ');
});

// Item 9. Sign: Reset lands on the fitted view at every size, also after the window changes size.
for (const [size, next] of [[phone, { width: 844, height: 390 }], [{ key: '834', width: 834, height: 1194, phone: true }, { width: 768, height: 1024 }], [laptop, { width: 768, height: 1024 }]]) {
  await check('sign-reset-fit', size, async (page) => {
    await loadFixture(page, '/sign', [qaPdf], { origin });
    await page.waitForTimeout(1200);
    const view = () => page.evaluate(() => {
      const viewport = [...document.querySelectorAll('[data-testid="pdf-zoom-viewport"]')].find((node) => node.getClientRects().length);
      const sheet = viewport.querySelector('[style*="height"]');
      const style = getComputedStyle(viewport);
      return { zoom: viewport.dataset.pdfZoom, fits: sheet.getBoundingClientRect().width <= viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 2 };
    });
    const open = await view();
    assertThat(open.fits, `opens cut off at ${open.zoom}`);
    await page.getByRole('button', { name: 'Zoom in' }).first().click();
    // Sign's reset reads "Fit page" (owner decision 2026-11-15).
    await page.getByRole('button', { name: /Fit page/ }).first().click();
    await page.waitForTimeout(300);
    const reset = await view();
    assertThat(reset.zoom === open.zoom && reset.fits, `Reset went to ${reset.zoom}, opened at ${open.zoom}`);
    await page.setViewportSize(next);
    await page.waitForTimeout(800);
    const resized = await view();
    assertThat(resized.fits, `after ${next.width}×${next.height} the page is cut off at ${resized.zoom}`);
    return `${open.zoom} -> ${next.width}: ${resized.zoom}`;
  });
}

// Item 10. A rejected range is not also told to press Select (desktop-r9-04).
await check('range-rejected-status', laptop, async (page) => {
  await loadFixture(page, '/split', [qaPdf], { origin });
  await page.getByRole('textbox', { name: 'Page numbers or ranges' }).fill('1,99');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.waitForTimeout(300);
  const said = await page.evaluate(() => [...document.querySelectorAll('[role=status],[role=alert]')].map((node) => node.textContent.trim()).filter(Boolean));
  assertThat(said.some((line) => /outside this PDF/.test(line)), `no error: ${said.join(' | ')}`);
  assertThat(!said.some((line) => /Press Select/.test(line)), `stale advice: ${said.join(' | ')}`);
  return said.join(' | ');
});

// Item 10. Sign keeps a drawing while another tab is looked at (fable C5).
await check('sign-draw-kept', laptop, async (page) => {
  await loadFixture(page, '/sign', [qaPdf], { origin });
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /Add signature/ }).first().click();
  const pad = page.locator('canvas').filter({ visible: true }).last();
  await pad.waitFor();
  await page.waitForTimeout(300);
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 40);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) await page.mouse.move(box.x + 30 + i * 15, box.y + 40 + (i % 2) * 30);
  await page.mouse.up();
  const ink = () => page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas')].filter((node) => node.getClientRects().length).pop();
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
    return count;
  });
  const drawn = await ink();
  await page.getByRole('radio', { name: 'Type' }).or(page.getByRole('button', { name: 'Type', exact: true })).first().click();
  await page.getByRole('radio', { name: 'Draw' }).or(page.getByRole('button', { name: 'Draw', exact: true })).first().click();
  await page.waitForTimeout(600);
  const kept = await ink();
  assertThat(drawn > 0 && kept === drawn, `drawn ${drawn}, after Type and back ${kept}`);
  return `${kept} inked pixels kept`;
});

// ------------------------------------------------------------------ Fix review (review-fixes.md)

const heavySettings = { confirmLargeJobs: true, largeFileWarningMb: 0.001 };
const heavySheet = (page) => page.getByRole('dialog').filter({ hasText: /large/ });
const notEarlier = async (page, why) => {
  const strip = page.locator('.chef-result-face').first();
  const now = await text(strip);
  assertThat(!/Earlier result/.test(now), `${why}: the strip reads ${now}`);
  return now;
};
const isEarlier = async (page, why) => {
  const strip = page.locator('.chef-result-face').first();
  const visible = await strip.isVisible().catch(() => false);
  const now = visible ? await text(strip) : '(no strip)';
  assertThat(!visible || /Earlier result/.test(now), `${why}: the strip still reads as current: ${now}`);
  return now;
};

// Finding 1. Every way to start the job asks first: Enter in Unlock's and Protect's password
// fields, and Split's "Extract N pages" chip.
await check('heavy-gate-unlock', { ...laptop, settings: heavySettings }, async (page) => {
  await ensureFixtures(chromium);
  await loadFixture(page, '/unlock', [fixtureFiles.locked], { origin });
  const field = page.locator('#unlock-password');
  await field.fill('pdfchef-qa');
  await field.press('Enter');
  await heavySheet(page).waitFor({ timeout: 3000 }).catch(() => {});
  assertThat(await heavySheet(page).isVisible(), 'Enter in the password field ran Unlock without the heavy-job question');
  await heavySheet(page).getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(500);
  assertThat(!(await page.locator('.chef-result-face').first().isVisible().catch(() => false)), 'Cancel ran the job');
  return 'Enter asked; Cancel kept the file';
});
await check('heavy-gate-protect', { ...laptop, settings: heavySettings }, async (page) => {
  await loadFixture(page, '/protect', [qaPdf], { origin });
  await page.locator('#protect-password').fill('abcd1234');
  const confirm = page.locator('#protect-password-confirmation');
  await confirm.fill('abcd1234');
  await confirm.press('Enter');
  await heavySheet(page).waitFor({ timeout: 3000 }).catch(() => {});
  assertThat(await heavySheet(page).isVisible(), 'Enter in the confirmation field ran Protect without the heavy-job question');
  return 'Enter asked';
});
await check('heavy-gate-split-extract', { ...laptop, settings: heavySettings }, async (page) => {
  await loadFixture(page, '/split', [qaPdf], { origin });
  await page.getByRole('textbox', { name: 'Page numbers or ranges' }).fill('1');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^Extract 1 page as one PDF/ }).click();
  await heavySheet(page).waitFor({ timeout: 3000 }).catch(() => {});
  assertThat(await heavySheet(page).isVisible(), 'the Extract chip ran without the heavy-job question');
  return 'the chip asked';
});

// Finding 2. Compress: a quality slider moved in its card (phone) marks the result earlier.
await check('earlier-compress-slider', phone, async (page) => {
  await loadFixture(page, '/compress', [await rawImagePdf()], { origin });
  await settle(page, 600);
  assertThat(await makeResult(page, { id: 'compress' }), 'no result');
  await notEarlier(page, 'fresh result');
  const slider = page.getByRole('slider', { name: 'Compression quality' });
  await reveal(page, slider, phone);
  await slider.focus();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  return isEarlier(page, 'after the quality moved by 3');
});

// Finding 3. Create PDF: moving a photo marks the result earlier.
await check('earlier-make-pdf-reorder', laptop, async (page) => {
  // The picker takes one photo at a time here. Three photos, and page 3 moves: the first page (and
  // so the default name in the sentence) stays the same.
  await loadFixture(page, '/make-pdf', [photo('tall.jpg')], { origin });
  await loadFiles(page, [photo('wide.jpg')]);
  await loadFiles(page, [photo('tall.jpg')]);
  await settle(page, 800);
  await page.getByRole('button', { name: /^Move page 3 up/ }).first().waitFor({ state: 'attached' });
  assertThat(await makeResult(page, { id: 'make-pdf' }), 'no result');
  await notEarlier(page, 'fresh result');
  // The tile's move buttons show on hover: pressed here by keyboard.
  await page.getByRole('button', { name: /^Move page 3 up/ }).first().focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  return isEarlier(page, 'after page 3 moved up');
});

// Finding 4. Crossing 768 px (a phone turned to landscape, a window narrowed) changes nothing.
for (const [route, files] of [['/split', () => [qaPdf]], ['/compress', async () => [await rawImagePdf()]], ['/delete-pages', () => [qaPdf]]]) {
  await check(`earlier-layout${route.replace('/', '-')}`, phone, async (page) => {
    await loadFixture(page, route, await files(), { origin });
    await settle(page, 600);
    assertThat(await makeResult(page, { id: route.slice(1) }), 'no result');
    await notEarlier(page, 'fresh result');
    // A touch on the page sets "touched", as a scroll by touch does.
    await page.locator('.tk-canvas').first().dispatchEvent('pointerdown');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(900);
    const wide = await notEarlier(page, 'turned to landscape (844 px)');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(900);
    await notEarlier(page, 'turned back to portrait');
    return wide;
  });
}

// Finding 5. Compare: new files make the old report an earlier result.
await check('earlier-compare-files', laptop, async (page) => {
  await ensureFixtures(chromium);
  await loadFixture(page, '/compare', [qaPdf, fixtureFiles.fillable], { origin, perInput: true });
  await settle(page, 800);
  assertThat(await makeResult(page, { id: 'compare' }), 'no result');
  await notEarlier(page, 'fresh result');
  await page.getByRole('button', { name: 'Choose different PDFs' }).click();
  await settle(page, 500);
  await loadFiles(page, [await blankPdf(), await photoPdf()], { perInput: true });
  await settle(page, 1200);
  return isEarlier(page, 'after two other PDFs were chosen');
});

// Finding 6. A held Ctrl+Enter (a repeating key) runs nothing.
await check('ctrl-enter-repeat', laptop, async (page) => {
  await ensureFixtures(chromium);
  await loadFixture(page, '/flatten', [fixtureFiles.fillable], { origin });
  await page.mouse.click(700, 140);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(2500);
  assertThat(!(await page.locator('.chef-result-face').first().isVisible().catch(() => false)), 'a repeated Ctrl+Enter ran the job');
  await page.keyboard.press('Control+Enter');
  await page.locator('.chef-result-face').first().waitFor({ timeout: 20_000 });
  return 'repeat ignored; one press ran';
});

// Finding 7. Open PDF from an unsaved result asks before it leaves the tool's files.
await check('open-pdf-asks', laptop, async (page) => {
  await ensureFixtures(chromium);
  await loadFixture(page, '/merge', [qaPdf, fixtureFiles.fillable], { origin });
  await page.getByRole('button', { name: 'Save the combined PDF' }).click();
  const sheet = page.getByRole('dialog').filter({ has: page.locator('[data-result-sheet]') });
  await sheet.waitFor();
  await sheet.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const ask = page.getByRole('dialog').filter({ hasText: 'Leave this tool and discard your files?' });
  await ask.waitFor({ timeout: 3000 }).catch(() => {});
  assertThat(await ask.isVisible(), `Open PDF left with no question (now at ${new URL(page.url()).pathname})`);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(400);
  assertThat(new URL(page.url()).pathname === '/merge', 'Cancel left the tool');
  return 'asked; Cancel stayed on /merge';
});

// Finding 8. A short screen (landscape phone, 200% zoom): the result strip, the sentence and the
// main action are all in view in the foot sheet without scrolling it.
for (const short of [{ key: '667x375', width: 667, height: 375, phone: true }, { key: '640x360', width: 640, height: 360, phone: true }]) {
  await check('sheet-short', short, async (page) => {
    await loadFixture(page, '/split', [qaPdf], { origin });
    await settle(page, 600);
    assertThat(await makeResult(page, { id: 'split' }), 'no result');
    const out = await page.evaluate(() => {
      const sheet = document.querySelector('.tk-sheet');
      if (!sheet) return { error: 'no sheet' };
      const box = sheet.getBoundingClientRect();
      const inView = (selector) => {
        const node = sheet.querySelector(selector);
        if (!node) return `${selector}: missing`;
        const rect = node.getBoundingClientRect();
        return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 ? '' : `${selector}: ${Math.round(rect.top)}-${Math.round(rect.bottom)} outside ${Math.round(box.top)}-${Math.round(box.bottom)}`;
      };
      return { height: Math.round(box.height), page: Math.round(window.innerHeight), problems: ['.chef-result-face', '.tk-sentence-group', '.tk-actions'].map(inView).filter(Boolean) };
    });
    assertThat(!out.error, out.error);
    await shot(page, `sheet-short-${short.key}`);
    assertThat(out.problems.length === 0, `sheet ${out.height}px of ${out.page}px hides: ${out.problems.join('; ')}`);
    return `sheet ${out.height}px of ${out.page}px`;
  });
}

await browser.close();
const failed = results.filter((result) => !result.pass);
if (shots) await writeFile(resolve(shots, `${label}-results.json`), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
