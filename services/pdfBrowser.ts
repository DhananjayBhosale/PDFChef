import { LocalizedError } from './i18n/errors.ts';
import { t } from './i18n/core.ts';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { canvasToBlob, getSafeBuffer, readFileAsArrayBuffer } from './pdfShared';
import {
  getAdaptiveConfig,
  projectCompressedSize,
  samplePageIndices,
  type AdaptiveConfig,
  type CompressionLevel,
  type CompressionSizeMeasurement,
} from './pdfCompressionConfig';
import { positionedTextItemsToWordTargets } from './pdfTextLineGrouping';
export type { PageSelectableTextLine } from './pdfTextLineGrouping';
import type { PageSelectableTextLine } from './pdfTextLineGrouping';

export {
  calculateTargetSize,
  getAdaptiveConfig,
  getInterpolatedConfig,
  type AdaptiveConfig,
  type CompressionLevel,
} from './pdfCompressionConfig';

const pdfjs = pdfjsLib;

if (typeof window !== 'undefined' && pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
}

/**
 * Where PDF.js finds the pieces it fetches rather than bundles.
 *
 * Without `wasmUrl` this build refuses to decode JPEG 2000 and JBIG2 images outright — it has no
 * fallback — so a scanned or image-heavy PDF renders with the pictures missing. Without `cMapUrl`
 * a CJK document with a non-Identity encoding extracts unusable text, and without
 * `standardFontDataUrl` the standard fourteen fonts are measured from approximations. All three
 * are vendored locally by scripts/prepare-local-assets.mjs so this keeps working with no network.
 */
const PDFJS_ASSET_BASE = '/vendor/pdfjs';
const pdfjsResourceOptions = {
  wasmUrl: `${PDFJS_ASSET_BASE}/wasm/`,
  cMapUrl: `${PDFJS_ASSET_BASE}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_ASSET_BASE}/standard_fonts/`,
};

const fileBufferCache = new WeakMap<File, Promise<ArrayBuffer>>();
const pdfDocumentCache = new WeakMap<File, Promise<any>>();

const getFileBuffer = (file: File) => {
  const cached = fileBufferCache.get(file);
  if (cached) return cached;

  const next = readFileAsArrayBuffer(file).catch((error) => {
    fileBufferCache.delete(file);
    throw error;
  });

  fileBufferCache.set(file, next);
  return next;
};

const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

const renderPageToBlob = async (
  page: any,
  scale: number,
  format: ImageExportConfig['format'] | 'image/jpeg',
  quality: number,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new LocalizedError("pdf-browser.canvas.context.failed.0fc40a");
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  const renderTask = page.render({ canvasContext: context, viewport });
  const cancel = () => renderTask.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await renderTask.promise;
    signal?.throwIfAborted();
    const width = canvas.width;
    const height = canvas.height;
    const blob = await canvasToBlob(canvas, format, quality);
    signal?.throwIfAborted();
    return { blob, width, height };
  } finally {
    signal?.removeEventListener('abort', cancel);
    canvas.width = 0;
    canvas.height = 0;
  }
};

const loadOwnedPDFDocument = async (file: File, onDestroy?: () => void): Promise<any> => {
  const arrayBuffer = await getFileBuffer(file);
  const loadingTask = pdfjs.getDocument({ data: getSafeBuffer(arrayBuffer), ...pdfjsResourceOptions });
  try {
    const doc = await loadingTask.promise;
    let destroyed = false;
    Object.defineProperty(doc, 'destroy', {
      configurable: true,
      value: async () => {
        if (destroyed) return;
        destroyed = true;
        onDestroy?.();
        await loadingTask.destroy();
      },
    });
    return doc;
  } catch (error) {
    try {
      await loadingTask.destroy();
    } catch {
      // Preserve the document-opening error; cleanup failure is secondary.
    }
    throw error;
  }
};

/**
 * Opens a PDF that the caller exclusively owns and must destroy.
 *
 * Long-lived readers use this instead of the shared probe cache so a closing
 * screen can release its PDF.js worker without invalidating another consumer.
 */
export const loadDisposablePDFDocument = (file: File) => loadOwnedPDFDocument(file);

export const loadPDFDocument = async (file: File) => {
  const cached = pdfDocumentCache.get(file);
  if (cached) return cached;

  let next: Promise<any>;
  next = loadOwnedPDFDocument(file, () => {
    if (pdfDocumentCache.get(file) === next) pdfDocumentCache.delete(file);
  }).catch((error) => {
    if (pdfDocumentCache.get(file) === next) pdfDocumentCache.delete(file);
    throw error;
  });

  pdfDocumentCache.set(file, next);
  return next;
};

const editablePdfDocumentCache = new WeakMap<File, Promise<any>>();

/**
 * Open a PDF for the inline text editor.
 *
 * `fontExtraProperties` is what exposes each font's embedded binary through `commonObjs`, and the
 * editor needs it to draw its overlay in the document's own typeface instead of an approximation.
 * It is deliberately kept off the shared loader: the font programs are large, and every other tool
 * renders pages without ever needing them.
 */
