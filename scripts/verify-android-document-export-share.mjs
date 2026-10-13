#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`ANDROID_EXPORT_SHARE: ${message}`);
};
const count = (source, pattern) => [...source.matchAll(pattern)].length;

const plugin = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPlugin.java');
const coordinator = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/DocumentLifecycleCoordinator.java');
const exporter = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentExporter.java');
const sharer = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentSharer.java');
const client = read('services/platform/android/androidDocuments.ts');
const workspace = read('services/platform/android/androidWorkspacePlatform.ts');
const pluginTest = read('android/app/src/test/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPluginContractTest.java');
const clientTest = read('tests/platform/androidDocuments.test.ts');
const workspaceTest = read('tests/platform/androidWorkspacePlatform.test.ts');
const runtimeTest = read('android/app/src/androidTest/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPluginInstrumentedTest.java');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const packagedIndex = read('android/app/src/main/assets/public/index.html');
const packagedMainMatch = packagedIndex.match(/src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/);
assert(packagedMainMatch !== null, 'Android packaged main bundle is missing');
const packagedMain = read(`android/app/src/main/assets/public/assets/${packagedMainMatch[1]}`);

const methods = [
  'readChunk', 'beginWrite', 'appendWrite', 'finishWrite', 'abortWrite',
  'listOwned', 'renameItem', 'trashOwned', 'restoreOwned', 'deleteOwned', 'clearOwned',
  'clearOwnedPayloads', 'takePendingImports',
  'acknowledgePendingImports', 'pickDocuments', 'exportItem', 'shareItem', 'openReader',
];
assert(count(plugin, /@PluginMethod\b/g) === methods.length
  && methods.every(method => new RegExp(
    `@PluginMethod\\s+public\\s+void\\s+${method}\\s*\\(\\s*PluginCall\\s+call\\s*\\)`,
  ).test(plugin)), 'exact AndroidDocuments activation surface drift');

for (const invariant of [
  'data.length() < 1 || data.length() > 3',
  'data.length() != 1 + (hasDisplayName ? 1 : 0) + (hasMimeType ? 1 : 0)',
  'PdfReaderLaunchContract.isCanonicalRef(ref)',
  'AndroidDocumentIngressPolicy.isSupportedMimeType(mimeType)',
  'OwnedDocumentWritePolicy.isValidDisplayName(displayName)',
  'execute(() -> completeExportItem(call, request))',
  'execute(() -> completeShareItem(call, request))',
  'call.resolve(deliveryStatus("completed"))',
]) assert(plugin.includes(invariant), `strict bridge invariant missing: ${invariant}`);
assert(count(plugin, /output\.put\("status", status\)/g) === 1,
  'delivery response must contain only terminal status');
