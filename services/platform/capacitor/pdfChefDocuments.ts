import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {
  ApplicationMetadata,
  DurableDocumentRef,
  StoredDocument,
} from '../../domain/workspaceModels.ts';
import { toDurableDocumentRef } from '../../domain/workspacePolicy.ts';
import type {
  ImportedDocument,
  StorageInformation,
} from '../contracts.ts';
import {
  IOS_PDF_READER_TOOL_PATHS,
  type IOSPdfReaderNativeResult,
} from './iosPdfReader.ts';

export const PDF_CHEF_MAXIMUM_CHUNK_BYTES = 512 * 1024;

type JsonObject = Record<string, unknown>;

export interface PdfChefDocumentsNativePlugin {
  beginWrite(options: { name?: string; mimeType?: string; transient?: boolean }): Promise<unknown>;
  appendWrite(options: { sessionId: string; data: string }): Promise<unknown>;
  finishWrite(options: { sessionId: string }): Promise<unknown>;
  abortWrite(options: { sessionId: string }): Promise<unknown>;
  readChunk(options: { ref: string; offset: number; length: number }): Promise<unknown>;
  stat(options: { ref: string }): Promise<unknown>;
  exists(options: { ref: string }): Promise<unknown>;
  listDocuments(): Promise<unknown>;
  rename(options: { ref: string; name: string }): Promise<unknown>;
  delete(options: { ref: string }): Promise<unknown>;
  clear(): Promise<unknown>;
  storageInformation(): Promise<unknown>;
  takePendingImports(): Promise<unknown>;
  acknowledgePendingImports(options: { refs: string[] }): Promise<unknown>;
  pickDocuments(options: { acceptedMimeTypes: string[]; maximumItems: number }): Promise<unknown>;
  exportDocument(options: { ref: string; name?: string; mimeType?: string }): Promise<unknown>;
  shareDocument(options: { ref: string; name?: string; mimeType?: string }): Promise<unknown>;
  signatureVerificationAvailable(): Promise<unknown>;
  presentSignatureReport(options: { ref: string; name?: string }): Promise<unknown>;
  openReader(options: { ref: string; displayName: string }): Promise<unknown>;
  signalHaptic(options: { signal: string }): Promise<unknown>;
  getApplicationMetadata(): Promise<unknown>;
  addListener(
    eventName: 'pendingImportReady',
    listener: (event: unknown) => void,
  ): Promise<PluginListenerHandle>;
}

/** The registered proxy is intentionally exported so native activation can use one discovery path. */
export const PdfChefDocuments = registerPlugin<PdfChefDocumentsNativePlugin>('PdfChefDocuments');

/** True only when Capacitor reports the real iOS plugin header, never by proxy shape. */
export const isPdfChefDocumentsAvailable = (): boolean =>
  Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('PdfChefDocuments');

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const object = (value: unknown, context: string): JsonObject => {
  if (!isObject(value)) throw new TypeError(`${context} must be an object`);
  for (const key of Object.keys(value)) {
    if (/^(url|path|bookmark|providerUrl)$/i.test(key)) {
      throw new TypeError(`${context} contains a forbidden address field`);
    }
  }
  return value;
};

