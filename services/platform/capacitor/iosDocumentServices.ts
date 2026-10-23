import { LocalizedError } from '../../i18n/errors.ts';
import { getLocale, subscribeLocale, t } from '../../i18n/core.ts';
import type {
  ApplicationMetadata,
  DurableDocumentRef,
  RecentEntry,
  RecentRecord,
  StoredDocument,
} from '../../domain/workspaceModels.ts';
import type {
  DocumentScanResult,
  DocumentScannerService,
  DocumentExportService,
  DocumentImportService,
  DocumentShareService,
  DocumentStorageService,
  HapticsService,
  ImportedDocument,
  PdfOpenHandoff,
  PdfOpenHandoffService,
  PendingImportDeliveryService,
  OutputDeliveryHandler,
  OutputDeliveryRequest,
  PdfSignatureVerificationService,
  RecentRepository,
  SettingsRepository,
  StorageInformation,
  StorageInformationService,
  WorkspacePlatform,
} from '../contracts.ts';
import { installOutputDeliveryHandler } from '../../pdfShared.ts';
import { setDeviceMemorySource } from '../../imageNormalization.ts';
import { announceRecordsChanged } from '../../workspace.ts';
import {
  PdfChefDocumentsBridge,
  isPdfChefDocumentsAvailable,
  type ListedDocument,
} from './pdfChefDocuments.ts';
import { createLocalWorkspaceRepositories } from '../local/localWorkspaceRepositories.ts';
import {
  IndexedDbLegacyWorkspaceSource,
  LocalStorageLegacyWorkspaceMigrationJournal,
  migrateLegacyWorkspace,
  type LegacyWorkspaceMigrationJournal,
  type LegacyWorkspaceSource,
} from './legacyWorkspaceMigration.ts';
import {
  createIOSPdfReaderService,
  type IOSPdfReaderNativeResult,
} from './iosPdfReader.ts';

export const IOS_PICKER_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

const FALLBACK_MIME_TYPE = 'application/octet-stream';
const READER_BUSY_RETRY_MS = 500;
const READER_BUSY_LIMIT_MS = 10 * 60 * 1000;

export interface IOSDocumentBridge {
  retain(
    input: ReadableStream<Uint8Array>,
    metadata: Pick<StoredDocument, 'name' | 'mimeType'> & { transient?: boolean },
  ): Promise<StoredDocument>;
  open(ref: DurableDocumentRef): ReadableStream<Uint8Array>;
  stat(ref: DurableDocumentRef): Promise<StoredDocument>;
  exists(ref: DurableDocumentRef): Promise<boolean>;
  listDocuments(): Promise<readonly ListedDocument[]>;
  rename(ref: DurableDocumentRef, name: string): Promise<StoredDocument>;
  delete(ref: DurableDocumentRef): Promise<void>;
  clear(): Promise<void>;
  storageInformation(): Promise<StorageInformation>;
  takePendingImports(): Promise<readonly ImportedDocument[]>;
  acknowledgePendingImports(refs: readonly DurableDocumentRef[]): Promise<void>;
  startPendingImportDelivery(
    consume: (imports: readonly ImportedDocument[]) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
  pickDocuments(
    acceptedMimeTypes: readonly string[],
    maximumItems: number,
  ): Promise<readonly ImportedDocument[]>;
  exportDocument(ref: DurableDocumentRef, name: string | null, mimeType: string | null): Promise<void>;
  shareDocument(ref: DurableDocumentRef, name: string | null, mimeType: string | null): Promise<void>;
  signatureVerificationAvailable?(): Promise<boolean>;
  presentSignatureReport?(ref: DurableDocumentRef, name: string | null): Promise<void>;
  openReader(ref: DurableDocumentRef, displayName: string): Promise<IOSPdfReaderNativeResult>;
  documentScannerAvailable?(): Promise<boolean>;
  scanDocument(): Promise<DocumentScanResult>;
  setLanguage(language: string): Promise<void>;
  signalHaptic(signal: string): Promise<void>;
  getApplicationMetadata(): Promise<ApplicationMetadata>;
}

export interface IOSWorkspacePlatform extends WorkspacePlatform {
  settings: SettingsRepository;
  recent: RecentRepository;
  pendingImports: PendingImportDeliveryService;
  /** Pending delivery registration, its initial peek, and legacy migration complete here. */
  ready: Promise<void>;
  dispose(): Promise<void>;
}

export interface IOSWorkspacePlatformOptions {
  bridge?: IOSDocumentBridge;
  settings?: SettingsRepository;
  recent?: RecentRepository;
  now?: () => number;
  legacyWorkspaceSource?: LegacyWorkspaceSource;
  legacyWorkspaceJournal?: LegacyWorkspaceMigrationJournal;
}

const documentMetadata = (
  name: string | null,
  mimeType: string | null,
): Pick<StoredDocument, 'name' | 'mimeType'> => ({
  name,
  mimeType,
});

const freshEntry = (document: StoredDocument, id: string, createdAt: number): RecentEntry => ({
  id,
  documentRef: document.ref,
  name: document.name,
  mimeType: document.mimeType,
  toolId: null,
  createdAt,
  inputSizeBytes: null,
  outputSizeBytes: document.sizeBytes,
  spaceSavedBytes: null,
});

const outputEntry = (
  document: StoredDocument,
  request: OutputDeliveryRequest,
  createdAt: number,
): RecentEntry => ({
  id: `output-${document.ref}`,
  documentRef: document.ref,
  name: request.name,
  mimeType: request.mimeType,
  toolId: request.toolPath || null,
  createdAt,
  inputSizeBytes: null,
  outputSizeBytes: document.sizeBytes,
  spaceSavedBytes: null,
});

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<BlobPart[]> => {
  const reader = stream.getReader();
  const parts: BlobPart[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return parts;
      const copy = next.value.slice();
      parts.push(copy.buffer as ArrayBuffer);
    }
  } finally {
    reader.releaseLock();
  }
};

