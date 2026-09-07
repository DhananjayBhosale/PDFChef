import { downloadBlob } from '../../services/pdfShared.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DurableCollectionRef,
  DurableDocumentRef,
  RecentRecord,
} from '../../services/domain/workspaceModels.ts';
import type { WorkspacePlatform } from '../../services/platform/contracts.ts';
import {
  AndroidDocumentsClient,
  type AndroidDocumentsNativePlugin,
} from '../../services/platform/android/androidDocuments.ts';
import { createAndroidWorkspacePlatform } from '../../services/platform/android/androidWorkspacePlatform.ts';
import type { AndroidLegacyHistorySnapshot } from '../../services/platform/android/legacyCompatibilityContracts.ts';

const ref = `d1_${'A'.repeat(22)}`;
const batchRef = `b1_${'B'.repeat(43)}`;
const pendingItem = {
  kind: 'file',
  ref,
  displayName: null,
  mimeType: 'application/pdf',
  sizeBytes: 25,
  contentHash: 'a'.repeat(64),
  createdAt: 1,
  available: true,
  pending: true,
} as const;

const base = (): WorkspacePlatform => ({
  records: {
    list: async () => [],
    delete: async () => undefined,
    clearRecords: async () => undefined,
    clearDocuments: async () => undefined,
  },
  capabilities: {
    persistentRename: false,
    durableDocuments: false,
    separateClearActions: false,
  },
  save: async () => undefined,
  reopen: async () => new File([], 'empty.pdf', { type: 'application/pdf' }),
  saveFresh: async () => undefined,
});

const native = (): AndroidDocumentsNativePlugin => ({
  readChunk: async ({ offset }) => ({ data: '', nextOffset: offset, done: true }),
  beginWrite: async () => ({ sessionRef: `w1_${'C'.repeat(22)}`, maximumChunkBytes: 524288 }),
  appendWrite: async ({ data }) => ({ acceptedBytes: atob(data).length }),
  finishWrite: async () => ({ item: { ...pendingItem, pending: false } }),
  abortWrite: async () => ({ aborted: false }),
  listOwned: async () => ({ items: [] }),
  deleteOwned: async () => ({ deleted: false }),
  clearOwned: async () => ({ deletedCount: 0 }),
  clearOwnedPayloads: async () => ({ clearedCount: 0 }),
  renameItem: async () => ({ status: 'completed' }),
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

const durableRef = ref as DurableDocumentRef;

/** A row as Recent actually holds it: durable, legacy, or browser-session. */
const recordFor = (
  id: string,
  overrides: Partial<RecentRecord> = {},
): RecentRecord => ({
  entry: {
    id,
    documentRef: (id.startsWith('android:') ? id.slice('android:'.length) : null) as DurableDocumentRef | null,
    name: 'Scan.pdf',
    mimeType: 'application/pdf',
    toolId: null,
    createdAt: 1,
    inputSizeBytes: null,
    outputSizeBytes: 25,
    spaceSavedBytes: null,
  },
  document: {
    ref: durableRef,
    name: 'Scan.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 25,
    contentHash: 'a'.repeat(64),
    retainedAt: 1,
  },
  available: true,
  ...overrides,
});

const androidPlatform = (plugin: AndroidDocumentsNativePlugin): WorkspacePlatform =>
  createAndroidWorkspacePlatform(base(), new AndroidDocumentsClient(plugin));

const legacySnapshot = (
  health: AndroidLegacyHistorySnapshot['health'],
  entries: AndroidLegacyHistorySnapshot['entries'] = [],
): AndroidLegacyHistorySnapshot => ({
  health,
  sourceCount: entries.length,
  invalidRecordCount: health === 'partial_invalid' ? 1 : 0,
  returnedCount: entries.length,
  truncated: false,
  entries,
});

test('T927: a legacy inspector rejection reaches Recent unchanged', async () => {
  const failure = new Error('native bridge rejected');
  const platform = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(native()),
    false,
    undefined,
    { readHistory: async () => { throw failure; } },
  );

  await assert.rejects(platform.records.list(), error => error === failure);
});

test('T927: corrupt legacy history fails Recent with one safe fixed error', async () => {
  const platform = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(native()),
    false,
    undefined,
    { readHistory: async () => legacySnapshot('corrupt') },
  );

  await assert.rejects(platform.records.list(), error =>
    error instanceof Error && error.message === 'Legacy history is unavailable.',
  );
});

