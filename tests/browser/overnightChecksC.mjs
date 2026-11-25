// Overnight 2026-11-24, fix Group C: behaviour checks for the shared card and sentence fixes that
// came from the Android emulator and the iOS simulator (output/web/overnight-2026-11-24/fixes/GROUP-C.md).
//
//   PDF_CHEF_URL=http://127.0.0.1:4481 node tests/browser/overnightChecksC.mjs [--only=c1,c2,c3,c3-all,c4]
//
// c1  A card that holds two settings (Watermark's "Opacity · Rotation") stays open after a tap
//     choice; a card with one setting still closes after one.
// c2  An open card stays open, with focus inside, when the phone turns sideways (Merge, Watermark,
//     and Split as the control).
// c3  No line of a tool sentence holds only punctuation (Page Numbers' "Page 1 of 3" left the
//     closing "." alone on line 3 at 402 px). `c3-all` sweeps every tool at four widths in en-US and de-DE.
// c4  Assessment only (no fix): Watermark's large preview at about 375%, one finger and two fingers.
//
// QA files only: qa-sample.pdf and the fixtures in tests/fixtures/ (made by scripts/lib/tool-ui.mjs).
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ensureFixtures, fixtureFiles, loadFiles, qaPdf, settle, tools } from '../../scripts/lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const only = (process.argv.find((arg) => arg.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);

const newContext = (browser, { width = 390, height = 844, locale = 'en-US' } = {}) => browser.newContext({
  viewport: { width, height }, deviceScaleFactor: width < 768 ? 2 : 1, isMobile: width < 768, hasTouch: width < 768, locale,
}).then(async (context) => {
  await context.addInitScript((language) => {
    if (!sessionStorage.getItem('overnight-c.init')) {
      localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
        onboardingComplete: true, keepLocalHistory: false, autoDownload: false, confirmLargeJobs: false,
      }));
      // Remembered tool settings from an earlier case must not change this one's starting point.
      localStorage.removeItem('pdfchef.tool-settings.v1');
      localStorage.setItem('pdfchef.locale.v1', language);
      sessionStorage.setItem('overnight-c.init', '1');
    }
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
  }, locale);
  return context;
});

