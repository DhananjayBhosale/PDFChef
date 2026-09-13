import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFStream,
  PDFTextField,
  rgb,
  degrees,
  StandardFonts,
} from 'pdf-lib';
import JSZip from 'jszip';
import { copyPagesWithForms } from './pdfPageCopy';
import type { PDFMetadata } from '../types';
import type { PdfFormFieldValue } from './pdfBrowser';
import { loadPDFDocument } from './pdfBrowser';
import { readFileAsArrayBuffer } from './pdfShared';
import { getPdfPageVisualGeometry } from './pdfPageGeometry';
import { decryptPdf, encryptPdfWithAes128 } from './qpdfBrowser';
import {
  getVisualPageSize,
  normalizePageRotation,
  rotatePointAroundCenter,
  rotatedBoxOrigin,
  visualPointToPdf,
  visualRectangleToPdf,
} from './pdfEditorGeometry';
import type { PdfSpaceRect } from './pdfNativeTextPlanning';
import { layoutParagraphLines, paragraphStandardFontKey } from './pdfParagraphLayout';
import {
  DELETE_ALL_PAGES_MESSAGE,
  DELETE_PAGES_TOO_LARGE_MESSAGE,
  MAX_DELETE_PAGES_INPUT_BYTES,
  MIN_PROTECT_PASSWORD_LENGTH,
  NO_PAGES_MESSAGE,
  PASSWORD_REQUIRED_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  UNLOCK_FAILED_MESSAGE,
  UNLOCK_PASSWORD_REQUIRED_MESSAGE,
  buildPageExportLabel,
  buildPageNumberText,
  pageNumberLayout,
  remainingPageIndices,
  resolveOptionalPageSelection,
  resolvePageNumberRange,
  resolvePageOrder,
  resolvePageSelection,
  rotatedTextOrigin,
  sanitizePageNumberFontSize,
  sanitizePdfText,
  watermarkLayout,
  DEFAULT_PAGE_NUMBER_FONT_SIZE,
  DEFAULT_PAGE_NUMBER_X_PERCENT,
  DEFAULT_PAGE_NUMBER_Y_PERCENT,
  DEFAULT_WATERMARK_COLOR_HEX,
  DEFAULT_WATERMARK_ROTATION_DEGREES,
  DEFAULT_WATERMARK_SIZE,
  DEFAULT_WATERMARK_X_PERCENT,
  DEFAULT_WATERMARK_Y_PERCENT,
  WATERMARK_MAX_ROTATION_DEGREES,
  WATERMARK_MIN_ROTATION_DEGREES,
  pageRotationFitScale,
  pageRotationMetadataDegreesOrNull,
  sanitizePageRotationDegrees,
} from './androidParity';

const pageCountCache = new WeakMap<File, Promise<number>>();

const throwIfPdfJobAborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('PDF operation cancelled.');
  error.name = 'AbortError';
  throw error;
};

/** Give the browser a chance to deliver a pending Cancel tap between expensive file/page units. */
const pdfJobCheckpoint = async (signal?: AbortSignal, yieldToEvents = false) => {
  throwIfPdfJobAborted(signal);
  if (!signal || !yieldToEvents) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfPdfJobAborted(signal);
};

export const mergePDFs = async (files: File[], signal?: AbortSignal): Promise<Uint8Array> => {
  await pdfJobCheckpoint(signal);
  const mergedPdf = await PDFDocument.create();
  for (let index = 0; index < files.length; index += 1) {
    await pdfJobCheckpoint(signal, index > 0);
    const file = files[index];
    const arrayBuffer = await readFileAsArrayBuffer(file);
    throwIfPdfJobAborted(signal);
    const pdf = await PDFDocument.load(arrayBuffer);
    throwIfPdfJobAborted(signal);
    const copiedPages = await copyPagesWithForms(mergedPdf, pdf, pdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
    throwIfPdfJobAborted(signal);
  }
  await pdfJobCheckpoint(signal, true);
  removeUnusedPdfObjects(mergedPdf);
  const bytes = await mergedPdf.save();
  await pdfJobCheckpoint(signal, true);
  return bytes;
};

export const createPDFFromImages = async (
  files: File[],
  layout: { fit: 'contain' | 'cover' | 'fill'; margin: number } = { fit: 'contain', margin: 0 },
): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.create();

  for (const file of files) {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    let image;

    if (file.type === 'image/jpeg') image = await pdfDoc.embedJpg(arrayBuffer);
    else if (file.type === 'image/png') image = await pdfDoc.embedPng(arrayBuffer);
    else throw new Error('This image format cannot be included in the PDF.');

    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const { width, height } = image.scale(1);
    const availableWidth = pageWidth - layout.margin * 2;
    const availableHeight = pageHeight - layout.margin * 2;
    const scale = Math.min(availableWidth / width, availableHeight / height);
    const displayWidth = width * scale;
    const displayHeight = height * scale;

    page.drawImage(image, {
      x: (pageWidth - displayWidth) / 2,
      y: (pageHeight - displayHeight) / 2,
      width: displayWidth,
      height: displayHeight,
    });
  }

  return pdfDoc.save();
};

export interface PDFPageLayout {
  width: number;
  height: number;
  elements: PDFImageElement[];
}

export interface PDFImageElement {
  file: File;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const createPDFFromLayout = async (pages: PDFPageLayout[]): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.create();
  const imageCache = new WeakMap<File, Promise<any>>();

  const loadEmbeddedImage = async (file: File) => {
    const cached = imageCache.get(file);
    if (cached) return cached;

    const promise = (async () => {
      const arrayBuffer = await readFileAsArrayBuffer(file);
      if (file.type === 'image/jpeg') return pdfDoc.embedJpg(arrayBuffer);
      if (file.type === 'image/png') return pdfDoc.embedPng(arrayBuffer);
      throw new Error(`Unsupported image type: ${file.type}`);
    })();

    imageCache.set(file, promise);
    return promise;
  };

  for (const layout of pages) {
    const page = pdfDoc.addPage([
      layout.width > 0 ? layout.width : 595.28,
      layout.height > 0 ? layout.height : 841.89,
    ]);
    const { width: pageWidth, height: pageHeight } = page.getSize();

    for (const element of layout.elements) {
      const image = await loadEmbeddedImage(element.file);
      const pdfX = element.x * pageWidth;
      const pdfY = pageHeight - element.y * pageHeight;
      const pdfW = element.width * pageWidth;
      const pdfH = element.height * pageHeight;

      page.drawImage(image, {
        x: pdfX,
        y: pdfY - pdfH,
        width: pdfW,
        height: pdfH,
      });
    }
  }

  return pdfDoc.save();
};

/** One page per file, which is the Android tool's `pagesPerSplit=1` default. */
export const splitPDF = async (file: File, signal?: AbortSignal): Promise<SplitResult> =>
  splitPDFByPagesPerFile(file, 1, [], undefined, signal);

export interface SplitResult {
  blob: Blob;
  /** True when more than one part was produced and the parts had to be zipped to be delivered. */
  isArchive: boolean;
  partCount: number;
}

/**
 * `SplitPdfToolProcessor` in the Android app.
 *
 * A split that yields a single part is a single PDF on both surfaces — the app writes one file
 * instead of a folder, so handing back a one-entry zip here would make the same request produce a
 * different kind of result depending on which surface ran it. Multi-part names follow the app's
 * `part_<n>_<pageLabel>.pdf`.
 */
