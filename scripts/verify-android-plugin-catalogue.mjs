#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const assert = (condition, message) => { if (!condition) throw new Error(`ANDROID_PLUGIN_CATALOGUE: ${message}`); };

const sourceExtensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs'];
const resolveSource = (fromFile, specifier) => {
  let base;
  if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else if (specifier.startsWith('@/')) base = resolve(root, specifier.slice(2));
  else if (specifier === 'framer-motion') base = resolve(root, 'lib/framer-motion-shim.tsx');
  else return null;

  const insideRoot = candidate => {
    const path = relative(root, candidate);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  const candidates = [
    ...sourceExtensions.map(extension => `${base}${extension}`),
    ...sourceExtensions.slice(1).map(extension => resolve(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (insideRoot(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`ANDROID_PLUGIN_CATALOGUE: unresolved local module ${specifier}`);
};

const productionEntryGraph = entry => {
  const pending = [resolve(root, entry)];
  const visited = new Set();
  const importPatterns = [
    /\bimport\s+(?:type\s+)?[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const dependency = resolveSource(file, match[1]);
        if (dependency !== null && !visited.has(dependency)) pending.push(dependency);
      }
    }
  }
  return visited;
};
const activity = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/MainActivity.java');
const plugin = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPlugin.java');
const entries = [
  'registerPlugin(AndroidLegacyInspectorPlugin.class)',
  'registerPlugin(AndroidLegacySettingsWriterPlugin.class)',
  'registerPlugin(AndroidAppMetadataPlugin.class)',
  'registerPlugin(AndroidStorageStatsPlugin.class)',
  'registerPlugin(AndroidDocumentsPlugin.class)',
  'registerPlugin(AndroidDocumentScannerPlugin.class)',
  'registerPlugin(AndroidSupportPlugin.class)',
  'super.onCreate(savedInstanceState)',
];
const positions = entries.map(entry => activity.indexOf(entry));
assert(positions.every(value => value >= 0), 'accepted registration missing');
assert(positions.every((value, index) => index === 0 || value > positions[index - 1]), 'registration order drift');
assert((activity.match(/registerPlugin\(/g) ?? []).length === 7, 'registration count drift');
for (const entry of entries.slice(0, 7)) assert(activity.split(entry).length - 1 === 1, `duplicate ${entry}`);
const documentMethods = [
  'readChunk', 'beginWrite', 'appendWrite', 'finishWrite', 'abortWrite',
  'listOwned', 'renameItem', 'trashOwned', 'restoreOwned', 'deleteOwned', 'clearOwned',
  'clearOwnedPayloads', 'takePendingImports',
  'acknowledgePendingImports', 'pickDocuments', 'exportItem', 'renameExport', 'shareItem',
  'openReader',
];
assert((plugin.match(/@PluginMethod\b/g) ?? []).length === documentMethods.length
  && documentMethods.every(method => new RegExp(`public\\s+void\\s+${method}\\s*\\(`).test(plugin)),
  'AndroidDocuments surface drift');
const entryGraph = productionEntryGraph('index.tsx');
const androidDocumentsClient = resolve(root, 'services/platform/android/androidDocuments.ts');
const scannerClient = resolve(root, 'services/platform/android/androidDocumentScanner.ts');
const readerClient = resolve(root, 'services/platform/android/androidPdfReader.ts');
const metadataClient = resolve(root, 'services/platform/android/androidAppMetadata.ts');
const storageClient = resolve(root, 'services/platform/android/androidStorageStats.ts');
const workspaceComposition = resolve(root, 'services/platform/android/androidWorkspacePlatform.ts');
const supportClient = resolve(root, 'services/platform/android/androidSupport.ts');
for (const [file, label] of [
  [androidDocumentsClient, 'AndroidDocuments'],
  [scannerClient, 'AndroidDocumentScanner'],
  [readerClient, 'AndroidPdfReader'],
  [metadataClient, 'AndroidAppMetadata'],
  [storageClient, 'AndroidStorageStats'],
  [workspaceComposition, 'Android workspace composition'],
  [supportClient, 'AndroidSupport'],
]) {
  assert(entryGraph.has(file), `${label} must enter the activated production graph`);
}
const documentConsumers = [...entryGraph]
  .filter(file => file !== androidDocumentsClient)
  .filter(file => readFileSync(file, 'utf8').includes('AndroidDocuments'))
  .map(file => relative(root, file))
  .sort();
assert(JSON.stringify(documentConsumers) === JSON.stringify([
  'components/Layout/AndroidIncomingPdfHandler.tsx',
  'services/platform/android/androidPdfReader.ts',
  'services/platform/android/androidWorkspacePlatform.ts',
]), `AndroidDocuments composition drifted: ${documentConsumers.join(', ')}`);
const workspace = readFileSync(workspaceComposition, 'utf8');
assert(workspace.includes("if (!documentsOverride && Capacitor.getPlatform() !== 'android') return platformWithDeviceFacts;")
  && workspace.includes('getApplicationMetadata: () => metadata.getMetadata()')
  && workspace.includes('getStorageInformation: () => storage.getStorageStats()')
  && workspace.includes('platform.documentScanner = createAndroidDocumentScannerService()')
  && workspace.includes('platform.pdfReader = createAndroidPdfReaderService(documents)'),
  'device facts, scanner and reader must compose only through the Android workspace platform');
const runtime = read('android/app/src/androidTest/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPluginInstrumentedTest.java');
for (const pluginName of ['AndroidLegacyInspector', 'AndroidLegacySettingsWriter', 'AndroidDocuments']) {
  assert(runtime.includes(`getPlugin("${pluginName}")`) && runtime.includes(`isPluginAvailable('${pluginName}')`),
    `runtime catalogue proof missing ${pluginName}`);
}
const deviceFactsRuntime = read('android/app/src/androidTest/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/AndroidSettingsDeviceFactsInstrumentedTest.java');
for (const pluginName of ['AndroidAppMetadata', 'AndroidStorageStats']) {
  assert(deviceFactsRuntime.includes(`getPlugin("${pluginName}")`)
    && deviceFactsRuntime.includes(`isPluginAvailable('${pluginName}')`),
  `runtime catalogue proof missing ${pluginName}`);
}
console.log('ANDROID_PLUGIN_CATALOGUE_VERIFIER: PASS');
console.log(`CATALOGUE: AndroidLegacyInspector -> AndroidLegacySettingsWriter -> AndroidAppMetadata(getMetadata) -> AndroidStorageStats(getStorageStats) -> AndroidDocuments(${documentMethods.join(', ')}) -> AndroidDocumentScanner(scan) -> AndroidSupport(getSupport, support, manageSupport)`);
console.log(`FRONTEND_ENTRY_GRAPH: ${entryGraph.size} modules; device facts, scanner and reader activated behind native discovery`);
console.log('SCANNER_RUNTIME_DISCOVERY: NOT_CHECKED; reserved for disposable-emulator gate');
console.log('PRODUCTION_RELEASE_READY: REQUIRES_BUILD_AND_RUNTIME_GATES');
