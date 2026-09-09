import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ApplicationMetadata,
  DurableDocumentRef,
  RecentEntry,
  StoredDocument,
} from '../../services/domain/workspaceModels.ts';
import type { ImportedDocument, StorageInformation } from '../../services/platform/contracts.ts';
import { deliverBlob, downloadBlob, type OutputReadyRecord } from '../../services/pdfShared.ts';
import {
  createIOSWorkspacePlatform,
  type IOSDocumentBridge,
} from '../../services/platform/capacitor/iosDocumentServices.ts';
import {
  LocalRecentRepository,
  LocalSettingsRepository,
  type LocalStringStorage,
} from '../../services/platform/local/localWorkspaceRepositories.ts';

class MemoryStorage implements LocalStringStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const ref = (value: string) => value as DurableDocumentRef;
const document = (value: string, availableName = `${value}.pdf`): StoredDocument => ({
  ref: ref(value),
  name: availableName,
  mimeType: 'application/pdf',
  sizeBytes: 8,
  contentHash: 'b'.repeat(64),
  retainedAt: 100,
});
const entry = (id: string, documentRef: DurableDocumentRef | null): RecentEntry => ({
  id,
  documentRef,
  name: `${id}.pdf`,
  mimeType: 'application/pdf',
  toolId: 'compress-pdf',
  createdAt: 100,
  inputSizeBytes: 12,
  outputSizeBytes: 8,
  spaceSavedBytes: 4,
});

class FakeBridge implements IOSDocumentBridge {
  documents = new Map<DurableDocumentRef, StoredDocument>();
  unavailable = new Set<DurableDocumentRef>();
  pendingRefs = new Set<DurableDocumentRef>();
  deleted: DurableDocumentRef[] = [];
  exports: Array<{ ref: DurableDocumentRef; name: string | null }> = [];
  shares: Array<{ ref: DurableDocumentRef; name: string | null }> = [];
  signaturePresentations: Array<{ ref: DurableDocumentRef; name: string | null }> = [];
  signatureAvailable = true;
  picked: readonly ImportedDocument[] = [];
  pending: readonly ImportedDocument[] = [];
  retained = document('FRESH');
  exportError: Error | null = null;
  shareError: Error | null = null;
  exportWait: Promise<void> | null = null;
  retainCalls: Array<{
    bytes: Uint8Array;
    metadata: Pick<StoredDocument, 'name' | 'mimeType'> & { transient?: boolean };
  }> = [];

  async retain(
    input: ReadableStream<Uint8Array>,
    metadata: Pick<StoredDocument, 'name' | 'mimeType'>,
  ): Promise<StoredDocument> {
    const reader = input.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.length;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    this.retainCalls.push({ bytes, metadata });
    this.documents.set(this.retained.ref, this.retained);
    return this.retained;
  }
  open(): ReadableStream<Uint8Array> {
    return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); } });
  }
  async stat(value: DurableDocumentRef) { const item = this.documents.get(value); if (!item) throw new Error('missing'); return item; }
  async exists(value: DurableDocumentRef) { return this.documents.has(value) && !this.unavailable.has(value); }
  async listDocuments() {
    return [...this.documents.values()].map(value => ({
      document: value,
      available: !this.unavailable.has(value.ref),
      pending: this.pendingRefs.has(value.ref),
    }));
  }
  async rename(value: DurableDocumentRef, name: string) {
    const renamed = { ...(await this.stat(value)), name };
    this.documents.set(value, renamed);
    return renamed;
  }
  async delete(value: DurableDocumentRef) { this.deleted.push(value); this.documents.delete(value); }
  async clear() { this.documents.clear(); }
  async storageInformation(): Promise<StorageInformation> { return { retainedBytes: 8, availableBytes: 100, capacityBytes: 108 }; }
  async takePendingImports() { return this.pending; }
  async startPendingImportDelivery(consume: (imports: readonly ImportedDocument[]) => Promise<void> | void) {
    await consume(this.pending);
    return async () => undefined;
  }
  async pickDocuments() { return this.picked; }
  async exportDocument(value: DurableDocumentRef, name: string | null) {
    this.exports.push({ ref: value, name });
    if (this.exportWait) await this.exportWait;
    if (this.exportError) throw this.exportError;
  }
  async shareDocument(value: DurableDocumentRef, name: string | null) {
    this.shares.push({ ref: value, name });
    if (this.shareError) throw this.shareError;
  }
  async signatureVerificationAvailable() { return this.signatureAvailable; }
  async presentSignatureReport(value: DurableDocumentRef, name: string | null) {
    this.signaturePresentations.push({ ref: value, name });
  }
  async signalHaptic() {}
  async getApplicationMetadata(): Promise<ApplicationMetadata> { return { name: 'PDF Chef', version: '1.0', build: '1' }; }
}