test('T927: missing and blank legacy histories remain empty', async () => {
  for (const health of ['missing', 'blank'] as const) {
    const platform = createAndroidWorkspacePlatform(
      base(),
      new AndroidDocumentsClient(native()),
      false,
      undefined,
      { readHistory: async () => legacySnapshot(health) },
    );
    assert.deepEqual(await platform.records.list(), []);
  }
});

test('T927: partially invalid legacy history keeps its valid file rows', async () => {
  const entry = {
    kind: 'file' as const,
    ref: 'a1_7' as AndroidLegacyHistorySnapshot['entries'][number]['ref'],
    displayName: 'Imported.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 25,
    toolId: null,
    createdAt: 1,
    available: true,
  };
  const snapshot = {
    ...legacySnapshot('partial_invalid', [entry]),
    sourceCount: 2,
  };
  const platform = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(native()),
    false,
    undefined,
    { readHistory: async () => snapshot },
  );

  assert.equal((await platform.records.list())[0]?.entry.id, 'android:a1_7');
});

test('T928: legacy batch output is listed as one aggregate collection without child leakage', async () => {
  const legacyRef = 'a1_8' as AndroidLegacyHistorySnapshot['entries'][number]['ref'];
  const entry = {
    kind: 'collection' as const,
    ref: legacyRef,
    displayName: 'Split pages',
    itemCount: 12,
    toolId: '/split',
    createdAt: 1_725_000_000_000,
    available: true,
  };
  const platform = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(native()),
    false,
    undefined,
    { readHistory: async () => legacySnapshot('ok', [entry]) },
  );

  const [record] = await platform.records.list();
  assert.deepEqual(record, {
    entry: {
      id: 'android:a1_8',
      documentRef: null,
      name: 'Split pages',
      mimeType: null,
      toolId: '/split',
      createdAt: 1_725_000_000_000,
      inputSizeBytes: null,
      outputSizeBytes: null,
      spaceSavedBytes: null,
    },
    document: null,
    collection: {
      ref: 'a1_8',
      name: 'Split pages',
      sizeBytes: null,
      retainedAt: 1_725_000_000_000,
      itemCount: 12,
    },
    available: true,
  });
  assert.deepEqual(Reflect.ownKeys(record.collection!), [
    'ref', 'name', 'sizeBytes', 'retainedAt', 'itemCount',
  ]);
  assert.equal('items' in record.collection!, false);
  assert.equal('children' in record.collection!, false);
  assert.equal('path' in record.collection!, false);
  assert.equal('uri' in record.collection!, false);
});

test('T928: collection merge deduplicates by its opaque ref without claiming a document ref', async () => {
  const legacyOpaqueRef = 'a1_9' as AndroidLegacyHistorySnapshot['entries'][number]['ref'];
  const collectionRef = legacyOpaqueRef as unknown as DurableCollectionRef;
  const sessionRecord: RecentRecord = {
    entry: {
      id: 'session:collection', documentRef: null, name: 'Already present', mimeType: null,
      toolId: '/split', createdAt: 20, inputSizeBytes: null, outputSizeBytes: null,
      spaceSavedBytes: null,
    },
    document: null,
    collection: {
      ref: collectionRef, name: 'Already present', sizeBytes: null, retainedAt: 20, itemCount: 2,
    },
    available: true,
  };
  const browser = base();
  browser.records.list = async () => [sessionRecord];
  const legacyEntry = {
    kind: 'collection' as const,
    ref: legacyOpaqueRef,
    displayName: 'Duplicate legacy row', itemCount: 2, toolId: '/split', createdAt: 10,
    available: true,
  };
  const platform = createAndroidWorkspacePlatform(
    browser,
    new AndroidDocumentsClient(native()),
    false,
    undefined,
    { readHistory: async () => legacySnapshot('ok', [legacyEntry]) },
  );

  const records = await platform.records.list();
  assert.equal(records.length, 1);
  assert.equal(records[0], sessionRecord);
  assert.equal(records[0].entry.documentRef, null);
});

