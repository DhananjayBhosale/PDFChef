import { localizeError } from '../services/i18n/errors.ts';
import english from '../services/i18n/en-US.ts';
import { t } from '../services/i18n/core.ts';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApplicationMetadataService,
  DocumentExportService,
  DocumentImportService,
  DocumentScannerService,
  DocumentShareService,
  DocumentStorageService,
  HapticsService,
  PdfSignatureVerificationService,
  PdfReaderService,
  PdfOpenHandoffService,
  RecordAbilities,
  RecordRecoveryService,
  StorageInformation,
  StorageInformationService,
} from '../services/platform/contracts';
import type {
  ApplicationMetadata,
  ByteCount,
  DurableDocumentRef,
  RecentEntry,
  StoredCollection,
  StoredDocument,
} from '../services/domain/workspaceModels';
import { calculateSpaceSaved, normalizeByteCount, toDurableDocumentRef } from '../services/domain/workspacePolicy';
import {
  clearOutputDocuments,
  clearOutputs,
  deleteOutput,
  getOutput,
  listOutputs,
  recordOutput,
  type OutputRecord,
} from '../services/workspace';
import { triggerBrowserDownload } from '../services/pdfShared';

/**
 * The seam between the interface and the platform.
 *
 * Every port below is one of the typed contracts Codex owns. None of them are
 * assumed to exist: a port that has not been injected is simply absent, and the
 * interface renders an unavailable state that says so rather than pretending the
 * action succeeded. When Codex injects a real implementation the same components
 * light up with no visual change required.
 *
 * `records` is the one port the interface needs that
 * `services/platform/contracts.ts` does not declare yet — reading the retained
 * documents and recent entries back out of the store. It is typed here against
 * Codex's own domain models so adopting it later is a move, not a rewrite. See
 * docs/brand-guidelines.md and the handover notes for the exact request.
 */

export interface RecentRecord {
  entry: RecentEntry;
  /** The retained file behind the entry, when one is still on the device. */
  document: StoredDocument | null;
  /**
   * A logical group of files behind the entry, when a platform can enumerate
   * one. Deliberately not a `document`: a collection has no MIME type and no
   * single byte representation, so no surface may treat it as a file. The field
   * is optional, so every browser record stays exactly what it was.
   */
  collection?: StoredCollection | null;
  /** False when the record survives but its file does not. */
  available: boolean;
}

export interface WorkspaceRecordsService {
  list(): Promise<readonly RecentRecord[]>;
  delete(id: string): Promise<void>;
  clearRecords(): Promise<void>;
  clearDocuments(): Promise<void>;
}

export interface WorkspaceCapabilities {
  /** Rename is written back to the stored record, not only to the next save. */
  persistentRename: boolean;
  /** Documents survive a relaunch as durable files rather than session blobs. */
  durableDocuments: boolean;
  /** Records and retained files can be cleared independently of one another. */
  separateClearActions: boolean;
  /** False when an automatic download would only be a blocking system picker. */
  automaticExternalExport?: boolean;
}

/**
 * A result that has just been produced and is not yet a stored record.
 *
 * The Codex export and share contracts address a `DurableDocumentRef`, which a
 * fresh in-memory result does not have until something retains it. These two
 * optional hooks let a native adapter take that result directly; without them
 * the browser download and Web Share paths are used, and nothing is faked.
 */
export interface FreshResult {
  blob: Blob;
  name: string;
  mimeType: string;
}

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
  /**
   * A hardware document scanner, when the platform has one. Absent everywhere
   * else, so Create PDF shows its camera and gallery intake and nothing more.
   */
  documentScanner?: DocumentScannerService;
  /**
   * A native PDF reader for durable documents. Absent means the web reader is
   * the reader; no surface may assume one exists. Both ports are the exact
   * declarations from services/platform/contracts.ts.
   */
  pdfReader?: PdfReaderService;
  /** Buffered continuation after the native iOS reader chooses a web tool. */
  pdfOpenHandoffs?: PdfOpenHandoffService;
  /** Native signature details for the exact durable File returned by reopen. */
  pdfSignatureVerification?: PdfSignatureVerificationService;
  /**
   * Per-record abilities and reversible deletion. Absent means every deletion
   * this platform performs is permanent, which is what the surface then says.
   */
  recordRecovery?: RecordRecoveryService;
  /** Save a retained document to wherever the platform puts downloads. */
  save(record: RecentRecord, name: string): Promise<void>;
  /** Hand the document to the platform share sheet, when there is one. */
  share?: (record: RecentRecord, name: string) => Promise<void>;
  /** Re-open a retained document as a File the tool routes already accept. */
  reopen(record: RecentRecord): Promise<File>;
  rename?: (record: RecentRecord, name: string) => Promise<void>;
  /** Save a just-produced result. Falls back to the browser download. */
  saveFresh(result: FreshResult): Promise<void>;
  /** Keep a just-produced result in the app's Recent list. */
  keepFresh?: (result: FreshResult) => Promise<void>;
  /** Share a just-produced result, when the platform has a share sheet. */
  shareFresh?: (result: FreshResult) => Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Default adapter: the browser build that ships today.
 * It reports honestly on what it cannot do rather than faking it.
 * ------------------------------------------------------------------ */

