import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export const ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES = 512 * 1024;
/** OwnedDocumentWriter.MAXIMUM_FILE_BYTES: the largest file Android can keep or save. */
export const ANDROID_DOCUMENT_MAXIMUM_FILE_BYTES = 256 * 1024 * 1024;

export interface AndroidDocumentsNativePlugin {
  readChunk(options: {
    readonly ref: string;
    readonly offset: number;
    readonly length: number;
  }): Promise<unknown>;
  beginWrite(options: { readonly mimeType: SupportedOwnedMime; readonly displayName?: string }): Promise<unknown>;
  appendWrite(options: { readonly sessionRef: string; readonly data: string }): Promise<unknown>;
  finishWrite(options: { readonly sessionRef: string; readonly transient?: boolean }): Promise<unknown>;
  abortWrite(options: { readonly sessionRef: string }): Promise<unknown>;
  listOwned(options: Readonly<Record<string, never>>): Promise<unknown>;
  deleteOwned(options: { readonly ref: string }): Promise<unknown>;
  clearOwned(options: Readonly<Record<string, never>>): Promise<unknown>;
  clearOwnedPayloads(options: Readonly<Record<string, never>>): Promise<unknown>;
  renameItem(options: { readonly ref: string; readonly displayName: string }): Promise<unknown>;
  renameExport(options: { readonly exportRef: string; readonly displayName: string }): Promise<unknown>;
  trashOwned(options: { readonly ref: string }): Promise<unknown>;
  restoreOwned(options: { readonly undoRef: string }): Promise<unknown>;
  takePendingImports(options: Readonly<Record<string, never>>): Promise<unknown>;
  acknowledgePendingImports(options: {
    readonly batchRef: string;
    readonly refs: readonly string[];
  }): Promise<unknown>;
  pickDocuments(options: {
    readonly acceptedMimeTypes: readonly SupportedPickerMime[];
    readonly maximumItems: number;
  }): Promise<unknown>;
  exportItem(options: {
    readonly ref: string;
    readonly displayName?: string;
    readonly mimeType?: SupportedOwnedMime;
  }): Promise<unknown>;
  shareItem(options: {
    readonly ref: string;
    readonly displayName?: string;
    readonly mimeType?: SupportedOwnedMime;
  }): Promise<unknown>;
  openReader(options: {
    readonly ref: string;
    readonly displayName: string;
    readonly initialAction?: 'verify-signatures';
  }): Promise<unknown>;
  addListener(
    eventName: 'pendingImportReady' | 'incomingPdfReady' | 'incomingPdfRejected',
    listener: (event: unknown) => void,
  ): Promise<PluginListenerHandle>;
}

/** Why Android refused a PDF another app handed over: over 256 MB, not a PDF, or anything else. */
export type IncomingPdfRejection = 'tooLarge' | 'notPdf' | 'other';
const INCOMING_PDF_REJECTIONS: readonly IncomingPdfRejection[] = ['tooLarge', 'notPdf', 'other'];

export type SupportedOwnedMime = 'application/pdf' | 'application/zip' | 'text/plain' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export interface AndroidOwnedDocument { readonly kind: 'file'; readonly ref: string; readonly displayName: string | null; readonly mimeType: SupportedOwnedMime; readonly sizeBytes: number; readonly contentHash: string; readonly createdAt: number; readonly available: boolean; readonly pending: false; }
export type SupportedPickerMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/heic' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export interface AndroidPendingDocument { readonly kind: 'file'; readonly ref: string; readonly displayName: string | null; readonly mimeType: SupportedPickerMime; readonly sizeBytes: number; readonly contentHash: string; readonly createdAt: number; readonly available: true; readonly pending: true; }
export interface AndroidPendingBatch { readonly batchRef: string | null; readonly items: readonly AndroidPendingDocument[]; }
export type AndroidPickerResult = Readonly<
  | { readonly status: 'cancelled'; readonly batchRef: null; readonly items: readonly [] }
  | { readonly status: 'accepted'; readonly batchRef: string; readonly items: readonly AndroidPendingDocument[] }
