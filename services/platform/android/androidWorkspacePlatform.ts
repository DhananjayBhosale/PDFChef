import { LocalizedError } from '../../i18n/errors.ts';
import type {
  RecentEntry,
  RecentRecord,
  StoredCollection,
  StoredDocument,
} from '../../domain/workspaceModels.ts';
import type {
  ImportedDocument,
  FreshResult,
  OutputDeliveryHandler,
  PendingImportDeliveryService,
  RecordAbilities,
  RecordRecoveryService,
  SavedCopy,
  UndoReceipt,
  WorkspacePlatform,
} from '../contracts.ts';
import { Capacitor } from '@capacitor/core';
import {
  ANDROID_PICKER_MIME_TYPES,
  ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES,
  ANDROID_DOCUMENT_MAXIMUM_FILE_BYTES,
  AndroidDocumentsClient,
  type AndroidDeliveryResult,
  type AndroidOwnedDocument,
  type AndroidPendingDocument,
  type SupportedOwnedMime,
  type SupportedPickerMime,
} from './androidDocuments.ts';
import {
  createAndroidDocumentScannerService,
  isAndroidDocumentScannerAvailable,
} from './androidDocumentScanner.ts';
import {
  createAndroidPdfReaderService,
  isAndroidNativePdfReaderAvailable,
} from './androidPdfReader.ts';
import {
  AndroidLegacyInspectorClient,
} from './androidLegacyInspector.ts';
import {
  AndroidAppMetadataClient,
  isAndroidAppMetadataAvailable,
} from './androidAppMetadata.ts';
import {
  AndroidStorageStatsClient,
  isAndroidStorageStatsAvailable,
} from './androidStorageStats.ts';
import { setDeviceMemorySource } from '../../imageNormalization.ts';
import { assertOutputSize, installOutputDeliveryHandler } from '../../pdfShared.ts';
import type {
  AndroidLegacyCollectionHistoryEntry,
  AndroidLegacyFileHistoryEntry,
  AndroidLegacyHistoryEntry,
} from './legacyCompatibilityContracts.ts';

type AndroidLegacyHistoryClient = Pick<AndroidLegacyInspectorClient, 'readHistory'>;

const LEGACY_HISTORY_UNAVAILABLE_ERROR = 'Legacy history is unavailable.';

/**
 * The Android workspace, assembled once.
 *
 * The browser adapter still owns everything it already did: results produced in
 * this session, their bytes, and the save and share paths that work in a
 * WebView. This adds the two things the browser cannot see — documents this app
 * owns on the device, and the file history the older Android app left behind —
 * and routes their delete and clear to whatever actually owns them.
 *
 * No native address, path or URI is constructed here. A document is addressed
 * only by its opaque `d1_` or `a1_` ref, and its bytes arrive as bounded chunks
 * over the same seam every other Android read uses.
 */

/** Native documents are listed under their own id space so no browser id can collide. */
const SYNTHETIC_PREFIX = 'android:';
/** The older Android app's history is readable and openable, and nothing more. */
const LEGACY_REF = /^a1_[1-9][0-9]*$/;
/**
 * The exact durable ref shape this app owns, held to the same form the client
 * validates. A row addressed by anything else is not ours to rename or trash,
 * and asking the native store about it would be a request it must reject.
 */
const OWNED_REF = /^d1_[A-Za-z0-9_-]{22,64}$/;

const syntheticId = (ref: string): string => `${SYNTHETIC_PREFIX}${ref}`;

const refFromSyntheticId = (id: unknown): string | null =>
  typeof id === 'string' && id.startsWith(SYNTHETIC_PREFIX)
    ? id.slice(SYNTHETIC_PREFIX.length)
    : null;

export const isLegacyAndroidRef = (ref: unknown): boolean =>
  typeof ref === 'string' && LEGACY_REF.test(ref);