export const loadEditablePDFDocument = async (file: File) => {
  const cached = editablePdfDocumentCache.get(file);
  if (cached) return cached;

  const next = (async () => {
    const arrayBuffer = await getFileBuffer(file);
    const loadingTask = pdfjs.getDocument({
      data: getSafeBuffer(arrayBuffer),
      ...pdfjsResourceOptions,
      fontExtraProperties: true,
      // Local system fonts would render without ever registering a FontFace, leaving the overlay
      // unable to check whether the face it wants is actually available.
      useSystemFonts: false,
    });
    const doc = await loadingTask.promise;
    let destroyed = false;
    Object.defineProperty(doc, 'destroy', {
      configurable: true,
      value: async () => {
        if (destroyed) return;
        destroyed = true;
        editablePdfDocumentCache.delete(file);
        await loadingTask.destroy();
      },
    });

    return doc;
  })().catch((error) => {
    editablePdfDocumentCache.delete(file);
    throw error;
  });

  editablePdfDocumentCache.set(file, next);
  return next;
};

export const loadProtectedPDFDocument = async (file: File, password: string): Promise<any> => {
  const exactPassword = password;
  if (!exactPassword) {
    throw new LocalizedError("pdf-browser.password.is.required.7aeae1");
  }

  const arrayBuffer = await getFileBuffer(file);
  const loadingTask = pdfjs.getDocument({
    data: getSafeBuffer(arrayBuffer),
    ...pdfjsResourceOptions,
    password: exactPassword,
  });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    try {
      await loadingTask.destroy();
    } catch {
      // Preserve the password/opening error; cleanup failure is secondary.
    }
    throw error;
  }
  let destroyed = false;
  Object.defineProperty(doc, 'destroy', {
    configurable: true,
    value: async () => {
      if (destroyed) return;
      destroyed = true;
      await loadingTask.destroy();
    },
  });
  return doc;
};

export const analyzePDF = async (file: File): Promise<{ isTextHeavy: boolean; pageCount: number }> => {
  try {
    const pdf = await loadPDFDocument(file);
    const numPages = pdf.numPages;
    const maxPagesToCheck = Math.min(numPages, 3);
    let totalTextItems = 0;

    for (let i = 1; i <= maxPagesToCheck; i += 1) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      totalTextItems += textContent.items.length;
    }

    const avgTextItems = totalTextItems / maxPagesToCheck;
    return {
      isTextHeavy: avgTextItems > 20,
      pageCount: numPages,
    };
  } catch (error) {
    console.error('Analysis failed', error);
    return { isTextHeavy: false, pageCount: 0 };
  }
};

export interface PdfPreviewProgress { completed: number; total: number; }

export const getPdfPagePreviews = async (
  file: File,
  options?: { limit?: number; scale?: number; signal?: AbortSignal; onProgress?: (progress: PdfPreviewProgress) => void },
): Promise<string[]> => {
  options?.signal?.throwIfAborted();
  // A preview batch owns its worker. The shared cache has other consumers whose documents
  // must remain usable when this batch finishes or the user chooses a different file.
  const pdf = await loadDisposablePDFDocument(file);
  const previews: string[] = [];

  try {
    options?.signal?.throwIfAborted();
    const pageLimit = options?.limit ? Math.min(pdf.numPages, options.limit) : pdf.numPages;
    const scale = options?.scale ?? 0.3;
    options?.onProgress?.({ completed: 0, total: pageLimit });
    for (let index = 0; index < pageLimit; index += 1) {
      options?.signal?.throwIfAborted();
      const page = await pdf.getPage(index + 1);
      const { blob } = await renderPageToBlob(page, scale, 'image/jpeg', 0.7, options?.signal);
      previews.push(URL.createObjectURL(blob));
      options?.onProgress?.({ completed: index + 1, total: pageLimit });
      // Paint the first completed preview, then keep the existing four-page yield cadence.
      if (index === 0 || (index + 1) % 4 === 0) await nextFrame();
    }
    options?.signal?.throwIfAborted();
    return previews;
  } catch (error) {
    previews.forEach(url => URL.revokeObjectURL(url));
    throw error;
  } finally {
    await pdf.destroy();
  }
};

export interface ImageExportConfig {
  format: 'image/jpeg' | 'image/png' | 'image/webp';
  quality: number;
  scale: number;
}

export const renderPdfPageToBlob = async (
  page: any,
  config: ImageExportConfig,
): Promise<{ blob: Blob; width: number; height: number; sizeBytes: number }> => {
  const { blob, width, height } = await renderPageToBlob(
    page,
    config.scale,
    config.format,
    config.quality,
  );

  return {
    blob,
    width,
    height,
    sizeBytes: blob.size,
  };
};

export interface EmbeddedPdfImageAsset {
  id: string;
  objectUrl: string;
  blob: Blob;
  width: number;
  height: number;
  byteSize: number;
  pageNumbers: number[];
  source: 'xobject' | 'inline';
}

export type PdfFormFieldKind = 'text' | 'textarea' | 'checkbox' | 'radio' | 'select' | 'multiselect';
export type PdfFormFieldValue = string | boolean | string[];

export interface PdfFormFieldOption {
  label: string;
  value: string;
}

