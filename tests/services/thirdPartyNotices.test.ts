import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { licenseIds, renderThirdPartyNotices } from '../../scripts/generate-third-party-notices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

interface Component { name: string; version: string; kind: 'js' | 'asset' | 'android'; license: string; copyright: string; url: string }
const components: Component[] = JSON.parse(read('services/legal/thirdPartyComponents.json'));
const texts: { licenses: Record<string, { name: string; text: string }>; notices: Array<{ component: string; title: string; text: string }> } =
  JSON.parse(read('services/legal/licenseTexts.json'));

const packageJson = JSON.parse(read('package.json'));
const lock: { packages: Record<string, { version: string; dev?: boolean }> } = JSON.parse(read('package-lock.json'));
const listed = (kind: Component['kind']) => new Map(components.filter((item) => item.kind === kind).map((item) => [`${item.name}@${item.version}`, item]));

/**
 * Not shipped in the app: type-only packages, and the Node.js-only native canvas binaries that
 * pdfjs-dist declares as optional.
 */
const notShipped = (path: string) => /^@types\/|^@napi-rs\/canvas/.test(path);

test('every production dependency in package.json is in the notices, at the locked version', () => {
  const js = listed('js');
  for (const name of Object.keys(packageJson.dependencies)) {
    const locked = lock.packages[`node_modules/${name}`]?.version;
    assert.ok(locked, `${name} is not in package-lock.json`);
    assert.ok(js.has(`${name}@${locked}`), `${name}@${locked} is missing from services/legal/thirdPartyComponents.json`);
  }
});

test('every production package in the lockfile, nested copies included, is in the notices', () => {
  const js = listed('js');
  const missing = Object.entries(lock.packages)
    .filter(([path, entry]) => path && !entry.dev && !notShipped(path.replace(/^.*node_modules\//, '')))
    .map(([path, entry]) => `${path.replace(/^.*node_modules\//, '')}@${entry.version}`)
    .filter((key) => !js.has(key));
  assert.deepEqual(missing, [], 'run npm ls --omit=dev --all and add these to services/legal/thirdPartyComponents.json');
});

test('every direct Android dependency in app/build.gradle is in the notices at the same version', () => {
  const variables = Object.fromEntries([...read('android/variables.gradle').matchAll(/(\w+)\s*=\s*'([^']+)'/g)].map((match) => [match[1], match[2]]));
  const android = listed('android');
  const direct = [...read('android/app/build.gradle').matchAll(/^\s*implementation\s+["']([\w.-]+):([\w.-]+):([^"']+)["']/gm)]
    .map(([, group, artifact, version]) => [`${group}:${artifact}`, version.replace(/^\$(\w+)$/, (_, name) => variables[name] ?? version)]);
  assert.ok(direct.length >= 8, 'the Gradle dependency scan found too few dependencies');
  for (const [name, version] of direct) {
    assert.ok(android.has(`${name}@${version}`), `${name}@${version} is missing from services/legal/thirdPartyComponents.json`);
  }
});

test('every entry names its version, licence, copyright and project, and no entry is listed twice', () => {
  const seen = new Set<string>();
  for (const item of components) {
    for (const field of ['name', 'version', 'license', 'copyright', 'url'] as const) {
      assert.ok(item[field]?.trim(), `${item.name}: missing ${field}`);
    }
    assert.match(item.url, /^https?:\/\//, `${item.name}: project link`);
    const key = `${item.kind}:${item.name}@${item.version}`;
    assert.ok(!seen.has(key), `${key} is listed twice`);
    seen.add(key);
  }
});

test('every licence a component names has its full text, and no text is orphaned', () => {
  const used = new Set(components.flatMap((item) => licenseIds(item.license)));
  for (const id of used) {
    assert.ok(texts.licenses[id]?.text.trim().length > 200 || id === 'LicenseRef-Android-SDK-Terms', `${id}: no licence text`);
  }
  assert.deepEqual(Object.keys(texts.licenses).filter((id) => !used.has(id)), [], 'licence text that no component uses');
  assert.ok(texts.licenses['Apache-2.0'].text.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'));
  for (const notice of texts.notices) assert.ok(notice.text.trim() && notice.title, `${notice.component}: NOTICE text`);
});

test('THIRD_PARTY_NOTICES.md is the generated rendering of the same data the page shows', () => {
  assert.equal(
    read('THIRD_PARTY_NOTICES.md'),
    renderThirdPartyNotices(components, texts),
    'run: node scripts/generate-third-party-notices.mjs',
  );
});

test('the licences page is reachable from Settings and keeps its texts out of the page chunk', () => {
  assert.match(read('App.tsx'), /<Route path="\/licenses" element=\{<OpenSourceLicenses \/>\} \/>/);
  assert.match(read('components/Pages/SettingsPage.tsx'), /to="\/licenses"/);
  assert.match(read('services/legal/thirdPartyNotices.ts'), /import\('\.\/licenseTexts\.json'\)/);
  assert.doesNotMatch(read('services/legal/thirdPartyNotices.ts'), /^import .*licenseTexts/m);
});
