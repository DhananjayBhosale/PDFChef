import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const fixture = path.join(process.cwd(), 'qa-sample.pdf');
await fs.access(fixture);

const browser = await chromium.launch({ headless: true });

const verifySurface = async ({ route, label, mobile }) => {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    hasTouch: mobile,
    isMobile: mobile,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false,
      keepLocalHistory: false,
      confirmLargeJobs: false,
      largeFileWarningMb: 80,
      onboardingComplete: true,
      interfaceFont: 'inter',
    }));
  });

  try {
    await page.goto(`${baseUrl}${route}`);
    await page.locator('input[type=file]').setInputFiles(fixture);
    const viewport = page.getByTestId('pdf-zoom-viewport');
    await viewport.waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });
    assert.equal(await viewport.evaluate(element => getComputedStyle(element).touchAction), 'pan-x pan-y');

    const before = Number(await viewport.getAttribute('data-pdf-zoom'));
    const bounds = await viewport.boundingBox();
    assert.ok(bounds, `${label} did not expose zoom viewport bounds`);
    const centerX = Math.max(80, Math.min((mobile ? 310 : 1200), bounds.x + bounds.width / 2));
    const centerY = Math.max(100, Math.min((mobile ? 700 : 800), bounds.y + Math.min(bounds.height, 500) / 2));

    const dispatchPinch = async direction => {
      const startGap = direction === 'in' ? 30 : 60;
      const endGap = direction === 'in' ? 60 : 30;
      if (!mobile) {
        await viewport.dispatchEvent('wheel', {
          ctrlKey: true,
          deltaY: direction === 'in' ? -20 : 20,
          clientX: centerX,
          clientY: centerY,
        });
        return;
      }
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: centerX - startGap, y: centerY },
          { x: centerX + startGap, y: centerY },
        ],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: centerX - endGap, y: centerY },
          { x: centerX + endGap, y: centerY },
        ],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    };

    await dispatchPinch('in');

    await page.waitForFunction(
      previous => Number(document.querySelector('[data-testid="pdf-zoom-viewport"]')?.getAttribute('data-pdf-zoom')) > previous,
      before,
    );
    const after = Number(await viewport.getAttribute('data-pdf-zoom'));
    assert.ok(after > before, `${label} pinch did not increase zoom`);
    await dispatchPinch('out');
    await page.waitForFunction(
      previous => Number(document.querySelector('[data-testid="pdf-zoom-viewport"]')?.getAttribute('data-pdf-zoom')) < previous,
      after,
    );
    const afterOut = Number(await viewport.getAttribute('data-pdf-zoom'));
    assert.ok(afterOut < after, `${label} pinch-out did not decrease zoom`);
    assert.deepEqual(errors, [], `${label} emitted browser errors`);
    return { surface: label, input: mobile ? 'two-touch pinch' : 'Mac trackpad pinch', before, afterIn: after, afterOut };
  } finally {
    await context.close();
  }
};

const verifyCompressionPreview = async mobile => {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    hasTouch: mobile,
    isMobile: mobile,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false,
      keepLocalHistory: false,
      confirmLargeJobs: false,
      largeFileWarningMb: 80,
      onboardingComplete: true,
      interfaceFont: 'inter',
    }));
  });

  try {
    await page.goto(`${baseUrl}/compress`);
    await page.locator('input[type=file]').setInputFiles(fixture);
    // The preview shows pages turned into pictures, which is off by default.
    // The switch is the sentence's one-tap word (owner decision 1, A-004): one tap turns it off.
    await page.getByRole('switch', { name: 'Keep text selectable' }).uncheck();
    // On a phone the quality and its Preview sit in the Quality value's card (owner decision 2026-11-15).
    if (mobile) await page.getByRole('button', { name: /^Quality, / }).click();
    // Exact: the first page beside it is a button too, "Preview page 1", which opens it large (pass 5).
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const original = page.getByTestId('compression-original-preview');
    const compressed = page.getByTestId('compression-compressed-preview');
    await dialog.locator('img').first().waitFor({ state: 'visible', timeout: 60_000 });
    assert.equal(await original.evaluate(element => getComputedStyle(element).touchAction), 'none');
    assert.equal(await compressed.evaluate(element => getComputedStyle(element).touchAction), 'none');

    const zoom = async pane => Number(await pane.getAttribute('data-preview-zoom'));
    const results = [];
    for (const [name, pane] of [['Original', original], ['Compressed', compressed]]) {
      const bounds = await pane.boundingBox();
      assert.ok(bounds, `${name} preview has no bounds`);
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      const changeZoom = async (direction, startGap, endGap) => {
        if (!mobile) {
          await pane.dispatchEvent('wheel', { ctrlKey: true, deltaY: direction === 'in' ? -20 : 20, clientX: x, clientY: y });
          return;
        }
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: x - startGap, y }, { x: x + startGap, y }],
        });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: x - endGap, y }, { x: x + endGap, y }],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      };

      const before = await zoom(pane);
      await changeZoom('in', 30, 70);
      await page.waitForFunction(previous => Number(document.querySelector('[data-testid="compression-original-preview"]')?.getAttribute('data-preview-zoom')) > previous, before);
      const afterIn = await zoom(pane);
      assert.ok(afterIn > before, `${name} preview did not zoom in`);
      assert.equal(await zoom(original), await zoom(compressed), 'Comparison panes must stay in sync');
      await changeZoom('out', 70, 30);
      await page.waitForFunction(previous => Number(document.querySelector('[data-testid="compression-original-preview"]')?.getAttribute('data-preview-zoom')) < previous, afterIn);
      const afterOut = await zoom(pane);
      assert.ok(afterOut < afterIn, `${name} preview did not zoom out`);
      results.push({ pane: name, before, afterIn, afterOut });
    }
    assert.deepEqual(errors, [], 'Compression preview emitted browser errors');
    return { surface: `Compression preview ${mobile ? 'mobile' : 'desktop'}`, input: mobile ? 'two-touch pinch' : 'Mac trackpad pinch', results };
  } finally {
    await context.close();
  }
};

