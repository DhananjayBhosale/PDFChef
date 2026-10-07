import { LocalizedError } from './i18n/errors.ts';
import { t } from './i18n/core.ts';
import type { OutputDeliveryHandler } from './platform/contracts.ts';
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
}

/** Delivery feedback is transient; it is never written to local history. */
export interface OutputReadyRecord extends OutputRecord {
  deliveryIssue?: 'cancelled' | 'failed';
  historyRetained?: boolean;
  /** True only after a platform actually wrote a copy outside the app. */
  externallyExported?: boolean;
  /** A metered iOS preview is intentionally visible only in this transient event. */
  accessLocked?: boolean;
  /** Native scanner results already live in Recent; load bytes only for an action that needs them. */
  recentRecord?: RecentRecord;
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
export const installOutputDeliveryHandler = (handler: OutputDeliveryHandler): (() => void) => {
  const installation = { handler };
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

export const getSafeBuffer = (buffer: ArrayBuffer): Uint8Array => {
  return new Uint8Array(buffer).slice(0);
};

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
      autoDownload: settings.autoDownload,
    });
    const ready: OutputReadyRecord = {
      ...record,
      historyRetained: settings.keepLocalHistory,
      ...(outcome && outcome.exportIssue ? { deliveryIssue: outcome.exportIssue } : {}),
      ...(outcome && typeof outcome.externallyExported === 'boolean'
        ? { externallyExported: outcome.externallyExported }
        : {}),
      ...(outcome && outcome.recentRecord ? { recentRecord: outcome.recentRecord } : {}),
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
  const access = options?.accessScope === 'source' ? null : outputAccessHandler;
  if (access) {
    void checkOutputAccess(blob, filename, resolvedMimeType, toolPath, options)
      .then(result => {
        if (result.disposition.status === 'preview') {
          announceOutput(result.preview!);
          return;
        }
        if (installation) {
          return deliverWithInstalledHandler(installation, blob, filename, resolvedMimeType, toolPath);
        }
        void downloadBlobWithoutAccess(blob, filename, resolvedMimeType, toolPath);
      })
      .catch(error => console.warn('Unable to check output access.', error));
    return null;
  }
  if (installation) {
    void deliverWithInstalledHandler(installation, blob, filename, resolvedMimeType, toolPath)
      .catch((error) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          console.warn('Unable to deliver output.', error);
        }
      });
    return null;
  }

  const settings = getWorkspaceSettings();
  const recorded = recordOutput(blob, filename, resolvedMimeType, toolPath)
    .then(record => ({ record, retained: settings.keepLocalHistory, historyError: undefined as unknown }))
    .catch(historyError => ({
      record: createOutputRecord(blob, filename, resolvedMimeType, toolPath),
      retained: false,
      historyError,
    }));
  const announceResult = async (deliveryError?: unknown) => {
    const { record, retained, historyError } = await recorded;
    const issue = deliveryError ?? (!settings.autoDownload ? historyError : undefined);
    if (issue !== undefined) announceRetryableOutput(record, issue, retained);
    else {
      const ready: OutputReadyRecord = { ...record, historyRetained: retained };
      announceOutput(ready);
    }
  };

  if (!settings.autoDownload) {
    void announceResult();
    return null;
  }

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    void (async () => {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          types: mimeType
            ? [
                {
                  description: t("pdf-shared.document.export.5cf1c6"),
                  accept: { [mimeType]: [`.${filename.split('.').pop() || ''}`] },
                },
              ]
            : undefined,
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        await announceResult();
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          await announceResult(error);
          return;
        }
        try {
          triggerBrowserDownload(blob, filename);
          await announceResult();
        } catch (downloadError) {
          await announceResult(downloadError);
        }
      }
    })();
    return null;
  }

  try {
    const url = triggerBrowserDownload(blob, filename);
    void announceResult();
    return url;
  } catch (error) {
    void announceResult(error);
    throw error;
  }
};

const downloadBlobWithoutAccess = (
  blob: Blob,
  filename: string,
  resolvedMimeType: string,
  toolPath: string,
) => {
  const settings = getWorkspaceSettings();
  const recorded = recordOutput(blob, filename, resolvedMimeType, toolPath)
    .then(record => ({ record, retained: settings.keepLocalHistory, historyError: undefined as unknown }))
    .catch(historyError => ({
      record: createOutputRecord(blob, filename, resolvedMimeType, toolPath),
      retained: false,
      historyError,
    }));
  const announceResult = async (deliveryError?: unknown) => {
    const { record, retained, historyError } = await recorded;
    const issue = deliveryError ?? (!settings.autoDownload ? historyError : undefined);
    if (issue !== undefined) announceRetryableOutput(record, issue, retained);
    else {
      const ready: OutputReadyRecord = { ...record, historyRetained: retained };
      announceOutput(ready);
    }
  };
  if (!settings.autoDownload) {
    void announceResult();
    return null;
  }
  try {
    const url = triggerBrowserDownload(blob, filename);
    void announceResult();
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
  let record: OutputRecord | null = null;
  let historyError: unknown;
  try {
    record = await recordOutput(blob, filename, resolvedMimeType, toolPath);
  } catch (error) {
    historyError = error;
  }
  const recoverable = record ?? createOutputRecord(blob, filename, resolvedMimeType, toolPath);
  const historyRetained = settings.keepLocalHistory && record !== null;
  const announceSuccess = () => {
    const ready: OutputReadyRecord = { ...recoverable, historyRetained };
    announceOutput(ready);
  };
  const download = () => {
    try {
      triggerBrowserDownload(blob, filename);
      announceSuccess();
    } catch (error) {
      announceRetryableOutput(recoverable, error, historyRetained);
      throw error;
    }
  };

  if (!settings.autoDownload) {
    if (!record) {
      announceRetryableOutput(recoverable, historyError);
      throw historyError;
    }
    announceSuccess();
    return { status: 'delivered' };
  }

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: filename,
        types: resolvedMimeType
          ? [
              {
                description: t("pdf-shared.document.export.5cf1c6"),
                accept: { [resolvedMimeType]: [`.${filename.split('.').pop() || ''}`] },
              },
            ]
          : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      announceSuccess();
      return { status: 'delivered' };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        announceRetryableOutput(recoverable, error, historyRetained);
        if (historyRetained) return { status: 'delivered' };
        throw historyError ?? error;
      }
      download();
      return { status: 'delivered' };
    }
  }

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
