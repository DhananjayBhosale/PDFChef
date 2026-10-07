import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { onRequest } from '../../functions/_middleware.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const routes = JSON.parse(read('public/_routes.json'));
const excluded = (path: string) => routes.exclude.some((rule: string) => rule.endsWith('*')
  ? path.startsWith(rule.slice(0, -1)) : path === rule);

test('static payloads bypass Functions while HTML and crawler routes keep middleware', () => {
  assert.equal(routes.version, 1);
  assert.deepEqual(routes.include, ['/*']);
  assert.ok(routes.include.length + routes.exclude.length <= 100);
  for (const rule of routes.exclude) {
    assert.match(rule, /^\/[^*]*(\*)?$/);
    assert.ok(rule.length <= 100);
    if (!rule.endsWith('*')) read(`public${rule}`);
  }
  for (const path of ['/assets/app-abc.js', '/assets/font-abc.woff2', '/vendor/pdfjs/cmaps/a.bcmap', '/vendor/tesseract/core.wasm', '/tool-icons/edit.webp', '/site.webmanifest']) {
    assert.equal(excluded(path), true, path);
  }
  const middleware = read('functions/_middleware.js');
  const htmlRoutes = [...middleware.matchAll(/^  "(\/[^"\n]*)": /gm)].map(match => match[1]);
  assert.ok(htmlRoutes.length > 30);
  for (const path of [...htmlRoutes, '/unknown-route', '/robots.txt', '/sitemap.xml', '/index.html', '/sw.js']) {
    assert.equal(excluded(path), false, path);
  }
});

test('every public and built payload bypasses Functions except deliberate crawler routes', () => {
  const controls = new Set(['_headers', '_redirects', '_routes.json', '.DS_Store']);
  const retained = new Set(['index.html', 'robots.txt', 'sitemap.xml', 'sw.js']);
  for (const directory of ['public', 'dist']) {
    const walk = (relative = '') => {
      for (const entry of readdirSync(resolve(root, directory, relative), { withFileTypes: true })) {
        if (controls.has(entry.name)) continue;
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path);
        else assert.equal(excluded(`/${path}`), !retained.has(path), `${directory}/${path}`);
      }
    };
    walk();
  }
});

test('static headers retain existing immutable and revalidation policies', async () => {
  const headers = read('public/_headers');
  for (const path of ['/assets/app-abc.js', '/sw.js', '/site.webmanifest']) {
    const response = await onRequest({ request: new Request(`https://pdfchef.dhananjaytech.app${path}`), next: async () => new Response('asset', { headers: { 'content-type': 'application/javascript' } }) });
    const rule = path.startsWith('/assets/') ? '/assets/*' : path;
    assert.ok(headers.includes(`${rule}\n  Cache-Control: ${response.headers.get('cache-control')}`));
  }
  assert.doesNotMatch(headers, /\/vendor\/|\/tool-icons\//);
});

test('HTML metadata, unknown-route 404 and old-host navigation redirect remain intact', async () => {
  const next = async () => new Response(read('index.html'), { headers: { 'content-type': 'text/html' } });
  const edited = await onRequest({ request: new Request('https://pdfchef.dhananjaytech.app/edit'), next });
  assert.equal(edited.status, 200);
  assert.equal(edited.headers.get('cache-control'), 'no-cache');
  assert.match(await edited.text(), /<title>Edit PDF/);
  const missing = await onRequest({ request: new Request('https://pdfchef.dhananjaytech.app/unknown-route'), next });
  assert.equal(missing.status, 404);
  const old = await onRequest({ request: new Request('https://pdftools.dhananjaytech.app/edit?test=1'), next });
  assert.equal(old.status, 308);
  assert.equal(old.headers.get('location'), 'https://pdfchef.dhananjaytech.app/edit?test=1');
});

test('real manifest injection excludes hosting controls without dropping offline payloads', () => {
  const scratch = resolve(root, 'output');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(resolve(scratch, 'routing-regression-'));
  try {
    mkdirSync(resolve(dir, 'vendor'));
    writeFileSync(resolve(dir, 'index.html'), '<html>fixture</html>');
    writeFileSync(resolve(dir, 'vendor/runtime.wasm'), 'fixture-payload');
    for (const control of ['_headers', '_redirects', '_routes.json']) writeFileSync(resolve(dir, control), read(`public/${control}`));
    const inject = () => {
      writeFileSync(resolve(dir, 'sw.js'), read('public/sw.js'));
      execFileSync(process.execPath, [resolve(root, 'scripts/inject-service-worker-manifest.mjs')], { env: { ...process.env, PDF_CHEF_DIST_DIR: dir } });
      return readFileSync(resolve(dir, 'sw.js'), 'utf8');
    };
    const before = inject();
    assert.deepEqual(JSON.parse(before.match(/const PRECACHE_ASSETS = (\[[^;]*\]);/)![1]), ['/vendor/runtime.wasm']);
    writeFileSync(resolve(dir, '_routes.json'), '{}');
    assert.equal(inject(), before, 'routing-only edits must not invalidate the offline payload cache');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
