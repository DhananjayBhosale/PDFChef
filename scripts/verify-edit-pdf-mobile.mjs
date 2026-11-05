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

// A new result opens its actions sheet. Back (Escape) closes only the sheet; the editor stays.
const closeResultSheet = async () => {
  const resultActions = page.getByRole('dialog').filter({ hasText: 'Result ready' });
  await resultActions.waitFor();
  await page.keyboard.press('Escape');
  await resultActions.waitFor({ state: 'hidden' });
  await canvas().waitFor({ state: 'visible' });
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
  // A phone types into the dock's field; the tap's letter becomes the field's caret.
  const field = page.getByTestId('pdf-paragraph-field');
  await field.waitFor();
  await page.waitForFunction(() => document.activeElement?.dataset?.testid === 'pdf-paragraph-field');
  await page.waitForTimeout(300);
  const focusAfter = await ordinaryParagraph.evaluate((element, anchor) => {
    const block = element.getBoundingClientRect();
    const pdf = element.closest('[data-pdf-page]').getBoundingClientRect();
    return {
      y: pdf.top + anchor.pageY * pdf.height,
      blockTop: (block.top - pdf.top) / pdf.height,
      windowScrollY: window.scrollY,
      userSelect: getComputedStyle(element).userSelect,
      block: block.toJSON(),
      viewport: element.closest('[data-testid="pdf-zoom-viewport"]').getBoundingClientRect().toJSON(),
      pageFocused: document.activeElement === element,
    };
  }, focusBefore);
  // The page fits the paragraph's whole width and centres it, so the tapped point no longer
  // stays put sideways. It stays put vertically.
  assert.ok(focusAfter.block.left >= focusAfter.viewport.left - 1 && focusAfter.block.right <= focusAfter.viewport.right + 1,
    `the paragraph is not fully within the PDF viewport horizontally: ${JSON.stringify(focusAfter)}`);
  assert.ok(Math.abs(focusAfter.y - focusBefore.y) < 2, `focus zoom moved the selected page point vertically: ${JSON.stringify({ focusBefore, focusAfter })}`);
  assert.ok(Math.abs(focusAfter.blockTop - focusBefore.blockTop) < 0.0001, 'focus zoom altered PDF-relative block position');
  assert.equal(focusAfter.windowScrollY, focusBefore.windowScrollY, 'focus zoom scrolled the application page');
  assert.equal(focusAfter.pageFocused, false, 'the page paragraph kept focus while the dock field types');
  assert.equal(await field.getAttribute('data-field-for') !== null, true);
  assert.equal(focusAfter.userSelect, 'text', 'touch selection is unavailable');
  const fieldState = await field.evaluate(element => ({ value: element.value, caret: element.selectionStart, end: element.selectionEnd }));
  assert.equal(fieldState.value, 'This is QA content for tool verification.', 'the field does not show the paragraph text');
  assert.equal(fieldState.caret, fieldState.end);
  assert.ok(fieldState.caret > 0 && fieldState.caret < fieldState.value.length, `the caret is not at the tapped letter: ${fieldState.caret}`);
  // The bottom bar has to stay on screen when the keyboard is up, which is the one moment it
  // matters. A phone raises the keyboard by shrinking the WebView, so shrinking the viewport
  // reproduces it exactly — and catches the real cause, which is never the bar's own CSS: any
  // ancestor left holding a transform becomes the containing block for `position: fixed`, and the
  // bar silently re-anchors to that ancestor's taller box instead of the viewport.
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
  // The field sits in the dock above the keyboard, and the paragraph being typed stays in view.
  const keyboardView = await ordinaryParagraph.evaluate(element => {
    const viewport = element.closest('[data-testid="pdf-zoom-viewport"]').getBoundingClientRect();
    const inspector = document.querySelector('[data-testid="pdf-paragraph-inspector"]').closest('.chef-chrome').getBoundingClientRect();
    const field = document.querySelector('[data-testid="pdf-paragraph-field"]').getBoundingClientRect();
    const block = element.getBoundingClientRect();
    const pdf = element.closest('[data-pdf-page]').getBoundingClientRect();
    return {
      blockTop: block.top, blockBottom: block.bottom, fieldBottom: field.bottom,
      visibleTop: viewport.top, visibleBottom: Math.min(viewport.bottom, inspector.top, window.innerHeight),
      relTop: (block.top - pdf.top) / pdf.height, innerHeight: window.innerHeight,
    };
  });
  assert.ok(keyboardView.blockTop >= keyboardView.visibleTop - 1, 'keyboard avoidance scrolled the paragraph above the PDF viewport');
  assert.ok(keyboardView.blockBottom <= keyboardView.visibleBottom + 1, 'keyboard or inspector obscures the paragraph');
  assert.ok(keyboardView.fieldBottom <= keyboardView.innerHeight + 1, 'the dock field is below the visible area');
  assert.ok(Math.abs(keyboardView.relTop - focusBefore.blockTop) < 0.0001, 'keyboard resize altered PDF-relative block position');
  await field.press('ControlOrMeta+A');
  assert.equal(await field.evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd)), 'This is QA content for tool verification.', 'native selection no longer selects existing text');
  await page.keyboard.insertText('This is QA content for tool verification!');
  await page.getByTestId('pdf-block-preview').first().waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await ordinaryParagraph.innerText(), 'This is QA content for tool verification!', 'Done discarded the inline change');
  assert.equal(await ordinaryParagraph.evaluate(element => document.activeElement === element), false, 'Done did not dismiss editing');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await ordinaryParagraph.innerText(), 'This is QA content for tool verification.', 'Undo did not restore the original paragraph');
  await ordinaryParagraph.tap();
  await page.waitForFunction(() => document.activeElement?.dataset?.testid === 'pdf-paragraph-field');
  await field.press('ControlOrMeta+A');
  await page.keyboard.insertText('This is QA content for tool verification. More.');
  // Redrawn text wraps within its width, so a longer line no longer raises the "Longer than the
  // original line" caution; the details behind the info button open without taking the caret
  // out of the dock field.
  await page.getByTestId('pdf-block-preview').first().waitFor();
  assert.equal(await field.inputValue(), 'This is QA content for tool verification. More.');
  assert.doesNotMatch(await page.getByTestId('pdf-paragraph-status').innerText(), /Longer than the original line/,
    'wrapped text still claims to be longer than the original line');
  await page.getByRole('button', { name: 'About this change' }).click();
  await page.getByTestId('pdf-paragraph-provenance').filter({ hasText: /Long lines wrap to fit its width/ }).waitFor();
  assert.equal(await field.evaluate(element => document.activeElement === element), true,
    'opening the change details took the caret out of the field');
  assert.equal(await page.getByTestId('pdf-block-overflow').count(), 0, 'a floating overflow hint still covers the page');
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
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  const inlineTextEditor = page.getByRole('textbox', { name: 'Edit text on page 1' });
  await inlineTextEditor.waitFor();
  assert.equal(
    await inlineTextEditor.evaluate(element => document.activeElement === element),
    true,
    'selecting placed text did not focus its inline editor',
  );
  // A new text box starts empty (placeholder "Text") and zooms to 16 px text on focus.
  assert.equal(await inlineTextEditor.inputValue(), '', 'a new text box should start empty');
  await inlineTextEditor.pressSequentially('Dhananajay');
  assert.equal(await inlineTextEditor.inputValue(), 'Dhananajay');
  await page.screenshot({ path: inlineTextScreenshotPath, fullPage: true });
  await inlineTextEditor.press('Escape');
  assert.equal(
    await inlineTextEditor.evaluate(element => document.activeElement === element),
    false,
    'Escape did not leave inline editing',
  );
  // One Undo reverts the typing session. The box is then empty, and an empty box that is not
  // selected is removed; while selected it stays, empty.
  await undo.click();
  const canvasText = page.locator('[role="group"][aria-label^="text on page "]').last();
  const textBoxes = page.locator('[role="group"][aria-label^="text on page "]');
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="group"][aria-label^="text on page "]')]
    .some((box) => box.textContent?.includes('Dhananajay')));
  assert.ok(await textBoxes.count() === 0 || (await canvasText.textContent())?.trim() === '',
    'one Undo did not revert the inline typing session');
  await redo.click();
  await canvasText.click();
  assert.equal(await inlineTextEditor.inputValue(), 'Dhananajay', 'Redo did not restore inline text');

  // The add row waits while a text box is selected; Done brings it back.
  await page.getByRole('button', { name: 'Done', exact: true }).click();
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

  // Leaving asks in the app's own sheet; keeping the edits leaves the editor open.
  await page.getByRole('button', { name: 'Close editor' }).click();
  await page.getByText(/Save your edits/).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await canvas().waitFor({ state: 'visible' });

  await page.locator('#main').getByRole('button', { name: 'Save', exact: true }).click();
  // A complete save shows no banner of its own: the result sheet says it.
  await page.getByRole('dialog').filter({ hasText: 'Result ready' }).waitFor({ timeout: 60_000 });
  await closeResultSheet();
  await page.getByRole('button', { name: 'Close editor' }).click();
  await page.getByText('Choose a PDF to edit').waitFor();

  await page.locator('input[type=file][accept=".pdf"]').setInputFiles(fixture);
  await canvas().waitFor({ state: 'visible', timeout: 60_000 });
  await place('text');
  // An empty new text box is dropped when let go, so give it text to save.
  await page.getByRole('textbox', { name: 'Edit text on page 1' }).fill('Saved text');
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
  // Keeping the file in Recent failed, but the file was made: the editor and the result agree.
  // A complete save shows no banner of its own: the result sheet says it.
  await page.getByRole('dialog').filter({ hasText: 'Result ready' }).waitFor({ timeout: 60_000 });
  await page.locator('aside[role="status"]').getByText(/available until dismissed/).waitFor();
  assert.equal(await page.getByText(/Unable to save the edited PDF|Saving did not complete/).count(), 0,
    'a failed history write was reported as a failed save');
  await closeResultSheet();

  // A save that really fails keeps the edits unsaved.
  await place('text');
  // An empty new text box is dropped when let go, so give it text to save.
  await page.getByRole('textbox', { name: 'Edit text on page 1' }).fill('Saved text');
  await page.evaluate(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: true,
      keepLocalHistory: false,
      confirmLargeJobs: false,
      largeFileWarningMb: 80,
      onboardingComplete: true,
      interfaceFont: 'inter',
    }));
    delete window.showSaveFilePicker;
    HTMLAnchorElement.prototype.click = () => { throw new Error('Download blocked'); };
  });
  await page.locator('#main').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Unable to save the edited PDF. Your edits are still here so you can try again.').waitFor();
  // The exact bytes stay on the result sheet so Save can be retried from there.
  await closeResultSheet();
  // Leaving asks in the app's own sheet; keeping the edits leaves the editor open.
  await page.getByRole('button', { name: 'Close editor' }).click();
  await page.getByText(/Save your edits/).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await canvas().waitFor({ state: 'visible' });

  const unexpectedErrors = consoleErrors.filter(message =>
    !message.includes('Local history is unavailable') && !message.includes('Download blocked'));
  assert.deepEqual(unexpectedErrors, []);
  console.log(JSON.stringify({
    status: 'PASS',
    viewport: '390x844',
    screenshots: [inlineTextScreenshotPath, screenshotPath],
    checked: [
      'touchscreen pinch-in and pinch-out inside the PDF viewport',
      'one-finger vertical scrolling stays inside the zoomed PDF box',
      'touch focus zoom fits the whole paragraph in the viewport, keeps its vertical point, and puts the caret in the dock field',
      'keyboard and inspector leave the paragraph and dock field visible without changing PDF-relative position',
      'wrapped text raises no "longer than the original line" caution',
      'Done retains existing-text changes and Undo restores them',
      'visible Next and Previous page controls render different PDF pages',
      'reconstructed paragraphs go inert while an insert is armed',
      'text and shape placement',
      'direct inline text focus, typing, Escape, Undo, and Redo',
      'selection preserves Redo',
      'keyboard move and resize undo',
      'dirty Close cancellation',
      'successful save clears dirty baseline',
      'failed history write still delivers without a failed-save message',
      'failed delivery preserves dirty baseline',
      'no horizontal overflow',
    ],
  }, null, 2));
} finally {
  await browser.close();
}