export const splitPDFByPagesPerFile = async (
  file: File,
  pagesPerFile: number,
  selectedPageIndices: number[] = [],
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<SplitResult> => {
  await pdfJobCheckpoint(signal);
  const sanitizedPagesPerFile = Math.max(1, Math.floor(pagesPerFile || 1));
  const arrayBuffer = await readFileAsArrayBuffer(file);
  throwIfPdfJobAborted(signal);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  throwIfPdfJobAborted(signal);
  const totalPages = pdfDoc.getPageCount();
  if (totalPages === 0) {
    throw new Error(NO_PAGES_MESSAGE);
  }

  const exportIndices = resolveOptionalPageSelection(
    selectedPageIndices.map((index) => index + 1),
    totalPages,
    'Pages to split',
  );
  const totalParts = Math.ceil(exportIndices.length / sanitizedPagesPerFile);

  if (totalParts <= 1) {
    const singlePdf = await PDFDocument.create();
    const copiedPages = await copyPagesWithForms(singlePdf, pdfDoc, exportIndices);
    await pdfJobCheckpoint(signal, true);
    for (let index = 0; index < copiedPages.length; index += 1) {
      throwIfPdfJobAborted(signal);
      const page = copiedPages[index];
      onProgress?.(index + 1, exportIndices.length);
      singlePdf.addPage(page);
      if ((index + 1) % 8 === 0) await pdfJobCheckpoint(signal, true);
    }
    await pdfJobCheckpoint(signal, true);
    removeUnusedPdfObjects(singlePdf);
    const bytes = await singlePdf.save();
    await pdfJobCheckpoint(signal, true);
    return {
      blob: new Blob([bytes], { type: 'application/pdf' }),
      isArchive: false,
      partCount: 1,
    };
  }

  const zip = new JSZip();
  for (let startIndex = 0; startIndex < exportIndices.length; startIndex += sanitizedPagesPerFile) {
    await pdfJobCheckpoint(signal, true);
    const chunk = exportIndices.slice(startIndex, startIndex + sanitizedPagesPerFile);
    const partNumber = Math.floor(startIndex / sanitizedPagesPerFile) + 1;
    onProgress?.(partNumber, totalParts);
    const partPdf = await PDFDocument.create();
    const copiedPages = await copyPagesWithForms(partPdf, pdfDoc, chunk);
    throwIfPdfJobAborted(signal);
    copiedPages.forEach((page) => partPdf.addPage(page));
    removeUnusedPdfObjects(partPdf);
    const partBytes = await partPdf.save();
    throwIfPdfJobAborted(signal);
    zip.file(`part_${partNumber}_${buildPageExportLabel(chunk)}.pdf`, partBytes);
  }

  await pdfJobCheckpoint(signal, true);
  const archive = await zip.generateAsync({ type: 'blob' });
  await pdfJobCheckpoint(signal, true);
  return {
    blob: archive,
    isArchive: true,
    partCount: totalParts,
  };
};

/** Greedy, measured split matching Android's maximum-size mode. Every candidate PDF is actually
 * serialized before it is accepted, so the limit is based on output bytes rather than a page-count
 * guess. A page that exceeds the limit on its own is refused with a recovery instruction. */
export const splitPDFByMaximumSize = async (
  file: File,
  maximumSizeMb: number,
  selectedPageIndices: number[] = [],
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<SplitResult> => {
  await pdfJobCheckpoint(signal);
  const maximumBytes = Math.floor(maximumSizeMb * 1024 * 1024);
  if (!Number.isFinite(maximumBytes) || maximumBytes < 1024 * 1024) {
    throw new Error('Maximum split size must be at least 1 MB.');
  }

  const sourceBytes = await readFileAsArrayBuffer(file);
  throwIfPdfJobAborted(signal);
  const source = await PDFDocument.load(sourceBytes);
  throwIfPdfJobAborted(signal);
  const totalPages = source.getPageCount();
  if (!totalPages) throw new Error(NO_PAGES_MESSAGE);
  const indices = resolveOptionalPageSelection(
    selectedPageIndices.map((index) => index + 1),
    totalPages,
    'Pages to split',
  );

  const serialize = async (chunk: number[]) => {
    throwIfPdfJobAborted(signal);
    const candidate = await PDFDocument.create();
    const pages = await copyPagesWithForms(candidate, source, chunk);
    throwIfPdfJobAborted(signal);
    pages.forEach((page) => candidate.addPage(page));
    removeUnusedPdfObjects(candidate);
    const bytes = await candidate.save();
    throwIfPdfJobAborted(signal);
    return bytes;
  };

  const parts: Array<{ indices: number[]; bytes: Uint8Array }> = [];
  let current: number[] = [];
  let currentBytes: Uint8Array | null = null;
  for (let position = 0; position < indices.length; position += 1) {
    await pdfJobCheckpoint(signal, true);
    const pageIndex = indices[position];
    const candidateIndices = [...current, pageIndex];
    const candidateBytes = await serialize(candidateIndices);
    if (candidateBytes.byteLength <= maximumBytes) {
      current = candidateIndices;
      currentBytes = candidateBytes;
    } else if (current.length) {
      parts.push({ indices: current, bytes: currentBytes ?? await serialize(current) });
      const singleBytes = await serialize([pageIndex]);
      if (singleBytes.byteLength > maximumBytes) {
        throw new Error(`Page ${pageIndex + 1} exceeds the ${maximumSizeMb} MB limit on its own. Compress first, then split again.`);
      }
      current = [pageIndex];
      currentBytes = singleBytes;
    } else {
      throw new Error(`Page ${pageIndex + 1} exceeds the ${maximumSizeMb} MB limit on its own. Compress first, then split again.`);
    }
    onProgress?.(position + 1, indices.length);
  }
  if (current.length) parts.push({ indices: current, bytes: currentBytes ?? await serialize(current) });

  await pdfJobCheckpoint(signal, true);
  if (parts.length === 1) {
    return { blob: new Blob([parts[0].bytes], { type: 'application/pdf' }), isArchive: false, partCount: 1 };
  }
  const zip = new JSZip();
  parts.forEach((part, index) => zip.file(`part_${index + 1}_${buildPageExportLabel(part.indices)}.pdf`, part.bytes));
  const archive = await zip.generateAsync({ type: 'blob' });
  await pdfJobCheckpoint(signal, true);
  return { blob: archive, isArchive: true, partCount: parts.length };
};

/**
 * `ExtractPagesToolProcessor`. Takes 0-based indices, and refuses an empty or out-of-range
 * selection with the app's wording instead of quietly producing a zero-page PDF.
 */
export const extractPages = async (
  file: File,
  pageIndices: number[],
  label = 'Pages to extract',
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  await pdfJobCheckpoint(signal);
  const arrayBuffer = await readFileAsArrayBuffer(file);
  throwIfPdfJobAborted(signal);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  throwIfPdfJobAborted(signal);
  const totalPages = pdfDoc.getPageCount();
  if (totalPages === 0) {
    throw new Error(NO_PAGES_MESSAGE);
  }

  const resolved = resolvePageSelection(pageIndices.map((index) => index + 1), totalPages, label);
  const newPdf = await PDFDocument.create();
  const copiedPages = await copyPagesWithForms(newPdf, pdfDoc, resolved);
  await pdfJobCheckpoint(signal, true);
  for (let index = 0; index < copiedPages.length; index += 1) {
    throwIfPdfJobAborted(signal);
    newPdf.addPage(copiedPages[index]);
    if ((index + 1) % 8 === 0) await pdfJobCheckpoint(signal, true);
  }
  await pdfJobCheckpoint(signal, true);
  removeUnusedPdfObjects(newPdf);
  const bytes = await newPdf.save();
  await pdfJobCheckpoint(signal, true);
  return bytes;
};

/**
 * `DeletePagesToolProcessor`. The app refuses to delete every page and refuses inputs over 128 MB,
 * both of which used to fall through here — deleting everything produced an empty document rather
 * than an explanation.
 */
export const deletePagesFromPDF = async (file: File, pageIndicesToDelete: number[]): Promise<Uint8Array> => {
  if (file.size > MAX_DELETE_PAGES_INPUT_BYTES) {
    throw new Error(DELETE_PAGES_TOO_LARGE_MESSAGE);
  }

  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const totalPages = pdfDoc.getPageCount();
  if (totalPages === 0) {
    throw new Error(NO_PAGES_MESSAGE);
  }

  const deleteIndices = resolvePageSelection(
    pageIndicesToDelete.map((index) => index + 1),
    totalPages,
    'Pages to delete',
  );
  if (deleteIndices.length >= totalPages) {
    throw new Error(DELETE_ALL_PAGES_MESSAGE);
  }

  const keptIndices = remainingPageIndices(totalPages, new Set(deleteIndices));
  const newPdf = await PDFDocument.create();
  const copiedPages = await copyPagesWithForms(newPdf, pdfDoc, keptIndices);
  copiedPages.forEach((page) => newPdf.addPage(page));
  removeUnusedPdfObjects(newPdf);
  return newPdf.save();
};

/**
 * `ReorderPagesToolProcessor`. Takes 0-based indices and requires a complete permutation, so a
 * dropped or duplicated page is reported rather than silently written out.
 */
export const reorderPDFPages = async (file: File, pageOrderIndices: number[]): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const totalPages = pdfDoc.getPageCount();
  if (totalPages === 0) {
    throw new Error(NO_PAGES_MESSAGE);
  }

  const order = resolvePageOrder(pageOrderIndices.map((index) => index + 1), totalPages);
  const newPdf = await PDFDocument.create();
  const copiedPages = await copyPagesWithForms(newPdf, pdfDoc, order);
  copiedPages.forEach((page) => newPdf.addPage(page));
  removeUnusedPdfObjects(newPdf);
  return newPdf.save();
};

/**
 * `RotatePagesToolProcessor` in the Android app.
 *
 * Quarter turns are written as `/Rotate`, which costs nothing and keeps the page byte-identical.
 * Any other angle has to be redrawn, and is redrawn shrunk by `pageRotationFitScale` so the
 * corners stay on the sheet. The app rasterizes at that point; embedding the page as a form
 * XObject keeps the text selectable, which is strictly better and produces the same geometry.
 *
 * `rotations` carries 0-based page indices and degrees relative to the page's current orientation.
 */
export const rotateSpecificPages = async (
  file: File,
  rotations: { pageIndex: number; rotation: number }[],
  onProgress?: (current: number, total: number) => void,
): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const sourcePdf = await PDFDocument.load(arrayBuffer);
  const totalPages = sourcePdf.getPageCount();
  if (totalPages === 0) {
    throw new Error(NO_PAGES_MESSAGE);
  }

  const requested = new Map<number, number>();
  rotations.forEach(({ pageIndex, rotation }) => {
    if (pageIndex < 0 || pageIndex >= totalPages) return;
    const sanitized = sanitizePageRotationDegrees(rotation);
    if (sanitized !== 0) requested.set(pageIndex, sanitized);
  });

  const allQuarterTurns = [...requested.values()].every(
    (degreesValue) => pageRotationMetadataDegreesOrNull(degreesValue) !== null,
  );

  if (allQuarterTurns) {
    const pages = sourcePdf.getPages();
    let completed = 0;
    [...requested.entries()]
      .sort(([left], [right]) => left - right)
      .forEach(([pageIndex, degreesValue]) => {
        completed += 1;
        onProgress?.(completed, requested.size);
        const page = pages[pageIndex];
        const current = ((page.getRotation().angle % 360) + 360) % 360;
        const metadataDegrees = pageRotationMetadataDegreesOrNull(degreesValue) ?? 0;
        page.setRotation(degrees((current + metadataDegrees) % 360));
      });
    return sourcePdf.save();
  }

  const outputPdf = await PDFDocument.create();
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    onProgress?.(pageIndex + 1, totalPages);
    const requestedDegrees = requested.get(pageIndex) ?? 0;
    const metadataDegrees = pageRotationMetadataDegreesOrNull(requestedDegrees);

    if (metadataDegrees !== null) {
      const [copied] = await outputPdf.copyPages(sourcePdf, [pageIndex]);
      const current = ((copied.getRotation().angle % 360) + 360) % 360;
      copied.setRotation(degrees((current + metadataDegrees) % 360));
      outputPdf.addPage(copied);
      continue;
    }

    // A free angle is applied to the page's *visual* orientation, so any existing `/Rotate` is
    // folded into the total and dropped from the output rather than being applied twice.
    const sourcePage = sourcePdf.getPage(pageIndex);
    const { width, height } = sourcePage.getSize();
    const existingRotation = ((sourcePage.getRotation().angle % 360) + 360) % 360;
    const totalRotation = sanitizePageRotationDegrees(existingRotation + requestedDegrees);
    const fitScale = pageRotationFitScale(width, height, totalRotation);
    const drawnWidth = width * fitScale;
    const drawnHeight = height * fitScale;
    const origin = rotatedBoxOrigin(width / 2, height / 2, drawnWidth, drawnHeight, totalRotation);

    const embedded = await outputPdf.embedPage(sourcePage);
    const outputPage = outputPdf.addPage([width, height]);
    outputPage.drawPage(embedded, {
      x: origin.x,
      y: origin.y,
      width: drawnWidth,
      height: drawnHeight,
      rotate: degrees(totalRotation),
    });
  }

  return outputPdf.save();
};