test('T909: record and payload clears are independent across session and native stores', async () => {
  const calls: string[] = [];
  const browser = base();
  browser.records.clearRecords = async () => { calls.push('session-records'); };
  browser.records.clearDocuments = async () => { calls.push('session-payloads'); };
  const plugin = native();
  plugin.clearOwned = async options => {
    assert.deepEqual(options, {});
    calls.push('native-records');
    return { deletedCount: 1 };
  };
  plugin.clearOwnedPayloads = async options => {
    assert.deepEqual(options, {});
    calls.push('native-payloads');
    return { clearedCount: 1 };
  };
  plugin.listOwned = async () => ({
    items: [{ ...pendingItem, pending: false, available: false }],
  });
  const platform = createAndroidWorkspacePlatform(browser, new AndroidDocumentsClient(plugin));
  assert.equal(platform.capabilities.separateClearActions, true);
  const [record] = await platform.records.list();
  assert.equal(record.available, false);
  assert.equal(record.document?.ref, ref);

  await platform.records.clearDocuments();
  await platform.records.clearRecords();
  assert.deepEqual(calls, [
    'session-payloads', 'native-payloads', 'session-records', 'native-records',
  ]);
});

test('T906: only a canonical available durable row reports rename and reversible delete', () => {
  const platform = androidPlatform(native());
  const abilities = platform.recordRecovery!.abilitiesFor;

  assert.deepEqual(abilities(recordFor(`android:${ref}`)), {
    rename: true,
    reversibleDelete: true,
    limitation: null,
  });
  assert.deepEqual(abilities(recordFor('android:a1_7')), {
    rename: false,
    reversibleDelete: false,
    limitation: 'legacy-read-only',
  });
  assert.deepEqual(abilities(recordFor('browser:1', { document: null })), {
    rename: false,
    reversibleDelete: false,
    limitation: 'session-only',
  });
  // A ref that is not the exact durable shape is not this app's to write to.
  assert.deepEqual(abilities(recordFor('android:d1_short')), {
    rename: false,
    reversibleDelete: false,
    limitation: 'session-only',
  });
  assert.deepEqual(abilities(recordFor(`android:${ref}`, { available: false })), {
    rename: false,
    reversibleDelete: false,
    limitation: 'file-missing',
  });
});

test('T906: durable rename goes through renameItem on the same ref', async () => {
  const calls: unknown[] = [];
  const plugin = native();
  plugin.renameItem = async (options) => {
    calls.push(options);
    return { status: 'completed' };
  };
  const platform = androidPlatform(plugin);

  await platform.rename!(recordFor(`android:${ref}`), 'Quarterly report.pdf');
  assert.deepEqual(calls, [{ ref, displayName: 'Quarterly report.pdf' }]);

  await assert.rejects(
    platform.rename!(recordFor('android:a1_7'), 'Renamed.pdf'),
    /read-only/,
  );
  await assert.rejects(
    platform.rename!(recordFor(`android:${ref}`, { available: false }), 'Renamed.pdf'),
    /not one this app keeps/,
  );
  // A refused rename never reached the durable store.
  assert.equal(calls.length, 1);
});

test('T906: a browser-session row keeps the base rename rather than a native one', async () => {
  const calls: string[] = [];
  const plugin = native();
  plugin.renameItem = async () => {
    calls.push('native');
    return { status: 'completed' };
  };
  const browser = base();
  browser.rename = async (_record, name) => { calls.push(`base:${name}`); };
  const platform = createAndroidWorkspacePlatform(browser, new AndroidDocumentsClient(plugin));

  await platform.rename!(recordFor('browser:1', { document: null }), 'Browser.pdf');
  assert.deepEqual(calls, ['base:Browser.pdf']);
});

