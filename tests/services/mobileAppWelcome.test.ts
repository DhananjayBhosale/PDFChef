import assert from 'node:assert/strict';
import test from 'node:test';
import { isMobileAppWelcomeRoute, smartphonePlatform } from '../../services/mobileAppWelcome.ts';

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