/** Every page by the same amount, which is the app's `degrees=<n>` option with no `pages=` token. */
export const rotatePDF = async (file: File, rotation: number): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pageCount = (await PDFDocument.load(arrayBuffer)).getPageCount();
  return rotateSpecificPages(
    file,
    Array.from({ length: pageCount }, (_, pageIndex) => ({ pageIndex, rotation })),
  );
};

export const protectPDF = async (file: File, password: string): Promise<Uint8Array> => {
  const exactPassword = password;
  if (!exactPassword || !/\S/.test(exactPassword)) {
    throw new Error(PASSWORD_REQUIRED_MESSAGE);
  }
  // The Android processor enforces the same floor, so a 3-character password is rejected on both
  // surfaces rather than producing a file whose protection is theatre.
  if (exactPassword.length < MIN_PROTECT_PASSWORD_LENGTH) {
    throw new Error(PASSWORD_TOO_SHORT_MESSAGE);
  }

  const input = new Uint8Array(await readFileAsArrayBuffer(file));
  return encryptPdfWithAes128(input, exactPassword);
};

export const getPDFMetadata = async (file: File): Promise<PDFMetadata> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer, { updateMetadata: false });
  return {
    title: pdfDoc.getTitle(),
    author: pdfDoc.getAuthor(),
    subject: pdfDoc.getSubject(),
    keywords: pdfDoc.getKeywords(),
    creator: pdfDoc.getCreator(),
    producer: pdfDoc.getProducer(),
    creationDate: pdfDoc.getCreationDate(),
    modificationDate: pdfDoc.getModificationDate(),
  };
};

/**
 * `MetadataPdfToolProcessor` plus `parseMetadataUpdateOptions`/`MetadataUpdateOptions.asMap`.
 *
 * Undefined fields are unchanged; explicitly empty fields are cleared. Clearing all six can
 * be followed by new values, so editing one box after Clear does not restore old properties.
 */
