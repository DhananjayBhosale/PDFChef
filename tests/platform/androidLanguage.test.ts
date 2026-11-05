import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocalePreference, setTemporaryLocale } from '../../services/i18n/core.ts';
import { syncAndroidLanguage } from '../../services/platform/android/androidLanguage.ts';

test('nothing is sent before the saved language loads, so a start never clears it', async () => {
  const sent: unknown[] = [];
  const stop = syncAndroidLanguage({ setLanguage: async options => { sent.push(options); } });
  assert.deepEqual(sent, []);
  await setLocalePreference('ru-RU', false); // As initializeLocale does with a saved Russian choice.
  assert.deepEqual(sent, [{ language: 'ru-RU' }]);
  stop();
});

test('Android native screens get the chosen language, or "system" while the app follows the phone', async () => {
  const sent: unknown[] = [];
  const stop = syncAndroidLanguage({ setLanguage: async options => { sent.push(options); } });
  await setLocalePreference('ja-JP', false);
  await setTemporaryLocale('en-US'); // English legal pages leave the chosen language alone.
  await setLocalePreference('system', false);
  await setLocalePreference('system', false);
  stop();
  await setLocalePreference('de-DE', false);
  assert.deepEqual(sent, [{ language: 'ru-RU' }, { language: 'ja-JP' }, { language: 'system' }]);
  await setLocalePreference('system', false);
});

test('a native shell without the plugin leaves the app running', async () => {
  const stop = syncAndroidLanguage({ setLanguage: () => Promise.reject(new Error('not implemented')) });
  await setLocalePreference('fr-FR', false);
  stop();
  await setLocalePreference('system', false);
});