assert(!/put\("(?:uri|path|provider|filename|bytes|exception)"/.test(plugin),
  'private delivery address crossed the bridge');

const shareLaunch = plugin.slice(plugin.indexOf('private void launchPreparedShare'),
  plugin.indexOf('private void scheduleShareCancellation'));
assert(shareLaunch.indexOf('activity.startActivity(Intent.createChooser(send, null))')
  < shareLaunch.indexOf('coordinator.markShareDispatched(handle)'),
  'share must mark dispatched only after chooser launch');
assert(shareLaunch.includes('call.resolve(deliveryStatus("completed"))')
  && shareLaunch.includes('The bounded stage remains until expiry'),
  'chooser launch must be the honest completion boundary');
assert(plugin.includes('appendQueryParameter("displayName", request.displayName())')
  && plugin.includes('cancelShareBeforeDispatch(handle)'),
  'validated name metadata or prelaunch cleanup is missing');

for (const nativeCall of [
  'exportDocument(', 'prepareShare(', 'createShareContentUri(', 'createShareIntent(',
  'markShareDispatched(', 'cancelShareBeforeDispatch(',
]) assert(coordinator.includes(nativeCall), `coordinator delivery API missing: ${nativeCall}`);
assert(exporter.includes('MediaStore.Downloads.IS_PENDING, 1')
  && exporter.includes('MediaStore.Downloads.IS_PENDING, 0')
  && exporter.includes('PublicationState.UNKNOWN')
  && exporter.includes('DOCUMENT_DURABILITY_UNCERTAIN')
  && exporter.includes('output.force()'), 'MediaStore durability contract drift');
assert(sharer.includes('new Intent(Intent.ACTION_SEND)')
  && sharer.includes('intent.setClipData(ClipData.newRawUri')
  && sharer.includes('intent.setFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)')
  && !sharer.includes('FLAG_GRANT_WRITE_URI_PERMISSION')
  && !sharer.includes('FLAG_GRANT_PERSISTABLE_URI_PERMISSION')
  && !sharer.includes('FLAG_GRANT_PREFIX_URI_PERMISSION'),
  'read-only share intent contract drift');
assert(manifest.includes('android:name=".documents.ReadOnlyDocumentFileProvider"')
  && manifest.includes('android:exported="false"')
  && manifest.includes('android:grantUriPermissions="true"'),
  'narrow existing FileProvider registration drift');

for (const invariant of [
  'exportItem(options:', 'shareItem(options:',
  "return this.deliver('exportItem'", "return this.deliver('shareItem'",
  "method: 'exportItem' | 'shareItem'", "exactObject(await this.native[method](options), ['status'])",
  "result.status !== 'completed' && result.status !== 'cancelled'",
]) assert(client.includes(invariant), `strict TypeScript client invariant missing: ${invariant}`);

const saveSlice = workspace.slice(workspace.indexOf('async save(record, name)'),
  workspace.indexOf('async reopen(record)'));
assert(saveSlice.includes('documents.exportItem(') && saveSlice.includes('documents.shareItem('),
  'durable Android records must use native delivery');
assert(!saveSlice.includes('nativeBlob(') && !saveSlice.includes('readChunk(')
  && !saveSlice.includes('saveFresh(') && !saveSlice.includes('shareFresh('),
  'native delivery must not materialize document bytes in the WebView');
assert(saveSlice.includes('return base.save(record, name)')
  && saveSlice.includes('return base.share(record, name)'),
  'browser/session delivery fallback drift');
assert(packagedMain.includes('exportItem') && packagedMain.includes('shareItem'),
  'Android packaged workspace bundle does not contain the native delivery dispatch');

for (const proof of [
  'deliveryRequestIsExactOpaqueAndUsesSafeDefaults',
  'native export and share use exact opaque metadata and strict terminal status',
  'durable Android save and share stay native while browser records keep base delivery',
  'native delivery must not materialize bridge bytes',
]) assert(pluginTest.includes(proof) || clientTest.includes(proof) || workspaceTest.includes(proof),
  `focused proof missing: ${proof}`);
for (const proof of [
  'nativeExportAndShareCompleteWithoutBridgeAddresses',
  'Capacitor.Plugins.AndroidDocuments.exportItem',
  'Capacitor.Plugins.AndroidDocuments.shareItem',
  'findDownload(context, exportName)',
  'assertArrayEquals(bytes, input.readAllBytes())',
  'findDownload(context, legacyExportName)',
  'assertArrayEquals(legacyBytes, input.readAllBytes())',
  "'a1_920903'",
  "uri:'content://private'",
]) assert(runtimeTest.includes(proof), `runtime proof missing: ${proof}`);

console.log('ANDROID_DOCUMENT_EXPORT_SHARE_VERIFIER: PASS');
console.log('NATIVE_DELIVERY: durable a1_/d1_ -> MediaStore export or read-only chooser; browser/session -> existing web path');
console.log('BRIDGE_PRIVACY: terminal status only; no URI/path/provider/filename/bytes/exception');
console.log('PHYSICAL_DEVICE_SIGNING_PLAY_PRODUCTION: NOT_CHECKED');