export const setPDFMetadata = async (
  file: File,
  metadata: PDFMetadata,
  options?: { clearAll?: boolean },
): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer, { updateMetadata: false });

  if (options?.clearAll) {
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setCreator('');
    pdfDoc.setProducer('');
  }

  const write = (value: string | undefined, apply: (sanitized: string) => void) => {
    if (value === undefined) return;
    const sanitized = sanitizePdfText(value);
    apply(sanitized);
  };

  write(metadata.title, (value) => pdfDoc.setTitle(value));
  write(metadata.author, (value) => pdfDoc.setAuthor(value));
  write(metadata.subject, (value) => pdfDoc.setSubject(value));
  // The app stores the keywords string verbatim; pdf-lib joins the array with a space, so a
  // single-element array round-trips the same text instead of re-splitting the user's phrasing.
  write(metadata.keywords, (value) => pdfDoc.setKeywords([value]));
  write(metadata.creator, (value) => pdfDoc.setCreator(value));
  write(metadata.producer, (value) => pdfDoc.setProducer(value));

  if (metadata.creationDate !== undefined) pdfDoc.setCreationDate(metadata.creationDate);
  if (metadata.modificationDate !== undefined) pdfDoc.setModificationDate(metadata.modificationDate);
  return pdfDoc.save();
};

export const getPDFPageCount = async (file: File): Promise<number> => {
  const cached = pageCountCache.get(file);
  if (cached) return cached;

  const next = (async () => {
    try {
      const arrayBuffer = await readFileAsArrayBuffer(file);
      const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
      return pdfDoc.getPageCount();
    } catch (error) {
      console.error('Error counting pages', error);
      return 0;
    }
  })();

  pageCountCache.set(file, next);
  return next;
};

/**
 * `FlattenPdfToolProcessor`. The app calls `documentCatalog?.acroForm?.flatten()`, so a PDF with no
 * form is re-saved untouched instead of failing; pdf-lib's `getForm()` synthesises an empty form
 * whose `flatten()` can still throw on unsupported widgets, so that case degrades the same way.
 */
export const flattenPDF = async (file: File): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  if (pdfDoc.getPageCount() === 0) {
    throw new Error(NO_PAGES_MESSAGE);
  }

  const hasAcroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm')) !== undefined;
  if (hasAcroForm) {
    pdfDoc.getForm().flatten();
  }

  return pdfDoc.save();
};

export const repairPDF = async (file: File): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  if (pdfDoc.getPageCount() === 0) throw new Error(NO_PAGES_MESSAGE);
  return pdfDoc.save({ useObjectStreams: false });
};

const clearPDFMetadataAndCatalogActions = (pdfDoc: PDFDocument) => {
  pdfDoc.setTitle('');
  pdfDoc.setAuthor('');
  pdfDoc.setSubject('');
  pdfDoc.setKeywords([]);
  pdfDoc.setCreator('');
  pdfDoc.setProducer('');
  const info = pdfDoc.context.lookup(pdfDoc.context.trailerInfo.Info, PDFDict);
  info.delete(PDFName.of('CreationDate'));
  info.delete(PDFName.of('ModDate'));

  const catalog = pdfDoc.catalog;
  catalog.delete(PDFName.of('Metadata'));
  catalog.delete(PDFName.of('ViewerPreferences'));
  catalog.delete(PDFName.of('OpenAction'));
  catalog.delete(PDFName.of('AA'));
  // XMP can belong to a page or an image/form XObject as well as the catalog.
  // Check the target type so an ordinary resource named "Metadata" is preserved.
  for (const [, object] of pdfDoc.context.enumerateIndirectObjects()) {
    const dictionary = object instanceof PDFStream ? object.dict : object;
    if (!(dictionary instanceof PDFDict)) continue;
    const metadata = pdfDoc.context.lookup(dictionary.get(PDFName.of('Metadata')));
    if (metadata instanceof PDFStream && (
      metadata.dict.lookup(PDFName.of('Type')) === PDFName.of('Metadata') ||
      metadata.dict.lookup(PDFName.of('Subtype')) === PDFName.of('XML')
    )) dictionary.delete(PDFName.of('Metadata'));
  }
};

const removeCommentAnnotations = (pdfDoc: PDFDocument) => {
  for (const page of pdfDoc.getPages()) {
    const annotations = page.node.Annots();
    if (annotations) {
      for (let index = annotations.size() - 1; index >= 0; index -= 1) {
        const annotation = annotations.lookup(index, PDFDict);
        if (annotation.lookup(PDFName.of('Subtype')) !== PDFName.of('Widget')) annotations.remove(index);
      }
    }
    page.node.delete(PDFName.of('AA'));
  }
};

/** pdf-lib otherwise serializes detached objects, leaving removed private data recoverable. */
const removeUnusedPdfObjects = (pdfDoc: PDFDocument) => {
  const pending: unknown[] = Object.values(pdfDoc.context.trailerInfo);
  const visited = new Set<unknown>();
  const referenced = new Set<string>();
  while (pending.length) {
    const object = pending.pop();
    if (!object || visited.has(object)) continue;
    visited.add(object);
    if (object instanceof PDFRef) {
      referenced.add(object.toString());
      pending.push(pdfDoc.context.lookup(object));
    } else if (object instanceof PDFDict) {
      pending.push(...object.values());
    } else if (object instanceof PDFArray) {
      pending.push(...object.asArray());
    } else if (object instanceof PDFStream) {
      pending.push(object.dict);
    }
  }
  for (const [reference] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!referenced.has(reference.toString())) pdfDoc.context.delete(reference);
  }
};

export const removePDFMetadata = async (file: File): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer, { updateMetadata: false });
  clearPDFMetadataAndCatalogActions(pdfDoc);
  removeUnusedPdfObjects(pdfDoc);
  return pdfDoc.save();
};

export const removePDFAnnotations = async (file: File): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer, { updateMetadata: false });
  removeCommentAnnotations(pdfDoc);
  removeUnusedPdfObjects(pdfDoc);
  return pdfDoc.save();
};

export const sanitizePDF = async (file: File): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer, {
    updateMetadata: false,
  });

  removeCommentAnnotations(pdfDoc);

  // Loading a saved intermediate document makes pdf-lib stamp a new Producer/ModDate. Clear
  // metadata after every structural mutation and save once so sanitize stays metadata-free.
  clearPDFMetadataAndCatalogActions(pdfDoc);
  removeUnusedPdfObjects(pdfDoc);

  return pdfDoc.save();
};

export interface CropBoxOptions {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const normalizeCropMargin = (value: number) => Math.max(0, Math.min(40, Number.isFinite(value) ? value : 0));

export const cropPDFMargins = async (file: File, options: CropBoxOptions): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const margins = {
    top: normalizeCropMargin(options.top),
    right: normalizeCropMargin(options.right),
    bottom: normalizeCropMargin(options.bottom),
    left: normalizeCropMargin(options.left),
  };

  for (const page of pdfDoc.getPages()) {
    // Trim what is currently visible, not the sheet it was cut from.
    //
    // getSize() reports the MediaBox and drops its origin, so cropping twice
    // used to throw the first crop away — a 20% trim followed by a 5% nudge
    // came back BIGGER than the 20% — and any page whose MediaBox does not
    // start at 0,0 (common from imposition and scanner software) was trimmed
    // against the wrong corner.
    const box = page.getCropBox();
    // The controls name visible edges; a clockwise quarter turn maps visible top to PDF left.
    const edges = [margins.top, margins.right, margins.bottom, margins.left];
    const turns = normalizePageRotation(page.getRotation().angle) / 90;
    const [topMargin, rightMargin, bottomMargin, leftMargin] = edges.map((_, index) => edges[(index + turns) % 4]);
    const left = box.width * (leftMargin / 100);
    const bottom = box.height * (bottomMargin / 100);
    const right = box.width * (rightMargin / 100);
    const top = box.height * (topMargin / 100);
    // Each margin is bounded to 40%, so at least 20% always remains.
    const cropWidth = box.width - left - right;
    const cropHeight = box.height - top - bottom;

    page.setCropBox(box.x + left, box.y + bottom, cropWidth, cropHeight);
  }

