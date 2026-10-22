import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { locales } from '../../services/i18n/locales.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const script = read('public/webview-update/webview-update.js');

/** Runs the page script the way an old WebView would and returns what it put on screen. */
const show = (languages: string[], saved: string | null | Error = null) => {
  const elements: Record<string, { textContent: string }> = { title: { textContent: '' }, message: { textContent: '' }, play: { textContent: '' } };
  const document = { documentElement: { lang: '', dir: '' }, title: '', getElementById: (id: string) => elements[id] };
  const localStorage = { getItem: () => { if (saved instanceof Error) throw saved; return saved; } };
  runInNewContext(script, { window: { localStorage }, navigator: { languages, language: languages[0] }, document });
  return { lang: document.documentElement.lang, dir: document.documentElement.dir, title: elements.title.textContent, message: elements.message.textContent, button: elements.play.textContent, documentTitle: document.title };
};

test('the shell shows the update page on a WebView below the floor, and the page is packaged', () => {
  assert.match(read('capacitor.config.ts'), /minWebViewVersion: 119,/);
  const activity = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/MainActivity.java');
  assert.match(activity, /bridge\.isMinimumWebViewInstalled\(\)\s*\?\s*PdfChefWebViewPolicy\.rendererRecoveryUrl\(recoveryUrl\)\s*:\s*PdfChefWebViewPolicy\.WEBVIEW_UPDATE_URL;/);
  const policy = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/security/PdfChefWebViewPolicy.java');
  const path = policy.match(/WEBVIEW_UPDATE_URL = PACKAGED_ORIGIN \+ "\/([^"]+)"/)?.[1];
  assert.equal(path, 'webview-update/index.html');
  const page = read(`public/${path}`);
  assert.match(page, /<script src="webview-update\.js"><\/script>/);
  assert.match(page, /href="https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.google\.android\.webview"/);
  assert.match(page, /script-src 'self';/);
});

test('the page script stays ES5 so the old WebViews it is for can run it', () => {
  assert.doesNotMatch(script, /=>|\blet\b|\bconst\b|`|\?\.|\?\?|\bclass\b|\.\.\./);
});

test('the page follows the app language first, then the phone, then English', () => {
  assert.equal(show(['en-US'], 'de-DE').lang, 'de');
  assert.equal(show(['de-DE'], 'system').lang, 'de');
  assert.equal(show(['fr-FR'], new Error('blocked')).lang, 'fr');
  assert.equal(show(['xx-YY', 'it-IT']).lang, 'it');
  assert.equal(show(['xx-YY']).lang, 'en');
  assert.equal(show(['zh-TW']).lang, 'zh-Hant');
  assert.equal(show(['zh-Hant-HK']).lang, 'zh-Hant');
  assert.equal(show(['zh-CN']).lang, 'zh-Hans');
  assert.equal(show(['pt-PT']).lang, 'pt-PT');
  assert.equal(show(['pt-BR']).lang, 'pt-BR');
  assert.equal(show(['in-ID']).lang, 'id');
  const arabic = show(['ar-EG']);
  assert.deepEqual([arabic.lang, arabic.dir], ['ar', 'rtl']);
  assert.equal(show(['en-GB']).dir, 'ltr');
});

test('every app language has its own heading, sentence and button', () => {
  const english = show(['en-US']);
  for (const [locale] of locales) {
    const shown = show([locale]);
    for (const text of [shown.title, shown.message, shown.button]) assert.ok(text.trim(), `${locale} is missing text`);
    assert.equal(shown.documentTitle, shown.title);
    if (!locale.startsWith('en-')) assert.notEqual(shown.message, english.message, `${locale} fell back to English`);
  }
});