const open = async (context, route, files) => {
  const page = await context.newPage();
  await page.goto(new URL(route, origin).toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor({ timeout: 60_000 });
  if (files.length) {
    await loadFiles(page, files);
    await settle(page, 800);
  }
  return page;
};

/** The slot whose accessible name starts with `label` (the setting's name), opened with a tap. */
const openCard = async (page, label) => {
  const name = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`);
  const opener = page.getByRole('button', { name }).and(page.locator('[aria-haspopup="dialog"][aria-controls]:visible')).first();
  await opener.waitFor({ timeout: 30_000 });
  const card = page.locator(`#${await opener.getAttribute('aria-controls')}`);
  await opener.tap();
  await page.waitForFunction((node) => node?.getAttribute('role') === 'dialog', await card.elementHandle(), { timeout: 10_000 });
  await card.waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  return { opener, card };
};

/** Whether the card is open and shown, and whether focus is inside it. */
const cardState = (card) => card.evaluate((node) => ({
  open: node.getAttribute('role') === 'dialog' && !node.closest('[hidden]') && node.getClientRects().length > 0,
  focusInside: node.contains(document.activeElement),
}));

const cases = [];
const check = (id, name, run) => cases.push({ id, name, run });

// ------------------------------------------------------------------ C1

const lookLabel = 'Opacity · Rotation';

check('c1', 'Watermark: an opacity tap choice keeps the "Opacity · Rotation" card open; a rotation choice is then one tap away', async (browser) => {
  const context = await newContext(browser);
  const page = await open(context, '/watermark', [qaPdf]);
  const { opener, card } = await openCard(page, lookLabel);
  await card.getByRole('group', { name: 'Opacity' }).getByRole('button', { name: /^50\s?%$/ }).tap();
  await page.waitForTimeout(400);
  assert.equal((await cardState(card)).open, true, 'the card closed after the opacity tap choice');
  assert.match(await opener.textContent(), /50\s?%/, 'the opacity tap choice was applied');
  const rotation = card.getByRole('group', { name: 'Rotation' }).getByRole('button', { name: /^45°$/ });
  await rotation.scrollIntoViewIfNeeded();
  await rotation.tap();
  await page.waitForTimeout(400);
  assert.equal((await cardState(card)).open, true, 'the card closed after the rotation tap choice');
  assert.match(await opener.textContent(), /50\s?%.*45°/, 'both tap choices were applied');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert.equal((await cardState(card)).open, false, 'Escape closes the card');
  // Close and a tap outside still close it.
  await opener.tap();
  await page.waitForTimeout(300);
  await card.getByRole('button', { name: 'Close', exact: true }).tap();
  await page.waitForTimeout(300);
  assert.equal((await cardState(card)).open, false, 'Close closes the card');
  await opener.tap();
  await page.waitForTimeout(300);
  await page.locator('h1').first().tap();
  await page.waitForTimeout(300);
  assert.equal((await cardState(card)).open, false, 'a tap outside closes the card');
  await context.close();
});

check('c1', 'Watermark: the Size card (one setting) still closes after one tap choice', async (browser) => {
  const context = await newContext(browser);
  const page = await open(context, '/watermark', [qaPdf]);
  const { opener, card } = await openCard(page, 'Size');
  await card.getByRole('button', { name: /^72\s?pt$/ }).tap();
  await page.waitForTimeout(400);
  assert.equal((await cardState(card)).open, false, 'the Size card stayed open');
  assert.match(await opener.textContent(), /72/);
  await context.close();
});

check('c1', 'Page Numbers: the Size and Position cards (one setting each) still close after one tap choice', async (browser) => {
  const context = await newContext(browser);
  const page = await open(context, '/page-numbers', [qaPdf]);
  const size = await openCard(page, 'Font size');
  await size.card.getByRole('button', { name: /^10\s?pt$/ }).tap();
  await page.waitForTimeout(400);
  assert.equal((await cardState(size.card)).open, false, 'the Size card stayed open');
  const position = await openCard(page, 'Position');
  await position.card.getByRole('button', { name: 'Top left', exact: true }).tap();
  await page.waitForTimeout(400);
  assert.equal((await cardState(position.card)).open, false, 'the Position card stayed open');
  await context.close();
});

// ------------------------------------------------------------------ C2

const sideways = [
  { from: { width: 390, height: 844 }, to: { width: 844, height: 390 } },
  { from: { width: 411, height: 914 }, to: { width: 914, height: 411 } },
];
const turnCases = [
  { id: 'merge', route: '/merge', files: () => [qaPdf, fixtureFiles.fillable], label: 'PDF merge order' },
  { id: 'watermark', route: '/watermark', files: () => [qaPdf], label: lookLabel },
  // The control: Split's range card stayed open on the 15 Nov fix.
  { id: 'split', route: '/split', files: () => [qaPdf], label: 'Pages to include' },
];
for (const item of turnCases) {
  for (const { from, to } of sideways) {
    check('c2', `${item.id}: the open card stays open with focus inside when ${from.width}×${from.height} turns to ${to.width}×${to.height}`, async (browser) => {
      const context = await newContext(browser, from);
      const page = await open(context, item.route, item.files());
      const { card } = await openCard(page, item.label);
      assert.deepEqual(await cardState(card), { open: true, focusInside: true }, 'before the turn');
      await page.setViewportSize(to);
      await page.waitForTimeout(900);
      assert.deepEqual(await cardState(card), { open: true, focusInside: true }, `after the turn to ${to.width}×${to.height}`);
      assert.equal(await page.locator('main.tk-tool[data-wide]').count(), 0, 'the phone layout is kept sideways');
      await page.setViewportSize(from);
      await page.waitForTimeout(900);
      assert.deepEqual(await cardState(card), { open: true, focusInside: true }, 'after turning back');
      await context.close();
    });
  }
}

// ------------------------------------------------------------------ C3

/** Lines of the visible tool sentences that hold nothing but punctuation. */
const punctuationOnlyLines = (page) => page.evaluate(() => {
  const found = [];
  const sentences = Array.from(document.querySelectorAll('.tk-sentence-group > p.tk-sentence:not(.tk-measure)'))
    .filter((node) => node.getClientRects().length > 0);
  for (const sentence of sentences) {
    const items = [];
    const add = (rect, punct, text) => { if (rect && (rect.width || rect.height)) items.push({ mid: (rect.top + rect.bottom) / 2, punct, text }); };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent ?? '';
          for (let index = 0; index < text.length; index += 1) {
            const char = text[index];
            if (/\s/u.test(char) || /[⁦-⁩‎‏-]/u.test(char)) continue;
            const range = document.createRange();
            range.setStart(child, index);
            range.setEnd(child, index + 1);
            add(range.getClientRects()[0], /^\p{P}$/u.test(char), char);
          }
        } else if (child instanceof Element) {
          if (child.matches('[data-slot], [data-slot-inline], [data-slot-text], .tk-static, .tk-inline, button, input')) {
            add(child.getBoundingClientRect(), false, `[${(child.textContent ?? '').trim()}]`);
          } else {
            walk(child);
          }
        }
      }
    };
    walk(sentence);
    const lineHeight = parseFloat(getComputedStyle(sentence).lineHeight) || 36;
    const top = sentence.getBoundingClientRect().top;
    const lines = new Map();
    for (const item of items) {
      const line = Math.floor((item.mid - top) / lineHeight);
      if (!lines.has(line)) lines.set(line, []);
      lines.get(line).push(item);
    }
    for (const [line, list] of lines) {
      if (list.length && list.every((item) => item.punct)) found.push(`line ${line + 1} is "${list.map((item) => item.text).join('')}" in "${sentence.textContent?.trim()}"`);
    }
  }
  return found;
});

