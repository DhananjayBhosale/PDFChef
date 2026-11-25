import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

// Each tool's last settings are kept on this device (path to 9, item 5). The store decides once
// what may be kept: never a password, only plain values, and nothing a document could fill.
const memory = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  },
};
const { TOOL_SETTINGS_KEY, forgetToolSettings, mayRemember, readToolSetting, writeToolSetting } = await import('../../services/toolSettings.ts');

test('a kept setting comes back for its own tool only', () => {
  memory.clear();
  writeToolSetting('/watermark', 'opacity', 30);
  writeToolSetting('/watermark', 'text', 'DRAFT');
  assert.equal(readToolSetting('/watermark', 'opacity', 50), 30);
  assert.equal(readToolSetting('/watermark', 'text', 'CONFIDENTIAL'), 'DRAFT');
  assert.equal(readToolSetting('/page-numbers', 'opacity', 50), 50);
});

test('a password, passcode, PIN or secret is never kept', () => {
  memory.clear();
  for (const name of ['password', 'userPassword', 'ownerPassword', 'passcode', 'passphrase', 'pin', 'secret', 'clientSecret']) {
    assert.equal(mayRemember(name), false, name);
    writeToolSetting('/protect', name, 'hunter2');
    assert.equal(readToolSetting('/protect', name, ''), '', name);
  }
  assert.equal(memory.get(TOOL_SETTINGS_KEY), undefined, 'nothing was written');
  // Names that only look alike are fine.
  assert.equal(mayRemember('pinned'), true);
  assert.equal(mayRemember('spinCount'), true);
});

test('only plain values are kept, so a document cannot end up in the store', () => {
  memory.clear();
  writeToolSetting('/split', 'pages', [1, 2, 3]);
  writeToolSetting('/split', 'field', { x: 1, y: 2 });
  writeToolSetting('/split', 'size', Number.NaN);
  writeToolSetting('/split', 'size', Number.POSITIVE_INFINITY);
  writeToolSetting('/split', 'text', 'x'.repeat(2049));
  assert.equal(memory.get(TOOL_SETTINGS_KEY), undefined);
  writeToolSetting('/split', 'text', 'x'.repeat(2048));
  assert.equal(readToolSetting('/split', 'text', '').length, 2048);
});

test('a kept value of another kind, or a broken store, gives the default', () => {
  memory.clear();
  writeToolSetting('/compress', 'quality', 'high');
  assert.equal(readToolSetting('/compress', 'quality', 32), 32);
  memory.set(TOOL_SETTINGS_KEY, '{not json');
  assert.equal(readToolSetting('/compress', 'quality', 32), 32);
  memory.set(TOOL_SETTINGS_KEY, '[1,2]');
  assert.equal(readToolSetting('/compress', 'quality', 32), 32);
});

test('Settings → Reset forgets every tool', () => {
  memory.clear();
  writeToolSetting('/watermark', 'size', 72);
  forgetToolSettings();
  assert.equal(readToolSetting('/watermark', 'size', 50), 50);
  const settings = readFileSync(new URL('../../components/Pages/SettingsPage.tsx', import.meta.url), 'utf8');
  assert.match(settings, /forgetToolSettings\(\)/);
});

test('no tool keeps a password or anything tied to one file', () => {
  const dir = new URL('../../components/Tools/', import.meta.url);
  const kept: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.tsx'))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const match of source.matchAll(/useRemembered(?:<[^>]+>)?\('([^']+)'/g)) kept.push(`${file}:${match[1]}`);
    if (/useRememberedFields/.test(source)) kept.push(`${file}:fields`);
  }
  assert.ok(kept.length >= 10, kept.join(', '));
  const forbidden = /pass|pin\b|secret|range|pageList|selected|position|field(?!s$)|crop|margin/i;
  assert.deepEqual(kept.filter((entry) => forbidden.test(entry.split(':')[1])), []);
  // The tools that hold passwords or file-bound values keep none of them.
  for (const file of ['SecurityPDF.tsx', 'UnlockPDF.tsx', 'DeletePages.tsx', 'ExtractPages.tsx', 'MakeFillable.tsx']) {
    assert.ok(!kept.some((entry) => entry.startsWith(`${file}:`)), file);
  }
});
