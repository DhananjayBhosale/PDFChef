// English-first locale sync. For each locale catalog and draft it inserts the keys that en-US.ts has and
// the locale lacks, with the English text (every plural category the locale needs), and checks them
// against services/i18n/pending.ts. See scripts/sync-locale-fallbacks.mjs for the command.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

export const MARKER = '// English until translated (see services/i18n/pending.ts)';
const pluralOrder = ['zero', 'one', 'two', 'few', 'many', 'other'];

const unwrap = (node) => {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
};

const propertyName = (property) => {
  const name = property.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))) return name.text;
  throw new Error('Expected a string-keyed catalog entry');
};

/** The plain value of a static literal: a string, or an object of them. Comments are allowed. */
export function literalValue(node) {
  node = unwrap(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) throw new Error('Expected a static catalog entry');
      out[propertyName(property)] = literalValue(property.initializer);
    }
    return out;
  }
  throw new Error(`Expected a static catalog value, found ${ts.SyntaxKind[node.kind]}`);
}

/** The default-exported object literal of a catalog file, with its source file. */
export function parseCatalogFile(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let object;
  for (const statement of file.statements) if (ts.isExportAssignment(statement)) object = unwrap(statement.expression);
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`Expected a static catalog: ${path}`);
  return { file, object, catalog: literalValue(object) };
}