export const createIOSWorkspacePlatform = (
  options: IOSWorkspacePlatformOptions = {},
): IOSWorkspacePlatform => {
  const bridge = options.bridge ?? new PdfChefDocumentsBridge();
  setDeviceMemorySource(async () => (await bridge.storageInformation()).memoryBytes);
  const sendLanguage = () => { bridge.setLanguage(getLocale()).catch(() => undefined); };
  sendLanguage();
  const stopLanguageUpdates = subscribeLocale(sendLanguage);
  const repositories =
    options.settings && options.recent
      ? { settings: options.settings, recent: options.recent }
      : createLocalWorkspaceRepositories();
  const settings = options.settings ?? repositories.settings;
  const recent = options.recent ?? repositories.recent;
  const now = options.now ?? Date.now;
  const transientRefs = new Set<DurableDocumentRef>();
  const reopenedDocuments = new WeakMap<File, StoredDocument>();
  let signatureVerificationAvailable = false;
  const pdfReader = createIOSPdfReaderService(bridge, {
    isSignatureVerificationAvailable: () => signatureVerificationAvailable,
  });
  const queuedPdfHandoffs: PdfOpenHandoff[] = [];
  let pdfHandoffConsumer: ((handoff: PdfOpenHandoff) => Promise<void> | void) | null = null;
  let pdfHandoffDelivery = Promise.resolve();

  const deliverPdfHandoff = async (handoff: PdfOpenHandoff): Promise<void> => {
    const consume = pdfHandoffConsumer;
    if (!consume) {
      queuedPdfHandoffs.push(handoff);
      return;
    }
    try {
      await consume(handoff);
    } catch (error) {
      // Keep the document for the next consumer rather than losing it.
      queuedPdfHandoffs.push(handoff);
      throw error;
    }
  };

  const publishPdfHandoff = (handoff: PdfOpenHandoff): Promise<void> => {
    if (!pdfHandoffConsumer) {
      queuedPdfHandoffs.push(handoff);
      return Promise.resolve();
    }
    // Deliveries stay in order, but one failed continuation must not stall every
    // later document: each delivery starts from the previous one's settlement.
    const delivery = pdfHandoffDelivery.catch(() => undefined).then(() => deliverPdfHandoff(handoff));
    pdfHandoffDelivery = delivery;
    return delivery;
  };

  const pdfOpenHandoffs: PdfOpenHandoffService = {
    async start(consume) {
      pdfHandoffConsumer = consume;
      // The whole backlog joins the delivery chain before anything is awaited, so a document
      // published meanwhile arrives after it. One that fails again is re-queued; the rest still arrive.
      const buffered = queuedPdfHandoffs.splice(0).map(handoff => publishPdfHandoff(handoff).catch(() => undefined));
      await Promise.all(buffered);
      return async () => {
        if (pdfHandoffConsumer === consume) pdfHandoffConsumer = null;
      };
    },
  };

  const records = {
    async list(): Promise<readonly RecentRecord[]> {
      const listed = await bridge.listDocuments();
      const documents = new Map(listed.map(value => [value.document.ref, value]));
      let entries = [...await recent.list()];
      const referenced = new Set(entries.flatMap(entry => (entry.documentRef ? [entry.documentRef] : [])));
      // A process death can happen after native commit and before the local record
      // write. Reconcile committed non-inbox documents instead of leaking bytes or
      // hiding durable work. Pending inbox items stay owned by peek/ack delivery.
      for (const retained of listed) {
        if (retained.pending || transientRefs.has(retained.document.ref) || referenced.has(retained.document.ref)) continue;
        const recovered = freshEntry(
          retained.document,
          `recovered-${retained.document.ref}`,
          retained.document.retainedAt ?? now(),
        );
        await recent.save(recovered);
        entries = [recovered, ...entries.filter(entry => entry.id !== recovered.id)];
        referenced.add(retained.document.ref);
      }
      return entries.map(entry => {
        const retained = entry.documentRef ? documents.get(entry.documentRef) : undefined;
        return {
          entry,
          document: retained?.document ?? null,
          available: retained?.available ?? false,
        };
      });
    },

    async delete(id: string): Promise<void> {
      const entry = await recent.get(id);
      if (!entry) return;
      if (entry.documentRef) {
        const stillReferenced = (await recent.list()).some(
          value => value.id !== id && value.documentRef === entry.documentRef,
        );
        if (!stillReferenced) {
          const retained = (await bridge.listDocuments()).some(value => value.document.ref === entry.documentRef);
          if (retained) await bridge.delete(entry.documentRef);
        }
      }
      await recent.delete(id);
    },

    async clearRecords(): Promise<void> {
      const retained = await bridge.listDocuments();
      for (const value of retained) {
        if (!value.pending && !transientRefs.has(value.document.ref)) await bridge.delete(value.document.ref);
      }
      await recent.clear();
    },

    async clearDocuments(): Promise<void> {
      await bridge.clear();
    },
  };

  const documentStorage: DocumentStorageService = {
    retain: (input, metadata) => bridge.retain(input, metadata),
    open: async ref => bridge.open(ref),
    list: async () => (await bridge.listDocuments()).map(value => ({
      document: value.document,
      available: value.available,
    })),
    rename: async (ref, name) => {
      await bridge.rename(ref, name);
    },
    delete: ref => bridge.delete(ref),
    clear: () => bridge.clear(),
    exists: ref => bridge.exists(ref),
  };

  const documentImport: DocumentImportService = {
    importDocuments: options => bridge.pickDocuments(
      options?.acceptedMimeTypes ?? IOS_PICKER_MIME_TYPES,
      options?.maximumItems ?? 100,
    ),
    // Peek only. Acknowledgement belongs to pendingImports.start after its consumer succeeds.
    takePendingImports: () => bridge.takePendingImports(),
  };

  const documentExport: DocumentExportService = {
    export: (ref, metadata) => bridge.exportDocument(ref, metadata.name, metadata.mimeType),
  };

  const documentShare: DocumentShareService = {
    share: (ref, metadata) => bridge.shareDocument(ref, metadata.name, metadata.mimeType),
  };

  const storageInformation: StorageInformationService = {
    getStorageInformation: () => bridge.storageInformation(),
  };

  const haptics: HapticsService = {
    signal: signal => bridge.signalHaptic(signal),
  };

  const pendingImports: PendingImportDeliveryService = {
    start: consume => bridge.startPendingImportDelivery(consume),
  };

  const retainFresh = async (result: { blob: Blob; name: string; mimeType: string }): Promise<StoredDocument> => {
    const document = await bridge.retain(
      result.blob.stream(),
      { ...documentMetadata(result.name, result.mimeType || result.blob.type || null), transient: true },
    );
    transientRefs.add(document.ref);
    return document;
  };

  // A PDF from another app can arrive while a share sheet, picker, report or another
  // reader is up. The web reader would open hidden behind it, with no Close button,
  // so wait for that screen to go away. A screen stuck this long keeps the old fallback.
  const openImportedReader = async (document: StoredDocument) => {
    const giveUpAt = now() + READER_BUSY_LIMIT_MS;
    for (;;) {
      try {
        return await pdfReader.open(document);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'PRESENTATION_BUSY' || now() >= giveUpAt) throw error;
        await new Promise(resolve => setTimeout(resolve, READER_BUSY_RETRY_MS));
      }
    }
  };

  const pendingImportRegistration = pendingImports.start(async imports => {
    for (const imported of imports) {
      const document = imported.document;
      // Opening a PDF the app already keeps hands back that document, so its Recent row
      // moves to the top instead of a second row appearing.
      const kept = (await recent.list()).find(value => value.documentRef === document.ref);
      const entry = kept
        ? { ...kept, createdAt: now() }
        : freshEntry(document, `import-${document.ref}`, document.retainedAt ?? now());
      await recent.save(entry);
      // The file is now in Recent. Acknowledge it before the reader opens: the reader
      // stays up until the user closes it, and if iOS ends the app meanwhile an
      // unacknowledged import would reopen on every launch.
      await bridge.acknowledgePendingImports([document.ref]).catch(() => undefined);
      // A warm Open-In arrives while Recent may already be on screen.
      if (typeof window !== 'undefined') announceRecordsChanged();
      const record = { entry, document, available: true };
      if (pdfReader.isEligible(document)) {
        try {
          const result = await openImportedReader(document);
          if (result.action === 'tool') {
            await publishPdfHandoff({ record, toolPath: result.toolPath }).catch(() => undefined);
          }
          continue;
        } catch {
          // A native launch failure falls back to the existing web reader.
        }
      }
      // A failed continuation is re-queued for retry and must not skip later imports.
      await publishPdfHandoff({ record, toolPath: '/view' }).catch(() => undefined);
    }
  });
  let stopPendingImports: (() => Promise<void>) | null = null;
  let pendingImportFailure: { readonly error: unknown } | null = null;
  const pendingImportReady = pendingImportRegistration
    .then(stop => { stopPendingImports = stop; })
    .catch(error => { pendingImportFailure = { error }; });
  const documentScanner: DocumentScannerService = { scan: () => bridge.scanDocument() };
  let scannerAvailable = false;
  const scannerCapabilityReady = (async () => {
    try {
      scannerAvailable = await bridge.documentScannerAvailable?.() ?? false;
    } catch {
      // Older native packages have no scanner; Create PDF keeps its camera button.
      scannerAvailable = false;
    }
  })();
  const signatureCapabilityReady = (async () => {
    try {
      signatureVerificationAvailable = await bridge.signatureVerificationAvailable?.() ?? false;
    } catch {
      // Older native packages do not expose this method. Their reader remains unchanged.
      signatureVerificationAvailable = false;
    }
  })();
  const initialized = Promise.all([pendingImportReady, signatureCapabilityReady, scannerCapabilityReady]).then(async () => {
    // The app renders after ready, so Create PDF sees the scanner from its first frame.
    if (scannerAvailable) platform.documentScanner = documentScanner;
    await migrateLegacyWorkspace({
      source: options.legacyWorkspaceSource ?? new IndexedDbLegacyWorkspaceSource(),
      journal: options.legacyWorkspaceJournal ?? new LocalStorageLegacyWorkspaceMigrationJournal(),
      bridge,
      recent,
    });
    if (pendingImportFailure) throw pendingImportFailure.error;
  });

  const deleteTransient = async (document: StoredDocument): Promise<void> => {
    try {
      if (await bridge.exists(document.ref)) await bridge.delete(document.ref);
    } finally {
      transientRefs.delete(document.ref);
    }
  };

  const pdfSignatureVerification: PdfSignatureVerificationService = {
    isEligible(file) {
      const document = reopenedDocuments.get(file);
      const documentMimeType = document?.mimeType?.toLocaleLowerCase();
      const hasPdfIdentity = documentMimeType
        ? documentMimeType === 'application/pdf'
        : file.type.toLocaleLowerCase() === 'application/pdf'
          || file.name.toLocaleLowerCase().endsWith('.pdf');
      return signatureVerificationAvailable
        && Boolean(document)
        && hasPdfIdentity;
    },
    async present(file) {
      const document = reopenedDocuments.get(file);
      const present = bridge.presentSignatureReport;
      if (!signatureVerificationAvailable || !document || !present) {
        throw new LocalizedError("ios-document-services.error.6bf1b5338a");
      }
      await present.call(bridge, document.ref, document.name ?? file.name);
    },
  };

  const deliverOutput: OutputDeliveryHandler = async request => {
    // iOS has no silent external download destination. Presenting a Files picker
    // here blocks the completed-result actions behind a second modal every time a
    // job finishes. Keep the durable copy when requested, then let OutputCenter's
    // explicit Download and Share actions own native presentation.
    if (!request.keepLocalHistory) return { externallyExported: false };

    const document = await bridge.retain(
      request.blob.stream(),
      documentMetadata(request.name, request.mimeType),
    );

    const entry = outputEntry(document, request, document.retainedAt ?? now());
    try {
      await recent.save(entry);
    } catch (error) {
      // Keep the retained file. records.list can reconstruct its metadata on
      // the next successful read rather than losing a completed operation.
      throw error;
    }
    return {
      externallyExported: false,
      recentRecord: { entry, document, available: true },
    };
  };

  let uninstallOutputDelivery = () => {};

  const platform: IOSWorkspacePlatform = {
    settings,
    recent,
    pendingImports,
    ready: initialized,
    async dispose(): Promise<void> {
      uninstallOutputDelivery();
      stopLanguageUpdates();
      try {
        await initialized;
      } catch {
        // The initialization failure remains observable through ready.
      } finally {
        await stopPendingImports?.();
      }
    },
    capabilities: {
      persistentRename: true,
      durableDocuments: true,
      separateClearActions: true,
      automaticExternalExport: false,
    },
    records,
    documentImport,
    documentStorage,
    documentExport,
    documentShare,
    storageInformation,
    haptics,
    applicationMetadata: {
      getApplicationMetadata: () => bridge.getApplicationMetadata(),
    },
    pdfReader,
    pdfOpenHandoffs,
    pdfSignatureVerification,
    save: (record, name) => {
      if (!record.document || !record.available) throw new LocalizedError("ios-document-services.error.402cf723fd");
      return bridge.exportDocument(record.document.ref, name, record.document.mimeType);
    },
    share: (record, name) => {
      if (!record.document || !record.available) throw new LocalizedError("ios-document-services.error.402cf723fd");
      return bridge.shareDocument(record.document.ref, name, record.document.mimeType);
    },
    async reopen(record): Promise<File> {
      if (!record.document || !record.available) throw new LocalizedError("ios-document-services.error.402cf723fd");
      const parts = await readAll(bridge.open(record.document.ref));
      const file = new File(parts, record.entry.name || record.document.name || t("use-workspace-runtime.untitled.document.9f6d7c"), {
        type: record.entry.mimeType || record.document.mimeType || FALLBACK_MIME_TYPE,
      });
      reopenedDocuments.set(file, record.document);
      return file;
    },
    async rename(record, name): Promise<void> {
      if (!record.document || !record.available) throw new LocalizedError("ios-document-services.error.402cf723fd");
      await bridge.rename(record.document.ref, name);
      try {
        await recent.save({ ...record.entry, name });
      } catch (error) {
        try {
          await bridge.rename(record.document.ref, record.document.name ?? record.entry.name ?? name);
        } catch {
          // Preserve the repository error; the next records.list still exposes the durable document.
        }
        throw error;
      }
    },
    async saveFresh(result): Promise<void> {
      const document = await retainFresh(result);
      try {
        await bridge.exportDocument(document.ref, result.name, result.mimeType || document.mimeType);
      } finally {
        await deleteTransient(document);
      }
    },
    async keepFresh(result): Promise<void> {
      const document = await bridge.retain(
        result.blob.stream(),
        documentMetadata(result.name, result.mimeType || result.blob.type || null),
      );
      await recent.save(freshEntry(document, `output-${document.ref}`, document.retainedAt ?? now()));
    },
    async shareFresh(result): Promise<void> {
      const document = await retainFresh(result);
      try {
        await bridge.shareDocument(document.ref, result.name, result.mimeType || document.mimeType);
      } finally {
        await deleteTransient(document);
      }
    },
  };
  uninstallOutputDelivery = installOutputDeliveryHandler(deliverOutput);
  return platform;
};

export { isPdfChefDocumentsAvailable };
