import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const root = process.cwd();
const fixture = path.join(root, 'qa-sample.pdf');
const outputDir = path.join(root, 'output', 'edit-pdf-mobile-verification');
const screenshotPath = path.join(outputDir, 'edit-pdf-selected-mobile.png');
const inlineTextScreenshotPath = path.join(outputDir, 'edit-pdf-inline-text-mobile.png');

await fs.access(fixture);
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await context.newPage();
const consoleErrors = [];

page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', error => consoleErrors.push(error.message));

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

const selected = type => page.locator(`[role="group"][aria-label^="Selected ${type} "]`);
const canvas = () => page.locator('canvas').first();
const touchscreenPinch = async (direction) => {
  const viewport = page.getByTestId('pdf-zoom-viewport');
  const bounds = await viewport.boundingBox();
  assert.ok(bounds, 'PDF zoom viewport did not expose bounds');
  const centerX = bounds.x + bounds.width / 2;
  const centerY = Math.max(80, Math.min(760, bounds.y + Math.min(bounds.height, 480) / 2));
  const before = Number(await viewport.getAttribute('data-pdf-zoom'));
  const startGap = direction === 'in' ? 36 : 72;
  const endGap = direction === 'in' ? 72 : 36;
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
  await page.waitForFunction(
    ({ expectedDirection, previous }) => {
      const value = Number(document.querySelector('[data-testid="pdf-zoom-viewport"]')?.getAttribute('data-pdf-zoom'));
      return expectedDirection === 'in' ? value > previous : value < previous;
    },
    { expectedDirection: direction, previous: before },
  );
  await page.waitForTimeout(300);
  return Number(await viewport.getAttribute('data-pdf-zoom'));
};
const touchscreenScrollDown = async () => {
  const viewport = page.getByTestId('pdf-zoom-viewport');
  const bounds = await viewport.boundingBox();
  assert.ok(bounds, 'mobile PDF scroll viewport did not expose bounds');
  const before = await viewport.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    overflowY: getComputedStyle(element).overflowY,
    windowScrollY: window.scrollY,
  }));
  assert.equal(before.overflowY, 'auto', 'mobile PDF box does not own vertical scrolling');
  assert.ok(before.scrollHeight > before.clientHeight, 'zoomed mobile PDF does not overflow inside its box');
  const x = bounds.x + bounds.width / 2;
  const startY = Math.min(bounds.y + bounds.height - 48, bounds.y + 300);
  const endY = Math.max(bounds.y + 48, startY - 180);
  const cdp = await context.newCDPSession(page);
  // Let Chromium pace a real touch swipe across frames. Sending every move in one burst can
  // coalesce the entire gesture before the compositor starts scrolling, especially after pinch.
  await cdp.send('Input.synthesizeScrollGesture', {
    x, y: startY, yDistance: endY - startY,
    gestureSourceType: 'touch', speed: 600, preventFling: true,
  });
  await cdp.detach();
  await page.waitForFunction(
    previous => (document.querySelector('[data-testid="pdf-zoom-viewport"]'))?.scrollTop > previous,
    before.scrollTop,
  );
  await viewport.evaluate(element => new Promise(resolve => {
    let previous = element.scrollTop;
    let stableFrames = 0;
    const check = () => {
      const current = element.scrollTop;
      stableFrames = Math.abs(current - previous) < 0.25 ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 4) resolve(undefined);
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
  assert.equal(await page.evaluate(() => window.scrollY), before.windowScrollY, 'touch-scrolling the PDF moved the app page');
};
const upload = async () => {
  if (page.url() === 'about:blank') {
    await page.goto(baseUrl);
    await page.locator('a[href="/edit"]').first().click();
  } else {
    await page.goto(`${baseUrl}/edit`);
  }
  await page.getByRole('heading', { name: /Edit PDF/ }).waitFor();
  await page.locator('input[type=file][accept=".pdf"]').setInputFiles(fixture);
  await canvas().waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: 'Close editor' }).waitFor();
};

const place = async type => {
  await page.getByRole('button', { name: type === 'text' ? 'Text' : 'Shape', exact: true }).click();
  const bounds = await canvas().boundingBox();
  assert.ok(bounds, 'PDF canvas did not expose bounds');
  await page.mouse.click(
    bounds.x + bounds.width * (type === 'text' ? 0.35 : 0.62),
    bounds.y + bounds.height * (type === 'text' ? 0.32 : 0.58),
  );
  await selected(type === 'shape' ? 'rectangle' : type).waitFor();
};

