// Overnight 2026-11-24, fix Group B: behaviour checks for the night's screen fixes that fit no
// existing script (output/web/overnight-2026-11-24/debate/CONCLUSION.md, section 2, Group B).
//
//   PDF_CHEF_URL=http://127.0.0.1:4173 node tests/browser/overnightChecksB.mjs [--only=b2,b6]
//
// QA files only: the PDFs are made here with pdf-lib.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const only = (process.argv.find((arg) => arg.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);
const fixtures = resolve(process.cwd(), 'output/qa-fixtures/overnight-checks-b');

const textPdf = async (name, pages) => {
  const file = resolve(fixtures, name);
  if (existsSync(file)) return file;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= pages; index += 1) {
    doc.addPage([612, 792]).drawText(`QA page ${index}`, { x: 60, y: 692, size: 40, font });
  }
  await mkdir(fixtures, { recursive: true });
  await writeFile(file, await doc.save());
  return file;
};

/** Settings are written once per tab, so a reload keeps what the page changed. */
const newContext = (browser, { width = 390, height = 844 } = {}) => browser.newContext({
  viewport: { width, height }, deviceScaleFactor: width < 768 ? 2 : 1, isMobile: width < 768, hasTouch: width < 768,
}).then(async (context) => {
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('overnight-b.init')) {
      localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
        onboardingComplete: true, keepLocalHistory: false, autoDownload: false, confirmLargeJobs: false,
      }));
      sessionStorage.setItem('overnight-b.init', '1');
    }
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
  });
  return context;
});

/** The visible dialogs' names, for an assertion message. */
const dialogs = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
  .filter((element) => element.getClientRects().length)
  .map((element) => (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)));

/** Whether closing the tab now raises the browser's own "Leave site?" prompt. */
const leavePromptFires = async (page) => {
  let fired = false;
  page.on('dialog', async (dialog) => { if (dialog.type() === 'beforeunload') fired = true; await dialog.dismiss().catch(() => {}); });
  await page.close({ runBeforeUnload: true });
  await new Promise((done) => setTimeout(done, 1500));
  return fired;
};

const cases = [];
const check = (id, name, run) => cases.push({ id, name, run });

// B2 (s4-02): the compact Edit PDF screen keeps the leave guards a tool screen holds.
const openCompactEditor = async (page, file, { viaHome = false } = {}) => {
  if (viaHome) {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('a[href="/edit"]').first().click();
  } else {
    await page.goto(`${origin}/edit`, { waitUntil: 'domcontentloaded' });
  }
  await page.getByRole('heading', { name: /Edit PDF/ }).first().waitFor({ timeout: 60_000 });
  await page.locator('input[type=file][accept=".pdf"]').setInputFiles(file);
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: 'Close editor' }).waitFor();
  await page.waitForTimeout(600);
};
const placeShape = async (page) => {
  await page.getByRole('button', { name: 'Shape', exact: true }).first().click();
  const box = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.58);
  await page.locator('[role="group"][aria-label^="Selected rectangle "]').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).first().isEnabled(), true, 'the shape is an unsaved edit');
};
const shapes = (page) => page.locator('[role="group"][aria-label*="rectangle"]').count();
const saveQuestion = (page) => page.getByRole('dialog', { name: 'Save your edits?' });

check('b2', 'compact Edit PDF: Tools asks before an unsaved shape is lost', async (browser) => {
  const file = await textPdf('three.pdf', 3);
  const context = await newContext(browser);
  const page = await context.newPage();
  await openCompactEditor(page, file);
  await placeShape(page);
  await page.locator('[data-tk-tools]').first().click();
  await saveQuestion(page).waitFor({ timeout: 5000 }).catch(async () => {
    assert.fail(`Tools left with no question: now at ${new URL(page.url()).pathname}, dialogs ${JSON.stringify(await dialogs(page))}`);
  });
  await saveQuestion(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname, '/edit', 'Cancel stays in the editor');
  assert.equal(await shapes(page), 1, 'Cancel keeps the shape');
  await context.close();
});

