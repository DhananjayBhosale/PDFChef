import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ApplicationMetadata,
  DurableDocumentRef,
  RecentEntry,
  StoredDocument,
} from '../../services/domain/workspaceModels.ts';
import type {
  ImportedDocument,
  RecentRepository,
  StorageInformation,
} from '../../services/platform/contracts.ts';
import {
  migrateLegacyWorkspace,
  type LegacyWorkspaceMigrationJournal,
  type LegacyWorkspaceMigrationJournalEntry,
  type LegacyWorkspaceOutput,
  type LegacyWorkspaceSource,
} from '../../services/platform/capacitor/legacyWorkspaceMigration.ts';
import {
  createIOSWorkspacePlatform,
  type IOSDocumentBridge,
} from '../../services/platform/capacitor/iosDocumentServices.ts';

const ref = (value: string) => value as DurableDocumentRef;

class MemoryRecent implements RecentRepository {
  readonly entries = new Map<string, RecentEntry>();
  failNextSave = false;

  async list() { return [...this.entries.values()]; }
  async get(id: string) { return this.entries.get(id) ?? null; }
  async save(entry: RecentEntry) {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('Recent save failed');
    }
    this.entries.set(entry.id, entry);
  }
  async delete(id: string) { this.entries.delete(id); }
  async clear() { this.entries.clear(); }
}

class MemoryJournal implements LegacyWorkspaceMigrationJournal {
  readonly entries = new Map<string, LegacyWorkspaceMigrationJournalEntry>();
  failRefSaveOnce = false;

  async get(id: string) { return this.entries.get(id) ?? null; }
  async save(entry: LegacyWorkspaceMigrationJournalEntry) {
    if (this.failRefSaveOnce && entry.status === 'pending' && entry.documentRef) {
      this.failRefSaveOnce = false;
      throw new Error('Process stopped before retained ref was journaled');
    }
    this.entries.set(entry.legacyId, entry);
  }
}

class MemorySource implements LegacyWorkspaceSource {
  listCalls = 0;
  readonly outputs: readonly LegacyWorkspaceOutput[];
  private readonly beforeList: (() => void) | undefined;

  constructor(outputs: readonly LegacyWorkspaceOutput[], beforeList?: () => void) {
    this.outputs = outputs;
    this.beforeList = beforeList;
  }
  async list() {
    this.listCalls += 1;
    this.beforeList?.();
    return this.outputs;
  }
}

class MigrationBridge implements IOSDocumentBridge {
  readonly documents = new Map<DurableDocumentRef, StoredDocument>();
  readonly retainedBytes: Uint8Array[] = [];
  readonly retainedNames: Array<string | null> = [];
  readonly renamed: Array<{ ref: DurableDocumentRef; name: string }> = [];
  pendingRegistrationStarted = false;
  private nextRef = 1;

  async retain(input: ReadableStream<Uint8Array>, metadata: Pick<StoredDocument, 'name' | 'mimeType'>) {
    const bytes = new Uint8Array(await new Response(input).arrayBuffer());
    this.retainedBytes.push(bytes);
    this.retainedNames.push(metadata.name);
    const document: StoredDocument = {
      ref: ref(`native-${this.nextRef++}`),
      name: metadata.name,
      mimeType: metadata.mimeType,
      sizeBytes: bytes.byteLength,
      contentHash: null,
      retainedAt: 500,
    };
    this.documents.set(document.ref, document);
    return document;
  }
  open(value: DurableDocumentRef) {
    const item = this.documents.get(value);
    if (!item) throw new Error('missing');
    return new Blob(['retained']).stream();
  }
  async stat(value: DurableDocumentRef) {
    const item = this.documents.get(value);
    if (!item) throw new Error('missing');
    return item;
  }
  async exists(value: DurableDocumentRef) { return this.documents.has(value); }
  async openReader() { return { action: 'closed' } as const; }
  async listDocuments() {
    return [...this.documents.values()].map(document => ({ document, available: true, pending: false }));
  }
  async rename(value: DurableDocumentRef, name: string) {
    const renamed = { ...(await this.stat(value)), name };
    this.documents.set(value, renamed);
    this.renamed.push({ ref: value, name });
    return renamed;
  }
  async delete() { throw new Error('migration must not delete retained documents'); }
  async clear() { throw new Error('migration must not clear retained documents'); }
  async storageInformation(): Promise<StorageInformation> {
    return { retainedBytes: 0, availableBytes: null, capacityBytes: null };
  }
  async takePendingImports(): Promise<readonly ImportedDocument[]> { return []; }
  async startPendingImportDelivery(consume: (imports: readonly ImportedDocument[]) => Promise<void> | void) {
    this.pendingRegistrationStarted = true;
    await consume([]);
    return async () => undefined;
  }
  async pickDocuments(): Promise<readonly ImportedDocument[]> { return []; }
  async exportDocument() {}
  async shareDocument() {}
  async signalHaptic() {}
  async getApplicationMetadata(): Promise<ApplicationMetadata> {
    return { name: 'PDF Chef', version: '1', build: '1' };
  }
}

const legacyOutput = (): LegacyWorkspaceOutput => ({
  id: 'legacy/id with unsafe marker characters',
  filename: 'compressed.pdf',
  mimeType: 'application/pdf',
  size: 3,
  toolPath: '/compress-pdf',
  createdAt: 123,
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
});

const harness = () => {
  const output = legacyOutput();
  const source = new MemorySource([output]);
  const journal = new MemoryJournal();
  const recent = new MemoryRecent();
  const bridge = new MigrationBridge();
  return { output, source, journal, recent, bridge };
};

