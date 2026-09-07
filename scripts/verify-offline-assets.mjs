import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.PDF_CHEF_DIST_DIR
  ? resolve(process.env.PDF_CHEF_DIST_DIR)
  : resolve(root, 'dist');
const assetsDirectory = resolve(dist, 'assets');
const ignoredMetadataFiles = new Set(['.DS_Store']);

const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredMetadataFiles.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile()) files.push(absolute);
    else fail(`non-file entry is not allowed in offline assets: ${absolute}`);
  }
  return files;
};

const exists = async (path) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const fail = (message) => { throw new Error(`Offline asset verification failed: ${message}`); };
const requireFile = async (path, label) => {
  if (!await exists(path)) fail(`${label} is missing`);
  return readFile(path);
};
const relativeUrl = (path) => `/${relative(dist, path).split(sep).join('/')}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sorted = (values) => [...values].sort();
const only = (values, label) => {
  if (values.length !== 1) fail(`${label} expected exactly one match, found ${values.length}`);
  return values[0];
};
const hasMagic = (bytes, magic) => magic.every((value, index) => bytes[index] === value);

const indexPath = resolve(dist, 'index.html');
const serviceWorkerPath = resolve(dist, 'sw.js');
const DEPLOYMENT_CONTROL_FILES = new Set(['_headers', '_redirects']);
await requireFile(indexPath, 'dist/index.html');
await requireFile(serviceWorkerPath, 'dist/sw.js');

// Bind verification to a fresh output. Inputs intentionally exclude tests,
// documentation, this verifier, generated output, and native wrapper copies.
const sourceRoots = ['assets', 'components', 'hooks', 'lib', 'services', 'public']
  .map(value => resolve(root, value));
const sourceFiles = [
  resolve(root, 'index.html'),
  resolve(root, 'index.css'),
  resolve(root, 'index.tsx'),
  resolve(root, 'App.tsx'),
  resolve(root, 'package.json'),
  resolve(root, 'package-lock.json'),
  resolve(root, 'vite.config.ts'),
  resolve(root, 'tailwind.config.cjs'),
  resolve(root, 'postcss.config.cjs'),
  resolve(root, 'tsconfig.json'),
  resolve(root, 'scripts/prepare-local-assets.mjs'),
  resolve(root, 'scripts/inject-service-worker-manifest.mjs'),
];
for (const directory of sourceRoots) sourceFiles.push(...await walk(directory));
const newestInput = Math.max(...await Promise.all(sourceFiles.map(async path => (await stat(path)).mtimeMs)));
const builtAt = (await stat(indexPath)).mtimeMs;
if (builtAt < newestInput) fail('dist predates a build input; run npm run build first');

const distFiles = await walk(dist);
const assetFiles = await walk(assetsDirectory);
const assetNames = assetFiles.map(path => relative(assetsDirectory, path).split(sep).join('/'));

// OCR: exact eight-file set, package bytes (decompressed model), and local wiring.
const ocrAssets = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm', 'core/tesseract-core-lstm.wasm'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm', 'core/tesseract-core-simd-lstm.wasm'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'core/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm', 'core/tesseract-core-relaxedsimd-lstm.wasm'],
  ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata'],
];
const builtOcrRoot = resolve(dist, 'vendor/tesseract');
const builtOcrFiles = (await walk(builtOcrRoot)).map(path => relative(builtOcrRoot, path).split(sep).join('/'));
assert.deepEqual(sorted(builtOcrFiles), sorted(ocrAssets.map(([, destination]) => destination)), 'OCR file set');
for (const [source, destination] of ocrAssets) {
  const packagedSourceBytes = await readFile(resolve(root, source));
  const sourceBytes = source.endsWith('.gz') ? gunzipSync(packagedSourceBytes) : packagedSourceBytes;
  const builtBytes = await readFile(resolve(builtOcrRoot, destination));
  if (sha256(sourceBytes) !== sha256(builtBytes)) fail(`OCR asset differs from package source: ${destination}`);
  if (destination.endsWith('.wasm') && !hasMagic(builtBytes, [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])) {
    fail(`invalid WebAssembly magic: ${destination}`);
  }
  if (destination.endsWith('.js') && builtBytes.length === 0) fail(`empty OCR JavaScript: ${destination}`);
}
const ocrSource = await readFile(resolve(root, 'components/Tools/OCRPDF.tsx'), 'utf8');
for (const expected of [
  "const LOCAL_OCR_ROOT = '/vendor/tesseract'",
  'workerPath: `${LOCAL_OCR_ROOT}/worker.min.js`',
  'corePath: `${LOCAL_OCR_ROOT}/core`',
  'langPath: `${LOCAL_OCR_ROOT}/lang`',
  'gzip: false',
]) {
  if (!ocrSource.includes(expected)) fail(`OCR local wiring is missing: ${expected}`);
}
const ocrChunk = only(assetFiles.filter(path => /^OCRPDF-[\w-]+\.js$/.test(relative(assetsDirectory, path))), 'OCR chunk');
if (!(await readFile(ocrChunk, 'utf8')).includes('/vendor/tesseract')) fail('built OCR chunk does not bind the local OCR root');

// PDF.js worker is emitted once and its consumer binds the hashed local URL.
const pdfSource = await readFile(resolve(root, 'services/pdfBrowser.ts'), 'utf8');
if (!pdfSource.includes("from 'pdfjs-dist/legacy/build/pdf.mjs'")) fail('PDF.js API import is not WebView-compatible');
if (!pdfSource.includes("from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'")) fail('PDF.js worker URL import is not WebView-compatible');
if (!pdfSource.includes('GlobalWorkerOptions.workerSrc = pdfWorkerSrc')) fail('PDF.js worker binding is missing');
const pdfWorkerName = only(assetNames.filter(name => /^pdf\.worker\.min-[\w-]+\.mjs$/.test(name)), 'PDF.js worker');
const pdfWorkerBytes = await readFile(resolve(assetsDirectory, pdfWorkerName));
if (pdfWorkerBytes.length === 0) fail('PDF.js worker is empty');
const pdfConsumers = [];
for (const path of assetFiles.filter(path => extname(path) === '.js')) {
  const text = await readFile(path, 'utf8');
  if (text.includes(`/assets/${pdfWorkerName}`) && text.includes('workerSrc')) pdfConsumers.push(path);
}
only(pdfConsumers, 'PDF.js worker consumer');

// PDF.js 6's generic bundle assumes newer typed-array APIs than Android WebView.
// Prove the official legacy bundle still opens a real document without toHex.
const originalToHex = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex');
try {
  Reflect.deleteProperty(Uint8Array.prototype, 'toHex');
  const [{ PDFDocument: FixturePDFDocument }, compatiblePdfJs] = await Promise.all([
    import('pdf-lib'),
    import('pdfjs-dist/legacy/build/pdf.mjs'),
  ]);
  const fixture = await FixturePDFDocument.create();
  for (let page = 0; page < 5; page += 1) fixture.addPage();
  const bytes = await fixture.save();
  const loadingTask = compatiblePdfJs.getDocument({ data: new Uint8Array(bytes) });
  const document = await loadingTask.promise;
  if (document.numPages !== 5) fail('WebView-compatible PDF.js did not open the five-page fixture');
  await loadingTask.destroy();
} finally {
  Reflect.deleteProperty(Uint8Array.prototype, 'toHex');
  if (originalToHex) Object.defineProperty(Uint8Array.prototype, 'toHex', originalToHex);
}

// QPDF's worker, JS runtime, and WASM are derived from the built consumer.
const qpdfSource = await readFile(resolve(root, 'services/qpdfBrowser.ts'), 'utf8');
for (const expected of [
  "from 'qpdf-run/worker?url'",
  "from 'qpdf-run/qpdf.js?url'",
  "from 'qpdf-run/qpdf.wasm?url'",
  'workerUrl: qpdfWorkerUrl',
  'qpdfJsUrl',
  'wasmUrl: qpdfWasmUrl',
]) {
  if (!qpdfSource.includes(expected)) fail(`QPDF local wiring is missing: ${expected}`);
}
const qpdfWasmName = only(assetNames.filter(name => /^qpdf-[\w-]+\.wasm$/.test(name)), 'QPDF WASM');
const qpdfJsName = only(assetNames.filter(name => /^qpdf-[\w-]+\.js$/.test(name)), 'QPDF JavaScript');
const qpdfConsumers = [];
const qpdfWorkerNames = new Set();
for (const path of assetFiles.filter(path => extname(path) === '.js')) {
  const text = await readFile(path, 'utf8');
  if (!text.includes(`/assets/${qpdfWasmName}`) || !text.includes(`/assets/${qpdfJsName}`)) continue;
  const workerMatch = text.match(/["'`]\/assets\/(worker-[\w-]+\.js)["'`]/);
  if (!workerMatch) continue;
  qpdfConsumers.push(path);
  qpdfWorkerNames.add(workerMatch[1]);
}
if (qpdfConsumers.length === 0) fail('QPDF consumer does not bind three local runtime URLs');
const qpdfWorkerName = only([...qpdfWorkerNames], 'QPDF worker URL');
for (const name of [qpdfJsName, qpdfWorkerName]) {
  if (!(await readFile(resolve(assetsDirectory, name))).length) fail(`empty QPDF JavaScript: ${name}`);
}
const qpdfWasmBytes = await readFile(resolve(assetsDirectory, qpdfWasmName));
if (!hasMagic(qpdfWasmBytes, [0x00, 0x61, 0x73, 0x6d])) fail('invalid QPDF WebAssembly magic');