export interface PdfFormFieldDefinition {
  id: string;
  fieldName: string;
  label: string;
  kind: PdfFormFieldKind;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  readOnly: boolean;
  required: boolean;
  value: PdfFormFieldValue;
  options?: PdfFormFieldOption[];
  radioValue?: string;
}

const prettifyFieldName = (fieldName: string) =>
  fieldName
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const normalizePdfFieldValue = (annotation: any): PdfFormFieldValue => {
  if (annotation.fieldType === 'Btn' && annotation.checkBox) {
    return Boolean(annotation.fieldValue && annotation.fieldValue !== 'Off');
  }

  if (annotation.fieldType === 'Ch') {
    if (annotation.multiSelect) {
      return Array.isArray(annotation.fieldValue)
        ? annotation.fieldValue.filter((value: unknown): value is string => typeof value === 'string')
        : typeof annotation.fieldValue === 'string' && annotation.fieldValue
          ? [annotation.fieldValue]
          : [];
    }

    if (Array.isArray(annotation.fieldValue)) {
      return typeof annotation.fieldValue[0] === 'string' ? annotation.fieldValue[0] : '';
    }

    return typeof annotation.fieldValue === 'string' ? annotation.fieldValue : '';
  }

  return typeof annotation.fieldValue === 'string' ? annotation.fieldValue : '';
};

export const getPdfFormFields = async (pdfDoc: any): Promise<PdfFormFieldDefinition[]> => {
  const fields: PdfFormFieldDefinition[] = [];

  for (let pageIndex = 0; pageIndex < (pdfDoc?.numPages || 0); pageIndex += 1) {
    const page = await pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const annotations = await page.getAnnotations();

    annotations.forEach((annotation: any) => {
      if (!annotation?.fieldName || annotation.hidden || annotation.noHTML || annotation.pushButton) {
        return;
      }

      const rect = Array.isArray(annotation.rect) ? annotation.rect : null;
      if (!rect || rect.length < 4) return;

      const left = Math.min(rect[0], rect[2]);
      const right = Math.max(rect[0], rect[2]);
      const bottom = Math.min(rect[1], rect[3]);
      const top = Math.max(rect[1], rect[3]);
      const width = Math.max(1, right - left);
      const height = Math.max(1, top - bottom);
      const y = Math.max(0, viewport.height - top);

      let kind: PdfFormFieldKind | null = null;
      if (annotation.fieldType === 'Tx') {
        kind = annotation.multiLine ? 'textarea' : 'text';
      } else if (annotation.fieldType === 'Btn' && annotation.checkBox) {
        kind = 'checkbox';
      } else if (annotation.fieldType === 'Btn' && annotation.radioButton) {
        kind = 'radio';
      } else if (annotation.fieldType === 'Ch') {
        kind = annotation.multiSelect ? 'multiselect' : 'select';
      }

      if (!kind) return;

      const options = Array.isArray(annotation.options)
        ? annotation.options
            .map((option: any) => {
              const value = typeof option?.exportValue === 'string' ? option.exportValue : '';
              const label = typeof option?.displayValue === 'string' && option.displayValue
                ? option.displayValue
                : value;
              return value ? { label, value } : null;
            })
            .filter((option: PdfFormFieldOption | null): option is PdfFormFieldOption => Boolean(option))
        : undefined;

      fields.push({
        id: String(annotation.id || `${annotation.fieldName}-${pageIndex}-${fields.length}`),
        fieldName: annotation.fieldName,
        label: annotation.alternativeText || prettifyFieldName(annotation.fieldName),
        kind,
        pageIndex,
        x: left,
        y,
        width,
        height,
        readOnly: Boolean(annotation.readOnly),
        required: Boolean(annotation.required),
        value: normalizePdfFieldValue(annotation),
        options,
        radioValue: typeof annotation.exportValue === 'string' ? annotation.exportValue : undefined,
      });
    });
  }

  return fields;
};