export const FALLBACK_DOCUMENT_NAME = english["use-workspace-runtime.untitled.document.9f6d7c"];
export const FALLBACK_MIME_TYPE = 'application/octet-stream';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const timestamp = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * An opaque token, never a path.
 *
 * `toDurableDocumentRef` rejects anything that looks addressable, so the id is
 * first reduced to the characters that cannot be read as a scheme, a separator,
 * or a traversal. A record whose id survives none of that gets a null ref, which
 * the interface reports as a missing file rather than guessing one.
 */
const refFor = (id: unknown): DurableDocumentRef | null => {
  const cleaned = text(id).replace(/[^A-Za-z0-9._-]/g, '');
  if (!cleaned || cleaned.startsWith('.')) return null;
  return toDurableDocumentRef(`local-${cleaned}`);
};

/**
 * IndexedDB hands back whatever was written, including records from older
 * builds with fields this one expects. Everything is therefore checked at this
 * boundary, so no surface downstream has to defend itself against a missing
 * filename or a timestamp that is not a number.
 */
const toRecord = (output: OutputRecord): RecentRecord => {
  const ref = refFor(output.id);
  const outputSize = normalizeByteCount(output.size);
  const name = text(output.filename) || t("use-workspace-runtime.untitled.document.9f6d7c");
  const mimeType = text(output.mimeType) || text(output.blob?.type) || FALLBACK_MIME_TYPE;
  const createdAt = timestamp(output.createdAt);

  // The blob is what makes a record usable. A missing ref costs the record its
  // durable identity, not its availability, so a browser record that still holds
  // its bytes stays openable, savable and shareable.
  const hasBytes = output.blob instanceof Blob;

  const document: StoredDocument | null = ref
    ? {
        ref,
        name,
        mimeType,
        sizeBytes: outputSize,
        contentHash: null,
        retainedAt: createdAt,
      }
    : null;

  return {
    entry: {
      id: text(output.id),
      documentRef: ref,
      name,
      mimeType,
      toolId: text(output.toolPath),
      createdAt,
      // The browser store never captured the input size, so the saving is
      // genuinely unknown. Reporting null is the contract's own answer for that,
      // and the interface says "unknown" instead of guessing zero.
      inputSizeBytes: null,
      outputSizeBytes: outputSize,
      spaceSavedBytes: calculateSpaceSaved(null, outputSize),
    },
    document,
    available: hasBytes,
  };
};

const blobFor = async (record: RecentRecord): Promise<Blob> => {
  const output = record.entry.id ? await getOutput(record.entry.id) : undefined;
  if (!(output?.blob instanceof Blob)) {
    throw new Error(t("use-workspace-runtime.that.file.is.no.longer.stored.on.a99d6c"));
  }
  return output.blob;
};

/** A File always needs a name and a type; neither may arrive as undefined. */
const fileFrom = (blob: Blob, name: string, mimeType: string): File =>
  new File([blob], text(name) || t("use-workspace-runtime.untitled.document.9f6d7c"), {
    type: text(mimeType) || text(blob.type) || FALLBACK_MIME_TYPE,
  });

const canWebShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

const webShareFile = async (file: File, title: string) => {
  if (navigator.canShare && !navigator.canShare({ files: [file] })) {
    throw new Error(t("use-workspace-runtime.this.device.cannot.share.that.file.type.fe7f0e"));
  }
  await navigator.share({ files: [file], title });
};

/**
 * The browser build that ships today. Everything it cannot do is absent rather
 * than stubbed, so the interface can tell the difference.
 */
export const browserPlatform: WorkspacePlatform = {
  capabilities: {
    persistentRename: false,
    durableDocuments: false,
    separateClearActions: false,
  },
  records: {
    async list() {
      return (await listOutputs()).map(toRecord);
    },
    async delete(id) {
      await deleteOutput(id);
    },
    async clearRecords() {
      await clearOutputs();
    },
    async clearDocuments() {
      await clearOutputDocuments();
    },
  },
  async save(record, name) {
    const blob = await blobFor(record);
    triggerBrowserDownload(blob, text(name) || record.entry.name || t("use-workspace-runtime.untitled.document.9f6d7c"));
  },
  share: canWebShare()
    ? async (record, name) => {
        const blob = await blobFor(record);
        const resolved = text(name) || record.entry.name || t("use-workspace-runtime.untitled.document.9f6d7c");
        await webShareFile(fileFrom(blob, resolved, record.entry.mimeType), resolved);
      }
    : undefined,
  async reopen(record) {
    const blob = await blobFor(record);
    return fileFrom(blob, record.entry.name, record.entry.mimeType);
  },
  async saveFresh(result) {
    triggerBrowserDownload(result.blob, text(result.name) || t("use-workspace-runtime.untitled.document.9f6d7c"));
  },
  async keepFresh(result) {
    await recordOutput(result.blob, result.name, result.mimeType, window.location.pathname, true);
  },
  shareFresh: canWebShare()
    ? async (result) => {
        const resolved = text(result.name) || t("use-workspace-runtime.untitled.document.9f6d7c");
        await webShareFile(fileFrom(result.blob, resolved, result.mimeType), resolved);
      }
    : undefined,
};