/** The string literals inside `new Set([...])` in pending.ts. */
export function parsePendingKeys(source, path = 'pending.ts') {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const keys = [];
  let found = false;
  const visit = (node) => {
    if (ts.isNewExpression(node) && node.expression.getText(file) === 'Set' && node.arguments?.[0]) {
      const array = unwrap(node.arguments[0]);
      if (ts.isArrayLiteralExpression(array)) {
        found = true;
        for (const element of array.elements) {
          if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) keys.push(element.text);
          else throw new Error(`${path}: every pending key must be a string literal`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`${path}: expected \`new Set([ ... ])\``);
  return keys;
}

/** The English text a locale shows for a key it has not translated. */
export function fallbackFor(english, locale) {
  if (typeof english === 'string') return english;
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  const out = {};
  for (const category of pluralOrder) {
    if (!categories.includes(category)) continue;
    out[category] = category === 'one' ? (english.one ?? english.other) : english.other;
  }
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const renderEntry = (key, value, indent) => {
  if (typeof value === 'string') return `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  const lines = Object.entries(value).map(([category, text]) => `${indent}  ${JSON.stringify(category)}: ${JSON.stringify(text)}`);
  return `${indent}${JSON.stringify(key)}: {\n${lines.join(',\n')}\n${indent}}`;
};

/** Appends entries to the object literal of a .ts catalog, under MARKER. */
function appendToCatalog(source, file, object, entries) {
  const close = object.end - 1; // the closing brace
  let before = source.slice(0, close).replace(/\s+$/, '');
  if (!before.endsWith(',') && !before.endsWith('{')) before += ',';
  const heading = source.includes(MARKER) ? '' : `\n\n  ${MARKER}`;
  const body = entries.map(([key, value]) => renderEntry(key, value, '  ')).join(',\n');
  return `${before}${heading}\n${body}\n${source.slice(close)}`;
}

/** Removes properties by key from a .ts catalog, keeping the rest of the file as written. */
function removeFromCatalog(source, file, object, keys) {
  const doomed = object.properties.filter(property => keys.has(property.name?.text));
  let result = source;
  for (const property of [...doomed].reverse()) {
    let start = property.getStart(file);
    start = result.lastIndexOf('\n', start - 1) + 1; // the start of its line
    let end = property.end;
    if (result[end] === ',') end += 1;
    if (result[end] === '\n') end += 1;
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

/**
 * Brings every locale catalog and draft in line with en-US.
 * Returns { changes, failures, pending }. Writes only when there are no failures and `check` is false.
 * With `mirrorDrafts`, each draft becomes a copy of its locale catalog (which is what drafts are for),
 * instead of being synced key by key; use it once to catch up drafts that have fallen behind.
 */
export async function syncLocaleFallbacks({ root, prune = false, check = false, mirrorDrafts = false }) {
  const failures = [];
  const changes = [];
  const english = parseCatalogFile(await readFile(resolve(root, 'services/i18n/en-US.ts'), 'utf8'), 'en-US').catalog;
  const englishKeys = Object.keys(english);
  const pendingKeys = parsePendingKeys(await readFile(resolve(root, 'services/i18n/pending.ts'), 'utf8'));
  const pending = new Set(pendingKeys);
  if (pending.size !== pendingKeys.length) failures.push('pending.ts: duplicate keys');
  for (const key of pending) if (!Object.hasOwn(english, key)) failures.push(`pending.ts: ${key} is not in en-US.ts`);

  const targets = [];
  for (const name of (await readdir(resolve(root, 'services/i18n/locales'))).filter(n => n.endsWith('.ts')).sort()) {
    targets.push({ kind: 'locale', locale: name.slice(0, -3), path: resolve(root, 'services/i18n/locales', name) });
  }
  let draftNames = [];
  try { draftNames = (await readdir(resolve(root, 'localization/drafts'))).filter(n => n.endsWith('.json')).sort(); } catch { /* no drafts folder */ }
  for (const name of draftNames) targets.push({ kind: 'draft', locale: name.slice(0, -5), path: resolve(root, 'localization/drafts', name) });

  const writes = [];
  const nextCatalogs = new Map();
  for (const target of targets) {
    const label = `${target.kind} ${target.locale}`;
    const source = await readFile(target.path, 'utf8');
    let catalog, file, object;
    if (target.kind === 'locale') ({ catalog, file, object } = parseCatalogFile(source, target.path));
    else catalog = JSON.parse(source);

    const missing = englishKeys.filter(key => !Object.hasOwn(catalog, key));
    const extra = Object.keys(catalog).filter(key => !Object.hasOwn(english, key));
    const mirroring = target.kind === 'draft' && mirrorDrafts;
    if (!mirroring) {
      const notPending = missing.filter(key => !pending.has(key));
      for (const key of notPending) failures.push(`${label}: ${key} is missing and not listed in pending.ts (translate it, or list it as pending)`);
      for (const key of pending) {
        if (!Object.hasOwn(catalog, key) || !Object.hasOwn(english, key)) continue;
        if (!same(catalog[key], fallbackFor(english[key], target.locale))) {
          failures.push(`${label}: ${key} is listed in pending.ts but has a translation; take it off the pending list`);
        }
      }
      if (extra.length && !prune) for (const key of extra) failures.push(`${label}: ${key} is not in en-US.ts (run with --prune)`);
    }

    const insert = missing.filter(key => pending.has(key)).map(key => [key, fallbackFor(english[key], target.locale)]);
    const drop = prune ? new Set(extra) : new Set();
    if (target.kind === 'locale') {
      const next = { ...catalog };
      for (const key of drop) delete next[key];
      for (const [key, value] of insert) next[key] = value;
      nextCatalogs.set(target.locale, next);
    }
    if (target.kind === 'draft' && mirrorDrafts) {
      const mirror = nextCatalogs.get(target.locale);
      if (!mirror) { failures.push(`${label}: no locale catalog to mirror`); continue; }
      const text = `${JSON.stringify(mirror, null, 2)}\n`;
      if (text !== source) {
        changes.push({ label, inserted: Object.keys(mirror).filter(key => !Object.hasOwn(catalog, key)), removed: Object.keys(catalog).filter(key => !Object.hasOwn(mirror, key)), mirrored: true });
        writes.push([target.path, text]);
      }
      continue;
    }
    if (!insert.length && !drop.size) continue;
    changes.push({ label, inserted: insert.map(([key]) => key), removed: [...drop] });
    if (target.kind === 'draft') {
      const next = { ...catalog };
      for (const key of drop) delete next[key];
      for (const [key, value] of insert) next[key] = value;
      writes.push([target.path, `${JSON.stringify(next, null, 2)}\n`]);
    } else {
      let next = source;
      if (drop.size) {
        next = removeFromCatalog(next, file, object, drop);
        ({ file, object } = parseCatalogFile(next, target.path));
      }
      if (insert.length) next = appendToCatalog(next, file, object, insert);
      writes.push([target.path, next]);
    }
  }
  if (!failures.length && !check) for (const [path, text] of writes) await writeFile(path, text);
  return { changes, failures, pending: pending.size, wrote: !failures.length && !check ? writes.length : 0 };
}
