// Checks for the web bugs found by the Android and iOS app syncs (2026-11-15).
// Run on a built preview: PDF_CHEF_URL=http://127.0.0.1:4173 node tests/browser/syncFixChecks.mjs
import { chromium } from 'playwright';
import { newContext, loadFixture, openSlot, qaPdf, settle } from '../../scripts/lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL ?? 'http://127.0.0.1:4173';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

const browser = await chromium.launch();
const open = async (size, route, files = [qaPdf]) => {
  const context = await newContext(browser, size);
  const page = await context.newPage();
  await page.goto(origin);
  await loadFixture(page, route, files, { origin });
  return { context, page };
};
const wideLayout = (page) => page.locator('.tk-tool').first().evaluate((tool) => tool.hasAttribute('data-wide'));

try {
  // 1. A phone on its side keeps the phone layout; a tablet in landscape keeps the wide one.
  for (const [size, expected] of [[{ width: 784, height: 360, phone: true }, false], [{ width: 932, height: 430, phone: true }, false], [{ width: 1024, height: 768, phone: false }, true], [{ width: 768, height: 1024, phone: true }, true]]) {
    const { context, page } = await open(size, '/watermark');
    const wide = await wideLayout(page);
    // Tailwind's md: rules sit in media rules of their own: each must follow the same height rule.
    const tailwindMd = await page.evaluate(() => {
      const queries = new Set();
      for (const sheet of Array.from(document.styleSheets)) {
        let rules = [];
        try { rules = Array.from(sheet.cssRules); } catch { continue; }
        for (const rule of rules) {
          if (rule instanceof CSSMediaRule && Array.from(rule.cssRules).some((inner) => inner.selectorText?.startsWith('.md\\:'))) queries.add(rule.conditionText);
        }
      }
      const list = [...queries];
      const matches = list.map((query) => window.matchMedia(query).matches);
      return list.length && matches.every((value) => value === matches[0]) && list.every((query) => /min-height: 480px|height >= 480px/.test(query)) ? matches[0] : `mixed: ${list.join(' | ')}`;
    });
    check(`${size.width}x${size.height}: ${expected ? 'wide' : 'phone'} layout`, wide === expected && tailwindMd === expected, `data-wide=${wide}, md:=${tailwindMd}`);
    await context.close();
  }

  // 2. Watermark's text box is named by its label, not by its placeholder.
  {
    const { context, page } = await open({ width: 390, height: 844, phone: true }, '/watermark');
    await openSlot(page, /^Watermark text,/);
    const named = await page.getByRole('textbox', { name: 'Watermark text' }).count();
    check('Watermark text box is named "Watermark text"', named === 1, `found ${named}`);
    await context.close();
  }

  // 3. Page Numbers' font size: the focus ring goes round the whole field, not through "pt".
  {
    const { context, page } = await open({ width: 390, height: 844, phone: true }, '/page-numbers');
    await openSlot(page, /^Font size,/);
    const input = page.locator('.chef-slider-value input').first();
    await input.focus();
    const rings = await input.evaluate((field) => ({
      input: getComputedStyle(field).outlineStyle,
      label: getComputedStyle(field.closest('.chef-slider-value')).outlineStyle,
    }));
    check('Font size: one ring round the field', rings.input === 'none' && rings.label === 'solid', JSON.stringify(rings));
    await context.close();
  }

  // 4. Page Numbers' range card with the keyboard up (Android shrinks the window): From and To show.
  for (const scale of ['default', 'larger', 'zoom200']) {
    const context = await newContext(browser, { width: 360, height: 780, phone: true });
    // Android's 200% system text (WebView text zoom) has no browser setting: double the root size.
    if (scale === 'zoom200') await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '200%'; }));
    else if (scale !== 'default') await context.addInitScript((value) => localStorage.setItem('pdfchef.appearance.text-scale.v1', value), scale);
    const page = await context.newPage();
    await page.goto(origin);
    await loadFixture(page, '/page-numbers', [qaPdf], { origin });
    await openSlot(page, /^Pages to number,/);
    const card = page.locator('.tk-scrim[data-tk-editor] [role="dialog"]:visible, .tk-scrim[data-tk-editor] .tk-pop:visible').first();
    const field = card.locator('input:not([type=radio]):not([type=checkbox])').first();
    if (!(await field.count())) {
      const custom = card.getByRole('radio').last();
      if (await custom.count()) await custom.check().catch(() => custom.click());
    }
    await field.focus();
    // The window Android leaves above a keyboard (about 360 px of 780).
    await page.setViewportSize({ width: 360, height: 360 });
    await page.waitForTimeout(600);
    const seen = await card.evaluate((node) => {
      const fields = Array.from(node.querySelectorAll('input:not([type=radio]):not([type=checkbox])'));
      const scroller = Array.from(node.querySelectorAll('*')).find((el) => el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY));
      return {
        keyboard: document.documentElement.hasAttribute('data-chef-keyboard'),
        fields: fields.length,
        visible: fields.filter((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }).length,
        scrollWindow: scroller ? scroller.clientHeight : null,
        cardHeight: Math.round(node.getBoundingClientRect().height),
      };
    });
    check(`Page Numbers range card, keyboard up, text ${scale}: fields on screen`, seen.fields > 0 && seen.visible === seen.fields && (seen.scrollWindow === null || seen.scrollWindow >= 100), JSON.stringify(seen));
    await context.close();
  }

  // 5. Compress: the switch's words stay the same; a skipped run's note is not cut by the button.
  {
    const { context, page } = await open({ width: 402, height: 874, phone: true }, '/compress');
    const toggle = page.getByRole('switch', { name: 'Keep text selectable' }).first();
    const before = (await toggle.innerText()).trim();
    await toggle.click();
    const after = (await toggle.innerText()).trim();
    const checked = await toggle.getAttribute('aria-checked');
    check('Compress switch words stay the same when off', before === after && checked === 'false', `${before} / ${after}, aria-checked=${checked}`);
    await toggle.click();
    await page.getByRole('button', { name: /^Compress/ }).last().click();
    await page.getByText('Already as small as it gets').waitFor({ timeout: 30_000 });
    await settle(page, 600);
    const layout = await page.evaluate(() => {
      const notice = document.querySelector('.tk-sheet > .tk-notice');
      const action = document.querySelector('.tk-sheet > .tk-actions');
      const sheet = document.querySelector('.tk-sheet');
      return {
        noticeBottom: Math.round(notice?.getBoundingClientRect().bottom ?? -1),
        actionTop: Math.round(action?.getBoundingClientRect().top ?? -1),
        sheetScrolls: sheet ? sheet.scrollHeight > sheet.clientHeight + 1 : null,
      };
    });
    check('Compress note is not under the button', layout.noticeBottom > 0 && layout.noticeBottom <= layout.actionTop && layout.sheetScrolls === false, JSON.stringify(layout));
    await context.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((item) => !item.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