export const getPageSelectableTextLines = async (
  pdfDoc: any,
  pageIndex: number,
  scale = 1,
): Promise<PageSelectableTextLine[]> => {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const textContent = await page.getTextContent();

  const positionedItems = textContent.items
    .map((item: any) => {
      const text = typeof item.str === 'string' ? item.str : '';
      if (!text.trim()) return null;

      const tx = pdfjs.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.max(1, Math.hypot(tx[2], tx[3]) || (item.height || 0) * scale || 12);
      const width = Math.max(1, (item.width || 0) * scale);
      const advanceLength = Math.hypot(tx[0], tx[1]);
      const advanceX = advanceLength > 0 ? tx[0] / advanceLength * width : width;
      const advanceY = advanceLength > 0 ? tx[1] / advanceLength * width : 0;
      const riseLength = Math.hypot(tx[2], tx[3]);
      const riseX = riseLength > 0 ? tx[2] / riseLength * fontHeight : 0;
      const riseY = riseLength > 0 ? tx[3] / riseLength * fontHeight : -fontHeight;
      const viewportCorners = [
        [tx[4], tx[5]],
        [tx[4] + advanceX, tx[5] + advanceY],
        [tx[4] + riseX, tx[5] + riseY],
        [tx[4] + advanceX + riseX, tx[5] + advanceY + riseY],
      ];
      const viewportXValues = viewportCorners.map(([x]) => x);
      const viewportYValues = viewportCorners.map(([, y]) => y);
      const left = Math.min(...viewportXValues);
      const top = Math.min(...viewportYValues);
      const right = Math.max(...viewportXValues);
      const bottom = Math.max(...viewportYValues);

      const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform || [];
      const pdfAdvanceLength = Math.hypot(a, b);
      const pdfAdvanceX = pdfAdvanceLength > 0 ? a / pdfAdvanceLength * (item.width || 0) : item.width || 0;
      const pdfAdvanceY = pdfAdvanceLength > 0 ? b / pdfAdvanceLength * (item.width || 0) : 0;
      const pdfRiseLength = Math.hypot(c, d);
      const pdfHeight = Math.max(1, item.height || pdfRiseLength || fontHeight / scale);
      const pdfRiseX = pdfRiseLength > 0 ? c / pdfRiseLength * pdfHeight : 0;
      const pdfRiseY = pdfRiseLength > 0 ? d / pdfRiseLength * pdfHeight : pdfHeight;
      const pdfCorners = [
        [e, f],
        [e + pdfAdvanceX, f + pdfAdvanceY],
        [e + pdfRiseX, f + pdfRiseY],
        [e + pdfAdvanceX + pdfRiseX, f + pdfAdvanceY + pdfRiseY],
      ];
      const pdfXValues = pdfCorners.map(([x]) => x);
      const pdfYValues = pdfCorners.map(([, y]) => y);

      return {
        text,
        left,
        top,
        right,
        bottom,
        height: Math.max(1, bottom - top),
        centerY: (top + bottom) / 2,
        quad: {
          x: tx[4],
          y: tx[5],
          advanceX,
          advanceY,
          riseX,
          riseY,
        },
        sourcePdfRect: [
          Math.min(...pdfXValues),
          Math.min(...pdfYValues),
          Math.max(...pdfXValues),
          Math.max(...pdfYValues),
        ] as [number, number, number, number],
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => {
      const verticalDelta = a.top - b.top;
      if (Math.abs(verticalDelta) <= Math.max(a.height, b.height) * 0.5) {
        return a.left - b.left;
      }
      return verticalDelta;
    });

  return positionedTextItemsToWordTargets(positionedItems).map((word) => {
    const corners = [
      viewport.convertToPdfPoint(word.left, word.top),
      viewport.convertToPdfPoint(word.left + word.width, word.top),
      viewport.convertToPdfPoint(word.left, word.top + word.height),
      viewport.convertToPdfPoint(word.left + word.width, word.top + word.height),
    ];
    const xValues = corners.map(([x]: [number, number]) => x);
    const yValues = corners.map(([, y]: [number, number]) => y);
    const sourceRunCorners = word.sourceRun && !word.sourceRun.pdfRect ? [
      viewport.convertToPdfPoint(word.sourceRun.left, word.sourceRun.top),
      viewport.convertToPdfPoint(word.sourceRun.left + word.sourceRun.width, word.sourceRun.top),
      viewport.convertToPdfPoint(word.sourceRun.left, word.sourceRun.top + word.sourceRun.height),
      viewport.convertToPdfPoint(
        word.sourceRun.left + word.sourceRun.width,
        word.sourceRun.top + word.sourceRun.height,
      ),
    ] : [];
    const sourceRunXValues = sourceRunCorners.map(([x]: [number, number]) => x);
    const sourceRunYValues = sourceRunCorners.map(([, y]: [number, number]) => y);
    return {
      ...word,
      pdfRect: [
        Math.min(...xValues),
        Math.min(...yValues),
        Math.max(...xValues),
        Math.max(...yValues),
      ],
      sourceRun: word.sourceRun ? {
        ...word.sourceRun,
        pdfRect: word.sourceRun.pdfRect ?? [
          Math.min(...sourceRunXValues),
          Math.min(...sourceRunYValues),
          Math.max(...sourceRunXValues),
          Math.max(...sourceRunYValues),
        ],
      } : undefined,
    };
  });
};

export const pdfSpaceRectToViewportRect = async (
  pdfDoc: any,
  pageIndex: number,
  pdfRect: [number, number, number, number],
) => {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const corners = [
    viewport.convertToViewportPoint(pdfRect[0], pdfRect[1]),
    viewport.convertToViewportPoint(pdfRect[2], pdfRect[1]),
    viewport.convertToViewportPoint(pdfRect[0], pdfRect[3]),
    viewport.convertToViewportPoint(pdfRect[2], pdfRect[3]),
  ];
  const xValues = corners.map(([x]: [number, number]) => x);
  const yValues = corners.map(([, y]: [number, number]) => y);
  const left = Math.min(...xValues);
  const top = Math.min(...yValues);
  return {
    left,
    top,
    width: Math.max(1, Math.max(...xValues) - left),
    height: Math.max(1, Math.max(...yValues) - top),
  };
};

const textRenderingOperations = new Set<number>([
  pdfjs.OPS.showText,
  pdfjs.OPS.showSpacedText,
  pdfjs.OPS.nextLineShowText,
  pdfjs.OPS.nextLineSetSpacingShowText,
].filter((operation): operation is number => typeof operation === 'number'));

/**
 * Free a scratch canvas's pixels once PDF.js has finished with it.
 *
 * Rendering the same page twice makes PDF.js tidy up the earlier task, and that tidy-up restores
 * the graphics state on the context it drew into. Resizing the canvas in the same turn wipes that
 * state out from under it, which throws. Deferring the release lets the tidy-up run first.
 */
const releaseCanvas = (canvas: HTMLCanvasElement) => {
  setTimeout(() => {
    canvas.width = 0;
    canvas.height = 0;
  }, 0);
};

export const getPageTextBackgroundPatch = async (
  pdfDoc: any,
  pageIndex: number,
  line: PageSelectableTextLine,
  renderScale = 2,
): Promise<string> => {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const scale = Math.max(1, Math.min(3, renderScale));
  const viewport = page.getViewport({ scale });
  const operatorList = await page.getOperatorList({ intent: 'display' });
  const left = Math.max(0, line.left);
  const top = Math.max(0, line.top);
  const right = Math.min(viewport.width / scale, line.left + Math.max(1, line.width));
  const bottom = Math.min(viewport.height / scale, line.top + Math.max(1, line.height));
  const width = Math.max(1, Math.ceil((right - left) * scale));
  const height = Math.max(1, Math.ceil((bottom - top) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new LocalizedError("pdf-browser.the.highlight.behind.the.text.could.not.85b523");

  let maximumObservedOperationIndex = -1;
  await page.render({
    canvasContext: context,
    viewport,
    background: '#ffffff',
    transform: [1, 0, 0, 1, -left * scale, -top * scale],
    operationsFilter: (index: number) => {
      maximumObservedOperationIndex = Math.max(maximumObservedOperationIndex, index);
      return !textRenderingOperations.has(operatorList.fnArray[index]);
    },
  }).promise;

  // In the pinned PDF.js build, getOperatorList(OPLIST) is unoptimised while render(display)
  // may run a shorter QueueOptimizer list. Every registered optimisation strictly shrinks the
  // list, so equal lengths mean the operation indexes used by this filter are still aligned.
  // Revisit this invariant whenever PDF.js changes its optimiser registrations.
  if (maximumObservedOperationIndex + 1 !== operatorList.fnArray.length) {
    releaseCanvas(canvas);
    throw new LocalizedError("pdf-browser.automatic.text.reconstruction.is.unavailable.for.this.7b828c");
  }

  const dataUrl = canvas.toDataURL('image/png');
  releaseCanvas(canvas);
  return dataUrl;
};

export const renderPageAsImage = async (
  pdfDoc: any,
  pageIndex: number,
  config: ImageExportConfig,
): Promise<{ objectUrl: string; blob: Blob; width: number; height: number; sizeBytes: number }> => {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const rendered = await renderPdfPageToBlob(page, config);
  const objectUrl = URL.createObjectURL(rendered.blob);

  return {
    ...rendered,
    objectUrl,
  };
};

const hashUint8 = (bytes: Uint8Array) => {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

const waitForPdfObject = (pool: any, objectId: string) =>
  new Promise<any>((resolve, reject) => {
    try {
      if (pool.has(objectId)) {
        resolve(pool.get(objectId));
        return;
      }
      pool.get(objectId, resolve);
    } catch (error) {
      reject(error);
    }
  });

const toRgbaPixels = (image: any) => {
  const width = image.width || 0;
  const height = image.height || 0;
  const data = image.data;
  if (!width || !height || !(data instanceof Uint8Array)) {
    throw new LocalizedError("pdf-browser.this.picture.is.in.a.format.the.b0dc49");
  }

  if (image.kind === pdfjs.ImageKind.RGBA_32BPP) {
    return new Uint8ClampedArray(data);
  }

  if (image.kind === pdfjs.ImageKind.RGB_24BPP) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let src = 0, dest = 0; src < data.length; src += 3, dest += 4) {
      rgba[dest] = data[src];
      rgba[dest + 1] = data[src + 1];
      rgba[dest + 2] = data[src + 2];
      rgba[dest + 3] = 255;
    }
    return rgba;
  }

  if (image.kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const stride = Math.ceil(width / 8);
    let dest = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const byte = data[y * stride + (x >> 3)];
        const bit = (byte >> (7 - (x & 7))) & 1;
        const value = bit ? 0 : 255;
        rgba[dest] = value;
        rgba[dest + 1] = value;
        rgba[dest + 2] = value;
        rgba[dest + 3] = 255;
        dest += 4;
      }
    }
    return rgba;
  }

  throw new LocalizedError("pdf-browser.unsupported.embedded.image.kind.27b45e", { v0: String(image.kind) });
};

const exportEmbeddedImageAsPng = async (image: any) => {
  if (image?.bitmap) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new LocalizedError("pdf-browser.canvas.context.failed.0fc40a");
    }
    context.drawImage(image.bitmap, 0, 0);
    const blob = await canvasToBlob(canvas, 'image/png');
    return { blob, width: canvas.width, height: canvas.height };
  }

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new LocalizedError("pdf-browser.canvas.context.failed.0fc40a");
  }

  const rgba = toRgbaPixels(image);
  const imageData = context.createImageData(canvas.width, canvas.height);
  imageData.data.set(rgba);
  context.putImageData(imageData, 0, 0);
  const blob = await canvasToBlob(canvas, 'image/png');

  return {
    blob,
    width: canvas.width,
    height: canvas.height,
  };
};

