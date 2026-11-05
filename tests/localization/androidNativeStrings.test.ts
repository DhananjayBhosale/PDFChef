import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const res = resolve(dirname(fileURLToPath(import.meta.url)), '../../android/app/src/main/res');

/** The app's languages besides English, as Android resource qualifiers name them. */
const folders = ['ar', 'b+es+419', 'b+zh+Hans', 'b+zh+Hant', 'da', 'de', 'es', 'fr', 'fr-rCA', 'hi', 'in', 'it', 'ja', 'ko', 'nl', 'pl', 'pt-rBR', 'pt-rPT', 'ru', 'sv', 'tr'];
const files = ['pdf_reader_strings.xml', 'strings.xml'];

const strings = (folder: string) => {
  const found = new Map<string, string>();
  for (const file of files) {
    for (const match of readFileSync(resolve(res, folder, file), 'utf8').matchAll(/<string name="([^"]+)"([^>]*)>([\s\S]*?)<\/string>/g)) {
      if (!match[2].includes('translatable="false"')) found.set(match[1], match[3]);
    }
  }
  return found;
};
const formats = (text: string) => (text.match(/%\d+\$[ds]/g) ?? []).sort();

test('every native Android text is translated, with the same format arguments, in all 21 app languages', () => {
  const english = strings('values');
  assert.ok(english.size > 80, `only ${english.size} translatable texts were found`);
  for (const folder of folders) {
    const translated = strings(`values-${folder}`);
    assert.deepEqual([...translated.keys()].sort(), [...english.keys()].sort(), `values-${folder} has different texts`);
    for (const [name, text] of english) {
      const value = translated.get(name)!;
      assert.ok(value.trim(), `values-${folder} is empty for ${name}`);
      assert.deepEqual(formats(value), formats(text), `values-${folder} format arguments differ for ${name}`);
      // An unescaped apostrophe or quote breaks AAPT2 or silently drops the character.
      assert.doesNotMatch(value, /(^|[^\\])['"]/, `values-${folder} has an unescaped quote in ${name}`);
    }
  }
});

test('Android Settings lists every app language for PDF Chef', () => {
  const config = readFileSync(resolve(res, 'xml/locales_config.xml'), 'utf8');
  const listed = [...config.matchAll(/<locale android:name="([^"]+)"/g)].map(match => match[1]);
  // One per non-English language folder, plus English.
  assert.equal(listed.length, folders.length + 1);
  assert.ok(listed.includes('en-US') && listed.includes('ru') && listed.includes('zh-Hant'));
  const manifest = readFileSync(resolve(res, '../AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android:localeConfig="@xml\/locales_config"/);
});
