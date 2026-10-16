import { LocalizedError } from './i18n/errors.ts';
import { t } from './i18n/core.ts';
export type WorkspaceInterfaceFont = 'inter' | 'manrope' | 'noto-sans' | 'system' | 'serif' | 'monospace';

export interface WorkspaceSettings {
  autoDownload: boolean;
  keepLocalHistory: boolean;
  confirmLargeJobs: boolean;
  largeFileWarningMb: number;
  onboardingComplete: boolean;
  interfaceFont: WorkspaceInterfaceFont;
}

export interface OutputRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  toolPath: string;
  createdAt: number;
  /** Null after an explicit payload-only clear; the Recent metadata remains. */
  blob: Blob | null;
}

export interface RecentToolRecord {
  path: string;
  lastUsedAt: number;
  uses: number;
}

export interface SavingsTally {
  bytesSaved: number;
  filesReduced: number;
}

export const WORKSPACE_SETTINGS_KEY = 'pdfchef.workspace.settings.v1';
export const WORKSPACE_INTERFACE_FONT_AUTHORITY_KEY = 'pdfchef.workspace.interface-font-authority.v1';
export const ANDROID_LEGACY_INTERFACE_FONT_CHECK_KEY = 'pdfchef.android.legacy-interface-font.v1';
export const RECENT_TOOLS_KEY = 'pdfchef.workspace.recent-tools.v1';
export const SAVINGS_TALLY_KEY = 'pdfchef.workspace.savings.v1';
export const OUTPUT_EVENT = 'pdfchef:output-ready';
export const RECORDS_CHANGED_EVENT = 'pdfchef:records-changed';

const DEFAULT_SETTINGS: WorkspaceSettings = {
  autoDownload: true,
  keepLocalHistory: true,
  confirmLargeJobs: true,
  largeFileWarningMb: 80,
  onboardingComplete: false,
  interfaceFont: 'inter',
};

const DB_NAME = 'pdfchef-local-workspace';
const DB_VERSION = 1;
const OUTPUT_STORE = 'outputs';
const MAX_HISTORY_ITEMS = 50;

const safeParse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const WORKSPACE_INTERFACE_FONTS: readonly WorkspaceInterfaceFont[] = Object.freeze([
  'inter',
  'manrope',
  'noto-sans',
  'system',
  'serif',
  'monospace',
]);

export const isWorkspaceInterfaceFont = (value: unknown): value is WorkspaceInterfaceFont =>
  typeof value === 'string' && (WORKSPACE_INTERFACE_FONTS as readonly string[]).includes(value);

/**
 * A materialized default is not a user choice. The separate authority marker is
 * written only by an interface-font patch, so onboarding or another unrelated
 * settings write cannot accidentally block the one-time Android legacy import.
 */
export const getExplicitWorkspaceInterfaceFont = (): WorkspaceInterfaceFont | null => {
  if (typeof window === 'undefined') return null;
  if (window.localStorage.getItem(WORKSPACE_INTERFACE_FONT_AUTHORITY_KEY) !== 'shared') return null;
  const saved = safeParse<Record<string, unknown>>(
    window.localStorage.getItem(WORKSPACE_SETTINGS_KEY),
    {},
  );
  return isWorkspaceInterfaceFont(saved.interfaceFont) ? saved.interfaceFont : null;
};

export const hasCheckedAndroidLegacyInterfaceFont = (): boolean =>
  typeof window !== 'undefined'
  && window.localStorage.getItem(ANDROID_LEGACY_INTERFACE_FONT_CHECK_KEY) === 'checked';

export const markAndroidLegacyInterfaceFontChecked = (): void => {
  window.localStorage.setItem(ANDROID_LEGACY_INTERFACE_FONT_CHECK_KEY, 'checked');
};

export const getWorkspaceSettings = (): WorkspaceSettings => {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  const saved = safeParse<Partial<WorkspaceSettings>>(window.localStorage.getItem(WORKSPACE_SETTINGS_KEY), {});
  return { ...DEFAULT_SETTINGS, ...saved };
};

export const updateWorkspaceSettings = (patch: Partial<WorkspaceSettings>): WorkspaceSettings => {
  const next = { ...getWorkspaceSettings(), ...patch };
  window.localStorage.setItem(WORKSPACE_SETTINGS_KEY, JSON.stringify(next));
  if (Object.prototype.hasOwnProperty.call(patch, 'interfaceFont')
      && isWorkspaceInterfaceFont(patch.interfaceFont)) {
    window.localStorage.setItem(WORKSPACE_INTERFACE_FONT_AUTHORITY_KEY, 'shared');
  }
  window.dispatchEvent(new CustomEvent('pdfchef:settings-changed', { detail: next }));
  return next;
};

export const shouldWarnForFiles = (files: File[]): boolean => {
  const settings = getWorkspaceSettings();
  if (!settings.confirmLargeJobs) return false;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return totalBytes >= settings.largeFileWarningMb * 1024 * 1024;
};

export const rememberToolUse = (path: string) => {
  if (typeof window === 'undefined' || !path.startsWith('/') || path === '/') return;
  const current = safeParse<RecentToolRecord[]>(window.localStorage.getItem(RECENT_TOOLS_KEY), []);
  const previous = current.find((item) => item.path === path);
  const next = [
    { path, lastUsedAt: Date.now(), uses: (previous?.uses || 0) + 1 },
    ...current.filter((item) => item.path !== path),
  ].slice(0, 12);
  window.localStorage.setItem(RECENT_TOOLS_KEY, JSON.stringify(next));
};

export const getRecentTools = (): RecentToolRecord[] => {
  if (typeof window === 'undefined') return [];
  return safeParse<RecentToolRecord[]>(window.localStorage.getItem(RECENT_TOOLS_KEY), []);
};