test('T906: eligible deletion trashes the ref and restores from the opaque receipt', async () => {
  const calls: unknown[] = [];
  const plugin = native();
  plugin.trashOwned = async (options) => {
    calls.push(['trash', options]);
    return { undoRef: `u1_${'U'.repeat(22)}`, expiresAt: 1_800_000 };
  };
  plugin.restoreOwned = async (options) => {
    calls.push(['restore', options]);
    return { status: 'completed' };
  };
  plugin.deleteOwned = async () => {
    throw new Error('a reversible deletion must not delete outright');
  };
  const platform = androidPlatform(plugin);

  const receipt = await platform.recordRecovery!.deleteReversibly(recordFor(`android:${ref}`));
  assert.deepEqual(receipt, { undoRef: `u1_${'U'.repeat(22)}`, expiresAt: 1_800_000 });

  await platform.recordRecovery!.restore(receipt);
  assert.deepEqual(calls, [
    ['trash', { ref }],
    ['restore', { undoRef: `u1_${'U'.repeat(22)}` }],
  ]);
});

test('T906: legacy, session and missing rows never reach trashOwned', async () => {
  const plugin = native();
  plugin.trashOwned = async () => {
    throw new Error('an ineligible row must not be trashed');
  };
  const recovery = androidPlatform(plugin).recordRecovery!;

  for (const record of [
    recordFor('android:a1_7'),
    recordFor('browser:1', { document: null }),
    recordFor(`android:${ref}`, { available: false }),
  ]) {
    await assert.rejects(recovery.deleteReversibly(record), /not one this app keeps/);
  }
});

test('T906: a failing trash call surfaces instead of reporting a deletion', async () => {
  const failure = Object.assign(new Error('DOCUMENT_UNAVAILABLE'), { code: 'DOCUMENT_UNAVAILABLE' });
  const plugin = native();
  plugin.trashOwned = async () => { throw failure; };
  const recovery = androidPlatform(plugin).recordRecovery!;
  await assert.rejects(
    recovery.deleteReversibly(recordFor(`android:${ref}`)),
    (error) => error === failure,
  );
});

test('T906: the durable store now reports persistent rename', () => {
  assert.equal(androidPlatform(native()).capabilities.persistentRename, true);
});

test('T907: accepted metadata and storage clients map to the existing Settings services', async () => {
  const calls: string[] = [];
  const platform = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(native()),
    false,
    {
      metadata: {
        async getMetadata() {
          calls.push('metadata');
          return { name: 'PDF Chef', version: '2.2.4', build: '21' };
        },
      },
      storage: {
        async getStorageStats() {
          calls.push('storage');
          return { retainedBytes: 45, availableBytes: 100, capacityBytes: 200 };
        },
      },
    },
  );

  assert.deepEqual(await platform.applicationMetadata!.getApplicationMetadata(), {
    name: 'PDF Chef', version: '2.2.4', build: '21',
  });
  assert.deepEqual(await platform.storageInformation!.getStorageInformation(), {
    retainedBytes: 45, availableBytes: 100, capacityBytes: 200,
  });
  assert.deepEqual(calls, ['metadata', 'storage']);
});

test('T907: device-fact failures remain failures instead of becoming null or zero', async () => {
  const metadataFailure = Object.assign(new Error('metadata unavailable'), { code: 'APP_METADATA_UNAVAILABLE' });
  const storageFailure = Object.assign(new Error('storage unavailable'), { code: 'STORAGE_STATS_FAILED' });
  const platform = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(native()),
    false,
    {
      metadata: { getMetadata: async () => { throw metadataFailure; } },
      storage: { getStorageStats: async () => { throw storageFailure; } },
    },
  );

  await assert.rejects(
    platform.applicationMetadata!.getApplicationMetadata(),
    error => error === metadataFailure,
  );
  await assert.rejects(
    platform.storageInformation!.getStorageInformation(),
    error => error === storageFailure,
  );
});

