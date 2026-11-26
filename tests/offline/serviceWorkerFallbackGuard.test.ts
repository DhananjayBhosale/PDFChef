import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const origin = 'https://pdfchef.dhananjaytech.app';
const page = (entry: string) => `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body></body></html>`;
const OWN_PAGE = page('/assets/index-own.js');
const OTHER_PAGE = page('/assets/index-other.js');
const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
  .replace('/*__PDF_CHEF_PRECACHE__*/ []', JSON.stringify(['/assets/index-own.js', '/vendor/pdfjs/pdf.worker.min.mjs']));

type Network = {type: string; body?: string; offline?: boolean};
type Send = {path: string; mode?: string; destination?: string; clientId?: string; resultingClientId?: string};

/**
 * A worker over one cache store. `restart()` starts a new worker on the same store, as the browser
 * does after stopping an idle worker. `stored` holds the cache's URLs and content types.
 */
function startWorker(stored = new Map<string, string>()) {
  const writes: string[] = [];
  const network: Network = {type: 'application/javascript'};
  const key = (request: any) => (typeof request === 'string' ? request : new URL(request.url).pathname);
  const cache = {
    match: async (request: any) => (stored.has(key(request))
      ? new Response(`cached ${key(request)}`, {headers: {'content-type': stored.get(key(request))!}}) : undefined),
    put: async (request: any, response: Response) => {
      writes.push(key(request));
      stored.set(key(request), response.headers.get('content-type') || '');
    },
    addAll: async () => undefined,
  };
  const listeners: Record<string, (event: any) => void> = {};
  runInNewContext(source, {
    self: {location: {origin}, addEventListener: (name: string, fn: any) => {listeners[name] = fn;}},
    URL, Response,
    caches: {open: async () => cache},
    fetch: async () => {
      if (network.offline) throw new TypeError('offline');
      return new Response(network.body ?? 'network', {headers: {'content-type': network.type}});
    },
  });
  const send = async ({path, mode = 'cors', destination = mode === 'navigate' ? 'document' : 'script', clientId = '', resultingClientId = ''}: Send) => {
    let result: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    listeners.fetch({
      request: {method: 'GET', headers: new Headers(), url: origin + path, mode, destination},
      clientId, resultingClientId,
      respondWith: (promise: Promise<Response>) => {result = promise;},
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    const response = await result!;
    await Promise.all(pending);
    return response;
  };
  return {send, writes, network, stored, restart: () => startWorker(stored)};
}

test('missing asset HTML is neither returned nor written to the offline cache', async () => {
  for (const type of ['text/html', 'text/html; charset=utf-8', 'TEXT/HTML']) {
    const worker = startWorker();
    worker.network.type = type;
    const response = await worker.send({path: '/assets/probe.js', clientId: 'tab'});
    assert.equal(response.type, 'error');
    assert.deepEqual(worker.writes, []);
  }
});

test('valid JavaScript still loads and caches, replacing a previous HTML cache entry', async () => {
  for (const cached of [undefined, 'text/html']) {
    const worker = startWorker(new Map(cached ? [['/assets/probe.js', cached]] : []));
    const response = await worker.send({path: '/assets/probe.js', clientId: 'tab'});
    assert.equal(await response.text(), 'network');
    assert.deepEqual(worker.writes, ['/assets/probe.js']);
  }
});

test('a page of its own build is stored as the shell and gets this build files', async () => {
  const worker = startWorker(new Map([['/vendor/pdfjs/pdf.worker.min.mjs', 'text/javascript']]));
  worker.network.type = 'text/html';
  worker.network.body = OWN_PAGE;
  const response = await worker.send({path: '/merge', mode: 'navigate', resultingClientId: 'tab'});
  assert.equal(await response.text(), OWN_PAGE);
  assert.deepEqual(worker.writes, ['/']);
  worker.network.type = 'text/javascript';
  assert.equal(await (await worker.send({path: '/vendor/pdfjs/pdf.worker.min.mjs', clientId: 'tab'})).text(), 'cached /vendor/pdfjs/pdf.worker.min.mjs');
  worker.network.offline = true;
  assert.equal(await (await worker.send({path: '/merge', mode: 'navigate', resultingClientId: 'next'})).text(), 'cached /');
});

// One build per tab (owner, 26 Nov 2026). After a release, or after the old/new switch, the website
// serves another build. A worker must never pair that page with its own build's files.
test('a page of another build gets every file from the network, also in its web workers', async () => {
  const worker = startWorker(new Map([['/vendor/pdfjs/pdf.worker.min.mjs', 'text/javascript'], ['/vendor/tesseract/core.wasm', 'application/wasm']]));
  worker.network.type = 'text/html';
  worker.network.body = OTHER_PAGE;
  const response = await worker.send({path: '/', mode: 'navigate', resultingClientId: 'release-tab'});
  assert.equal(await response.text(), OTHER_PAGE);
  worker.network.type = 'text/javascript';
  worker.network.body = 'release file';
  const pdfWorker = await worker.send({path: '/vendor/pdfjs/pdf.worker.min.mjs', destination: 'worker', clientId: 'release-tab', resultingClientId: 'release-worker'});
  assert.equal(await pdfWorker.text(), 'release file');
  const fromWorker = await worker.send({path: '/vendor/tesseract/core.wasm', destination: '', clientId: 'release-worker'});
  assert.equal(await fromWorker.text(), 'release file');
  assert.ok(!worker.writes.includes('/'), 'the other build page is never stored as this worker shell');
  assert.ok(!worker.writes.some((path) => path.startsWith('/vendor/')), 'the other build files are never stored in this cache');
  // A tab of this build still gets this build's copy.
  assert.equal(await (await worker.send({path: '/vendor/pdfjs/pdf.worker.min.mjs', clientId: 'own-tab'})).text(), 'cached /vendor/pdfjs/pdf.worker.min.mjs');

  // The browser stops an idle worker; the restarted one still knows both tabs.
  const restarted = worker.restart();
  restarted.network.body = 'release file';
  assert.equal(await (await restarted.send({path: '/vendor/pdfjs/pdf.worker.min.mjs', clientId: 'release-tab'})).text(), 'release file');
  assert.equal(await (await restarted.send({path: '/vendor/tesseract/core.wasm', destination: '', clientId: 'release-worker'})).text(), 'release file');
  assert.equal(await (await restarted.send({path: '/vendor/pdfjs/pdf.worker.min.mjs', clientId: 'own-tab'})).text(), 'cached /vendor/pdfjs/pdf.worker.min.mjs');
});

test('the old/new switch redirect passes through untouched', async () => {
  const worker = startWorker();
  worker.network.type = '';
  const redirect = await worker.send({path: '/__version/new?to=/', mode: 'navigate', resultingClientId: 'tab'});
  assert.equal(await redirect.text(), 'network');
  assert.deepEqual(worker.writes, []);
});
