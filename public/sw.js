const CACHE_NAME = 'pdf-chef-shell-__PDF_CHEF_CACHE_VERSION__';
const APP_SHELL = [
  '/',
  '/site.webmanifest',
  '/pdf-chef-app-icon-512.png',
  '/pdf-chef-logo-exact.webp',
];
const PRECACHE_ASSETS = /*__PDF_CHEF_PRECACHE__*/ [];
const isHtmlResponse = (response) => (response.headers.get('content-type') || '').toLowerCase().includes('text/html');
const precache = () => caches.open(CACHE_NAME).then((cache) => cache.addAll([...new Set([...APP_SHELL, ...PRECACHE_ASSETS])]));
const ownCache = () => caches.open(CACHE_NAME);

// One build per tab. After a release, or after the old/new switch, the website answers a load with
// another build than this worker's. That tab gets every file from the network, so it never pairs
// its page with this build's files that keep their URL (/vendor/, icons). Tabs of this build keep
// this cache. A page is of this build when its entry script is one this worker precaches. The marks
// are kept in the cache too, because the browser stops an idle worker and the tab outlives it.
const OTHER_BUILD = '/__other-build/';
const otherBuildTabs = new Map();
const isOwnShell = (html) => (html.match(/<script\b[^>]*>/gi) || []).some((tag) => /\btype="module"/i.test(tag)
  && PRECACHE_ASSETS.includes((/\bsrc="([^"]+)"/i.exec(tag) || [])[1]));
const markOtherBuild = (id) => {
  if (!id) return Promise.resolve();
  otherBuildTabs.set(id, true);
  return ownCache().then((cache) => cache.put(OTHER_BUILD + id, new Response('')));
};
const isOtherBuild = async (id) => {
  if (!id) return false;
  if (!otherBuildTabs.has(id)) otherBuildTabs.set(id, Boolean(await (await ownCache()).match(OTHER_BUILD + id)));
  return otherBuildTabs.get(id);
};

const loadPage = async (event) => {
  let response;
  try {
    response = await fetch(event.request);
  } catch {
    return (await (await ownCache()).match('/')) || Response.error();
  }
  // A redirect, such as the old/new switch, is followed by another load.
  if (!isHtmlResponse(response)) return response;
  if (!isOwnShell(await response.clone().text())) event.waitUntil(markOtherBuild(event.resultingClientId));
  else if (response.ok) event.waitUntil(ownCache().then((cache) => cache.put('/', response.clone())));
  return response;
};

const loadFile = async (event) => {
  const request = event.request;
  if (await isOtherBuild(event.clientId)) {
    // A worker started by that tab is of its build too.
    if (request.destination === 'worker' || request.destination === 'sharedworker') event.waitUntil(markOtherBuild(event.resultingClientId));
    return fetch(request);
  }
  const cache = await ownCache();
  const cached = await cache.match(request, { ignoreVary: true });
  // Precached WASM and OCR model fetches have an empty request destination, so any exact
  // cache hit must win before applying the runtime-cache allowlist.
  if (cached && !isHtmlResponse(cached)) return cached;
  const url = new URL(request.url);
  const cacheable = ['script', 'style', 'font', 'worker', 'image'].includes(request.destination)
    || url.pathname.startsWith('/assets/')
    || url.pathname.startsWith('/vendor/tesseract/');
  if (!cacheable) return fetch(request);
  try {
    const response = await fetch(request);
    // Missing static files can receive the SPA HTML fallback. Never persist or
    // serve that fallback as a script, font, image or PDF runtime asset.
    if (isHtmlResponse(response)) return Response.error();
    if (response.ok) event.waitUntil(cache.put(request, response.clone()));
    return response;
  } catch {
    return Response.error();
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  // Let updates wait until the previous worker's tabs close. Those tabs still
  // import the previous build's lazy chunks, whose cache activation removes.
  // A first installation activates normally and claims its initial tab below.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('pdf-chef-shell-') && name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(request.mode === 'navigate' ? loadPage(event) : loadFile(event));
});
