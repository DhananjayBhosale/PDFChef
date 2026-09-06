import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const read = (path) => readFileSync(resolve(root, path), 'utf8');

const catalog = read('components/Tools/toolCatalog.ts');
const app = read('App.tsx');
const seo = read('components/SEO/RouteSEO.tsx');
const middleware = read('functions/_middleware.js');
const sitemap = read('public/sitemap.xml');

const catalogRoutes = [...catalog.matchAll(/path:\s*'([^']+)'/g)].map((match) => match[1]);
const appRoutes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]);
const sitemapRoutes = [...sitemap.matchAll(/<loc>https:\/\/pdfchef\.dhananjaytech\.app\/([^<]*)<\/loc>/g)]
  .map((match) => `/${match[1]}`)
  .map((route) => (route === '/' ? '/' : route.replace(/\/$/, '')));

const failures = [];

const parseRouteMetadata = (source, sourceName) => {
  const defaultMatch = source.match(
    /const defaultMeta(?:\s*:\s*RouteMeta)?\s*=\s*\{\s*title:\s*(['"])(.*?)\1,\s*description:\s*(['"])(.*?)\3,\s*\};/s,
  );
  const routeBlock = source.match(
    /const routeMeta(?:\s*:\s*Record<[^>]+>)?\s*=\s*\{([\s\S]*?)\n\};/,
  );
  if (!defaultMatch || !routeBlock) {
    failures.push(`Could not parse route metadata from ${sourceName}`);
    return new Map();
  }

  const metadata = new Map();
  if (/(['"])\/\1\s*:\s*defaultMeta/.test(routeBlock[1])) {
    metadata.set('/', { title: defaultMatch[2], description: defaultMatch[4] });
  }

  // `canonical` and `noindex` may precede the copy, so the pattern tolerates
  // leading keys rather than making field order load-bearing.
  const entryPattern = /(['"])(\/[^'"]*)\1\s*:\s*\{\s*(?:(?:canonical|noindex)\s*:\s*[^,]+,\s*)*title:\s*(['"])(.*?)\3,\s*description:\s*(['"])(.*?)\5,\s*\}/gs;
  for (const match of routeBlock[1].matchAll(entryPattern)) {
    metadata.set(match[2], { title: match[4], description: match[6] });
  }
  return metadata;
};

const seoMetadata = parseRouteMetadata(seo, 'components/SEO/RouteSEO.tsx');
const middlewareMetadata = parseRouteMetadata(middleware, 'functions/_middleware.js');
const seoRoutes = [...seoMetadata.keys()];

// Android parity: `ANDROID_TOOLS` lists every `PdfTool` constant in the Android app plus
// its reader surface. Each one must be claimed by exactly one catalog entry, so a tool
// added or renamed on Android fails this check until the site catalog follows.
const androidToolsBlock = catalog.match(/export const ANDROID_TOOLS = \[([\s\S]*?)\] as const;/);
const catalogEntries = [...catalog.matchAll(/\{\s*\n\s*id:\s*\d+,[\s\S]*?\n\s*\},/g)].map((match) => match[0]);

if (!androidToolsBlock) {
  failures.push('Could not find ANDROID_TOOLS in components/Tools/toolCatalog.ts');
}

const checkedInAndroidTools = androidToolsBlock
  ? [...androidToolsBlock[1].matchAll(/'([A-Z_]+)'/g)].map((match) => match[1])
  : [];

const findPdfToolFile = (projectPath) => {
  if (statSync(projectPath).isFile()) return projectPath;
  const direct = join(projectPath, 'app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/data/model/PdfTool.kt');
  if (existsSync(direct)) return direct;
  const pending = [projectPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.gradle' || entry.name === 'build' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === 'PdfTool.kt') return path;
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return null;
};

const parseAndroidTools = (source) => {
  // Constants are parsed only from the enum body, avoiding references in comments or
  // companion-object lists. This also supports enum constructors split across lines.
  const enumStart = source.match(/enum\s+class\s+PdfTool\b[^\{]*\{/);
  const companionIndex = enumStart ? source.indexOf('companion object', enumStart.index) : -1;
  const enumBody = enumStart
    ? source.slice(enumStart.index + enumStart[0].length, companionIndex === -1 ? source.length : companionIndex)
    : '';
  const enumTools = enumBody
    ? [...enumBody.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*\(/gm)].map((match) => match[1])
    : [];
  const popularity = source.match(/POPULARITY_ORDER\s*=\s*listOf\(([\s\S]*?)\n\s*\)/);
  const popularityTools = popularity
    ? [...popularity[1].matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)].map((match) => match[1])
    : [];
  const ordered = popularityTools.length > 0 ? popularityTools : enumTools;
  return [...new Set(ordered)].filter((tool) => enumTools.includes(tool));
};

let androidTools = checkedInAndroidTools;
const androidProject = process.env.PDF_CHEF_ANDROID_PROJECT?.trim();
if (androidProject) {
  const projectPath = isAbsolute(androidProject) ? androidProject : resolve(process.cwd(), androidProject);
  try {
    const pdfToolPath = findPdfToolFile(projectPath);
    if (!pdfToolPath) {
      failures.push(`Could not find PdfTool.kt under PDF_CHEF_ANDROID_PROJECT: ${projectPath}`);
    } else {
      const parsed = parseAndroidTools(readFileSync(pdfToolPath, 'utf8'));
      if (parsed.length === 0) failures.push(`Could not parse PdfTool constants from: ${pdfToolPath}`);
      androidTools = ['READER', ...parsed];
      console.log(`Android parity source: ${pdfToolPath}`);
    }
  } catch (error) {
    failures.push(`Could not read PDF_CHEF_ANDROID_PROJECT (${projectPath}): ${error.message}`);
  }
}

const claimedAndroidTools = catalogEntries
  .map((entry) => entry.match(/androidTool:\s*'([A-Z_]+)'/))
  .filter(Boolean)
  .map((match) => match[1]);

for (const androidTool of androidTools) {
  const claims = claimedAndroidTools.filter((claimed) => claimed === androidTool).length;
  if (claims === 0) failures.push(`Android tool has no site catalog entry: ${androidTool}`);
  if (claims > 1) failures.push(`Android tool is claimed by ${claims} catalog entries: ${androidTool}`);
}

for (const claimed of claimedAndroidTools) {
  if (!androidTools.includes(claimed)) {
    failures.push(`Catalog entry maps to an unknown Android tool: ${claimed}`);
  }
}

// The catalog lists shared tools in the app's own popularity order, so the two home
// screens read the same way. Compare the claim sequence, ignoring web-only entries.
if (androidTools.length === claimedAndroidTools.length) {
  const firstDivergence = claimedAndroidTools.findIndex((claimed, index) => claimed !== androidTools[index]);
  if (firstDivergence !== -1) {
    failures.push(
      `Catalog order diverges from the Android order at position ${firstDivergence + 1}: ` +
        `expected ${androidTools[firstDivergence]}, found ${claimedAndroidTools[firstDivergence]}`,
    );
  }
}

// Every entry must declare whether it actually runs in the browser, so a tool that only
// exists on Android is never presented as if it works here.
for (const entry of catalogEntries) {
  if (!/availability:\s*'(web|android-only)'/.test(entry)) {
    const name = entry.match(/name:\s*'([^']+)'/);
    failures.push(`Catalog entry is missing a valid availability: ${name ? name[1] : entry.trim()}`);
  }
}

// A sitemap advertises the URL that should rank, so it lists canonical URLs
// only. /privacy-policy, /pdf-chef-privacy and /terms-and-conditions stay live
// and keep working — they render the same component and now canonicalise onto
// /privacy and /terms — but listing them here as well would ask search engines
// to index three originals of one document.
const requiredRoutes = Array.from(new Set([
  ...catalogRoutes,
  '/',
  '/help',
  '/privacy',
  '/terms',
])).sort();

/** Live, reachable, and deliberately absent from the sitemap. */
const canonicalisedAliases = ['/privacy-policy', '/pdf-chef-privacy', '/terms-and-conditions'];

/** Device-local surfaces: reachable in the app, never a search result. */
const noindexRoutes = ['/recent', '/history', '/settings'];

for (const route of catalogRoutes) {
  if (!appRoutes.includes(route)) failures.push(`Catalog route is missing in App.tsx: ${route}`);
  if (!seoRoutes.includes(route)) failures.push(`Catalog route is missing SEO metadata: ${route}`);
}

for (const route of new Set(appRoutes.filter((path) => path !== '*'))) {
  if (!seoMetadata.has(route)) failures.push(`App route is missing SEO metadata: ${route}`);
}

for (const [route, meta] of seoMetadata) {
  const edgeMeta = middlewareMetadata.get(route);
  if (!edgeMeta) {
    failures.push(`Route SEO metadata is missing from functions/_middleware.js: ${route}`);
    continue;
  }
  if (edgeMeta.title !== meta.title) {
    failures.push(`Route title differs between RouteSEO and middleware: ${route}`);
  }
  if (edgeMeta.description !== meta.description) {
    failures.push(`Route description differs between RouteSEO and middleware: ${route}`);
  }
}

for (const route of middlewareMetadata.keys()) {
  if (!seoMetadata.has(route)) failures.push(`Middleware route metadata is missing from RouteSEO: ${route}`);
}

for (const route of requiredRoutes) {
  if (!sitemapRoutes.includes(route)) failures.push(`Required route is missing from sitemap.xml: ${route}`);
}

for (const route of [...canonicalisedAliases, ...noindexRoutes]) {
  if (sitemapRoutes.includes(route)) {
    failures.push(`Route canonicalises elsewhere or is noindex, so it must not be in sitemap.xml: ${route}`);
  }
}

// The alias must actually declare its canonical, or dropping it from the sitemap
// would simply hide a duplicate rather than resolve one.
for (const route of canonicalisedAliases) {
  if (!new RegExp(`["']${route}["']:\\s*\\{[^}]*canonical:`).test(middleware)) {
    failures.push(`Alias route is missing a canonical in _middleware.js: ${route}`);
  }
  if (!new RegExp(`["']${route}["']:\\s*\\{[^}]*canonical:`).test(seo)) {
    failures.push(`Alias route is missing a canonical in RouteSEO.tsx: ${route}`);
  }
}

// RouteSEO and the middleware are the only writers of title/description/
// canonical/robots. A page component that sets its own puts a second writer on
// the same DOM nodes, and the last effect to run wins: that is how
// /privacy-policy came to self-canonicalise while routeMeta said otherwise.
const componentDirs = ['components', 'App.tsx'];
const offenders = [];
for (const dir of componentDirs) {
  const target = resolve(root, dir);
  const files = statSync(target).isDirectory()
    ? readdirSync(target, { recursive: true }).filter((name) => String(name).endsWith('.tsx'))
        .map((name) => resolve(target, String(name)))
    : [target];
  for (const file of files) {
    const body = readFileSync(file, 'utf8');
    if (/document\.title\s*=/.test(body) || /rel="canonical"/.test(body)) {
      const relative = file.slice(resolve(root).length + 1);
      if (relative !== 'components/SEO/RouteSEO.tsx') offenders.push(relative);
    }
  }
}
for (const file of offenders) {
  failures.push(`Page metadata must only be written by RouteSEO.tsx, but this file writes it too: ${file}`);
}

for (const route of noindexRoutes) {
  if (!new RegExp(`["']${route}["']:\\s*\\{[^}]*noindex:`).test(middleware)) {
    failures.push(`Device-local route is missing noindex in _middleware.js: ${route}`);
  }
}

const duplicateCatalogRoutes = catalogRoutes.filter((route, index) => catalogRoutes.indexOf(route) !== index);
for (const route of new Set(duplicateCatalogRoutes)) {
  failures.push(`Catalog route is duplicated: ${route}`);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(
  `Verified ${catalogRoutes.length} catalog tools (${claimedAndroidTools.length} mapped to Android), ` +
    `${appRoutes.length} app routes, and ${sitemapRoutes.length} sitemap entries.`,
);