export const extractEmbeddedImagesFromPDF = async (
  pdfDoc: any,
  options?: { onProgress?: (currentPage: number, totalPages: number) => void },
): Promise<EmbeddedPdfImageAsset[]> => {
  const imagesByHash = new Map<string, EmbeddedPdfImageAsset>();
  const totalPages = pdfDoc.numPages || 0;

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    options?.onProgress?.(pageIndex + 1, totalPages);

    const page = await pdfDoc.getPage(pageIndex + 1);
    const operatorList = await page.getOperatorList();
    const pageImageRefs = new Set<string>();

    for (let opIndex = 0; opIndex < operatorList.fnArray.length; opIndex += 1) {
      const fn = operatorList.fnArray[opIndex];
      const args = operatorList.argsArray[opIndex];

      if (
        fn !== pdfjs.OPS.paintImageXObject &&
        fn !== pdfjs.OPS.paintImageXObjectRepeat &&
        fn !== pdfjs.OPS.paintInlineImageXObject &&
        fn !== pdfjs.OPS.paintInlineImageXObjectGroup
      ) {
        continue;
      }

      const source = fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintImageXObjectRepeat ? 'xobject' : 'inline';
      const refKey = source === 'xobject' ? String(args[0]) : `inline-${pageIndex}-${opIndex}`;

      if (pageImageRefs.has(refKey)) {
        continue;
      }
      pageImageRefs.add(refKey);

      let imageObject: any = null;
      try {
        if (source === 'xobject') {
          const objectId = String(args[0]);
          const pool = objectId.startsWith('g_') ? page.commonObjs : page.objs;
          imageObject = await waitForPdfObject(pool, objectId);
        } else {
          imageObject = args[0];
        }
      } catch (error) {
        console.error('Failed to resolve embedded image', error);
        continue;
      }

      if (!imageObject?.width || !imageObject?.height) {
        continue;
      }

      try {
        const { blob, width, height } = await exportEmbeddedImageAsPng(imageObject);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const imageHash = `${width}x${height}-${hashUint8(bytes)}`;
        const existing = imagesByHash.get(imageHash);

        if (existing) {
          if (!existing.pageNumbers.includes(pageIndex + 1)) {
            existing.pageNumbers.push(pageIndex + 1);
            existing.pageNumbers.sort((a, b) => a - b);
          }
          continue;
        }

        const objectUrl = URL.createObjectURL(blob);
        imagesByHash.set(imageHash, {
          id: imageHash,
          objectUrl,
          blob,
          width,
          height,
          byteSize: blob.size,
          pageNumbers: [pageIndex + 1],
          source,
        });
      } catch (error) {
        console.error('Failed to export embedded image', error);
      }
    }

    if ((pageIndex + 1) % 2 === 0) {
      await nextFrame();
    }
  }

  return Array.from(imagesByHash.values()).sort((left, right) => {
    const pageDelta = (left.pageNumbers[0] || 0) - (right.pageNumbers[0] || 0);
    if (pageDelta !== 0) return pageDelta;
    return right.byteSize - left.byteSize;
  });
};