const widths = [360, 390, 402, 430];

/** Page Numbers with the "Page 1 of 3" format: the iOS simulator's case (P3-orphan-period.png). */
for (const locale of ['en-US', 'de-DE']) {
  check('c3', `Page Numbers, "Page 1 of 3", ${locale}: no sentence line is only punctuation at ${widths.join(', ')} px`, async (browser) => {
    const context = await newContext(browser, { width: 430, height: 932, locale });
    const page = await open(context, '/page-numbers', [qaPdf]);
    // The format slot: the second value of the sentence ("Page 1" in the default format).
    const format = page.locator('.tk-sentence-group [data-slot="format"]:visible').first();
    await format.tap();
    const card = page.locator(`#${await format.getAttribute('aria-controls')}`);
    await card.waitFor({ state: 'visible' });
    await card.locator('[data-tk-preset]').filter({ hasText: /1\D+3/ }).first().tap();
    await page.waitForTimeout(400);
    if (await card.isVisible()) await page.keyboard.press('Escape');
    assert.match(await format.textContent(), /1\D+3/, 'the "Page 1 of 3" format is set');
    const problems = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(500);
      for (const line of await punctuationOnlyLines(page)) problems.push(`${width} px: ${line}`);
    }
    assert.deepEqual(problems, []);
    await context.close();
  });
}

for (const locale of ['en-US', 'de-DE']) {
  check('c3-all', `every tool, ${locale}: no sentence line is only punctuation at ${widths.join(', ')} px`, async (browser) => {
    const problems = [];
    for (const tool of tools) {
      const context = await newContext(browser, { width: 430, height: 932, locale });
      try {
        const page = await open(context, tool.route, tool.files());
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          await page.waitForTimeout(350);
          for (const line of await punctuationOnlyLines(page)) problems.push(`${tool.id} ${width} px: ${line}`);
        }
      } catch (error) {
        problems.push(`${tool.id}: could not load (${String(error?.message ?? error).split('\n')[0]})`);
      } finally {
        await context.close();
      }
    }
    assert.deepEqual(problems, []);
  });
}

// ------------------------------------------------------------------ C4 (fixed 2026-11-25: blank page pans, the text drags)

