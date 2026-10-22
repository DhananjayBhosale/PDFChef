#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`ANDROID_READER_BACKEND: ${message}`);
};
const count = (source, pattern) => [...source.matchAll(pattern)].length;

const paths = {
  build: 'android/app/build.gradle',
  manifest: 'android/app/src/main/AndroidManifest.xml',
  host: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/MainActivity.java',
  plugin: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPlugin.java',
  coordinator: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/DocumentLifecycleCoordinator.java',
  pending: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/OwnedPendingImportStore.java',
  owned: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/OwnedDocumentWriter.java',
  legacy: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/LegacyDocumentOpenResolver.java',
  contract: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/reader/PdfReaderLaunchContract.java',
  session: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/reader/PdfReaderDocumentSession.java',
  actions: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/reader/PdfReaderActions.java',
  activity: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/reader/PdfReaderActivity.java',
  documentsClient: 'services/platform/android/androidDocuments.ts',
  readerClient: 'services/platform/android/androidPdfReader.ts',
  workspace: 'services/platform/android/androidWorkspacePlatform.ts',
  recent: 'components/Pages/RecentPage.tsx',
};

const build = read(paths.build);
assert(/compileSdk\s*\{\s*version\s*=\s*release\(36\)\s*\{\s*minorApiLevel\s*=\s*1\s*\}\s*\}/s.test(build),
  'compile SDK must remain Android 36.1 (extension 20)');
assert(count(build, /androidx\.pdf:pdf-viewer-fragment:1\.0\.0-beta01/g) === 1
  && count(build, /androidx\.pdf:pdf-viewer-fragment:/g) === 1,
  'the AndroidX PDF dependency must be exactly one beta01 fragment coordinate');
assert(!/composeOptions|buildFeatures\s*\{[^}]*compose\s+true|androidx\.compose/.test(build),
  'reader activation must not add a Compose shell');

const manifest = read(paths.manifest);
const readerTags = [...manifest.matchAll(
  /<activity\b[^>]*android:name="\.reader\.PdfReaderActivity"[^>]*>/g,
)];
assert(readerTags.length === 1, 'manifest must declare exactly one PdfReaderActivity');
const readerTag = readerTags[0][0];
for (const required of [
  'android:exported="false"',
  'android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|screenLayout|navigation"',
  'android:theme="@style/PdfReaderTheme"',
  'android:windowSoftInputMode="adjustResize"',
]) assert(readerTag.includes(required), `reader manifest invariant missing ${required}`);
assert(/\/>\s*$/.test(readerTag)
  && !/android:(?:process|permission|taskAffinity|launchMode|screenOrientation)=/.test(readerTag),
  'reader Activity must have no filter, process, permission, task, launch, or orientation broadening');
assert(count(manifest, /<provider\b/g) === 1
  && manifest.includes('android:name=".documents.ReadOnlyDocumentFileProvider"'),
  'reader must reuse the one existing private read-only provider');

