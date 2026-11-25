// A slider and its number box set one value; whichever the person used last must win.
// Research round 5, mobile-01: on a phone a slot editor focused the number box on open, so a
// slider dragged by finger was undone by the box's old text when the editor closed or Save was
// tapped (Watermark opacity 81% saved as 0.3). Checks every slider slot on a phone (finger drag,
// then Close / Escape / a tap outside), the saved Watermark file, typing still applying, a drag
// after typing, the same on desktop with a mouse, and (mobile-02) that a slider slot on a touch
// screen opens without focusing its box. Header & Footer's font size takes a typed 12 (mobile-03).
// Works on preview or dev. QA file only (qa-sample.pdf).
//
//   PDF_CHEF_URL=http://127.0.0.1:4173 node tests/browser/sliderFieldCommit.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { loadFixture, newContext, qaPdf } from '../../scripts/lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const phone = { width: 390, height: 844, phone: true };
const desktop = { width: 1440, height: 900, phone: false };
const browser = await chromium.launch({ headless: true });
const failures = [];
const check = async (name, run) => {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
  }
};

const open = async (size, route) => {
  const context = await newContext(browser, size);
  const page = await context.newPage();
  await loadFixture(page, route, [qaPdf], { origin });
  return { context, page };
};

/** A finger drag across a slider, from one fraction of its width to another (CDP touch events). */
const touchDrag = async (page, slider, from, to) => {
  const box = await slider.boundingBox();
  const y = box.y + box.height / 2;
  const at = (fraction) => [{ x: box.x + box.width * fraction, y }];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
  for (let step = 1; step <= 8; step += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from + ((to - from) * step) / 8) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(150);
};

// A row (labelled rows on a phone, owner decision 2026-11-15) reads label then value: take the value.
const slotText = async (opener) => {
  const value = opener.locator('.tk-row-value');
  return ((await ((await value.count()) ? value.first() : opener).textContent()) || '').replace(/\s+/g, ' ').trim();
};
const editorOf = async (page, opener) => page.locator(`[id="${await opener.getAttribute('aria-controls')}"]`);
const openSlot = async (page, name) => {
  const opener = page.getByRole('button', { name }).first();
  await opener.tap();
  await page.waitForFunction((element) => element.getAttribute('aria-expanded') === 'true', await opener.elementHandle());
  await page.waitForTimeout(150);
  return opener;
};

// How many slots have a slider in their editor, by tool.
// Watermark: size, opacity with rotation (one slot since pass 6), position.
const sliderSlots = { '/watermark': 3, '/page-numbers': 2, '/pdf-to-jpg': 2 };

