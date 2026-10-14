import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve(process.env.PDF_CHEF_SW_OUTPUT || 'output/service-worker-updates');
await mkdir(output, { recursive: true });
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
let version = 1;
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Cache-Control', 'no-store');
  if (pathname === '/sw.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(source
      .replace('__PDF_CHEF_CACHE_VERSION__', `update-test-v${version}`)
      .replace('/*__PDF_CHEF_PRECACHE__*/ []', JSON.stringify([`/assets/lazy-v${version}.js`])));
  } else if (pathname === `/assets/lazy-v${version}.js`) {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(`export const version = ${version};`);
  } else if (pathname.startsWith('/assets/')) {
    response.writeHead(404, { 'Content-Type': 'text/html' });
    response.end('Previous deployment asset is unavailable.');
  } else if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><body>App v${version}</body></html>`);
  } else {
    response.setHeader('Content-Type', pathname.endsWith('.webmanifest') ? 'application/manifest+json' : 'image/png');
    response.end('Offline shell fixture');
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

// Poll from Node so lifecycle state and asynchronous CacheStorage reads have
// settled before testing activation; a controllerchange alone is too early.
const waitFor = async (read, matches, label) => {
  const deadline = Date.now() + 15_000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (matches(value)) return value;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  const firstInstall = await waitFor(
    () => page.evaluate(async () => ({
      controlled: Boolean(navigator.serviceWorker.controller),
      active: (await navigator.serviceWorker.getRegistration()).active?.state,
      cached: Boolean(await caches.match('/assets/lazy-v1.js')),
    })),
    state => state.controlled && state.active === 'activated' && state.cached,
    'First installation must activate, cache its assets and claim the open tab',
  );
  await page.evaluate(() => { window.originalController = navigator.serviceWorker.controller; });

  version = 2;
  const updatedWorkerReady = context.waitForEvent('serviceworker');
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  const updatedWorker = await updatedWorkerReady;
  const waiting = await waitFor(
    () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        waiting: registration.waiting?.state ?? null,
        sameController: navigator.serviceWorker.controller === window.originalController,
        cacheKeys: await caches.keys(),
      };
    }),
    state => state.waiting === 'installed' || !state.sameController,
    'Updated worker must finish installing',
  );
  assert.equal(waiting.waiting, 'installed', 'An update must wait while a previous-build tab is open');
  assert.equal(waiting.sameController, true);
  assert.deepEqual(waiting.cacheKeys.sort(), ['pdf-chef-shell-update-test-v1', 'pdf-chef-shell-update-test-v2']);

  await context.setOffline(true);
  const oldTab = await page.evaluate(async () => ({
    shell: document.body.textContent,
    lazyVersion: (await import('/assets/lazy-v1.js')).version,
  }));
  assert.deepEqual(oldTab, { shell: 'App v1', lazyVersion: 1 });

  // Closing the last old client lets the browser activate the waiting build.
  await page.close();
  const activated = await waitFor(
    () => updatedWorker.evaluate(async () => ({
      active: self.registration.active?.state,
      cacheKeys: await caches.keys(),
    })),
    state => state.active === 'activated' && state.cacheKeys.length === 1,
    'Update must activate and release the previous cache after old tabs close',
  );
  assert.deepEqual(activated.cacheKeys, ['pdf-chef-shell-update-test-v2']);
  const reopened = await context.newPage();
  await reopened.goto(origin);
  const newTab = await reopened.evaluate(async () => ({
    shell: document.body.textContent,
    lazyVersion: (await import('/assets/lazy-v2.js')).version,
  }));
  assert.deepEqual(newTab, { shell: 'App v2', lazyVersion: 2 });

  const evidence = { firstInstall, waiting, oldTab, activated, newTab };
  await writeFile(resolve(output, 'results.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS first installation, waiting update, old-tab offline lazy import, activation after close, and new-build offline reopen');
  await context.close();
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
