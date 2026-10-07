import { LocalizedError } from '../../i18n/errors.ts';
import type {
  DurableDocumentRef,
  RecentEntry,
  WorkspaceSettings,
} from '../../domain/workspaceModels.ts';
import { toDurableDocumentRef } from '../../domain/workspacePolicy.ts';
import type { RecentRepository, SettingsRepository } from '../contracts.ts';

export interface LocalStringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const WORKSPACE_SETTINGS_KEY = 'pdf-chef:workspace-settings:v1';
export const WORKSPACE_RECENT_KEY = 'pdf-chef:recent:v1';

const storageOrThrow = (): LocalStringStorage => {
  if (typeof localStorage === 'undefined') {
    throw new LocalizedError("local-workspace-repositories.error.c39eaed9bd");
  }
  return localStorage;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nullableString = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value === 'string' && !value.includes('\0')) return value;
  return undefined;
};

const nullableCount = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  return undefined;
};

const nullableRef = (value: unknown): DurableDocumentRef | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() !== value) return undefined;
  return toDurableDocumentRef(value) ?? undefined;
};

const parseRecentEntry = (value: unknown): RecentEntry | null => {
  if (!isObject(value) || typeof value.id !== 'string' || value.id.length === 0 || value.id.includes('\0')) return null;
  const documentRef = nullableRef(value.documentRef);
  const name = nullableString(value.name);
  const mimeType = nullableString(value.mimeType);
  const toolId = nullableString(value.toolId);
  const createdAt = nullableCount(value.createdAt);
  const inputSizeBytes = nullableCount(value.inputSizeBytes);
  const outputSizeBytes = nullableCount(value.outputSizeBytes);
  const spaceSavedBytes = nullableCount(value.spaceSavedBytes);
  if (
    documentRef === undefined ||
    name === undefined ||
    mimeType === undefined ||
    toolId === undefined ||
    createdAt === undefined ||
    inputSizeBytes === undefined ||
    outputSizeBytes === undefined ||
    spaceSavedBytes === undefined
  ) {
    return null;
  }
  return {
    id: value.id,
    documentRef,
    name,
    mimeType,
    toolId,
    createdAt,
    inputSizeBytes,
    outputSizeBytes,
    spaceSavedBytes,
  };
};

const readJSON = (storage: LocalStringStorage, key: string): unknown => {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const parseSettings = (value: unknown): WorkspaceSettings | null => {
  if (!isObject(value) || !Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 0) return null;
  if (!isObject(value.values)) return null;
  return { schemaVersion: value.schemaVersion as number, values: value.values };
};

const parseRecentList = (value: unknown): RecentEntry[] => {
  if (!Array.isArray(value)) return [];
  const entries: RecentEntry[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const entry = parseRecentEntry(candidate);
    if (!entry || ids.has(entry.id)) continue;
    ids.add(entry.id);
    entries.push(entry);
  }
  return entries;
};

const readRecentRaw = (storage: LocalStringStorage): unknown[] => {
  const value = readJSON(storage, WORKSPACE_RECENT_KEY);
  return Array.isArray(value) ? value : [];
};

const assertSettings = (settings: WorkspaceSettings): WorkspaceSettings => {
  const parsed = parseSettings(settings);
  if (!parsed) throw new TypeError('Workspace settings do not match the persistence contract');
  try {
    JSON.stringify(parsed);
  } catch {
    throw new TypeError('Workspace settings must be JSON serializable');
  }
  return parsed;
};

const assertRecentEntry = (entry: RecentEntry): RecentEntry => {
  const parsed = parseRecentEntry(entry);
  if (!parsed) throw new TypeError('Recent entry does not match the persistence contract');
  return parsed;
};

export class LocalSettingsRepository implements SettingsRepository {
  private readonly storage: LocalStringStorage;

  constructor(storage: LocalStringStorage = storageOrThrow()) {
    this.storage = storage;
  }

  async load(): Promise<WorkspaceSettings | null> {
    return parseSettings(readJSON(this.storage, WORKSPACE_SETTINGS_KEY));
  }

  async save(settings: WorkspaceSettings): Promise<void> {
    this.storage.setItem(WORKSPACE_SETTINGS_KEY, JSON.stringify(assertSettings(settings)));
  }

  async clear(): Promise<void> {
    this.storage.removeItem(WORKSPACE_SETTINGS_KEY);
  }
}

export class LocalRecentRepository implements RecentRepository {
  private readonly storage: LocalStringStorage;

  constructor(storage: LocalStringStorage = storageOrThrow()) {
    this.storage = storage;
  }

  async list(): Promise<readonly RecentEntry[]> {
    return parseRecentList(readRecentRaw(this.storage));
  }

  async get(id: string): Promise<RecentEntry | null> {
    if (typeof id !== 'string' || id.length === 0) return null;
    return (await this.list()).find(entry => entry.id === id) ?? null;
  }

  async save(entry: RecentEntry): Promise<void> {
    const checked = assertRecentEntry(entry);
    // Keep unknown/legacy records byte-for-JSON-value intact. A newer schema must
    // never be erased merely because this version cannot render it yet.
    const current = readRecentRaw(this.storage).filter(value => {
      const parsed = parseRecentEntry(value);
      return !parsed || parsed.id !== checked.id;
    });
    this.storage.setItem(WORKSPACE_RECENT_KEY, JSON.stringify([checked, ...current]));
  }

  async delete(id: string): Promise<void> {
    if (typeof id !== 'string' || id.length === 0) return;
    const next = readRecentRaw(this.storage).filter(value => {
      const parsed = parseRecentEntry(value);
      return !parsed || parsed.id !== id;
    });
    this.storage.setItem(WORKSPACE_RECENT_KEY, JSON.stringify(next));
  }

  async clear(): Promise<void> {
    this.storage.removeItem(WORKSPACE_RECENT_KEY);
  }
}

export const createLocalWorkspaceRepositories = (storage: LocalStringStorage = storageOrThrow()) => ({
  settings: new LocalSettingsRepository(storage),
  recent: new LocalRecentRepository(storage),
});