test('T907: each unavailable native fact stays unadvertised independently', () => {
  const metadataOnly = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(native()),
    false,
    {
      metadata: { getMetadata: async () => ({ name: 'PDF Chef', version: '1.0', build: '1' }) },
      storage: null,
    },
  );
  assert.ok(metadataOnly.applicationMetadata);
  assert.equal(metadataOnly.storageInformation, undefined);

  const storageOnly = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(native()),
    false,
    {
      metadata: null,
      storage: { getStorageStats: async () => ({ retainedBytes: 0, availableBytes: null, capacityBytes: null }) },
    },
  );
  assert.equal(storageOnly.applicationMetadata, undefined);
  assert.ok(storageOnly.storageInformation);
});

test('direct picker mapping is consumed before the full batch is acknowledged', async () => {
  const calls: string[] = [];
  const plugin = native();
  plugin.pickDocuments = async () => {
    calls.push('pick');
    return { status: 'accepted', batchRef, items: [pendingItem] };
  };
  plugin.acknowledgePendingImports = async ({ refs }) => {
    calls.push('ack');
    assert.deepEqual(refs, [ref]);
    return { acknowledgedCount: 1 };
  };
  const platform = createAndroidWorkspacePlatform(base(), new AndroidDocumentsClient(plugin));
  const imports = await platform.documentImport!.importDocuments({
    acceptedMimeTypes: ['application/pdf'],
  });
  assert.deepEqual(calls, ['pick', 'ack']);
  assert.equal(imports[0].document.ref, ref);
  assert.equal(imports[0].document.name, 'Document');
});

test('pending delivery registers first, peeks durably, consumes, then acknowledges', async () => {
  const calls: string[] = [];
  const plugin = native();
  plugin.addListener = async () => {
    calls.push('listen');
    return { remove: async () => { calls.push('stop'); } };
  };
  plugin.takePendingImports = async () => {
    calls.push('peek');
    return { batchRef, items: [pendingItem] };
  };
  plugin.acknowledgePendingImports = async () => {
    calls.push('ack');
    return { acknowledgedCount: 1 };
  };
  const platform = createAndroidWorkspacePlatform(base(), new AndroidDocumentsClient(plugin));
  const stop = await platform.pendingImports!.start(async imports => {
    calls.push(`consume:${imports[0].document.ref}`);
  });
  assert.deepEqual(calls, ['listen', 'peek', `consume:${ref}`, 'ack']);
  await stop();
  assert.equal(calls.at(-1), 'stop');
});

test('Android platform startup recovers a lost pending event before owned listing', async () => {
  const calls: string[] = [];
  const plugin = native();
  plugin.addListener = async () => {
    calls.push('listen');
    return { remove: async () => undefined };
  };
  plugin.takePendingImports = async () => {
    calls.push('peek');
    return { batchRef, items: [pendingItem] };
  };
  plugin.acknowledgePendingImports = async () => {
    calls.push('ack');
    return { acknowledgedCount: 1 };
  };
  plugin.listOwned = async () => {
    calls.push('owned');
    return { items: [] };
  };
  const platform = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(plugin),
    true,
  );
  await platform.records.list();
  assert.deepEqual(calls, ['listen', 'peek', 'ack', 'owned']);
});

test('startup pending failure is not converted into an empty Recent list', async () => {
  const failure = Object.assign(new Error('pending unavailable'), {
    code: 'DOCUMENT_UNAVAILABLE',
  });
  const plugin = native();
  plugin.takePendingImports = async () => { throw failure; };
  const platform = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(plugin),
    true,
  );
  await assert.rejects(platform.records.list(), error => error === failure);
});

