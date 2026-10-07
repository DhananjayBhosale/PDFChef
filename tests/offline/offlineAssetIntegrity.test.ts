import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = resolve(root, 'dist');
const DEPLOYMENT_CONTROL_URLS = new Set(['/_headers', '/_redirects', '/_routes.json']);
const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === '.DS_Store') return [];
  const path = resolve(directory, entry.name);
  return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
});
const urlFor = (path: string) => `/${relative(dist, path).split(sep).join('/')}`;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const cacheVersion = (identity: Array<{ path: string; sha256: string }>) => createHash('sha256')
  .update(JSON.stringify(identity))
  .digest('hex')
  .slice(0, 12);

test('offline cache identity covers each unique sorted URL and its exact bytes', () => {
  const urls = walk(dist)
    .map(urlFor)
    .filter((url) => url !== '/index.html' && url !== '/sw.js')
    .filter((url) => !DEPLOYMENT_CONTROL_URLS.has(url))
    .sort();
  assert.deepEqual(urls, [...new Set(urls)]);
  const identity = [
    { path: '/', sha256: sha256(readFileSync(resolve(dist, 'index.html'))) },
    ...urls.map((path) => ({ path, sha256: sha256(readFileSync(resolve(dist, `.${path}`)) ) })),
  ];
  const expectedVersion = cacheVersion(identity);
  const worker = readFileSync(resolve(dist, 'sw.js'), 'utf8');
  assert.match(worker, new RegExp(`const CACHE_NAME = 'pdf-chef-shell-${expectedVersion}'`));
  const manifest = JSON.parse(worker.match(/const PRECACHE_ASSETS = (\[[^;]*\]);/)?.[1] ?? 'null');
  assert.deepEqual(manifest, urls);
  for (const url of DEPLOYMENT_CONTROL_URLS) assert.equal(manifest.includes(url), false);
});

test('a byte change at a stable cached path changes the cache identity', () => {
  const before = [{ path: '/', sha256: 'a'.repeat(64) }, { path: '/assets/app.js', sha256: 'b'.repeat(64) }];
  const after = [{ path: '/', sha256: 'a'.repeat(64) }, { path: '/assets/app.js', sha256: 'c'.repeat(64) }];
  assert.notEqual(cacheVersion(before), cacheVersion(after));
});

test('offline and Android package verifiers accept the generated artifacts', () => {
  for (const script of ['scripts/verify-offline-assets.mjs', 'scripts/verify-android-packaged-assets.mjs']) {
    const output = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.match(output, /verification passed/i);
  }
});
