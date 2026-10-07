import type { StoredDocument } from '../../domain/workspaceModels.ts';
import type { PdfReaderResult, PdfReaderService } from '../contracts.ts';

export const IOS_PDF_READER_TOOL_PATHS = [
  '/compress',
  '/merge',
  '/split',
  '/edit',
  '/make-fillable',
  '/sign',
  '/watermark',
  '/protect',
  '/unlock',
  '/delete-pages',
  '/page-numbers',
  '/reorder',
  '/rotate',
  '/flatten',
  '/extract',
  '/pdf-to-jpg',
  '/pdf-to-word',
  '/ocr',
  '/metadata',
  '/repair',
  '/compare',
] as const;

export type IOSPdfReaderNativeResult =
  | PdfReaderResult
  | { action: 'batched'; partCount: number };

const TOOL_PATHS = new Set<string>(IOS_PDF_READER_TOOL_PATHS);
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FALLBACK_NAME = 'Document.pdf';
export const IOS_MAXIMUM_WEB_HANDOFF_BYTES = 200 * 1024 * 1024;
// Keep this preflight limit in sync with PdfChefSignatureVerifier.maximumFileSizeBytes.
export const IOS_MAXIMUM_SIGNATURE_VERIFICATION_BYTES = 64 * 1024 * 1024;

export class IOSSignatureVerificationSizeError extends RangeError {
  constructor() {
    super('The PDF is too large for signature verification.');
  }
}

export interface IOSPdfReaderBridge {
  openReader(ref: StoredDocument['ref'], displayName: string): Promise<IOSPdfReaderNativeResult>;
  presentSignatureReport?(ref: StoredDocument['ref'], name: string | null): Promise<void>;
}

export interface IOSPdfReaderCapabilities {
  isSignatureVerificationAvailable(): boolean;
}

const safeName = (document: StoredDocument): string => {
  const candidate = document.name ?? FALLBACK_NAME;
  if (
    candidate.trim().length === 0
    || candidate.length > 180
    || candidate.includes('\0')
    || candidate.includes('/')
    || candidate.includes('\\')
    || candidate === '.'
    || candidate === '..'
    || new TextEncoder().encode(candidate).length > 720
  ) return FALLBACK_NAME;
  return candidate;
};

export const isEligibleIOSPdf = (document: StoredDocument): boolean => {
  const mimeType = document.mimeType?.toLocaleLowerCase();
  const name = document.name?.toLocaleLowerCase();
  return OPAQUE_REF.test(document.ref)
    && (mimeType === 'application/pdf' || (!mimeType && name?.endsWith('.pdf') === true))
    && document.sizeBytes !== null
    && Number.isSafeInteger(document.sizeBytes)
    && document.sizeBytes > 0;
};

export const createIOSPdfReaderService = (
  bridge: IOSPdfReaderBridge,
  capabilities: IOSPdfReaderCapabilities = {
    isSignatureVerificationAvailable: () => false,
  },
): PdfReaderService => ({
  get supportsSignatureVerification() {
    return capabilities.isSignatureVerificationAvailable()
      && typeof bridge.presentSignatureReport === 'function';
  },
  isEligible: isEligibleIOSPdf,
  async open(document, options) {
    if (!isEligibleIOSPdf(document)) {
      throw new TypeError('The document is not eligible for the native iOS PDF reader.');
    }
    if (
      options?.initialAction !== undefined
      && options.initialAction !== 'verify-signatures'
    ) {
      throw new TypeError('The native iOS PDF reader action is invalid.');
    }
    if (options?.initialAction === 'verify-signatures') {
      if (
        !capabilities.isSignatureVerificationAvailable()
        || typeof bridge.presentSignatureReport !== 'function'
      ) {
        throw new TypeError('Native iOS signature verification is unavailable.');
      }
      if ((document.sizeBytes ?? 0) > IOS_MAXIMUM_SIGNATURE_VERIFICATION_BYTES) {
        throw new IOSSignatureVerificationSizeError();
      }
      await bridge.presentSignatureReport(document.ref, safeName(document));
      return { action: 'closed' };
    }
    let result: IOSPdfReaderNativeResult;
    try {
      result = await bridge.openReader(document.ref, safeName(document));
    } catch (error) {
      // A very large retained PDF must never fall through to PDF.js after a
      // native presentation failure. It remains available in Recent so the
      // user can retry the native reader and its bounded-part workflow.
      if ((document.sizeBytes ?? 0) > IOS_MAXIMUM_WEB_HANDOFF_BYTES) {
        return { action: 'closed' };
      }
      throw error;
    }
    if (result.action === 'closed') return result;
    if (result.action === 'tool' && TOOL_PATHS.has(result.toolPath)) return result;
    if (
      result.action === 'batched'
      && Number.isSafeInteger(result.partCount)
      && result.partCount > 0
      && result.partCount <= 64
    ) {
      // Native storage is authoritative. Its next listDocuments() reconciliation
      // adds the new parts to Recent without transferring PDF bytes or metadata
      // arrays over the bridge.
      return { action: 'closed' };
    }
    throw new TypeError('The native iOS PDF reader returned an invalid action.');
  },
});