>;
export type AndroidDeliveryResult = Readonly<{
  readonly status: 'completed' | 'cancelled';
  /** A single exported file: the name Downloads kept, and a handle to rename it later. */
  readonly savedName?: string;
  readonly exportRef?: string;
}>;
export type AndroidRenameResult = Readonly<{ readonly status: 'completed' }>;
export type AndroidUndoReceipt = Readonly<{ readonly undoRef: string; readonly expiresAt: number }>;
export interface AndroidWriteSession { readonly sessionRef: string; readonly maximumChunkBytes: number; }
export type AndroidReaderToolPath = '/compress' | '/merge' | '/split' | '/edit' | '/make-fillable' | '/sign' | '/watermark' | '/protect' | '/unlock' | '/delete-pages' | '/page-numbers' | '/reorder' | '/rotate' | '/flatten' | '/extract' | '/pdf-to-jpg' | '/pdf-to-word' | '/ocr' | '/metadata' | '/repair' | '/compare';
export type AndroidReaderResult = Readonly<
  | { readonly action: 'closed' }
  | { readonly action: 'tool'; readonly toolPath: AndroidReaderToolPath }
>;

export interface AndroidDocumentChunk {
  readonly data: Uint8Array;
  readonly nextOffset: number;
  readonly done: boolean;
}

const AndroidDocuments =
  registerPlugin<AndroidDocumentsNativePlugin>('AndroidDocuments');

export const isAndroidDocumentsAvailable = (): boolean =>
  Capacitor.getPlatform() === 'android'
  && Capacitor.isPluginAvailable('AndroidDocuments');

const MAXIMUM_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const LEGACY_REF = /^a1_([1-9][0-9]{0,15})$/;
const OWNED_REF = /^d1_[A-Za-z0-9_-]{22,64}$/;
const BATCH_REF = /^b1_[A-Za-z0-9_-]{22,64}$/;
const SESSION_REF = /^w1_[A-Za-z0-9_-]{22,64}$/;
const UNDO_REF = /^u1_[A-Za-z0-9_-]{22,64}$/;
const OWNED_MIMES = new Set<SupportedOwnedMime>(['application/pdf', 'application/zip', 'text/plain', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
export const ANDROID_PICKER_MIME_TYPES = Object.freeze<readonly SupportedPickerMime[]>([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const PICKER_MIMES = new Set<SupportedPickerMime>(ANDROID_PICKER_MIME_TYPES);
const READER_TOOL_PATHS = new Set<AndroidReaderToolPath>(['/compress', '/merge', '/split', '/edit', '/make-fillable', '/sign', '/watermark', '/protect', '/unlock', '/delete-pages', '/page-numbers', '/reorder', '/rotate', '/flatten', '/extract', '/pdf-to-jpg', '/pdf-to-word', '/ocr', '/metadata', '/repair', '/compare']);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OUTPUT_KEYS = ['data', 'done', 'nextOffset'] as const;

const invalidRequest = (): TypeError => new TypeError('Android document request is invalid.');
const invalidResponse = (): TypeError => new TypeError('Android document response is invalid.');

const isExactReference = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const legacy = LEGACY_REF.exec(value);
  if (legacy) {
    const id = Number(legacy[1]);
    return Number.isSafeInteger(id) && `a1_${id}` === value;
  }
  return OWNED_REF.test(value);
};

const isExactInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= minimum
  && value <= maximum;

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + blockSize, bytes.length)),
    );
  }
  return btoa(binary);
};

const decodeBase64 = (value: unknown, requestedLength: number): Uint8Array => {
  const maximumEncodedLength = Math.ceil(ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES / 3) * 4;
  if (typeof value !== 'string'
      || value.length > maximumEncodedLength
      || !CANONICAL_BASE64.test(value)) {
    throw invalidResponse();
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw invalidResponse();
  }
  if (binary.length > requestedLength || binary.length > ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES) {
    throw invalidResponse();
  }

  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encodeBase64(bytes) !== value) throw invalidResponse();
  return bytes;
};

const parseChunk = (
  value: unknown,
  offset: number,
  requestedLength: number,
): AndroidDocumentChunk => {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidResponse();
  }

  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some(key => typeof key !== 'string')) throw invalidResponse();
  const keys = (ownKeys as string[]).sort();
  if (keys.length !== OUTPUT_KEYS.length
      || keys.some((key, index) => key !== OUTPUT_KEYS[index])) {
    throw invalidResponse();
  }

  const data = decodeBase64(record.data, requestedLength);
  if (!isExactInteger(record.nextOffset, 0, MAXIMUM_SAFE_INTEGER)
      || record.nextOffset !== offset + data.length
      || typeof record.done !== 'boolean'
      || (!record.done && data.length === 0)) {
    throw invalidResponse();
  }

  return Object.freeze({ data, nextOffset: record.nextOffset, done: record.done });
};

