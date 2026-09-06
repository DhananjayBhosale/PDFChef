import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const root = process.cwd();
const fixture = path.join(root, 'qa-sample.pdf');
const outputDir = path.join(root, 'output', 'edit-pdf-desktop-verification');
const screenshotPath = path.join(outputDir, 'edit-pdf-inline-text-desktop.png');
const replacementScreenshotPath = path.join(outputDir, 'edit-existing-pdf-text-desktop.png');

await fs.access(fixture);
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];

const trackpadPinch = async (direction) => {
  const viewport = page.getByTestId('pdf-zoom-viewport');
  const bounds = await viewport.boundingBox();
  assert.ok(bounds, 'PDF zoom viewport did not expose bounds');
  const before = Number(await viewport.getAttribute('data-pdf-zoom'));
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    Math.max(1, Math.min(700, bounds.y + Math.min(bounds.height, 500) / 2)),
  );
  await page.keyboard.down('Control');
  try {
    await page.mouse.wheel(0, direction === 'in' ? -20 : 20);
  } finally {
    await page.keyboard.up('Control');
  }
  await page.waitForFunction(
    ({ expectedDirection, previous }) => {
      const value = Number(document.querySelector('[data-testid="pdf-zoom-viewport"]')?.getAttribute('data-pdf-zoom'));
      return expectedDirection === 'in' ? value > previous : value < previous;
    },
    { expectedDirection: direction, previous: before },
  );
  return Number(await viewport.getAttribute('data-pdf-zoom'));
};

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

