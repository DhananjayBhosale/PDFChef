import { LocalizedError } from '../../i18n/errors.ts';
import type { DurableDocumentRef, RecentEntry, StoredDocument } from '../../domain/workspaceModels.ts';
import type { RecentRepository } from '../contracts.ts';
import type { LocalStringStorage } from '../local/localWorkspaceRepositories.ts';
import type { IOSDocumentBridge } from './iosDocumentServices.ts';

const LEGACY_DB_NAME = 'pdfchef-local-workspace';
const LEGACY_DB_VERSION = 1;
const LEGACY_OUTPUT_STORE = 'outputs';
export const LEGACY_WORKSPACE_MIGRATION_JOURNAL_KEY = 'pdf-chef:legacy-workspace-migration:v1';

export interface LegacyWorkspaceOutput {
  readonly id: string;
  readonly filename?: unknown;
  readonly mimeType?: unknown;
  readonly size?: unknown;
  readonly toolPath?: unknown;
  readonly createdAt?: unknown;
  readonly blob: Blob;
}

export interface LegacyWorkspaceSource {
  /** Read-only: migration never updates or deletes legacy records. */
  list(): Promise<readonly LegacyWorkspaceOutput[]>;
}

export interface LegacyWorkspaceMigrationJournalEntry {
  readonly legacyId: string;
  readonly status: 'pending' | 'complete';
  readonly documentRef: DurableDocumentRef | null;
}

export interface LegacyWorkspaceMigrationJournal {
  get(legacyId: string): Promise<LegacyWorkspaceMigrationJournalEntry | null>;
  save(entry: LegacyWorkspaceMigrationJournalEntry): Promise<void>;
}

export interface LegacyWorkspaceMigrationDependencies {
  readonly source: LegacyWorkspaceSource;
  readonly journal: LegacyWorkspaceMigrationJournal;
  readonly bridge: IOSDocumentBridge;
  readonly recent: RecentRepository;
}

const storageOrThrow = (): LocalStringStorage => {
  if (typeof localStorage === 'undefined') {
    throw new LocalizedError("legacy-workspace-migration.error.7a9a0e1dfc");
  }
  return localStorage;
};

const requestValue = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new LocalizedError("legacy-workspace-migration.error.289a151a01"));
});

const openLegacyDatabase = (): Promise<IDBDatabase | null> => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    resolve(null);
    return;
  }

  const request = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
  let created = false;
  request.onupgradeneeded = () => {
    created = true;
    // A migration probe must not create or upgrade the legacy database. Abort
    // the version-change transaction when no v1 database exists yet.
    request.transaction?.abort();
  };
  request.onsuccess = () => {
    const database = request.result;
    if (created || !database.objectStoreNames.contains(LEGACY_OUTPUT_STORE)) {
      database.close();
      resolve(null);
      return;
    }
    resolve(database);
  };
  request.onerror = () => {
    if (created) {
      resolve(null);
      return;
    }
    reject(request.error ?? new LocalizedError("legacy-workspace-migration.error.cc98a49d51"));
  };
});

export class IndexedDbLegacyWorkspaceSource implements LegacyWorkspaceSource {
  async list(): Promise<readonly LegacyWorkspaceOutput[]> {
    const database = await openLegacyDatabase();
    if (!database) return [];
    try {
      const transaction = database.transaction(LEGACY_OUTPUT_STORE, 'readonly');
      const values = await requestValue(transaction.objectStore(LEGACY_OUTPUT_STORE).getAll()) as unknown[];
      return values.filter((value): value is LegacyWorkspaceOutput => {
        if (typeof value !== 'object' || value === null) return false;
        const candidate = value as Partial<LegacyWorkspaceOutput>;
        return typeof candidate.id === 'string' && candidate.id.length > 0 && candidate.blob instanceof Blob;
      });
    } finally {
      database.close();
    }
  }
}

const isJournalEntry = (value: unknown): value is LegacyWorkspaceMigrationJournalEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LegacyWorkspaceMigrationJournalEntry>;
  return typeof candidate.legacyId === 'string'
    && (candidate.status === 'pending' || candidate.status === 'complete')
    && (candidate.documentRef === null || typeof candidate.documentRef === 'string');
};

export class LocalStorageLegacyWorkspaceMigrationJournal implements LegacyWorkspaceMigrationJournal {
  private readonly providedStorage: LocalStringStorage | undefined;