export class AndroidDocumentsClient {
  private readonly native: AndroidDocumentsNativePlugin;

  /** Runtime callers use the registered proxy; injection exists only for isolated contract tests. */
  constructor(native: AndroidDocumentsNativePlugin = AndroidDocuments) {
    this.native = native;
  }

  async readChunk(ref: string, offset: number, length: number): Promise<AndroidDocumentChunk> {
    if (!isExactReference(ref)
        || !isExactInteger(offset, 0, MAXIMUM_SAFE_INTEGER)
        || !isExactInteger(length, 1, ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES)) {
      throw invalidRequest();
    }

    return parseChunk(await this.native.readChunk({ ref, offset, length }), offset, length);
  }

  async beginWrite(mimeType: SupportedOwnedMime, displayName?: string): Promise<AndroidWriteSession> {
    if (!OWNED_MIMES.has(mimeType) || (displayName !== undefined && !isDisplayName(displayName))) throw invalidRequest();
    const result = exactObject(await this.native.beginWrite(displayName === undefined ? { mimeType } : { mimeType, displayName }), ['maximumChunkBytes', 'sessionRef']);
    if (!isSessionRef(result.sessionRef) || result.maximumChunkBytes !== ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES) throw invalidResponse();
    return Object.freeze({ sessionRef: result.sessionRef, maximumChunkBytes: result.maximumChunkBytes });
  }

  async appendWrite(sessionRef: string, bytes: Uint8Array): Promise<number> {
    if (!isSessionRef(sessionRef) || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > ANDROID_DOCUMENT_MAXIMUM_CHUNK_BYTES) throw invalidRequest();
    const result = exactObject(await this.native.appendWrite({ sessionRef, data: encodeBase64(bytes) }), ['acceptedBytes']);
    if (result.acceptedBytes !== bytes.length) throw invalidResponse(); return result.acceptedBytes;
  }

  async finishWrite(sessionRef: string, transient = false): Promise<AndroidOwnedDocument> {
    if (!isSessionRef(sessionRef) || typeof transient !== 'boolean') throw invalidRequest();
    const result = exactObject(await this.native.finishWrite(transient ? { sessionRef, transient: true } : { sessionRef }), ['item']);
    return parseOwnedItem(result.item);
  }

  async abortWrite(sessionRef: string): Promise<boolean> {
    if (!isSessionRef(sessionRef)) throw invalidRequest(); const result = exactObject(await this.native.abortWrite({ sessionRef }), ['aborted']);
    if (typeof result.aborted !== 'boolean') throw invalidResponse(); return result.aborted;
  }

  async listOwned(): Promise<readonly AndroidOwnedDocument[]> {
    const result = exactObject(await this.native.listOwned({}), ['items']);
    if (!Array.isArray(result.items) || result.items.length > 10_000) throw invalidResponse();
    const seen = new Set<string>();
    const items = result.items.map((value: unknown) => {
      const item = parseOwnedItem(value);
      if (seen.has(item.ref)) throw invalidResponse();
      seen.add(item.ref);
      return item;
    });
    return Object.freeze(items);
  }

  async deleteOwned(ref: string): Promise<boolean> {
    if (typeof ref !== 'string' || !OWNED_REF.test(ref)) throw invalidRequest();
    const result = exactObject(await this.native.deleteOwned({ ref }), ['deleted']);
    if (typeof result.deleted !== 'boolean') throw invalidResponse();
    return result.deleted;
  }

  async clearOwned(): Promise<number> {
    const result = exactObject(await this.native.clearOwned({}), ['deletedCount']);
    if (!isExactInteger(result.deletedCount, 0, 10_000)) throw invalidResponse();
    return result.deletedCount;
  }

