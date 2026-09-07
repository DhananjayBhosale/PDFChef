import assert from 'node:assert/strict';
import test from 'node:test';
import { openIncomingAndroidPdf } from '../../services/platform/android/openIncomingPdf.ts';
import type { WorkspacePlatform } from '../../services/platform/contracts.ts';
import type { RecentRecord, DurableDocumentRef } from '../../services/domain/workspaceModels.ts';

const ref = `d1_${'A'.repeat(22)}`;
const document = { ref: ref as DurableDocumentRef, name: 'Incoming.pdf', mimeType: 'application/pdf', sizeBytes: 10, contentHash: null, retainedAt: 1 };
const record: RecentRecord = { entry: { id: `android:${ref}`, documentRef: document.ref, name: document.name, mimeType: document.mimeType, toolId: null, createdAt: 1, inputSizeBytes: null, outputSizeBytes: 10, spaceSavedBytes: null }, document, available: true };
const platform = (): WorkspacePlatform => ({
  capabilities: { persistentRename: true, durableDocuments: true, separateClearActions: true },
  records: { list: async () => [record], delete: async () => {}, clearRecords: async () => {}, clearDocuments: async () => {} },
  save: async () => {}, saveFresh: async () => {},
  reopen: async () => new File(['%PDF'], 'Incoming.pdf', { type: 'application/pdf' }),
});

test('incoming owned PDF opens native reader and closing it does not navigate a tool', async () => {
  const native = platform();
  let opened = false;
  native.pdfReader = { isEligible: () => true, open: async value => { assert.equal(value, document); opened = true; return { action: 'closed' }; } };
  await openIncomingAndroidPdf(native, ref, () => assert.fail('Unexpected navigation'));
  assert.equal(opened, true);
});

test('incoming reader tools receive the original PDF and failed reader falls back to web', async () => {
  const native = platform();
  native.pdfReader = { isEligible: () => true, open: async () => ({ action: 'tool', toolPath: '/edit' }) };
  const paths: string[] = [];
  const receive = (file: File, path: string) => { assert.equal(file.name, 'Incoming.pdf'); paths.push(path); };
  await openIncomingAndroidPdf(native, ref, receive);
  native.pdfReader.open = async () => { throw new Error('Reader unavailable'); };
  await openIncomingAndroidPdf(native, ref, receive);
  assert.deepEqual(paths, ['/edit', '/view']);
});

test('missing external refs never read a different recent file', async () => {
  await assert.rejects(openIncomingAndroidPdf(platform(), 'd1_' + 'B'.repeat(22), () => assert.fail('Unexpected navigation')));
});
