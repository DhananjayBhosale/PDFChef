import assert from 'node:assert/strict';
import test from 'node:test';
import { Capacitor } from '@capacitor/core';
import {
  ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES,
  AndroidDocumentsClient,
  isAndroidDocumentsAvailable,
  type AndroidDocumentsNativePlugin,
} from '../../services/platform/android/androidDocuments.ts';

const ownedRef = `d1_${'A'.repeat(22)}`;

const nativeStub = (
  implementation: AndroidDocumentsNativePlugin['readChunk'] = async ({ offset }) => ({
    data: 'AQID',
    nextOffset: offset + 3,
    done: false,
  }),
): AndroidDocumentsNativePlugin => ({
  readChunk: implementation,
  beginWrite: async () => ({ sessionRef: `w1_${'A'.repeat(22)}`, maximumChunkBytes: 524288 }),
  appendWrite: async ({ data }) => ({ acceptedBytes: atob(data).length }),
  finishWrite: async () => ({ item: { kind: 'file', ref: ownedRef, displayName: null, mimeType: 'application/pdf', sizeBytes: 1, contentHash: 'a'.repeat(64), createdAt: 0, available: true, pending: false } }),
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

test('client sends exact bounded arguments and decodes canonical bytes', async () => {
  const calls: unknown[] = [];
  const client = new AndroidDocumentsClient(nativeStub(async options => {
    calls.push(options);
    return { data: 'AQID', nextOffset: 10, done: false };
  }));

  const chunk = await client.readChunk(ownedRef, 7, 16);
  assert.deepEqual(calls, [{ ref: ownedRef, offset: 7, length: 16 }]);
  assert.deepEqual([...chunk.data], [1, 2, 3]);
  assert.equal(chunk.nextOffset, 10);
  assert.equal(chunk.done, false);
  assert.equal(Object.isFrozen(chunk), true);
});

test('accepted owned and legacy references support a terminal empty chunk', async () => {
  const calls: string[] = [];
  const client = new AndroidDocumentsClient(nativeStub(async ({ ref, offset }) => {
    calls.push(ref);
    return { data: '', nextOffset: offset, done: true };
  }));

  assert.equal((await client.readChunk('a1_1', 0, 1)).data.length, 0);
  assert.equal((await client.readChunk('a1_9007199254740991', 12, 1)).done, true);
  assert.equal((await client.readChunk(ownedRef, 12, 1)).done, true);
  assert.deepEqual(calls, ['a1_1', 'a1_9007199254740991', ownedRef]);
});

test('invalid references and non-exact numeric inputs never reach native code', async () => {
  let calls = 0;
  const client = new AndroidDocumentsClient(nativeStub(async () => {
    calls += 1;
    return { data: '', nextOffset: 0, done: true };
  }));

  const invalidRefs = [
    '', ' a1_1', 'a1_0', 'a1_01', 'a1_9007199254740992', 'd1_short',
    `d1_${'A'.repeat(65)}`, '/private/item.pdf', 'file:///private/item.pdf', 'content://provider/item',
  ];
  for (const ref of invalidRefs) await assert.rejects(client.readChunk(ref, 0, 1), TypeError);
  await assert.rejects(
    (client.readChunk as unknown as (ref: unknown, offset: unknown, length: unknown) => Promise<unknown>)(
      1,
      0,
      1,
    ),
    TypeError,
  );

  for (const offset of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.readChunk(ownedRef, offset, 1), TypeError);
  }
  for (const length of [0, -1, 1.5, Number.NaN, ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES + 1]) {
    await assert.rejects(client.readChunk(ownedRef, 0, length), TypeError);
  }
  const untypedRead = client.readChunk as unknown as (
    ref: unknown,
    offset: unknown,
    length: unknown,
  ) => Promise<unknown>;
  await assert.rejects(untypedRead(ownedRef, '0', 1), TypeError);
  await assert.rejects(untypedRead(ownedRef, 0, '1'), TypeError);
  assert.equal(calls, 0);
});

test('maximum safe offset remains a valid request boundary', async () => {
  const client = new AndroidDocumentsClient(nativeStub(async ({ offset }) => ({
    data: '', nextOffset: offset, done: true,
  })));
  const chunk = await client.readChunk(ownedRef, Number.MAX_SAFE_INTEGER, 1);
  assert.equal(chunk.nextOffset, Number.MAX_SAFE_INTEGER);
  assert.equal(chunk.done, true);
});

test('the exact 512 KiB canonical payload boundary is accepted', async () => {
  const bytes = new Uint8Array(ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES);
  const encoded = btoa('\0'.repeat(ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES));
  const client = new AndroidDocumentsClient(nativeStub(async () => ({
    data: encoded,
    nextOffset: ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES,
    done: true,
  })));
  const chunk = await client.readChunk(ownedRef, 0, ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES);
  assert.deepEqual(chunk.data, bytes);
  assert.equal(chunk.nextOffset, ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES);
});

test('response must be a plain object with exactly data, nextOffset, and done', async () => {
  const withHiddenField = { data: '', nextOffset: 0, done: true };
  Object.defineProperty(withHiddenField, 'hiddenPath', { value: '/private/item.pdf' });
  const withSymbolField = Object.assign(
    { data: '', nextOffset: 0, done: true },
    { [Symbol('private')]: true },
  );
  const invalid: unknown[] = [
    null,
    [],
    'AQID',
    Object.create(null),
    { data: '', nextOffset: 0 },
    { data: '', nextOffset: 0, done: true, path: '/private/item.pdf' },
    Object.assign(Object.create({ inherited: true }), { data: '', nextOffset: 0, done: true }),
    withHiddenField,
    withSymbolField,
  ];

  for (const response of invalid) {
    const client = new AndroidDocumentsClient(nativeStub(async () => response));
    await assert.rejects(client.readChunk(ownedRef, 0, 1), TypeError);
  }
});

test('response rejects coercion, unsafe offsets, malformed base64, and inconsistent progress', async () => {
  const invalid: unknown[] = [
    { data: 123, nextOffset: 0, done: true },
    { data: 'A', nextOffset: 0, done: true },
    { data: 'AB==', nextOffset: 1, done: true },
    { data: 'AQID\n', nextOffset: 3, done: false },
    { data: 'AQID', nextOffset: 2, done: false },
    { data: 'AQID', nextOffset: 3.5, done: false },
    { data: 'AQID', nextOffset: Number.MAX_SAFE_INTEGER + 1, done: false },
    { data: 'AQID', nextOffset: 3, done: 'false' },
    { data: '', nextOffset: 0, done: false },
  ];

  for (const response of invalid) {
    const client = new AndroidDocumentsClient(nativeStub(async () => response));
    await assert.rejects(client.readChunk(ownedRef, 0, 3), TypeError);
  }

  const tooManyDecodedBytes = new AndroidDocumentsClient(nativeStub(async () => ({
    data: 'AQID', nextOffset: 3, done: true,
  })));
  await assert.rejects(tooManyDecodedBytes.readChunk(ownedRef, 0, 2), TypeError);

  const oversizedBase64 = `${'AAAA'.repeat(Math.ceil(ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES / 3))}AAAA`;
  const oversized = new AndroidDocumentsClient(nativeStub(async () => ({
    data: oversizedBase64, nextOffset: 0, done: true,
  })));
  await assert.rejects(
    oversized.readChunk(ownedRef, 0, ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES),
    TypeError,
  );
});

test('native rejection identity is preserved and availability requires Android plus the native header', async () => {
  const nativeError = Object.assign(new Error('document unavailable'), { code: 'DOCUMENT_UNAVAILABLE' });
  const client = new AndroidDocumentsClient(nativeStub(async () => { throw nativeError; }));
  await assert.rejects(client.readChunk(ownedRef, 0, 1), error => error === nativeError);
  assert.equal(isAndroidDocumentsAvailable(), false);

  const capacitor = Capacitor as unknown as {
    getPlatform(): string;
    isPluginAvailable(name: string): boolean;
  };
  const getPlatform = capacitor.getPlatform;
  const isPluginAvailable = capacitor.isPluginAvailable;
  const queriedNames: string[] = [];
  try {
    capacitor.getPlatform = () => 'android';
    capacitor.isPluginAvailable = name => {
      queriedNames.push(name);
      return name === 'AndroidDocuments';
    };
    assert.equal(isAndroidDocumentsAvailable(), true);
    capacitor.isPluginAvailable = name => {
      queriedNames.push(name);
      return false;
    };
    assert.equal(isAndroidDocumentsAvailable(), false);
    capacitor.getPlatform = () => 'ios';
    capacitor.isPluginAvailable = name => {
      queriedNames.push(name);
      return true;
    };
    assert.equal(isAndroidDocumentsAvailable(), false);
    assert.deepEqual(queriedNames, ['AndroidDocuments', 'AndroidDocuments']);
  } finally {
    capacitor.getPlatform = getPlatform;
    capacitor.isPluginAvailable = isPluginAvailable;
  }
});

test('native contract exposes the bounded document, picker, pending, rename, undo, delivery, and reader methods', () => {
  const native = nativeStub();
  assert.deepEqual(Object.keys(native).sort(), ['abortWrite', 'acknowledgePendingImports', 'addListener', 'appendWrite', 'beginWrite', 'clearOwned', 'clearOwnedPayloads', 'deleteOwned', 'exportItem', 'finishWrite', 'listOwned', 'openReader', 'pickDocuments', 'readChunk', 'renameExport', 'renameItem', 'restoreOwned', 'shareItem', 'takePendingImports', 'trashOwned']);
});

test('owned undo uses exact opaque DTOs and rejects malformed or leaking responses', async () => {
  const undoRef = `u1_${'U'.repeat(22)}`;
  const calls: unknown[] = [];
  const native = nativeStub();
  native.trashOwned = async options => {
    calls.push(options);
    return { undoRef, expiresAt: 601_000 };
  };
  native.restoreOwned = async options => {
    calls.push(options);
    return { status: 'completed' };
  };
  const client = new AndroidDocumentsClient(native);
  assert.deepEqual(await client.trashOwned(ownedRef), { undoRef, expiresAt: 601_000 });
  assert.equal(Object.isFrozen(await client.trashOwned(ownedRef)), true);
  assert.deepEqual(await client.restoreOwned(undoRef), { status: 'completed' });
  assert.deepEqual(calls, [
    { ref: ownedRef },
    { ref: ownedRef },
    { undoRef },
  ]);

  const invalidTrashRefs = ['a1_1', 'content://provider/item', `d1_${'A'.repeat(21)}`];
  for (const ref of invalidTrashRefs) {
    await assert.rejects(client.trashOwned(ref), TypeError);
  }
  for (const ref of ['', 'u1_short', `u1_${'U'.repeat(65)}`, '/private/undo']) {
    await assert.rejects(client.restoreOwned(ref), TypeError);
  }

  const invalidTrashResponses: unknown[] = [
    { undoRef, expiresAt: -1 },
    { undoRef: 'u1_short', expiresAt: 601_000 },
    { undoRef, expiresAt: 601_000, path: '/private/item.pdf' },
    Object.assign(Object.create({ inherited: true }), { undoRef, expiresAt: 601_000 }),
    Object.assign({ undoRef, expiresAt: 601_000 }, { [Symbol('private')]: true }),
  ];
  for (const response of invalidTrashResponses) {
    const bad = nativeStub();
    bad.trashOwned = async () => response;
    await assert.rejects(new AndroidDocumentsClient(bad).trashOwned(ownedRef), TypeError);
  }
  const badRestore = nativeStub();
  badRestore.restoreOwned = async () => ({ status: 'completed', uri: 'content://private' });
  await assert.rejects(new AndroidDocumentsClient(badRestore).restoreOwned(undoRef), TypeError);
});

test('picker and pending DTOs are exact, bounded, ordered, and acknowledgement is full-batch', async () => {
  const secondRef = `d1_${'B'.repeat(22)}`;
  const batchRef = `b1_${'C'.repeat(43)}`;
  const item = (ref: string) => ({
    kind: 'file', ref, displayName: null, mimeType: 'application/pdf', sizeBytes: 25,
    contentHash: 'a'.repeat(64), createdAt: 1, available: true, pending: true,
  });
  const native = nativeStub();
  native.pickDocuments = async options => {
    assert.deepEqual(options, {
      acceptedMimeTypes: ['application/pdf', 'image/jpeg'],
      maximumItems: 2,
    });
    return { status: 'accepted', batchRef, items: [item(ownedRef), item(secondRef)] };
  };
  native.takePendingImports = async options => {
    assert.deepEqual(options, {});
    return { batchRef, items: [item(ownedRef), item(secondRef)] };
  };
  native.acknowledgePendingImports = async options => {
    assert.deepEqual(options, { batchRef, refs: [ownedRef, secondRef] });
    return { acknowledgedCount: 2 };
  };
  const client = new AndroidDocumentsClient(native);
  const picked = await client.pickDocuments(['application/pdf', 'image/jpeg'], 2);
  assert.equal(picked.status, 'accepted');
  assert.deepEqual(picked.items.map(value => value.ref), [ownedRef, secondRef]);
  const pending = await client.takePendingImports();
  assert.equal(pending.batchRef, batchRef);
  assert.equal(await client.acknowledgePendingImports(
    batchRef,
    pending.items.map(value => value.ref),
  ), 2);
  assert.equal(Object.isFrozen(pending.items), true);

  for (const invalidMimeList of [
    [], ['application/pdf', 'application/pdf'], ['text/plain'],
  ] as unknown as readonly string[][]) {
    await assert.rejects(client.pickDocuments(invalidMimeList as never, 1), TypeError);
  }
  await assert.rejects(client.pickDocuments(['application/pdf'], 0), TypeError);
  await assert.rejects(client.acknowledgePendingImports(batchRef, [ownedRef, ownedRef]), TypeError);
});

test('pending failures never become empty and listener events expose only batch identity and count', async () => {
  const batchRef = `b1_${'D'.repeat(43)}`;
  const nativeFailure = Object.assign(new Error('unavailable'), { code: 'DOCUMENT_UNAVAILABLE' });
  const native = nativeStub();
  native.takePendingImports = async () => { throw nativeFailure; };
  let registered: ((event: unknown) => void) | null = null;
  let removed = false;
  native.addListener = async (name, listener) => {
    assert.equal(name, 'pendingImportReady');
    registered = listener;
    return { remove: async () => { removed = true; } };
  };
  const client = new AndroidDocumentsClient(native);
  await assert.rejects(client.takePendingImports(), error => error === nativeFailure);
  const seen: unknown[] = [];
  const stop = await client.addPendingImportListener(event => seen.push(event));
  registered!({ batchRef, itemCount: 2 });
  registered!({ batchRef, itemCount: 2, path: '/private/leak' });
  assert.deepEqual(seen, [{ batchRef, itemCount: 2 }]);
  await stop();
  assert.equal(removed, true);
});

test('owned listing recovers durable scanner results and delete or clear stay exact', async () => {
  const native = nativeStub();
  native.listOwned = async options => {
    assert.deepEqual(options, {});
    return { items: [{ kind: 'file', ref: ownedRef, displayName: 'Scan.pdf', mimeType: 'application/pdf', sizeBytes: 25, contentHash: 'a'.repeat(64), createdAt: 1, available: true, pending: false }] };
  };
  native.deleteOwned = async options => {
    assert.deepEqual(options, { ref: ownedRef });
    return { deleted: true };
  };
  native.clearOwned = async options => {
    assert.deepEqual(options, {});
    return { deletedCount: 1 };
  };
  native.clearOwnedPayloads = async options => {
    assert.deepEqual(options, {});
    return { clearedCount: 1 };
  };
  const client = new AndroidDocumentsClient(native);
  const items = await client.listOwned();
  assert.equal(items.length, 1);
  assert.equal(items[0].displayName, 'Scan.pdf');
  assert.equal(Object.isFrozen(items), true);
  assert.equal(await client.deleteOwned(ownedRef), true);
  assert.equal(await client.clearOwned(), 1);
  assert.equal(await client.clearOwnedPayloads(), 1);
  await assert.rejects(client.deleteOwned('a1_1'), TypeError);
});

test('payload-only clear retains strict unavailable owned records', async () => {
  const native = nativeStub();
  native.listOwned = async () => ({
    items: [{
      kind: 'file', ref: ownedRef, displayName: 'Cleared.pdf', mimeType: 'application/pdf',
      sizeBytes: 25, contentHash: 'b'.repeat(64), createdAt: 2,
      available: false, pending: false,
    }],
  });
  const [item] = await new AndroidDocumentsClient(native).listOwned();
  assert.equal(item.available, false);

  for (const invalid of [
    { clearedCount: -1 }, { clearedCount: 1.5 }, { clearedCount: 10_001 },
    { clearedCount: 1, path: '/private/item' },
  ]) {
    native.clearOwnedPayloads = async () => invalid;
    await assert.rejects(new AndroidDocumentsClient(native).clearOwnedPayloads(), TypeError);
  }
});

test('owned rename is exact, d1-only, and accepts only completed status', async () => {
  const native = nativeStub();
  const calls: unknown[] = [];
  native.renameItem = async options => {
    calls.push(options);
    return { status: 'completed' };
  };
  const client = new AndroidDocumentsClient(native);
  const result = await client.renameItem(ownedRef, 'Renamed document.pdf');
  assert.deepEqual(result, { status: 'completed' });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(calls, [{ ref: ownedRef, displayName: 'Renamed document.pdf' }]);
  await assert.rejects(client.renameItem('a1_1', 'Legacy.pdf'), TypeError);
  await assert.rejects(client.renameItem(ownedRef, 'bad/name'), TypeError);
  await assert.rejects(client.renameItem(ownedRef, 'bad\ud800name'), TypeError);
  for (const invalid of [
    {}, { status: 'completed', path: '/private/item' }, { status: 'cancelled' },
  ]) {
    native.renameItem = async () => invalid;
    await assert.rejects(client.renameItem(ownedRef, 'Valid.pdf'), TypeError);
  }
});

test('reader result accepts only closed or a frozen allowlisted tool route', async () => {
  const native = nativeStub();
  const client = new AndroidDocumentsClient(native);
  assert.deepEqual(await client.openReader('a1_1', 'Legacy.pdf'), { action: 'closed' });
  native.openReader = async options => {
    assert.deepEqual(options, { ref: ownedRef, displayName: 'Scan.pdf' });
    return { action: 'tool', toolPath: '/compress' };
  };
  const tool = await client.openReader(ownedRef, 'Scan.pdf');
  assert.deepEqual(tool, { action: 'tool', toolPath: '/compress' });
  assert.equal(Object.isFrozen(tool), true);
  for (const invalid of [
    { action: 'tool', toolPath: '/view' },
    { action: 'closed', toolPath: '/compress' },
    { action: 'failed' },
    { action: 'closed', uri: 'content://private' },
  ]) {
    native.openReader = async () => invalid;
    await assert.rejects(client.openReader(ownedRef, 'Scan.pdf'), TypeError);
  }
});

test('write client preserves an exact display name and rejects malformed public DTOs', async () => {
  const sessionRef = `w1_${'B'.repeat(22)}`;
  const native = nativeStub();
  native.beginWrite = async options => {
    assert.deepEqual(options, { mimeType: 'application/pdf', displayName: 'output.pdf' });
    return { sessionRef, maximumChunkBytes: 524288 };
  };
  native.appendWrite = async options => { assert.equal(options.sessionRef, sessionRef); assert.equal(options.data, 'AQID'); return { acceptedBytes: 3 }; };
  native.finishWrite = async () => ({ item: { kind: 'file', ref: ownedRef, displayName: 'output.pdf', mimeType: 'application/pdf', sizeBytes: 3, contentHash: 'a'.repeat(64), createdAt: 0, available: true, pending: false } });
  native.abortWrite = async () => ({ aborted: false });
  const client = new AndroidDocumentsClient(native);
  const session = await client.beginWrite('application/pdf', 'output.pdf');
  assert.equal(await client.appendWrite(session.sessionRef, new Uint8Array([1, 2, 3])), 3);
  assert.equal((await client.finishWrite(session.sessionRef)).displayName, 'output.pdf');
  assert.equal(await client.abortWrite(session.sessionRef), false);
  await assert.rejects(client.beginWrite('application/pdf', 'bad/name'), TypeError);
  await assert.rejects(client.beginWrite('application/pdf', 'bad\ud800name'), TypeError);
  await assert.rejects(client.beginWrite('application/pdf', 'bad\udc00name'), TypeError);
});

test('native export and share use exact opaque metadata and strict terminal status', async () => {
  const native = nativeStub();
  const calls: unknown[] = [];
  native.exportItem = async options => {
    calls.push(['export', options]);
    return { status: 'completed' };
  };
  native.shareItem = async options => {
    calls.push(['share', options]);
    return { status: 'cancelled' };
  };
  const client = new AndroidDocumentsClient(native);
  assert.deepEqual(
    await client.exportItem(ownedRef, 'Scan.pdf', 'application/pdf'),
    { status: 'completed' },
  );
  assert.deepEqual(await client.shareItem('a1_1'), { status: 'cancelled' });
  assert.deepEqual(calls, [
    ['export', { ref: ownedRef, displayName: 'Scan.pdf', mimeType: 'application/pdf' }],
    ['share', { ref: 'a1_1' }],
  ]);

  for (const invalidRef of ['a1_01', 'd1_short', 'content://provider/item']) {
    await assert.rejects(client.exportItem(invalidRef), TypeError);
  }
  await assert.rejects(client.shareItem(ownedRef, 'bad/name', 'application/pdf'), TypeError);
  await assert.rejects(
    client.exportItem(ownedRef, 'Scan.pdf', 'application/javascript' as never),
    TypeError,
  );
  for (const invalid of [
    {}, { status: 'completed', uri: 'content://private' }, { status: 'failed' },
  ]) {
    native.exportItem = async () => invalid;
    await assert.rejects(client.exportItem(ownedRef), TypeError);
  }
});

test('T928: logical collection delivery accepts an opaque legacy ref and deliberately omits MIME', async () => {
  const native = nativeStub();
  const calls: unknown[] = [];
  native.exportItem = async options => {
    calls.push(options);
    return { status: 'completed' };
  };
  native.shareItem = async options => {
    calls.push(options);
    return { status: 'completed' };
  };
  const client = new AndroidDocumentsClient(native);

  await client.exportItem('a1_21', 'Split pages');
  await client.shareItem('a1_21', 'Split pages');
  assert.deepEqual(calls, [
    { ref: 'a1_21', displayName: 'Split pages' },
    { ref: 'a1_21', displayName: 'Split pages' },
  ]);
  for (const options of calls as Record<string, unknown>[]) {
    assert.deepEqual(Reflect.ownKeys(options), ['ref', 'displayName']);
    assert.equal('mimeType' in options, false);
    assert.equal('items' in options, false);
    assert.equal('path' in options, false);
    assert.equal('uri' in options, false);
  }
});


test('generated output delivery accepts owned ZIP, text and WebP without widening ingress or legacy reads', async () => {
  const client = new AndroidDocumentsClient(nativeStub());
  for (const mime of ['application/zip', 'text/plain', 'image/webp'] as const) {
    await client.exportItem(ownedRef, 'Output', mime);
    await client.shareItem(ownedRef, 'Output', mime);
    await assert.rejects(client.exportItem('a1_1', 'Output', mime), TypeError);
    await assert.rejects(client.pickDocuments([mime as never], 1), TypeError);
  }
});


test('external PDF events are separate from picker events and accept only opaque owned refs', async () => {
  const native = nativeStub();
  let incoming: ((event: unknown) => void) | undefined;
  const received: string[] = [];
  native.addListener = async (name, listener) => {
    assert.equal(name, 'incomingPdfReady'); incoming = listener;
    return { remove: async () => undefined };
  };
  await new AndroidDocumentsClient(native).addIncomingPdfListener(ref => received.push(ref));
  incoming!({ ref: ownedRef });
  incoming!({ ref: 'a1_1' });
  incoming!({ ref: 'content://private/document' });
  incoming!({ ref: ownedRef, toolPath: '/edit' });
  incoming!({ batchRef: 'b1_' + 'A'.repeat(22), itemCount: 1 });
  assert.deepEqual(received, [ownedRef]);
});

// NAV-45, FIL-31: a refused hand-over now reaches the page, as one of three fixed words.
test('refused external PDF events carry only an allow-listed reason', async () => {
  const native = nativeStub();
  let rejected: ((event: unknown) => void) | undefined;
  const received: string[] = [];
  native.addListener = async (name, listener) => {
    assert.equal(name, 'incomingPdfRejected'); rejected = listener;
    return { remove: async () => undefined };
  };
  await new AndroidDocumentsClient(native).addIncomingPdfRejectedListener(reason => received.push(reason));
  for (const reason of ['tooLarge', 'notPdf', 'other']) rejected!({ reason });
  rejected!({ reason: 'DOCUMENT_CORRUPT' });
  rejected!({ reason: 'notPdf', ref: ownedRef });
  rejected!({ ref: ownedRef });
  rejected!(null);
  assert.deepEqual(received, ['tooLarge', 'notPdf', 'other']);
});

// Release QA NAV-29 / ORG-51: the app showed one name while Downloads held "Name (1).pdf", and a
// rename never reached the saved copy. Export now reports the stored name and a rename handle.
test('export reports the name Downloads kept, and only that copy can be renamed', async () => {
  const native = nativeStub();
  const exportRef = `pdfchef-${'B'.repeat(22)}`;
  native.exportItem = async () => ({ status: 'completed', exportRef, savedName: 'Report (1).pdf' });
  const calls: unknown[] = [];
  native.renameExport = async options => {
    calls.push(options);
    return { status: 'completed', savedName: 'Invoice.pdf' };
  };
  const client = new AndroidDocumentsClient(native);
  assert.deepEqual(await client.exportItem(ownedRef, 'Report.pdf', 'application/pdf'),
    { status: 'completed', exportRef, savedName: 'Report (1).pdf' });
  assert.equal(await client.renameExport(exportRef, 'Invoice.pdf'), 'Invoice.pdf');
  assert.deepEqual(calls, [{ exportRef, displayName: 'Invoice.pdf' }]);

  await assert.rejects(client.renameExport('content://media/1', 'Invoice.pdf'), TypeError);
  await assert.rejects(client.renameExport(exportRef, 'a/b.pdf'), TypeError);
  await assert.rejects(client.renameExport(exportRef, 'x'.repeat(181)), TypeError);
  for (const invalid of [
    { status: 'completed', exportRef: 'content://media/1', savedName: 'Report.pdf' },
    { status: 'completed', exportRef, savedName: '' },
    { status: 'cancelled', exportRef, savedName: 'Report.pdf' },
    { status: 'completed', exportRef, savedName: 'Report.pdf', path: '/storage/x' },
  ]) {
    native.exportItem = async () => invalid;
    await assert.rejects(client.exportItem(ownedRef, 'Report.pdf', 'application/pdf'), TypeError);
  }
  for (const invalid of [{ status: 'completed' }, { status: 'completed', savedName: 'a/b' }]) {
    native.renameExport = async () => invalid;
    await assert.rejects(client.renameExport(exportRef, 'Invoice.pdf'), TypeError);
  }
});
