#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(`ANDROID_DOCUMENTS: ${message}`); };
const count = (source, pattern) => [...source.matchAll(pattern)].length;

const plugin = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPlugin.java');
const coordinator = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/DocumentLifecycleCoordinator.java');
const provider = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/ReadOnlyDocumentFileProvider.java');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const releaseApp = read('android/app/src/release/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/PdfChefApplication.java');
const debugApp = read('android/app/src/debug/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/PdfChefApplication.java');
const testManifest = read('android/app/src/androidTest/AndroidManifest.xml');
const recipient = read('android/app/src/androidTest/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/DocumentRecipientProbeService.java');
const pluginRuntime = read('android/app/src/androidTest/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPluginInstrumentedTest.java');
const providerRuntime = read('android/app/src/androidTest/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentFileProviderInstrumentedTest.java');

assert(/@CapacitorPlugin\s*\(\s*name\s*=\s*"AndroidDocuments"\s*\)/.test(plugin), 'plugin name drift');
const documentMethods = [
  'readChunk', 'beginWrite', 'appendWrite', 'finishWrite', 'abortWrite',
  'listOwned', 'renameItem', 'trashOwned', 'restoreOwned', 'deleteOwned', 'clearOwned',
  'clearOwnedPayloads', 'takePendingImports',
  'acknowledgePendingImports', 'pickDocuments', 'exportItem', 'renameExport', 'shareItem',
  'openReader',
];
assert(count(plugin, /@PluginMethod\b/g) === documentMethods.length,
  'plugin must expose exactly the accepted promise methods');
for (const method of documentMethods) {
  assert(new RegExp(`@PluginMethod\\s+public\\s+void\\s+${method}\\s*\\(\\s*PluginCall\\s+call\\s*\\)`).test(plugin),
    `AndroidDocuments method missing: ${method}`);
}
for (const absent of ['stat', 'exists', 'listDocuments', 'exportDocument', 'shareDocument']) {
  assert(!new RegExp(`public\\s+void\\s+${absent}\\s*\\(`).test(plugin), `unaccepted method exposed: ${absent}`);
}
assert(plugin.includes('data.length() != 3') && plugin.includes('MAXIMUM_CHUNK_BYTES = 524_288')
  && plugin.includes('MAXIMUM_SAFE_INTEGER = 9_007_199_254_740_991L'), 'strict bounded request missing');