const harness = () => {
  const storage = new MemoryStorage();
  const recent = new LocalRecentRepository(storage);
  const settings = new LocalSettingsRepository(storage);
  const bridge = new FakeBridge();
  const platform = createIOSWorkspacePlatform({ bridge, recent, settings, now: () => 123 });
  return { bridge, recent, platform };
};

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for asynchronous output delivery');
};

const withOutputSettings = async (
  settings: { keepLocalHistory: boolean; autoDownload: boolean },
  run: () => Promise<void>,
  onOutput?: (output: OutputReadyRecord) => void,
): Promise<void> => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const workspaceSettings = JSON.stringify(settings);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { pathname: '/compress-pdf' },
      localStorage: {
        getItem: (key: string) => key === 'pdfchef.workspace.settings.v1' ? workspaceSettings : null,
      },
      dispatchEvent: (event: CustomEvent<OutputReadyRecord>) => {
        onOutput?.(event.detail);
        return true;
      },
    },
  });
  try {
    await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete (globalThis as { window?: unknown }).window;
  }
};

test('records join local history to retained and missing native documents', async () => {
  const { bridge, recent, platform } = harness();
  const present = document('PRESENT');
  const missing = document('MISSING');
  bridge.documents.set(present.ref, present);
  bridge.documents.set(missing.ref, missing);
  bridge.unavailable.add(missing.ref);
  await recent.save(entry('missing', missing.ref));
  await recent.save(entry('present', present.ref));

  const records = await platform.records.list();
  assert.deepEqual(records.map(value => [value.entry.id, value.available]), [
    ['present', true],
    ['missing', false],
  ]);
  assert.equal(records[1].document?.ref, missing.ref, 'metadata remains visible when retained bytes are missing');
});

test('records reconcile an unreferenced committed document after a crash boundary', async () => {
  const { bridge, recent, platform } = harness();
  const orphan = document('RECOVERABLE');
  bridge.documents.set(orphan.ref, orphan);

  const records = await platform.records.list();

  assert.equal(records[0].entry.id, 'recovered-RECOVERABLE');
  assert.equal(records[0].document?.ref, orphan.ref);
  assert.equal((await recent.get('recovered-RECOVERABLE'))?.documentRef, orphan.ref);
});

test('record deletion cascades a document only after its last local reference', async () => {
  const { bridge, recent, platform } = harness();
  const shared = document('SHARED');
  bridge.documents.set(shared.ref, shared);
  await recent.save(entry('one', shared.ref));
  await recent.save(entry('two', shared.ref));

  await platform.records.delete('one');
  assert.deepEqual(bridge.deleted, []);
  await platform.records.delete('two');
  assert.deepEqual(bridge.deleted, [shared.ref]);
});

test('record deletion removes listed missing metadata before deleting Recent', async () => {
  const { bridge, recent, platform } = harness();
  const missing = document('MISSING-BYTES');
  bridge.documents.set(missing.ref, missing);
  bridge.unavailable.add(missing.ref);
  await recent.save(entry('missing', missing.ref));

  await platform.records.delete('missing');

  assert.deepEqual(bridge.deleted, [missing.ref]);
  assert.equal(await recent.get('missing'), null);
});