for (const [route, expected] of Object.entries(sliderSlots)) {
  for (const closeBy of ['Close', 'Escape', 'a tap outside']) {
    await check(`${route} phone: a finger drag survives ${closeBy} in every slider slot`, async () => {
      const { context, page } = await open(phone, route);
      try {
        // Fixed by aria-controls: an open card covers the bottom row's slot (Position), so a
        // ':visible' list shrinks while a card is open and its nth() would point elsewhere.
        const ids = await page.locator('[aria-haspopup="dialog"][aria-controls]:visible')
          .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-controls')));
        let seen = 0;
        for (const id of ids) {
          const opener = page.locator(`[aria-haspopup="dialog"][aria-controls="${id}"]`).first();
          const before = await slotText(opener);
          await opener.tap();
          await page.waitForTimeout(250);
          const editor = await editorOf(page, opener);
          const slider = editor.locator('[role=slider]').first();
          if (!(await slider.count())) {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(150);
            continue;
          }
          seen += 1;
          const focused = await page.evaluate(() => (document.activeElement?.matches('[data-tk-preset]') ? 'tap choice' : null)
            || document.activeElement?.getAttribute('role') || document.activeElement?.tagName);
          const start = await slider.getAttribute('aria-valuenow');
          await touchDrag(page, slider, 0.15, 0.7);
          if ((await slider.getAttribute('aria-valuenow')) === start) await touchDrag(page, slider, 0.7, 0.3);
          const during = await slider.getAttribute('aria-valuenow');
          const box = editor.locator('input[type=number]').first();
          assert.equal(Number(await box.inputValue()), Number(during), `${before}: the box follows the slider`);
          if (closeBy === 'Close') await editor.getByRole('button', { name: 'Close' }).first().tap();
          else if (closeBy === 'Escape') await page.keyboard.press('Escape');
          // An empty spot above the preview: the page itself would take a tap (Watermark places its
          // stamp there), and the header has no empty middle once Change sits in it (round 6).
          else {
            // Clear for 20 px around, or a finger tap is drawn to the nearest button (touch adjustment).
            const spot = await page.evaluate(() => {
              const inert = (x, y) => {
                const hit = document.elementFromPoint(x, y);
                return !!hit && !hit.closest('button, a, input, select, textarea, label, [role=slider], [role=button], [role=dialog], [aria-haspopup], img, canvas, .tk-pframe');
              };
              for (let y = 24; y < 300; y += 6) for (let x = 24; x < innerWidth - 24; x += 8) {
                if ([-20, 0, 20].every((dy) => [-20, 0, 20].every((dx) => inert(x + dx, y + dy)))) return { x, y };
              }
              return null;
            });
            // PDF to Image's band is all rows (two to a line), so nothing above its page is empty;
            // its page takes no tap, so the tap outside lands on the page.
            const target = spot ?? (route === '/pdf-to-jpg' ? await page.locator('.tk-pframe canvas, .tk-pframe img').first().evaluate((node) => {
              const box = node.getBoundingClientRect();
              return { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 60) };
            }) : null);
            assert.ok(target, 'an empty spot to tap');
            await page.touchscreen.tap(target.x, target.y);
          }
          await page.waitForTimeout(250);
          assert.notEqual(await slotText(opener), before, `${before}: kept after ${closeBy}`);
          await opener.tap();
          await page.waitForTimeout(250);
          assert.equal(await (await editorOf(page, opener)).locator('[role=slider]').first().getAttribute('aria-valuenow'), during, `${before}: slider after reopening`);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(150);
          // mobile-02: a slider slot opens with the slider (or a tap choice) focused, so no keyboard comes up.
          // A tap choice above the slider (Page Numbers' position words) raises no keyboard either.
          assert.ok(['slider', 'tap choice'].includes(focused), `${before}: focus on open (${focused})`);
        }
        assert.equal(seen, expected, 'slider slots found');
      } finally {
        await context.close();
      }
    });
  }
}

const fillOpacity = async (bytes) => {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const found = [];
  const walk = (value, depth = 0) => {
    if (depth > 6) return;
    if (value instanceof PDFDict) {
      for (const [key, item] of value.entries()) {
        if (key === PDFName.of('ca') && item instanceof PDFNumber) found.push(item.asNumber());
        else walk(item, depth + 1);
      }
    } else if (value instanceof PDFArray) value.asArray().forEach((item) => walk(item, depth + 1));
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) walk(object instanceof PDFDict ? object : object.dict);
  return found;
};

const saveWatermark = async (page, tap = true) => {
  const save = page.getByRole('button', { name: /Save stamped PDF/i }).first();
  if (tap) await save.tap(); else await save.click();
  const download = page.getByRole('dialog').getByRole('button', { name: /^Download$/ }).first();
  await download.waitFor({ timeout: 30_000 });
  const event = page.waitForEvent('download', { timeout: 30_000 });
  if (tap) await download.tap(); else await download.click();
  return readFile(await (await event).path());
};

await check('/watermark phone: opacity dragged, then Save tapped with the editor open, is saved', async () => {
  const { context, page } = await open(phone, '/watermark');
  try {
    const opener = await openSlot(page, /^Opacity · Rotation,/);
    const slider = (await editorOf(page, opener)).locator('[role=slider]').first();
    await touchDrag(page, slider, 0.3, 0.8);
    const during = Number(await slider.getAttribute('aria-valuenow'));
    assert.ok(during > 60, `dragged to ${during}`);
    const opacities = await fillOpacity(await saveWatermark(page));
    assert.ok(opacities.some((value) => Math.abs(value * 100 - during) < 1), `saved ${opacities} for ${during}%`);
  } finally {
    await context.close();
  }
});

await check('/watermark phone: a typed value still applies, and a drag after typing wins', async () => {
  const { context, page } = await open(phone, '/watermark');
  try {
    const opener = await openSlot(page, /^Opacity · Rotation,/);
    const editor = await editorOf(page, opener);
    const box = editor.locator('input[type=number]').first();
    await editor.locator('.chef-slider-value').first().tap();
    await box.fill('64');
    await box.press('Enter');
    await page.waitForTimeout(250);
    assert.match(await slotText(opener), /^64\s?%/, 'typed 64 then Enter');
    await openSlot(page, /^Opacity · Rotation,/);
    await editor.locator('.chef-slider-value').first().tap();
    await box.fill('20');
    const slider = editor.locator('[role=slider]').first();
    await touchDrag(page, slider, 0.2, 0.9);
    const during = await slider.getAttribute('aria-valuenow');
    await editor.getByRole('button', { name: 'Close' }).first().tap();
    await page.waitForTimeout(250);
    assert.match(await slotText(opener), new RegExp(`^${Math.round(Number(during))}\\s?%`), `drag after typing (${during})`);
  } finally {
    await context.close();
  }
});