test('consumer failure leaves a durable pending batch unacknowledged', async () => {
  let acknowledged = false;
  const plugin = native();
  plugin.takePendingImports = async () => ({ batchRef, items: [pendingItem] });
  plugin.acknowledgePendingImports = async () => {
    acknowledged = true;
    return { acknowledgedCount: 1 };
  };
  const platform = createAndroidWorkspacePlatform(base(), new AndroidDocumentsClient(plugin));
  await assert.rejects(
    platform.pendingImports!.start(async () => { throw new Error('consumer failed'); }),
    /consumer failed/,
  );
  assert.equal(acknowledged, false);
});

test('native owned-list failure propagates instead of presenting false empty Recent', async () => {
  const failure = Object.assign(new Error('unavailable'), { code: 'DOCUMENT_UNAVAILABLE' });
  const plugin = native();
  plugin.listOwned = async () => { throw failure; };
  const platform = createAndroidWorkspacePlatform(base(), new AndroidDocumentsClient(plugin));
  await assert.rejects(platform.records.list(), error => error === failure);
});

test('durable Android save and share stay native while browser records keep base delivery', async () => {
  const calls: unknown[] = [];
  const plugin = native();
  plugin.exportItem = async options => {
    calls.push(['native-export', options]);
    return { status: 'completed' };
  };
  plugin.shareItem = async options => {
    calls.push(['native-share', options]);
    return { status: 'completed' };
  };
  plugin.readChunk = async () => {
    throw new Error('native delivery must not materialize bridge bytes');
  };
  const browser = base();
  browser.save = async (_record, name) => { calls.push(['browser-save', name]); };
  browser.share = async (_record, name) => { calls.push(['browser-share', name]); };
  const platform = createAndroidWorkspacePlatform(
    browser,
    new AndroidDocumentsClient(plugin),
  );
  const durableRef = ref as DurableDocumentRef;
  const durable: RecentRecord = {
    entry: {
      id: `android:${ref}`,
      documentRef: durableRef,
      name: 'Scan.pdf',
      mimeType: 'application/pdf',
      toolId: null,
      createdAt: 1,
      inputSizeBytes: null,
      outputSizeBytes: 25,
      spaceSavedBytes: null,
    },
    document: {
      ref: durableRef,
      name: 'Scan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 25,
      contentHash: 'a'.repeat(64),
      retainedAt: 1,
    },
    available: true,
  };
  const browserRecord: RecentRecord = {
    ...durable,
    entry: { ...durable.entry, id: 'browser:1', documentRef: null },
    document: null,
  };
  const legacyRecord: RecentRecord = {
    entry: {
      ...durable.entry,
      id: 'android:a1_7',
      documentRef: 'a1_7' as DurableDocumentRef,
      name: 'Legacy.pdf',
      mimeType: null,
    },
    document: null,
    available: true,
  };

  await platform.save(durable, 'Saved scan.pdf');
  await platform.share!(durable, 'Shared scan.pdf');
  await platform.save(legacyRecord, 'Saved legacy.pdf');
  await platform.save(browserRecord, 'Browser.pdf');
  await platform.share!(browserRecord, 'Browser.pdf');
  assert.deepEqual(calls, [
    ['native-export', { ref, displayName: 'Saved scan.pdf', mimeType: 'application/pdf' }],
    ['native-share', { ref, displayName: 'Shared scan.pdf', mimeType: 'application/pdf' }],
    ['native-export', { ref: 'a1_7', displayName: 'Saved legacy.pdf', mimeType: 'application/pdf' }],
    ['browser-save', 'Browser.pdf'],
    ['browser-share', 'Browser.pdf'],
  ]);
});