test('migration retains a marked copy, commits Recent, restores its name, and never mutates legacy data', async () => {
  const state = harness();
  const originalBlob = state.output.blob;

  await migrateLegacyWorkspace(state);

  assert.equal(state.bridge.retainedBytes.length, 1);
  assert.deepEqual([...state.bridge.retainedBytes[0]], [1, 2, 3]);
  assert.match(state.bridge.retainedNames[0] ?? '', /^\.pdfchef-legacy-[0-9a-f]{64}\.pending$/);
  assert.match(state.bridge.renamed[0].name, /^compressed\.pdf$/);
  assert.equal(state.journal.entries.get(state.output.id)?.status, 'complete');
  assert.deepEqual(state.recent.entries.get(state.output.id), {
    id: state.output.id,
    documentRef: ref('native-1'),
    name: 'compressed.pdf',
    mimeType: 'application/pdf',
    toolId: '/compress-pdf',
    createdAt: 123,
    inputSizeBytes: null,
    outputSizeBytes: 3,
    spaceSavedBytes: null,
  });
  assert.equal(state.output.blob, originalBlob, 'legacy source record remains untouched');
});

test('restart adopts a marker-retained document after process death before ref journaling', async () => {
  const state = harness();
  state.journal.failRefSaveOnce = true;

  await assert.rejects(migrateLegacyWorkspace(state), /before retained ref was journaled/);
  assert.equal(state.bridge.retainedBytes.length, 1);
  assert.equal(state.journal.entries.get(state.output.id)?.documentRef, null);

  await migrateLegacyWorkspace(state);

  assert.equal(state.bridge.retainedBytes.length, 1, 'restart must adopt the marked native document');
  assert.equal(state.journal.entries.get(state.output.id)?.status, 'complete');
  assert.equal(state.recent.entries.get(state.output.id)?.documentRef, ref('native-1'));
});

test('Recent failure leaves a pending ref and restart reuses it to repair metadata', async () => {
  const state = harness();
  state.recent.failNextSave = true;

  await assert.rejects(migrateLegacyWorkspace(state), /Recent save failed/);
  assert.deepEqual(state.journal.entries.get(state.output.id), {
    legacyId: state.output.id,
    status: 'pending',
    documentRef: ref('native-1'),
  });

  await migrateLegacyWorkspace(state);

  assert.equal(state.bridge.retainedBytes.length, 1, 'journaled ref must be reused');
  assert.equal(state.recent.entries.get(state.output.id)?.name, 'compressed.pdf');
  assert.equal(state.journal.entries.get(state.output.id)?.status, 'complete');
});

test('a complete import does not replay legacy metadata after Recent is cleared', async () => {
  const state = harness();
  await migrateLegacyWorkspace(state);
  state.recent.entries.clear();

  await migrateLegacyWorkspace(state);

  assert.equal(state.bridge.retainedBytes.length, 1);
  assert.equal(state.recent.entries.has(state.output.id), false);
  assert.equal(state.journal.entries.get(state.output.id)?.status, 'complete');
});

test('a completed import preserves a later native rename', async () => {
  const state = harness();
  await migrateLegacyWorkspace(state);
  const entry = state.recent.entries.get(state.output.id)!;
  await state.bridge.rename(entry.documentRef!, 'renamed.pdf');
  await state.recent.save({ ...entry, name: 'renamed.pdf' });

  await migrateLegacyWorkspace(state);

  assert.equal(state.recent.entries.get(state.output.id)?.name, 'renamed.pdf');
  assert.equal((await state.bridge.stat(entry.documentRef!)).name, 'renamed.pdf');
  assert.equal(state.bridge.retainedBytes.length, 1);
});

test('a completed import does not recreate a file deleted from the native workspace', async () => {
  const state = harness();
  await migrateLegacyWorkspace(state);
  state.bridge.documents.clear();
  state.recent.entries.clear();

  await migrateLegacyWorkspace(state);

  assert.equal(state.bridge.documents.size, 0);
  assert.equal(state.recent.entries.size, 0);
  assert.equal(state.bridge.retainedBytes.length, 1);
});

test('native reconciliation still recovers an existing file after completed import metadata is lost', async () => {
  const state = harness();
  await migrateLegacyWorkspace(state);
  await state.bridge.rename(ref('native-1'), 'current-name.pdf');
  state.recent.entries.clear();
  const platform = createIOSWorkspacePlatform({
    bridge: state.bridge,
    recent: state.recent,
    settings: { async load() { return null; }, async save() {}, async clear() {} },
    legacyWorkspaceSource: state.source,
    legacyWorkspaceJournal: state.journal,
  });
  try {
    await platform.ready;
    const records = await platform.records.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].entry.name, 'current-name.pdf');
    assert.equal(records[0].entry.documentRef, ref('native-1'));
    assert.equal(state.bridge.retainedBytes.length, 1);
  } finally {
    await platform.dispose();
  }
});

test('native startup registers pending-import delivery before reading legacy IndexedDB', async () => {
  const bridge = new MigrationBridge();
  const recent = new MemoryRecent();
  const journal = new MemoryJournal();
  const source = new MemorySource([], () => {
    assert.equal(bridge.pendingRegistrationStarted, true);
  });
  const settings = {
    async load() { return null; },
    async save() {},
    async clear() {},
  };

  const platform = createIOSWorkspacePlatform({
    bridge,
    recent,
    settings,
    legacyWorkspaceSource: source,
    legacyWorkspaceJournal: journal,
  });
  await platform.ready;

  assert.equal(source.listCalls, 1);
  await platform.dispose();
});
