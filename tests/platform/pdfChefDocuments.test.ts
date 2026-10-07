import assert from 'node:assert/strict';
import test from 'node:test';
import type { DurableDocumentRef, StoredDocument } from '../../services/domain/workspaceModels.ts';
import {
  PDF_CHEF_MAXIMUM_CHUNK_BYTES,
  PdfChefDocumentsBridge,
  isPdfChefDocumentsAvailable,
  type PdfChefDocumentsNativePlugin,
} from '../../services/platform/capacitor/pdfChefDocuments.ts';

const ref = 'DOC-123' as DurableDocumentRef;
const stored: StoredDocument = {
  ref,
  name: 'sample.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 3,
  contentHash: 'a'.repeat(64),
  retainedAt: 42,
};

const nativeStub = (overrides: Partial<PdfChefDocumentsNativePlugin> = {}): PdfChefDocumentsNativePlugin => ({
  beginWrite: async () => ({ sessionId: 'SESSION-1', maximumChunkBytes: PDF_CHEF_MAXIMUM_CHUNK_BYTES }),
  appendWrite: async ({ data }) => ({ acceptedBytes: atob(data).length }),
  finishWrite: async () => stored,
  abortWrite: async () => ({}),
  readChunk: async () => ({ data: 'YWJj', nextOffset: 3, done: true }),
  stat: async () => stored,
  exists: async () => ({ exists: true }),
  listDocuments: async () => ({ documents: [{ document: stored, available: true, pending: false }] }),
  rename: async ({ name }) => ({ ...stored, name }),
  delete: async () => ({}),
  clear: async () => ({}),
  storageInformation: async () => ({ retainedBytes: 3 }),
  takePendingImports: async () => ({ imports: [] }),
  acknowledgePendingImports: async () => ({}),
  pickDocuments: async () => ({ imports: [{ document: stored }] }),
  exportDocument: async () => ({ completed: true }),
  shareDocument: async () => ({ completed: true }),
  signatureVerificationAvailable: async () => ({ available: true }),
  presentSignatureReport: async () => ({ completed: true }),
  openReader: async () => ({ action: 'closed' }),
  signalHaptic: async () => ({}),
  getApplicationMetadata: async () => ({ name: 'PDF Chef', version: '1.0', build: '1' }),
  addListener: async () => ({ remove: async () => undefined }),
  ...overrides,
});

test('retain splits arbitrary streams into bounded 512 KiB native calls', async () => {
  const appended: number[] = [];
  const bridge = new PdfChefDocumentsBridge(nativeStub({
    appendWrite: async ({ data }) => {
      const length = atob(data).length;
      appended.push(length);
      return { acceptedBytes: length };
    },
    finishWrite: async () => ({
      ...stored,
      sizeBytes: PDF_CHEF_MAXIMUM_CHUNK_BYTES * 2 + 7,
    }),
  }));
  const input = new Uint8Array(PDF_CHEF_MAXIMUM_CHUNK_BYTES * 2 + 7);

  const result = await bridge.retain(
    new ReadableStream({ start: controller => { controller.enqueue(input); controller.close(); } }),
    { name: 'sample.pdf', mimeType: 'application/pdf' },
  );

  assert.deepEqual(appended, [PDF_CHEF_MAXIMUM_CHUNK_BYTES, PDF_CHEF_MAXIMUM_CHUNK_BYTES, 7]);
  assert.equal(result.sizeBytes, input.length);
});

test('retain aborts a usable native session when chunk-limit negotiation fails', async () => {
  const aborted: string[] = [];
  const bridge = new PdfChefDocumentsBridge(nativeStub({
    beginWrite: async () => ({ sessionId: 'SESSION-MISMATCH', maximumChunkBytes: 1024 }),
    abortWrite: async ({ sessionId }) => { aborted.push(sessionId); return {}; },
  }));

  await assert.rejects(
    bridge.retain(new Blob(['x']).stream(), {
      name: 'x.pdf', mimeType: 'application/pdf',
    }),
    /chunk limits do not match/,
  );
  assert.deepEqual(aborted, ['SESSION-MISMATCH']);
});

test('transient retention marks native staging before committing output bytes', async () => {
  const writes: unknown[] = [];
  const bridge = new PdfChefDocumentsBridge(nativeStub({
    beginWrite: async options => {
      writes.push(options);
      return { sessionId: 'TRANSIENT', maximumChunkBytes: PDF_CHEF_MAXIMUM_CHUNK_BYTES };
    },
  }));
  await bridge.retain(new Blob(['abc']).stream(), {
    name: 'temporary.pdf', mimeType: 'application/pdf', transient: true,
  });
  assert.deepEqual(writes, [{ name: 'temporary.pdf', mimeType: 'application/pdf', transient: true }]);
});

