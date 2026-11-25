// Path to 9, part 1 (owner decisions of 2026-11-14), checked in the browser:
//   1. phone setting editors get out of the way (one pick closes, Enter closes, Done, no cover,
//      no keyboard on open, tap choices next to a slider)
//   2. one or two settings are on the screen under the sentence on a phone
//   3. the result strip's own Download, and "Download automatically" still saves with no click
//   4. the wide layout from 768 px
//   5. each tool's last settings come back, never a password
//   6. focus never drops to the page; Cancel says "Canceled."
//   7. the Tools link asks before leaving a file; theme and text size follow other tabs
//
// Run against a preview of a fresh build:
//   PDF_CHEF_URL=http://127.0.0.1:4173 node scripts/verify-path-to-9-part1.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { ensureFixtures, fixtureFiles, loadFixture, newContext, qaPdf, settle } from './lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const phone = { width: 390, height: 844, phone: true };
const desktop = { width: 1440, height: 900, phone: false };
const SETTINGS_STORE = 'pdfchef.tool-settings.v1';

await ensureFixtures(chromium);
const browser = await chromium.launch({ headless: true });
let failures = 0;

const check = async (name, size, settings, run) => {
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
const openSlot = async (page, name) => {
  const button = opener(page, name);
  await button.click();
  await assertOpen(button, true);
  return button;
};
const assertOpen = async (button, open) => {
  await button.page().waitForFunction(([el, want]) => (el.getAttribute('aria-expanded') === 'true') === want, [await button.elementHandle(), open], { timeout: 3000 });
};
const editorOf = async (page, button) => page.locator(`[id="${await button.getAttribute('aria-controls')}"]`);
const overlap = (a, b) => Boolean(a && b) && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const voice = (page) => page.locator('.tk-screen > [role="status"]');

// ------------------------------------------------------------------ 1. editors

await check('1 a choice editor closes after one pick (PDF to Image, Format)', phone, {}, async (page) => {
  await loadFixture(page, '/pdf-to-jpg', [qaPdf], { origin });
  const button = await openSlot(page, 'Format');
  const editor = await editorOf(page, button);
  await editor.getByRole('button', { name: 'PNG', exact: true }).click();
  await assertOpen(button, false);
  assert.match(await button.textContent(), /PNG/);
});

await check('1 Enter closes a typing editor, which shows Done (Header & Footer, Header text)', phone, {}, async (page) => {
  await loadFixture(page, '/header-footer', [qaPdf], { origin });
  const button = await openSlot(page, 'Header text');
  const editor = await editorOf(page, button);
  assert.equal(await editor.getByRole('button', { name: 'Done', exact: true }).isVisible(), true, 'Done is shown');
  const field = editor.getByRole('textbox').first();
  await field.click();
  await field.fill('Quarterly report');
  await field.press('Enter');
  await assertOpen(button, false);
  assert.match(await button.textContent(), /Quarterly report/);
  // Done closes as well.
  await openSlot(page, 'Footer text');
  const footer = await editorOf(page, opener(page, 'Footer text'));
  await footer.getByRole('button', { name: 'Done', exact: true }).click();
  await assertOpen(opener(page, 'Footer text'), false);
});

await check('1 a slider editor has tap choices, no Done and no keyboard on open (Watermark)', phone, {}, async (page) => {
  await loadFixture(page, '/watermark', [qaPdf], { origin });
  for (const [slot, choice, shown] of [['Opacity', /^75\s?%$/, /75\s?%/], ['Size', /^72\s?pt$/, /72/], ['Rotation', /^45°$/, /45°/]]) {
    const button = await openSlot(page, slot);
    const editor = await editorOf(page, button);
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      return el instanceof HTMLInputElement && !['range', 'radio', 'checkbox'].includes(el.type) ? el.type : '';
    });
    assert.equal(active, '', `${slot}: no typing field has focus on open`);
    assert.equal(await editor.getByRole('button', { name: 'Done', exact: true }).count(), 0, `${slot}: no Done beside a slider`);
    const taps = editor.getByRole('group').filter({ has: page.locator('[data-tk-preset]') });
    assert.equal(await taps.count(), 1, `${slot}: one group of tap choices`);
    await taps.locator('[data-tk-preset]').filter({ hasText: choice }).first().click();
    await assertOpen(button, false);
    assert.match(await button.textContent(), shown, `${slot} took the tap choice`);
  }
});