await check('/watermark phone: the text slot still opens with its box focused', async () => {
  const { context, page } = await open(phone, '/watermark');
  try {
    await openSlot(page, /^Watermark text,/);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'INPUT');
  } finally {
    await context.close();
  }
});

await check('/watermark desktop: box clicked, then the slider dragged with a mouse, is kept', async () => {
  const { context, page } = await open(desktop, '/watermark');
  try {
    const box = page.getByRole('spinbutton', { name: /opacity/i }).first();
    const slider = page.getByRole('slider', { name: /opacity/i }).first();
    await page.locator('.chef-slider-value', { has: box }).click();
    assert.equal(await box.evaluate((element) => element === document.activeElement), true, 'box focused');
    const rect = await slider.boundingBox();
    await page.mouse.move(rect.x + rect.width * 0.3, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * 0.8, rect.y + rect.height / 2, { steps: 8 });
    await page.mouse.up();
    const during = Number(await slider.getAttribute('aria-valuenow'));
    await page.locator('h1').first().click();
    await page.waitForTimeout(200);
    assert.equal(Number(await slider.getAttribute('aria-valuenow')), during, 'slider after leaving the box');
    assert.equal(Number(await box.inputValue()), during, 'box after leaving it');
    const opacities = await fillOpacity(await saveWatermark(page, false));
    assert.ok(opacities.some((value) => Math.abs(value * 100 - during) < 1), `saved ${opacities} for ${during}%`);
  } finally {
    await context.close();
  }
});

await check('/header-footer phone: a typed font size of 12 stays 12 (mobile-03)', async () => {
  const { context, page } = await open(phone, '/header-footer');
  try {
    const opener = await openSlot(page, /^Font size,/);
    const box = (await editorOf(page, opener)).locator('input[type=number]').first();
    await box.focus();
    await box.press('ControlOrMeta+a');
    await box.pressSequentially('12');
    assert.equal(await box.inputValue(), '12', 'while typing');
    await box.press('Enter');
    await page.waitForTimeout(250);
    assert.match(await slotText(opener), /^12 pt/);
  } finally {
    await context.close();
  }
});

await check('/pdf-to-jpg phone: a tap on the dim layer over Tools only closes the editor (round 6)', async () => {
  const { context, page } = await open(phone, '/pdf-to-jpg');
  try {
    const tools = await page.getByRole('link', { name: 'Tools' }).or(page.getByRole('button', { name: 'Tools' })).first().boundingBox();
    const opener = await openSlot(page, /^Quality,/);
    await page.touchscreen.tap(tools.x + tools.width / 2, tools.y + tools.height / 2);
    await page.waitForTimeout(400);
    assert.equal(new URL(page.url()).pathname, '/pdf-to-jpg', 'still on the tool');
    assert.equal(await opener.getAttribute('aria-expanded'), 'false', 'editor closed');
  } finally {
    await context.close();
  }
});

await check('/watermark desktop: an arrow key moves a slider by 1, Page Up turns rotation by 15 (round 6, desktop-06)', async () => {
  const { context, page } = await open(desktop, '/watermark');
  try {
    for (const name of ['Watermark size', 'Watermark opacity', 'Watermark rotation', 'Watermark horizontal position', 'Watermark vertical position']) {
      const slider = page.getByRole('slider', { name, exact: true });
      const from = Number(await slider.getAttribute('aria-valuenow'));
      await slider.focus();
      await slider.press('ArrowRight');
      assert.equal(Number(await slider.getAttribute('aria-valuenow')), from + 1, name);
    }
    const rotation = page.getByRole('slider', { name: 'Watermark rotation', exact: true });
    const from = Number(await rotation.getAttribute('aria-valuenow'));
    await rotation.press('PageUp');
    assert.equal(Number(await rotation.getAttribute('aria-valuenow')), from + 15, 'Page Up');
  } finally {
    await context.close();
  }
});

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\nall slider and number-box checks passed');