  return pdfDoc.save();
};

export interface HeaderFooterOptions {
  headerText: string;
  footerText: string;
  fontSize: number;
  includePageNumbers: boolean;
}

const interpolateHeaderFooterText = (value: string, pageNumber: number, totalPages: number) =>
  value.replaceAll('{n}', String(pageNumber)).replaceAll('{total}', String(totalPages));

export const addHeaderFooterToPDF = async (file: File, options: HeaderFooterOptions): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  const fontSize = Math.max(8, Math.min(48, Number.isFinite(options.fontSize) ? options.fontSize : 10));
  const totalPages = pages.length;

  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    const geometry = getPdfPageVisualGeometry(page);
    const { width, height } = getVisualPageSize(geometry);
    const header = interpolateHeaderFooterText(options.headerText.trim(), pageNumber, totalPages);
    const footerBase = options.footerText.trim();
    const footer = interpolateHeaderFooterText(
      options.includePageNumbers && !footerBase ? 'Page {n} of {total}' : footerBase,
      pageNumber,
      totalPages,
    );

    if (header) {
      const headerWidth = font.widthOfTextAtSize(header, fontSize);
      const origin = visualPointToPdf(geometry, Math.max(24, (width - headerWidth) / 2), fontSize + 18);
      page.drawText(header, {
        x: origin.x,
        y: origin.y,
        rotate: degrees(geometry.rotation),
        size: fontSize,
        font,
        color: rgb(0.25, 0.25, 0.25),
      });
    }

    if (footer) {
      const footerWidth = font.widthOfTextAtSize(footer, fontSize);
      const origin = visualPointToPdf(geometry, Math.max(24, (width - footerWidth) / 2), height - 18);
      page.drawText(footer, {
        x: origin.x,
        y: origin.y,
        rotate: degrees(geometry.rotation),
        size: fontSize,
        font,
        color: rgb(0.25, 0.25, 0.25),
      });
    }
  });

  return pdfDoc.save();
};

const isPageBlank = async (pdfDoc: any, pageIndex: number, threshold: number) => {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 0.18 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Canvas context failed');
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let nonWhite = 0;
  const maxDelta = 28;

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 20) continue;
    const delta = 255 - Math.min(pixels[index], pixels[index + 1], pixels[index + 2]);
    if (delta > maxDelta) {
      nonWhite += 1;
    }
  }

  return nonWhite / Math.max(1, pixels.length / 4) <= threshold;
};

export const removeBlankPagesFromPDF = async (
  file: File,
  options?: { threshold?: number; onProgress?: (current: number, total: number) => void },
): Promise<{ bytes: Uint8Array; removedPages: number[] }> => {
  const sourceBuffer = await readFileAsArrayBuffer(file);
  const sourcePdf = await PDFDocument.load(sourceBuffer);
  const renderedPdf = await loadPDFDocument(file);
  const totalPages = sourcePdf.getPageCount();
  const threshold = Math.max(0.0001, Math.min(0.02, options?.threshold ?? 0.002));
  const keptIndices: number[] = [];
  const removedPages: number[] = [];

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    options?.onProgress?.(pageIndex + 1, totalPages);
    const blank = await isPageBlank(renderedPdf, pageIndex, threshold);
    if (blank) {
      removedPages.push(pageIndex + 1);
    } else {
      keptIndices.push(pageIndex);
    }
  }

  if (keptIndices.length === 0) {
    throw new Error('All pages look blank. No output was created.');
  }

  const outputPdf = await PDFDocument.create();
  const copiedPages = await copyPagesWithForms(outputPdf, sourcePdf, keptIndices);
  copiedPages.forEach((page) => outputPdf.addPage(page));
  removeUnusedPdfObjects(outputPdf);

  return {
    bytes: await outputPdf.save(),
    removedPages,
  };
};

export const unlockPDF = async (file: File, password: string): Promise<Uint8Array> => {
  const exactPassword = password;
  if (!exactPassword) {
    throw new Error(UNLOCK_PASSWORD_REQUIRED_MESSAGE);
  }

  const input = new Uint8Array(await readFileAsArrayBuffer(file));
  return decryptPdf(input, exactPassword).catch(() => {
    throw new Error(UNLOCK_FAILED_MESSAGE);
  });
};

export interface EditorElement {
  id: string;
  type: 'text' | 'image' | 'rectangle' | 'ellipse' | 'line' | 'arrow';
  pageIndex: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  content: string;
  fontSize?: number;
  color?: string;
  fillColor?: string;
  strokeWidth?: number;
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
}

/**
 * A paragraph edit that the original PDF text objects can express exactly. Nothing is painted
 * over: the document's own fonts keep drawing the text, so it stays selectable and searchable.
 */
export interface ParagraphDirectEdit {
  mode: 'direct';
  pageIndex: number;
  runEdits: Array<{
    sourceText: string;
    sourcePdfRect: PdfSpaceRect;
    replacementText: string;
  }>;
}

/**
 * A paragraph edit that changed shape — a new line, a removed line break, or text that outgrew
 * the space it had. The paragraph is redrawn, re-embedding the document's own font program when
 * one is available.
 *
 * `runDeletions` removes the original text objects first. That is what keeps the result honest:
 * without it the old words survive underneath the redraw, so the file still searches and copies as
 * the text that is no longer on the page. It also lets a flat background be filled with a vector
 * rectangle instead of a raster patch, because there is nothing left to hide.
 */
export interface ParagraphReflowEdit {
  mode: 'reflow';
  pageIndex: number;
  /** Paragraph box as fractions of the visual page. */
  x: number;
  y: number;
  width: number;
  height: number;
  runDeletions: Array<{ sourceText: string; sourcePdfRect: PdfSpaceRect }>;
  /** Raster re-render of the area, used only when the paragraph does not sit on a flat colour. */
  backgroundImage?: string;
  backgroundColor: string;
  /** True when the area is a single colour, so a vector fill reproduces it exactly. */
  backgroundFlat: boolean;
  /**
   * The explicit paragraph rows, one entry per line, each a list of stretches with the face they are
   * drawn in. A paragraph that opens with a bold lead-in stays that way through the redraw.
   */
  lines: Array<Array<{ text: string; face: ParagraphFace }>>;
  /** Original PDF origins, relative to the paragraph box, shared with the editing preview. */
  lineOrigins?: Array<{ x?: number; y: number }>;
  fontSize: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right' | 'justify';
  color: string;
}

/**
 * One typeface a redrawn paragraph needs.
 *
 * Always one of the standard faces. The document's own program is deliberately not re-embedded:
 * what PDF.js exposes is a transcoded copy built for the browser, not the file's original font,
 * and drawing Unicode text through it produced wrong advances and unreachable spaces — text ran
 * off the page and characters were lost. A metric-compatible standard face is a visible change,
 * which the editor states, rather than a silent one.
 */
export interface ParagraphFace {
  /** Stable key so the same face is embedded once per document. */
  key: string;
  family: 'Helvetica' | 'TimesRoman' | 'Courier';
  bold: boolean;
  italic: boolean;
}

export type ParagraphSaveEdit = ParagraphDirectEdit | ParagraphReflowEdit;

/** Shown when a document's own permissions forbid writing it back. */
export const PDF_EDIT_PERMISSION_MESSAGE = 'This PDF is password-protected against changes, so it cannot be saved. Remove the password with the Unlock PDF tool first.';

