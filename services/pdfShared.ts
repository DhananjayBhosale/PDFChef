import { LocalizedError } from './i18n/errors.ts';
import type { OutputDeliveryHandler, SavedCopy } from './platform/contracts.ts';
import type { RecentRecord } from './domain/workspaceModels.ts';
import { Capacitor } from '@capacitor/core';
import {
  announceOutput,
  getWorkspaceSettings,
  recordOutput,
  type OutputRecord,
} from './workspace.ts';

interface InstalledOutputDeliveryHandler {
  handler: OutputDeliveryHandler;
  maximumBytes?: number;
}

/**
 * Refuses a result the platform cannot keep or save, before anything says it is ready.
 * Without this, Android announced a 480 MB result and every Save failed after 100 seconds.
 */
export const assertOutputSize = (size: number, maximumBytes: number | undefined) => {
  if (maximumBytes === undefined || size <= maximumBytes) return;
  const megabytes = (bytes: number) => Math.ceil(bytes / (1024 * 1024));
  throw new LocalizedError('error.outputTooLarge', { v0: megabytes(size), v1: megabytes(maximumBytes) });
};

/** Delivery feedback is transient; it is never written to local history. */
export interface OutputReadyRecord extends OutputRecord {
  deliveryIssue?: 'cancelled' | 'failed';
  historyRetained?: boolean;
  /** True only after a platform actually wrote a copy outside the app. */
  externallyExported?: boolean;
  /** The copy written outside the app: the name it was saved under. */
  savedCopy?: SavedCopy;
  /** A metered iOS preview is intentionally visible only in this transient event. */
  accessLocked?: boolean;
  /** Native scanner results already live in Recent; load bytes only for an action that needs them. */
  recentRecord?: RecentRecord;
  /**
   * The result (a Split ZIP) was not saved automatically: its parts are saved one by one instead
   * (the result strip runs "Save N files separately"). `folder` is the folder already picked at
   * the tap that started the job (desktop Chrome and Edge).
   */
  separateSave?: SeparateSaveRequest;
}

export interface SeparateSaveRequest {
  readonly folder?: FileSystemDirectoryHandle;
  /** The ZIP's PDFs under their entry names, as the split made them: not read back out of the ZIP. */
  readonly parts?: readonly { readonly name: string; readonly blob: Blob }[];
}

export interface OutputAccessRequest {
  readonly operationId: string;
  readonly blob: Blob;
  readonly name: string;
  readonly mimeType: string;
  readonly toolPath: string;
}

export type OutputAccessDisposition =
  | { readonly status: 'deliver' }
  | { readonly status: 'preview' };

export type OutputDeliveryDisposition =
  | { readonly status: 'delivered' }
  | { readonly status: 'preview' };

export type OutputAccessHandler = (request: OutputAccessRequest) => Promise<OutputAccessDisposition>;

export interface OutputDeliveryOptions {
  /** Reuse one native quota decision across preview, copy, and delivery retries. */
  readonly operationId?: string;
  /** Unchanged source files are not processing jobs and never consume the iOS allowance. */
  readonly accessScope?: 'generated' | 'source';
  /** Keep and announce the result without saving it; its parts are saved separately (Split). */
  readonly separateSave?: SeparateSaveRequest;
}

let outputAccessHandler: OutputAccessHandler | null = null;
const outputOperationIds = new WeakMap<Blob, string>();

const outputOperationId = (blob: Blob): string => {
  const existing = outputOperationIds.get(blob);
  if (existing) return existing;
  const next = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  outputOperationIds.set(blob, next);
  return next;
};

/** Installs the optional native entitlement seam. Without it all existing delivery stays unchanged. */
export const installOutputAccessHandler = (handler: OutputAccessHandler): (() => void) => {
  outputAccessHandler = handler;
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    if (outputAccessHandler === handler) outputAccessHandler = null;
  };
};

const announceRetryableOutput = (record: OutputRecord, error: unknown, historyRetained = false) => {
  const retry: OutputReadyRecord = {
    ...record,
    deliveryIssue: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed',
    historyRetained,
  };
  announceOutput(retry);
};

let outputDeliveryHandler: InstalledOutputDeliveryHandler | null = null;

/** Installs one process-wide delivery seam. Cleanup cannot remove a newer handler. */
export const installOutputDeliveryHandler = (
  handler: OutputDeliveryHandler,
  options: { readonly maximumBytes?: number } = {},
): (() => void) => {
  const installation: InstalledOutputDeliveryHandler = { handler, maximumBytes: options.maximumBytes };
  outputDeliveryHandler = installation;
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    if (outputDeliveryHandler === installation) outputDeliveryHandler = null;
  };
};

export const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
};

/** Browsers and file pickers do not consistently provide a MIME type for local PDFs. */
export const isPdfFile = (file: File): boolean =>
  file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

const canvasDataUrlToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => {
  const dataUrl = canvas.toDataURL(type, quality);
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new LocalizedError("pdf-shared.canvas.export.failed.dc7043");

  const header = dataUrl.slice(0, separator);
  const payload = dataUrl.slice(separator + 1);
  const mimeType = /^data:([^;,]+)/.exec(header)?.[1] || type;
  const decoded = atob(payload);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
};