try {
  await upload();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const touchZoomedIn = await touchscreenPinch('in');
  await touchscreenScrollDown();
  const touchZoomedOut = await touchscreenPinch('out');
  assert.ok(touchZoomedIn > 1, 'touchscreen pinch-in did not increase PDF zoom');
  assert.ok(touchZoomedOut < touchZoomedIn, 'touchscreen pinch-out did not decrease PDF zoom');

  // The fling/pinch control above may retain compositor momentum; isolate focus geometry from it.
  await upload();

  const currentPage = page.getByLabel('Current editor page');
  const paragraphs = page.locator('[data-testid="pdf-text-block"]');
  await paragraphs.first().waitFor({ timeout: 60_000 });
  const ordinaryParagraph = paragraphs.filter({ hasText: 'This is QA content for tool verification' });
  await page.getByTestId('pdf-zoom-viewport').evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
  const focusBefore = await ordinaryParagraph.evaluate(element => {
    const block = element.getBoundingClientRect();
    const pdf = element.closest('[data-pdf-page]').getBoundingClientRect();
    const x = block.left + 20;
    const y = block.top + block.height / 2;
    return {
      x, y,
      pageX: (x - pdf.left) / pdf.width,
      pageY: (y - pdf.top) / pdf.height,
      blockTop: (block.top - pdf.top) / pdf.height,
      zoom: Number(document.querySelector('[data-testid="pdf-zoom-viewport"]').dataset.pdfZoom),
      windowScrollY: window.scrollY,
    };
  });
  await page.touchscreen.tap(focusBefore.x, focusBefore.y);
  await page.waitForFunction(previous => Number(document.querySelector('[data-testid="pdf-zoom-viewport"]').dataset.pdfZoom) > previous, focusBefore.zoom);
  await page.waitForTimeout(200);
  const focusAfter = await ordinaryParagraph.evaluate((element, anchor) => {
    const block = element.getBoundingClientRect();
    const pdf = element.closest('[data-pdf-page]').getBoundingClientRect();
    const selection = window.getSelection();
    const caret = document.createRange();
    caret.setStart(selection.focusNode, selection.focusOffset);
    caret.collapse(true);
    return {
      x: pdf.left + anchor.pageX * pdf.width,
      y: pdf.top + anchor.pageY * pdf.height,
      blockTop: (block.top - pdf.top) / pdf.height,
      windowScrollY: window.scrollY,
      editable: element.isContentEditable,
      userSelect: getComputedStyle(element).userSelect,
      caret: caret.getBoundingClientRect().toJSON(),
      viewport: element.closest('[data-testid="pdf-zoom-viewport"]').getBoundingClientRect().toJSON(),
    };
  }, focusBefore);
  assert.ok(Math.abs(focusAfter.x - focusBefore.x) < 2, `focus zoom moved the selected page point horizontally: ${JSON.stringify({ focusBefore, focusAfter })}`);
  assert.ok(Math.abs(focusAfter.y - focusBefore.y) < 2, `focus zoom moved the selected page point vertically: ${JSON.stringify({ focusBefore, focusAfter })}`);
  assert.ok(Math.abs(focusAfter.blockTop - focusBefore.blockTop) < 0.0001, 'focus zoom altered PDF-relative block position');
  assert.equal(focusAfter.windowScrollY, focusBefore.windowScrollY, 'focus zoom scrolled the application page');
  assert.equal(focusAfter.editable, true);
  assert.equal(focusAfter.userSelect, 'text', 'touch selection is unavailable');
  // The bottom bar has to stay on screen when the keyboard is up, which is the one moment it
  // matters. A phone raises the keyboard by shrinking the WebView, so shrinking the viewport
  // reproduces it exactly — and catches the real cause, which is never the bar's own CSS: any
  // ancestor left holding a transform becomes the containing block for `position: fixed`, and the
  // bar silently re-anchors to that ancestor's taller box instead of the viewport.
  await page.waitForFunction(() => document.activeElement?.dataset?.testid === 'pdf-text-block');
  await page.setViewportSize({ width: 390, height: 530 });
  await page.waitForTimeout(400);
  const keyboardChrome = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="pdf-paragraph-inspector"]')?.closest('.chef-chrome');
    const transformed = [];
    for (let node = bar?.parentElement; node; node = node.parentElement) {
      if (getComputedStyle(node).transform !== 'none') transformed.push(node.className || node.tagName);
    }
    return {
      bottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
      innerHeight: window.innerHeight,
      transformed,
    };
  });
  assert.deepEqual(
    keyboardChrome.transformed,
    [],
    `an ancestor of the editor's fixed bottom bar holds a transform: ${keyboardChrome.transformed.join(', ')}`,
  );
  assert.ok(
    keyboardChrome.bottom !== null && keyboardChrome.bottom <= keyboardChrome.innerHeight + 1,
    `editor bottom bar ends at ${keyboardChrome.bottom} with only ${keyboardChrome.innerHeight} visible`,
  );
  const keyboardCaret = await ordinaryParagraph.evaluate(element => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(selection.focusNode, selection.focusOffset);
    range.collapse(true);
    const caret = range.getBoundingClientRect();
    const viewport = element.closest('[data-testid="pdf-zoom-viewport"]').getBoundingClientRect();
    const inspector = document.querySelector('[data-testid="pdf-paragraph-inspector"]').closest('.chef-chrome').getBoundingClientRect();
    const block = element.getBoundingClientRect();
    const pdf = element.closest('[data-pdf-page]').getBoundingClientRect();
    return { top: caret.top, bottom: caret.bottom, visibleTop: viewport.top, visibleBottom: Math.min(viewport.bottom, inspector.top, window.innerHeight), blockTop: (block.top - pdf.top) / pdf.height };
  });
  assert.ok(keyboardCaret.top >= keyboardCaret.visibleTop - 1, 'keyboard avoidance scrolled the caret above the PDF viewport');
  assert.ok(keyboardCaret.bottom <= keyboardCaret.visibleBottom + 1, 'keyboard or inspector obscures the caret');
  assert.ok(Math.abs(keyboardCaret.blockTop - focusBefore.blockTop) < 0.0001, 'keyboard resize altered PDF-relative block position');
  await ordinaryParagraph.press('ControlOrMeta+A');
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'This is QA content for tool verification.', 'native selection no longer selects existing text');
  await page.keyboard.insertText('This is QA content for tool verification!');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await ordinaryParagraph.innerText(), 'This is QA content for tool verification!', 'Done discarded the inline change');
  assert.equal(await ordinaryParagraph.evaluate(element => document.activeElement === element), false, 'Done did not dismiss editing');
  await page.getByRole('button', { name: 'Undo added element change' }).click();
  assert.equal(await ordinaryParagraph.innerText(), 'This is QA content for tool verification.', 'Undo did not restore the original paragraph');
  await ordinaryParagraph.click();
  await ordinaryParagraph.press('ControlOrMeta+A');
  await page.keyboard.insertText('This is QA content for tool verification. More.');
  const overflowHint = page.getByTestId('pdf-block-overflow');
  await overflowHint.waitFor();
  const hintGeometry = await overflowHint.evaluate(hint => {
    const selection = getSelection();
    const range = document.createRange();
    range.setStart(selection.focusNode, selection.focusOffset);
    range.collapse(true);
    return { hint: hint.getBoundingClientRect().toJSON(), caret: range.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight };
  });
  assert.ok(hintGeometry.hint.left >= 0 && hintGeometry.hint.right <= hintGeometry.width,
    'the mobile overflow hint is clipped horizontally');
  assert.ok(hintGeometry.hint.top >= 0 && hintGeometry.hint.bottom <= hintGeometry.height,
    'the keyboard obscures the mobile overflow hint');
  assert.ok(hintGeometry.hint.top >= hintGeometry.caret.bottom || hintGeometry.hint.bottom <= hintGeometry.caret.top,
    'the overflow hint obscures the caret');
  await page.getByRole('button', { name: 'Revert this paragraph' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(200);
  const resetZoom = page.getByRole('button', { name: 'Reset zoom to 100%' });
  if (await resetZoom.isEnabled()) await resetZoom.click();

  const firstPageParagraphs = await paragraphs.evaluateAll(blocks => blocks.map(block => block.innerText));
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Current editor page"]')?.value === '1');
  await page.getByRole('group', { name: /Page 2 of/ }).waitFor({ state: 'visible' });
  assert.equal(await currentPage.inputValue(), '1');
  const secondPageParagraphs = await paragraphs.evaluateAll(blocks => blocks.map(block => block.innerText));
  assert.notDeepEqual(secondPageParagraphs, firstPageParagraphs, 'Next page did not render a different PDF page');
  await page.getByRole('button', { name: 'Previous page' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Current editor page"]')?.value === '0');
  await page.getByRole('group', { name: /Page 1 of/ }).waitFor({ state: 'visible' });
  assert.equal(await currentPage.inputValue(), '0');

  // An armed insert must not steal taps meant for the page, so the paragraphs go inert.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  assert.equal(await paragraphs.first().evaluate(element => getComputedStyle(element).pointerEvents), 'none');
  assert.equal(await paragraphs.first().evaluate(element => element.tabIndex), -1);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  assert.equal(await paragraphs.first().evaluate(element => element.tabIndex), 0);

  await place('text');
  const undo = page.getByRole('button', { name: 'Undo added element change' });
  const redo = page.getByRole('button', { name: 'Redo added element change' });
  const inlineTextEditor = page.getByRole('textbox', { name: 'Edit text on page 1' });
  await inlineTextEditor.waitFor();
  assert.equal(
    await inlineTextEditor.evaluate(element => document.activeElement === element),
    true,
    'selecting placed text did not focus its inline editor',
  );
  await inlineTextEditor.pressSequentially('Dhananajay');
  assert.equal(await inlineTextEditor.inputValue(), 'Dhananajay');
  await page.screenshot({ path: inlineTextScreenshotPath, fullPage: true });
  await inlineTextEditor.press('Escape');
  assert.equal(
    await inlineTextEditor.evaluate(element => document.activeElement === element),
    false,
    'Escape did not leave inline editing',
  );
  await undo.click();
  const canvasText = page.locator('[role="group"][aria-label^="text on page "]').last();
  assert.equal((await canvasText.textContent())?.trim(), 'Text', 'one Undo did not revert the inline typing session');
  await redo.click();
  await canvasText.click();
  assert.equal(await inlineTextEditor.inputValue(), 'Dhananajay', 'Redo did not restore inline text');

  await place('shape');
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await undo.click();
  await assert.rejects(selected('rectangle').waitFor({ state: 'visible', timeout: 500 }));
  await page.locator('[role="group"][aria-label^="text on page "]').last().click();
  await selected('text').waitFor();
  assert.equal(await redo.isEnabled(), true, 'selection-only tap cleared Redo');
  await redo.click();
  await page.locator('[role="group"][aria-label^="rectangle on page "]').waitFor();

  await page.locator('[role="group"][aria-label^="text on page "]').last().click();
  const text = selected('text');
  await text.focus();
  const textStart = await text.evaluate(element => element.style.left);
  await text.dispatchEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', repeat: false });
  for (let index = 0; index < 100; index += 1) {
    await text.dispatchEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', repeat: true });
  }
  const textMoved = await text.evaluate(element => element.style.left);
  assert.notEqual(textMoved, textStart, 'keyboard movement did not move the selected element');
  await undo.click();
  assert.equal(
    await page.locator('[role="group"][aria-label^="text on page "]').last().evaluate(element => element.style.left),
    textStart,
  );

  await page.locator('[role="group"][aria-label^="rectangle on page "]').click();
  const rectangle = selected('rectangle');
  await rectangle.focus();
  const resize = rectangle.getByRole('button', { name: 'Resize selected element with arrow keys' });
  const widthStart = await rectangle.evaluate(element => element.style.width);
  await resize.dispatchEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', repeat: false });
  const widthChanged = await rectangle.evaluate(element => element.style.width);
  assert.notEqual(widthChanged, widthStart, 'keyboard resize did not change the selected element');
  await undo.click();
  assert.equal(
    await page.locator('[role="group"][aria-label^="rectangle on page "]').evaluate(element => element.style.width),
    widthStart,
  );

  let closePrompt = '';
  page.once('dialog', async dialog => {
    closePrompt = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Close editor' }).click();
  assert.match(closePrompt, /Discard your unsaved edits/);
  await canvas().waitFor({ state: 'visible' });

  await page.locator('#main').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Edited PDF ready. Review it before sharing.').waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Close editor' }).click();
  await page.getByText('Choose a PDF to edit').waitFor();

  await page.locator('input[type=file][accept=".pdf"]').setInputFiles(fixture);
  await canvas().waitFor({ state: 'visible', timeout: 60_000 });
  await place('text');
  await page.evaluate(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false,
      keepLocalHistory: true,
      confirmLargeJobs: false,
      largeFileWarningMb: 80,
      onboardingComplete: true,
      interfaceFont: 'inter',
    }));
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  });
  await page.locator('#main').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Unable to save the edited PDF. Your edits are still here so you can try again.').waitFor();
  let failurePrompt = '';
  page.once('dialog', async dialog => {
    failurePrompt = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Close editor' }).click();
  assert.match(failurePrompt, /Discard your unsaved edits/);
  await canvas().waitFor({ state: 'visible' });

  const unexpectedErrors = consoleErrors.filter(message => !message.includes('Local history is unavailable'));
  assert.deepEqual(unexpectedErrors, []);
  console.log(JSON.stringify({
    status: 'PASS',
    viewport: '390x844',
    screenshots: [inlineTextScreenshotPath, screenshotPath],
    checked: [
      'touchscreen pinch-in and pinch-out inside the PDF viewport',
      'one-finger vertical scrolling stays inside the zoomed PDF box',
      'touch focus zoom preserves the selected PDF point and native text selection',
      'keyboard and inspector leave the caret visible without changing PDF-relative position',
      'overflow guidance stays readable above the keyboard without covering the caret',
      'Done retains existing-text changes and Undo restores them',
      'visible Next and Previous page controls render different PDF pages',
      'reconstructed paragraphs go inert while an insert is armed',
      'text and shape placement',
      'direct inline text focus, typing, Escape, Undo, and Redo',
      'selection preserves Redo',
      'keyboard move and resize undo',
      'dirty Close cancellation',
      'successful save clears dirty baseline',
      'failed delivery preserves dirty baseline',
      'no horizontal overflow',
    ],
  }, null, 2));
} finally {
  await browser.close();
}