  async clearOwnedPayloads(): Promise<number> {
    const result = exactObject(await this.native.clearOwnedPayloads({}), ['clearedCount']);
    if (!isExactInteger(result.clearedCount, 0, 10_000)) throw invalidResponse();
    return result.clearedCount;
  }

  async renameItem(ref: string, displayName: string): Promise<AndroidRenameResult> {
    if (typeof ref !== 'string' || !OWNED_REF.test(ref) || !isDisplayName(displayName)) {
      throw invalidRequest();
    }
    const result = exactObject(
      await this.native.renameItem({ ref, displayName }),
      ['status'],
    );
    if (result.status !== 'completed') throw invalidResponse();
    return Object.freeze({ status: 'completed' });
  }

  async trashOwned(ref: string): Promise<AndroidUndoReceipt> {
    if (typeof ref !== 'string' || !OWNED_REF.test(ref)) throw invalidRequest();
    const result = exactObject(await this.native.trashOwned({ ref }), ['expiresAt', 'undoRef']);
    if (typeof result.undoRef !== 'string' || !UNDO_REF.test(result.undoRef)
        || !isExactInteger(result.expiresAt, 0, MAXIMUM_SAFE_INTEGER)) {
      throw invalidResponse();
    }
    return Object.freeze({ undoRef: result.undoRef, expiresAt: result.expiresAt });
  }

  async restoreOwned(undoRef: string): Promise<Readonly<{ status: 'completed' }>> {
    if (typeof undoRef !== 'string' || !UNDO_REF.test(undoRef)) throw invalidRequest();
    const result = exactObject(await this.native.restoreOwned({ undoRef }), ['status']);
    if (result.status !== 'completed') throw invalidResponse();
    return Object.freeze({ status: 'completed' });
  }

  async takePendingImports(): Promise<AndroidPendingBatch> {
    return parsePendingBatch(await this.native.takePendingImports({}));
  }

  async acknowledgePendingImports(batchRef: string, refs: readonly string[]): Promise<number> {
    if (!BATCH_REF.test(batchRef)
        || !Array.isArray(refs)
        || refs.length < 1
        || refs.length > 100
        || refs.some(ref => typeof ref !== 'string' || !OWNED_REF.test(ref))
        || new Set(refs).size !== refs.length) {
      throw invalidRequest();
    }
    const result = exactObject(
      await this.native.acknowledgePendingImports({ batchRef, refs: [...refs] }),
      ['acknowledgedCount'],
    );
    if (result.acknowledgedCount !== refs.length) throw invalidResponse();
    return result.acknowledgedCount;
  }

  async pickDocuments(
    acceptedMimeTypes: readonly SupportedPickerMime[],
    maximumItems: number,
  ): Promise<AndroidPickerResult> {
    if (!Array.isArray(acceptedMimeTypes)
        || acceptedMimeTypes.length < 1
        || acceptedMimeTypes.length > ANDROID_PICKER_MIME_TYPES.length
        || acceptedMimeTypes.some(value => !PICKER_MIMES.has(value))
        || new Set(acceptedMimeTypes).size !== acceptedMimeTypes.length
        || !isExactInteger(maximumItems, 1, 100)) {
      throw invalidRequest();
    }
    const envelope = exactObject(
      await this.native.pickDocuments({
        acceptedMimeTypes: [...acceptedMimeTypes],
        maximumItems,
      }),
      ['batchRef', 'items', 'status'],
    );
    if (envelope.status === 'cancelled') {
      if (envelope.batchRef !== null || !Array.isArray(envelope.items)
          || envelope.items.length !== 0) throw invalidResponse();
      return Object.freeze({
        status: 'cancelled' as const,
        batchRef: null,
        items: Object.freeze([]) as readonly [],
      });
    }
    if (envelope.status !== 'accepted') throw invalidResponse();
    const batch = parsePendingBatch({ batchRef: envelope.batchRef, items: envelope.items });
    if (batch.batchRef === null || batch.items.length < 1
        || batch.items.length > maximumItems) throw invalidResponse();
    return Object.freeze({ status: 'accepted', batchRef: batch.batchRef, items: batch.items });
  }

