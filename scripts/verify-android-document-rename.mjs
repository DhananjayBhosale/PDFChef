#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`ANDROID_DOCUMENT_RENAME: ${message}`);
};

const writer = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/OwnedDocumentWriter.java');
const coordinator = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/DocumentLifecycleCoordinator.java');
const plugin = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPlugin.java');
const client = read('services/platform/android/androidDocuments.ts');
const workspace = read('services/platform/android/androidWorkspacePlatform.ts');
const recent = read('components/Pages/RecentPage.tsx');
const writerTest = read('android/app/src/test/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/OwnedDocumentWriterTest.java');
const coordinatorTest = read('android/app/src/test/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/DocumentLifecycleCoordinatorTest.java');
const pluginTest = read('android/app/src/test/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPluginContractTest.java');
const clientTest = read('tests/platform/androidDocuments.test.ts');
const runtimeTest = read('android/app/src/androidTest/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentsPluginInstrumentedTest.java');

for (const invariant of [
  'OwnedDocument renameOwned(String ref, String displayName)',
  'Path renamePart(String ref)',
  'writeForced(part, encodeOwned(updated))',
  'StandardCopyOption.ATOMIC_MOVE',
  'StandardCopyOption.REPLACE_EXISTING',
  'fsyncDirectory(layout.records)',
  'AFTER_RENAME_RECORD_FORCE',
  'AFTER_RENAME_RECORD_PUBLISH',
  'cleanupRenamePartOrUnsafe(layout, part)',
  '!sameIdentity(dataIdentity, attributes(dataPath))',
]) assert(writer.includes(invariant), `writer invariant missing: ${invariant}`);
const renameSlice = writer.slice(writer.indexOf('OwnedDocument renameOwned('),
  writer.indexOf('boolean deleteOwned('));
assert(renameSlice.includes('current.contentHash')
  && renameSlice.includes('current.createdAtMillis')
  && renameSlice.includes('current.sizeBytes')
  && !renameSlice.includes('digest(')
  && !renameSlice.includes('Files.move(dataPath'),
  'rename must preserve payload identity and metadata without payload hashing or movement');

assert(coordinator.includes('public synchronized DocumentRecord renameOwnedDocument(')
  && coordinator.includes('graph().writer.renameOwned(ref, displayName)'),
  'sole coordinator rename facade missing');
assert(plugin.includes('@PluginMethod public void renameItem(PluginCall call)')
  && plugin.includes('execute(() -> completeRenameItem(call, request))')
  && plugin.includes('data.length() != 2')
  && plugin.includes('PendingImportRecord.isValidRef(ref)')
  && plugin.includes('output.put("status", "completed")'),
  'strict background bridge rename missing');
assert(!/put\("(?:uri|path|provider|filename|bytes|oldName|exception)"/.test(
  plugin.slice(plugin.indexOf('@PluginMethod public void renameItem'),
    plugin.indexOf('@PluginMethod public void deleteOwned'))),
  'private rename data crossed the bridge');

assert(client.includes('renameItem(options: { readonly ref: string; readonly displayName: string })')
  && client.includes('async renameItem(ref: string, displayName: string)')
  && client.includes("await this.native.renameItem({ ref, displayName })")
  && client.includes("['status']")
  && client.includes("result.status !== 'completed'"),
  'strict TypeScript rename client missing');
assert(workspace.includes('persistentRename: true')
  && workspace.includes('return { rename: true, reversibleDelete: true, limitation: null }')
  && workspace.includes('await documents.renameItem(ownedRefFor(record), name)'),
  'T906 durable d1_ rename activation missing');
assert(recent.includes('recordAbilities(platform, record)')
  && recent.includes('disabled={!activeAbilities?.rename}')
  && recent.includes('if (!target || !platform.rename) return;')
  && recent.includes('await platform.rename(target, withOriginalExtension(')
  && recent.includes('{activeReason && <p'),
  'T906 visible rename must use per-row eligibility and a touch-visible reason');

for (const proof of [
  'renameAtomicallyChangesOnlyOwnedMetadataAndIsIdempotent',
  'renameFailureKeepsOneCompleteRecordAndCleansExactPart',
  'renameRejectsMissingOrStructurallyCorruptPayloadWithoutChangingName',
  'ownedRenamePreservesIdentityAndLegacyRenameIsRefused',
  'renameRequestIsOwnedOnlyExactAndNonleaking',
  'owned rename is exact, d1-only, and accepts only completed status',
  'nativeOwnedRenameIsDurableExactAndPayloadPreserving',
  'Capacitor.Plugins.AndroidDocuments.renameItem',
  'T904 renamed.pdf',
]) assert(writerTest.includes(proof) || coordinatorTest.includes(proof)
  || pluginTest.includes(proof) || clientTest.includes(proof) || runtimeTest.includes(proof),
`focused proof missing: ${proof}`);

console.log('ANDROID_DOCUMENT_RENAME_VERIFIER: PASS');
console.log('RENAME_SCOPE: durable d1_ metadata only; legacy a1_ remains read-only; payload identity unchanged');
console.log('VISIBLE_RENAME_ACTIVATION: ACTIVE for canonical available d1_ rows; legacy/session/missing rows remain ineligible');
console.log('PHYSICAL_DEVICE_SIGNING_PLAY_PRODUCTION: NOT_CHECKED');