test('clearRecords removes only documents referenced by cleared records', async () => {
  const { bridge, recent, platform } = harness();
  const referenced = document('REFERENCED');
  const pendingOnly = document('PENDING');
  bridge.documents.set(referenced.ref, referenced);
  bridge.documents.set(pendingOnly.ref, pendingOnly);
  bridge.pendingRefs.add(pendingOnly.ref);
  await recent.save(entry('record', referenced.ref));

  await platform.records.clearRecords();
  assert.deepEqual(bridge.deleted, [referenced.ref]);
  assert.equal(bridge.documents.has(pendingOnly.ref), true);
  assert.deepEqual(await recent.list(), []);
});

test('clearRecords deletes crash-orphaned non-pending documents but preserves inbox queue documents', async () => {
  const { bridge, platform } = harness();
  const orphan = document('ORPHAN');
  const pending = document('INBOX');
  bridge.documents.set(orphan.ref, orphan);
  bridge.documents.set(pending.ref, pending);
  bridge.pendingRefs.add(pending.ref);

  await platform.records.clearRecords();

  assert.deepEqual(bridge.deleted, [orphan.ref]);
  assert.equal(bridge.documents.has(pending.ref), true);
});

test('fresh save presents a transient retained copy and deletes it without creating history', async () => {
  const { bridge, recent, platform } = harness();
  await platform.saveFresh({
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
    name: 'result.pdf',
    mimeType: 'application/pdf',
  });

  assert.deepEqual(bridge.exports, [{ ref: bridge.retained.ref, name: 'result.pdf' }]);
  assert.deepEqual(bridge.deleted, [bridge.retained.ref]);
  assert.deepEqual(await recent.list(), []);
});

test('fresh export and share failures still delete transient retained documents', async () => {
  const first = harness();
  first.bridge.exportError = new Error('cancelled');
  await assert.rejects(first.platform.saveFresh({
    blob: new Blob(['save']), name: 'save.pdf', mimeType: 'application/pdf',
  }), /cancelled/);
  assert.deepEqual(first.bridge.deleted, [first.bridge.retained.ref]);
  assert.equal(first.bridge.retainCalls[0].metadata.transient, true);

  const second = harness();
  second.bridge.shareError = new Error('cancelled');
  await assert.rejects(second.platform.shareFresh({
    blob: new Blob(['share']), name: 'share.pdf', mimeType: 'application/pdf',
  }), /cancelled/);
  assert.deepEqual(second.bridge.deleted, [second.bridge.retained.ref]);
  assert.equal(second.bridge.retainCalls[0].metadata.transient, true);
});

test('fresh presentation staging is never reconciled into phantom Recent history', async () => {
  const { bridge, recent, platform } = harness();
  let release!: () => void;
  bridge.exportWait = new Promise<void>(resolve => { release = resolve; });
  const saving = platform.saveFresh({
    blob: new Blob(['save']), name: 'save.pdf', mimeType: 'application/pdf',
  });
  while (bridge.exports.length === 0) await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(await platform.records.list(), []);
  release();
  await saving;
  assert.deepEqual(await recent.list(), []);
});

test('factory eagerly registers pending delivery and ready waits for initial persisted import', async () => {
  const storage = new MemoryStorage();
  const recent = new LocalRecentRepository(storage);
  const bridge = new FakeBridge();
  const pending = document('COLD-INBOX');
  bridge.pending = [{ document: pending }];

  const platform = createIOSWorkspacePlatform({
    bridge,
    recent,
    settings: new LocalSettingsRepository(storage),
    now: () => 500,
  });
  await platform.ready;

  assert.equal((await recent.get('import-COLD-INBOX'))?.documentRef, pending.ref);
});

test('aggregate exposes native services and crash-safe pending delivery seam', async () => {
  const { bridge, platform } = harness();
  bridge.pending = [{ document: document('PENDING') }];
  const seen: string[] = [];
  await platform.pendingImports.start(imports => { seen.push(...imports.map(value => value.document.ref)); });
  assert.deepEqual(seen, ['PENDING']);
  assert.equal(await platform.documentStorage?.exists(bridge.retained.ref), false);
  bridge.documents.set(bridge.retained.ref, bridge.retained);
  bridge.unavailable.add(bridge.retained.ref);
  assert.deepEqual(await platform.documentStorage?.list(), [{
    document: bridge.retained,
    available: false,
  }]);
  assert.deepEqual(await platform.applicationMetadata?.getApplicationMetadata(), {
    name: 'PDF Chef', version: '1.0', build: '1',
  });
});