export const extractTextFromPDF = async (file: File): Promise<string> => {
  const pdf = await loadPDFDocument(file);
  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(' ');
    fullText += `--- Page ${i} ---\n${pageText}\n\n`;
  }

  return fullText;
};

export const getFirstPageTextSignature = async (file: File, maxChars = 500): Promise<string> => {
  const pdf = await loadPDFDocument(file);
  if (pdf.numPages <= 0) return '';
  const page = await pdf.getPage(1);
  const textContent = await page.getTextContent();
  const text = textContent.items
    .map((item: any) => item.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxChars);
};

export const getPageTextSignatures = async (
  file: File,
  options?: { maxPages?: number; maxCharsPerPage?: number },
): Promise<string[]> => {
  // Comparing must not destroy the cached document still used by the page preview.
  const pdf = await loadDisposablePDFDocument(file);
  const maxChars = options?.maxCharsPerPage ?? 500;
  const totalPages = options?.maxPages
    ? Math.min(pdf.numPages, Math.max(1, options.maxPages))
    : pdf.numPages;
  const signatures: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item: any) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxChars);
      signatures.push(text);
    }

    return signatures;
  } finally {
    await pdf.destroy();
  }
};

// Keep the preview and size sample on the same raster scale and JPEG encoder as export.
const renderCompressedPage = (page: any, config: AdaptiveConfig) =>
  renderPageToBlob(page, config.scale * 1.5, 'image/jpeg', config.quality);

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(new LocalizedError("pdf-browser.preview.render.failed.abb8ce"));
  reader.readAsDataURL(blob);
});