export const savePDFWithAnnotations = async (
  file: File,
  elements: EditorElement[],
  formValues: Record<string, PdfFormFieldValue> = {},
  paragraphEdits: ParagraphSaveEdit[] = [],
): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const directParagraphEdits = paragraphEdits.filter(
    (edit): edit is ParagraphDirectEdit => edit.mode === 'direct',
  );
  const reflowParagraphEdits = paragraphEdits.filter(
    (edit): edit is ParagraphReflowEdit => edit.mode === 'reflow',
  );
  let sourceBytes = new Uint8Array(arrayBuffer);
  const nativeEdits = [
    ...directParagraphEdits.flatMap((edit) => edit.runEdits.map((run) => ({
      pageIndex: edit.pageIndex,
      sourceText: run.sourceText,
      replacementText: run.replacementText,
      pdfRect: run.sourcePdfRect,
      // A paragraph edit rewrites whole source runs, so the run and the target are the same span.
      sourceRun: {
        text: run.sourceText,
        start: 0,
        end: run.sourceText.length,
        pdfRect: run.sourcePdfRect,
      },
    }))),
  ];
  // A redrawn paragraph's originals come out by area rather than by matching their text. The words
  // are about to be painted over, so what has to leave the file is whatever the PDF drew inside
  // those rectangles — a question geometry answers even for documents that set each glyph as its
  // own text object, which is where asking the engine to find a matching word used to give up.
  // One area per paragraph, not per run. A single run's rectangle is the box PDF.js reports for
  // that run's advance, and a glyph's real ink routinely reaches past it — an ascender, a descender,
  // an italic overhang. Measured against the whole paragraph those overshoots are interior, so the
  // objects that belong to it are recognised while a line running on past the paragraph still is
  // not.
  const clearances = reflowParagraphEdits.flatMap((edit) => {
    const rects = edit.runDeletions.map((run) => run.sourcePdfRect);
    if (rects.length === 0) return [];
    // A run's rectangle is measured from its baseline upwards, so every descender in the paragraph
    // hangs below it. Without room for them a line ending in "g" or "y" reads as reaching outside
    // the paragraph and is left in the file. One third of a line is the usual depth of a descender
    // and stays well clear of the next paragraph's ink.
    const lineHeight = Math.max(...rects.map((rect) => Math.abs(rect[3] - rect[1])));
    const descender = Math.max(1, lineHeight * 0.34);
    return [{
      pageIndex: edit.pageIndex,
      pdfRect: [
        Math.min(...rects.map((rect) => Math.min(rect[0], rect[2]))),
        Math.min(...rects.map((rect) => Math.min(rect[1], rect[3]))) - descender,
        Math.max(...rects.map((rect) => Math.max(rect[0], rect[2]))),
        Math.max(...rects.map((rect) => Math.max(rect[1], rect[3]))),
      ] as PdfSpaceRect,
    }];
  });
  if (nativeEdits.length > 0 || clearances.length > 0) {
    const {
      applyNativePdfTextEdits,
      clearNativePdfTextInAreas,
      releaseNativePdfTextDocument,
    } = await import('./pdfNativeTextEditor');
    await releaseNativePdfTextDocument(file);
    if (nativeEdits.length > 0) {
      sourceBytes = await applyNativePdfTextEdits(sourceBytes, nativeEdits);
    }
    if (clearances.length > 0) {
      const cleared = await clearNativePdfTextInAreas(sourceBytes, clearances);
      sourceBytes = cleared.bytes;
      if (cleared.uncleared > 0) {
        // Text that reaches outside the repainted area is left where it is, so say so rather than
        // letting the save claim the paragraph's originals are gone.
        throw new Error('Direct text edit failed: some original text crossed the paragraph edge and could not be removed.');
      }
    }
  }
  // A file whose only change is a set of in-place text rewrites is already finished: reloading it
  // through pdf-lib would rewrite objects the direct edit deliberately left alone.
  const containsOnlyDirectText = nativeEdits.length > 0
    && reflowParagraphEdits.length === 0
    && elements.length === 0
    && Object.keys(formValues).length === 0;
  if (containsOnlyDirectText) return sourceBytes;
  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(sourceBytes);
  } catch (error) {
    // A PDF can carry an owner password that permits reading but forbids changes. It opens and
    // edits perfectly well on screen and then cannot be written, so the reason has to be named
    // here rather than reported as an unexplained failure.
    if (/encrypted/i.test(error instanceof Error ? error.message : '')) {
      throw new Error(PDF_EDIT_PERMISSION_MESSAGE);
    }
    throw error;
  }
  const pages = pdfDoc.getPages();
  const fonts = {
    Helvetica: await pdfDoc.embedFont(StandardFonts.Helvetica),
    HelveticaBold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    HelveticaOblique: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
    HelveticaBoldOblique: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
    TimesRoman: await pdfDoc.embedFont(StandardFonts.TimesRoman),
    TimesRomanBold: await pdfDoc.embedFont(StandardFonts.TimesRomanBold),
    TimesRomanItalic: await pdfDoc.embedFont(StandardFonts.TimesRomanItalic),
    TimesRomanBoldItalic: await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic),
    Courier: await pdfDoc.embedFont(StandardFonts.Courier),
    CourierBold: await pdfDoc.embedFont(StandardFonts.CourierBold),
    CourierOblique: await pdfDoc.embedFont(StandardFonts.CourierOblique),
    CourierBoldOblique: await pdfDoc.embedFont(StandardFonts.CourierBoldOblique),
  };

  const hexToRgb = (hex: string) => {
    const normalized = hex.trim().replace('#', '');
    const full = normalized.length === 3
      ? normalized.split('').map((char) => `${char}${char}`).join('')
      : normalized;

    if (!/^[0-9a-fA-F]{6}$/.test(full)) {
      return rgb(0, 0, 0);
    }

    return rgb(
      parseInt(full.slice(0, 2), 16) / 255,
      parseInt(full.slice(2, 4), 16) / 255,
      parseInt(full.slice(4, 6), 16) / 255,
    );
  };

  const form = pdfDoc.getForm();
  const fieldsByName = new Map(form.getFields().map((field) => [field.getName(), field]));

  for (const [fieldName, value] of Object.entries(formValues)) {
    const field = fieldsByName.get(fieldName);
    if (!field) continue;

    try {
      if (field instanceof PDFTextField) {
        field.setText(typeof value === 'string' ? value : '');
        continue;
      }

      if (field instanceof PDFCheckBox) {
        value ? field.check() : field.uncheck();
        continue;
      }

      if (field instanceof PDFRadioGroup) {
        if (typeof value === 'string' && value) field.select(value);
        else field.clear();
        continue;
      }

      if (field instanceof PDFDropdown) {
        if (Array.isArray(value)) {
          if (value.length > 0) field.select(field.isMultiselect() ? value : value[0]);
          else field.clear();
        } else if (typeof value === 'string' && value) {
          field.select(value);
        } else {
          field.clear();
        }
        continue;
      }

      if (field instanceof PDFOptionList) {
        if (Array.isArray(value)) {
          if (value.length > 0) field.select(value);
          else field.clear();
        } else if (typeof value === 'string' && value) {
          field.select(value);
        } else {
          field.clear();
        }
      }
    } catch (error) {
      console.warn(`Failed to set form field "${fieldName}"`, error);
    }
  }

  try {
    form.updateFieldAppearances(fonts.Helvetica);
  } catch (error) {
    // Some valid third-party forms omit /DA on one field. Preserve the document and the values we
    // could set instead of refusing every edit because one pre-existing appearance is malformed.
    console.warn('Some existing form appearances could not be refreshed.', error);
  }

  const visualTextRuns: Array<{ pageIndex: number; text: string; x: number; y: number }> = [];
  if (reflowParagraphEdits.length > 0) {
    for (const edit of reflowParagraphEdits) {
      if (edit.pageIndex < 0 || edit.pageIndex >= pages.length) continue;
      const page = pages[edit.pageIndex];
      const cropBox = page.getCropBox();
      const geometry = {
        cropX: cropBox.x,
        cropY: cropBox.y,
        cropWidth: cropBox.width,
        cropHeight: cropBox.height,
        rotation: normalizePageRotation(page.getRotation().angle),
      };
      const visualSize = getVisualPageSize(geometry);
      const visualX = edit.x * visualSize.width;
      const visualY = edit.y * visualSize.height;
      const width = edit.width * visualSize.width;
      const height = edit.height * visualSize.height;

      // Successful text-object deletion already exposes the original background. Painting a
      // rectangle or image over it would hide or rasterise table rules and other vector artwork.
      if (edit.runDeletions.length === 0 && (edit.backgroundFlat || !edit.backgroundImage)) {
        // A uniform background reproduces exactly as a filled rectangle, so the page keeps its
        // vectors instead of gaining a resampled image of itself.
        const patch = visualRectangleToPdf(geometry, visualX, visualY, width, height);
        page.drawRectangle({ ...patch, color: hexToRgb(edit.backgroundColor) });
      } else if (edit.runDeletions.length === 0 && edit.backgroundImage) {
        const background = await pdfDoc.embedPng(edit.backgroundImage);
        const center = visualPointToPdf(geometry, visualX + width / 2, visualY + height / 2);
        const origin = rotatedBoxOrigin(center.x, center.y, width, height, geometry.rotation);
        page.drawImage(background, {
          x: origin.x,
          y: origin.y,
          width,
          height,
          rotate: degrees(geometry.rotation),
        });
      }

      const color = hexToRgb(edit.color);
      const positioned = layoutParagraphLines(edit.lines, {
        width,
        fontSize: edit.fontSize,
        lineHeight: edit.lineHeight,
        align: edit.align,
        lineOrigins: edit.lineOrigins,
      });
      for (const piece of positioned) {
        // Space advances are already in the layout; empty ink needs no PDF text object.
        if (!piece.text.trim()) continue;
        const point = visualPointToPdf(geometry, visualX + piece.x, visualY + piece.y);
        // Check the saved text only when the original objects were removed; overlapping old
        // objects can otherwise make PDF extraction report duplicates instead of the drawn text.
        if (edit.runDeletions.length > 0 && piece.text.trim()) {
          visualTextRuns.push({ pageIndex: edit.pageIndex, text: piece.text, x: point.x, y: point.y });
        }
        page.drawText(piece.text, {
          x: point.x,
          y: point.y,
          size: edit.fontSize,
          font: fonts[paragraphStandardFontKey(piece.face)],
          color,
          rotate: degrees(geometry.rotation),
        });
      }
    }
  }

  for (const element of elements) {
    if (element.pageIndex < 0 || element.pageIndex >= pages.length) continue;
    const page = pages[element.pageIndex];
    const cropBox = page.getCropBox();
    const geometry = {
      cropX: cropBox.x,
      cropY: cropBox.y,
      cropWidth: cropBox.width,
      cropHeight: cropBox.height,
      rotation: normalizePageRotation(page.getRotation().angle),
    };
    const visualSize = getVisualPageSize(geometry);
    const visualX = element.x * visualSize.width;
    const visualY = element.y * visualSize.height;

    if (element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'line' || element.type === 'arrow') {
      const width = Math.max(2, (element.width || 0.22) * visualSize.width);
      const height = Math.max(2, (element.height || 0.12) * visualSize.height);
      const borderColor = hexToRgb(element.color || '#2563eb');
      const fillColor = element.fillColor && element.fillColor !== 'transparent'
        ? hexToRgb(element.fillColor)
        : undefined;
      const borderWidth = Math.max(0.5, Math.min(16, element.strokeWidth || 2));

      if (element.type === 'rectangle') {
        const rotation = element.rotation || 0;
        const center = visualPointToPdf(
          geometry,
          visualX + width / 2,
          visualY + height / 2,
        );
        const origin = rotatedBoxOrigin(
          center.x,
          center.y,
          width,
          height,
          geometry.rotation + rotation,
        );
        page.drawRectangle({
          x: origin.x,
          y: origin.y,
          width,
          height,
          borderColor,
          borderWidth,
          color: fillColor,
          opacity: fillColor ? 0.22 : undefined,
          rotate: degrees(geometry.rotation + rotation),
        });
        continue;
      }

      if (element.type === 'ellipse') {
        const center = visualPointToPdf(
          geometry,
          visualX + width / 2,
          visualY + height / 2,
        );
        page.drawEllipse({
          x: center.x,
          y: center.y,
          xScale: width / 2,
          yScale: height / 2,
          borderColor,
          borderWidth,
          color: fillColor,
          opacity: fillColor ? 0.22 : undefined,
          rotate: degrees(geometry.rotation + (element.rotation || 0)),
        });
        continue;
      }

      const start = visualPointToPdf(geometry, visualX, visualY);
      const end = visualPointToPdf(geometry, visualX + width, visualY + height);
      page.drawLine({ start, end, thickness: borderWidth, color: borderColor });
      if (element.type === 'arrow') {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const headLength = Math.max(8, Math.min(24, width * 0.12));
        [Math.PI * 0.82, -Math.PI * 0.82].forEach((offset) => {
          page.drawLine({
            start: end,
            end: {
              x: end.x + Math.cos(angle + offset) * headLength,
              y: end.y + Math.sin(angle + offset) * headLength,
            },
            thickness: borderWidth,
            color: borderColor,
          });
        });
      }
      continue;
    }

    if (element.type === 'image') {
      try {
        const image = element.content.startsWith('data:image/png')
          ? await pdfDoc.embedPng(element.content)
          : await pdfDoc.embedJpg(element.content);
        const width = (element.width || 0.2) * visualSize.width;
        const height = (element.height || 0.2) * visualSize.height;
        const rotation = element.rotation || 0;
        const center = visualPointToPdf(
          geometry,
          visualX + width / 2,
          visualY + height / 2,
        );
        const origin = rotatedBoxOrigin(
          center.x,
          center.y,
          width,
          height,
          geometry.rotation + rotation,
        );

        page.drawImage(image, {
          x: origin.x,
          y: origin.y,
          width,
          height,
          rotate: degrees(geometry.rotation + rotation),
        });
      } catch (error) {
        console.warn('Failed to embed image', error);
      }
      continue;
    }

    const fontFamily = element.fontFamily === 'TimesRoman'
      ? 'TimesRoman'
      : element.fontFamily === 'Courier'
        ? 'Courier'
        : 'Helvetica';
    const isBold = (element.fontWeight ?? 400) >= 600;
    const isItalic = element.fontStyle === 'italic';
    const fontKey = fontFamily === 'TimesRoman'
      ? isBold && isItalic ? 'TimesRomanBoldItalic' : isBold ? 'TimesRomanBold' : isItalic ? 'TimesRomanItalic' : 'TimesRoman'
      : fontFamily === 'Courier'
        ? isBold && isItalic ? 'CourierBoldOblique' : isBold ? 'CourierBold' : isItalic ? 'CourierOblique' : 'Courier'
        : isBold && isItalic ? 'HelveticaBoldOblique' : isBold ? 'HelveticaBold' : isItalic ? 'HelveticaOblique' : 'Helvetica';
    const font = fonts[fontKey];
    const size = element.fontSize || 12;
    const lines = element.content.split('\n');
    const lineHeight = size * 1.2;
    const width = (element.width || 0.24) * visualSize.width;
    const height = (element.height || 0.07) * visualSize.height;
    const center = visualPointToPdf(
      geometry,
      visualX + width / 2,
      visualY + height / 2,
    );
    const rotation = element.rotation || 0;
    lines.forEach((line, index) => {
      const baseline = visualPointToPdf(
        geometry,
        visualX,
        visualY + size + index * lineHeight,
      );
      const origin = rotatePointAroundCenter(
        baseline.x,
        baseline.y,
        center.x,
        center.y,
        rotation,
      );
      page.drawText(line, {
        x: origin.x,
        y: origin.y,
        size,
        font,
        color: element.color ? hexToRgb(element.color) : rgb(0, 0, 0),
        rotate: degrees(geometry.rotation + rotation),
      });
    });
  }

  const output = await pdfDoc.save();
  if (visualTextRuns.length > 0) {
    const { verifyPdfTextRunsFitWithinPage } = await import('./pdfNativeTextEditor');
    await verifyPdfTextRunsFitWithinPage(output, visualTextRuns);
  }
  return output;
};

