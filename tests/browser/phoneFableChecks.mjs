// Fable's phone layout and Sign's "Fit page" (owner decisions of 2026-11-15,
// output/web/ui-redesign/audit/prompts/phone-fable-build.md). One check per contract, on the two
// phone sizes (390×844, 360×800) unless a size is named. Each check passes on the new build and
// fails on f2 (output/web/build/f2-dist), except where the detail says it held already.
//
//   PDF_CHEF_URL=http://127.0.0.1:4173 node tests/browser/phoneFableChecks.mjs [--only=a,b] [--shots=dir] [--label=after]
//
// QA files only: qa-sample.pdf, tests/fixtures/ui and tests/fixtures/photos. Works on preview or dev.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { ensureFixtures, fixtureFiles, loadFixture, newContext, photo, qaPdf, root } from '../../scripts/lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const only = arg('only')?.split(',').filter(Boolean) ?? null;
const label = arg('label') ?? 'run';
const shots = arg('shots') ? resolve(root, arg('shots')) : null;
if (shots) await mkdir(shots, { recursive: true });

const phones = [
  { key: '390', width: 390, height: 844, phone: true },
  { key: '360', width: 360, height: 800, phone: true },
];
const tablet = { key: '768', width: 768, height: 1024, phone: false };
const laptop = { key: '1440', width: 1440, height: 900, phone: false };
await ensureFixtures(chromium);
const browser = await chromium.launch({ headless: true });
const results = [];

const check = async (id, sizes, run) => {
  if (only && !only.some((item) => id.startsWith(item))) return;
  for (const size of sizes) {
    const name = `${id} @${size.key}`;
    const context = await newContext(browser, size);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    try {
      const detail = await run(page, size);
      results.push({ id, size: size.key, pass: true, detail });
      console.log(`ok   ${name}${detail ? ` · ${detail}` : ''}`);
    } catch (error) {
      results.push({ id, size: size.key, pass: false, detail: error.message.split('\n')[0] });
      console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
      if (shots) await page.screenshot({ path: resolve(shots, `${label}-${id}-${size.key}-fail.png`) }).catch(() => {});
    } finally {
      await context.close();
    }
  }
};
const assertThat = (condition, message) => { if (!condition) throw new Error(message); };
const open = (page, route, files) => loadFixture(page, route, files, { origin });
const openCard = async (page, slot) => {
  await slot.click();
  const id = await slot.getAttribute('aria-controls');
  assertThat(id, 'the value opens no card');
  const card = page.locator(`[id="${id}"]`);
  await card.waitFor({ state: 'visible', timeout: 4000 });
  await page.waitForTimeout(350);
  return card;
};
const slots = (page) => page.locator('.tk-sentence-group [data-slot]').filter({ visible: true });
const primary = (page) => page.locator('.tk-primary').filter({ visible: true }).first();

/** The visible form controls in the foot sheet or the top band that are not part of the sentence. */
const loose = (page) => page.evaluate(() => {
  const shown = (el) => el.getClientRects().length > 0 && !el.closest('[hidden]');
  return [...document.querySelectorAll('.tk-sheet, .tk-band-top')].flatMap((area) => [...area.querySelectorAll(
    'input:not([type="checkbox"]), select, textarea, [role="slider"], [role="radio"], [role="radiogroup"], .tk-step',
  )].filter((el) => shown(el) && !el.closest('.tk-sentence-group, .tk-result, .tk-actions'))
    .map((el) => el.getAttribute('aria-label') || el.closest('label')?.textContent?.trim() || el.getAttribute('placeholder') || el.tagName));
});
const sheetHeight = (page) => page.evaluate(() => {
  const sheet = [...document.querySelectorAll('.tk-sheet')].find((el) => el.getClientRects().length);
  return sheet ? Math.round(sheet.getBoundingClientRect().height) : 0;
});
const toResult = async (page) => {
  await primary(page).click();
  await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await page.locator('.tk-sheet .tk-result > *').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
};