try {
  await page.goto(`${baseUrl}/edit`);
  await page.getByRole('heading', { name: /Edit PDF/ }).waitFor();
  await page.locator('input[type=file][accept=".pdf"]').setInputFiles(fixture);
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });

  assert.equal(await page.getByRole('toolbar', { name: 'PDF editor tools' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Close editor' }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const trackpadZoomedIn = await trackpadPinch('in');
  const trackpadZoomedOut = await trackpadPinch('out');
  assert.ok(trackpadZoomedIn > 1, 'Mac trackpad pinch-in did not increase PDF zoom');
  assert.ok(trackpadZoomedOut < trackpadZoomedIn, 'Mac trackpad pinch-out did not decrease PDF zoom');

  const zoomViewport = page.getByTestId('pdf-zoom-viewport');
  await zoomViewport.evaluate(element => {
    window.__pdfChefWheelTrust = [];
    element.addEventListener('wheel', event => window.__pdfChefWheelTrust.push(event.isTrusted), { capture: true });
  });
  const currentPage = page.getByLabel('Current editor page');
  await page.mouse.move(640, 500);
  await page.keyboard.down('Control');
  try {
    await page.mouse.wheel(0, -200);
  } finally {
    await page.keyboard.up('Control');
  }
  // The editor zooms further than the viewers do, because editing body text on a small screen
  // needs it. A single hard pinch-in reaches that ceiling.
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="pdf-zoom-viewport"]')?.getAttribute('data-pdf-zoom')) === 4);
  const scrollMetrics = await zoomViewport.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    overflowY: getComputedStyle(element).overflowY,
    windowScrollY: window.scrollY,
  }));
  assert.equal(scrollMetrics.overflowY, 'auto', 'desktop PDF box does not own vertical scrolling');
  assert.ok(scrollMetrics.scrollHeight > scrollMetrics.clientHeight, 'zoomed desktop PDF does not overflow inside its box');
  await page.mouse.move(640, 500);
  await page.mouse.wheel(0, 80);
  await page.waitForFunction(
    previous => (document.querySelector('[data-testid="pdf-zoom-viewport"]'))?.scrollTop > previous,
    scrollMetrics.scrollTop,
  );
  assert.equal(await page.evaluate(() => window.scrollY), scrollMetrics.windowScrollY, 'scrolling the PDF moved the app page');
  await zoomViewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.mouse.wheel(0, 80);
  await page.waitForFunction(() => (document.querySelector('[aria-label="Current editor page"]'))?.value === '1');
  assert.equal(await currentPage.inputValue(), '1', 'scrolling past the zoomed page end did not open the next page');
  await page.waitForTimeout(300);
  await zoomViewport.evaluate(element => { element.scrollTop = 0; });
  await page.mouse.move(640, 500);
  await page.mouse.wheel(0, -80);
  await page.waitForFunction(() => (document.querySelector('[aria-label="Current editor page"]'))?.value === '0');
  assert.equal(await currentPage.inputValue(), '0', 'scrolling past the zoomed page start did not open the previous page');
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).click();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="pdf-zoom-viewport"]')?.getAttribute('data-pdf-zoom')) === 1);

  // Paragraph editing replaced the word-at-a-time targets. The end-to-end guarantees of that
  // surface live in verify-edit-pdf-paragraphs.mjs; what matters here is that the desktop editor
  // exposes them and that they do not fight the annotation tools below.
  const paragraphs = page.locator('[data-testid="pdf-text-block"]');
  await paragraphs.first().waitFor({ timeout: 60_000 });
  assert.ok(await paragraphs.count() > 0, 'no editable paragraphs were reconstructed');
  await paragraphs.first().click();
  await page.getByTestId('pdf-paragraph-inspector').waitFor({ timeout: 10_000 });
  assert.match(
    await page.getByTestId('pdf-paragraph-provenance').innerText(),
    /Drawn with|Substituted/,
    'the paragraph inspector did not say which typeface it is drawing with',
  );
  await page.getByRole('button', { name: 'Done' }).click();
  await page.screenshot({ path: replacementScreenshotPath, fullPage: true });

  const undo = page.getByRole('button', { name: 'Undo added element change' });
  const redo = page.getByRole('button', { name: 'Redo added element change' });

  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const selectedText = page.locator('[role="group"][aria-label^="Selected text on page "]').first();
  await selectedText.waitFor();

  const inlineTextEditor = page.getByRole('textbox', { name: 'Edit text on page 1' });
  await inlineTextEditor.waitFor();
  assert.equal(
    await inlineTextEditor.evaluate(element => document.activeElement === element),
    true,
    'desktop text selection did not focus the on-canvas editor',
  );
  await inlineTextEditor.pressSequentially('Desktop');
  assert.equal(await inlineTextEditor.inputValue(), 'Desktop');
  await inlineTextEditor.press('Escape');

  const inspector = page.getByRole('region', { name: 'Selected text properties' });
  const inspectorText = inspector.getByRole('textbox', { name: 'Text', exact: true });
  await inspectorText.selectText();
  await inspectorText.pressSequentially('Inspector grouped');
  await inspectorText.press('Tab');

  await undo.click();
  const canvasText = page.locator('[role="group"][aria-label^="text on page "]').last();
  assert.equal((await canvasText.textContent())?.trim(), 'Desktop', 'one Undo did not revert the inspector typing session');

  await redo.click();
  assert.equal((await canvasText.textContent())?.trim(), 'Inspector grouped', 'Redo did not restore inspector typing');
  await canvasText.click();
  await inlineTextEditor.press('Escape');
  await inspector.waitFor();

  await page.screenshot({ path: screenshotPath, fullPage: true });
  assert.ok(
    await page.evaluate(() => window.__pdfChefWheelTrust.length >= 3 && window.__pdfChefWheelTrust.every(Boolean)),
    'desktop wheel verification did not use trusted browser input',
  );
  assert.deepEqual(consoleErrors, []);

  console.log(JSON.stringify({
    status: 'PASS',
    viewport: '1280x900',
    screenshots: [replacementScreenshotPath, screenshotPath],
    checked: [
      'desktop toolbar layout',
      'Mac trackpad pinch-in and pinch-out inside the PDF viewport',
      'ordinary vertical scrolling stays inside the zoomed PDF box',
      'ordinary trackpad scrolling crosses zoomed page boundaries in both directions',
      'paragraph editing surface with a stated typeface provenance',
      'direct on-canvas text focus and typing',
      'one-snapshot inspector typing Undo and Redo',
      'desktop selected-text inspector',
      'no horizontal overflow',
    ],
  }, null, 2));
} finally {
  await browser.close();
}
