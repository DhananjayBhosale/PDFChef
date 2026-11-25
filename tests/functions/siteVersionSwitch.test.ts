import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequest } from '../../functions/_middleware.js';

// Old and new version side by side (owner, 25 Nov 2026): a cookie picks the build.
const page = (name: string) => `<!doctype html><html><head><title>t</title></head><body>${name}</body></html>`;
const html = { 'content-type': 'text/html; charset=UTF-8' };
const js = { 'content-type': 'text/javascript' };

const assets = {
  fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/__old/') return new Response(page('old build'), { headers: html });
    if (path === '/__old/sw.js') return new Response('// old worker', { headers: js });
    return new Response('missing', { status: 404 });
  },
};

const run = (url: string, { cookie, withOld = true }: { cookie?: string; withOld?: boolean } = {}) => onRequest({
  request: new Request(url, { headers: cookie ? { cookie } : {} }),
  env: withOld ? { ASSETS: assets } : {},
  next: async (request: Request) => (new URL(request.url).pathname === '/sw.js'
    ? new Response('// new worker', { headers: js })
    : new Response(page('new build'), { headers: html })),
});

test('a visitor without the cookie gets the old build, with the switch on its page', async () => {
  const body = await (await run('https://pdfchef.dhananjaytech.app/')).text();
  assert.match(body, /old build/);
  assert.match(body, /<script src="\/__version\/switch\.js" defer><\/script>/);
  assert.doesNotMatch(body, /pdfchef-version-switch/);
  assert.equal(await (await run('https://pdfchef.dhananjaytech.app/sw.js')).text(), '// old worker');
});

test('the cookie picks the new build, marked so its Settings shows the switch', async () => {
  const cookie = 'theme=dark; pdfchef_version=new';
  const body = await (await run('https://pdfchef.dhananjaytech.app/merge', { cookie })).text();
  assert.match(body, /new build/);
  assert.match(body, /<meta name="pdfchef-version-switch" content="new" \/>/);
  assert.equal(await (await run('https://pdfchef.dhananjaytech.app/sw.js', { cookie })).text(), '// new worker');
});

test('a deployment without the old build serves the root build to everyone, with no switch', async () => {
  const body = await (await run('https://pdfchef.dhananjaytech.app/', { withOld: false })).text();
  assert.match(body, /new build/);
  assert.doesNotMatch(body, /switch|pdfchef-version-switch/);
});

test('switching sets the cookie and returns only to a page on this site', async () => {
  const toNew = await run('https://pdfchef.dhananjaytech.app/__version/new?to=%2Fmerge');
  assert.equal(toNew.status, 303);
  assert.equal(toNew.headers.get('location'), '/merge');
  assert.match(toNew.headers.get('set-cookie') ?? '', /^pdfchef_version=new; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/);
  const toOld = await run('https://pdfchef.dhananjaytech.app/__version/old?to=%2F%2Fevil.example');
  assert.equal(toOld.headers.get('location'), '/');
  assert.match(toOld.headers.get('set-cookie') ?? '', /^pdfchef_version=old;/);
  const script = await run('https://pdfchef.dhananjaytech.app/__version/switch.js');
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.match(await script.text(), /__version\/new\?to=\//);
});