check('c4', 'Watermark large preview at about 375%: one finger on blank page pans, a drag on the text moves it', async (browser) => {
  const context = await newContext(browser, { width: 390, height: 844 });
  const page = await open(context, '/watermark', [qaPdf]);
  await page.getByRole('button', { name: 'Large preview', exact: true }).tap();
  const dialog = page.getByRole('dialog').last();
  await dialog.waitFor({ state: 'visible' });
  await page.waitForTimeout(800);
  const zoomIn = dialog.getByRole('button', { name: /^Zoom in/ });
  for (let step = 0; step < 12 && (await zoomIn.isEnabled().catch(() => false)); step += 1) {
    const label = await dialog.innerText();
    if (/37\d\s?%|4\d\d\s?%/.test(label)) break;
    await zoomIn.tap();
    await page.waitForTimeout(250);
  }
  const zoom = (await dialog.innerText()).match(/(\d{3})\s?%/)?.[1] ?? '?';
  const readPosition = async () => (await dialog.innerText()).match(/X\s?[\d.,]+\s?%\s?·\s?Y\s?[\d.,]+\s?%/)?.[0] ?? (await page.locator('body').innerText()).match(/X\s?[\d.,]+\s?%\s?·\s?Y\s?[\d.,]+\s?%/)?.[0] ?? '?';
  const scroller = await dialog.evaluateHandle((node) => {
    const all = [node, ...node.querySelectorAll('*')];
    return all.find((el) => el.scrollWidth > el.clientWidth + 20 && el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflow)) ?? node;
  });
  const scroll = () => scroller.evaluate((el) => ({ x: Math.round(el.scrollLeft), y: Math.round(el.scrollTop) }));
  const box = await scroller.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const cdp = await context.newCDPSession(page);
  const touch = async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
  // One finger on blank page, away from the stamp in the middle: near a corner of the view.
  const before1 = { position: await readPosition(), scroll: await scroll() };
  const sx = box.x + box.w * 0.15;
  const sy = box.y + box.h * 0.85;
  await touch('touchStart', [[sx, sy]]);
  for (let step = 1; step <= 8; step += 1) { await touch('touchMove', [[sx + step * 15, sy - step * 18]]); await page.waitForTimeout(30); }
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  const after1 = { position: await readPosition(), scroll: await scroll() };
  // Two fingers moving together.
  const before2 = { position: await readPosition(), scroll: await scroll() };
  const ax = box.x + box.w * 0.6; const ay = box.y + box.h * 0.6; const bx = box.x + box.w * 0.75; const by = box.y + box.h * 0.7;
  await touch('touchStart', [[ax, ay]]);
  await touch('touchStart', [[ax, ay], [bx, by]]);
  for (let step = 1; step <= 8; step += 1) { await touch('touchMove', [[ax - step * 17, ay - step * 20], [bx - step * 17, by - step * 20]]); await page.waitForTimeout(30); }
  await touch('touchEnd', [[ax - 136, ay - 160]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  const after2 = { position: await readPosition(), scroll: await scroll() };
  console.log(`  c4 zoom ${zoom}%`);
  console.log(`  c4 one finger on blank page: stamp ${before1.position} -> ${after1.position}, scroll ${JSON.stringify(before1.scroll)} -> ${JSON.stringify(after1.scroll)}`);
  console.log(`  c4 two fingers: stamp ${before2.position} -> ${after2.position}, scroll ${JSON.stringify(before2.scroll)} -> ${JSON.stringify(after2.scroll)}`);
  // A drag that starts on the text (the page centre, scrolled into the middle of the view) moves it.
  await scroller.evaluate((el) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
  await page.waitForTimeout(200);
  const centre = await dialog.locator('.tk-wm-surface').evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const before3 = await readPosition();
  await touch('touchStart', [[centre.x, centre.y]]);
  for (let step = 1; step <= 6; step += 1) { await touch('touchMove', [[centre.x + step * 10, centre.y + step * 8]]); await page.waitForTimeout(30); }
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  const after3 = await readPosition();
  console.log(`  c4 one finger on the text: stamp ${before3} -> ${after3}`);
  await context.close();
  assert.equal(after1.position, before1.position, 'one finger on blank page must not move the text');
  assert.notDeepEqual(after1.scroll, before1.scroll, 'one finger on blank page must pan');
  assert.equal(after2.position, before2.position, 'two fingers must not move the text');
  assert.notEqual(after3, before3, 'a drag that starts on the text must move it');
});

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  await ensureFixtures(chromium);
  for (const { id, name, run } of cases) {
    if (only.length && !only.includes(id)) continue;
    try {
      await run(browser);
      console.log(`PASS ${id} ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${id} ${name}: ${String(error?.message ?? error).split('\n').slice(0, 6).join(' | ')}`);
    }
  }
} finally {
  await browser.close();
}
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('overnight checks C: all passed');