export const isOwnedAndroidRef = (ref: unknown): ref is string =>
  typeof ref === 'string' && OWNED_REF.test(ref);

const FALLBACK_NAME = 'Document';

interface AndroidDeviceFactClients {
  readonly metadata: Pick<AndroidAppMetadataClient, 'getMetadata'> | null;
  readonly storage: Pick<AndroidStorageStatsClient, 'getStorageStats'> | null;
}

const deviceFactClients = (
  override: AndroidDeviceFactClients | undefined,
): AndroidDeviceFactClients => override ?? {
  metadata: isAndroidAppMetadataAvailable() ? new AndroidAppMetadataClient() : null,
  storage: isAndroidStorageStatsAvailable() ? new AndroidStorageStatsClient() : null,
};

/**
 * Device facts already have strict native clients. This adapter only translates
 * their method names into the shared Settings services; it neither substitutes
 * defaults nor catches failures, so the existing hooks keep their error state.
 */
const withDeviceFacts = (
  base: WorkspacePlatform,
  clients: AndroidDeviceFactClients,
): WorkspacePlatform => {
  const platform: WorkspacePlatform = { ...base };
  const metadata = clients.metadata;
  const storage = clients.storage;
  if (metadata) {
    platform.applicationMetadata = {
      getApplicationMetadata: () => metadata.getMetadata(),
    };
  }
  if (storage) {
    platform.storageInformation = {
      getStorageInformation: () => storage.getStorageStats(),
    };
  }
  return platform;
};

/**
 * One `readChunk` per pull, so a large document is never held in memory twice
 * and a cancelled read stops asking for the next window.
 */
const openOwnedStream = (
  documents: AndroidDocumentsClient,
  ref: string,
): ReadableStream<Uint8Array> => {
  let offset = 0;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      const chunk = await documents.readChunk(ref, offset, ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES);
      offset = chunk.nextOffset;
      if (chunk.data.length > 0) controller.enqueue(chunk.data);
      if (chunk.done) {
        done = true;
        controller.close();
      }
    },
  });
};

interface NativeDocumentView {
  kind: 'file';
  ref: string;
  name: string;
  mimeType: string;
}

interface NativeCollectionView {
  kind: 'collection';
  ref: string;
  name: string;
}

type NativeView = NativeDocumentView | NativeCollectionView;

const viewOf = (record: RecentRecord): NativeView | null => {
  const ref = refFromSyntheticId(record.entry.id);
  if (!ref) return null;
  if (record.collection?.ref === ref && isLegacyAndroidRef(ref)) {
    return {
      kind: 'collection',
      ref,
      name: record.collection.name ?? record.entry.name ?? FALLBACK_NAME,
    };
  }
  const legacy = isLegacyAndroidRef(ref);
  return {
    kind: 'file',
    ref,
    name: record.entry.name ?? FALLBACK_NAME,
    mimeType: record.document?.mimeType
      ?? record.entry.mimeType
      ?? (legacy ? 'application/pdf' : 'application/octet-stream'),
  };
};

const nativeBlob = async (documents: AndroidDocumentsClient, view: NativeView): Promise<Blob> =>
  new Response(openOwnedStream(documents, view.ref)).blob();

const nativeFile = async (
  documents: AndroidDocumentsClient,
  view: NativeDocumentView,
): Promise<File> =>
  new File([await nativeBlob(documents, view)], view.name, { type: view.mimeType });

const savedCopyOf = (result: AndroidDeliveryResult): SavedCopy | undefined =>
  result.status === 'completed' && result.savedName
    ? { savedName: result.savedName, ...(result.exportRef ? { exportRef: result.exportRef } : {}) }
    : undefined;