const finiteInteger = (value: unknown, context: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${context} must be a non-negative safe integer`);
  }
  return value as number;
};

const nullableString = (value: unknown, context: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError(`${context} must be a string or null`);
  }
  return value;
};

const nonEmptyString = (value: unknown, context: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
};

const durableRef = (value: unknown, context: string): DurableDocumentRef => {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new TypeError(`${context} must be an opaque document reference`);
  }
  const ref = toDurableDocumentRef(value);
  if (!ref) throw new TypeError(`${context} must be an opaque document reference`);
  return ref;
};

const document = (value: unknown, context = 'document'): StoredDocument => {
  const payload = object(value, context);
  const contentHash = nullableString(payload.contentHash, `${context}.contentHash`);
  if (contentHash !== null && !/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new TypeError(`${context}.contentHash must be a SHA-256 digest`);
  }
  return {
    ref: durableRef(payload.ref, `${context}.ref`),
    name: nullableString(payload.name, `${context}.name`),
    mimeType: nullableString(payload.mimeType, `${context}.mimeType`),
    sizeBytes: finiteInteger(payload.sizeBytes, `${context}.sizeBytes`),
    contentHash,
    retainedAt: finiteInteger(payload.retainedAt, `${context}.retainedAt`),
  };
};

const imports = (value: unknown, context: string): readonly ImportedDocument[] => {
  const payload = object(value, context);
  if (!Array.isArray(payload.imports)) throw new TypeError(`${context}.imports must be an array`);
  return payload.imports.map((candidate, index) => {
    const item = object(candidate, `${context}.imports[${index}]`);
    return { document: document(item.document, `${context}.imports[${index}].document`) };
  });
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const block = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + block, bytes.length)));
  }
  return btoa(binary);
};

const base64ToBytes = (value: unknown, context: string): Uint8Array => {
  if (typeof value !== 'string') throw new TypeError(`${context} must be a base64 string`);
  const encoded = value;
  if (encoded.length > Math.ceil(PDF_CHEF_MAXIMUM_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new TypeError(`${context} is not one bounded base64 chunk`);
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new TypeError(`${context} is not valid base64`);
  }
  if (binary.length > PDF_CHEF_MAXIMUM_CHUNK_BYTES) {
    throw new TypeError(`${context} exceeds the chunk limit`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const optionalNativeString = (value: string | null): string | undefined => value ?? undefined;

export interface ListedDocument {
  document: StoredDocument;
  available: boolean;
  pending: boolean;
}

export class PdfChefDocumentsBridge {
  private readonly native: PdfChefDocumentsNativePlugin;

  constructor(native: PdfChefDocumentsNativePlugin = PdfChefDocuments) {
    this.native = native;
  }

  async retain(
    input: ReadableStream<Uint8Array>,
    metadata: Pick<StoredDocument, 'name' | 'mimeType'> & { transient?: boolean },
  ): Promise<StoredDocument> {
    const name = nullableString(metadata.name, 'metadata.name');
    const mimeType = nullableString(metadata.mimeType, 'metadata.mimeType');
    const started = object(
      await this.native.beginWrite({
        name: optionalNativeString(name),
        mimeType: optionalNativeString(mimeType),
        ...(metadata.transient ? { transient: true } : {}),
      }),
      'beginWrite result',
    );
    const sessionId = nonEmptyString(started.sessionId, 'beginWrite result.sessionId');
    let finished = false;
    try {
      if (finiteInteger(started.maximumChunkBytes, 'beginWrite result.maximumChunkBytes') !== PDF_CHEF_MAXIMUM_CHUNK_BYTES) {
        throw new TypeError('Native and JavaScript document chunk limits do not match');
      }
      const reader = input.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (!(next.value instanceof Uint8Array)) throw new TypeError('Document streams must yield Uint8Array chunks');
          for (let offset = 0; offset < next.value.byteLength; offset += PDF_CHEF_MAXIMUM_CHUNK_BYTES) {
            const chunk = next.value.subarray(offset, Math.min(offset + PDF_CHEF_MAXIMUM_CHUNK_BYTES, next.value.byteLength));
            const accepted = object(
              await this.native.appendWrite({ sessionId, data: bytesToBase64(chunk) }),
              'appendWrite result',
            );
            if (finiteInteger(accepted.acceptedBytes, 'appendWrite result.acceptedBytes') !== chunk.byteLength) {
              throw new TypeError('Native storage did not accept the complete bounded chunk');
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      const retained = document(await this.native.finishWrite({ sessionId }), 'finishWrite result');
      finished = true;
      return retained;
    } finally {
      if (!finished) {
        try {
          await this.native.abortWrite({ sessionId });
        } catch {
          // The session may already have committed; preserve the original failure.
        }
      }
    }
  }

  open(ref: DurableDocumentRef): ReadableStream<Uint8Array> {
    const checkedRef = durableRef(ref, 'ref');
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        const payload = object(
          await this.native.readChunk({
            ref: checkedRef,
            offset,
            length: PDF_CHEF_MAXIMUM_CHUNK_BYTES,
          }),
          'readChunk result',
        );
        const bytes = base64ToBytes(payload.data, 'readChunk result.data');
        const nextOffset = finiteInteger(payload.nextOffset, 'readChunk result.nextOffset');
        if (nextOffset !== offset + bytes.byteLength) {
          throw new TypeError('readChunk result offset does not match its bytes');
        }
        if (typeof payload.done !== 'boolean' || (!payload.done && bytes.byteLength === 0)) {
          throw new TypeError('readChunk result has invalid completion state');
        }
        offset = nextOffset;
        if (bytes.byteLength > 0) controller.enqueue(bytes);
        if (payload.done) controller.close();
      },
    });
  }

  async stat(ref: DurableDocumentRef): Promise<StoredDocument> {
    return document(await this.native.stat({ ref: durableRef(ref, 'ref') }), 'stat result');
  }

  async exists(ref: DurableDocumentRef): Promise<boolean> {
    const payload = object(await this.native.exists({ ref: durableRef(ref, 'ref') }), 'exists result');
    if (typeof payload.exists !== 'boolean') throw new TypeError('exists result.exists must be boolean');
    return payload.exists;
  }

  async listDocuments(): Promise<readonly ListedDocument[]> {
    const payload = object(await this.native.listDocuments(), 'listDocuments result');
    if (!Array.isArray(payload.documents)) throw new TypeError('listDocuments result.documents must be an array');
    return payload.documents.map((candidate, index) => {
      const item = object(candidate, `listDocuments result.documents[${index}]`);
      if (typeof item.available !== 'boolean') {
        throw new TypeError(`listDocuments result.documents[${index}].available must be boolean`);
      }
      if (typeof item.pending !== 'boolean') {
        throw new TypeError(`listDocuments result.documents[${index}].pending must be boolean`);
      }
      return {
        document: document(item.document, `listDocuments result.documents[${index}].document`),
        available: item.available,
        pending: item.pending,
      };
    });
  }

  async rename(ref: DurableDocumentRef, name: string): Promise<StoredDocument> {
    return document(
      await this.native.rename({ ref: durableRef(ref, 'ref'), name: nonEmptyString(name, 'name') }),
      'rename result',
    );
  }

  async delete(ref: DurableDocumentRef): Promise<void> {
    await this.native.delete({ ref: durableRef(ref, 'ref') });
  }

  async clear(): Promise<void> {
    await this.native.clear();
  }

  async storageInformation(): Promise<StorageInformation> {
    const payload = object(await this.native.storageInformation(), 'storageInformation result');
    return {
      retainedBytes: finiteInteger(payload.retainedBytes, 'storageInformation result.retainedBytes'),
      availableBytes:
        payload.availableBytes === undefined || payload.availableBytes === null
          ? null
          : finiteInteger(payload.availableBytes, 'storageInformation result.availableBytes'),
      capacityBytes:
        payload.capacityBytes === undefined || payload.capacityBytes === null
          ? null
          : finiteInteger(payload.capacityBytes, 'storageInformation result.capacityBytes'),
    };
  }

  async takePendingImports(): Promise<readonly ImportedDocument[]> {
    return imports(await this.native.takePendingImports(), 'takePendingImports result');
  }

  async acknowledgePendingImports(refs: readonly DurableDocumentRef[]): Promise<void> {
    await this.native.acknowledgePendingImports({ refs: refs.map(ref => durableRef(ref, 'ref')) });
  }

  async startPendingImportDelivery(
    consume: (value: readonly ImportedDocument[]) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    let delivery = Promise.resolve();
    const deliver = () => {
      const attempt = delivery.catch(() => undefined).then(async () => {
        const pending = await this.takePendingImports();
        if (pending.length === 0) return;
        await consume(pending);
        await this.acknowledgePendingImports(pending.map(value => value.document.ref));
      });
      delivery = attempt;
      return attempt;
    };

    // Register first. The following durable peek closes the listener-registration race.
    const listener = await this.native.addListener('pendingImportReady', () => {
      void deliver().catch(() => {
        // The queue remains durable and a future event/launch retries delivery.
      });
    });
    try {
      await deliver();
    } catch (error) {
      await listener.remove();
      throw error;
    }
    return async () => listener.remove();
  }

  async pickDocuments(
    acceptedMimeTypes: readonly string[],
    maximumItems: number,
  ): Promise<readonly ImportedDocument[]> {
    const checked = acceptedMimeTypes.map((value, index) => nonEmptyString(value, `acceptedMimeTypes[${index}]`));
    if (!Number.isSafeInteger(maximumItems) || maximumItems < 1 || maximumItems > 100) {
      throw new TypeError('maximumItems must be an integer from 1 through 100');
    }
    const picked = imports(await this.native.pickDocuments({
      acceptedMimeTypes: checked,
      maximumItems,
    }), 'pickDocuments result');
    if (picked.length > maximumItems) {
      throw new TypeError('pickDocuments result exceeds maximumItems');
    }
    return picked;
  }

  async exportDocument(ref: DurableDocumentRef, name: string | null, mimeType: string | null): Promise<void> {
    const payload = object(await this.native.exportDocument({
      ref: durableRef(ref, 'ref'),
      name: optionalNativeString(nullableString(name, 'name')),
      mimeType: optionalNativeString(nullableString(mimeType, 'mimeType')),
    }), 'exportDocument result');
    if (typeof payload.completed !== 'boolean') throw new TypeError('exportDocument result.completed must be boolean');
    if (!payload.completed) throw new DOMException('Operation cancelled.', 'AbortError');
  }

  async shareDocument(ref: DurableDocumentRef, name: string | null, mimeType: string | null): Promise<void> {
    const payload = object(await this.native.shareDocument({
      ref: durableRef(ref, 'ref'),
      name: optionalNativeString(nullableString(name, 'name')),
      mimeType: optionalNativeString(nullableString(mimeType, 'mimeType')),
    }), 'shareDocument result');
    if (typeof payload.completed !== 'boolean') throw new TypeError('shareDocument result.completed must be boolean');
    if (!payload.completed) throw new DOMException('Operation cancelled.', 'AbortError');
  }

  async signatureVerificationAvailable(): Promise<boolean> {
    const payload = object(
      await this.native.signatureVerificationAvailable(),
      'signatureVerificationAvailable result',
    );
    if (typeof payload.available !== 'boolean') {
      throw new TypeError('signatureVerificationAvailable result.available must be boolean');
    }
    return payload.available;
  }

  async presentSignatureReport(ref: DurableDocumentRef, name: string | null): Promise<void> {
    const payload = object(await this.native.presentSignatureReport({
      ref: durableRef(ref, 'ref'),
      name: optionalNativeString(nullableString(name, 'name')),
    }), 'presentSignatureReport result');
    if (typeof payload.completed !== 'boolean') {
      throw new TypeError('presentSignatureReport result.completed must be boolean');
    }
    if (!payload.completed) throw new DOMException('Operation cancelled.', 'AbortError');
  }

  async openReader(ref: DurableDocumentRef, displayName: string): Promise<IOSPdfReaderNativeResult> {
    const payload = object(await this.native.openReader({
      ref: durableRef(ref, 'ref'),
      displayName: nonEmptyString(displayName, 'displayName'),
    }), 'openReader result');
    if (payload.action === 'closed') return { action: 'closed' };
    if (
      payload.action === 'tool'
      && typeof payload.toolPath === 'string'
      && (IOS_PDF_READER_TOOL_PATHS as readonly string[]).includes(payload.toolPath)
    ) {
      return { action: 'tool', toolPath: payload.toolPath };
    }
    if (payload.action === 'batched') {
      const partCount = finiteInteger(payload.partCount, 'openReader result.partCount');
      if (partCount > 0 && partCount <= 64) return { action: 'batched', partCount };
    }
    throw new TypeError('openReader result is invalid');
  }

  async signalHaptic(signal: string): Promise<void> {
    const value = nonEmptyString(signal, 'signal');
    if (!['selection', 'commit', 'warning', 'error'].includes(value)) {
      throw new TypeError('signal is not a supported haptic signal');
    }
    await this.native.signalHaptic({ signal: value });
  }

  async getApplicationMetadata(): Promise<ApplicationMetadata> {
    const payload = object(await this.native.getApplicationMetadata(), 'getApplicationMetadata result');
    return {
      name: nonEmptyString(payload.name, 'getApplicationMetadata result.name'),
      version: nonEmptyString(payload.version, 'getApplicationMetadata result.version'),
      build: nullableString(payload.build, 'getApplicationMetadata result.build'),
    };
  }
}
