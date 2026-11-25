// Rotate's sentence (plan 2.10) always says what a tap does and what saving does.
// Checks: the sentence for all, one, a range, a list and no pages; the outcome line for
// right, left, upside down and mixed turns; Reset; the saved file's page rotations; and
// that the two words keep a 48 px hit area on a phone. Uses qa-sample.pdf only.
//
//   PDF_CHEF_URL=http://127.0.0.1:4173 node scripts/verify-rotate-sentence.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { newContext, qaPdf, sizes } from './lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const out = process.env.PDF_CHEF_ROTATE_OUTPUT || 'output/web/rotate-sentence';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];

const sentenceText = (page) => page.locator('.tk-sentence:not(.tk-measure)').innerText().then((text) => text.replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1').trim());
const noticeText = async (page) => {
  const notice = page.locator('.tk-notice-line');
  return (await notice.count()) ? (await notice.innerText()).replace(/[⁦-⁩]/g, '').trim() : null;
};
const thumb = (page, number) => page.getByRole('button', { name: new RegExp(`^Page ${number}(, selected)?$`) });
const setSelection = async (page, wanted) => {
  for (let number = 1; number <= 3; number += 1) {
    const pressed = (await thumb(page, number).getAttribute('aria-pressed')) === 'true';
    if (pressed !== wanted.includes(number)) await thumb(page, number).click();
  }
};
const right = (page) => page.locator('[data-turn="right"]');
const left = (page) => page.locator('[data-turn="left"]');

async function open(size, settings = {}) {
  const context = await newContext(browser, size, settings);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/rotate`);
  await page.locator('input[type=file]').first().setInputFiles(qaPdf);
  await thumb(page, 3).waitFor();
  await page.locator('.tk-sentence:not(.tk-measure)').waitFor();
  return { context, page, errors };
}

for (const key of ['390x844', '1440x900']) {
  const size = sizes.find((entry) => entry.key === key);
  const { context, page, errors } = await open(size);

  // All pages are selected when the file opens.
  assert.equal(await sentenceText(page), 'Turn all 3 pages left 90° or right 90°.');
  assert.equal(await noticeText(page), null, 'No outcome line before any turn');
  await page.screenshot({ path: `${out}/rotate-all-${key}.png` });

  await setSelection(page, [2]);
  assert.equal(await sentenceText(page), 'Turn page 2 left 90° or right 90°.');
  await page.screenshot({ path: `${out}/rotate-one-${key}.png` });

  await setSelection(page, [2, 3]);
  assert.equal(await sentenceText(page), 'Turn pages 2–3 left 90° or right 90°.');
  await setSelection(page, [1, 3]);
  assert.equal(await sentenceText(page), 'Turn pages 1 and 3 left 90° or right 90°.');
  await page.screenshot({ path: `${out}/rotate-some-${key}.png` });

  await setSelection(page, []);
  assert.equal(await sentenceText(page), 'Select pages to turn left 90° or right 90°.');
  assert.equal(await right(page).isDisabled(), true, 'Words are off with nothing selected');
  assert.equal(await left(page).isDisabled(), true);

  // Outcome lines follow every turn.
  await setSelection(page, [2]);
  await right(page).click();
  assert.equal(await noticeText(page), 'Saving turns page 2 right.');
  await right(page).click();
  assert.equal(await noticeText(page), 'Saving turns page 2 upside down.');
  await right(page).click();
  assert.equal(await noticeText(page), 'Saving turns page 2 left.');
  await right(page).click();
  assert.equal(await noticeText(page), null, 'Four right turns are no turn');
  // Back where it started: Save is off again, as on first load (review 2, item 16). The off main
  // action keeps its focus and says so with aria-disabled.
  assert.equal(await page.getByRole('button', { name: 'Save turned PDF', exact: true }).getAttribute('aria-disabled'), 'true', 'Save is off when nothing turned');
  await setSelection(page, [1, 2]);
  await left(page).click();
  assert.equal(await noticeText(page), 'Saving turns pages 1–2 left.');
  await setSelection(page, [3]);
  await right(page).click();
  assert.equal(await noticeText(page), 'Saving turns all 3 pages as shown.');

  // Reset undoes every turn and then goes away.
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  assert.equal(await noticeText(page), null);
  assert.equal(await page.getByRole('button', { name: 'Reset', exact: true }).count(), 0);

  if (size.phone) {
    // Each word answers taps over at least 48 x 48 px (its ::after reaches above the first line
    // and below the last one, as the sentence's slots do).
    await setSelection(page, [1, 2, 3]);
    for (const turn of ['left', 'right']) {
      const extent = await page.evaluate((turn) => {
        const word = document.querySelector(`[data-turn="${turn}"]`);
        const box = word.getBoundingClientRect();
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const hits = (x, y) => Boolean(document.elementFromPoint(x, y)?.closest(`[data-turn="${turn}"]`));
        const reach = (dx, dy) => { let step = 0; while (step < 80 && hits(cx + dx * (step + 1), cy + dy * (step + 1))) step += 1; return step; };
        return { height: reach(0, -1) + reach(0, 1) + 1, width: reach(-1, 0) + reach(1, 0) + 1 };
      }, turn);
      assert.ok(extent.height >= 48 && extent.width >= 48, `${turn} word hit area ${extent.width} x ${extent.height}`);
      results.push({ size: key, turn, hitArea: extent });
    }
  }

  // Save and check the file: page 2 right, page 3 left.
  await setSelection(page, [2]);
  await right(page).click();
  await setSelection(page, [3]);
  await left(page).click();
  assert.equal(await noticeText(page), 'Saving turns pages 2–3 as shown.');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save turned PDF', exact: true }).click();
  const download = page.getByRole('button', { name: 'Download', exact: true });
  await download.or(page.getByRole('dialog').filter({ hasText: 'exported' })).first().waitFor({ timeout: 60_000 });
  if (await download.count()) await download.first().click();
  const saved = await downloadPromise;
  const chunks = [];
  for await (const chunk of await saved.createReadStream()) chunks.push(chunk);
  const document = await PDFDocument.load(Buffer.concat(chunks));
  const angles = document.getPages().map((entry) => entry.getRotation().angle);
  assert.deepEqual(angles, [0, 90, 270], 'Saved rotations match the outcome line');

  assert.deepEqual(errors, [], `page errors at ${key}`);
  results.push({ size: key, angles });
  await context.close();
}

// Phone, dark: one page selected, one turned.
{
  const size = sizes.find((entry) => entry.key === '390x844');
  const { context, page } = await open(size, { appearance: 'dark' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await setSelection(page, [2]);
  await right(page).click();
  await page.screenshot({ path: `${out}/rotate-dark-390x844.png` });
  await context.close();
}

await browser.close();
console.log(JSON.stringify({ status: 'PASS', results }, null, 2));