export const generatePreviewPair = async (
  file: File,
  config: AdaptiveConfig,
  options?: { pageIndex?: number },
) => {
  const pdf = await loadPDFDocument(file);
  const pageCount = Math.max(1, pdf.numPages || 1);
  const requestedPageIndex = Number.isFinite(options?.pageIndex)
    ? Math.floor(options?.pageIndex || 0)
    : 0;
  const pageIndex = Math.max(0, Math.min(pageCount - 1, requestedPageIndex));
  const page = await pdf.getPage(pageIndex + 1);

  const original = await renderPageToBlob(page, 1.5, 'image/jpeg', 0.9);
  const compressed = await renderCompressedPage(page, config);
  const [originalImage, compressedImage] = await Promise.all([
    blobToDataUrl(original.blob), blobToDataUrl(compressed.blob),
  ]);
  const estimatedTotalSize = projectCompressedSize({
    bytesPerPage: compressed.blob.size, pageCount, sampledPages: 1,
  });

  return {
    original: originalImage,
    compressed: compressedImage,
    metrics: { estimatedTotalSize },
    pageCount,
    pageIndex,
  };
};

/** Re-encode ordinary opaque image objects without touching text, forms, or drawings. */
const recompressSelectableImages = async (
  pdfDoc: PDFDocument,
  config: AdaptiveConfig,
  onProgress: (progress: number) => void,
) => {
  const name = (value: string) => PDFName.of(value);
  const images = pdfDoc.context.enumerateIndirectObjects().filter(([, object]) => {
    if (!(object instanceof PDFRawStream)) return false;
    const dictionary = object.dict;
    const width = dictionary.lookupMaybe(name('Width'), PDFNumber)?.asNumber() ?? 0;
    const height = dictionary.lookupMaybe(name('Height'), PDFNumber)?.asNumber() ?? 0;
    const colorSpace = dictionary.lookupMaybe(name('ColorSpace'), PDFName)?.toString();
    const filter = dictionary.get(name('Filter'))?.toString();
    return dictionary.get(name('Subtype'))?.toString() === '/Image'
      && (filter === '/DCTDecode' || filter === '/FlateDecode')
      && (colorSpace === '/DeviceRGB' || colorSpace === '/DeviceGray')
      && dictionary.lookupMaybe(name('BitsPerComponent'), PDFNumber)?.asNumber() === 8
      && !dictionary.has(name('SMask')) && !dictionary.has(name('Mask'))
      && !dictionary.has(name('Decode')) && !dictionary.has(name('DecodeParms'))
      && width >= 128 && height >= 128 && width * height <= 24_000_000;
  }) as Array<[import('pdf-lib').PDFRef, PDFRawStream]>;

  for (let index = 0; index < images.length; index += 1) {
    const [ref, original] = images[index];
    let objectUrl: string | null = null;
    let sourceCanvas: HTMLCanvasElement | null = null;
    let canvas: HTMLCanvasElement | null = null;
    try {
      const width = original.dict.lookup(name('Width'), PDFNumber).asNumber();
      const height = original.dict.lookup(name('Height'), PDFNumber).asNumber();
      let drawable: CanvasImageSource;
      if (original.dict.get(name('Filter'))?.toString() === '/DCTDecode') {
        objectUrl = URL.createObjectURL(new Blob([original.getContents()], { type: 'image/jpeg' }));
        const image = new Image();
        image.src = objectUrl;
        await image.decode();
        drawable = image;
      } else {
        const channels = original.dict.get(name('ColorSpace'))?.toString() === '/DeviceGray' ? 1 : 3;
        const pixels = decodePDFRawStream(original).decode();
        if (pixels.length !== width * height * channels) continue;
        sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = width;
        sourceCanvas.height = height;
        const sourceContext = sourceCanvas.getContext('2d');
        if (!sourceContext) continue;
        const rgba = sourceContext.createImageData(width, height);
        for (let pixel = 0; pixel < width * height; pixel += 1) {
          const source = pixel * channels;
          const target = pixel * 4;
          rgba.data[target] = pixels[source];
          rgba.data[target + 1] = pixels[source + (channels === 3 ? 1 : 0)];
          rgba.data[target + 2] = pixels[source + (channels === 3 ? 2 : 0)];
          rgba.data[target + 3] = 255;
        }
        sourceContext.putImageData(rgba, 0, 0);
        drawable = sourceCanvas;
      }
      const nextWidth = Math.max(1, Math.round(width * config.scale));
      const nextHeight = Math.max(1, Math.round(height * config.scale));
      canvas = document.createElement('canvas');
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.drawImage(drawable, 0, 0, nextWidth, nextHeight);
      const encoded = await canvasToBlob(canvas, 'image/jpeg', config.quality);
      if (encoded.size >= original.getContentsSize()) continue;

      const bytes = new Uint8Array(await encoded.arrayBuffer());
      const dictionary = original.dict.clone();
      dictionary.set(name('Width'), PDFNumber.of(nextWidth));
      dictionary.set(name('Height'), PDFNumber.of(nextHeight));
      dictionary.set(name('ColorSpace'), name('DeviceRGB'));
      dictionary.set(name('Filter'), name('DCTDecode'));
      dictionary.set(name('Length'), PDFNumber.of(bytes.length));
      pdfDoc.context.assign(ref, PDFRawStream.of(dictionary, bytes));
    } catch {
      // Unsupported or corrupt images are preserved byte-for-byte in the saved PDF.
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      if (sourceCanvas) { sourceCanvas.width = 0; sourceCanvas.height = 0; }
      onProgress(10 + ((index + 1) / images.length) * 80);
    }
  }
};

