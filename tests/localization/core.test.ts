import assert from 'node:assert/strict';
import test from 'node:test';
import { direction, locales, resolveLocale } from '../../services/i18n/locales.ts';
import { formatMessage, getLocale, getLocalePreference, isPendingTranslation, loadCatalog, pendingTextProps, setLocalePreference, setTemporaryLocale, subscribeLocale, t } from '../../services/i18n/core.ts';
import { pendingTranslation } from '../../services/i18n/pending.ts';
import { LocalizedError, localizeError, nativeTextPlanningError } from '../../services/i18n/errors.ts';
import { readFileSync } from 'node:fs';
import { normalizeSearchText } from '../../services/toolSearch.ts';

test('supported locale tags and store mappings are unique and complete', () => {
  assert.equal(locales.length, 25);
  assert.equal(new Set(locales.map(row => row[0])).size, 25);
  assert.equal(locales.find(row => row[0] === 'es-419')?.[2], 'es-MX');
});
test('system locale negotiation preserves regions, Chinese scripts and Latin American Spanish', () => {
  for (const [locale] of locales) assert.equal(resolveLocale([locale]), locale);
  assert.equal(resolveLocale(['fr']), 'fr-FR');
  assert.equal(resolveLocale(['fr-CA']), 'fr-CA');
  assert.equal(resolveLocale(['pt-PT']), 'pt-PT');
  assert.equal(resolveLocale(['fr-CA-u-nu-latn']), 'fr-CA');
  assert.equal(resolveLocale(['pt-PT-u-nu-latn']), 'pt-PT');
  // Portuguese outside Brazil follows pt-PT, as Android's native screens do.
  assert.equal(resolveLocale(['pt-AO']), 'pt-PT');
  assert.equal(resolveLocale(['pt-MZ']), 'pt-PT');
  assert.equal(resolveLocale(['pt']), 'pt-BR');
  assert.equal(resolveLocale(['pt-BR']), 'pt-BR');
  assert.equal(resolveLocale(['en-GB-u-hc-h23']), 'en-GB');
  assert.equal(resolveLocale(['zh-TW']), 'zh-Hant');
  assert.equal(resolveLocale(['zh-HK']), 'zh-Hant');
  assert.equal(resolveLocale(['zh-CN']), 'zh-Hans');
  assert.equal(resolveLocale(['es-MX']), 'es-419');
  assert.equal(resolveLocale(['invalid_tag', 'ja']), 'ja-JP');
  assert.equal(resolveLocale(['ru']), 'ru-RU');
  assert.equal(resolveLocale(['ru-KZ']), 'ru-RU');
  assert.equal(resolveLocale(['uk-UA', 'zz-ZZ']), 'en-US');
});
test('Russian plurals select one, few and many forms by Intl', async () => {
  const message = (await loadCatalog('ru-RU'))['recent-page.delete.cfd948'];
  for (const [count, text] of [[1, 'Удалить 1 файл?'], [3, 'Удалить 3 файла?'], [5, 'Удалить 5 файлов?'], [21, 'Удалить 21 файл?']] as const) {
    assert.equal(formatMessage(message, { count }, 'ru-RU'), text);
  }
});
test('only Arabic changes interface direction', () => {
  for (const [locale] of locales) assert.equal(direction(locale), locale === 'ar-SA' ? 'rtl' : 'ltr');
});
test('Arabic plural categories are selected by Intl, including zero, dual and few', () => {
  const message = { zero: 'zero {count}', one: 'one {count}', two: 'two {count}', few: 'few {count}', many: 'many {count}', other: 'other {count}' };
  for (const [count, category] of [[0, 'zero'], [1, 'one'], [2, 'two'], [3, 'few'], [11, 'many'], [100, 'other']] as const) {
    assert.equal(formatMessage(message, { count }, 'ar-SA'), `${category} ${new Intl.NumberFormat('ar-SA').format(count)}`);
  }
});
test('interpolation keeps user content and PDF formatting tokens literal', () => {
  assert.equal(formatMessage('Page {token}: {name}', { token: '{n}', name: '<script>literal</script>' }, 'en-US'), 'Page {n}: <script>literal</script>');
  assert.equal(t('settings.language'), 'Language');
});

test('counted image and scan actions support singular and plural messages', () => {
  assert.equal(t('editor.revertBlocked', { count: 1 }), 'Revert 1 paragraph');
  assert.equal(t('editor.revertBlocked', { count: 2 }), 'Revert 2 paragraphs');
  assert.equal(t('image-to-pdf.added.images.the.image.limit.has.been.83b23e', { count: 1, v1: 100 }), 'Added 1 image. The 100-image limit has been reached.');
  assert.equal(t('image-to-pdf.added.images.the.image.limit.has.been.83b23e', { count: 2, v1: 100 }), 'Added 2 images. The 100-image limit has been reached.');
  assert.equal(t('make-pdf.export.page.pdf.2e36cb', { count: 1 }), 'Export 1-page PDF');
});

