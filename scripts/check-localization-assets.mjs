import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const mapping = await json('localization/locale-mapping.json');
const source = await json('localization/stores/en-US.source.json');
const nativeSource = await json('localization/native-handoff/en-US.source.json');
const limits = await json('localization/stores/limits.json');
const variables = text => [...new Set(text.match(/\{[a-zA-Z]\w*\}|%\d+\$[ds]/g) || [])].sort();
const flatten = (object, prefix = '') => Object.fromEntries(Object.entries(object).flatMap(([key, value]) => {
  const path = prefix ? `${prefix}.${key}` : key;
  if (Array.isArray(value)) return value.map((text, index) => [`${path}.${index + 1}`, text]);
  return typeof value === 'object' ? Object.entries(flatten(value, path)) : [[path, value]];
}));
const storeReports = [], reports = [], failures = [];
const locales = Array.isArray(mapping) ? mapping : mapping.locales;
for (const locale of locales) {
  const id = locale.app;
  try {
    const pack = await json(`localization/stores/${id}.json`);
    assert.equal(pack.appleLocale, locale.apple);
    assert.equal(pack.googleLocale, locale.google);
    const fields = flatten({ apple: pack.apple, google: pack.google });
    assert.deepEqual(Object.keys(fields).sort(), Object.keys(source).sort(), `${id}: store field coverage`);
    for (const [key, text] of Object.entries(fields)) {
      assert.equal(typeof text, 'string', key);
      assert(text.trim(), key);
      assert.deepEqual(variables(text), variables(source[key]), `${id}:${key} placeholders`);
      const count = [...text].length;
      const limit = limits.limits[key] ?? (key.includes('.screenshot.') ? limits.projectCaptionLimit : undefined);
      if (limit) assert(count <= limit, `${id}:${key} ${count}/${limit} characters`);
      if (key.endsWith('.name') || key === 'apple.name') assert(count >= 2, key);
      if (key.endsWith('.name') && !key.includes('.monthly.') && !key.includes('.lifetime.')) assert.equal(text, 'PDF Chef', 'Brand is never translated');
    }
    assert([...fields['apple.keywords']].length <= limits.appleKeywords.characters);
    assert(Buffer.byteLength(fields['apple.keywords'], 'utf8') <= limits.appleKeywords.utf8Bytes, `${id}: Apple keyword bytes`);
    storeReports.push({ locale: id, fields: Object.keys(fields).length, missing: 0, limitFailures: 0 });
    const native = await json(`localization/native-handoff/${id}.json`);
    assert.deepEqual(Object.keys(native).sort(), Object.keys(nativeSource).sort(), `${id}: native handoff coverage`);
    for (const [key, text] of Object.entries(native)) {
      assert.equal(typeof text, 'string', key);
      assert(text.trim(), key);
      assert.deepEqual(variables(text), variables(nativeSource[key]), `${id}:${key} native formatting tokens`);
    }
    reports.push({ locale: id, storeFields: Object.keys(fields).length, nativeFields: Object.keys(native).length, missing: 0, limitFailures: 0 });
  } catch (error) { failures.push({ locale: id, error: error.message }); }
}
console.log(JSON.stringify({ storeReports, reports, failures }, null, 2));
if (failures.length) process.exitCode = 1;