export const compressPDFAdaptive = async (
  file: File,
  level: CompressionLevel,
  onProgress: (p: number) => void,
  overrideSafety = false,
  customConfig?: AdaptiveConfig,
  flatten = true,
  isTextHeavy = false,
) => {
  const config = customConfig || getAdaptiveConfig(level, isTextHeavy);

  if (!overrideSafety && config.projectedDPI < 72 && flatten) {
    return {
      data: new Uint8Array(0),
      meta: {
        compressedSize: 0,
        projectedDPI: config.projectedDPI,
        strategyUsed: 'Blocked (Low DPI)',
      },
      status: 'blocked' as const,
    };
  }

  if (!flatten) {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    await recompressSelectableImages(pdfDoc, config, onProgress);
    onProgress(90);
    const saved = await pdfDoc.save({ useObjectStreams: true });
    onProgress(100);
    return {
      data: saved,
      meta: {
        compressedSize: saved.byteLength,
        projectedDPI: config.projectedDPI,
        strategyUsed: 'Selectable Text Image Compression',
      },
      status: 'success' as const,
    };
  }

  const pdf = await loadPDFDocument(file);
  const numPages = pdf.numPages;
  const newPdf = await PDFDocument.create();
  let completedPages = 0;

  // Render two pages at a time for throughput, then embed and release that batch before rendering
  // more. Keeping every rendered JPEG until the end made peak memory grow with the page count.
  const renderBatchSize = 2;
  for (let batchStart = 0; batchStart < numPages; batchStart += renderBatchSize) {
    const batchEnd = Math.min(numPages, batchStart + renderBatchSize);
    const renderedPages = await Promise.all(
      Array.from({ length: batchEnd - batchStart }, async (_, offset) => {
        const page = await pdf.getPage(batchStart + offset + 1);
        const originalViewport = page.getViewport({ scale: 1.0 });
        const { blob } = await renderCompressedPage(page, config);
        completedPages += 1;
        onProgress((completedPages / numPages) * 90);

        return {
          imageBytes: await blob.arrayBuffer(),
          width: originalViewport.width,
          height: originalViewport.height,
        };
      }),
    );

    for (const renderedPage of renderedPages) {
      const embed = await newPdf.embedJpg(renderedPage.imageBytes);
      const outputPage = newPdf.addPage([renderedPage.width, renderedPage.height]);
      outputPage.drawImage(embed, {
        x: 0,
        y: 0,
        width: renderedPage.width,
        height: renderedPage.height,
      });
    }
  }

  const saved = await newPdf.save();
  return {
    data: saved,
    meta: {
      compressedSize: saved.byteLength,
      projectedDPI: config.projectedDPI,
      strategyUsed: 'Adaptive Rasterization',
    },
    status: 'success' as const,
  };
};

/* ------------------------------------------- Measured size estimation --- */

/**
 * What the export will actually weigh, measured rather than guessed.
 *
 * The rasterising path writes exactly one JPEG per page, so encoding a handful
 * of real pages through the same call the exporter uses and multiplying by the
 * page count describes this document instead of a fitted average. A scanned
 * page and a text page no longer get the same prediction, which is the whole
 * reason the ratio table was wrong.
 */
const measurementCache = new WeakMap<File, Map<string, CompressionSizeMeasurement>>();

const measurementKey = (config: AdaptiveConfig) =>
  `${config.scale.toFixed(3)}:${config.quality.toFixed(3)}`;

export const measureCompressedSize = async (
  file: File,
  config: AdaptiveConfig,
  options?: { maxSamples?: number },
): Promise<CompressionSizeMeasurement> => {
  const key = measurementKey(config);
  const cached = measurementCache.get(file)?.get(key);
  if (cached) return cached;

  const pdf = await loadPDFDocument(file);
  const pageCount = Math.max(1, pdf.numPages || 1);
  const indices = samplePageIndices(pageCount, options?.maxSamples ?? 3);

  let totalBytes = 0;
  let sampledPages = 0;
  for (const pageIndex of indices) {
    const page = await pdf.getPage(pageIndex + 1);
    // The exporter's own arguments, verbatim. Anything else would measure a
    // different encoder than the one that writes the file.
    const { blob } = await renderCompressedPage(page, config);
    totalBytes += blob.size;
    sampledPages += 1;
  }

  const measurement: CompressionSizeMeasurement = {
    bytesPerPage: sampledPages > 0 ? totalBytes / sampledPages : 0,
    pageCount,
    sampledPages,
  };

  const perFile = measurementCache.get(file) ?? new Map<string, CompressionSizeMeasurement>();
  perFile.set(key, measurement);
  measurementCache.set(file, perFile);
  return measurement;
};

/** The measured projection for one config, or 0 when the document could not be sampled. */
export const measureProjectedSize = async (
  file: File,
  config: AdaptiveConfig,
  options?: { maxSamples?: number },
): Promise<number> => {
  try {
    return projectCompressedSize(await measureCompressedSize(file, config, options));
  } catch {
    return 0;
  }
};