for (const route of ['/pdf-to-jpg', '/page-numbers', '/header-footer', '/watermark']) {
  await check(`1 an open editor covers neither the next slot nor the main action (${route})`, phone, {}, async (page) => {
    await loadFixture(page, route, [qaPdf], { origin });
    const openers = page.locator('[aria-haspopup="dialog"][aria-controls]:visible');
    const count = await openers.count();
    const action = page.locator('.tk-actions .tk-primary:visible').first();
    for (let index = 0; index < count; index += 1) {
      const button = openers.nth(index);
      await button.click();
      await assertOpen(button, true);
      const box = await (await editorOf(page, button)).boundingBox();
      const next = index + 1 < count ? await openers.nth(index + 1).boundingBox() : null;
      assert.equal(overlap(box, next), false, `editor ${index + 1} covers the next slot`);
      if (await action.count()) assert.equal(overlap(box, await action.boundingBox()), false, `editor ${index + 1} covers the main action`);
      await page.keyboard.press('Escape');
      await assertOpen(button, false);
    }
  });
}

// ------------------------------------------------------------------ 2. inline settings

await check('2 Split shows its two settings under the sentence on a phone', phone, {}, async (page) => {
  await loadFixture(page, '/split', [qaPdf], { origin });
  assert.equal(await page.getByRole('radio', { name: 'Max file size' }).isVisible(), true);
  assert.equal(await page.getByRole('textbox', { name: /Pages per output PDF/ }).or(page.getByRole('spinbutton', { name: /Pages per output PDF/ })).first().isVisible(), true);
  // The slot still opens nothing new: it points at the field on screen.
  await page.getByRole('button', { name: /^Pages per file,/ }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
});

// ------------------------------------------------------------------ 3. result strip

const mergeFiles = [qaPdf, fixtureFiles.fillable];
await check('3 the result strip has its own Download; the sheet keeps all its buttons', phone, {}, async (page) => {
  await loadFixture(page, '/merge', mergeFiles, { origin });
  await page.getByRole('button', { name: /^Save the combined PDF$/ }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Download', exact: true }).waitFor({ timeout: 60_000 });
  for (const name of ['Download', 'Rename', 'Use in another tool', 'Keep in Recent']) {
    assert.equal(await sheet.getByRole('button', { name, exact: true }).count(), 1, `sheet keeps ${name}`);
  }
  await page.keyboard.press('Escape');
  const stripDownload = page.locator('.tk-result').getByRole('button', { name: /^Download .+\.pdf$/ });
  await stripDownload.waitFor({ timeout: 5000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), stripDownload.click()]);
  assert.match(download.suggestedFilename(), /\.pdf$/);
});

await check('3 "Download automatically" still saves with no click (no save picker)', phone, { autoDownload: true }, async (page, context) => {
  await context.addInitScript(() => { try { delete window.showSaveFilePicker; } catch { /* not there */ } window.showSaveFilePicker = undefined; });
  await loadFixture(page, '/merge', mergeFiles, { origin });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: /^Save the combined PDF$/ }).click(),
  ]);
  assert.match(download.suggestedFilename(), /\.pdf$/);
});

// ------------------------------------------------------------------ 4. 768

for (const width of [767, 768, 820, 1024, 1180]) {
  await check(`4 ${width} px ${width >= 768 ? 'uses' : 'keeps the phone'} layout`, { width, height: width < 1000 ? 1024 : 820, phone: width < 1000 }, {}, async (page) => {
    await loadFixture(page, '/split', [qaPdf], { origin });
    assert.equal(await page.locator('main.tk-tool[data-wide]').count(), width >= 768 ? 1 : 0);
    assert.equal(await page.locator('.tk-sheet').count(), width >= 768 ? 0 : 1);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(scroll <= 1, `no sideways scroll (${scroll}px)`);
  });
}

// ------------------------------------------------------------------ 5. remembered settings