assert(plugin.includes('Base64.NO_WRAP') && count(plugin, /output\.put\("(?:data|nextOffset|done)"/g) === 3,
  'exact bounded response missing');
assert(!/getMessage\s*\(|printStackTrace\s*\(|\bLog\.|System\.out/.test(plugin), 'plugin detail leak');
assert(count(plugin, /getDocumentLifecycleCoordinator\(\)/g) >= 8
  && plugin.includes('private PdfChefApplication application()')
  && !/new\s+DocumentLifecycleCoordinator\s*\(/.test(plugin), 'plugin must use Application ownership only');
for (const operation of ['listOwnedDocuments()', 'renameOwnedDocument(',
  'deleteOwnedDocument(', 'clearOwnedDocuments()', 'clearOwnedDocumentPayloads()',
  'takePendingImports(', 'acknowledgePendingImports(', 'createPickerIntent(',
  'handlePickerResult(', 'PdfReaderLaunchContract.createIntent(',
  'PdfReaderLaunchContract.parseResult(', 'exportDocumentResult(', 'renameExportedDocument(', 'prepareShare(',
  'createShareContentUris(', 'createShareIntent(', 'markShareDispatched(',
  'cancelShareBeforeDispatch(']) {
  assert(plugin.includes(operation), `activated document operation missing: ${operation}`);
}
const readerResult = plugin.slice(plugin.indexOf('private void readerResult'),
  plugin.indexOf('static boolean launchAccepted'));
assert(readerResult.includes('output.put("action", result.action())')
  && readerResult.includes('output.put("toolPath", result.toolPath())')
  && !/put\("(?:uri|path|provider|bytes|password|exception)"/.test(readerResult),
  'openReader result must remain closed or allowlisted tool action only');

assert(/public\s+synchronized\s+ReadChunk\s+readChunk\s*\(\s*String\s+ref\s*,\s*long\s+offset\s*,\s*int\s+length\s*\)/.test(coordinator), 'coordinator read facade missing');
assert(coordinator.includes('graph().legacyResolver.readChunk') && coordinator.includes('graph().writer.source'),
  'both accepted ref families must be routed');
assert(coordinator.includes('public byte[] bytes() { return bytes.clone(); }'), 'chunk bytes must clone');
assert(!/static\s+(?:final\s+)?DocumentLifecycleCoordinator/.test(coordinator), 'static coordinator forbidden');
for (const app of [releaseApp, debugApp]) {
  assert(count(app, /new DocumentLifecycleCoordinator\(this\)/g) === 1, 'variant coordinator count drift');
  assert(count(app, /return documentLifecycleCoordinator;/g) === 1, 'variant coordinator getter drift');
  assert(!/\bonCreate\s*\(|getFilesDir\s*\(/.test(app), 'Application I/O/lifecycle work forbidden');
}

const providerTags = [...manifest.matchAll(
  /<provider\b[^>]*android:name="\.documents\.ReadOnlyDocumentFileProvider"[^>]*>/g,
)];
assert(providerTags.length === 1
  && providerTags[0][0].includes('android:authorities="${applicationId}.fileprovider"')
  && providerTags[0][0].includes('android:exported="false"')
  && providerTags[0][0].includes('android:grantUriPermissions="true"'),
  'provider manifest contract drift');
assert(provider.includes('extends FileProvider') && provider.includes('if (!"r".equals(mode))')
  && count(provider, /throw new SecurityException\("Read-only document provider"\)/g) === 4,
  'provider is not fail-closed read-only');
assert(hash('android/app/src/main/res/xml/file_paths.xml') ===
  'ef9f6c8b2cdd1e50d964eae3057e9d33aa404939e4ababdd72499bf50a4326f5',
  'narrow provider XML drift');
assert(testManifest.includes('DocumentRecipientProbeService')
  && testManifest.includes('android:exported="true"')
  && testManifest.includes('android:process=":recipient"'), 'test-only recipient manifest drift');
assert(!manifest.includes('DocumentRecipientProbeService'), 'recipient must not enter target manifest');
for (const operation of ['READ', 'WRITE', 'TRUNCATE', 'INSERT', 'UPDATE', 'DELETE']) {
  assert(recipient.includes(`public static final String ${operation}`), `recipient probe missing ${operation}`);
}
for (const proof of ['a1_920040', "isPluginAvailable('AndroidDocuments')",
  'getDocumentLifecycleCoordinator()', 'DOCUMENT_INVALID_ARGUMENT',
  'AndroidDocuments.beginWrite', 'AndroidDocuments.appendWrite',
  'AndroidDocuments.finishWrite', 'AndroidDocuments.abortWrite',
  'AndroidDocuments.renameItem',
  'AndroidDocuments.exportItem', 'AndroidDocuments.shareItem',
  'nativeExportAndShareCompleteWithoutBridgeAddresses']) {
  assert(pluginRuntime.includes(proof), `bridge runtime proof missing ${proof}`);
}
for (const proof of ['assertNotEquals("recipient must be a separate UID"',
  'FileProvider.getUriForFile', 'createShareIntent', 'FLAG_GRANT_READ_URI_PERMISSION',
  'revokeUriPermission', '%2e%2e%2f']) {
  assert(providerRuntime.includes(proof), `provider runtime proof missing ${proof}`);
}

console.log('ANDROID_DOCUMENTS_VERIFIER: PASS');
console.log(`ANDROID_DOCUMENTS_SURFACE: ${documentMethods.join(', ')}; a1_, d1_, and w1_; one lazy Application owner`);
console.log('PRODUCTION_RELEASE_READY: NO');