test('signature report accepts only the exact File reopened from a durable iOS PDF', async () => {
  const { bridge, recent, platform } = harness();
  const signed = document('SIGNED', 'signed.pdf');
  bridge.documents.set(signed.ref, signed);
  await recent.save(entry('signed', signed.ref));
  await platform.ready;
  const record = (await platform.records.list()).find(value => value.entry.id === 'signed');
  assert.ok(record);

  const reopened = await platform.reopen(record);
  assert.equal(platform.pdfSignatureVerification?.isEligible(reopened), true);
  assert.equal(
    platform.pdfSignatureVerification?.isEligible(new File([reopened], reopened.name, { type: reopened.type })),
    false,
  );

  await platform.pdfSignatureVerification?.present(reopened);
  assert.deepEqual(bridge.signaturePresentations, [{ ref: signed.ref, name: signed.name }]);
});

test('installed output delivery covers the four settings states without double-retaining', async () => {
  const cases = [
    { keepLocalHistory: true, autoDownload: true, retains: 1, records: 1, exports: 1, deletes: 0 },
    { keepLocalHistory: true, autoDownload: false, retains: 1, records: 1, exports: 0, deletes: 0 },
    { keepLocalHistory: false, autoDownload: true, retains: 1, records: 0, exports: 1, deletes: 1 },
    { keepLocalHistory: false, autoDownload: false, retains: 0, records: 0, exports: 0, deletes: 0 },
  ] as const;
  const expectedBytes = new Uint8Array([0, 17, 128, 255]);

  for (const expected of cases) {
    const { bridge, recent, platform } = harness();
    await platform.ready;
    await withOutputSettings(expected, async () => {
      downloadBlob(
        new Blob([expectedBytes], { type: 'application/pdf' }),
        'exact result.pdf',
        'application/x-pdf-chef-test',
      );
      if (expected.retains > 0) await waitFor(() => bridge.retainCalls.length === expected.retains);
      if (expected.exports > 0) await waitFor(() => bridge.exports.length === expected.exports);
      if (expected.deletes > 0) await waitFor(() => bridge.deleted.length === expected.deletes);
      if (expected.records > 0) await waitFor(() => bridge.documents.size === 1);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    assert.equal(bridge.retainCalls.length, expected.retains);
    assert.equal((await recent.list()).length, expected.records);
    assert.equal(bridge.exports.length, expected.exports);
    assert.equal(bridge.deleted.length, expected.deletes);
    if (expected.retains) {
      assert.deepEqual(bridge.retainCalls[0].bytes, expectedBytes);
      assert.deepEqual(bridge.retainCalls[0].metadata, {
        name: 'exact result.pdf',
        mimeType: 'application/x-pdf-chef-test',
        ...(!expected.keepLocalHistory ? { transient: true } : {}),
      });
    }
    if (expected.records) {
      assert.deepEqual(await recent.list(), [{
        id: 'output-FRESH',
        documentRef: bridge.retained.ref,
        name: 'exact result.pdf',
        mimeType: 'application/x-pdf-chef-test',
        toolId: '/compress-pdf',
        createdAt: bridge.retained.retainedAt,
        inputSizeBytes: null,
        outputSizeBytes: bridge.retained.sizeBytes,
        spaceSavedBytes: null,
      }]);
    }
    if (expected.exports) {
      assert.deepEqual(bridge.exports, [{ ref: bridge.retained.ref, name: 'exact result.pdf' }]);
    }
    await platform.dispose();
  }
});

test('transient automatic exports reject after cleaning retained bytes on failure and cancellation', async () => {
  for (const failure of [new Error('failed'), new DOMException('cancelled', 'AbortError')]) {
    const { bridge, recent, platform } = harness();
    bridge.exportError = failure;
    await platform.ready;
    await withOutputSettings({ keepLocalHistory: false, autoDownload: true }, async () => {
      await assert.rejects(
        deliverBlob(new Blob(['transient']), 'temporary.pdf', 'application/pdf'),
        (error: unknown) => error === failure,
      );
    });

    assert.equal(bridge.retainCalls.length, 1);
    assert.deepEqual(bridge.deleted, [bridge.retained.ref]);
    assert.deepEqual(await recent.list(), []);
    await platform.dispose();
  }
});

test('retained output stays saved and offers retry when automatic export fails or is cancelled', async () => {
  for (const [failure, issue] of [
    [new Error('presentation unavailable'), 'failed'],
    [new DOMException('cancelled', 'AbortError'), 'cancelled'],
  ] as const) {
    const { bridge, recent, platform } = harness();
    const outputs: OutputReadyRecord[] = [];
    bridge.exportError = failure;
    await platform.ready;
    await withOutputSettings({ keepLocalHistory: true, autoDownload: true }, async () => {
      await deliverBlob(new Blob(['retained']), 'retained.pdf', 'application/pdf');
    }, output => outputs.push(output));

    assert.equal((await recent.list()).length, 1);
    assert.deepEqual(bridge.exports, [{ ref: bridge.retained.ref, name: 'retained.pdf' }]);
    assert.deepEqual(bridge.deleted, []);
    assert.equal(bridge.documents.has(bridge.retained.ref), true);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].historyRetained, true);
    assert.equal(outputs[0].deliveryIssue, issue);
    assert.equal(await outputs[0].blob?.text(), 'retained');
    await platform.dispose();
  }
});

