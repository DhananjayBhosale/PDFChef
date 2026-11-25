import assert from 'node:assert/strict';
import test from 'node:test';
import { isMobileAppWelcomeRoute, smartphonePlatform, welcomeThisSession } from '../../services/mobileAppWelcome.ts';

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
const origin = 'https://pdfchef.dhananjaytech.app';

test('Android and iPhone browsers receive the correct app choice', () => {
  assert.equal(smartphonePlatform(iphone, 'web', origin), 'ios');
  assert.equal(smartphonePlatform(android, 'web', origin), 'android');
  assert.equal(smartphonePlatform('Mozilla/5.0 (Android 15; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0', 'web', origin), 'android');
});

test('desktop browsers and tablets keep the website entry', () => {
  for (const userAgent of [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    '',
  ]) assert.equal(smartphonePlatform(userAgent, 'web', origin), null);
});

test('installed apps never receive a download screen, including an uninitialized bridge', () => {
  for (const userAgent of [iphone, android]) {
    for (const nativePlatform of ['ios', 'android', 'native']) {
      assert.equal(smartphonePlatform(userAgent, nativePlatform, origin), null);
    }
    assert.equal(smartphonePlatform(userAgent, 'web', 'https://localhost'), null);
    assert.equal(smartphonePlatform(userAgent, 'web', 'capacitor://localhost'), null);
  }
});

test('legal routes remain directly readable while tool links receive the screen', () => {
  for (const path of ['/privacy', '/privacy-policy', '/pdf-chef-privacy', '/terms', '/terms-and-conditions', '/privacy/']) {
    assert.equal(isMobileAppWelcomeRoute(path), false, path);
  }
  for (const path of ['/', '/edit', '/compress', '/make-pdf', '/settings']) {
    assert.equal(isMobileAppWelcomeRoute(path), true, path);
  }
});

test('the get-the-app screen opens every other browser session, and a reload keeps the answer', () => {
  const store = () => { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } }; };
  const local = store();
  const answers = [];
  for (let visit = 0; visit < 4; visit += 1) {
    const session = store();
    const first = welcomeThisSession(session, local);
    assert.equal(welcomeThisSession(session, local), first, 'a reload in the same session');
    answers.push(first);
  }
  assert.deepEqual(answers, [true, false, true, false]);
  const dismissed = store();
  dismissed.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
  assert.equal(welcomeThisSession(dismissed, store()), false);
  assert.equal(welcomeThisSession(null, null), true);
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const kept = store();
  assert.deepEqual([welcomeThisSession(blocked, kept), welcomeThisSession(blocked, kept)], [true, true], 'blocked session storage always shows');
});

test('the version switch only links to a path on this site', async () => {
  const { siteVersionUrl } = await import('../../services/siteVersion.ts');
  assert.equal(siteVersionUrl('old', '/merge'), '/__version/old?to=%2Fmerge');
  assert.equal(siteVersionUrl('new', '//evil.example'), '/__version/new?to=%2F');
  assert.equal(siteVersionUrl('new', 'https://evil.example'), '/__version/new?to=%2F');
});