  async addPendingImportListener(
    listener: (event: Readonly<{ batchRef: string; itemCount: number }>) => void,
  ): Promise<() => Promise<void>> {
    if (typeof listener !== 'function') throw invalidRequest();
    const handle = await this.native.addListener('pendingImportReady', raw => {
      try {
        const event = exactObject(raw, ['batchRef', 'itemCount']);
        if (typeof event.batchRef !== 'string' || !BATCH_REF.test(event.batchRef)
            || !isExactInteger(event.itemCount, 1, 100)) return;
        listener(Object.freeze({ batchRef: event.batchRef, itemCount: event.itemCount }));
      } catch {
        // A malformed hint is ignored; the durable startup peek remains authoritative.
      }
    });
    return async () => handle.remove();
  }

  async addIncomingPdfListener(listener: (ref: string) => void): Promise<() => Promise<void>> {
    const handle = await this.native.addListener('incomingPdfReady', raw => {
      try {
        const event = exactObject(raw, ['ref']);
        if (typeof event.ref === 'string' && OWNED_REF.test(event.ref)) listener(event.ref);
      } catch {
        // External activity hints never expose a path, URL or unvalidated route.
      }
    });
    return async () => handle.remove();
  }

  async addIncomingPdfRejectedListener(
    listener: (reason: IncomingPdfRejection) => void,
  ): Promise<() => Promise<void>> {
    if (typeof listener !== 'function') throw invalidRequest();
    const handle = await this.native.addListener('incomingPdfRejected', raw => {
      try {
        const event = exactObject(raw, ['reason']);
        if (INCOMING_PDF_REJECTIONS.includes(event.reason)) listener(event.reason);
      } catch {
        // Only a fixed reason word is accepted; anything else is ignored.
      }
    });
    return async () => handle.remove();
  }

  async exportItem(
    ref: string,
    displayName?: string,
    mimeType?: SupportedOwnedMime,
  ): Promise<AndroidDeliveryResult> {
    return this.deliver('exportItem', ref, displayName, mimeType);
  }

  async shareItem(
    ref: string,
    displayName?: string,
    mimeType?: SupportedOwnedMime,
  ): Promise<AndroidDeliveryResult> {
    return this.deliver('shareItem', ref, displayName, mimeType);
  }

  private async deliver(
    method: 'exportItem' | 'shareItem',
    ref: string,
    displayName?: string,
    mimeType?: SupportedOwnedMime,
  ): Promise<AndroidDeliveryResult> {
    if (!isExactReference(ref)
        || (displayName !== undefined && !isDisplayName(displayName))
        || (mimeType !== undefined && !(OWNED_REF.test(ref) ? OWNED_MIMES.has(mimeType) : PICKER_MIMES.has(mimeType as SupportedPickerMime)))) {
      throw invalidRequest();
    }
    const options: {
      ref: string;
      displayName?: string;
      mimeType?: SupportedOwnedMime;
    } = { ref };
    if (displayName !== undefined) options.displayName = displayName;
    if (mimeType !== undefined) options.mimeType = mimeType;
    const raw = await this.native[method](options);
    if (method === 'exportItem' && raw && typeof raw === 'object' && 'exportRef' in raw) {
      const saved = exactObject(raw, ['exportRef', 'savedName', 'status']);
      if (saved.status !== 'completed' || !EXPORT_REF.test(saved.exportRef)
          || !isDisplayName(saved.savedName)) throw invalidResponse();
      return Object.freeze({ status: 'completed', exportRef: saved.exportRef, savedName: saved.savedName });
    }
    const result = exactObject(raw, ['status']);
    if (result.status !== 'completed' && result.status !== 'cancelled') {
      throw invalidResponse();
    }
    return Object.freeze({ status: result.status });
  }

  /** Renames the copy an earlier exportItem put in Downloads; returns the name it kept. */
  async renameExport(exportRef: string, displayName: string): Promise<string> {
    if (typeof exportRef !== 'string' || !EXPORT_REF.test(exportRef) || !isDisplayName(displayName)) {
      throw invalidRequest();
    }
    const result = exactObject(
      await this.native.renameExport({ exportRef, displayName }),
      ['savedName', 'status'],
    );
    if (result.status !== 'completed' || !isDisplayName(result.savedName)) throw invalidResponse();
    return result.savedName;
  }