// Each tool the owner named, with the setting that used to show twice: the value whose card now
// holds the control, and the control's accessible name inside the card.
const once = [
  { id: 'split', route: '/split', files: () => [qaPdf], slot: /^Pages to include, /, control: (c) => c.getByRole('textbox', { name: 'Page numbers or ranges' }) },
  { id: 'split-size', route: '/split', files: () => [qaPdf], slot: /^Pages per file, /, control: (c) => c.getByRole('button', { name: 'Increase Pages per output PDF' }) },
  { id: 'delete-pages', route: '/delete-pages', files: () => [qaPdf], slot: /^Mark a page range, /, control: (c) => c.getByRole('button', { name: 'Mark', exact: true }) },
  { id: 'extract', route: '/extract', files: () => [qaPdf], slot: /^Page numbers or ranges, /, control: (c) => c.getByRole('textbox', { name: 'Page numbers or ranges' }) },
  { id: 'make-pdf', route: '/make-pdf', files: () => [photo('tall.jpg')], slot: /^File name, /, control: (c) => c.getByRole('textbox', { name: 'File name' }) },
  { id: 'batch', route: '/batch', files: () => [qaPdf, fixtureFiles.fillable], slot: /^Operation, /, control: (c) => c.getByRole('combobox', { name: 'Operation' }) },
  { id: 'compress', route: '/compress', files: () => [qaPdf], slot: /^Quality, /, control: (c) => c.getByRole('slider', { name: 'Compression quality' }) },
  { id: 'pdf-to-jpg', route: '/pdf-to-jpg', files: () => [qaPdf], slot: /^Format, /, control: (c) => c.getByRole('button', { name: 'PNG' }) },
];

for (const tool of once) {
  await check(`once-${tool.id}`, phones, async (page) => {
    if (tool.files().length) await open(page, tool.route, tool.files());
    else { await page.goto(origin + tool.route); await page.locator('h1').first().waitFor(); await page.waitForTimeout(600); }
    const extra = await loose(page);
    assertThat(extra.length === 0, `controls outside the sentence: ${extra.join(', ')}`);
    const card = await openCard(page, page.getByRole('button', { name: tool.slot }).first());
    assertThat(await tool.control(card).first().isVisible(), 'the control is not in the value\'s card');
    return 'shown once, control in its card';
  });
}

// Polish item 3: a two-choice value is a toggle in the sentence. Its words switch the choice with
// one tap and no card; today's radios keep their names and checked state.
for (const tool of [
  { id: 'powerpoint-to-pdf', route: '/powerpoint-to-pdf', files: () => [fixtureFiles.pptx], group: 'Page orientation', a: 'Keep', b: 'Rotate' },
  { id: 'ocr', route: '/ocr', files: () => [], group: 'How should we read this PDF?', a: 'Normal PDF', b: 'Scanned pages' },
]) {
  await check(`toggle-${tool.id}`, phones, async (page) => {
    if (tool.files().length) await open(page, tool.route, tool.files());
    else { await page.goto(origin + tool.route); await page.locator('h1').first().waitFor(); await page.waitForTimeout(600); }
    const group = page.getByRole('radiogroup', { name: tool.group });
    const words = page.locator('.tk-sentence-group .tk-word-toggle').filter({ visible: true }).first();
    const radio = (name) => group.getByRole('radio', { name });
    // The value was remembered from an earlier run in some contexts: start from the first choice.
    if (!(await radio(tool.a).isChecked())) await words.tap();
    assertThat(await radio(tool.a).isChecked(), `${tool.a} is not chosen`);
    await words.tap();
    assertThat(await radio(tool.b).isChecked(), `one tap did not choose ${tool.b}`);
    assertThat(await page.locator('[role="dialog"]').filter({ visible: true }).count() === 0, 'a card opened');
    await words.tap();
    assertThat(await radio(tool.a).isChecked(), `a second tap did not go back to ${tool.a}`);
    const extra = await loose(page);
    assertThat(extra.length === 0, `controls outside the sentence: ${extra.join(', ')}`);
    return 'one tap switches, no card';
  });
}

// Polish item 1: a card's head and close stay in view when its body scrolls.
await check('head-stays', phones, async (page) => {
  await open(page, '/page-numbers', [qaPdf]);
  const card = await openCard(page, page.getByRole('button', { name: /^Position, / }).first());
  const result = await card.evaluate((node) => {
    const body = node.querySelector('.tk-pop-body');
    body.scrollTop = body.scrollHeight;
    const close = node.querySelector('.tk-pop-close').getBoundingClientRect();
    const hit = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2);
    const last = [...body.querySelectorAll('[role="slider"]')].pop().getBoundingClientRect();
    const box = body.getBoundingClientRect();
    return { closeSeen: Boolean(hit?.closest('.tk-pop-close')), lastSeen: last.top >= box.top - 1 && last.bottom <= box.bottom + 1, scrolls: body.scrollHeight > body.clientHeight };
  });
  assertThat(result.closeSeen, 'the close control scrolled away');
  assertThat(result.lastSeen, 'the last slider cannot be scrolled into view');
  return `close in view after scrolling (body scrolls: ${result.scrolls})`;
});

