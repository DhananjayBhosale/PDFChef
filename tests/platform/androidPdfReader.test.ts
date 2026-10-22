import assert from 'node:assert/strict';
import test from 'node:test';
import { Capacitor } from '@capacitor/core';
import type { DurableDocumentRef, StoredDocument } from '../../services/domain/workspaceModels.ts';
import type { AndroidDocumentsNativePlugin } from '../../services/platform/android/androidDocuments.ts';
import { AndroidDocumentsClient } from '../../services/platform/android/androidDocuments.ts';
import {
  createAndroidPdfReaderService,
  isAndroidNativePdfReaderAvailable,
} from '../../services/platform/android/androidPdfReader.ts';

const ownedRef = `d1_${'A'.repeat(22)}` as DurableDocumentRef;
const document = (overrides: Partial<StoredDocument> = {}): StoredDocument => ({
  ref: ownedRef,
  name: 'Scan.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  contentHash: 'a'.repeat(64),
  retainedAt: 1,
  ...overrides,
});

const native = (): AndroidDocumentsNativePlugin => ({
  readChunk: async () => ({ data: '', nextOffset: 0, done: true }),
  beginWrite: async () => ({ sessionRef: `w1_${'A'.repeat(22)}`, maximumChunkBytes: 524288 }),
  appendWrite: async () => ({ acceptedBytes: 1 }),
  finishWrite: async () => ({ item: {} }),
  abortWrite: async () => ({ aborted: false }),
  listOwned: async () => ({ items: [] }),
  deleteOwned: async () => ({ deleted: false }),
  clearOwned: async () => ({ deletedCount: 0 }),
  clearOwnedPayloads: async () => ({ clearedCount: 0 }),
  renameItem: async () => ({ status: 'completed' }),
  renameExport: async ({ displayName }) => ({ status: 'completed', savedName: displayName }),
  trashOwned: async () => ({ undoRef: `u1_${'U'.repeat(22)}`, expiresAt: 600_000 }),
  restoreOwned: async () => ({ status: 'completed' }),
  takePendingImports: async () => ({ batchRef: null, items: [] }),
  acknowledgePendingImports: async ({ refs }) => ({ acknowledgedCount: refs.length }),
  pickDocuments: async () => ({ status: 'cancelled', batchRef: null, items: [] }),
  exportItem: async () => ({ status: 'completed' }),
  shareItem: async () => ({ status: 'completed' }),
  openReader: async () => ({ action: 'closed' }),
  addListener: async () => ({ remove: async () => undefined }),
});

test('only bounded durable PDFs are native eligible; transient and oversized inputs fall back', () => {
  const service = createAndroidPdfReaderService(new AndroidDocumentsClient(native()));
  assert.equal(service.isEligible(document()), true);
  assert.equal(service.isEligible(document({ ref: 'a1_7' as DurableDocumentRef })), true);
  assert.equal(service.isEligible(document({ ref: 'blob:transient' as DurableDocumentRef })), false);
  assert.equal(service.isEligible(document({ mimeType: 'image/jpeg' })), false);
  assert.equal(service.isEligible(document({ sizeBytes: 250 * 1024 * 1024 })), true);
  assert.equal(service.isEligible(document({ sizeBytes: 256 * 1024 * 1024 + 1 })), false);
});

test('availability delegates to strict AndroidDocuments native discovery', () => {
  const capacitor = Capacitor as unknown as {
    getPlatform(): string;
    isPluginAvailable(name: string): boolean;
  };
  const getPlatform = capacitor.getPlatform;
  const isPluginAvailable = capacitor.isPluginAvailable;
  try {
    capacitor.getPlatform = () => 'android';
    capacitor.isPluginAvailable = name => name === 'AndroidDocuments';
    assert.equal(isAndroidNativePdfReaderAvailable(), true);
    capacitor.isPluginAvailable = name => name === 'AndroidPdfReader';
    assert.equal(isAndroidNativePdfReaderAvailable(), false);
    capacitor.isPluginAvailable = () => true;
    capacitor.getPlatform = () => 'ios';
    assert.equal(isAndroidNativePdfReaderAvailable(), false);
  } finally {
    capacitor.getPlatform = getPlatform;
    capacitor.isPluginAvailable = isPluginAvailable;
  }
});

test('open is safe when destructured and native receives the exact bounded public name', async () => {
  const bridge = native();
  const calls: unknown[] = [];
  bridge.openReader = async options => {
    calls.push(options);
    return { action: 'closed' };
  };
  const service = createAndroidPdfReaderService(new AndroidDocumentsClient(bridge));
  const { open } = service;
  assert.deepEqual(await open(document()), { action: 'closed' });
  assert.deepEqual(calls, [{ ref: ownedRef, displayName: 'Scan.pdf' }]);
});

test('signature tool opens the same private reader with only the allowlisted initial action', async () => {
  const bridge = native();
  const calls: unknown[] = [];
  bridge.openReader = async options => {
    calls.push(options);
    return { action: 'closed' };
  };
  const service = createAndroidPdfReaderService(new AndroidDocumentsClient(bridge));
  assert.equal(service.supportsSignatureVerification, true);
  assert.deepEqual(
    await service.open(document(), { initialAction: 'verify-signatures' }),
    { action: 'closed' },
  );
  assert.deepEqual(calls, [{
    ref: ownedRef,
    displayName: 'Scan.pdf',
    initialAction: 'verify-signatures',
  }]);
});

test('unsafe, malformed Unicode, dot, and oversized UTF-8 names use the fixed fallback', async () => {
  for (const name of ['.', '..', 'bad/name.pdf', 'bad\ud800name', 'é'.repeat(361)]) {
    const bridge = native();
    let displayName = '';
    bridge.openReader = async options => {
      displayName = options.displayName;
      return { action: 'closed' };
    };
    const service = createAndroidPdfReaderService(new AndroidDocumentsClient(bridge));
    await service.open(document({ name }));
    assert.equal(displayName, 'Document.pdf');
  }
});
