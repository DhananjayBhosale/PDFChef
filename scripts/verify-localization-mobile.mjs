import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3074';
const output = process.env.PDF_CHEF_I18N_OUTPUT || 'output/localization-20260918/browser';
await mkdir(output, { recursive: true });
const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
const routes = [...new Set([...app.matchAll(/<Route\s+path="([^"]+)"/g)].map(match => match[1]))]
  .map(route => route === '*' ? '/localization-unknown-route' : route);
const languages = process.env.PDF_CHEF_TEST_LOCALES?.split(',').filter(Boolean) || ['en-US', 'de-DE', 'fr-FR', 'ja-JP', 'zh-Hans', 'hi-IN', 'ar-SA'];
const reports = [];
const browser = await chromium.launch({ headless: true });
const document = await PDFDocument.create();
const font = await document.embedFont(StandardFonts.Helvetica);
document.addPage([595, 842]).drawText('PDF Chef localization control. Keep this document unchanged.', { x: 40, y: 740, size: 12, font });
const fixture = Buffer.from(await document.save());

try {
  for (const locale of languages) {
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale });
    await context.addInitScript(({ locale }) => {
      localStorage.setItem('pdfchef.locale.v1', locale);
      localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true, keepLocalHistory: false, autoDownload: false }));
    }, { locale });
    const page = await context.newPage();
    const errors = [], warnings = [], loadedCatalogs = new Set();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.text().includes('[i18n]')) warnings.push(message.text()); });
    page.on('request', request => {
      if (/\/i18n\/locales\/|\/assets\/(?:de-DE|fr-FR|ja-JP|zh-Hans|hi-IN|ar-SA)-/.test(request.url())) loadedCatalogs.add(new URL(request.url()).pathname);
    });
    const check = async route => {
      await page.goto(origin + route, { waitUntil: 'networkidle' });
      await page.locator('main').first().waitFor();
      const layout = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        text: document.querySelector('main')?.textContent?.trim(),
        logoTransform: [...document.querySelectorAll('img[src*="pdf-chef-logo"]')].map(image => getComputedStyle(image).transform),
      }));
      assert.equal(layout.lang, locale, route);
      assert.equal(layout.dir, locale === 'ar-SA' ? 'rtl' : 'ltr', route);
      assert(layout.text?.length > 2, `${locale} ${route}: empty route`);
      assert(layout.scrollWidth <= layout.width + 1, `${locale} ${route}: horizontal overflow ${layout.scrollWidth}/${layout.width}`);
      assert(layout.logoTransform.every(transform => transform === 'none'), 'Logo must never mirror');
      if (route === '/') {
        const categories = await page.locator('[role="group"] button[aria-pressed]').evaluateAll(buttons => buttons.map(button => {
          const box = button.getBoundingClientRect();
          const label = button.querySelector('span');
          const text = label?.getBoundingClientRect();
          return {
            label: label?.textContent?.trim() || '',
            aria: button.getAttribute('aria-label') || '',
            fits: Boolean(text && text.left >= box.left - 1 && text.right <= box.right + 1),
          };
        }));
        assert.equal(categories.length, 6, `${locale}: all category filters remain available`);
        for (const category of categories) {
          assert(category.fits, `${locale}: category label overflows its button: ${category.label}`);
          assert(category.aria.includes(category.label), `${locale}: category accessibility name is not localized`);
        }
      }
      return { route, ...layout, text: undefined };
    };
    const checkedRoutes = [];
    for (const route of ['de-DE', 'ar-SA'].includes(locale) ? routes : ['/', '/recent', '/settings', '/help', '/edit']) checkedRoutes.push(await check(route));
    await check('/settings');
    const language = page.locator('#app-language');
    assert.equal(await language.locator('option').count(), 25);
    await page.screenshot({ path: `${output}/${locale}-settings.png`, fullPage: true });
    if (['de-DE', 'fr-FR', 'ar-SA'].includes(locale)) {
      await page.evaluate(() => localStorage.setItem('pdfchef.appearance.text-scale.v1', 'larger'));
      checkedRoutes.push(await check('/settings'));
      checkedRoutes.push(await check('/'));
      await page.screenshot({ path: `${output}/${locale}-large-text.png`, fullPage: true });
    }
    // Document content is a separate LTR coordinate space even while the interface is RTL.
    await check('/edit');
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'localization-control.pdf', mimeType: 'application/pdf', buffer: fixture });
    const editable = page.locator('[data-testid="pdf-text-block"][contenteditable="plaintext-only"]').first();
    await editable.waitFor({ timeout: 60_000 });
    assert.match(await editable.innerText(), /localization control/);
    assert.equal(await editable.evaluate(element => getComputedStyle(element).direction), 'ltr');
    assert.equal(await page.getByTestId('pdf-zoom-viewport').evaluate(element => getComputedStyle(element).direction), 'ltr', 'Document scroll coordinates stay LTR');
    if (locale === 'ar-SA') {
      const anchor = await page.evaluate(async () => {
        const viewport = document.querySelector('[data-testid="pdf-zoom-viewport"]');
        const pdfPage = document.querySelector('[data-pdf-page]');
        const bounds = viewport.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const relativeX = () => {
          const pageBounds = pdfPage.getBoundingClientRect();
          return (x - pageBounds.left) / pageBounds.width;
        };
        const before = relativeX();
        viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -350, clientX: x, clientY: bounds.top + 100 }));
        await new Promise(resolve => setTimeout(resolve, 350));
        return { before, after: relativeX(), zoom: Number(viewport.getAttribute('data-pdf-zoom')) };
      });
      assert(anchor.zoom > 1, 'Arabic document zoom remains functional');
      // Fixed viewport padding does not scale; the large-text LTR control shifts by 0.0216.
      // Keep the same small tolerance in RTL, well below the broken RTL shift of 0.375.
      assert(Math.abs(anchor.after - anchor.before) < 0.03, `RTL chrome must not move the document zoom anchor: ${JSON.stringify(anchor)}`);
    }
    const editorLayout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert(editorLayout.scrollWidth <= editorLayout.width + 1, `${locale}: loaded editor controls overflow the screen`);
    await page.screenshot({ path: `${output}/${locale}-editor.png`, fullPage: true });
    if (locale === 'ar-SA') {
      // Field identifiers remain literal, but their UI types must be localized.
      await check('/make-fillable');
      await page.locator('input[type="file"]').first().setInputFiles({ name: 'localization-control.pdf', mimeType: 'application/pdf', buffer: fixture });
      const type = page.locator('aside select').first();
      await type.selectOption('checkbox');
      const typeLabel = await type.locator('option:checked').textContent();
      await page.locator('aside input[placeholder]').first().fill('regression_field');
      const preview = page.locator('main img[draggable="false"]').first();
      await preview.scrollIntoViewIfNeeded();
      const box = await preview.boundingBox();
      assert(box, 'Fillable PDF preview is visible');
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.3);
      await page.mouse.up();
      const field = page.locator('button[title][aria-pressed="true"]').first();
      await field.waitFor();
      assert((await field.getAttribute('title')).includes(typeLabel));
      assert((await field.getAttribute('aria-label')).includes(typeLabel));
      assert((await field.getAttribute('aria-label')).includes('regression_field'));
      assert(!(await field.getAttribute('aria-label')).includes('checkbox'), 'Do not announce English internal type IDs');
    }
    assert.deepEqual(errors, [], `${locale}: browser errors`);
    assert.deepEqual(warnings, [], `${locale}: missing translations`);
    // The English fallback is initial code; only the selected non-English catalog is requested.
    assert(loadedCatalogs.size <= (locale.startsWith('en-') ? 0 : 1), `${locale}: loaded unrelated catalogs: ${[...loadedCatalogs]}`);
    reports.push({ locale, routes: checkedRoutes, editorLayout, errors, warnings, loadedCatalogs: [...loadedCatalogs] });
    await context.close();
    console.log(`PASS ${locale}: ${checkedRoutes.length} routes/layouts, editable PDF, no missing-key warnings`);
  }
  if (languages.includes('de-DE') && languages.includes('ar-SA')) {
  // Exercise actual Settings change and subsequent reload without an init script overriding it.
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: 'de-DE' });
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true })));
  await page.goto(origin + '/settings');
  await page.locator('main').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'de-DE');
  const select = page.locator('#app-language');
  await select.selectOption('ar-SA');
  await page.waitForFunction(() => document.documentElement.lang === 'ar-SA');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await select.selectOption('system');
  await page.waitForFunction(() => document.documentElement.lang === 'de-DE');
  await context.close();
  console.log('PASS system language, explicit override, persistence and RTL reset');
  }
  // A failed initial catalog download must not replace the user's language preference.
  for (const preference of ['system', 'fr-CA']) {
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: 'fr-CA', serviceWorkers: 'block' });
    await context.addInitScript(preference => {
      localStorage.setItem('pdfchef.locale.v1', preference);
      localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true }));
    }, preference);
    await context.route(/(?:\/i18n\/locales\/fr-CA\.ts|\/assets\/fr-CA-[\w-]+\.js)/, route => route.abort());
    const page = await context.newPage();
    await page.goto(origin + '/settings');
    await page.locator('#app-language').waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en-US');
    assert.equal(await page.locator('#app-language').inputValue(), preference);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'languages', { configurable: true, value: ['ja-JP'] });
      window.dispatchEvent(new Event('languagechange'));
    });
    if (preference === 'system') {
      await page.waitForFunction(() => document.documentElement.lang === 'ja-JP');
    } else {
      assert.equal(await page.locator('html').getAttribute('lang'), 'en-US');
      assert.equal(await page.locator('#app-language').inputValue(), 'fr-CA');
    }
    await context.close();
  }
  console.log('PASS catalog failure preserves explicit preference and System language recovery');
  const imageLabels = [];
  for (const locale of process.env.PDF_CHEF_TEST_IMAGE_LOCALES?.split(',').filter(Boolean) || []) {
    const catalog = JSON.parse(await readFile(new URL(`../localization/drafts/${locale}.json`, import.meta.url), 'utf8'));
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale });
    context.setDefaultTimeout(30_000);
    await context.addInitScript(locale => {
      localStorage.setItem('pdfchef.locale.v1', locale);
      localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true, keepLocalHistory: false, autoDownload: false }));
    }, locale);
    const page = await context.newPage();
    await page.goto(origin + '/edit');
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'image-label.pdf', mimeType: 'application/pdf', buffer: fixture });
    await page.locator('[data-testid="pdf-text-block"][contenteditable="plaintext-only"]').first().waitFor({ timeout: 60_000 });
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 24;
      const context = canvas.getContext('2d');
      context.fillStyle = '#e51b23';
      context.fillRect(0, 0, 24, 24);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({ name: 'label-control.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const inspector = page.getByRole('region', { name: catalog['editor.image.properties'], exact: true });
    await inspector.waitFor();
    const label = await inspector.locator('span.uppercase').innerText();
    assert.equal(label, catalog['edit-pdf.image.1aa4cb'].toLocaleUpperCase(locale));
    imageLabels.push({ locale, label, expected: catalog['edit-pdf.image.1aa4cb'], passed: true });
    await page.screenshot({ path: `${output}/${locale}-selected-image.png`, fullPage: true });
    await context.close();
    console.log(`PASS ${locale}: selected image heading ${label}`);
  }
  if (imageLabels.length) await writeFile(`${output}/image-labels.json`, JSON.stringify(imageLabels, null, 2));
  {
    const german = JSON.parse(await readFile(new URL('../localization/drafts/de-DE.json', import.meta.url), 'utf8'));
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: 'en-US' });
    context.setDefaultTimeout(30_000);
    await context.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true, keepLocalHistory: false, autoDownload: false })));
    const page = await context.newPage();
    await page.goto(origin + '/edit');
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'locale-switch.pdf', mimeType: 'application/pdf', buffer: fixture });
    const editable = page.locator('[data-testid="pdf-text-block"][contenteditable="plaintext-only"]').first();
    await editable.waitFor({ timeout: 60_000 });
    await editable.fill('PDF Chef localization control. Keep this document edited.');
    await page.getByLabel('Typeface', { exact: true }).selectOption('serif');
    const provenance = page.getByTestId('pdf-paragraph-provenance');
    await page.waitForFunction(() => document.querySelector('[data-testid="pdf-paragraph-provenance"]')?.textContent.includes('font overridden for this paragraph'));
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'languages', { configurable: true, value: ['de-DE'] });
      window.dispatchEvent(new Event('languagechange'));
    });
    const translatedReason = german['pdf-font-resolution.font.overridden.for.this.paragraph.4e3f4b'];
    await page.waitForFunction(reason => document.querySelector('[data-testid="pdf-paragraph-provenance"]')?.textContent.includes(reason), translatedReason);
    assert(!(await provenance.innerText()).includes('font overridden'));
    assert((await editable.innerText()).includes('document edited.'), 'Language changes retain the edit');
    await page.getByRole('button', { name: german['pdf-paragraph-inspector.done.12e9a0'], exact: true }).click();
    await page.getByRole('button', { name: german['edit-pdf.shape.e0e492'], exact: true }).press('Enter');
    const inspector = page.getByRole('region', { name: german['editor.rectangle.properties'], exact: true });
    await inspector.waitFor();
    assert.equal(await inspector.locator('span.uppercase').innerText(), german['edit-pdf.rectangle.030699'].toUpperCase());
    await context.close();
    console.log('PASS live editor language change refreshes diagnostics and selected-element labels without losing edits');
  }
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(reports, null, 2));
  await browser.close();
}
