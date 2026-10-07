import type { StoredDocument } from '../../domain/workspaceModels.ts';
import type { PdfReaderService } from '../contracts.ts';
import {
  AndroidDocumentsClient,
  isAndroidDocumentsAvailable,
} from './androidDocuments.ts';

const LEGACY_REF = /^a1_([1-9][0-9]{0,15})$/;
const OWNED_REF = /^d1_[A-Za-z0-9_-]{22,64}$/;
const FALLBACK_NAME = 'Document.pdf';
const MAXIMUM_NATIVE_PDF_BYTES = 256 * 1024 * 1024;

const isCanonicalDurableRef = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (OWNED_REF.test(value)) return true;
  const legacy = LEGACY_REF.exec(value);
  if (!legacy) return false;
  const id = Number(legacy[1]);
  return Number.isSafeInteger(id) && id >= 1 && `a1_${id}` === value;
};

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

const safeName = (document: StoredDocument): string => {
  const candidate = document.name ?? FALLBACK_NAME;
  if (candidate.trim().length === 0
      || candidate.length > 180
      || candidate.includes('\0')
      || candidate.includes('/')
      || candidate.includes('\\')
      || candidate === '.'
      || candidate === '..'
      || !isWellFormedUtf16(candidate)
      || new TextEncoder().encode(candidate).length > 720) return FALLBACK_NAME;
  return candidate;
};

const isEligibleDocument = (document: StoredDocument): boolean =>
  isCanonicalDurableRef(document.ref)
  && document.mimeType === 'application/pdf'
  && document.sizeBytes !== null
  && Number.isSafeInteger(document.sizeBytes)
  && document.sizeBytes > 0
  && document.sizeBytes <= MAXIMUM_NATIVE_PDF_BYTES;

/** The reader shares the strictly discovered AndroidDocuments native bridge. */
export const isAndroidNativePdfReaderAvailable = (): boolean =>
  isAndroidDocumentsAvailable();

/** Durable a1_/d1_ PDFs use native reader; transient File objects never enter this seam. */
export const createAndroidPdfReaderService = (
  documents: AndroidDocumentsClient = new AndroidDocumentsClient(),
): PdfReaderService => ({
  supportsSignatureVerification: true,
  isEligible: isEligibleDocument,
  async open(document, options) {
    if (!isEligibleDocument(document)) {
      throw new TypeError('The document is not eligible for the native PDF reader.');
    }
    if (options?.initialAction !== undefined
        && options.initialAction !== 'verify-signatures') {
      throw new TypeError('The native PDF reader action is invalid.');
    }
    return documents.openReader(document.ref, safeName(document), options?.initialAction);
  },
});
