/**
 * The PDF engines (PDF.js, pdf-lib, the converters) load on first use, not with a tool's first
 * screen: a tool opens on its drop zone, which needs none of them. Each export keeps the name and
 * signature of the function it forwards to, so a screen only changes where it imports from.
 */
import type * as PdfBrowser from './pdfBrowser';
import { namedPdfError, pdfProblemMessage } from './i18n/errors.ts';

export type {
  EmbeddedPdfImageAsset,
  ImageExportConfig,
  PdfFormFieldDefinition,
  PdfFormFieldValue,
  PdfPreviewProgress,
} from './pdfBrowser';
export type { HeaderFooterOptions, PDFPageLayout, SplitResult } from './pdfDocument';

type AsyncKeys<M> = { [K in keyof M]: M[K] extends (...args: any[]) => Promise<unknown> ? K : never }[keyof M];

function lazy<M, K extends AsyncKeys<M>>(load: () => Promise<M>, key: K): M[K] {
  return ((...args: unknown[]) => load().then((module) =>
    (module[key] as unknown as (...forwarded: unknown[]) => unknown)(...args))) as M[K];
}

let browserModule: typeof PdfBrowser | null = null;
const browser = () => import('./pdfBrowser').then((module) => (browserModule = module));
const pdfDocument = () => import('./pdfDocument');

/** Starts loading PDF.js early, for a screen that is about to receive a PDF. */
export const preloadPdfEngine = () => { void browser().catch(() => undefined); };

/** Nothing to release until the engine has opened a document. */
export const releasePDFDocument = async (file: File) => { await browserModule?.releasePDFDocument(file); };

export const analyzePDF = lazy(browser, 'analyzePDF');
export const compressPDFAdaptive = lazy(browser, 'compressPDFAdaptive');
export const extractEmbeddedImagesFromPDF = lazy(browser, 'extractEmbeddedImagesFromPDF');
export const extractTextFromPDF = lazy(browser, 'extractTextFromPDF');
export const getPageSelectableTextLines = lazy(browser, 'getPageSelectableTextLines');
export const getPageTextBackgroundPatch = lazy(browser, 'getPageTextBackgroundPatch');
export const getPageTextSignatures = lazy(browser, 'getPageTextSignatures');
export const getPdfFormFields = lazy(browser, 'getPdfFormFields');
export const getPdfPagePreviews = lazy(browser, 'getPdfPagePreviews');
export const loadDisposablePDFDocument = lazy(browser, 'loadDisposablePDFDocument');
export const loadEditablePDFDocument = lazy(browser, 'loadEditablePDFDocument');
export const loadPDFDocument = lazy(browser, 'loadPDFDocument');
export const loadProtectedPDFDocument = lazy(browser, 'loadProtectedPDFDocument');
export const opensWithoutPassword = lazy(browser, 'opensWithoutPassword');
export const needsOpenPassword = lazy(browser, 'needsOpenPassword');
export const renderPageAsImage = lazy(browser, 'renderPageAsImage');
export const renderPdfPageToBlob = lazy(browser, 'renderPdfPageToBlob');

export const addHeaderFooterToPDF = lazy(pdfDocument, 'addHeaderFooterToPDF');
export const addPageNumbersToPDF = lazy(pdfDocument, 'addPageNumbersToPDF');
export const addWatermarkToPDF = lazy(pdfDocument, 'addWatermarkToPDF');
export const applySignaturesToPDF = lazy(pdfDocument, 'applySignaturesToPDF');
export const createPDFFromImages = lazy(pdfDocument, 'createPDFFromImages');
export const createPDFFromLayout = lazy(pdfDocument, 'createPDFFromLayout');
export const cropPDFMargins = lazy(pdfDocument, 'cropPDFMargins');
export const deletePagesFromPDF = lazy(pdfDocument, 'deletePagesFromPDF');
export const extractPages = lazy(pdfDocument, 'extractPages');
export const flattenPDF = lazy(pdfDocument, 'flattenPDF');
export const getPDFMetadata = lazy(pdfDocument, 'getPDFMetadata');
export const getPDFPageCount = lazy(pdfDocument, 'getPDFPageCount');
export const protectPDF = lazy(pdfDocument, 'protectPDF');
export const removeBlankPagesFromPDF = lazy(pdfDocument, 'removeBlankPagesFromPDF');
export const findBlankPages = lazy(pdfDocument, 'findBlankPages');
export const removePDFAnnotations = lazy(pdfDocument, 'removePDFAnnotations');
export const removePDFMetadata = lazy(pdfDocument, 'removePDFMetadata');
export const readHiddenInfo = lazy(pdfDocument, 'readHiddenInfo');
export const reorderPDFPages = lazy(pdfDocument, 'reorderPDFPages');
export const repairPDF = lazy(pdfDocument, 'repairPDF');
export const savePDFWithAnnotations = lazy(pdfDocument, 'savePDFWithAnnotations');
export const rotatePDF = lazy(pdfDocument, 'rotatePDF');
export const rotateSpecificPages = lazy(pdfDocument, 'rotateSpecificPages');
export const sanitizePDF = lazy(pdfDocument, 'sanitizePDF');
export const setPDFMetadata = lazy(pdfDocument, 'setPDFMetadata');
export const splitPDFByMaximumSize = lazy(pdfDocument, 'splitPDFByMaximumSize');
export const splitPDFByPagesPerFile = lazy(pdfDocument, 'splitPDFByPagesPerFile');
export const unlockPDF = lazy(pdfDocument, 'unlockPDF');

/**
 * Why a job on this file failed when the file itself is the cause (a password, not a PDF, a
 * damaged page tree), in the reader's words; null when the file reads and the cause is elsewhere.
 * Read from the error first, then from a page count (cached per file).
 */
export const pdfFileProblem = async (file: File, error?: unknown, name?: string): Promise<string | null> => {
  // A job over several files names the one at fault.
  const said = (reason: unknown) => pdfProblemMessage(name ? namedPdfError(reason, name) : reason);
  const direct = error === undefined ? null : said(error);
  if (direct) return direct;
  try {
    await getPDFPageCount(file);
    return null;
  } catch (reason) {
    return said(reason);
  }
};

/** JSZip, for a screen that packs its results into one archive. */
export const loadJSZip = () => import('jszip').then((module) => module.default);

export const convertPDFToDocx = lazy(() => import('./docxExport'), 'convertPDFToDocx');
export const convertDocxToPdf = lazy(() => import('./officeDocument'), 'convertDocxToPdf');
export const createFillablePdf = lazy(() => import('./fillableForms'), 'createFillablePdf');
export const detectVisualFormFields = lazy(() => import('./fillableForms'), 'detectVisualFormFields');