// Required local font families and binary signatures.
const fontNames = assetNames.filter(name => /\.woff2?$/.test(name));
for (const family of ['inter-', 'manrope-', 'cormorant-garamond-', 'noto-sans-']) {
  if (!fontNames.some(name => name.startsWith(family))) fail(`font family is missing: ${family}`);
}
for (const name of fontNames) {
  const bytes = await readFile(resolve(assetsDirectory, name));
  const magic = name.endsWith('.woff2') ? [0x77, 0x4f, 0x46, 0x32] : [0x77, 0x4f, 0x46, 0x46];
  if (!hasMagic(bytes, magic)) fail(`invalid font magic: ${name}`);
}

// No unresolved markers; cache ID and manifest are independently reproducible.
const sw = await readFile(serviceWorkerPath, 'utf8');
if (sw.includes('__PDF_CHEF_CACHE_VERSION__') || sw.includes('__PDF_CHEF_PRECACHE__')) fail('service worker contains unresolved injection markers');
const manifestMatch = sw.match(/const PRECACHE_ASSETS = (\[[^;]*\]);/);
if (!manifestMatch) fail('service worker precache manifest is not parseable');
const manifest = JSON.parse(manifestMatch[1]);
if (!Array.isArray(manifest) || manifest.some(value => typeof value !== 'string')) fail('service worker manifest contains non-string values');
assert.deepEqual(manifest, sorted(new Set(manifest)), 'precache manifest must be unique and sorted');
const expectedManifest = sorted(distFiles
  .filter(path => !['index.html', 'sw.js'].includes(relative(dist, path)))
  .filter(path => !DEPLOYMENT_CONTROL_FILES.has(relative(dist, path)))
  .map(relativeUrl));