// Overnight 2026-11-24, B13: PDF to Image's page preview zooms to 400%, as Compare and the reader do,
// with + and with two fingers (it stopped at 200%).
const verifyPdfToImageZoom = async mobile => {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    hasTouch: mobile,
    isMobile: mobile,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false, largeFileWarningMb: 80,
      onboardingComplete: true, interfaceFont: 'inter',
    }));
  });
  try {
    await page.goto(`${baseUrl}/pdf-to-jpg`);
    await page.locator('input[type=file]').setInputFiles(fixture);
    const stage = page.locator('.tk-imgstage-view');
    await stage.locator('canvas').waitFor({ state: 'visible', timeout: 60_000 });
    const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
    const percent = async () => Number((await zoomIn.locator('xpath=..').innerText()).match(/(\d+)\s*%/)?.[1]);
    const label = `PDF to Image ${mobile ? 'mobile' : 'desktop'}`;
    let steps = 0;
    while (await zoomIn.isEnabled() && steps < 20) { await zoomIn.click(); steps += 1; }
    assert.equal(await percent(), 400, `${label}: + stops at 400%`);
    await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click();
    assert.equal(await percent(), 100);
    const box = await stage.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + Math.min(box.height, 400) / 2;
    for (let pinch = 0; pinch < 4; pinch += 1) {
      if (mobile) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 30, y }, { x: x + 30, y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 90, y }, { x: x + 90, y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      } else {
        await stage.dispatchEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: x, clientY: y });
      }
      await page.waitForTimeout(150);
    }
    assert.equal(await percent(), 400, `${label}: ${mobile ? 'two fingers reach' : 'a trackpad pinch reaches'} 400%`);
    assert.deepEqual(errors, [], `${label} emitted browser errors`);
    return { surface: label, plusSteps: steps, maxPercent: 400 };
  } finally {
    await context.close();
  }
};

// Overnight 2026-11-24, B12: the large preview draws the page again at 200%. Until that picture is
// ready the old one stays: the page never leaves the frame in the middle of a pinch or a + press.
const verifyLargePreviewKeepsPage = async mobile => {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    hasTouch: mobile,
    isMobile: mobile,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false, largeFileWarningMb: 80,
      onboardingComplete: true, interfaceFont: 'inter',
    }));
  });
  const label = `Large preview ${mobile ? 'mobile' : 'desktop'}`;
  try {
    await page.goto(`${baseUrl}/compress`);
    await page.locator('input[type=file]').setInputFiles(fixture);
    await page.getByRole('button', { name: 'Preview page 1', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const frame = dialog.locator('[data-preview-zoom]');
    await frame.locator('img').waitFor({ state: 'visible', timeout: 60_000 });
    // Counts every moment the frame holds no page picture, however short.
    await frame.evaluate(element => {
      window.__pageGone = 0;
      new MutationObserver(() => { if (!element.querySelector('img')) window.__pageGone += 1; })
        .observe(element, { childList: true, subtree: true });
    });
    const zoomOf = async () => Number(await frame.getAttribute('data-preview-zoom'));
    const box = await frame.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const pinch = async (from, to) => {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - from, y }, { x: x + from, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - to, y }, { x: x + to, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    };
    const zoomIn = dialog.getByRole('button', { name: 'Zoom in', exact: true });
    const zoomOut = dialog.getByRole('button', { name: 'Zoom out', exact: true });
    // Up across 200%, let the sharper picture arrive, then back down across it.
    const firstPicture = await frame.locator('img').getAttribute('src');
    if (mobile) await pinch(30, 80); else for (let step = 0; step < 5; step += 1) await zoomIn.click();
    assert.ok(await zoomOf() > 2, `${label}: zoom crossed 200%`);
    await page.waitForFunction(previous => document.querySelector('[role="dialog"] [data-preview-zoom] img')?.getAttribute('src') !== previous, firstPicture, { timeout: 15_000 });
    await page.waitForTimeout(1000);
    if (mobile) await pinch(80, 30); else for (let step = 0; step < 3; step += 1) await zoomOut.click();
    assert.ok(await zoomOf() < 2, `${label}: zoom came back under 200%`);
    await page.waitForTimeout(2500);
    const gone = await page.evaluate(() => window.__pageGone);
    assert.equal(gone, 0, `${label}: the page left the frame ${gone} time(s) while the zoom crossed 200%`);
    assert.equal(await frame.locator('img').isVisible(), true);
    assert.deepEqual(errors, [], `${label} emitted browser errors`);
    return { surface: label, pageGone: gone };
  } finally {
    await context.close();
  }
};

try {
  const results = [];
  results.push(await verifyLargePreviewKeepsPage(true));
  results.push(await verifyLargePreviewKeepsPage(false));
  results.push(await verifyPdfToImageZoom(true));
  results.push(await verifyPdfToImageZoom(false));
  for (const surface of [
    { route: '/view', label: 'Reader desktop', mobile: false },
    { route: '/sign', label: 'Sign PDF desktop', mobile: false },
    { route: '/view', label: 'Reader mobile', mobile: true },
    { route: '/sign', label: 'Sign PDF mobile', mobile: true },
  ]) {
    results.push(await verifySurface(surface));
  }
  results.push(await verifyCompressionPreview(false));
  results.push(await verifyCompressionPreview(true));
  console.log(JSON.stringify({ status: 'PASS', results }, null, 2));
} finally {
  await browser.close();
}