  constructor(providedStorage?: LocalStringStorage) {
    this.providedStorage = providedStorage;
  }

  private get storage(): LocalStringStorage {
    return this.providedStorage ?? storageOrThrow();
  }

  private read(): LegacyWorkspaceMigrationJournalEntry[] {
    const raw = this.storage.getItem(LEGACY_WORKSPACE_MIGRATION_JOURNAL_KEY);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value.filter(isJournalEntry) : [];
    } catch {
      return [];
    }
  }

  async get(legacyId: string): Promise<LegacyWorkspaceMigrationJournalEntry | null> {
    return this.read().find(entry => entry.legacyId === legacyId) ?? null;
  }

  async save(entry: LegacyWorkspaceMigrationJournalEntry): Promise<void> {
    const next = [entry, ...this.read().filter(value => value.legacyId !== entry.legacyId)];
    this.storage.setItem(LEGACY_WORKSPACE_MIGRATION_JOURNAL_KEY, JSON.stringify(next));
  }
}

const nullableText = (value: unknown): string | null =>
  typeof value === 'string' && !value.includes('\0') ? value : null;

const nullableCount = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

const markerFor = async (legacyId: string): Promise<string> => {
  if (!globalThis.crypto?.subtle) throw new LocalizedError("legacy-workspace-migration.error.f451a86553");
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacyId));
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  return `.pdfchef-legacy-${hash}.pending`;
};

const recentEntry = (legacy: LegacyWorkspaceOutput, document: StoredDocument): RecentEntry => ({
  id: legacy.id,
  documentRef: document.ref,
  name: nullableText(legacy.filename),
  mimeType: nullableText(legacy.mimeType),
  toolId: nullableText(legacy.toolPath),
  createdAt: nullableCount(legacy.createdAt),
  inputSizeBytes: null,
  outputSizeBytes: nullableCount(legacy.size) ?? document.sizeBytes,
  spaceSavedBytes: null,
});

const sameRecentEntry = (left: RecentEntry | null, right: RecentEntry): boolean => left !== null
  && left.id === right.id
  && left.documentRef === right.documentRef
  && left.name === right.name
  && left.mimeType === right.mimeType
  && left.toolId === right.toolId
  && left.createdAt === right.createdAt
  && left.inputSizeBytes === right.inputSizeBytes
  && left.outputSizeBytes === right.outputSizeBytes
  && left.spaceSavedBytes === right.spaceSavedBytes;

export const migrateLegacyWorkspace = async (
  dependencies: LegacyWorkspaceMigrationDependencies,
): Promise<void> => {
  const { source, journal, bridge, recent } = dependencies;
  const legacyOutputs = await source.list();

  for (const legacy of legacyOutputs) {
    const marker = await markerFor(legacy.id);
    let journalEntry = await journal.get(legacy.id);
    let document: StoredDocument | null = null;

    if (journalEntry?.documentRef && await bridge.exists(journalEntry.documentRef)) {
      document = await bridge.stat(journalEntry.documentRef);
      const expected = recentEntry(legacy, document);
      if (journalEntry.status === 'complete' && sameRecentEntry(await recent.get(legacy.id), expected)) {
        continue;
      }
    }

    if (!document) {
      const marked = (await bridge.listDocuments()).find(value => value.document.name === marker && value.available);
      if (marked) document = marked.document;
    }

    if (!journalEntry || journalEntry.status !== 'pending' || journalEntry.documentRef !== document?.ref) {
      journalEntry = { legacyId: legacy.id, status: 'pending', documentRef: document?.ref ?? null };
      await journal.save(journalEntry);
    }

    if (!document) {
      document = await bridge.retain(legacy.blob.stream(), {
        name: marker,
        mimeType: nullableText(legacy.mimeType) ?? (legacy.blob.type || null),
      });
      journalEntry = { legacyId: legacy.id, status: 'pending', documentRef: document.ref };
      await journal.save(journalEntry);
    }

    const expected = recentEntry(legacy, document);
    if (!sameRecentEntry(await recent.get(legacy.id), expected)) {
      // The journal stays pending when this write fails, so restart can repair Recent.
      await recent.save(expected);
    }

    const originalName = nullableText(legacy.filename);
    if (originalName && document.name !== originalName) {
      document = await bridge.rename(document.ref, originalName);
    }

    await journal.save({ legacyId: legacy.id, status: 'complete', documentRef: document.ref });
  }
};