/* ------------------------------------------------------------------ */

const WorkspacePlatformContext = createContext<WorkspacePlatform>(browserPlatform);

export const WorkspacePlatformProvider: React.FC<{
  platform?: WorkspacePlatform;
  children: React.ReactNode;
}> = ({ platform, children }) => { return (
  <WorkspacePlatformContext.Provider value={platform ?? browserPlatform}>
    {children}
  </WorkspacePlatformContext.Provider>
); };

export const useWorkspacePlatform = (): WorkspacePlatform => useContext(WorkspacePlatformContext);

/* ------------------------------------------------------------------ *
 * Loading / error / empty as one explicit state, so no surface has to
 * infer "empty" from "not loaded yet".
 * ------------------------------------------------------------------ */

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: T };

const messageFrom = (caught: unknown, fallback: string) =>
  caught instanceof Error && caught.message ? localizeError(caught) : fallback;

export const useRecentRecords = () => {
  const platform = useWorkspacePlatform();
  const [state, setState] = useState<AsyncState<readonly RecentRecord[]>>({ status: 'loading' });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const value = await platform.records.list();
      if (alive.current) setState({ status: 'ready', value });
    } catch (caught) {
      if (alive.current) {
        setState({ status: 'error', message: messageFrom(caught, t("use-workspace-runtime.local.records.could.not.be.read.on.2e67b3")) });
      }
    }
  }, [platform]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, refresh };
};

export const useStorageInformation = () => {
  const platform = useWorkspacePlatform();
  const [state, setState] = useState<AsyncState<StorageInformation | null>>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    const service = platform.storageInformation;
    if (!service) {
      setState({ status: 'ready', value: null });
      return () => {
        alive = false;
      };
    }
    service
      .getStorageInformation()
      .then((value) => {
        if (alive) setState({ status: 'ready', value });
      })
      .catch((caught: unknown) => {
        if (alive) setState({ status: 'error', message: messageFrom(caught, t("use-workspace-runtime.storage.usage.could.not.be.read.96fb6b")) });
      });
    return () => {
      alive = false;
    };
  }, [platform]);

  return state;
};

export const useApplicationMetadata = () => {
  const platform = useWorkspacePlatform();
  const [state, setState] = useState<AsyncState<ApplicationMetadata | null>>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    const service = platform.applicationMetadata;
    if (!service) {
      setState({ status: 'ready', value: null });
      return () => {
        alive = false;
      };
    }
    service
      .getApplicationMetadata()
      .then((value) => {
        if (alive) setState({ status: 'ready', value });
      })
      .catch((caught: unknown) => {
        if (alive) setState({ status: 'error', message: messageFrom(caught, t("use-workspace-runtime.version.information.is.unavailable.f0bee1")) });
      });
    return () => {
      alive = false;
    };
  }, [platform]);

  return state;
};

/**
 * Haptics are a design decision here and a platform capability elsewhere.
 * Signals fire on the causal event only: a commit, a snap, a failure. If no
 * haptics service is injected the call is a no-op, never a visual substitute.
 */
export const useHaptics = () => {
  const platform = useWorkspacePlatform();
  return useCallback(
    (signal: 'selection' | 'commit' | 'warning' | 'error') => {
      void platform.haptics?.signal(signal).catch(() => {
        /* A missing haptic is never worth interrupting the task for. */
      });
    },
    [platform],
  );
};

export type { RecordAbilities, RecordLimitation, UndoReceipt } from '../services/platform/contracts';

/**
 * What this platform can do to one record.
 *
 * A store that owns some rows and only reads others cannot be described by one
 * capability flag, so a platform with the recovery port answers per record. A
 * platform without it answers from its capabilities, which is exactly what
 * every build did before durable rows existed: rename where the store writes
 * names back, and a permanent delete everywhere.
 */
export const recordAbilities = (platform: WorkspacePlatform, record: RecentRecord): RecordAbilities => {
  const answered = platform.recordRecovery?.abilitiesFor(record);
  if (answered) return answered;
  const rename = Boolean(platform.capabilities.persistentRename && platform.rename);
  return { rename, reversibleDelete: false, limitation: rename ? null : 'session-only' };
};

/** Total actual bytes saved across records that reported both sizes. */
export const knownSpaceSaved = (records: readonly RecentRecord[]) => {
  let bytes = 0;
  let known = 0;
  let unknown = 0;
  for (const record of records) {
    const saved: ByteCount = record.entry.spaceSavedBytes;
    if (saved === null) unknown += 1;
    else {
      bytes += saved;
      known += 1;
    }
  }
  return { bytes, known, unknown };
};