test('the scan notice has one movable link slot within a complete sentence', () => {
  const parts = t('editor.scan.useOcr', { page: 3, tool: '\uFFFC' }).split('\uFFFC');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^Page 3 /);
  // Translators can move the link first, rather than being restricted to an English suffix.
  assert.deepEqual(formatMessage('{tool}: {page}', { tool: '\uFFFC', page: 3 }, 'en-US').split('\uFFFC'), ['', ': 3']);
});

test('tool search preserves Hindi vowel marks, Arabic marks and CJK text', () => {
  assert.equal(normalizeSearchText('फ़ाइल जोड़ें'), 'फ़ाइल जोड़ें'.normalize('NFKC'));
  assert.equal(normalizeSearchText('تَوْقِيع PDF'), 'تَوْقِيع pdf');
  assert.equal(normalizeSearchText('合并 PDF'), '合并 pdf');
});

test('temporary legal language preserves System preference and restores its effective locale', async () => {
  await setLocalePreference('system', false);
  const systemLanguage = getLocale();
  let observedPreference = '';
  const unsubscribe = subscribeLocale(() => { observedPreference = getLocalePreference(); });
  try {
    await setTemporaryLocale('en-GB');
    assert.equal(getLocale(), 'en-GB');
    assert.equal(getLocalePreference(), 'system');
    assert.equal(observedPreference, 'system', 'Subscribers never see a replacement preference');
    await setLocalePreference(getLocalePreference(), false);
    assert.equal(getLocale(), systemLanguage);
  } finally {
    unsubscribe();
    await setLocalePreference('en-US', false);
  }
});

test('all direct-edit planning diagnostics have localized display reasons without changing processing text', () => {
  const source = readFileSync(new URL('../../services/pdfNativeTextPlanning.ts', import.meta.url), 'utf8');
  const reasons = [...source.matchAll(/reason: '([^']+)'/g)].map(match => match[1]);
  assert.equal(reasons.length, 7);
  for (const reason of reasons) {
    const error = nativeTextPlanningError(reason);
    assert.ok(error.translatedValues.v0, reason);
    assert.equal(error.message, `Direct text edit failed: ${reason}`);
    assert.equal(localizeError(error), error.message);
  }
});

test('allowance explanations retain successful jobs and save/share/export access', () => {
  for (const key of [
    'help-page.processing.is.unlimited.on.ios.the.first.90908e',
    'onboarding.on.ios.each.7.day.allowance.starts.c4855a',
    'pro-paywall.processing.stays.unlimited.each.7.day.allowance.cbf20f',
  ] as const) {
    const text = t(key);
    assert.match(text, /five successful jobs/);
    assert.match(text, /saved, shared, and exported/);
    assert.match(text, /processing and preview/i);
    assert.match(text, /until the allowance resets/);
  }
});

test('every supported catalog loads locally and is cached for synchronous lookups', async () => {
  for (const [locale] of locales) {
    const first = await loadCatalog(locale);
    assert.equal(await loadCatalog(locale), first, `${locale}: reuse loaded catalog`);
    assert.equal(Object.keys(first).length, Object.keys(await loadCatalog('en-US')).length, locale);
    if (!locale.startsWith('en-')) {
      assert.notEqual(first['settings.language'], (await loadCatalog('en-US'))['settings.language'], `${locale}: real localized catalog, not an English fallback copy`);
      const english = await loadCatalog('en-US');
      for (const [key, value] of Object.entries(english)) {
        // URLs are retained; full English UI sentences are not.
        if (typeof value !== 'string' || value.replace(/https?:\/\/\S+/g, '').length <= 35) continue;
        // Keys on the pending list are English on purpose until a translator takes them (plan 4).
        if (pendingTranslation.has(key as never)) continue;
        assert.notEqual(first[key as keyof typeof first], value, `${locale}:${key}: untranslated English sentence`);
      }
    }
  }
});