test('T928: a legacy collection saves and shares by opaque ref without MIME, bytes, or child names', async () => {
  const calls: unknown[] = [];
  const plugin = native();
  plugin.exportItem = async options => {
    calls.push(['export', options]);
    return { status: 'completed' };
  };
  plugin.shareItem = async options => {
    calls.push(['share', options]);
    return { status: 'completed' };
  };
  plugin.readChunk = async () => {
    throw new Error('a collection must never be materialized as one byte stream');
  };
  const browser = base();
  browser.reopen = async () => {
    throw new Error('a native collection must never fall back to browser reopen');
  };
  const legacyEntry = {
    kind: 'collection' as const,
    ref: 'a1_11' as AndroidLegacyHistorySnapshot['entries'][number]['ref'],
    displayName: 'JPEG pages', itemCount: 4, toolId: '/pdf-to-jpg', createdAt: 30,
    available: true,
  };
  const platform = createAndroidWorkspacePlatform(
    browser,
    new AndroidDocumentsClient(plugin),
    false,
    undefined,
    { readHistory: async () => legacySnapshot('ok', [legacyEntry]) },
  );
  const [record] = await platform.records.list();

  assert.deepEqual(platform.recordRecovery!.abilitiesFor(record), {
    rename: false,
    reversibleDelete: false,
    limitation: 'legacy-read-only',
  });
  await assert.rejects(platform.rename!(record, 'Renamed collection'), /read-only/);
  await assert.rejects(platform.recordRecovery!.deleteReversibly(record), /not one this app keeps/);
  await assert.rejects(platform.records.delete(record.entry.id), /read-only/);
  await assert.rejects(platform.reopen(record), /cannot be opened as a single document/);

  await platform.save(record, 'Saved pages');
  await platform.share!(record, 'Shared pages');
  assert.deepEqual(calls, [
    ['export', { ref: 'a1_11', displayName: 'Saved pages' }],
    ['share', { ref: 'a1_11', displayName: 'Shared pages' }],
  ]);
  for (const [, options] of calls as [string, Record<string, unknown>][]) {
    assert.deepEqual(Reflect.ownKeys(options), ['ref', 'displayName']);
    assert.equal('mimeType' in options, false);
    assert.equal('items' in options, false);
    assert.equal('children' in options, false);
    assert.equal('path' in options, false);
    assert.equal('uri' in options, false);
  }
});

test('T928: collection delivery failure propagates unchanged and never attempts bridge reads', async () => {
  const failure = Object.assign(new Error('collection unavailable'), {
    code: 'DOCUMENT_UNAVAILABLE',
  });
  const plugin = native();
  plugin.exportItem = async () => { throw failure; };
  plugin.readChunk = async () => {
    throw new Error('readChunk must not be called');
  };
  const platform = createAndroidWorkspacePlatform(
    base(),
    new AndroidDocumentsClient(plugin),
  );
  const collectionRef = 'a1_12' as DurableCollectionRef;
  const record: RecentRecord = {
    entry: {
      id: 'android:a1_12', documentRef: null, name: 'Images', mimeType: null,
      toolId: '/pdf-to-jpg', createdAt: 40, inputSizeBytes: null, outputSizeBytes: null,
      spaceSavedBytes: null,
    },
    document: null,
    collection: {
      ref: collectionRef, name: 'Images', sizeBytes: null, retainedAt: 40, itemCount: 3,
    },
    available: true,
  };

  await assert.rejects(platform.save(record, 'Images'), error => error === failure);
});


const outputHarness = () => {
  const plugin = native();
  const calls: string[] = [];
  const chunks: Uint8Array[] = [];
  const transientFlags: boolean[] = [];
  let mimeType = 'application/pdf';
  let owned = false;
  plugin.beginWrite = async options => {
    calls.push('begin'); mimeType = options.mimeType;
    return { sessionRef: `w1_${'C'.repeat(22)}`, maximumChunkBytes: 524288 };
  };
  plugin.appendWrite = async ({ data }) => {
    const chunk = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    chunks.push(chunk); return { acceptedBytes: chunk.length };
  };
  plugin.finishWrite = async options => {
    transientFlags.push(options.transient === true);
    calls.push('finish'); owned = true;
    return { item: { ...pendingItem, mimeType, pending: false } };
  };
  plugin.exportItem = async options => {
    calls.push(`export:${options.mimeType}`); return { status: 'completed' };
  };
  plugin.shareItem = async options => {
    calls.push(`share:${options.mimeType}`); return { status: 'completed' };
  };
  plugin.deleteOwned = async () => { calls.push('delete'); owned = false; return { deleted: true }; };
  plugin.abortWrite = async () => { calls.push('abort'); return { aborted: true }; };
  plugin.listOwned = async () => ({ items: owned ? [{ ...pendingItem, mimeType, pending: false }] : [] });
  return { plugin, calls, chunks, transientFlags, platform: androidPlatform(plugin) };
};