check('b2', 'compact Edit PDF: browser Back asks before an unsaved shape is lost', async (browser) => {
  const file = await textPdf('three.pdf', 3);
  const context = await newContext(browser);
  const page = await context.newPage();
  await openCompactEditor(page, file, { viaHome: true });
  await placeShape(page);
  await page.goBack({ waitUntil: 'commit' }).catch(() => {});
  await saveQuestion(page).waitFor({ timeout: 5000 }).catch(async () => {
    assert.fail(`Back left with no question: now at ${new URL(page.url()).pathname}, dialogs ${JSON.stringify(await dialogs(page))}`);
  });
  await saveQuestion(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname, '/edit', 'Cancel stays in the editor');
  assert.equal(await shapes(page), 1, 'Cancel keeps the shape');
  await context.close();
});

check('b2', 'compact Edit PDF: reload or closing the tab raises the browser\'s leave prompt', async (browser) => {
  const file = await textPdf('three.pdf', 3);
  const context = await newContext(browser);
  const page = await context.newPage();
  await openCompactEditor(page, file);
  await placeShape(page);
  await page.mouse.click(5, 5);
  assert.equal(await leavePromptFires(page), true, 'no leave prompt with an unsaved shape');
  await context.close();
});

check('b2', 'compact Edit PDF: an untouched file leaves with no question and no leave prompt', async (browser) => {
  const file = await textPdf('three.pdf', 3);
  const context = await newContext(browser);
  const page = await context.newPage();
  await openCompactEditor(page, file);
  assert.equal(await leavePromptFires(page), false, 'a leave prompt with nothing to lose');
  const second = await context.newPage();
  await openCompactEditor(second, file);
  await second.locator('[data-tk-tools]').first().click();
  await second.waitForURL((url) => new URL(url).pathname === '/', { timeout: 5000 });
  assert.deepEqual(await dialogs(second), [], 'no question with nothing to lose');
  await context.close();
});

// B1 (s1-01): Invoice, Receipt and Quote raise the browser's leave prompt once something is typed.
for (const route of ['/invoice', '/receipt', '/quote']) {
  check('b1', `${route}: a typed form raises the leave prompt on reload or close; an untouched one does not`, async (browser) => {
    const context = await newContext(browser, { width: 1440, height: 900 });
    const untouched = await context.newPage();
    await untouched.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await untouched.getByPlaceholder('What you did, or what you sold').first().waitFor({ timeout: 60_000 });
    await untouched.mouse.click(5, 300);
    assert.equal(await leavePromptFires(untouched), false, 'an untouched form asks before leaving');
    const typed = await context.newPage();
    await typed.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await typed.getByPlaceholder('What you did, or what you sold').first().fill('QA consulting');
    await typed.locator('textarea').last().fill('QA notes');
    await typed.waitForTimeout(300);
    assert.equal(await leavePromptFires(typed), true, 'a typed form leaves with no prompt');
    await context.close();
  });
}