  async openReader(
    ref: string,
    displayName: string,
    initialAction?: 'verify-signatures',
  ): Promise<AndroidReaderResult> {
    if (!isExactReference(ref) || !isDisplayName(displayName)) throw invalidRequest();
    if (initialAction !== undefined && initialAction !== 'verify-signatures') throw invalidRequest();
    const raw = await this.native.openReader(initialAction === undefined
      ? { ref, displayName }
      : { ref, displayName, initialAction });
    const envelope = exactObject(raw, raw && typeof raw === 'object'
      && (raw as Record<string, unknown>).action === 'tool'
      ? ['action', 'toolPath'] : ['action']);
    if (envelope.action === 'closed') return Object.freeze({ action: 'closed' });
    if (envelope.action !== 'tool'
        || typeof envelope.toolPath !== 'string'
        || !READER_TOOL_PATHS.has(envelope.toolPath as AndroidReaderToolPath)) {
      throw invalidResponse();
    }
    return Object.freeze({
      action: 'tool',
      toolPath: envelope.toolPath as AndroidReaderToolPath,
    });
  }
}

const isSessionRef = (value: unknown): value is string => typeof value === 'string' && SESSION_REF.test(value);
const isWellFormedUtf16 = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};
const EXPORT_REF = /^pdfchef-[A-Za-z0-9_-]{22,64}$/;
const isDisplayName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..' && value.length <= 180 && isWellFormedUtf16(value) && new TextEncoder().encode(value).length <= 720;
const exactObject = (value: unknown, expected: readonly string[]): Record<string, any> => { if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalidResponse(); const record = value as Record<string, any>; const keys = Reflect.ownKeys(record); if (keys.some(key => typeof key !== 'string') || keys.length !== expected.length || !(keys as string[]).sort().every((key, index) => key === expected[index])) throw invalidResponse(); return record; };
const parseOwnedItem = (value: unknown): AndroidOwnedDocument => {
  const item = exactObject(value, ['available', 'contentHash', 'createdAt', 'displayName', 'kind', 'mimeType', 'pending', 'ref', 'sizeBytes']);
  if (item.kind !== 'file' || !OWNED_REF.test(item.ref) || !OWNED_MIMES.has(item.mimeType as SupportedOwnedMime) || (item.displayName !== null && !isDisplayName(item.displayName)) || !isExactInteger(item.sizeBytes, 1, MAXIMUM_SAFE_INTEGER) || typeof item.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(item.contentHash) || !isExactInteger(item.createdAt, 0, MAXIMUM_SAFE_INTEGER) || typeof item.available !== 'boolean' || item.pending !== false) throw invalidResponse();
  return Object.freeze(item as AndroidOwnedDocument);
};
const parsePendingItem = (value: unknown): AndroidPendingDocument => {
  const item = exactObject(value, ['available', 'contentHash', 'createdAt', 'displayName', 'kind', 'mimeType', 'pending', 'ref', 'sizeBytes']);
  if (item.kind !== 'file' || !OWNED_REF.test(item.ref)
      || !PICKER_MIMES.has(item.mimeType as SupportedPickerMime)
      || (item.displayName !== null && !isDisplayName(item.displayName))
      || !isExactInteger(item.sizeBytes, 1, MAXIMUM_SAFE_INTEGER)
      || typeof item.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(item.contentHash)
      || !isExactInteger(item.createdAt, 0, MAXIMUM_SAFE_INTEGER)
      || item.available !== true || item.pending !== true) throw invalidResponse();
  return Object.freeze(item as AndroidPendingDocument);
};
const parsePendingBatch = (value: unknown): AndroidPendingBatch => {
  const envelope = exactObject(value, ['batchRef', 'items']);
  if (!Array.isArray(envelope.items) || envelope.items.length > 100) throw invalidResponse();
  if (envelope.items.length === 0) {
    if (envelope.batchRef !== null) throw invalidResponse();
    return Object.freeze({ batchRef: null, items: Object.freeze([]) });
  }
  if (typeof envelope.batchRef !== 'string' || !BATCH_REF.test(envelope.batchRef)) {
    throw invalidResponse();
  }
  const seen = new Set<string>();
  const items = envelope.items.map((value: unknown) => {
    const item = parsePendingItem(value);
    if (seen.has(item.ref)) throw invalidResponse();
    seen.add(item.ref);
    return item;
  });
  return Object.freeze({ batchRef: envelope.batchRef, items: Object.freeze(items) });
};
