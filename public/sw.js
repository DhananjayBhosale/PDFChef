const CACHE_NAME = 'pdf-chef-shell-__PDF_CHEF_CACHE_VERSION__';
const APP_SHELL = [
  '/',
  '/site.webmanifest',
  '/pdf-chef-app-icon-512.png',
  '/pdf-chef-logo-exact.webp',
];
const PRECACHE_ASSETS = /*__PDF_CHEF_PRECACHE__*/ [];
const isHtmlResponse = (response) => (response.headers.get('content-type') || '').toLowerCase().includes('text/html');

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...new Set([...APP_SHELL, ...PRECACHE_ASSETS])])));
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

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put('/', response.clone())));
          return response;
        })
        .catch(() => caches.match('/', { ignoreVary: true })),
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreVary: true }).then((cached) => {
      // Precached WASM and OCR model fetches have an empty request destination, so any exact
      // cache hit must win before applying the runtime-cache allowlist.
      if (cached && !isHtmlResponse(cached)) return cached;
      const cacheable = ['script', 'style', 'font', 'worker', 'image'].includes(request.destination)
        || url.pathname.startsWith('/assets/')
        || url.pathname.startsWith('/vendor/tesseract/');
      if (!cacheable) return fetch(request);
      const refreshed = fetch(request)
        .then((response) => {
          // Missing static files can receive the SPA HTML fallback. Never persist or
          // serve that fallback as a script, font, image or PDF runtime asset.
          if (isHtmlResponse(response)) return Response.error();
          if (response.ok) event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone())));
          return response;
        })
        .catch(() => Response.error());
      return refreshed;
    }),
  );
});