await check('5 a tool\'s last settings come back on the next visit; a password never is kept', phone, {}, async (page) => {
  await loadFixture(page, '/watermark', [qaPdf], { origin });
  const button = await openSlot(page, 'Opacity');
  await (await editorOf(page, button)).locator('[data-tk-preset]').filter({ hasText: /^75%$/ }).click();
  await assertOpen(button, false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await loadFixture(page, '/watermark', [qaPdf], { origin });
  assert.match(await opener(page, 'Opacity').textContent(), /75\s?%/, 'opacity came back');
  await loadFixture(page, '/protect', [qaPdf], { origin });
  const fields = page.locator('input[type=password]');
  await fields.first().fill('pdfchef-secret-1');
  if (await fields.count() > 1) await fields.nth(1).fill('pdfchef-secret-1');
  await page.waitForTimeout(300);
  const store = await page.evaluate((key) => localStorage.getItem(key) ?? '', SETTINGS_STORE);
  assert.ok(store.includes('"/watermark"'), store);
  assert.ok(!store.includes('pdfchef-secret-1'), 'no password in the store');
  assert.ok(!/"\/protect"/.test(store), 'Protect keeps nothing');
});

// ------------------------------------------------------------------ 6. focus and Cancel

await check('6 focus moves to a neighbour when Remove takes its row away (Merge), and it is said', desktop, {}, async (page) => {
  await loadFixture(page, '/merge', [qaPdf, fixtureFiles.fillable], { origin });
  const remove = page.getByRole('button', { name: /^Remove / }).first();
  await remove.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName ?? '', inTool: Boolean(el?.closest('.tk-screen')), body: el === document.body };
  });
  assert.equal(focused.body, false, 'focus did not drop to the page');
  assert.equal(focused.inTool, true, `focus stayed in the tool (${focused.tag})`);
  assert.match(await voice(page).textContent(), /^qa-sample\.pdf removed\./);
});

await check('6 Cancel says "Canceled." (Batch)', desktop, {}, async (page) => {
  const source = await PDFDocument.create();
  for (let index = 0; index < 3; index += 1) source.addPage([300, 300]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  await page.route(/pdf\.worker/i, async (route) => {
    if (new URL(route.request().url()).searchParams.has('url')) return route.continue();
    started();
    await gate;
    return route.continue();
  });
  try {
    await page.goto(new URL('/batch', origin).toString(), { waitUntil: 'domcontentloaded' });
    await page.locator('input[type=file]').setInputFiles([
      { name: 'one.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()) },
      { name: 'two.pdf', mimeType: 'application/pdf', buffer: await readFile(qaPdf) },
    ]);
    await page.getByRole('button', { name: /^Process .*file/ }).click();
    await running;
    await page.getByRole('button', { name: /^Cancel/ }).first().click();
    release();
    await page.locator('.tk-progress-block').waitFor({ state: 'detached', timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('.tk-screen > [role="status"]')?.textContent?.includes('Canceled.'), null, { timeout: 5000 });
  } finally {
    release();
  }
});

// ------------------------------------------------------------------ 7. leave, tabs

await check('7 the Tools link asks before leaving a loaded file, and not before one is loaded', phone, {}, async (page) => {
  await page.goto(new URL('/compress', origin).toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor();
  await page.locator('a[data-tk-tools]').click();
  await page.waitForURL((url) => url.pathname === '/');
  await loadFixture(page, '/compress', [qaPdf], { origin });
  await page.locator('a[data-tk-tools]').click();
  const ask = page.getByRole('dialog', { name: 'Leave this tool and discard your files?' });
  await ask.waitFor({ timeout: 3000 });
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await ask.waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).pathname, '/compress');
  assert.equal(await page.getByRole('button', { name: /^Compress$/ }).isVisible(), true, 'the file is still loaded');
  // The phone's tool name is a link to Tools as well, and asks the same.
  await page.locator('a[data-tk-home]').click();
  await ask.waitFor({ timeout: 3000 });
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await ask.waitFor({ state: 'hidden' });
  await page.locator('a[data-tk-tools]').click();
  await ask.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/');
});

await check('7 theme and text size follow another open tab', desktop, {}, async (page, context) => {
  await page.goto(new URL('/', origin).toString(), { waitUntil: 'domcontentloaded' });
  const other = await context.newPage();
  await other.goto(new URL('/settings', origin).toString(), { waitUntil: 'domcontentloaded' });
  await settle(page, 300);
  await other.evaluate(() => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('pdfchef.appearance.text-scale.v1', 'larger');
  });
  await page.waitForFunction(() => document.documentElement.classList.contains('dark') && document.documentElement.dataset.textScale === 'larger', null, { timeout: 3000 });
  await other.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), null, { timeout: 3000 });
});

await browser.close();
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('All path-to-9 part 1 checks passed.');
}