const ownedRecordOf = (item: AndroidOwnedDocument): RecentRecord => {
  const ref = item.ref as StoredDocument['ref'];
  const document: StoredDocument = {
    ref,
    name: item.displayName ?? FALLBACK_NAME,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    contentHash: item.contentHash,
    retainedAt: item.createdAt,
  };
  const entry: RecentEntry = {
    id: syntheticId(item.ref),
    documentRef: ref,
    name: item.displayName ?? FALLBACK_NAME,
    mimeType: item.mimeType,
    // The store keeps the file, not the operation that made it, so claiming a
    // tool here would be an invention. Recent already says "Tool not recorded".
    toolId: null,
    createdAt: item.createdAt,
    inputSizeBytes: null,
    outputSizeBytes: item.sizeBytes,
    spaceSavedBytes: null,
  };
  return { entry, document, available: item.available };
};

const importedDocumentOf = (item: AndroidPendingDocument): ImportedDocument => ({
  document: {
    ref: item.ref as StoredDocument['ref'],
    name: item.displayName ?? FALLBACK_NAME,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    contentHash: item.contentHash,
    retainedAt: item.createdAt,
  },
});

/**
 * A history row from the older app. Everything it does not record stays
 * unrecorded: no MIME, size or time is invented to make a row look complete.
 * Only a verified PDF with a real positive size gets a document, which is what
 * decides whether the native reader will take it; everything else keeps the web
 * reader it already had.
 */
const legacyRecordOf = (item: AndroidLegacyFileHistoryEntry): RecentRecord => {
  const ref = item.ref as string as StoredDocument['ref'];
  const readableAsPdf =
    item.available
    && item.mimeType === 'application/pdf'
    && typeof item.sizeBytes === 'number'
    && item.sizeBytes > 0;
  const entry: RecentEntry = {
    id: syntheticId(item.ref),
    documentRef: ref,
    name: item.displayName,
    mimeType: item.mimeType,
    toolId: item.toolId,
    createdAt: item.createdAt,
    inputSizeBytes: null,
    outputSizeBytes: item.sizeBytes,
    spaceSavedBytes: null,
  };
  return {
    entry,
    document: readableAsPdf
      ? {
          ref,
          name: item.displayName,
          mimeType: 'application/pdf',
          sizeBytes: item.sizeBytes,
          contentHash: null,
          retainedAt: item.createdAt,
        }
      : null,
    available: item.available,
  };
};

/**
 * A legacy batch output is one logical collection, not a pretend PDF. Child
 * names and native addresses remain behind the opaque collection ref; Recent
 * receives only the aggregate facts the legacy inspector already exposes.
 */
const legacyCollectionRecordOf = (
  item: AndroidLegacyCollectionHistoryEntry,
): RecentRecord => {
  const ref = item.ref as string as StoredCollection['ref'];
  const collection: StoredCollection = {
    ref,
    name: item.displayName,
    // The legacy index records a child count but no trustworthy aggregate size.
    sizeBytes: null,
    retainedAt: item.createdAt,
    itemCount: item.itemCount,
  };
  const entry: RecentEntry = {
    id: syntheticId(item.ref),
    // A collection has no single document ref or byte representation.
    documentRef: null,
    name: item.displayName,
    mimeType: null,
    toolId: item.toolId,
    createdAt: item.createdAt,
    inputSizeBytes: null,
    outputSizeBytes: null,
    spaceSavedBytes: null,
  };
  return {
    entry,
    document: null,
    collection,
    available: item.available,
  };
};

const legacyWorkspaceRecordOf = (item: AndroidLegacyHistoryEntry): RecentRecord =>
  item.kind === 'collection' ? legacyCollectionRecordOf(item) : legacyRecordOf(item);

/** The one opaque durable identity used for cross-layer merge/deduplication. */
const retainedRefOf = (record: RecentRecord): string | null =>
  typeof record.document?.ref === 'string'
    ? record.document.ref
    : typeof record.collection?.ref === 'string'
      ? record.collection.ref
      : typeof record.entry.documentRef === 'string'
        ? record.entry.documentRef
        : null;