export interface SignaturePlacement {
  pageIndex: number;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  aspectRatio: number;
}

export const applySignaturesToPDF = async (file: File, signatures: SignaturePlacement[]) => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);

  for (const signature of signatures) {
    if (signature.pageIndex < 0 || signature.pageIndex >= pdfDoc.getPageCount()) continue;

    const image = signature.dataUrl.startsWith('data:image/png')
      ? await pdfDoc.embedPng(signature.dataUrl)
      : await pdfDoc.embedJpg(signature.dataUrl);

    const page = pdfDoc.getPage(signature.pageIndex);
    const geometry = getPdfPageVisualGeometry(page);
    const { width, height } = getVisualPageSize(geometry);
    const targetW = width * signature.width;
    const targetH = targetW / signature.aspectRatio;

    const origin = visualPointToPdf(geometry, width * signature.x, height * signature.y + targetH);
    page.drawImage(image, {
      x: origin.x,
      y: origin.y,
      rotate: degrees(geometry.rotation),
      width: targetW,
      height: targetH,
    });
  }

  return pdfDoc.save();
};

const parseHexColor = (hex: string) => {
  const normalized = hex.trim().replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map((c) => `${c}${c}`).join('')
    : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    return rgb(0, 0, 0);
  }
  return rgb(
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  );
};

