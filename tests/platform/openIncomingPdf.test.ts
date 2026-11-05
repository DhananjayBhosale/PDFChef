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

// The native reader shows a PDF from another app by itself; the page only hears about it when
// the person picks a tool there, and that tool gets the same copy.
test('a tool chosen in the reader opens with the handed-over PDF', async () => {
  const paths: string[] = [];
  await openIncomingAndroidPdf(platform(), ref, '/edit', (file, path) => {
    assert.equal(file.name, 'Incoming.pdf');
    paths.push(path);
  });
  assert.deepEqual(paths, ['/edit']);
});

test('missing external refs never read a different recent file', async () => {
  await assert.rejects(openIncomingAndroidPdf(platform(), 'd1_' + 'B'.repeat(22), '/edit', () => assert.fail('Unexpected navigation')));
});
