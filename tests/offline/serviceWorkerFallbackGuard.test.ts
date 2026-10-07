import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

async function fetchThroughWorker(type: string, mode = 'cors', cachedType?: string) {
  const listeners: Record<string, (event: any) => void> = {};
  const writes: string[] = [];
  const pending: Promise<unknown>[] = [];
  let result: Promise<Response> | undefined;
  const origin = 'https://pdfchef.dhananjaytech.app';
  runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), {
    self: {location: {origin}, addEventListener: (name: string, fn: any) => {listeners[name] = fn;}},
    URL, Response,
    caches: {match: async () => cachedType ? new Response('cached', {headers: {'content-type': cachedType}}) : undefined,
      open: async () => ({put: async (request: any) => {writes.push(typeof request === 'string' ? request : request.url);}})},
    fetch: async () => new Response('body', {headers: {'content-type': type}}),
  });
  listeners.fetch({request: {method: 'GET', headers: new Headers(), url: origin + '/assets/probe.js', mode, destination: mode === 'navigate' ? 'document' : 'script'},
    respondWith: (promise: Promise<Response>) => {result = promise;}, waitUntil: (promise: Promise<unknown>) => pending.push(promise)});
  const response = await result!;
  await Promise.all(pending);
  return {response, writes};
}

test('missing asset HTML is neither returned nor written to the offline cache', async () => {
  for (const type of ['text/html', 'text/html; charset=utf-8', 'TEXT/HTML']) {
    const {response, writes} = await fetchThroughWorker(type);
    assert.equal(response.type, 'error');
    assert.deepEqual(writes, []);
  }
});

test('valid JavaScript still loads and caches, replacing a previous HTML cache entry', async () => {
  for (const cachedType of [undefined, 'text/html']) {
    const {response, writes} = await fetchThroughWorker('application/javascript', 'cors', cachedType);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'body');
    assert.deepEqual(writes, ['https://pdfchef.dhananjaytech.app/assets/probe.js']);
  }
});

test('navigation still caches the HTML shell for offline reopening', async () => {
  const {response, writes} = await fetchThroughWorker('text/html', 'navigate');
  assert.equal(response.status, 200);
  assert.deepEqual(writes, ['/']);
});