export const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => {
  // Android System WebView can leave HTMLCanvasElement.toBlob callbacks pending
  // indefinitely. Its synchronous encoder is reliable, so use that only in the
  // native shell and keep the lower-memory asynchronous path in browsers.
  if (Capacitor.isNativePlatform()) {
    return Promise.resolve(canvasDataUrlToBlob(canvas, type, quality));
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new LocalizedError("pdf-shared.canvas.export.failed.dc7043"));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
};

export const revokeObjectUrl = (url?: string | null) => {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
};

export const revokeObjectUrls = (urls: Iterable<string | null | undefined>) => {
  for (const url of urls) {
    revokeObjectUrl(url);
  }
};

export const triggerBrowserDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return url;
};

const createOutputRecord = (
  blob: Blob,
  filename: string,
  mimeType: string,
  toolPath: string,
): OutputRecord => ({
  id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  filename,
  mimeType,
  size: blob.size,
  toolPath,
  createdAt: Date.now(),
  blob,
});

/**
 * Keeps a browser result in Recent when history is on. A failed history write is not a failed
 * delivery: the result is still handed over, only marked as not kept, so the tool and the
 * result sheet never disagree about whether it was saved.
 */
const keepInHistory = async (
  blob: Blob,
  filename: string,
  mimeType: string,
  toolPath: string,
  keepLocalHistory: boolean,
): Promise<{ record: OutputRecord; retained: boolean }> => {
  try {
    return { record: await recordOutput(blob, filename, mimeType, toolPath), retained: keepLocalHistory };
  } catch (error) {
    console.warn('Unable to keep the result in Recent.', error);
    return { record: createOutputRecord(blob, filename, mimeType, toolPath), retained: false };
  }
};

/** Starts keeping a browser result and returns how to announce it once its delivery settles. */
const browserResultAnnouncer = (
  blob: Blob,
  filename: string,
  mimeType: string,
  toolPath: string,
  keepLocalHistory: boolean,
  separateSave?: SeparateSaveRequest,
) => {
  const kept = keepInHistory(blob, filename, mimeType, toolPath, keepLocalHistory);
  // `downloaded` is what this delivery did: true only after it started the download. The result
  // sheet must not infer it from a setting read later (s2-07).
  return async (deliveryError?: unknown, downloaded = false) => {
    const { record, retained } = await kept;
    if (deliveryError !== undefined) announceRetryableOutput(record, deliveryError, retained);
    else {
      const ready: OutputReadyRecord = {
        ...record,
        historyRetained: retained,
        externallyExported: downloaded,
        ...(separateSave ? { separateSave } : {}),
      };
      announceOutput(ready);
    }
  };
};

const checkOutputAccess = async (
  blob: Blob,
  filename: string,
  mimeType: string,
  toolPath: string,
  options?: OutputDeliveryOptions,
): Promise<{ disposition: OutputDeliveryDisposition; preview?: OutputReadyRecord }> => {
  const handler = outputAccessHandler;
  if (!handler) return { disposition: { status: 'delivered' } };
  const record = {
    ...createOutputRecord(blob, filename, mimeType, toolPath),
    id: options?.operationId?.trim() || outputOperationId(blob),
  };
  const result = await handler({
    operationId: record.id,
    blob,
    name: filename,
    mimeType,
    toolPath,
  });
  if (result.status === 'preview') {
    return {
      disposition: { status: 'preview' },
      preview: { ...record, historyRetained: false, accessLocked: true },
    };
  }
  return { disposition: { status: 'delivered' } };
};

const deliverWithInstalledHandler = async (
  installation: InstalledOutputDeliveryHandler,
  blob: Blob,
  filename: string,
  mimeType: string,
  toolPath: string,
  separateSave?: SeparateSaveRequest,
): Promise<void> => {
  const settings = getWorkspaceSettings();
  const record = createOutputRecord(blob, filename, mimeType, toolPath);
  try {
    const outcome = await installation.handler({
      blob,
      name: filename,
      mimeType,
      toolPath,
      keepLocalHistory: settings.keepLocalHistory,
      // Parts saved separately: the result itself is kept (Recent) but not exported.
      autoDownload: settings.autoDownload && !separateSave,
    });
    const ready: OutputReadyRecord = {
      ...record,
      historyRetained: settings.keepLocalHistory,
      ...(separateSave ? { separateSave, externallyExported: false } : {}),
      ...(outcome && outcome.exportIssue ? { deliveryIssue: outcome.exportIssue } : {}),
      ...(outcome && typeof outcome.externallyExported === 'boolean'
        ? { externallyExported: outcome.externallyExported }
        : {}),
      ...(outcome && outcome.recentRecord ? { recentRecord: outcome.recentRecord } : {}),
      ...(outcome && outcome.savedCopy ? { savedCopy: outcome.savedCopy } : {}),
    };
    announceOutput(ready);
  } catch (error) {
    // Keep exact generated bytes available for retry without persisting them
    // when history is disabled. Awaiting editors still receive the failure.
    announceRetryableOutput(record, error);
    throw error;
  }
};