// Polish item 4: Delete's Mark applies the range and closes its card, as Extract's Select does.
await check('mark-closes', phones, async (page) => {
  await open(page, '/delete-pages', [qaPdf]);
  const card = await openCard(page, page.getByRole('button', { name: /^Mark a page range, / }).first());
  const field = card.getByRole('textbox', { name: 'Mark a page range' });
  assertThat(await field.evaluate((el) => el === document.activeElement), 'the range field is not focused when the card opens');
  await field.fill('2');
  await card.getByRole('button', { name: 'Mark', exact: true }).tap();
  await card.waitFor({ state: 'hidden', timeout: 3000 });
  assertThat(await page.getByRole('button', { name: /^Mark a page range, page 2/ }).count() > 0, 'page 2 is not marked');
  return 'range field focused at once; Mark marks and closes';
});

// Item 2: the foot sheet is at most 40% of the screen, before and after a result.
for (const tool of [
  { id: 'split', route: '/split', files: () => [qaPdf], result: true },
  { id: 'delete-pages', route: '/delete-pages', files: () => [qaPdf] },
  { id: 'extract', route: '/extract', files: () => [qaPdf] },
  { id: 'make-pdf', route: '/make-pdf', files: () => [photo('tall.jpg'), photo('wide.jpg')], result: true },
  { id: 'powerpoint-to-pdf', route: '/powerpoint-to-pdf', files: () => [fixtureFiles.pptx] },
  { id: 'batch', route: '/batch', files: () => [qaPdf, fixtureFiles.fillable] },
  { id: 'compress', route: '/compress', files: () => [qaPdf] },
  { id: 'merge', route: '/merge', files: () => [qaPdf, fixtureFiles.fillable], result: true },
]) {
  await check(`sheet-cap-${tool.id}`, phones, async (page, size) => {
    await open(page, tool.route, tool.files());
    const limit = Math.ceil(size.height * 0.4);
    const rest = await sheetHeight(page);
    assertThat(rest > 0 && rest <= limit, `sheet ${rest} px at rest, limit ${limit}`);
    if (!tool.result) return `${rest} px (limit ${limit})`;
    await toResult(page);
    const done = await sheetHeight(page);
    assertThat(done <= limit, `sheet ${done} px with the result, limit ${limit}`);
    return `${rest} px at rest, ${done} px with the result (limit ${limit})`;
  });
}

// Item 3: four or more values read as labelled rows on a phone; desktop keeps the sentence.
for (const tool of [
  { id: 'pdf-to-jpg', route: '/pdf-to-jpg' },
  { id: 'watermark', route: '/watermark' },
]) {
  await check(`rows-${tool.id}`, [...phones, laptop], async (page, size) => {
    await open(page, tool.route, [qaPdf]);
    const form = await page.locator('.tk-sentence-group').first().getAttribute('data-form');
    assertThat(form === (size.phone ? 'rows' : 'sentence'), `form ${form}`);
    return form;
  });
}

// Item 4: with any card open on a live-preview tool, the preview keeps 40% of the screen.
for (const tool of [
  { id: 'watermark', route: '/watermark' },
  { id: 'page-numbers', route: '/page-numbers' },
  { id: 'header-footer', route: '/header-footer' },
  { id: 'crop', route: '/crop' },
  { id: 'pdf-to-jpg', route: '/pdf-to-jpg' },
]) {
  await check(`preview-${tool.id}`, phones, async (page, size) => {
    await open(page, tool.route, [qaPdf]);
    const openers = page.locator('.tk-band-top [aria-haspopup="dialog"], .tk-pframe [aria-haspopup="dialog"]').filter({ visible: true });
    const count = await openers.count();
    assertThat(count > 0, 'no values to open');
    // Polish item 2: a card that needs more room may take the preview down to 30%; one that fits
    // at 40% stays there (it is sized to its content).
    const limit = Math.floor(size.height * 0.3);
    const seen = [];
    for (let index = 0; index < count; index += 1) {
      const opener = openers.nth(index);
      const name = await opener.getAttribute('aria-label');
      const card = await openCard(page, opener);
      const room = await page.evaluate((id) => {
        const frame = document.querySelector('.tk-pframe').getBoundingClientRect();
        const pop = document.getElementById(id).getBoundingClientRect();
        return Math.round(pop.top - frame.top);
      }, await opener.getAttribute('aria-controls'));
      seen.push(room);
      assertThat(room >= limit, `"${name}": preview ${room} px, needs ${limit}`);
      assertThat(await card.isVisible(), 'card closed');
      await page.keyboard.press('Escape');
      await card.waitFor({ state: 'hidden', timeout: 3000 });
    }
    return `preview ${Math.min(...seen)}–${Math.max(...seen)} px with a card open (needs ${limit})`;
  });
}