// B7 (s3-07): Reorder's order is locked while it saves, so the saved PDF is the order on the screen.
check('b7', 'Reorder: the move, drag and history controls are off while it saves, and the order holds', async (browser) => {
  const file = await textPdf('forty.pdf', 40);
  const context = await newContext(browser, { width: 1440, height: 900 });
  const page = await context.newPage();
  await page.goto(`${origin}/reorder`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file]').first().setInputFiles(file);
  await page.getByRole('button', { name: 'Move page 1 down', exact: true }).click();
  await page.waitForTimeout(300);
  const order = () => page.evaluate(() => Array.from(document.querySelectorAll('[data-peek-page]')).slice(0, 4).map((tile) => tile.getAttribute('data-peek-page')).join(','));
  assert.equal(await order(), '1,0,2,3');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 40 });
  await page.getByRole('button', { name: 'Save reordered PDF', exact: true }).click();
  const during = await page.evaluate(() => {
    const named = (name) => Array.from(document.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === name);
    const on = (button) => Boolean(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    const move = named('Move page 3 down');
    const result = {
      saving: Boolean(document.querySelector('.tk-progress-block, [role="progressbar"]')),
      move: on(move),
      grip: on(named('Drag page 3')),
      undo: on(named('Undo page reorder')),
      reset: on(named('Reset to the original page order')),
    };
    move?.click();
    return result;
  });
  await page.getByRole('button', { name: 'Save reordered PDF', exact: true }).or(page.getByRole('dialog')).first().waitFor({ timeout: 120_000 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.waitForTimeout(500);
  assert.equal(during.saving, true, 'the save was running when the controls were read');
  assert.deepEqual({ move: during.move, grip: during.grip, undo: during.undo, reset: during.reset },
    { move: false, grip: false, undo: false, reset: false }, 'order controls are on during the save');
  assert.equal(await order(), '1,0,2,3', 'the order changed during the save');
  await context.close();
});

// B8 (s3-04): Batch Split takes whole pages per part only; 1.5 keeps Process off with the existing error.
check('b8', 'Batch Split: 1.5 pages per part keeps Process off and says why; 2 turns it on', async (browser) => {
  const file = await textPdf('six.pdf', 6);
  const context = await newContext(browser, { width: 1440, height: 900 });
  const page = await context.newPage();
  await page.goto(`${origin}/batch`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file]').first().setInputFiles(file);
  await page.locator('select').first().selectOption({ label: 'Split PDF' });
  const field = page.getByRole('spinbutton').first();
  const run = page.getByRole('button', { name: /^Process/ });
  await field.fill('1.5');
  await field.press('Tab');
  await page.waitForTimeout(400);
  assert.equal(await run.isEnabled(), false, 'Process runs with 1.5 pages per part');
  await page.getByText('Pages per file must be a positive whole number.').first().waitFor({ timeout: 3000 });
  await field.fill('2');
  await field.press('Tab');
  await page.waitForTimeout(400);
  assert.equal(await run.isEnabled(), true, 'Process stays off with 2 pages per part');
  await context.close();
});

// s3-05: Batch Protect keeps Protect PDF's password rules: at least 4 characters, not only spaces.
check('s3-05', 'Batch Protect: a 3-character or all-space password keeps Process off and says why; 4 characters turn it on', async (browser) => {
  const context = await newContext(browser, { width: 1440, height: 900 });
  const page = await context.newPage();
  await page.goto(`${origin}/batch`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file]').first().setInputFiles(await textPdf('six.pdf', 6));
  await page.locator('select').first().selectOption({ label: 'Protect PDF' });
  const field = page.locator('input[type=password], input[autocomplete="new-password"]').first();
  const run = page.getByRole('button', { name: /^Process/ });
  for (const [value, reason] of [['abc', 'At least 4 characters, with spaces preserved exactly.'], ['    ', 'Password is required to protect a PDF.']]) {
    await field.fill(value);
    await page.waitForTimeout(400);
    assert.equal(await run.isEnabled(), false, `Process runs with the password ${JSON.stringify(value)}`);
    await page.getByText(reason).first().waitFor({ timeout: 3000 });
  }
  await field.fill('abcd');
  await page.waitForTimeout(400);
  assert.equal(await run.isEnabled(), true, 'Process stays off with a 4-character password');
  await context.close();
});

// B10 (s5-03): Russian counts 21 and 101 take the `one` form, so it names no single page or picture.
// No browser: the app's own catalog and plural rules, run in Node.
// s5-04: Make Fillable's hint names the phone's Draw button with the button's own word.
check('s5-04', 'French (Canada), Japanese and Polish: the draw hint names the Draw button as the button reads', async () => {
  const { setLocalePreference, t } = await import('../../services/i18n/core.ts');
  try {
    for (const locale of ['fr-CA', 'ja-JP', 'pl-PL']) {
      await setLocalePreference(locale, false);
      const button = t('sign-pdf.draw.61517c');
      assert.ok(t('make-fillable.drawHint').includes(button), `${locale}: "${t('make-fillable.drawHint')}" does not name "${button}"`);
    }
  } finally {
    await setLocalePreference('en-US', false);
  }
});

check('b10', 'Russian: 1, 21 and 101 pages or pictures never read as "this page" or "the only picture"', async () => {
  const { setLocalePreference, t } = await import('../../services/i18n/core.ts');
  await setLocalePreference('ru-RU', false);
  try {
    // Russian's `one` form serves 1, 21, 31 ... 101 alike, so it must not name a single item.
    for (const count of [21, 101, 1]) {
      const exportLine = t('sentence.makePdf.export', { count, name: 'qa-sample.pdf' });
      const pictures = t('sentence.pdfToImage.images.all', { count });
      assert.doesNotMatch(exportLine, /эту страницу/, `${count}: ${exportLine}`);
      assert.doesNotMatch(pictures, /единственное/, `${count}: ${pictures}`);
    }
    // The other forms still carry the count.
    for (const count of [2, 5, 22]) {
      assert.match(t('sentence.makePdf.export', { count, name: 'qa-sample.pdf' }), new RegExp(`\\b${count}\\b`));
      assert.match(t('sentence.pdfToImage.images.all', { count }), new RegExp(`\\b${count}\\b`));
    }
  } finally {
    await setLocalePreference('en-US', false);
  }
});

// B5 (s4-04): every preview canvas stays within the page canvas cap of 5,242,880 pixels
// (services/pdfPageGeometry.ts), on an A0 poster and on a 14,400 pt square page. Exports are not checked.
const PAGE_CANVAS_CAP = 5_242_880;
const oversizedPdf = async (name, width, height) => {
  const file = resolve(fixtures, name);
  if (existsSync(file)) return file;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([width, height]).drawText('QA oversized page', { x: 60, y: height - 200, size: Math.round(width / 20), font });
  await mkdir(fixtures, { recursive: true });
  await writeFile(file, await doc.save());
  return file;
};
const recordCanvases = () => {
  const proto = HTMLCanvasElement.prototype;
  const width = Object.getOwnPropertyDescriptor(proto, 'width');
  const height = Object.getOwnPropertyDescriptor(proto, 'height');
  window.__largestCanvas = 0;
  const note = (canvas) => { window.__largestCanvas = Math.max(window.__largestCanvas, width.get.call(canvas) * height.get.call(canvas)); };
  Object.defineProperty(proto, 'width', { configurable: true, get() { return width.get.call(this); }, set(value) { width.set.call(this, value); note(this); } });
  Object.defineProperty(proto, 'height', { configurable: true, get() { return height.get.call(this); }, set(value) { height.set.call(this, value); note(this); } });
};
for (const [label, name, width, height] of [['A0 poster', 'a0-poster.pdf', 2384, 3370], ['14,400 pt square', 'giant-14400.pdf', 14400, 14400]]) {
  for (const [surface, route, open] of [
    ['PDF to Image preview', '/pdf-to-jpg', async (page) => page.locator('canvas[role="img"]').first().waitFor({ timeout: 60_000 })],
    ['first-page preview', '/compress', async (page) => page.locator('.tk-filepreview-page img').first().waitFor({ timeout: 60_000 })],
    ['large preview', '/compress', async (page) => {
      await page.locator('.tk-filepreview-page img').first().waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Preview page 1', exact: true }).click();
      await page.getByRole('dialog').locator('[data-preview-zoom] img').waitFor({ timeout: 60_000 });
    }],
  ]) {
    check('b5', `${label}, ${surface}: the page is shown and no canvas is above the cap`, async (browser) => {
      const file = await oversizedPdf(name, width, height);
      const context = await newContext(browser, { width: 1440, height: 900 });
      await context.addInitScript(recordCanvases);
      const page = await context.newPage();
      await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
      await page.locator('input[type=file]').first().setInputFiles(file);
      await open(page);
      await page.waitForTimeout(4000);
      const largest = await page.evaluate(() => window.__largestCanvas);
      assert.ok(largest <= PAGE_CANVAS_CAP, `a ${largest.toLocaleString('en-US')}-pixel canvas`);
      await context.close();
    });
  }
}

// B9 (s4-03): a second finger is a pinch. The stamp, shape or picture an edit holds stays where it
// started, even when the first finger moves too, while the page zooms. Real touches through
// Chromium's input pipeline (CDP), ported from judge/probes-2/s4-03-two-finger.mjs.
const dropFiles = (page, selector, files) => page.locator(selector).first().evaluate((target, inputs) => {
  const transfer = new DataTransfer();
  for (const input of inputs) transfer.items.add(new File([Uint8Array.from(atob(input.base64), (c) => c.charCodeAt(0))], input.name, { type: input.type }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
}, files);
const boxOf = (locator) => locator.evaluate((element) => ({ left: element.style.left, top: element.style.top, width: element.style.width }));
const centreOf = async (locator) => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
/** Finger 1 lands on `a`; finger 2 lands on `b` and moves by `spread`, as a pinch. */
const pinchFrom = async (context, page, a, b, spread, { moveFirst = false } = {}) => {
  const cdp = await context.newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const one = { x: a.x, y: a.y, id: 0 };
  const two = { x: b.x, y: b.y, id: 1 };
  await touch('touchStart', [one]);
  await page.waitForTimeout(120);
  await touch('touchStart', [one, two]);
  await page.waitForTimeout(60);
  for (let step = 1; step <= 6; step += 1) {
    await touch('touchMove', [
      moveFirst ? { ...one, x: one.x - step * 4, y: one.y - step * 4 } : one,
      { ...two, x: two.x + (spread.x * step) / 6, y: two.y + (spread.y * step) / 6 },
    ]);
    await page.waitForTimeout(30);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(500);
  await cdp.detach();
};
const pageZoom = (page) => page.getByTestId('pdf-zoom-viewport').getAttribute('data-pdf-zoom');
const signWithStamp = async (browser) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto(`${origin}/sign`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-file-upload]').waitFor({ timeout: 60_000 });
  const { readFile } = await import('node:fs/promises');
  const pdf = (await readFile(await textPdf('three.pdf', 3))).toString('base64');
  await dropFiles(page, '[data-file-upload]', [{ name: 'three.pdf', type: 'application/pdf', base64: pdf }]);
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(600);
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 80;
    const draw = canvas.getContext('2d'); draw.fillStyle = 'white'; draw.fillRect(0, 0, 240, 80);
    draw.fillStyle = 'black'; draw.font = 'italic 32px serif'; draw.fillText('QA Sign', 12, 48);
    return { name: 'qa-signature.png', type: 'image/png', base64: canvas.toDataURL('image/png').split(',')[1] };
  });
  await dropFiles(page, '[data-testid="pdf-zoom-viewport"]', [image]);
  const item = page.locator('[data-stamp-id]').first();
  await item.waitFor({ timeout: 15_000 });
  await item.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  return { context, page, item };
};
const editWithShape = async (browser) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto(`${origin}/edit`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file][accept=".pdf"]').setInputFiles(await textPdf('three.pdf', 3));
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Shape', exact: true }).first().click();
  const box = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + Math.min(box.height, 500) * 0.35);
  const item = page.locator('[role="group"][aria-label*="rectangle"]').first();
  await item.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  return { context, page, item };
};
for (const [tool, open] of [['Sign', signWithStamp], ['Edit PDF', editWithShape]]) {
  check('b9', `${tool} at 390 px: one finger still drags the item`, async (browser) => {
    const { context, page, item } = await open(browser);
    const a = await centreOf(item);
    const before = await boxOf(item);
    const cdp = await context.newCDPSession(page);
    const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    await touch('touchStart', [{ x: a.x, y: a.y, id: 0 }]);
    for (let step = 1; step <= 6; step += 1) {
      await touch('touchMove', [{ x: a.x, y: a.y + step * 8, id: 0 }]);
      await page.waitForTimeout(30);
    }
    await touch('touchEnd', []);
    await page.waitForTimeout(400);
    await cdp.detach();
    const after = await boxOf(item);
    assert.equal(after.left, before.left);
    assert.notEqual(after.top, before.top, 'the item did not move with one finger');
    await context.close();
  });
  for (const moveFirst of [false, true]) {
    check('b9', `${tool} at 390 px: a pinch that starts on the item${moveFirst ? ', with finger 1 moving too,' : ''} zooms and leaves the item where it was`, async (browser) => {
      const { context, page, item } = await open(browser);
      const a = await centreOf(item);
      const before = await boxOf(item);
      const zoomBefore = await pageZoom(page);
      await pinchFrom(context, page, a, { x: a.x, y: a.y + 120 }, { x: 0, y: 140 }, { moveFirst });
      const after = await boxOf(item);
      assert.deepEqual(after, before, `moved from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
      assert.notEqual(await pageZoom(page), zoomBefore, 'the pinch did not zoom the page');
      await context.close();
    });
  }
}
check('b9', 'Image to PDF at 390 px: a second finger during a corner resize leaves the picture as it was', async (browser) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto(`${origin}/image-to-pdf`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file]').first().setInputFiles(resolve(process.cwd(), 'tests/fixtures/photos/wide.jpg'));
  const corner = page.locator('[data-page-id] div[style*="nwse-resize"]').first();
  await corner.waitFor({ state: 'attached', timeout: 60_000 });
  await corner.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const picture = corner.locator('xpath=..');
  const before = await boxOf(picture);
  const a = await centreOf(corner);
  await pinchFrom(context, page, a, { x: a.x - 100, y: a.y + 60 }, { x: -80, y: 40 }, { moveFirst: true });
  const after = await boxOf(picture);
  assert.ok(before.width, 'no picture box found');
  assert.deepEqual(after, before, `changed from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
  await context.close();
});

// s5-02: Remove hidden info on a file it cannot read says so, not "This file has no hidden info."
check('s5-02', 'Remove hidden info on an unreadable file says its details could not be read', async (browser) => {
  const file = resolve(fixtures, 'qa-malformed.pdf');
  await mkdir(fixtures, { recursive: true });
  await writeFile(file, 'this is not a pdf file, QA malformed fixture.\n'.repeat(4));
  const context = await newContext(browser, { width: 1440, height: 900 });
  const page = await context.newPage();
  await page.goto(`${origin}/remove-metadata`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file]').first().setInputFiles(file);
  const side = page.locator('.tk-hidinfo');
  await side.getByText('This PDF’s details could not be read. Choose another file, or run Repair PDF on it first.')
    .waitFor({ timeout: 15_000 }).catch(() => {});
  const text = (await side.innerText()).replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /no hidden info/i);
  assert.match(text, /details could not be read/);
  await context.close();
});

// B14 (s8-03): at 400% in the large preview, a two-finger move pans the page on a touch screen.
// Ported from judge/probes-3/s8-03-pan.mjs: 390x844, touch, device scale 3.
const smallPrintPdf = async () => {
  const file = resolve(fixtures, 'small-print.pdf');
  if (existsSync(file)) return file;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([595, 842]);
  for (let line = 0; line < 70; line += 1) sheet.drawText(`QA small print line ${line + 1}: the quick brown fox jumps over the lazy dog.`, { x: 40, y: 800 - line * 11, size: 6, font });
  await mkdir(fixtures, { recursive: true });
  await writeFile(file, await doc.save());
  return file;
};
const zoomedLargePreview = async (browser, tool) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true, autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false }));
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
  });
  const page = await context.newPage();
  await page.goto(`${origin}/${tool}`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file]').first().setInputFiles(await smallPrintPdf());
  await page.waitForFunction(() => [...document.querySelectorAll('main img')].some((image) => image.complete && image.naturalWidth > 0), null, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Large preview', exact: true }).tap();
  const plus = page.getByRole('dialog').getByRole('button', { name: 'Zoom in', exact: true });
  for (let press = 0; press < 20 && !(await plus.isDisabled()); press += 1) { await plus.tap(); await page.waitForTimeout(100); }
  await page.waitForTimeout(600);
  const view = page.locator('.tk-largepreview-view');
  const box = await view.boundingBox();
  const scroll = () => view.evaluate((element) => ({ x: Math.round(element.scrollLeft), y: Math.round(element.scrollTop) }));
  /** Fingers move together by (dx, dy) from the centre of the view. */
  const move = async (dx, dy, two) => {
    const cdp = await context.newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const points = (f) => two
      ? [{ x: x - 30 + dx * f, y: y - 20 + dy * f, id: 1 }, { x: x + 30 + dx * f, y: y + 20 + dy * f, id: 2 }]
      : [{ x: x + dx * f, y: y + dy * f, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) });
    for (let step = 1; step <= 12; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(step / 12) });
      await page.waitForTimeout(25);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    await cdp.detach();
  };
  return { context, page, scroll, move };
};
for (const tool of ['watermark', 'crop']) {
  check('b14', `${tool} at 400% on a 390 px touch screen: a two-finger move pans the large preview`, async (browser) => {
    const { context, page, scroll, move } = await zoomedLargePreview(browser, tool);
    const before = await scroll();
    await move(-140, -160, true);
    const after = await scroll();
    assert.ok(after.x - before.x > 100 && after.y - before.y > 100, `scrolled from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
    if (tool === 'watermark') assert.match(await page.getByRole('dialog').innerText(), /X 50\.0% · Y 50\.0%/);
    await context.close();
  });
}
check('b14', 'page-numbers at 400% on a 390 px touch screen: one finger still pans the large preview', async (browser) => {
  const { context, scroll, move } = await zoomedLargePreview(browser, 'page-numbers');
  const before = await scroll();
  await move(-140, -160, false);
  const after = await scroll();
  assert.ok(after.x - before.x > 100 && after.y - before.y > 100, `scrolled from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
  await context.close();
});

// s3-06: Header & Footer will not save a line its Helvetica cannot print; it says which character.
check('s3-06', 'Header & Footer with a Devanagari header keeps its action off and names the character', async (browser) => {
  const context = await newContext(browser, { width: 1440, height: 900 });
  const page = await context.newPage();
  await page.goto(`${origin}/header-footer`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=file]').first().setInputFiles(await textPdf('three.pdf', 3));
  await page.getByPlaceholder('Optional header').fill('भारत');
  await page.waitForTimeout(800);
  const action = page.getByRole('button', { name: 'Add header/footer' });
  assert.equal(await action.isDisabled(), true, 'the action is on');
  assert.match(await page.locator('main').innerText(), /This PDF font cannot display भ \(U\+092D\)/);
  await page.getByPlaceholder('Optional header').fill('QA header');
  await page.waitForTimeout(400);
  assert.equal(await action.isDisabled(), false, 'the action stays off for a Latin header');
  await context.close();
});

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  for (const { id, name, run } of cases) {
    if (only.length && !only.includes(id)) continue;
    try {
      await run(browser);
      console.log(`PASS ${id} ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${id} ${name}: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
} finally {
  await browser.close();
}
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('overnight checks B: all passed');
