// A card that holds two sliders shows both of them whole at the phone's largest text size
// (Watermark's "Opacity · Rotation" card showed one field at a time at 200%, 26 Nov 2026).
// Also covers the two position cards (Watermark, Page Numbers). QA file only.
//   PDF_CHEF_URL=http://127.0.0.1:4173 node tests/browser/pairedSlidersLargeText.mjs [shot-folder]
// PAIRED_SLIDERS_BASELINE=<file.json>: at normal text, writes the cards' rectangles to the file when
// it does not exist, and compares with it when it does (proof that a change left normal text alone).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { closeEditor, loadFixture, qaPdf } from '../../scripts/lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL ?? 'http://127.0.0.1:4173';
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
const baselineFile = process.env.PAIRED_SLIDERS_BASELINE ? resolve(process.env.PAIRED_SLIDERS_BASELINE) : null;
if (shots) await mkdir(shots, { recursive: true });

const viewports = [{ width: 320, height: 693 }, { width: 390, height: 844 }];
/** The phone's own text size, as `services/platform/capacitor/iosDynamicType.ts` reports it. */
const scales = [2, 1.5, 1];
const cards = [
  { key: 'watermark-look', route: '/watermark', opener: /^Opacity · Rotation/, taps: true },
  { key: 'watermark-position', route: '/watermark', opener: /^Horizontal · Vertical/ },
  { key: 'page-numbers-position', route: '/page-numbers', opener: /^Position/ },
];

/** The open card: its body, each slider field's number box, slider and taps, and the page above it. */
const measure = () => {
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const card = document.querySelector('.tk-pop[role="dialog"]');
  const body = card?.querySelector('.tk-pop-body');
  const frame = document.querySelector('.tk-pframe');
  const action = [...document.querySelectorAll('.tk-actions')].find((node) => node.getClientRects().length > 0);
  if (!card || !body || !frame) return null;
  const fields = [...body.querySelectorAll('.tk-sliders > *')].filter((field) => field.querySelector('[role="slider"]'));
  return {
    card: box(card),
    body: box(body),
    scrolls: body.scrollHeight - body.clientHeight,
    page: box(frame).top,
    action: action ? box(action).top : null,
    screen: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, height: window.innerHeight },
    fields: fields.map((field) => ({
      field: box(field),
      value: box(field.querySelector('.chef-slider-value')),
      slider: box(field.querySelector('[role="slider"]')),
      taps: [...field.querySelectorAll('.tk-tap')].map(box),
    })),
    taps: [...body.querySelectorAll('.tk-tap')].map((tap) => ({ ...box(tap), fixed: Boolean(tap.closest('.tk-taps[style]')) })),
  };
};

const round = (value) => Math.round(value * 10) / 10;
const inside = (inner, outer) => inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5 && inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;

