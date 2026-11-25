import assert from 'node:assert/strict';
import test from 'node:test';
import { formatNumber, isPendingTranslation, setTemporaryLocale, t } from '../../services/i18n/core.ts';
import { pendingTranslation } from '../../services/i18n/pending.ts';
import { clip, degrees, pagesPhrase, percent, points, quoted, spanPhrase, times, type PageKeys } from '../../components/Tool/values.ts';

const keys: PageKeys = {
  all: 'sentence.split.pages.all',
  single: 'sentence.split.pages.single',
  range: 'sentence.split.pages.range',
  list: 'sentence.split.pages.list',
  selected: 'sentence.split.pages.selected',
};

test('page phrases cover every case in plan 2.1 and never say "N of M pages" (D6)', () => {
  assert.deepEqual(pagesPhrase(keys, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 12), { text: 'all 12 pages', ltr: false, none: false });
  assert.deepEqual(pagesPhrase(keys, [0], 1), { text: 'the only page', ltr: false, none: false });
  assert.deepEqual(pagesPhrase(keys, [3], 12), { text: 'page 4', ltr: false, none: false });
  assert.deepEqual(pagesPhrase(keys, [1, 2, 3, 4], 12), { text: 'pages 2–5', ltr: true, none: false });
  assert.deepEqual(pagesPhrase(keys, [2, 0], 12), { text: 'pages 1 and 3', ltr: true, none: false });
  assert.deepEqual(pagesPhrase(keys, [0, 2, 4], 12), { text: 'pages 1, 3, and 5', ltr: true, none: false });
  assert.deepEqual(pagesPhrase(keys, [0, 2, 4, 6, 8], 12), { text: 'the 5 selected pages', ltr: false, none: false });
  assert.equal(pagesPhrase(keys, [], 12).none, true);
  assert.equal(pagesPhrase(keys, [4, 4, 99, -1], 12).text, 'page 5', 'duplicates and out-of-range pages are ignored');
  for (const selection of [[0], [0, 1], [0, 2], [0, 2, 4, 6]]) {
    assert.doesNotMatch(pagesPhrase(keys, selection, 12).text, / of /);
  }
});

test('without list or selected keys, a broken selection falls back to its span', () => {
  const runOnly: PageKeys = { all: keys.all, single: keys.single, range: keys.range };
  assert.equal(pagesPhrase(runOnly, [0, 2, 4, 6], 12).text, 'pages 1–7');
  assert.equal(spanPhrase(runOnly, 3, 6, 12).text, 'pages 3–6');
  assert.equal(spanPhrase(runOnly, 1, 12, 12).text, 'all 12 pages');
});

test('a sentence value still in English uses English digits, like its sentence (decision 2026-11-13)', async () => {
  // Every key is translated now, so the test marks the page phrase and the value message as
  // pending for its own length: a value inside an English-only sentence keeps English digits.
  const pending = pendingTranslation as Set<string>;
  const marked = [keys.range, 'sentence.value.points', 'sentence.value.times'].filter((key) => !pending.has(key));
  for (const key of marked) pending.add(key);
  await setTemporaryLocale('ar-SA');
  try {
    assert.equal(isPendingTranslation(keys.range), true);
    assert.doesNotMatch(pagesPhrase(keys, [1, 2, 3], 12).text, /[٠-٩]/);
    assert.doesNotMatch(points(10.5, 1), /[٠-٩٫]/);
    assert.match(points(10.5, 1), /10\.5/);
    assert.doesNotMatch(times(1.5), /[٠-٩٫]/);
    assert.doesNotMatch(percent(52), /[٠-٩٪]/);
    assert.doesNotMatch(degrees(45), /[٠-٩]/);
    // A translated message keeps the locale's digits.
    assert.match(formatNumber(12), /[٠-٩]/);
  } finally {
    for (const key of marked) pending.delete(key);
    await setTemporaryLocale('en-US');
  }
});

test('clip cuts on grapheme boundaries and adds an ellipsis', () => {
  assert.equal(clip('Quarterly report', 9), 'Quarterly…');
  assert.equal(clip('short', 9), 'short');
  assert.equal(clip('👩‍👩‍👧‍👦👩‍👩‍👧‍👦👩‍👩‍👧‍👦', 2), '👩‍👩‍👧‍👦👩‍👩‍👧‍👦…');
  assert.equal(clip('ab   cd', 3), 'ab…', 'trailing space before the ellipsis is dropped');
});

test('quoted wraps user text in the locale’s quotes, clipped when asked', () => {
  assert.equal(quoted('Draft'), t('sentence.quoted', { text: 'Draft' }));
  assert.equal(quoted('Draft'), '“Draft”');
  assert.equal(quoted('Confidential copy', 4), '“Conf…”');
});