export const getSavingsTally = (): SavingsTally => {
  if (typeof window === 'undefined') return { bytesSaved: 0, filesReduced: 0 };
  const saved = safeParse<Partial<SavingsTally>>(window.localStorage.getItem(SAVINGS_TALLY_KEY), {});
  return {
    bytesSaved: Math.max(0, Number(saved.bytesSaved) || 0),
    filesReduced: Math.max(0, Math.floor(Number(saved.filesReduced) || 0)),
  };
};

export const recordSavings = (originalSize: number, resultSize: number): SavingsTally => {
  const current = getSavingsTally();
  const saved = originalSize - resultSize;
  if (!Number.isFinite(saved) || saved <= 0) return current;
  const next = { bytesSaved: current.bytesSaved + saved, filesReduced: current.filesReduced + 1 };
  window.localStorage.setItem(SAVINGS_TALLY_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('pdfchef:savings-changed', { detail: next }));
  return next;
};

const openWorkspaceDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new LocalizedError("workspace.local.history.is.unavailable.in.this.browser.3c06bd"));
    return;
  }

  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(OUTPUT_STORE)) {
      const store = db.createObjectStore(OUTPUT_STORE, { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt');
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new LocalizedError("workspace.unable.to.open.local.history.985514"));
});

const requestValue = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new LocalizedError("workspace.local.history.operation.failed.c82c2d"));
});

const transactionComplete = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new LocalizedError("workspace.local.history.transaction.failed.ce548d"));
  transaction.onabort = () => reject(transaction.error || new LocalizedError("workspace.local.history.transaction.was.cancelled.b41acb"));
});

const makeId = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const listOutputs = async (): Promise<OutputRecord[]> => {
  const db = await openWorkspaceDb();
  try {
    const transaction = db.transaction(OUTPUT_STORE, 'readonly');
    const records = await requestValue(transaction.objectStore(OUTPUT_STORE).getAll()) as OutputRecord[];
    return records.sort((left, right) => right.createdAt - left.createdAt);
  } finally {
    db.close();
  }
};

export const getOutput = async (id: string): Promise<OutputRecord | undefined> => {
  const db = await openWorkspaceDb();
  try {
    const transaction = db.transaction(OUTPUT_STORE, 'readonly');
    return await requestValue(transaction.objectStore(OUTPUT_STORE).get(id)) as OutputRecord | undefined;
  } finally {
    db.close();
  }
};

export const deleteOutput = async (id: string): Promise<void> => {
  const db = await openWorkspaceDb();
  try {
    const transaction = db.transaction(OUTPUT_STORE, 'readwrite');
    transaction.objectStore(OUTPUT_STORE).delete(id);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
};

export const clearOutputs = async (): Promise<void> => {
  const db = await openWorkspaceDb();
  try {
    const transaction = db.transaction(OUTPUT_STORE, 'readwrite');
    transaction.objectStore(OUTPUT_STORE).clear();
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
};

export const withoutOutputPayload = (record: OutputRecord): OutputRecord => (
  record.blob === null ? record : { ...record, blob: null }
);

/**
 * Remove only the bytes behind browser/session records.
 *
 * Android composes these records with its native catalogue. Keeping the exact
 * metadata while replacing only the Blob lets the existing Recent surface say
 * that a result remains but its file is gone. One IndexedDB transaction makes
 * the operation all-or-nothing for this store.
 */
export const clearOutputDocuments = async (): Promise<void> => {
  const db = await openWorkspaceDb();
  try {
    const transaction = db.transaction(OUTPUT_STORE, 'readwrite');
    const store = transaction.objectStore(OUTPUT_STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as OutputRecord;
      if (record.blob instanceof Blob) cursor.update(withoutOutputPayload(record));
      cursor.continue();
    };
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
};

export const recordOutput = async (
  blob: Blob,
  filename: string,
  mimeType: string,
  toolPath: string,
  forceKeep = false,
): Promise<OutputRecord> => {
  const record: OutputRecord = {
    id: makeId(),
    filename,
    mimeType: mimeType || blob.type || 'application/octet-stream',
    size: blob.size,
    toolPath,
    createdAt: Date.now(),
    blob,
  };

  if (!forceKeep && !getWorkspaceSettings().keepLocalHistory) return record;

  const db = await openWorkspaceDb();
  try {
    const transaction = db.transaction(OUTPUT_STORE, 'readwrite');
    transaction.objectStore(OUTPUT_STORE).put(record);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }

  const records = await listOutputs();
  await Promise.all(records.slice(MAX_HISTORY_ITEMS).map((item) => deleteOutput(item.id)));
  return record;
};

export const OUTPUT_DISMISS_EVENT = 'pdfchef:output-dismiss';

/** A tool starting on a new file clears the last result's banner, which would cover it. */
export const dismissOutputBanner = () => {
  window.dispatchEvent(new Event(OUTPUT_DISMISS_EVENT));
};

export const OUTPUT_RENAMED_EVENT = 'pdfchef:output-renamed';

/** A tool renamed its own result, so the result sheet must share and save under the new name. */
export const announceOutputRenamed = (id: string, filename: string) => {
  window.dispatchEvent(new CustomEvent<{ id: string; filename: string }>(OUTPUT_RENAMED_EVENT, { detail: { id, filename } }));
};

export const announceOutput = (record: OutputRecord) => {
  window.dispatchEvent(new CustomEvent<OutputRecord>(OUTPUT_EVENT, { detail: record }));
};

/** Refresh retained-file lists without opening another result action sheet. */
export const announceRecordsChanged = () => {
  window.dispatchEvent(new Event(RECORDS_CHANGED_EVENT));
};