const contract = read(paths.contract);
for (const invariant of [
  'ACTIVITY_CLASS_NAME', 'new ComponentName(context.getPackageName(), ACTIVITY_CLASS_NAME)',
  'EXTRA_REF', 'EXTRA_DISPLAY_NAME', 'EXTRA_INITIAL_ACTION',
  'INITIAL_ACTION_VERIFY_SIGNATURES', 'createSignatureVerificationIntent',
  'requestsSignatureVerification', 'ACTION_CLOSED', 'ACTION_TOOL',
  'data.getAction() != null', 'data.getData() != null', 'data.getClipData() != null',
  'LEGACY_REF', 'OWNED_REF', 'TOOL_PATHS.contains(toolPath)',
]) assert(contract.includes(invariant), `reader launch allowlist missing ${invariant}`);
assert(count(contract, /intent\.putExtra\(/g) === 3,
  'reader launch request may add only the allowlisted signature-verification action');

const plugin = read(paths.plugin);
const documentMethods = [
  'readChunk', 'beginWrite', 'appendWrite', 'finishWrite', 'abortWrite',
  'listOwned', 'renameItem', 'trashOwned', 'restoreOwned', 'deleteOwned', 'clearOwned',
  'clearOwnedPayloads', 'takePendingImports',
  'acknowledgePendingImports', 'pickDocuments', 'exportItem', 'renameExport', 'shareItem',
  'openReader',
];
assert(count(plugin, /@PluginMethod\b/g) === documentMethods.length
  && documentMethods.every(method => new RegExp(`public\\s+void\\s+${method}\\s*\\(`).test(plugin)),
  'AndroidDocuments must expose the accepted document/picker surface');
for (const invariant of [
  'private static final AtomicBoolean READER_LAUNCH_ACTIVE',
  'startActivityForResult(call,', 'PdfReaderLaunchContract.createIntent(', '"readerResult"',
  'launchAccepted(call.isReleased()', 'releaseReaderLaunch()',
  'PdfReaderLaunchContract.parseResult(', 'output.put("action", result.action())',
]) assert(plugin.includes(invariant), `openReader single-flight invariant missing ${invariant}`);
const readerResult = plugin.slice(plugin.indexOf('private void readerResult'),
  plugin.indexOf('static boolean launchAccepted'));
assert(readerResult.includes('output.put("toolPath", result.toolPath())')
  && !/put\("(?:uri|path|provider|bytes|password|exception)"/.test(readerResult),
  'reader result may expose only closed or allowlisted tool action');

const session = read(paths.session);
for (const invariant of [
  'MAXIMUM_DOCUMENT_BYTES = 256L * 1024L * 1024L',
  'COPY_CHUNK_BYTES = 512 * 1024', 'stream.limit(RECOVERY_BATCH_LIMIT + 1L)',
  'byte[] reusableWindow = new byte[COPY_CHUNK_BYTES]',
  'makeReadOnly(part)', 'fsyncFile(part)', 'StandardCopyOption.ATOMIC_MOVE',
  'isReadOnly(complete)', 'deleteVerified(snapshot)', 'fsyncDirectory(snapshot.getParent())',
  'Thread.currentThread().isInterrupted()',
]) assert(session.includes(invariant), `private reader-session invariant missing ${invariant}`);
assert(count(session, /source\.read\(/g) === 1
  && session.indexOf('makeReadOnly(part)') < session.indexOf('StandardCopyOption.ATOMIC_MOVE'),
  'reader snapshot must use one bounded source pass and publish read-only bytes atomically');
assert(!/readAllBytes|Files\.copy\(|FileOutputStream/.test(session),
  'reader snapshot must not introduce an unbounded or second copy primitive');

const owned = read(paths.owned);
for (const invariant of [
  'DocumentSource readerSource(String ref)', 'new OwnedReaderSource(path, identity, document)',
  'offset != consumed', 'digest.update(target, 0, total)',
  'hex(digest.digest()).equals(document.contentHash)', 'sameIdentity(identity, attributes(path))',
  'FileChannel.open(path, StandardOpenOption.READ', 'LinkOption.NOFOLLOW_LINKS',
  'AFTER_OWNED_READER_SOURCE_READ',
]) assert(owned.includes(invariant), `owned-reader one-pass validation missing ${invariant}`);
for (const invariant of [
  'loadMetadataForImmediateValidation(ref)',
  'BasicFileAttributes identityBeforeDigest = attributes(source)',
  'sameIdentity(identityBeforeDigest, verifiedIdentity)',
  'sameIdentity(verifiedIdentity, movedIdentity)',
]) assert(owned.includes(invariant), `pending promotion one-pass invariant missing ${invariant}`);
const pending = read(paths.pending);
assert(pending.includes('PendingImportRecord loadMetadataForImmediateValidation(String ref)')
  && pending.includes('return readMetadata(record, layout.dataPath(ref), ref)')
  && pending.includes('requireRegularFile(dataPath, record.sizeBytes())'),
  'metadata-only retain read must preserve record and structural validation');
const ownedReader = owned.slice(owned.indexOf('private final class OwnedReaderSource'),
  owned.indexOf('static final class Failure'));
assert(count(ownedReader, /FileChannel\.open\(/g) === 1
  && count(ownedReader, /channel\.read\(/g) === 1,
  'd1 reader source must pin one channel and validate during the same sequential pass');

const coordinator = read(paths.coordinator);
const prepareReader = coordinator.slice(coordinator.indexOf('public PdfReaderDocumentSession prepareReader'),
  coordinator.indexOf('public synchronized DocumentRecord retainPending'));
assert(prepareReader.indexOf('synchronized (this)') >= 0
  && prepareReader.indexOf('PdfReaderDocumentSession.prepareForCoordinator')
    > prepareReader.indexOf('filesDir = graph.filesDir;\n            }'),
  'snapshot copy must run after the narrow coordinator resolution lock');
for (const fixed of [
  'DOCUMENT_LIMIT_EXCEEDED', 'DOCUMENT_STORAGE_FULL', 'DOCUMENT_INTERRUPTED', 'DOCUMENT_CANCELLED',
]) assert(coordinator.includes(`"${fixed}".equals(code)`), `fixed reader failure mapping missing ${fixed}`);
assert(prepareReader.includes('finally {') && prepareReader.includes('source.close()'),
  'the pinned owned or legacy source must close on every reader preparation path');

const legacy = read(paths.legacy);
const legacySource = legacy.slice(legacy.indexOf('private final class ResolvedSource'),
  legacy.indexOf('private static void closeQuietly'));
for (const invariant of [
  'private final FileChannel channel', 'FileChannel.open(resolved.path, StandardOpenOption.READ',
  'channel.read(buffer, offset + total)', 'resolved.identity.requireSame(attributes(resolved.path))',
  'closeQuietly(channel)',
]) assert(legacySource.includes(invariant), `legacy-reader pinned-source invariant missing ${invariant}`);
assert(count(legacySource, /FileChannel\.open\(/g) === 1,
  'a1 reader source must open exactly one channel for all sequential windows');

const actions = read(paths.actions);
for (const invariant of [
  'Executors.newSingleThreadExecutor', 'if (busy)', 'activity.startActivity(',
  'coordinator.markShareDispatched', 'chooserLaunched ? null : preparedHandle',
  'executor.shutdownNow()',
]) assert(actions.includes(invariant), `reader share lifecycle missing ${invariant}`);

const activity = read(paths.activity);
for (const invariant of [
  'public final class PdfReaderActivity extends AppCompatActivity',
  'setResult(RESULT_OK, PdfReaderLaunchContract.closedResultIntent())',
  'coordinator.prepareReader(requestedRef, requestedName)', 'Executors.newSingleThreadExecutor()',
  'extends PdfViewerFragment', 'fragment.setDocumentUri(staged.documentUri())',
  'new PdfReaderSearchEngine(getApplicationContext()).search(',
  'activeSession.snapshotForVerification()', 'executor.submit(() ->',
  'document.getPageCount()', 'pdfView.addOnViewportChangedListener',
  'actions.share(ref', 'PdfReaderLaunchContract.toolResultIntent(path)',
  'viewer.setToolboxVisible(false)', 'R.string.pdf_reader_search_unavailable',
  'onRetainCustomNonConfigurationInstance()', 'onConfigurationChanged(@NonNull Configuration newConfig)',
  'super.onConfigurationChanged(newConfig);', 'dismissTools();',
]) assert(activity.includes(invariant), `native reader affordance missing ${invariant}`);
assert(activity.indexOf('setResult(RESULT_OK, PdfReaderLaunchContract.closedResultIntent())')
  < activity.indexOf('prepareDocument();'),
  'closed must be the default Activity result before asynchronous preparation');
for (const forbidden of ['PluginCall', 'put("uri"', 'put("path"', 'put("bytes"',
  'put("password"', 'getMessage()', 'printStackTrace', 'android.util.Log']) {
  assert(!activity.includes(forbidden), `reader Activity bridge/detail leak: ${forbidden}`);
}

const host = read(paths.host);
for (const invariant of [
  'public void onStart()', 'webView.onResume()',
  'public void onStop()', 'webView.onPause()',
]) assert(host.includes(invariant), `host reader-background lifecycle missing ${invariant}`);
assert(!host.includes('pauseTimers()') && !host.includes('resumeTimers()'),
  'reader backgrounding must not mutate process-global WebView timers');

const documentsClient = read(paths.documentsClient);
const readerClient = read(paths.readerClient);
const workspace = read(paths.workspace);
const recent = read(paths.recent);
assert(documentsClient.includes("registerPlugin<AndroidDocumentsNativePlugin>('AndroidDocuments')")
  && documentsClient.includes('initialAction?: \'verify-signatures\'')
  && documentsClient.includes("{ action: 'closed' }")
  && documentsClient.includes("action: 'tool'"),
  'strict TypeScript AndroidDocuments reader adapter missing');
for (const invariant of [
  'const LEGACY_REF = /^a1_', 'const OWNED_REF = /^d1_',
  "document.mimeType === 'application/pdf'", 'MAXIMUM_NATIVE_PDF_BYTES = 256 * 1024 * 1024',
  'isAndroidDocumentsAvailable()', 'supportsSignatureVerification: true',
  'documents.openReader(document.ref, safeName(document), options?.initialAction)',
]) assert(readerClient.includes(invariant), `native reader eligibility invariant missing ${invariant}`);
assert(workspace.includes("if (!documentsOverride && Capacitor.getPlatform() !== 'android') return platformWithDeviceFacts;")
  && workspace.includes('if (isAndroidNativePdfReaderAvailable())')
  && workspace.includes('platform.pdfReader = createAndroidPdfReaderService(documents)'),
  'native reader must compose through the Android workspace only after bridge discovery');
assert(recent.includes('reader.isEligible(document)')
  && recent.includes('const file = await platform.reopen(record)')
  && recent.includes("navigate('/view')")
  && recent.includes('if (result.action !== \'closed\')'),
  'Recent must dispatch durable PDFs natively and preserve the web fallback');

console.log('ANDROID_READER_BACKEND_VERIFIER: PASS');
console.log('READER_DISPATCH: durable bounded a1_/d1_ PDF -> private AndroidX reader; transient File -> PDF.js');
console.log('BRIDGE_PRIVACY: closed | allowlisted toolPath only; no URI/path/provider/bytes/password/error detail');
console.log('RUNTIME_READER_DISCOVERY: NOT_CHECKED');
console.log('PRODUCTION_RELEASE_READY: REQUIRES_BUILD_AND_RUNTIME_GATES');
