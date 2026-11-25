import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MARKER, fallbackFor, parseCatalogFile, parsePendingKeys, syncLocaleFallbacks } from '../../scripts/lib/locale-fallbacks.mjs';

const catalogSource = (body: string) => `import type { Catalog } from '../core';\n\nexport default {\n${body}\n} satisfies Catalog;\n`;
const english = `export default {
  "a.label": "Label",
  "b.files": {
    "one": "{count} file",
    "other": "{count} files"
  },
  "c.keep": "Keep"
} as const;
`;

async function fixture({ pending = ['a.label', 'b.files'], ru = '', ar = '', draft = '{}' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdfchef-sync-'));
  await mkdir(join(root, 'services/i18n/locales'), { recursive: true });
  await mkdir(join(root, 'localization/drafts'), { recursive: true });
  await writeFile(join(root, 'services/i18n/en-US.ts'), english);
  await writeFile(join(root, 'services/i18n/pending.ts'), `export const pendingTranslation = new Set<string>([\n${pending.map(key => `  '${key}',`).join('\n')}\n]);\n`);
  await writeFile(join(root, 'services/i18n/locales/ru-RU.ts'), catalogSource(`  "c.keep": "Оставить"${ru}`));
  await writeFile(join(root, 'services/i18n/locales/ar-SA.ts'), catalogSource(`  "c.keep": "احتفظ"${ar}`));
  await writeFile(join(root, 'localization/drafts/ru-RU.json'), draft === '{}' ? `${JSON.stringify({ 'c.keep': 'Оставить' }, null, 2)}\n` : draft);
  return root;
}
const catalogOf = async (root: string, locale: string) => parseCatalogFile(await readFile(join(root, `services/i18n/locales/${locale}.ts`), 'utf8'), locale).catalog;

test('fallbackFor gives every plural category the locale needs, English one for one and other for the rest', () => {
  const message = { one: '{count} file', other: '{count} files' };
  assert.deepEqual(fallbackFor(message, 'de-DE'), { one: '{count} file', other: '{count} files' });
  assert.deepEqual(Object.keys(fallbackFor(message, 'ru-RU')), ['one', 'few', 'many', 'other']);
  assert.deepEqual(fallbackFor(message, 'ru-RU'), { one: '{count} file', few: '{count} files', many: '{count} files', other: '{count} files' });
  assert.deepEqual(Object.keys(fallbackFor(message, 'ar-SA')), ['zero', 'one', 'two', 'few', 'many', 'other']);
  assert.deepEqual(fallbackFor(message, 'ja-JP'), { other: '{count} files' });
  assert.equal(fallbackFor('Plain', 'ru-RU'), 'Plain');
});

test('pending.ts keys are read as string literals', () => {
  assert.deepEqual(parsePendingKeys(`export const p = new Set<string>(['a', "b"]);`), ['a', 'b']);
  assert.deepEqual(parsePendingKeys(`export const p: ReadonlySet<string> = new Set<string>([\n]);`), []);
  assert.throws(() => parsePendingKeys(`const k = 'a'; export const p = new Set([k]);`), /string literal/);
});

test('missing pending keys are added to locales and drafts with the English text', async () => {
  const root = await fixture();
  try {
    const result = await syncLocaleFallbacks({ root });
    assert.deepEqual(result.failures, []);
    const ru = await catalogOf(root, 'ru-RU');
    assert.equal(ru['a.label'], 'Label');
    assert.deepEqual(ru['b.files'], { one: '{count} file', few: '{count} files', many: '{count} files', other: '{count} files' });
    assert.equal(ru['c.keep'], 'Оставить', 'translated keys are untouched');
    const ar = await catalogOf(root, 'ar-SA');
    assert.deepEqual(Object.keys(ar['b.files']), ['zero', 'one', 'two', 'few', 'many', 'other']);
    const source = await readFile(join(root, 'services/i18n/locales/ru-RU.ts'), 'utf8');
    assert.equal(source.split(MARKER).length, 2, 'the marker is written once');
    assert.match(source, /\} satisfies Catalog;\n$/);
    const draft = JSON.parse(await readFile(join(root, 'localization/drafts/ru-RU.json'), 'utf8'));
    assert.deepEqual(Object.keys(draft), ['c.keep', 'a.label', 'b.files']);
    // A second run changes nothing.
    const again = await syncLocaleFallbacks({ root, check: true });
    assert.deepEqual(again.changes, []);
    assert.deepEqual(again.failures, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing key that is not listed as pending fails and nothing is written', async () => {
  const root = await fixture({ pending: ['a.label'] });
  try {
    const before = await readFile(join(root, 'services/i18n/locales/ru-RU.ts'), 'utf8');
    const result = await syncLocaleFallbacks({ root });
    assert.ok(result.failures.some(line => line.includes('b.files') && line.includes('not listed in pending.ts')));
    assert.equal(result.wrote, 0);
    assert.equal(await readFile(join(root, 'services/i18n/locales/ru-RU.ts'), 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a pending key that has been translated fails until it comes off the list', async () => {
  const root = await fixture({ ru: ',\n  "a.label": "Метка"' });
  try {
    const result = await syncLocaleFallbacks({ root });
    assert.ok(result.failures.some(line => line.includes('ru-RU') && line.includes('a.label') && line.includes('take it off the pending list')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('--prune removes keys English no longer has, plural messages included, and keeps the file valid', async () => {
  const root = await fixture({
    pending: [],
    ru: ',\n  "a.label": "Метка",\n  "b.files": {\n    "one": "x",\n    "few": "x",\n    "many": "x",\n    "other": "x"\n  },\n  "z.old": "Старое",\n  "z.older": {\n    "one": "a",\n    "other": "b"\n  }',
    ar: ',\n  "a.label": "x",\n  "b.files": { "zero": "x", "one": "x", "two": "x", "few": "x", "many": "x", "other": "x" }',
    draft: `${JSON.stringify({ 'c.keep': 'Оставить', 'a.label': 'Метка', 'b.files': { one: 'x', few: 'x', many: 'x', other: 'x' }, 'z.old': 'x' }, null, 2)}\n`,
  });
  try {
    const without = await syncLocaleFallbacks({ root, check: true });
    assert.ok(without.failures.some(line => line.includes('z.old') && line.includes('--prune')));
    const result = await syncLocaleFallbacks({ root, prune: true });
    assert.deepEqual(result.failures, []);
    const ru = await catalogOf(root, 'ru-RU');
    assert.deepEqual(Object.keys(ru), ['c.keep', 'a.label', 'b.files']);
    const draft = JSON.parse(await readFile(join(root, 'localization/drafts/ru-RU.json'), 'utf8'));
    assert.ok(!('z.old' in draft));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('--mirror-drafts makes each draft a copy of its locale catalog', async () => {
  const root = await fixture({
    ru: ',\n  "a.label": "Метка",\n  "b.files": { "one": "x", "few": "x", "many": "x", "other": "x" }',
    ar: ',\n  "a.label": "x",\n  "b.files": { "zero": "x", "one": "x", "two": "x", "few": "x", "many": "x", "other": "x" }',
    pending: [],
    draft: `${JSON.stringify({ stale: 'x' }, null, 2)}\n`,
  });
  try {
    const result = await syncLocaleFallbacks({ root, mirrorDrafts: true });
    assert.deepEqual(result.failures.filter(line => line.includes('draft')), []);
    const draft = JSON.parse(await readFile(join(root, 'localization/drafts/ru-RU.json'), 'utf8'));
    assert.deepEqual(draft, await catalogOf(root, 'ru-RU'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