assert.deepEqual(manifest, expectedManifest, 'precache manifest must exactly cover dist except index.html and sw.js');
if (manifest.includes('/index.html') || manifest.includes('/sw.js')) fail('precache includes an excluded service-worker control file');
for (const name of DEPLOYMENT_CONTROL_FILES) {
  if (manifest.includes(`/${name}`)) fail(`precache includes deployment control file: ${name}`);
}
const cacheIdentity = [{ path: '/', sha256: sha256(await readFile(indexPath)) }];
for (const url of expectedManifest) {
  const bytes = await readFile(resolve(dist, `.${url}`));
  cacheIdentity.push({ path: url, sha256: sha256(bytes) });
}
const expectedCacheVersion = createHash('sha256')
  .update(JSON.stringify(cacheIdentity))
  .digest('hex')
  .slice(0, 12);
const cacheMatch = sw.match(/const CACHE_NAME = 'pdf-chef-shell-([a-f0-9]{12})'/);
if (!cacheMatch || cacheMatch[1] !== expectedCacheVersion) fail('service worker cache version does not match the exact URL-and-content identity');

// Reject effective remote processing/asset dependencies without false positives
// from XML namespaces, licenses, metadata, or overridden library defaults.
const remoteRuntimeSink = /(?:fetch|importScripts|new\s+(?:Shared)?Worker|import)\s*\(\s*["'`]https?:\/\//;
if (!remoteRuntimeSink.test('fetch("https://invalid.example/runtime.wasm")')) fail('remote-runtime detector self-test failed');
const remoteAssetConfiguration = /(?:worker(?:Src|Path)?|corePath|langPath|wasmUrl|qpdfJsUrl)\s*[:=]\s*["'`]https?:\/\//;
if (!remoteAssetConfiguration.test('workerPath: "https://invalid.example/worker.js"')) fail('remote-asset detector self-test failed');
const effectiveRuntimePaths = [
  resolve(root, 'components/Tools/OCRPDF.tsx'),
  resolve(root, 'services/pdfBrowser.ts'),
  resolve(root, 'services/qpdfBrowser.ts'),
  resolve(root, 'services/officeDocument.ts'),
  ocrChunk,
  ...pdfConsumers,
  ...qpdfConsumers,
];
for (const path of effectiveRuntimePaths) {
  const text = await readFile(path, 'utf8');
  if (remoteRuntimeSink.test(text)) {
    fail(`remote processing runtime or asset found in ${relative(root, path)}`);
  }
}
// Third-party bundles may retain an unreachable CDN default. The application
// source is the authoritative configuration, and the local URL/chunk checks
// above prove that the effective OCR/PDF/QPDF runtimes do not use that default.
for (const path of effectiveRuntimePaths.slice(0, 4)) {
  if (remoteAssetConfiguration.test(await readFile(path, 'utf8'))) {
    fail(`remote processing asset configuration found in ${relative(root, path)}`);
  }
}
const indexHtml = await readFile(indexPath, 'utf8');
if (/<script\b[^>]*\bsrc=["']https?:\/\//i.test(indexHtml)) fail('remote script dependency found in dist/index.html');
if (/<link\b[^>]*\brel=["'](?:stylesheet|modulepreload|preload)["'][^>]*\bhref=["']https?:\/\//i.test(indexHtml)) {
  fail('remote preload or stylesheet dependency found in dist/index.html');
}
for (const cssPath of assetFiles.filter(path => extname(path) === '.css')) {
  if (/url\(\s*["']?https?:\/\//i.test(await readFile(cssPath, 'utf8'))) fail(`remote CSS asset found in ${relative(root, cssPath)}`);
}

console.log(`Offline asset verification passed: ${manifest.length} precached files, ${ocrAssets.length} OCR assets, ${fontNames.length} fonts.`);
