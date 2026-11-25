// A setting value that is one long word ("CONFIDENTIAL") at Largest text breaks inside its row
// instead of running off the screen (🍎 sync, 25 Nov 2026, S1). QA file only.
//   PDF_CHEF_URL=http://127.0.0.1:4501 node tests/browser/longWordValue.mjs [shot.png]
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loadFixture, qaPdf } from '../../scripts/lib/tool-ui.mjs';

const origin = process.env.PDF_CHEF_URL ?? 'http://127.0.0.1:4173';
const browser = await chromium.launch();
let failed = 0;
for (const width of [320, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true }));
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
    localStorage.setItem('pdfchef.appearance.text-scale.v1', 'larger');
  });
  const page = await context.newPage();
  await loadFixture(page, '/watermark', [qaPdf], { origin, settleMs: 1500 });
  // iOS's largest accessibility text size scales the page past the app's own Largest setting.
  await page.addStyleTag({ content: 'html { font-size: 150% !important; }' });
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => {
    const value = [...document.querySelectorAll('.tk-row-value')].find((node) => /CONFIDENTIAL/.test(node.textContent ?? ''));
    if (!value) return { found: false };
    // The text itself, which can run past its box, and the row's chevron after it.
    const range = document.createRange();
    range.selectNodeContents(value.querySelector('.tk-slot-text') ?? value);
    const caret = value.closest('.tk-row')?.querySelector('.tk-slot-caret')?.getBoundingClientRect();
    return {
      found: true,
      right: Math.max(...[...range.getClientRects()].map((rect) => rect.right)),
      limit: Math.min(document.documentElement.clientWidth, caret ? caret.left + 1 : Infinity),
      page: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    };
  });
  if (process.argv[2] && width === 320) await page.screenshot({ path: process.argv[2] });
  try {
    if (!result.found) { console.log(`SKIP ${width} px: the settings read as a sentence, not rows`); await context.close(); continue; }
    assert.ok(result.right <= result.limit, `the value ends before its chevron and the screen edge (${Math.round(result.right)} > ${Math.round(result.limit)})`);
    assert.ok(result.scroll <= result.page, `no sideways scrolling (${result.scroll} > ${result.page})`);
    console.log(`PASS ${width} px, Largest text: "CONFIDENTIAL" stays on screen`);
  } catch (error) { failed += 1; console.log(`FAIL ${width} px: ${error.message}`); }
  await context.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