// Item 5: every card has the same one close control, Escape closes it, and a tap outside closes
// it and reaches what it landed on.
await check('one-close', [phones[0]], async (page) => {
  const seen = [];
  for (const tool of [
    { route: '/split', files: [qaPdf] },
    { route: '/watermark', files: [qaPdf] },
    { route: '/header-footer', files: [qaPdf] },
    { route: '/make-pdf', files: [photo('tall.jpg')] },
  ]) {
    await open(page, tool.route, tool.files);
    const openers = page.locator('[aria-haspopup="dialog"][aria-controls]').filter({ visible: true });
    const count = await openers.count();
    for (let index = 0; index < count; index += 1) {
      const opener = openers.nth(index);
      const name = await opener.getAttribute('aria-label');
      let card = await openCard(page, opener);
      const buttons = await card.locator('.tk-pop-head button').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') || node.textContent.trim()));
      assertThat(buttons.length === 1 && buttons[0] === 'Close', `"${name}": head buttons ${JSON.stringify(buttons)}`);
      assertThat(await card.getByRole('button', { name: 'Done', exact: true }).count() === 0, `"${name}": has Done`);
      await page.keyboard.press('Escape');
      await card.waitFor({ state: 'hidden', timeout: 3000 });
      card = await openCard(page, opener);
      // A tap on the header's title area, outside the card.
      await page.mouse.click(Math.round(page.viewportSize().width / 2), 70);
      await card.waitFor({ state: 'hidden', timeout: 3000 });
      seen.push(name);
    }
  }
  return `${seen.length} cards: one Close, Escape and an outside tap close each`;
});
await check('outside-tap-reaches', [phones[0]], async (page) => {
  // With the range card open, a tap on the main action closes the card and runs the action.
  await open(page, '/split', [qaPdf]);
  const card = await openCard(page, page.getByRole('button', { name: /^Pages to include, / }));
  await primary(page).click();
  await card.waitFor({ state: 'hidden', timeout: 3000 });
  await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
  return 'card closed and the split ran';
});

// Sign: "Fit page" on every size, back to the fitted view; Edit PDF and Read PDF unchanged.
await check('sign-fit-page', [...phones, tablet, laptop], async (page) => {
  await open(page, '/sign', [qaPdf]);
  const fit = page.getByRole('button', { name: 'Fit page', exact: true });
  assertThat(await fit.count() === 1, `"Fit page" buttons: ${await fit.count()}`);
  assertThat(await page.getByRole('button', { name: 'Reset zoom to 100%' }).count() === 0, 'Sign still says "Reset zoom to 100%"');
  const readZoom = async () => Number((await page.locator('.tabular').filter({ hasText: /\d+\s?%/ }).first().textContent()).replace(/\D/g, ''));
  const start = await readZoom();
  assertThat(await fit.isDisabled(), 'Fit page is on while the page is fitted');
  await page.getByRole('button', { name: 'Zoom in' }).first().click();
  await page.waitForTimeout(300);
  assertThat(await readZoom() > start, 'zoom in did nothing');
  await fit.click();
  await page.waitForTimeout(300);
  const back = await readZoom();
  assertThat(back === start, `Fit page went to ${back}%, the fit is ${start}%`);
  return `fit ${start}%, back to ${back}%`;
});
await check('reset-zoom-elsewhere', [laptop], async (page) => {
  await open(page, '/edit', [qaPdf]);
  assertThat(await page.getByRole('button', { name: /Reset zoom to 100%/ }).count() > 0, 'Edit PDF lost "Reset zoom to 100%"');
  assertThat(await page.getByRole('button', { name: 'Fit page', exact: true }).count() === 0, 'Edit PDF says "Fit page"');
  return 'Edit PDF keeps "Reset zoom to 100%"';
});

await browser.close();
const failed = results.filter((result) => !result.pass);
if (shots) await writeFile(resolve(shots, `${label}-results.json`), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