test('iOS picker forwards and validates the requested item limit', async () => {
  const requests: unknown[] = [];
  const bridge = new PdfChefDocumentsBridge(nativeStub({
    pickDocuments: async options => {
      requests.push(options);
      return { imports: [{ document: stored }] };
    },
  }));

  await bridge.pickDocuments(['application/pdf'], 1);
  assert.deepEqual(requests, [{
    acceptedMimeTypes: ['application/pdf'],
    maximumItems: 1,
  }]);
  await assert.rejects(bridge.pickDocuments(['application/pdf'], 0), /maximumItems/);
  await assert.rejects(bridge.pickDocuments(['application/pdf'], 101), /maximumItems/);

  const overLimit = new PdfChefDocumentsBridge(nativeStub({
    pickDocuments: async () => ({
      imports: [{ document: stored }, { document: stored }],
    }),
  }));
  await assert.rejects(
    overLimit.pickDocuments(['application/pdf'], 1),
    /exceeds maximumItems/,
  );
});

test('open validates native offsets, completion state and address-free payloads', async () => {
  const invalidOffset = new PdfChefDocumentsBridge(nativeStub({
    readChunk: async () => ({ data: 'YQ==', nextOffset: 99, done: true }),
  }));
  await assert.rejects(invalidOffset.open(ref).getReader().read(), /offset does not match/);

  const stalled = new PdfChefDocumentsBridge(nativeStub({
    readChunk: async () => ({ data: '', nextOffset: 0, done: false }),
  }));
  await assert.rejects(stalled.open(ref).getReader().read(), /completion state/);

  const leakedPath = new PdfChefDocumentsBridge(nativeStub({
    stat: async () => ({ ...stored, path: '/private/container/sample.pdf' }),
  }));
  await assert.rejects(leakedPath.stat(ref), /forbidden address field/);
});

test('pending delivery registers listener before peek and acknowledges only after consumption', async () => {
  const calls: string[] = [];
  let listener: (() => void) | undefined;
  let eventCount = 0;
  let consumeCount = 0;
  const bridge = new PdfChefDocumentsBridge(nativeStub({
    addListener: async (_event, callback) => {
      calls.push('listen');
      listener = () => callback({ available: true });
      return { remove: async () => undefined };
    },
    takePendingImports: async () => {
      calls.push('peek');
      if (eventCount === 0) return { imports: [] };
      return { imports: [{ document: stored }] };
    },
    acknowledgePendingImports: async ({ refs }) => {
      calls.push(`ack:${refs.join(',')}`);
      return {};
    },
  }));

  await bridge.startPendingImportDelivery(async () => {
    consumeCount += 1;
    calls.push(`consume:${consumeCount}`);
    if (consumeCount === 1) throw new Error('consumer not ready');
  });
  assert.deepEqual(calls.slice(0, 2), ['listen', 'peek']);

  eventCount = 1;
  listener?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.some(value => value.startsWith('ack:')), false);

  listener?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(consumeCount, 2, 'a failed event must not poison later durable retries');
  assert.ok(calls.includes(`ack:${ref}`));
});

test('strict document and plugin discovery validation reject false native success', async () => {
  const invalid = new PdfChefDocumentsBridge(nativeStub({
    stat: async () => ({ ...stored, ref: '../private' }),
  }));
  await assert.rejects(invalid.stat(ref), /opaque document reference/);
  assert.equal(isPdfChefDocumentsAvailable(), false, 'the web test process must not report a native proxy as discovered');
});

test('export and share cancellations reject instead of reporting false success', async () => {
  const bridge = new PdfChefDocumentsBridge(nativeStub({
    exportDocument: async () => ({ completed: false }),
    shareDocument: async () => ({ completed: false }),
  }));
  await assert.rejects(bridge.exportDocument(ref, 'sample.pdf', 'application/pdf'), { name: 'AbortError' });
  await assert.rejects(bridge.shareDocument(ref, 'sample.pdf', 'application/pdf'), { name: 'AbortError' });
});

test('native reader validates bounded large-PDF batch completion', async () => {
  const bridge = new PdfChefDocumentsBridge(nativeStub({
    openReader: async () => ({ action: 'batched', partCount: 7 }),
  }));
  assert.deepEqual(await bridge.openReader(ref, 'sample.pdf'), { action: 'batched', partCount: 7 });

  const invalid = new PdfChefDocumentsBridge(nativeStub({
    openReader: async () => ({ action: 'batched', partCount: 0 }),
  }));
  await assert.rejects(invalid.openReader(ref, 'sample.pdf'), /invalid/);
});
