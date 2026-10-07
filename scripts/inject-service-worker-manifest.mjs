import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.PDF_CHEF_DIST_DIR
  ? resolve(process.env.PDF_CHEF_DIST_DIR)
  : resolve(root, 'dist');
const serviceWorkerPath = resolve(dist, 'sw.js');
const DEPLOYMENT_CONTROL_FILES = new Set(['_headers', '_redirects', '_routes.json']);
const IGNORED_METADATA_FILES = new Set(['.DS_Store']);

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (IGNORED_METADATA_FILES.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`Offline asset injection rejects non-file entry: ${absolute}`);
  }
  return files;
};

const assets = [...new Set((await walk(dist))
  .filter((file) => !['index.html', 'sw.js'].includes(relative(dist, file)))
  .filter((file) => !DEPLOYMENT_CONTROL_FILES.has(relative(dist, file)))
  .map((file) => `/${relative(dist, file).split(sep).join('/')}`)
)].sort();

// The URL manifest is deliberately URL-only: Cache.addAll accepts request URLs,
// while the cache identity is a separate content address. A renamed or modified
// payload therefore always selects a new cache, even if the URL list is stable.
const identity = [{
  path: '/',
  sha256: createHash('sha256').update(await readFile(resolve(dist, 'index.html'))).digest('hex'),
}];
for (const url of assets) {
  const bytes = await readFile(resolve(dist, `.${url}`));
  identity.push({ path: url, sha256: createHash('sha256').update(bytes).digest('hex') });
}

const source = await readFile(serviceWorkerPath, 'utf8');
const manifest = JSON.stringify(assets);
const version = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12);
const output = source
  .replace('__PDF_CHEF_CACHE_VERSION__', version)
  .replace('/*__PDF_CHEF_PRECACHE__*/ []', manifest);

if (output === source) throw new Error('Service worker injection markers were not found.');
await writeFile(serviceWorkerPath, output);
console.log(`Injected ${assets.length} offline assets into cache ${version}.`);
