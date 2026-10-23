import type {
  ApplicationMetadata,
  DurableDocumentRef,
  RecentEntry,
  RecentRecord,
  StoredCollection,
  StoredDocument,
  StoredWorkspaceItem,
  WorkspaceSettings,
} from '../domain/workspaceModels.ts';

export interface SettingsRepository {
  load(): Promise<WorkspaceSettings | null>;
  save(settings: WorkspaceSettings): Promise<void>;
  clear(): Promise<void>;
}

export interface RecentRepository {
  list(): Promise<readonly RecentEntry[]>;
  get(id: string): Promise<RecentEntry | null>;
  save(entry: RecentEntry): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** Read and clear the joined recent-document view exposed to application UI. */
export interface WorkspaceRecordsService {
  list(): Promise<readonly RecentRecord[]>;
  delete(id: string): Promise<void>;
  clearRecords(): Promise<void>;
  clearDocuments(): Promise<void>;
}

export interface ImportedDocument {
  document: StoredDocument;
}

export interface DocumentImportService {
  importDocuments(options?: {
    acceptedMimeTypes?: readonly string[];
    maximumItems?: number;
  }): Promise<readonly ImportedDocument[]>;
  takePendingImports(): Promise<readonly ImportedDocument[]>;
}

export interface ListedStoredDocument {
  document: StoredDocument;
  available: boolean;
}

export interface ListedStoredCollection {
  collection: StoredCollection;
  available: boolean;
}

export interface ListedStoredWorkspaceItem {
  item: StoredWorkspaceItem;
  available: boolean;
}

export interface DocumentStorageService {
  retain(
    input: ReadableStream<Uint8Array>,
    metadata: Pick<StoredDocument, 'name' | 'mimeType'>,
  ): Promise<StoredDocument>;
  open(ref: DurableDocumentRef): Promise<ReadableStream<Uint8Array>>;
  list(): Promise<readonly ListedStoredDocument[]>;
  rename(ref: DurableDocumentRef, name: string): Promise<void>;
  delete(ref: DurableDocumentRef): Promise<void>;
  clear(): Promise<void>;
  exists(ref: DurableDocumentRef): Promise<boolean>;
}

export interface DocumentExportService {
  export(ref: DurableDocumentRef, metadata: Pick<StoredDocument, 'name' | 'mimeType'>): Promise<void>;
}

export interface DocumentShareService {
  share(ref: DurableDocumentRef, metadata: Pick<StoredDocument, 'name' | 'mimeType'>): Promise<void>;
}

export interface StorageInformation {
  retainedBytes: number;
  availableBytes: number | null;
  capacityBytes: number | null;
  /** The device's total memory, when the platform reports it. */
  memoryBytes?: number | null;
}

export interface StorageInformationService {
  getStorageInformation(): Promise<StorageInformation>;
}

export type HapticSignal = 'selection' | 'commit' | 'warning' | 'error';

export interface HapticsService {
  signal(signal: HapticSignal): Promise<void>;
}

export interface ApplicationMetadataService {
  getApplicationMetadata(): Promise<ApplicationMetadata>;
}

export type DocumentScanResult = Readonly<
  | { readonly status: 'cancelled' }
  | { readonly status: 'completed'; readonly document: StoredDocument; readonly pageCount: number }
>;

export interface DocumentScannerService {
  scan(): Promise<DocumentScanResult>;
}

export type PdfReaderResult = Readonly<
  | { readonly action: 'closed' }
  | { readonly action: 'tool'; readonly toolPath: string }
>;

export interface PdfReaderService {
  /** True only when this reader can open directly into its signature report. */
  readonly supportsSignatureVerification?: boolean;
  isEligible(document: StoredDocument): boolean;
  open(
    document: StoredDocument,
    options?: { readonly initialAction?: 'verify-signatures' },
  ): Promise<PdfReaderResult>;
}

/** A native-opened PDF that should continue in one of the existing web tool routes. */
export interface PdfOpenHandoff {
  readonly record: RecentRecord;
  readonly toolPath: string;
}

/**
 * Buffered native-to-web continuation for Open-In PDFs.
 *
 * Native reading does not copy the document through the JavaScript bridge. Only
 * when the reader chooses a web tool does the platform hand the durable record
 * back to React, which can reopen it through the existing bounded bridge.
 */
export interface PdfOpenHandoffService {
  start(consume: (handoff: PdfOpenHandoff) => Promise<void> | void): Promise<() => Promise<void>>;
}

/** Native-only signature details for the exact retained File returned by reopen. */
export interface PdfSignatureVerificationService {
  isEligible(file: File): boolean;
  present(file: File): Promise<void>;
}

/** Capabilities consumed by the React workspace without importing a native SDK. */
export interface WorkspaceCapabilities {
  persistentRename: boolean;
  durableDocuments: boolean;
  separateClearActions: boolean;
  /** False when the platform cannot write externally without presenting a picker. */
  automaticExternalExport?: boolean;
  /** Where saved copies land, as the phone's Files app shows it (Android: "Download/PDF Chef"). */
  exportFolder?: string;
  /** The largest file the platform can keep or save, when it has a fixed limit. */
  maximumOutputBytes?: number;
}

/** A copy written outside the app: the name the platform kept, and a handle to rename it. */
export interface SavedCopy {
  readonly savedName: string;
  readonly exportRef?: string;
}

/**
 * Why a record cannot be renamed or reversibly deleted. A code, not a sentence:
 * the surface owns the wording, this seam owns the fact.
 */
export type RecordLimitation =
  /** Owned by an older app on the same device. Readable, never writable. */
  | 'legacy-read-only'
  /** Kept only for this browser session, so a delete is permanent. */
  | 'session-only'
  /** The record survives but its file does not. */
  | 'file-missing';

/**
 * What a platform can actually do to one specific record.
 *
 * A capability flag answers for the whole build, and a store that owns some
 * rows while only reading others cannot be described by one flag. The surface
 * asks per record and states the limitation it gets back instead of guessing.
 */
export interface RecordAbilities {
  /** A new name is written back to the durable record behind this row. */
  readonly rename: boolean;
  /** Deleting this record is reversible until the receipt expires. */
  readonly reversibleDelete: boolean;
  /** Null when nothing is withheld. */
  readonly limitation: RecordLimitation | null;
}

/**
 * A deletion that can still be undone.
 *
 * `undoRef` is an opaque platform token. It is held in memory for the window
 * and nothing else: it is never rendered, persisted, or written to a log.
 */
export interface UndoReceipt {
  readonly undoRef: string;
  /** Epoch milliseconds after which restoring no longer works. */
  readonly expiresAt: number;
}

/**
 * Reversible deletion for the records a platform genuinely owns. Absent means
 * every deletion this platform performs is permanent, which is what the
 * surface then says.
 */
export interface RecordRecoveryService {
  abilitiesFor(record: RecentRecord): RecordAbilities;
  /** Rejects for any record `abilitiesFor` did not call reversible. */
  deleteReversibly(record: RecentRecord): Promise<UndoReceipt>;
  restore(receipt: UndoReceipt): Promise<void>;
}

export interface FreshResult {
  blob: Blob;
  name: string;
  mimeType: string;
}

export interface OutputDeliveryRequest {
  readonly blob: Blob;
  readonly name: string;
  readonly mimeType: string;
  readonly toolPath: string;
  readonly keepLocalHistory: boolean;
  readonly autoDownload: boolean;
}

/** A retained result is saved even when its optional external export needs retry. */
export interface OutputDeliveryResult {
  readonly exportIssue?: 'cancelled' | 'failed';
  /** Whether this delivery already wrote a copy outside the app. */
  readonly externallyExported?: boolean;
  /** The exact durable record retained for this output, when history is enabled. */
  readonly recentRecord?: RecentRecord;
  /** The copy written outside the app, when there was one. */
  readonly savedCopy?: SavedCopy;
}

export type OutputDeliveryHandler = (request: OutputDeliveryRequest) => Promise<void | OutputDeliveryResult>;

/**
 * Platform aggregate implemented by iOS and structurally compatible with the
 * existing AppRoot injection seam. The React-owned declaration can migrate to
 * this contract without changing runtime behaviour.
 */
export interface WorkspacePlatform {
  records: WorkspaceRecordsService;
  capabilities: WorkspaceCapabilities;
  documentImport?: DocumentImportService;
  documentStorage?: DocumentStorageService;
  documentExport?: DocumentExportService;
  documentShare?: DocumentShareService;
  storageInformation?: StorageInformationService;
  haptics?: HapticsService;
  applicationMetadata?: ApplicationMetadataService;
  documentScanner?: DocumentScannerService;
  pdfReader?: PdfReaderService;
  pdfOpenHandoffs?: PdfOpenHandoffService;
  pdfSignatureVerification?: PdfSignatureVerificationService;
  pendingImports?: PendingImportDeliveryService;
  recordRecovery?: RecordRecoveryService;
  save(record: RecentRecord, name: string): Promise<void | SavedCopy>;
  share?: (record: RecentRecord, name: string) => Promise<void>;
  reopen(record: RecentRecord): Promise<File>;
  rename?: (record: RecentRecord, name: string) => Promise<void>;
  /** Renames a copy an earlier save wrote; resolves to the name the platform kept. */
  renameSaved?: (exportRef: string, name: string) => Promise<string>;
  saveFresh(result: FreshResult): Promise<void | SavedCopy>;
  keepFresh?: (result: FreshResult) => Promise<void>;
  shareFresh?: (result: FreshResult) => Promise<void>;
}

/** Listener-first pending delivery. Refs are acknowledged only after consume resolves. */
export interface PendingImportDeliveryService {
  start(consume: (imports: readonly ImportedDocument[]) => Promise<void> | void): Promise<() => Promise<void>>;
}