const browser = await chromium.launch();
const normal = {};
let failed = 0;
for (const viewport of viewports) {
  for (const scale of scales) {
    const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await context.addInitScript((systemScale) => {
      localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true }));
      sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
      if (systemScale === 1) return;
      // What iOS Dynamic Type sets (the browser build has no `-apple-system-body` to read it from).
      const apply = () => {
        document.documentElement.style.setProperty('--system-text-scale', String(systemScale));
        document.documentElement.dataset.systemTextScale = 'large';
      };
      if (document.documentElement) apply();
      document.addEventListener('DOMContentLoaded', apply);
    }, scale);
    const page = await context.newPage();
    let route = '';
    for (const card of cards) {
      const name = `${card.key} ${viewport.width}x${viewport.height} text ${scale * 100}%`;
      try {
        if (route !== card.route) {
          await loadFixture(page, card.route, [qaPdf], { origin, settleMs: 1500 });
          route = card.route;
        }
        // Not `openSlot`: a position chip is under the page, which the open card covers.
        const opener = page.getByRole('button', { name: card.opener }).first();
        const covered = await opener.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return !node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        });
        if (covered) {
          // A failure (26 Nov 2026: the page covered Watermark's position chip at 200%). Still open
          // the card, by keyboard, so the card's own checks run too.
          failed += 1;
          console.log(`FAIL ${name}: something else is drawn over the card's opener, so a tap misses it`);
          await opener.focus();
          await page.keyboard.press('Enter');
        } else {
          await opener.click();
        }
        await page.locator('.tk-pop[role="dialog"]').waitFor();
        await page.waitForTimeout(500);
        const seen = await page.evaluate(measure);
        const fontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
        assert.equal(fontSize, 16 * scale, `the page text is at ${scale * 100}%`);
        if (shots && viewport.width === 320) await page.screenshot({ path: resolve(shots, `${card.key}-${viewport.width}-${scale * 100}.png`) });
        await closeEditor(page);
        assert.ok(seen, 'the card opened over a live preview');
        if (scale === 1) {
          // Measured from the first field, so a card that may now be taller compares field for field.
          const from = seen.fields[0]?.field.top ?? seen.body.top;
          normal[`${card.key} ${viewport.width}x${viewport.height}`] = {
            card: [seen.card.top, seen.card.height].map(round),
            fields: seen.fields.map((field) => [field.field.top - from, field.field.height, field.value.width, field.slider.left, field.slider.width].map(round)),
            taps: seen.taps.map((tap) => [tap.left, tap.top - from, tap.width, tap.height].map(round)),
          };
        }
        assert.equal(seen.fields.length, 2, 'the card has two slider fields');
        // Normal text stays as it is today: only the baseline comparison below checks it.
        if (scale === 1) {
          console.log(`MEASURED ${name}: card ${Math.round(seen.card.height)} px, page keeps ${Math.round(seen.card.top - seen.page)} px`);
          continue;
        }
        seen.fields.forEach((field, index) => {
          const which = index === 0 ? 'first' : 'second';
          assert.ok(inside(field.value, seen.body), `the ${which} field's number box shows whole without scrolling (box ${Math.round(field.value.top)}-${Math.round(field.value.bottom)}, card body ${Math.round(seen.body.top)}-${Math.round(seen.body.bottom)})`);
          assert.ok(inside(field.slider, seen.body), `the ${which} field's slider shows whole without scrolling (slider ${Math.round(field.slider.top)}-${Math.round(field.slider.bottom)}, card body ${Math.round(seen.body.top)}-${Math.round(seen.body.bottom)})`);
          assert.ok(field.slider.width >= 120, `the ${which} slider is at least 120 px wide (${Math.round(field.slider.width)})`);
          assert.ok(field.slider.height >= 48, `the ${which} slider is at least 48 px tall (${Math.round(field.slider.height)})`);
        });
        if (card.taps) assert.ok(seen.taps.length >= 8, `both fields keep their tap choices (${seen.taps.length})`);
        seen.taps.forEach((tap, index) => {
          assert.ok(tap.height >= 38, `tap ${index + 1} is at least 38 px tall (${Math.round(tap.height)})`);
          // A fixed grid (Page Numbers' 3 x 2 places) keeps its columns; at large text its words wrap
          // inside their cells, so the grid fits the card (decision 26 Nov 2026).
          assert.ok(inside(tap, seen.body), `tap ${index + 1}${tap.fixed ? ' of a fixed grid' : ''} shows whole inside the card (tap ${Math.round(tap.left)}-${Math.round(tap.right)} x ${Math.round(tap.top)}-${Math.round(tap.bottom)}, card body ${Math.round(seen.body.left)}-${Math.round(seen.body.right)} x ${Math.round(seen.body.top)}-${Math.round(seen.body.bottom)})`);
        });
        assert.ok(seen.screen.scroll <= seen.screen.width, `no sideways scrolling (${seen.screen.scroll} > ${seen.screen.width})`);
        // At large text the settings rows fill most of a small phone and the page is a strip, so a
        // card that needs the room may cover the page and the rows; never the main action.
        assert.ok(seen.action === null || seen.card.bottom <= seen.action + 0.5, `the main action stays in view below the card (card ends ${Math.round(seen.card.bottom)}, action starts ${Math.round(seen.action)})`);
        console.log(`PASS ${name}: card ${Math.round(seen.card.height)} px, sliders ${seen.fields.map((field) => Math.round(field.slider.width)).join(' and ')} px wide, card ends ${Math.round(seen.card.bottom)} above the action at ${Math.round(seen.action)}`);
      } catch (error) {
        failed += 1;
        console.log(`FAIL ${name}: ${error.message.split('\n')[0]}`);
        // Only when a card is still open: Escape on the tool itself leaves it.
        if (await page.locator('.tk-pop[role="dialog"]').count()) await closeEditor(page).catch(() => {});
      }
    }
    await context.close();
  }
}
await browser.close();

if (baselineFile) {
  if (!existsSync(baselineFile)) {
    await writeFile(baselineFile, `${JSON.stringify(normal, null, 1)}\n`);
    console.log(`Baseline written: ${baselineFile}`);
  } else {
    const baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
    const differences = Object.keys({ ...baseline, ...normal }).flatMap((key) => ['card', 'fields', 'taps']
      .filter((part) => JSON.stringify(baseline[key]?.[part]) !== JSON.stringify(normal[key]?.[part]))
      .map((part) => `${key} ${part}: was ${JSON.stringify(baseline[key]?.[part])}, now ${JSON.stringify(normal[key]?.[part])}`));
    if (differences.length) {
      failed += 1;
      differences.forEach((difference) => console.log(`FAIL normal text differs from the baseline: ${difference}`));
    } else {
      console.log('PASS normal text: every card, field and tap is where the baseline has it');
    }
  }
}
process.exit(failed ? 1 : 0);