export interface WatermarkOptions {
  text: string;
  size: number;
  opacity: number;
  rotation: number;
  color: string;
  /** Fraction of the page width, 0-1, as in the Android option string (`x=0.5000`). */
  xPercent?: number;
  /** Fraction of the page height measured from the *bottom*, as in PDF user space. */
  yPercent?: number;
}

/**
 * `WatermarkPdfToolProcessor` in the Android app.
 *
 * Geometry comes from the shared `watermarkLayout`, including its rotated-bounding-box clamp, and
 * the glyph origin is pre-rotated so pdf-lib turns the mark about its centre. Drawing at the
 * centre and letting pdf-lib rotate about that origin would swing the text off the anchor the
 * preview shows, which is exactly the drift this path used to have.
 */
export const addWatermarkToPDF = async (file: File, options: WatermarkOptions): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const pages = pdfDoc.getPages();
  if (pages.length === 0) {
    throw new Error(NO_PAGES_MESSAGE);
  }

  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const opacity = Math.max(0.05, Math.min(1, Number.isFinite(options.opacity) ? options.opacity : 0.3));
  const rotation = Math.max(
    WATERMARK_MIN_ROTATION_DEGREES,
    Math.min(
      WATERMARK_MAX_ROTATION_DEGREES,
      Number.isFinite(options.rotation) ? options.rotation : DEFAULT_WATERMARK_ROTATION_DEGREES,
    ),
  );
  const color = parseHexColor(options.color || DEFAULT_WATERMARK_COLOR_HEX);
  const measureTextWidth = (text: string, fontSize: number) => font.widthOfTextAtSize(text, fontSize);

  for (const page of pages) {
    const geometry = getPdfPageVisualGeometry(page);
    const { width, height } = getVisualPageSize(geometry);
    const layout = watermarkLayout({
      pageWidth: width,
      pageHeight: height,
      text: options.text,
      fontSize: Number.isFinite(options.size) ? options.size : DEFAULT_WATERMARK_SIZE,
      rotationDegrees: rotation,
      placement: {
        xPercent: Number.isFinite(options.xPercent) ? Number(options.xPercent) : DEFAULT_WATERMARK_X_PERCENT,
        yPercent: Number.isFinite(options.yPercent) ? Number(options.yPercent) : DEFAULT_WATERMARK_Y_PERCENT,
      },
      measureTextWidth,
    });
    if (!layout) continue;

    const visualOrigin = rotatedTextOrigin(layout);
    const origin = visualPointToPdf(geometry, visualOrigin.x, height - visualOrigin.y);
    page.drawText(layout.text, {
      x: origin.x,
      y: origin.y,
      size: layout.fontSize,
      font,
      color,
      opacity,
      rotate: degrees(geometry.rotation + layout.rotationDegrees),
    });
  }

  return pdfDoc.save();
};

export interface PageNumberOptions {
  format: string;
  fontSize: number;
  /** Fraction of the page width, 0-1. */
  xPercent: number;
  /** Fraction of the page height measured from the *bottom*, as in PDF user space. */
  yPercent: number;
  startPage: number;
  endPage: number;
}

/**
 * `PageNumbersToolProcessor` in the Android app: Helvetica at 30% grey, placed by the shared
 * `pageNumberLayout` so the label is centred on the anchor and clamped by its own measured box
 * rather than by a fixed 8pt margin.
 */
export const addPageNumbersToPDF = async (file: File, options: PageNumberOptions): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const pages = pdfDoc.getPages();
  const totalPages = pages.length;
  if (totalPages === 0) {
    throw new Error(NO_PAGES_MESSAGE);
  }

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const measureTextWidth = (text: string, size: number) => font.widthOfTextAtSize(text, size);
  const fontSize = sanitizePageNumberFontSize(
    Number.isFinite(options.fontSize) ? options.fontSize : DEFAULT_PAGE_NUMBER_FONT_SIZE,
  );
  const placement = {
    xPercent: Number.isFinite(options.xPercent) ? options.xPercent : DEFAULT_PAGE_NUMBER_X_PERCENT,
    yPercent: Number.isFinite(options.yPercent) ? options.yPercent : DEFAULT_PAGE_NUMBER_Y_PERCENT,
  };
  const { startPage, endPage } = resolvePageNumberRange(
    Number.isFinite(options.startPage) ? Math.floor(options.startPage) : null,
    Number.isFinite(options.endPage) ? Math.floor(options.endPage) : null,
    totalPages,
  );

  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    if (pageNumber < startPage || pageNumber > endPage) return;

    const geometry = getPdfPageVisualGeometry(page);
    const { width, height } = getVisualPageSize(geometry);
    const layout = pageNumberLayout({
      pageWidth: width,
      pageHeight: height,
      text: buildPageNumberText(options.format, pageNumber, totalPages),
      placement,
      fontSize,
      measureTextWidth,
    });
    if (!layout) return;

    const origin = visualPointToPdf(geometry, layout.baselineX, height - layout.baselineY);
    page.drawText(layout.text, {
      x: origin.x,
      y: origin.y,
      rotate: degrees(geometry.rotation),
      size: layout.fontSize,
      font,
      color: rgb(0.3, 0.3, 0.3),
    });
  });

  return pdfDoc.save();
};