export const downloadBlob = (
  blob: Blob,
  filename: string,
  mimeType = blob.type,
  options?: OutputDeliveryOptions,
) => {
  const resolvedMimeType = mimeType || blob.type || 'application/octet-stream';
  const toolPath = typeof window !== 'undefined' ? window.location.pathname : '';
  const installation = outputDeliveryHandler;
  assertOutputSize(blob.size, installation?.maximumBytes);
  const separateSave = options?.separateSave;
  const access = options?.accessScope === 'source' ? null : outputAccessHandler;
  if (access) {
    void checkOutputAccess(blob, filename, resolvedMimeType, toolPath, options)
      .then(result => {
        if (result.disposition.status === 'preview') {
          // The parts are saved through the result strip's access check (OutputCenter's guard).
          announceOutput(separateSave ? { ...result.preview!, separateSave } : result.preview!);
          return;
        }
        if (installation) {
          return deliverWithInstalledHandler(installation, blob, filename, resolvedMimeType, toolPath, separateSave);
        }
        void downloadBlobWithoutAccess(blob, filename, resolvedMimeType, toolPath, separateSave);
      })
      .catch(error => console.warn('Unable to check output access.', error));
    return null;
  }
  if (installation) {
    void deliverWithInstalledHandler(installation, blob, filename, resolvedMimeType, toolPath, separateSave)
      .catch((error) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          console.warn('Unable to deliver output.', error);
        }
      });
    return null;
  }
  return downloadBlobWithoutAccess(blob, filename, resolvedMimeType, toolPath, separateSave);
};

const downloadBlobWithoutAccess = (
  blob: Blob,
  filename: string,
  resolvedMimeType: string,
  toolPath: string,
  separateSave?: SeparateSaveRequest,
) => {
  const settings = getWorkspaceSettings();
  const announceResult = browserResultAnnouncer(
    blob, filename, resolvedMimeType, toolPath, settings.keepLocalHistory, separateSave);

  // With automatic saving off nothing is saved; with separate parts the strip saves them.
  if (!settings.autoDownload || separateSave) {
    void announceResult();
    return null;
  }

  // An automatic save is a plain download. The save picker needs a user gesture, and the job
  // finishes long after the tap that started it, so the picker would fail or wait for a click
  // (h3 F1). The picker was used only on the automatic paths (here and in deliverBlob); the result sheet's Download is unchanged.
  try {
    const url = triggerBrowserDownload(blob, filename);
    void announceResult(undefined, true);
    return url;
  } catch (error) {
    void announceResult(error);
    throw error;
  }
};

/**
 * Delivers one output and resolves only after the result is recoverable.
 *
 * Existing tools intentionally keep `downloadBlob`'s fire-and-forget behavior.
 * Editors that disarm a dirty-state guard use this seam so a failed or cancelled
 * native delivery cannot be reported as a successful save.
 */
export const deliverBlob = async (
  blob: Blob,
  filename: string,
  mimeType = blob.type,
  options?: OutputDeliveryOptions,
): Promise<OutputDeliveryDisposition> => {
  const resolvedMimeType = mimeType || blob.type || 'application/octet-stream';
  const toolPath = typeof window !== 'undefined' ? window.location.pathname : '';
  const installation = outputDeliveryHandler;
  assertOutputSize(blob.size, installation?.maximumBytes);
  const access = await checkOutputAccess(blob, filename, resolvedMimeType, toolPath, options);
  if (access.disposition.status === 'preview') {
    announceOutput(access.preview!);
    return access.disposition;
  }
  if (installation) {
    await deliverWithInstalledHandler(installation, blob, filename, resolvedMimeType, toolPath);
    return { status: 'delivered' };
  }

  const settings = getWorkspaceSettings();
  const { record: recoverable, retained: historyRetained } = await keepInHistory(
    blob, filename, resolvedMimeType, toolPath, settings.keepLocalHistory);
  // Whether this delivery downloaded the result, said by the delivery itself (s2-07).
  const announceSuccess = (downloaded: boolean) => {
    const ready: OutputReadyRecord = { ...recoverable, historyRetained, externallyExported: downloaded };
    announceOutput(ready);
  };
  const download = () => {
    try {
      triggerBrowserDownload(blob, filename);
      announceSuccess(true);
    } catch (error) {
      announceRetryableOutput(recoverable, error, historyRetained);
      throw error;
    }
  };

  if (!settings.autoDownload) {
    announceSuccess(false);
    return { status: 'delivered' };
  }

  // A plain download, never the save picker (see downloadBlob).
  download();
  return { status: 'delivered' };
};

export const downloadBytes = (
  bytes: Uint8Array | ArrayBuffer,
  filename: string,
  mimeType = 'application/octet-stream',
) => {
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return downloadBlob(new Blob([payload], { type: mimeType }), filename, mimeType);
};