test('language changes preserve preference, switch direction, notify consumers and keep diagnostic errors stable', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const saved = new Map<string, string>();
  const root = { lang: '', dir: '' };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: (key: string, value: string) => saved.set(key, value) } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } });
  let notifications = 0;
  const unsubscribe = subscribeLocale(() => { notifications += 1; });
  try {
    const key = 'pdf-native-text-editor.the.local.pdf.text.engine.could.not.d6b23b';
    const error = new LocalizedError(key);
    const diagnostic = error.message;
    await setLocalePreference('ar-SA');
    assert.equal(getLocale(), 'ar-SA');
    assert.equal(getLocalePreference(), 'ar-SA');
    assert.deepEqual(root, { lang: 'ar-SA', dir: 'rtl' });
    assert.equal(saved.get('pdfchef.locale.v1'), 'ar-SA');
    assert.equal(error.message, diagnostic, 'Processing guards retain their original diagnostic');
    assert.equal(localizeError(error), t(key));
    assert.notEqual(localizeError(error), diagnostic);
    await setTemporaryLocale('en-US');
    assert.equal(root.dir, 'ltr');
    assert.equal(getLocalePreference(), 'ar-SA');
    assert.equal(saved.get('pdfchef.locale.v1'), 'ar-SA', 'Temporary authoritative-English legal view does not overwrite the choice');
    assert.equal(notifications, 2);
    unsubscribe();
    await setLocalePreference('en-GB', false);
    assert.equal(notifications, 2);
    await setLocalePreference('tr-TR', false);
    assert.equal(normalizeSearchText('İMZA'), 'imza', 'Turkish dotted I follows the selected locale');
  } finally {
    unsubscribe();
    await setLocalePreference('en-US', false);
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('partial paragraph saves keep written and blocked counts grammatically independent', async () => {
  const key = 'edit-pdf.edited.pdf.ready.with.of.edited.paragraphs.cab23a';
  const english = (await loadCatalog('en-US'))[key];
  const french = (await loadCatalog('fr-FR'))[key];
  for (const [written, planned, blocked] of [[0, 1, 1], [1, 2, 1], [1, 3, 2], [0, 2, 2]]) {
    const values = { v0: written, v1: planned, count: blocked, v2: '', v4: '' };
    const en = formatMessage(english, values, 'en-US');
    const fr = formatMessage(french, values, 'fr-FR');
    assert.ok(en.startsWith(`Edited PDF ready. Edited paragraphs written: ${written} of ${planned}.`));
    assert.ok(fr.startsWith(`PDF modifié prêt. Paragraphes modifiés écrits : ${written} sur ${planned}.`));
    assert.ok(fr.includes(blocked === 1 ? 'celui-ci' : 'ceux-ci'));
  }
});

test('batch summaries keep output counts independent of failure plural selection', async () => {
  const key = 'batch-pdf.created.with.outputs.and.failure.listed.in.44f091';
  const english = (await loadCatalog('en-US'))[key];
  const polish = (await loadCatalog('pl-PL'))[key];
  for (const [outputs, failures] of [[1, 2], [2, 1], [1, 1]]) {
    const values = { v0: 'results.zip', v1: outputs, count: failures };
    const en = formatMessage(english, values, 'en-US');
    const pl = formatMessage(polish, values, 'pl-PL');
    assert.ok(en.includes(`Outputs: ${outputs}.`));
    assert.ok(pl.includes(`Pliki wyjściowe: ${outputs}.`));
    assert.ok(en.includes(`${failures} ${failures === 1 ? 'failure listed' : 'failures listed'}`));
    assert.ok(pl.includes(failures === 1 ? '1 błąd wymieniony' : '2 błędy wymienione'));
    assert.ok(en.includes('results.zip') && pl.includes('results.zip'));
    assert.ok(en.includes('failures.txt') && pl.includes('failures.txt'));
  }
});

test('a pending key in a right-to-left locale is wrapped in left-to-right isolates; others are not', async () => {
  const pending = pendingTranslation as Set<string>;
  const key = 'settings.language';
  const original = getLocalePreference();
  try {
    pending.add(key);
    await setLocalePreference('ar-SA', false);
    const text = t(key);
    assert.equal(text, `\u2066${(await loadCatalog('ar-SA'))[key]}\u2069`);
    assert.equal(isPendingTranslation(key), true);
    assert.deepEqual(pendingTextProps(key), { lang: 'en', dir: 'ltr' });
    // A key that is not pending is left alone, and so is a plural message that is.
    assert.equal(t('settings.systemLanguage'), (await loadCatalog('ar-SA'))['settings.systemLanguage']);
    assert.equal(pendingTextProps('settings.systemLanguage'), undefined);
    pending.add('settings-page..24a420');
    assert.match(t('settings-page..24a420', { count: 2 }), /^\u2066.*\u2069$/);
    // Left-to-right locales never get isolates, even for a pending key.
    await setLocalePreference('de-DE', false);
    assert.equal(t(key).includes('\u2066'), false);
    assert.equal(isPendingTranslation(key), true, 'German is not English, so the key still counts as pending');
    assert.deepEqual(pendingTextProps(key), { lang: 'en', dir: 'ltr' });
    // English is never wrapped and never marked.
    await setLocalePreference('en-US', false);
    assert.equal(t(key), 'Language');
    assert.equal(isPendingTranslation(key), false);
    assert.equal(pendingTextProps(key), undefined);
  } finally {
    pending.delete(key);
    pending.delete('settings-page..24a420');
    await setLocalePreference(original, false);
  }
});

test('the pending list names real keys and every pending key carries the English text in every locale', async () => {
  const english = (await loadCatalog('en-US')) as Record<string, unknown>;
  for (const key of pendingTranslation) assert.ok(key in english, `${key} is not in en-US`);
  for (const [locale] of locales) {
    if (locale.startsWith('en-')) continue;
    const catalog = (await loadCatalog(locale)) as Record<string, unknown>;
    for (const key of pendingTranslation) {
      const message = catalog[key];
      assert.ok(message !== undefined, `${locale} lacks ${key}`);
      const source = english[key];
      if (typeof source === 'string') assert.equal(message, source, `${locale}:${key} is listed as pending but differs from English`);
      else for (const [category, text] of Object.entries(message as Record<string, string>)) {
        const fallback = category === 'one' ? ((source as Record<string, string>).one ?? (source as Record<string, string>).other) : (source as Record<string, string>).other;
        assert.equal(text, fallback, `${locale}:${key}:${category} is listed as pending but differs from English`);
      }
    }
  }
});