/**
 * The Android platform. `base` stays responsible for everything produced in the
 * current session; this only adds the durable and legacy layers on top of it.
 */
export const createAndroidWorkspacePlatform = (
  base: WorkspacePlatform,
  documentsOverride?: AndroidDocumentsClient,
  activatePendingRecovery = documentsOverride === undefined,
  deviceFactsOverride?: AndroidDeviceFactClients,
  legacyOverride?: AndroidLegacyHistoryClient | null,
): WorkspacePlatform => {
  const deviceFacts = deviceFactClients(deviceFactsOverride);
  const platformWithDeviceFacts = withDeviceFacts(base, deviceFacts);
  const storage = deviceFacts.storage;
  if (storage) setDeviceMemorySource(async () => (await storage.getStorageStats()).memoryBytes);
  // The Android branch is selected by the native shell before this adapter is
  // created. Do not turn a transient Capacitor plugin-header discovery miss
  // into a whole-session empty Recent list: construct the fixed registered
  // proxies and let a genuine native failure reach the existing error state.
  if (!documentsOverride && Capacitor.getPlatform() !== 'android') return platformWithDeviceFacts;

  const documents = documentsOverride ?? new AndroidDocumentsClient();
  const legacy = legacyOverride === undefined
    ? (Capacitor.getPlatform() === 'android' ? new AndroidLegacyInspectorClient() : null)
    : legacyOverride;

  const transientRefs = new Set<string>();
  const listOwned = async (): Promise<readonly RecentRecord[]> =>
    (await documents.listOwned()).filter(item => !transientRefs.has(item.ref)).map(ownedRecordOf);

  const listLegacy = async (): Promise<readonly RecentRecord[]> => {
    if (!legacy) return [];
    const snapshot = await legacy.readHistory();
    if (snapshot.health === 'corrupt') {
      throw new Error(LEGACY_HISTORY_UNAVAILABLE_ERROR);
    }
    return snapshot.entries.map(legacyWorkspaceRecordOf);
  };

  /**
   * Per-row truth about what this build can do to one record. Only a canonical
   * durable ref whose file this app still holds can be renamed or trashed;
   * every other row carries the reason it cannot, so no control is ever
   * disabled without one.
   */
  const abilitiesFor = (record: RecentRecord): RecordAbilities => {
    const ref = refFromSyntheticId(record.entry.id);
    if (isLegacyAndroidRef(ref)) {
      return { rename: false, reversibleDelete: false, limitation: 'legacy-read-only' };
    }
    if (!isOwnedAndroidRef(ref)) {
      return { rename: false, reversibleDelete: false, limitation: 'session-only' };
    }
    if (!record.available) {
      return { rename: false, reversibleDelete: false, limitation: 'file-missing' };
    }
    return { rename: true, reversibleDelete: true, limitation: null };
  };

  /** The one place a record turns into a durable ref this app may write to. */
  const ownedRefFor = (record: RecentRecord): string => {
    const ref = refFromSyntheticId(record.entry.id);
    if (!isOwnedAndroidRef(ref) || !record.available) {
      throw new LocalizedError("android-workspace-platform.error.17284fe28e");
    }
    return ref;
  };

  const recordRecovery: RecordRecoveryService = {
    abilitiesFor,
    async deleteReversibly(record) {
      // The receipt is all that is kept: no path, no name, no bytes.
      const { undoRef, expiresAt } = await documents.trashOwned(ownedRefFor(record));
      return { undoRef, expiresAt };
    },
    async restore(receipt: UndoReceipt) {
      await documents.restoreOwned(receipt.undoRef);
    },
  };

  const pendingImports: PendingImportDeliveryService = {
    async start(consume) {
      let stopped = false;
      let delivery = Promise.resolve();
      const deliver = () => {
        const attempt = delivery.catch(() => undefined).then(async () => {
          if (stopped) return;
          const batch = await documents.takePendingImports();
          if (batch.batchRef === null) return;
          const imports = batch.items.map(importedDocumentOf);
          await consume(imports);
          if (stopped) return;
          await documents.acknowledgePendingImports(
            batch.batchRef,
            batch.items.map(item => item.ref),
          );
        });
        delivery = attempt;
        return attempt;
      };

      // Listener first, durable peek second: retained or lost events cannot hide a batch.
      const removeListener = await documents.addPendingImportListener(() => {
        void deliver().catch(() => {
          // The durable pending marker remains available to a later event or relaunch.
        });
      });
      try {
        await deliver();
      } catch (error) {
        stopped = true;
        await removeListener();
        throw error;
      }
      return async () => {
        stopped = true;
        await removeListener();
      };
    },
  };

  // The Android host has no separate React-owned bootstrap for pending imports.
  // Start the durable listener/peek as part of platform construction so a lost
  // event or process restart cannot strand a completed picker result. The
  // consumer boundary is intentionally storage-only: after it resolves, native
  // acknowledgement atomically promotes the exact batch into listOwned().
  let pendingRecoveryFailure: unknown = null;
  const pendingRecoveryReady = activatePendingRecovery
    ? pendingImports.start(async imports => { void imports; })
        .then(() => undefined)
        .catch((error: unknown) => { pendingRecoveryFailure = error; })
    : Promise.resolve();

  const requirePendingRecovery = async (): Promise<void> => {
    await pendingRecoveryReady;
    if (pendingRecoveryFailure !== null) throw pendingRecoveryFailure;
  };

  const pickerMimeTypes = (values: readonly string[] | undefined): readonly SupportedPickerMime[] => {
    const selected = values ?? ANDROID_PICKER_MIME_TYPES;
    const allowed = new Set<string>(ANDROID_PICKER_MIME_TYPES);
    if (selected.length < 1 || selected.length > ANDROID_PICKER_MIME_TYPES.length
        || selected.some(value => !allowed.has(value))
        || new Set(selected).size !== selected.length) {
      throw new TypeError('Android document request is invalid.');
    }
    return selected as readonly SupportedPickerMime[];
  };

  const platform: WorkspacePlatform = {
    ...platformWithDeviceFacts,

    capabilities: {
      // Owned documents survive a relaunch, which is the whole point of this layer.
      durableDocuments: true,
      // The durable store renames the record it already holds, so a new name
      // outlives the session. It is true of the rows this app owns and of
      // nothing else, which is why the surface asks `recordRecovery` per row
      // rather than reading this flag as a promise about every row.
      persistentRename: true,
      // Session and native records both retain metadata when only their payload
      // bytes are cleared, so the two destructive actions are now independent.
      separateClearActions: true,
      // AndroidDocumentExporter writes to MediaStore Downloads under RELATIVE_PATH Download/PDF Chef.
      exportFolder: 'Download/PDF Chef',
      // OwnedDocumentWriter.MAXIMUM_FILE_BYTES: larger results cannot be kept or saved.
      maximumOutputBytes: ANDROID_DOCUMENT_MAXIMUM_FILE_BYTES,
    },

    documentImport: {
      async importDocuments(options) {
        const maximumItems = options?.maximumItems ?? 100;
        if (!Number.isSafeInteger(maximumItems) || maximumItems < 1 || maximumItems > 100) {
          throw new TypeError('Android document request is invalid.');
        }
        const picked = await documents.pickDocuments(
          pickerMimeTypes(options?.acceptedMimeTypes),
          maximumItems,
        );
        if (picked.status === 'cancelled') return [];
        const imports = picked.items.map(importedDocumentOf);
        // Mapping the complete strict DTO is this direct call's consumer boundary.
        // Only then is the accepted T039 pending-to-owned transition acknowledged.
        await documents.acknowledgePendingImports(
          picked.batchRef,
          picked.items.map(item => item.ref),
        );
        return imports;
      },
      async takePendingImports() {
        const batch = await documents.takePendingImports();
        return batch.items.map(importedDocumentOf);
      },
    },

    pendingImports,

    recordRecovery,

    records: {
      async list() {
        // Recovery began during platform construction; awaiting it here does
        // not make listing a mutation trigger. A failed native recovery stays
        // a typed failure instead of being misreported as an empty Recent list.
        await requirePendingRecovery();
        const [session, owned, older] = await Promise.all([
          base.records.list(),
          listOwned(),
          listLegacy(),
        ]);
        const seen = new Set<string>();
        for (const record of session) {
          const ref = retainedRefOf(record);
          if (ref !== null) seen.add(ref);
        }
        const merge = (records: readonly RecentRecord[]) =>
          records.filter((record) => {
            const ref = retainedRefOf(record);
            if (ref === null || seen.has(ref)) return false;
            seen.add(ref);
            return true;
          });
        return [...session, ...merge(owned), ...merge(older)];
      },
      async delete(id) {
        const ref = refFromSyntheticId(id);
        if (!ref) {
          await base.records.delete(id);
          return;
        }
        // The older app's history is read-only by contract. It is never handed
        // to the owned-document delete, and the interface says so rather than
        // letting a press fail silently.
        if (isLegacyAndroidRef(ref)) {
          throw new LocalizedError("android-workspace-platform.error.ce5f360252");
        }
        await documents.deleteOwned(ref);
      },
      async clearRecords() {
        await base.records.clearRecords();
        await documents.clearOwned();
      },
      async clearDocuments() {
        await base.records.clearDocuments();
        await documents.clearOwnedPayloads();
      },
    },

    async save(record, name) {
      const view = viewOf(record);
      if (!view) return base.save(record, name);
      const result = await documents.exportItem(
        view.ref,
        name || view.name,
        view.kind === 'file' ? view.mimeType as SupportedOwnedMime : undefined,
      );
      return savedCopyOf(result);
    },

    async renameSaved(exportRef, name) {
      return documents.renameExport(exportRef, name);
    },

    async share(record, name) {
      const view = viewOf(record);
      if (!view) {
        if (!base.share) throw new LocalizedError("android-workspace-platform.error.f768cf1b34");
        return base.share(record, name);
      }
      await documents.shareItem(
        view.ref,
        name || view.name,
        view.kind === 'file' ? view.mimeType as SupportedOwnedMime : undefined,
      );
    },

    async rename(record, name) {
      const ref = refFromSyntheticId(record.entry.id);
      if (ref === null) {
        if (!base.rename) throw new LocalizedError("android-workspace-platform.error.0414c2710f");
        return base.rename(record, name);
      }
      if (isLegacyAndroidRef(ref)) {
        throw new LocalizedError("android-workspace-platform.error.ce5f360252");
      }
      // The same durable record is renamed in place. Nothing is copied, and the
      // ref the list already holds keeps addressing it.
      await documents.renameItem(ownedRefFor(record), name);
    },

    async reopen(record) {
      const view = viewOf(record);
      if (!view) return base.reopen(record);
      if (view.kind === 'collection') {
        throw new LocalizedError("android-workspace-platform.error.6e5880db7e");
      }
      return nativeFile(documents, view);
    },
  };

  if (isAndroidDocumentScannerAvailable()) {
    platform.documentScanner = createAndroidDocumentScannerService();
  }

  if (isAndroidNativePdfReaderAvailable()) {
    platform.pdfReader = createAndroidPdfReaderService(documents);
  }

  // The writer's closed MIME set includes generated ZIP, text and WebP outputs.
  // Keep picker ingress separate from delivery of validated, already-owned bytes.
  const RETAINABLE = new Set<string>([
    'application/pdf', 'application/zip', 'text/plain',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]);

  const retain = async (request: FreshResult, transient = false) => {
    if (request.blob.size < 1 || !RETAINABLE.has(request.mimeType)) {
      throw new LocalizedError("android-workspace-platform.error.48bf1b9e75");
    }
    // The native writer refuses this only after every chunk has crossed the bridge.
    assertOutputSize(request.blob.size, ANDROID_DOCUMENT_MAXIMUM_FILE_BYTES);
    const session = await documents.beginWrite(
      request.mimeType as SupportedOwnedMime,
      request.name,
    );
    try {
      for (let offset = 0; offset < request.blob.size; offset += session.maximumChunkBytes) {
        const chunk = await request.blob.slice(offset, offset + session.maximumChunkBytes).arrayBuffer();
        await documents.appendWrite(session.sessionRef, new Uint8Array(chunk));
      }
      return await documents.finishWrite(session.sessionRef, transient);
    } catch (failure) {
      await documents.abortWrite(session.sessionRef).catch(() => undefined);
      throw failure;
    }
  };

  const deliverOutput: OutputDeliveryHandler = async (request) => {
    if (!request.keepLocalHistory && !request.autoDownload) return;
    const document = await retain(request, !request.keepLocalHistory);
    if (!request.keepLocalHistory) transientRefs.add(document.ref);
    let exportIssue: 'cancelled' | 'failed' | undefined;
    let externallyExported = false;
    let savedCopy: SavedCopy | undefined;
    let kept = document;
    try {
      if (request.autoDownload) {
        try {
          const result = await documents.exportItem(document.ref, request.name, document.mimeType);
          if (result.status === 'cancelled') {
            if (request.keepLocalHistory) exportIssue = 'cancelled';
            else throw new LocalizedError("android-workspace-platform.error.ff5066dbb7");
          } else {
            externallyExported = true;
            savedCopy = savedCopyOf(result);
          }
        } catch (failure) {
          if (request.keepLocalHistory) exportIssue = 'failed';
          else throw failure;
        }
      }
      // Downloads adds " (1)" when the name is taken. Recent then uses the same name, so the
      // row and the file can be matched up.
      if (request.keepLocalHistory && savedCopy && savedCopy.savedName !== document.displayName) {
        try {
          await documents.renameItem(document.ref, savedCopy.savedName);
          kept = { ...document, displayName: savedCopy.savedName };
        } catch {
          // The saved file is what matters; Recent keeps the requested name.
        }
      }
      return {
        externallyExported,
        ...(exportIssue ? { exportIssue } : {}),
        ...(savedCopy ? { savedCopy } : {}),
        ...(request.keepLocalHistory ? { recentRecord: ownedRecordOf(kept) } : {}),
      };
    } finally {
      // A download-only result must not become a permanent Recent document.
      if (!request.keepLocalHistory) {
        await documents.deleteOwned(document.ref);
        transientRefs.delete(document.ref);
      }
    }
  };

  platform.saveFresh = async (result) => {
    const document = await retain(result, true);
    transientRefs.add(document.ref);
    try {
      const delivery = await documents.exportItem(document.ref, result.name, document.mimeType);
      if (delivery.status === 'cancelled') throw new LocalizedError("android-workspace-platform.error.ff5066dbb7");
      return savedCopyOf(delivery);
    } finally {
      await documents.deleteOwned(document.ref);
      transientRefs.delete(document.ref);
    }
  };
  platform.keepFresh = async (result) => {
    await retain(result);
  };
  platform.shareFresh = async (result) => {
    const document = await retain(result, true);
    transientRefs.add(document.ref);
    try {
      await documents.shareItem(document.ref, result.name, document.mimeType);
    } finally {
      await documents.deleteOwned(document.ref);
      transientRefs.delete(document.ref);
    }
  };

  installOutputDeliveryHandler(deliverOutput, { maximumBytes: ANDROID_DOCUMENT_MAXIMUM_FILE_BYTES });

  return platform;
};
