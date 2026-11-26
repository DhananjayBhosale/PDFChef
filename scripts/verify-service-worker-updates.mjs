import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as playwright from 'playwright';

// PDF_CHEF_SW_BROWSER=webkit runs the same checks in WebKit (Chromium by default).
const browserName = process.env.PDF_CHEF_SW_BROWSER || 'chromium';
// Playwright's offline mode in WebKit also blocks a service worker's own cache (with the committed
// worker too), so WebKit skips the two offline steps.
const offlineWorks = browserName !== 'webkit';
const output = resolve(process.env.PDF_CHEF_SW_OUTPUT || 'output/service-worker-updates', browserName);
await mkdir(output, { recursive: true });
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
let version = 1;
// Each fixture build has an entry script and a lazy chunk with the build in their names, and
// files that keep their URL from build to build, as /vendor/ and the icons do on the website:
// a script, and a web worker that loads a second script, as the PDF and OCR workers do.
const SAME_URL_FILES = ['/vendor/runtime.js', '/vendor/worker.js', '/vendor/worker-part.js'];
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Cache-Control', 'no-store');
  if (pathname === '/sw.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(source
      .replace('__PDF_CHEF_CACHE_VERSION__', `update-test-v${version}`)
      .replace('/*__PDF_CHEF_PRECACHE__*/ []', JSON.stringify([`/assets/index-v${version}.js`, `/assets/lazy-v${version}.js`, ...SAME_URL_FILES])));
  } else if (pathname === `/assets/lazy-v${version}.js` || pathname === `/assets/index-v${version}.js` || pathname === '/vendor/runtime.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(`export const version = ${version};`);
  } else if (pathname === '/vendor/worker.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(`importScripts('/vendor/worker-part.js'); postMessage([${version}, self.partVersion]);`);
  } else if (pathname === '/vendor/worker-part.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(`self.partVersion = ${version};`);
  } else if (pathname.startsWith('/assets/')) {
    response.writeHead(404, { 'Content-Type': 'text/html' });
    response.end('Previous deployment asset is unavailable.');
  } else if (pathname.startsWith('/__version/')) {
    response.writeHead(303, { Location: '/' });
    response.end();
  } else if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><head><script type="module" crossorigin src="/assets/index-v${version}.js"></script></head><body>App v${version}</body></html>`);
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

// What a tab runs: the page it was given, and the build of each file that keeps its URL. Each
// call fetches the files again, so it shows what the worker serves now.
const running = (tab) => tab.evaluate(async () => {
  const worker = new Worker('/vendor/worker.js');
  const [workerScript, workerPart] = await new Promise((done) => { worker.onmessage = (event) => done(event.data); });
  worker.terminate();
  return {
    shell: document.body.textContent,
    sameUrlFile: Number((await (await fetch('/vendor/runtime.js')).text()).match(/\d+/)[0]),
    workerScript,
    workerPart,
  };
});
const build = (n) => ({ shell: `App v${n}`, sameUrlFile: n, workerScript: n, workerPart: n });

let browser;
try {
  browser = await playwright[browserName].launch({ headless: true });
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

  // A release.
  version = 2;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  const waiting = await waitFor(
    () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        waiting: registration.waiting?.state ?? null,
        sameController: navigator.serviceWorker.controller === window.originalController,
        cacheKeys: (await caches.keys()).sort(),
      };
    }),
    state => state.waiting === 'installed' || !state.sameController,
    'Updated worker must finish installing',
  );
  assert.equal(waiting.waiting, 'installed', 'An update must wait while a previous-build tab is open');
  assert.equal(waiting.sameController, true);
  assert.deepEqual(waiting.cacheKeys, ['pdf-chef-shell-update-test-v1', 'pdf-chef-shell-update-test-v2']);

  // One build per tab (owner, 26 Nov 2026). A tab opened after the release, while a tab of the
  // previous build is open, gets the release as a whole; the open tab keeps the previous build.
  const second = await context.newPage();
  await second.goto(origin);
  const secondTab = await running(second);
  assert.deepEqual(secondTab, build(2), 'A new tab must not pair the release page with files of the previous build');
  const firstTab = await running(page);
  assert.deepEqual(firstTab, build(1), 'The open tab must keep the files of its own build');

  // Offline, the previous-build tab still loads its lazy parts from its worker cache.
  let offlineOldTab = null;
  if (offlineWorks) {
    await context.setOffline(true);
    offlineOldTab = await page.evaluate(async () => ({
      lazyVersion: (await import('/assets/lazy-v1.js')).version,
      sameUrlFile: Number((await (await fetch('/vendor/runtime.js')).text()).match(/\d+/)[0]),
    }));
    assert.deepEqual(offlineOldTab, { lazyVersion: 1, sameUrlFile: 1 });
    await context.setOffline(false);
  }

  // Reloading the previous-build tab moves it to the release as a whole.
  await page.reload();
  const reloaded = await running(page);
  assert.deepEqual(reloaded, build(2), 'A reload must load the release without the previous build files');

  // Closing every tab lets the browser activate the waiting build.
  await page.close();
  await second.close();
  const activated = await waitFor(
    async () => {
      const probe = await context.newPage();
      await probe.goto(`${origin}/site.webmanifest`);
      const cacheKeys = await probe.evaluate(() => caches.keys());
      await probe.close();
      return { cacheKeys };
    },
    state => state.cacheKeys.length === 1 && state.cacheKeys[0] === 'pdf-chef-shell-update-test-v2',
    'Update must activate after old tabs close',
  );
  if (offlineWorks) await context.setOffline(true);
  const reopened = await context.newPage();
  await reopened.goto(origin);
  const offlineReopen = { ...(await running(reopened)), lazyVersion: await reopened.evaluate(async () => (await import('/assets/lazy-v2.js')).version) };
  assert.deepEqual(offlineReopen, { ...build(2), lazyVersion: 2 });
  await context.setOffline(false);

  // The old/new switch: the website serves the other build (v3 here) after /__version/. The tab
  // gets it at once, although it is not a reload, and none of the v2 files. Another tab of the
  // v2 build stays on v2.
  const stays = await context.newPage();
  await stays.goto(origin);
  version = 3;
  await reopened.goto(`${origin}/__version/new?to=/`);
  const switched = await running(reopened);
  assert.deepEqual(switched, build(3), 'The switched tab must not get the other build files');
  const notSwitched = await running(stays);
  assert.deepEqual(notSwitched, build(2), 'A tab that did not switch keeps its own build files');

  // Switching back: the v2 worker serves its own build again, from its cache.
  version = 2;
  await reopened.goto(`${origin}/__version/old?to=/`);
  const switchedBack = await running(reopened);
  assert.deepEqual(switchedBack, build(2));

  // A release while no tab of it is open: the first new load gets it, from the network.
  await stays.close();
  await reopened.close();
  version = 4;
  const fresh = await context.newPage();
  await fresh.goto(origin);
  const freshLoad = await running(fresh);
  assert.deepEqual(freshLoad, build(4), 'A fresh load after a release must get the release as a whole');

  // The browser stops an idle worker; each tab must still get files of its own build afterwards.
  // Last, because Playwright's offline switch stalls on a worker stopped this way.
  let afterRestart = null;
  if (browserName === 'chromium') {
    // Close every tab, so one worker is left with one cache; its name says its build.
    await fresh.close();
    const { cacheKeys: [onlyCache] } = await waitFor(async () => {
      const probe = await context.newPage();
      await probe.goto(`${origin}/site.webmanifest`);
      const cacheKeys = await probe.evaluate(() => caches.keys());
      await probe.close();
      return { cacheKeys };
    }, state => state.cacheKeys.length === 1, 'One worker must be left');
    const active = Number(onlyCache.match(/v(\d+)$/)[1]);
    version = active;
    const own = await context.newPage();
    await own.goto(origin);
    version = active + 1;
    const other = await context.newPage();
    await other.goto(origin);
    const cdp = await context.newCDPSession(own);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach();
    afterRestart = { otherBuildTab: await running(other), ownTab: await running(own) };
    assert.deepEqual(afterRestart, { otherBuildTab: build(active + 1), ownTab: build(active) }, 'A worker restart must keep each tab on its build');
  }

  const evidence = { browserName, firstInstall, waiting, secondTab, firstTab, afterRestart, offlineOldTab, reloaded, activated, offlineReopen, switched, notSwitched, switchedBack, freshLoad };
  await writeFile(resolve(output, 'results.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS (${browserName}) first installation, waiting update, one build per tab (new tab gets the release, open tab keeps its build, web worker files, ${afterRestart ? 'worker restart, ' : ''}${offlineWorks ? 'offline old tab' : 'no offline steps'}), reload, activation after close, ${offlineWorks ? 'offline ' : ''}reopen, old/new switch both ways, fresh load after a release`);
  await context.close();
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
