import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit, devices } from 'playwright';

const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4187';
const output = process.env.PDF_CHEF_WELCOME_OUTPUT || 'output/mobile-app-welcome-20261003/browser';
await mkdir(output, { recursive: true });
const androidLink = 'https://play.google.com/store/apps/details?id=com.dhananjaytech.pdfchef';
const iosLink = 'https://apps.apple.com/app/pdf-chef/id6811619417';
const dismissedKey = 'pdfchef.mobile-app-welcome.dismissed.v1';
const browsers = [];

async function prepare(context, { onboardingComplete = true, blockedStorage = false, locale = 'en-US' } = {}) {
  await context.addInitScript(({ onboardingComplete, blockedStorage, locale }) => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete, keepLocalHistory: false }));
    localStorage.setItem('pdfchef.locale.v1', locale);
    if (blockedStorage) Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Unavailable', 'SecurityError'); } });
  }, { onboardingComplete, blockedStorage, locale });
}

async function checkLayout(page) {
  const layout = await page.evaluate(() => {
    const screen = document.querySelector('[data-testid="mobile-app-welcome"]');
    const controls = [...screen.querySelectorAll('a,button')];
    return {
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      controls: controls.map(element => {
        const box = element.getBoundingClientRect();
        return { width: box.width, height: box.height, left: box.left, right: box.right };
      }),
    };
  });
  assert(layout.scrollWidth <= layout.width + 1, 'No horizontal overflow');
  assert.equal(layout.controls.length, 4, 'Both download links and both website actions');
  for (const control of layout.controls) {
    assert(control.width >= 44 && control.height >= 44, 'Every action has a comfortable tap target');
    assert(control.left >= -1 && control.right <= layout.width + 1, 'Actions fit the screen');
  }
}

try {
  for (const [engine, device, platform] of [[chromium, 'Pixel 7', 'android'], [webkit, 'iPhone 13', 'ios']]) {
    const browser = await engine.launch({ headless: true });
    browsers.push(browser);
    const context = await browser.newContext({ ...devices[device], serviceWorkers: 'block' });
    await prepare(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/compress?source=welcome-check`);
    await page.getByTestId('mobile-app-welcome').waitFor();
    const android = page.getByRole('link', { name: 'Download the app for Android', exact: true });
    const ios = page.getByRole('link', { name: 'Download the app for iOS', exact: true });
    assert.equal(await android.getAttribute('href'), androidLink);
    assert.equal(await ios.getAttribute('href'), iosLink);
    assert((await (platform === 'android' ? android : ios).getAttribute('class')).includes('bg-[var(--accent-rest)]'), 'Current platform download is prominent');
    assert.equal(await page.getByRole('dialog').count(), 0, 'Onboarding cannot cover the choice');
    await checkLayout(page);
    await page.screenshot({ path: `${output}/${platform}.png`, fullPage: true });
    await page.setViewportSize({ width: 320, height: 568 });
    await checkLayout(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await checkLayout(page);
    assert.equal(await page.getByTestId('mobile-app-welcome').count(), 1, 'Phone landscape retains the screen');
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    await skip.focus();
    assert.equal(await skip.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.getByTestId('mobile-app-welcome').waitFor({ state: 'detached' });
    await page.locator('input[type=file]').first().waitFor({ state: 'attached' });
    assert.equal(new URL(page.url()).pathname, '/compress');
    assert.equal(new URL(page.url()).search, '?source=welcome-check');
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), dismissedKey), 'true');
    await page.reload();
    await page.locator('input[type=file]').first().waitFor({ state: 'attached' });
    assert.equal(await page.getByTestId('mobile-app-welcome').count(), 0, 'Reload retains the website choice');
    assert.deepEqual(errors, [], 'No browser errors');
    await context.close();

    const freshContext = await browser.newContext({ ...devices[device], serviceWorkers: 'block' });
    await prepare(freshContext, { onboardingComplete: false });
    const freshPage = await freshContext.newPage();
    await freshPage.goto(`${origin}/#/make-pdf`);
    await freshPage.getByTestId('mobile-app-welcome').waitFor();
    await freshPage.waitForURL('**/make-pdf');
    await freshPage.getByRole('button', { name: 'Visit the website', exact: true }).click();
    await freshPage.getByRole('dialog', { name: 'Before you start', exact: true }).waitFor();
    await freshPage.getByRole('button', { name: 'Start using PDF Chef', exact: true }).click();
    await freshPage.getByRole('heading', { name: 'Create PDF', exact: true }).waitFor();
    assert.equal(new URL(freshPage.url()).pathname, '/make-pdf', 'Legacy deep links are preserved');
    await freshContext.close();
    console.log(`PASS ${platform}: four actions, preferred download, narrow/landscape layout, Skip, Visit, session persistence, deep links and onboarding`);
  }

  const browser = browsers[0];
  for (const options of [{ viewport: { width: 320, height: 568 } }, devices['iPad (gen 7)'], devices['Galaxy Tab S4']]) {
    const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
    await prepare(context);
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator('main').waitFor();
    assert.equal(await page.getByTestId('mobile-app-welcome').count(), 0);
    await context.close();
  }
  console.log('PASS desktop (including narrow windows) and tablets bypass the screen');

  for (const [locale, dark] of [['de-DE', false], ['hi-IN', false], ['ar-SA', false], ['en-US', true]]) {
    const context = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 320, height: 568 }, colorScheme: dark ? 'dark' : 'light', serviceWorkers: 'block' });
    await prepare(context, { locale });
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByTestId('mobile-app-welcome').waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), locale);
    assert.equal(await page.locator('html').getAttribute('dir'), locale === 'ar-SA' ? 'rtl' : 'ltr');
    await checkLayout(page);
    const skipStyle = await page.locator('[data-testid="mobile-app-welcome"] button').last().evaluate(element => {
      const style = getComputedStyle(element);
      return { color: style.color, background: getComputedStyle(document.querySelector('main')).backgroundColor, fontSize: style.fontSize };
    });
    const luminance = color => {
      const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
        value /= 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    const values = [luminance(skipStyle.color), luminance(skipStyle.background)].sort((a, b) => a - b);
    assert((values[1] + 0.05) / (values[0] + 0.05) >= 4.5, 'Secondary Skip text remains readable');
    assert.equal(skipStyle.fontSize, '12px', 'Skip is visually secondary');
    await page.screenshot({ path: `${output}/${locale}${dark ? '-dark' : ''}.png`, fullPage: true });
    await context.close();
  }
  console.log('PASS German, Hindi, Arabic RTL, dark appearance and readable secondary Skip');

  const context = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' });
  await prepare(context, { blockedStorage: true });
  const page = await context.newPage();
  await page.goto(`${origin}/privacy`);
  await page.getByRole('heading', { name: 'Privacy Policy', exact: true }).waitFor();
  assert.equal(await page.getByTestId('mobile-app-welcome').count(), 0);
  await page.goto(`${origin}/edit`);
  await page.getByTestId('mobile-app-welcome').waitFor();
  await page.getByRole('button', { name: 'Visit the website', exact: true }).click();
  await page.getByRole('heading', { name: /^Edit PDF/ }).waitFor();
  assert.equal(await page.getByTestId('mobile-app-welcome').count(), 0);
  await context.close();
  console.log('PASS direct legal access and website access when session storage is blocked');
} finally {
  await Promise.all(browsers.map(browser => browser.close()));
}
