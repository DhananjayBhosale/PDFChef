import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];
const draftMode = process.argv.includes('--drafts');
const source = await readFile(resolve(root, 'services/i18n/en-US.ts'), 'utf8');
const parseCatalog = (source, path) => {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const seen = new Set();
  let object;
  for (const statement of file.statements) if (ts.isExportAssignment(statement)) {
    object = statement.expression;
    while (ts.isAsExpression(object) || ts.isSatisfiesExpression(object)) object = object.expression;
  }
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`Expected a static catalog: ${path}`);
  for (const property of object.properties) {
    const key = property.name?.text;
    if (seen.has(key)) failures.push(`${path}: duplicate ${key}`);
    seen.add(key);
  }
  return JSON.parse(source.slice(object.getStart(file), object.end));
};
const english = parseCatalog(source, 'en-US');
const keys = Object.keys(english);
const vars = (message) => [...new Set([...message.matchAll(/\{([a-zA-Z]\w*)\}/g)].map(match => match[1]))].sort().join(',');
const checkProtectedText = (from, to, label) => {
  for (const name of ['PDF Chef', 'Aadhaar', 'GST', 'Google Play', 'App Store', 'Android', 'iOS', 'Apple', 'Cloudflare', 'Dhananjay Tech']) {
    if (from.includes(name) && !to.includes(name)) failures.push(`${label}: missing proper name ${name}`);
  }
  if (['Inter', 'Manrope', 'Noto Sans'].includes(from) && to !== from) failures.push(`${label}: font name changed`);
  for (const url of from.match(/https?:\/\/[^\s<>]+/g) || []) {
    if (!to.includes(url)) failures.push(`${label}: URL changed: ${url}`);
  }
  for (const address of from.match(/(?:[\w.+-]+@)?[a-z0-9][a-z0-9.-]+\.(?:app|com|org|net)\b/g) || []) {
    if (!to.includes(address)) failures.push(`${label}: address changed: ${address}`);
  }
};
const isMessageObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validateCatalog = ({ catalog, locale, label, reports, draft = false }) => {
  const missing = keys.filter(key => !Object.hasOwn(catalog, key));
  const extra = Object.keys(catalog).filter(key => !Object.hasOwn(english, key));
  if (draft && missing.length) failures.push(`${label}: incomplete draft with ${missing.length} missing keys; drafts are not runnable catalogs`);
  else for (const key of missing) failures.push(`${label}: missing ${key}`);
  for (const key of extra) failures.push(`${label}: extra ${key}`);
  let pluralCategories;
  try { pluralCategories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories; }
  catch { failures.push(`${label}: invalid locale for plural validation`); pluralCategories = ['other']; }
  for (const key of keys.filter(key => Object.hasOwn(catalog, key))) {
    const from = english[key], to = catalog[key];
    if (typeof from === 'string') {
      if (typeof to !== 'string') { failures.push(`${label}:${key}: changed message type`); continue; }
      if (!to.trim()) failures.push(`${label}:${key}: empty message`);
      if (vars(from) !== vars(to)) failures.push(`${label}:${key}: variables differ`);
      checkProtectedText(from, to, `${label}:${key}`);
      continue;
    }
    if (!isMessageObject(to)) { failures.push(`${label}:${key}: changed message type`); continue; }
    for (const rule of pluralCategories) {
      if (!Object.hasOwn(to, rule)) { failures.push(`${label}:${key}: missing plural ${rule}`); continue; }
      const text = to[rule];
      if (typeof text !== 'string') { failures.push(`${label}:${key}:${rule}: changed plural message type`); continue; }
      if (!text.trim()) failures.push(`${label}:${key}:${rule}: empty plural message`);
      if (vars(text) !== vars(from[rule] ?? from.other)) failures.push(`${label}:${key}:${rule}: variables differ`);
      checkProtectedText(from[rule] ?? from.other, text, `${label}:${key}:${rule}`);
    }
    for (const rule of Object.keys(to)) if (!pluralCategories.includes(rule)) {
      failures.push(`${label}:${key}: unknown plural ${rule}`);
    }
  }
  reports.push({
    locale,
    keys: Object.keys(catalog).length,
    missing: missing.length,
    extra: extra.length,
    ...(draft ? { draftOnly: true, runtimeCatalog: false, missingKeys: missing } : {}),
    ...(draft && missing.length ? { incomplete: true } : {}),
  });
};
const parseDraftCatalog = (contents, path) => {
  const file = ts.parseJsonText(path, contents);
  for (const diagnostic of file.parseDiagnostics) {
    failures.push(`${path}: invalid JSON: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
  const object = file.statements[0]?.expression;
  if (!object || !ts.isObjectLiteralExpression(object)) {
    failures.push(`${path}: expected a JSON object catalog`);
    return null;
  }
  const checkObject = (node, prefix = '') => {
    const seen = new Set();
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !property.name) {
        failures.push(`${path}: expected a string-keyed catalog entry`);
        continue;
      }
      const key = property.name.text;
      const qualified = prefix ? `${prefix}.${key}` : key;
      if (seen.has(key)) failures.push(`${path}: duplicate ${qualified}`);
      seen.add(key);
      if (ts.isObjectLiteralExpression(property.initializer)) checkObject(property.initializer, qualified);
    }
  };
  checkObject(object);
  if (file.parseDiagnostics.length) return null;
  try { return JSON.parse(contents); }
  catch (error) {
    failures.push(`${path}: invalid JSON: ${error instanceof Error ? error.message : 'parse failure'}`);
    return null;
  }
};
const used = new Set();
if (!draftMode) {
  const englishCatalog = resolve(root, 'services/i18n/en-US.ts');
  const generatedCatalogs = resolve(root, 'services/i18n/locales');

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (path === englishCatalog || path === generatedCatalogs) continue;
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const code = await readFile(path, 'utf8');
        for (const key of keys) if (code.includes(JSON.stringify(key)) || code.includes(`'${key}'`)) used.add(key);
        if (/\/(components|hooks)\//.test(path)) auditVisibleCopy(path, code);
      }
    }
  }
  for (const directory of ['components', 'hooks', 'services']) await walk(resolve(root, directory));
  const app = await readFile(resolve(root, 'App.tsx'), 'utf8');
  for (const key of keys) if (app.includes(JSON.stringify(key))) used.add(key);
  // Closed unions used by contextual UI messages. Unrelated keys sharing a prefix are still unused.
  const dynamicKeys = /^(?:category\.(?:All|Create|Edit|Optimize|Convert|Secure)|business\.(?:invoice|receipt|quote)\.(?:title|reference|issued|settled|recipient|total|drawing|cannotDraw|preview|ready|cannotSave|maker|save)|editor\.(?:text|image|rectangle|ellipse|line|arrow)\.(?:add|place|properties|selected|aria|selectedAria)|font\.class\.(?:sans-serif|serif|monospace)|theme\.switch\.(?:light|dark))$/;
  for (const key of keys) if (dynamicKeys.test(key)) used.add(key);
}
const unused = draftMode ? [] : keys.filter(key => !used.has(key));
for (const key of unused) failures.push(`Unused key: ${key}`);
const localeDefinition = await readFile(resolve(root, 'services/i18n/locales.ts'), 'utf8');
const expectedLocales = [...localeDefinition.matchAll(/^\s*\['([A-Za-z0-9-]+)'/gm)].map(match => match[1]);
if (draftMode) {
  const draftFiles = await readdir(resolve(root, 'localization/drafts'));
  const draftLocaleFiles = new Set(draftFiles.filter(filename => filename.endsWith('.json')));
  const draftReports = [];
  for (const filename of draftFiles) {
    if (!filename.endsWith('.json')) {
      failures.push(`Draft file is not JSON: ${filename}`);
      continue;
    }
    const locale = filename.slice(0, -5);
    const label = `draft ${locale}`;
    if (!expectedLocales.includes(locale)) failures.push(`${label}: unknown locale`);
    const path = resolve(root, 'localization/drafts', filename);
    const catalog = parseDraftCatalog(await readFile(path, 'utf8'), `localization/drafts/${filename}`);
    if (catalog) validateCatalog({ catalog, locale, label, reports: draftReports, draft: true });
    else draftReports.push({
      locale,
      keys: 0,
      missing: keys.length,
      extra: 0,
      draftOnly: true,
      runtimeCatalog: false,
      invalid: true,
      incomplete: true,
      missingKeys: keys,
    });
  }
  for (const locale of expectedLocales) {
    if (locale.startsWith('en-') || draftLocaleFiles.has(`${locale}.json`)) continue;
    failures.push(`Missing draft catalog: ${locale}`);
    draftReports.push({
      locale,
      keys: 0,
      missing: keys.length,
      extra: 0,
      draftOnly: true,
      runtimeCatalog: false,
      catalogAbsent: true,
      incomplete: true,
      missingKeys: keys,
    });
  }
  console.log(JSON.stringify({ mode: 'drafts', keys: keys.length, draftReports, unused, failures }, null, 2));
} else {
  const localeFiles = await readdir(resolve(root, 'services/i18n/locales'));
  const reports = [];
  for (const filename of localeFiles.filter(name => name.endsWith('.ts'))) {
    const locale = filename.slice(0, -3);
    const catalog = parseCatalog(await readFile(resolve(root, 'services/i18n/locales', filename), 'utf8'), locale);
    validateCatalog({ catalog, locale, label: locale, reports });
  }
  for (const locale of expectedLocales) {
    if (locale.startsWith('en-')) { reports.push({ locale, keys: keys.length, missing: 0, extra: 0, inherits: locale === 'en-US' ? null : 'en-US' }); continue; }
    if (!localeFiles.includes(`${locale}.ts`)) {
      failures.push(`Missing locale catalog: ${locale}`);
      reports.push({ locale, keys: 0, missing: keys.length, extra: 0, catalogAbsent: true });
    }
  }
  console.log(JSON.stringify({ keys: keys.length, localeReports: reports, unused, failures }, null, 2));
}
if (failures.length) process.exitCode = 1;

/** Catch visible literals, not CSS, processing identifiers, or the contents of a user's PDF. */
function auditVisibleCopy(path, code) {
  const tree = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const labels = /^(?:title|alt|placeholder|aria-label|label|description|hint)$/;
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'style'
      && /\bformat(?:Percent|Number|Date|Currency)\s*\(/.test(node.initializer?.getText(tree) ?? '')) {
      failures.push(`${path}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: localized formatting in CSS geometry`);
    }
    let text;
    if (ts.isJsxText(node)) text = node.text.trim();
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      if (ts.isJsxAttribute(parent) && labels.test(parent.name.getText(tree))) text = node.text;
      else if (ts.isJsxExpression(parent) && (!ts.isJsxAttribute(parent.parent) || labels.test(parent.parent.name.getText(tree)))) text = node.text;
      else if (ts.isPropertyAssignment(parent) && parent.initializer === node && /^(?:label|title|hint|description|ariaLabel|emptyMessage|message|error)$/.test(parent.name.getText(tree))) text = node.text;
    }
    // The brand and documented literal PDF formatting tokens are deliberately not translated.
    if (text && /[A-Za-z]/.test(text) && !['PDF Chef', '{n}', '{total}'].includes(text)) {
      failures.push(`${path}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: hardcoded visible text: ${text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