test('fresh Android save and share deliver all generated types through native storage and remove staging', async () => {
  for (const mimeType of ['application/pdf', 'application/zip', 'text/plain', 'image/webp']) {
    const { platform, calls, transientFlags } = outputHarness();
    const result = { blob: new Blob(['output']), name: 'result', mimeType };
    await platform.saveFresh(result);
    await platform.shareFresh!(result);
    assert.deepEqual(calls, ['begin', 'finish', `export:${mimeType}`, 'delete',
      'begin', 'finish', `share:${mimeType}`, 'delete']);
    assert.deepEqual(await platform.records.list(), []);
    assert.deepEqual(transientFlags, [true, true]);
  }
});

test('fresh Android delivery preserves native failures and cleans up incomplete writes and staging', async () => {
  const first = outputHarness();
  const failure = new Error('No storage');
  first.plugin.appendWrite = async () => { throw failure; };
  await assert.rejects(first.platform.saveFresh({ blob: new Blob(['output']), name: 'result.pdf', mimeType: 'application/pdf' }), error => error === failure);
  assert.deepEqual(first.calls, ['begin', 'abort']);
  const second = outputHarness();
  second.plugin.exportItem = async () => { throw failure; };
  await assert.rejects(second.platform.saveFresh({ blob: new Blob(['output']), name: 'result.pdf', mimeType: 'application/pdf' }), error => error === failure);
  assert.deepEqual(second.calls, ['begin', 'finish', 'delete']);
});

test('Android writes read bounded Blob slices and preserve exact bytes', async () => {
  const { platform, chunks } = outputHarness();
  const bytes = Uint8Array.from({ length: 524289 }, (_, index) => index % 256);
  const blob = new Blob([bytes]);
  blob.arrayBuffer = async () => { throw new Error('Whole-blob reads are forbidden'); };
  await platform.saveFresh({ blob, name: 'result.pdf', mimeType: 'application/pdf' });
  assert.deepEqual(chunks.map(chunk => chunk.length), [524288, 1]);
  assert.deepEqual(new Uint8Array(await new Blob(chunks).arrayBuffer()), bytes);
});

test('Android automatic output delivery honors all history and download settings', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    for (const keepLocalHistory of [false, true]) {
      for (const autoDownload of [false, true]) {
        const { calls, platform, transientFlags } = outputHarness();
        let announced = false;
        Object.defineProperty(globalThis, 'window', { configurable: true, value: {
          location: { pathname: '/compress' },
          localStorage: { getItem: () => JSON.stringify({ keepLocalHistory, autoDownload }) },
          dispatchEvent: () => { announced = true; return true; },
        } });
        downloadBlob(new Blob(['output']), 'result.pdf', 'application/pdf');
        for (let attempt = 0; attempt < 100 && !announced; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        assert.equal(announced, true);
        assert.equal(calls.includes('begin'), keepLocalHistory || autoDownload);
        assert.equal(calls.includes('export:application/pdf'), autoDownload);
        assert.equal(calls.includes('delete'), !keepLocalHistory && autoDownload);
        assert.equal((await platform.records.list()).length, keepLocalHistory ? 1 : 0);
        assert.deepEqual(transientFlags, keepLocalHistory || autoDownload ? [!keepLocalHistory] : []);
      }
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete (globalThis as { window?: unknown }).window;
  }
});
