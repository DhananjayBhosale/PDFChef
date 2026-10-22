#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`ANDROID_DOCUMENT_UNDO: ${message}`);
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
  'UNDO_EXPIRY_MILLIS = 10L * 60L * 1000L',
  'COMPLETED_RECORD_EXPIRY_MILLIS = 24L * 60L * 60L * 1000L',
  'UndoEntry trashOwned(String ref)',
  'boolean restoreOwned(String undoRef)',
  'String undoTargetRef(String undoRef)',
  'enum UndoState { PREPARED, TRASHED, RESTORING, RESTORED, PURGING',
  'publishNew(layout.undoRecord(undoRef), encodeUndo(intent))',
  'moveAtomicPreserving(ownedRecord, trashRecord, -1)',
  'moveAtomicPreserving(ownedData, trashData, record.size)',
  'moveAtomicPreserving(trashData, ownedData, record.size)',
  'moveAtomicPreserving(trashRecord, ownedRecord, -1)',
  'deleteVerified(layout.undoRecord(record.undoRef))',
  'fsyncDirectory(layout.operations)',
  'return recoverUndoTransactions(layout, targetRef, 4);',
  'cleanupCount < cleanupLimit',
  'MAXIMUM_OWNED_DOCUMENTS = 10_000',
  'MAXIMUM_UNDO_RECORD_BYTES = 2048',
  'recoverNonRestoringUndos(layout)',
  'recoverRestoringUndoForRef(layout, ref)',
  'requireRestoreCapacity(layout, decoded)',
  'if (restoredAt < record.createdAt) restoredAt = record.createdAt',
]) assert(writer.includes(invariant), `writer invariant missing: ${invariant}`);

const trashSlice = writer.slice(writer.indexOf('UndoEntry trashOwned('),
  writer.indexOf('boolean deleteOwned('));
assert(!trashSlice.includes('deleteOwned(') && !trashSlice.includes('clearOwned('),
  'undo must not change irreversible delete or clear');
assert(writer.indexOf('moveAtomicPreserving(ownedRecord, trashRecord, -1)')
  < writer.indexOf('moveAtomicPreserving(ownedData, trashData, record.size)'),
  'trash must journal metadata move before payload move');
assert(writer.indexOf('moveAtomicPreserving(trashData, ownedData, record.size)')
  < writer.indexOf('moveAtomicPreserving(trashRecord, ownedRecord, -1)'),
  'restore must move payload before metadata');

assert(coordinator.includes('public synchronized UndoReceipt trashOwnedDocument(String ref)')
  && coordinator.includes('public synchronized void restoreOwnedDocument(String undoRef)')
  && coordinator.includes('closeOwnedCursor(ref)'), 'sole coordinator undo facade missing');
assert(plugin.includes('@PluginMethod public void trashOwned(PluginCall call)')
  && plugin.includes('@PluginMethod public void restoreOwned(PluginCall call)')
  && plugin.includes('execute(() -> completeTrashOwned(call, ref))')
  && plugin.includes('execute(() -> completeRestoreOwned(call, undoRef))')
  && plugin.includes('output.put("undoRef", receipt.undoRef())')
  && plugin.includes('output.put("expiresAt", receipt.expiresAt())')
  && plugin.includes('output.put("status", "completed")'),
  'strict background bridge undo missing');
const bridgeUndo = plugin.slice(plugin.indexOf('@PluginMethod public void trashOwned'),
  plugin.indexOf('@PluginMethod public void deleteOwned'));
assert(!/put\("(?:uri|path|provider|filename|displayName|bytes|hash|exception)"/.test(bridgeUndo),
  'private undo data crossed the bridge');

assert(client.includes('trashOwned(options: { readonly ref: string })')
  && client.includes('restoreOwned(options: { readonly undoRef: string })')
  && client.includes('async trashOwned(ref: string)')
  && client.includes('async restoreOwned(undoRef: string)')
  && client.includes("const UNDO_REF = /^u1_[A-Za-z0-9_-]{22,64}$/"),
  'strict TypeScript undo client missing');
assert(workspace.includes('recordRecovery,')
  && workspace.includes('async deleteReversibly(record)')
  && workspace.includes('documents.trashOwned(ownedRefFor(record))')
  && workspace.includes('documents.restoreOwned(receipt.undoRef)'),
  'T906 per-record reversible-delete workspace activation missing');
assert(recent.includes('recordAbilities(platform, record)')
  && recent.includes('service.deleteReversibly(target)')
  && recent.includes('service.restore(receipt)')
  && recent.includes('mergeUndo(current, trashed, outcome.message, Date.now())')
  && recent.includes('remainingUndo(offer, unrestored, outcome.message, Date.now())')
  && !recent.includes('undoRef'),
  'T906 visible undo must be per-row, retry-safe, and opaque');

for (const proof of [
  'trashAndRestorePreserveExactPayloadAndAreResponseLossIdempotent',
  'everyUndoMoveCheckpointRecoversWithTheSameToken',
  'everyRestoreMoveCheckpointRecoversWithoutResurrection',
  'undoExpiryBoundaryPurgesExactTrashWithoutChangingDeleteSemantics',
  'everyExpiryPurgeCheckpointConvergesToNotFound',
  'undoClockRollbackPreservesDataAndUnsafeTimestampCannotCrossBridge',
  'journaledTrashIsRecoveredBeforeRenameDeleteOrClearCanMutateIt',
  'restoringRecoveryReservesCapacityBeforePublishingOwnedMetadata',
  'maximumLegalNameRefAndMimeFitTheDedicatedUndoRecordBound',
  'ownedUndoClosesTheExactReadCursorAndLegacyIsRefused',
  'owned undo uses exact opaque DTOs and rejects malformed or leaking responses',
  'nativeOwnedUndoIsOpaqueDurableAndRetrySafe',
]) assert(writerTest.includes(proof) || coordinatorTest.includes(proof)
  || pluginTest.includes(proof) || clientTest.includes(proof) || runtimeTest.includes(proof),
`focused proof missing: ${proof}`);

console.log('ANDROID_DOCUMENT_UNDO_VERIFIER: PASS');
console.log('UNDO_SCOPE: durable d1_ only; 10-minute window; exact private atomic moves; 24-hour restored tombstone');
console.log('VISIBLE_RENAME_UNDO_ACTIVATION: ACTIVE behind exact per-record d1_ eligibility; normal-phone review gate required');
console.log('PHYSICAL_DEVICE_SIGNING_PLAY_PRODUCTION: NOT_CHECKED');