test('metadata persistence failure still rejects when optional export is cancelled', async () => {
  const { bridge, recent, platform } = harness();
  await platform.ready;
  const failure = new Error('metadata unavailable');
  recent.save = async () => { throw failure; };
  bridge.exportError = new DOMException('cancelled', 'AbortError');
  await withOutputSettings({ keepLocalHistory: true, autoDownload: true }, async () => {
    await assert.rejects(deliverBlob(new Blob(['retained']), 'retained.pdf', 'application/pdf'),
      (error: unknown) => error === failure);
  });
  assert.equal(bridge.documents.has(bridge.retained.ref), true);
  assert.deepEqual(bridge.deleted, []);
  await platform.dispose();
});

test('active transient output is excluded from clear reconciliation until presentation completes', async () => {
  const { bridge, platform } = harness();
  let release!: () => void;
  bridge.exportWait = new Promise<void>(resolve => { release = resolve; });
  await platform.ready;
  await withOutputSettings({ keepLocalHistory: false, autoDownload: true }, async () => {
    downloadBlob(new Blob(['transient']), 'temporary.pdf', 'application/pdf');
    await waitFor(() => bridge.exports.length === 1);
    await platform.records.clearRecords();
    assert.deepEqual(bridge.deleted, []);
    release();
    await waitFor(() => bridge.deleted.length === 1);
  });
  await platform.dispose();
});

test('Recent persistence failure preserves a retained orphan for deterministic recovery', async () => {
  const { bridge, recent, platform } = harness();
  const save = recent.save.bind(recent);
  let failureObserved = false;
  recent.save = async value => {
    if (value.id.startsWith('output-')) {
      failureObserved = true;
      throw new Error('metadata unavailable');
    }
    await save(value);
  };
  await platform.ready;
  await withOutputSettings({ keepLocalHistory: true, autoDownload: true }, async () => {
    downloadBlob(new Blob(['recover']), 'recover.pdf', 'application/pdf');
    await waitFor(() => failureObserved);
    await waitFor(() => bridge.exports.length === 1);
  });

  assert.equal(bridge.documents.has(bridge.retained.ref), true);
  assert.deepEqual(bridge.deleted, []);
  assert.deepEqual(bridge.exports, [{ ref: bridge.retained.ref, name: 'recover.pdf' }]);
  recent.save = save;
  const records = await platform.records.list();
  assert.equal(records[0].entry.id, `recovered-${bridge.retained.ref}`);
  assert.equal(records[0].document?.ref, bridge.retained.ref);
  await platform.dispose();
});
