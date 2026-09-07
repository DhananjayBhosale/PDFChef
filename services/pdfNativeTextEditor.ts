import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { boundsFitWithinCropBox, PDF_TEXT_OVERFLOW_MESSAGE } from './pdfTextEditSafety';
import {
  planNativePdfTextEdits,
  resolveNativePdfTextTarget,
  sameSourceRun,
  type NativePdfTextTarget,
  type NativePdfTextAppearance,
  type PdfSpaceRect,
  type PdfTextCharacterSnapshot,
  type PdfTextObjectSnapshot,
  type PlannedNativePdfTextEdit,
} from './pdfNativeTextPlanning';

const PDF_PAGE_OBJECT_TEXT = 1;
const PDF_PAGE_OBJECT_FORM = 5;
const PDF_TEXT_RENDER_MODE_INVISIBLE = 3;
const MAX_NATIVE_TEXT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FIRST_INSPECTION_MS = 400;
/**
 * How far a glyph the reader did not touch may sit from where it started, before the rewrite is
 * abandoned and the paragraph is redrawn instead.
 *
 * Two different things show up in this measurement and the threshold has to separate them. Writing
 * a text object back re-derives every advance, and float arithmetic alone shifts glyphs by a few
 * hundredths of a point — measured at 0.07 and 0.10 on documents whose text is otherwise untouched.
 * Where a PDF spaced its glyphs by hand, though, that spacing is lost and the same measurement
 * jumps to whole points: 1.4 typical and 2.9 at worst on one document here, which is text visibly
 * moving on the page. 0.15 sits an order of magnitude below the damage and twice above the noise,
 * and is itself finer than the thinnest rule a PDF can draw.
 */
const SERIALIZED_BOUNDS_TOLERANCE_POINTS = 0.15;

type PdfiumHeap = WrappedPdfiumModule['pdfium'] & {
  HEAPU8: Uint8Array;
};

type PdfiumEngine = WrappedPdfiumModule & { pdfium: PdfiumHeap };

export interface NativePdfTextEdit extends NativePdfTextTarget {
  pageIndex: number;
  replacementText: string;
}

export interface PdfTextRunPlacement {
  pageIndex: number;
  text: string;
  x: number;
  y: number;
}

export interface NativePdfTextCapability {
  supported: boolean;
  reason?: string;
  match?: {
    pdfRect: PdfSpaceRect;
    sourceRun: {
      text: string;
      start: number;
      end: number;
      pdfRect: PdfSpaceRect;
    };
    appearance?: NativePdfTextAppearance;
  };
}

interface CachedInspectionDocument {
  engine: PdfiumEngine;
  inputPointer: number;
  document: number;
}

interface PageObjectState {
  objectIndex: number;
  type: number;
  bounds?: PdfSpaceRect;
  text?: string;
  fontSize?: number;
  matrix?: [number, number, number, number, number, number];
  fillColor?: [number, number, number, number];
  characters?: PdfTextCharacterSnapshot[];
}

interface SerializedPageExpectation {
  pageIndex: number;
  originalObjects: PageObjectState[];
  changes: Array<{
    objectIndex: number;
    replacementText: string;
    stablePrefixLength: number;
    originalStableSuffixStart: number;
    replacementStableSuffixStart: number;
  }>;
}

let enginePromise: Promise<PdfiumEngine> | null = null;
let operationChain: Promise<unknown> = Promise.resolve();
const inspectionDocuments = new WeakMap<File, CachedInspectionDocument>();
const inspectionDisabledReasons = new WeakMap<File, string>();

const loadEngine = () => {
  enginePromise ??= (async () => {
    const response = await fetch(pdfiumWasmUrl);
    if (!response.ok) throw new Error('The local PDF text engine could not be loaded.');
    const wasmBinary = await response.arrayBuffer();
    const engine = await init({ wasmBinary }) as PdfiumEngine;
    engine.PDFiumExt_Init();
    return engine;
  })().catch((error) => {
    enginePromise = null;
    throw error;
  });
  return enginePromise;
};

const serializePdfiumOperation = <T>(operation: () => Promise<T>): Promise<T> => {
  const run = operationChain.then(operation, operation);
  operationChain = run.catch(() => undefined);
  return run;
};

const malloc = (engine: PdfiumEngine, size: number) => engine.pdfium.wasmExports.malloc(size);
const free = (engine: PdfiumEngine, pointer: number) => engine.pdfium.wasmExports.free(pointer);

const readFloat32 = (engine: PdfiumEngine, pointer: number) => (
  new DataView(engine.pdfium.HEAPU8.buffer).getFloat32(pointer, true)
);

const readFloat64 = (engine: PdfiumEngine, pointer: number) => (
  new DataView(engine.pdfium.HEAPU8.buffer).getFloat64(pointer, true)
);

const readUint32 = (engine: PdfiumEngine, pointer: number) => (
  new DataView(engine.pdfium.HEAPU8.buffer).getUint32(pointer, true)
);

const readUtf8 = (engine: PdfiumEngine, pointer: number, byteLength: number) => (
  new TextDecoder().decode(engine.pdfium.HEAPU8.slice(pointer, pointer + Math.max(0, byteLength - 1)))
);

const utf16Pointer = (engine: PdfiumEngine, text: string) => {
  const pointer = malloc(engine, (text.length + 1) * 2);
  const view = new DataView(engine.pdfium.HEAPU8.buffer);
  for (let index = 0; index < text.length; index += 1) {
    view.setUint16(pointer + index * 2, text.charCodeAt(index), true);
  }
  view.setUint16(pointer + text.length * 2, 0, true);
  return pointer;
};

const readTextObject = (
  engine: PdfiumEngine,
  object: number,
  textPage: number,
) => {
  const byteLength = engine.FPDFTextObj_GetText(object, textPage, 0, 0);
  if (byteLength <= 2) return '';
  const pointer = malloc(engine, byteLength);
  try {
    engine.FPDFTextObj_GetText(object, textPage, pointer, byteLength);
    return new TextDecoder('utf-16le').decode(
      engine.pdfium.HEAPU8.slice(pointer, pointer + byteLength - 2),
    );
  } finally {
    free(engine, pointer);
  }
};

const readObjectBounds = (engine: PdfiumEngine, object: number): PdfSpaceRect | undefined => {
  const pointers = [
    malloc(engine, 4),
    malloc(engine, 4),
    malloc(engine, 4),
    malloc(engine, 4),
  ] as [number, number, number, number];
  const [leftPointer, bottomPointer, rightPointer, topPointer] = pointers;
  try {
    if (!engine.FPDFPageObj_GetBounds(
      object,
      leftPointer,
      bottomPointer,
      rightPointer,
      topPointer,
    )) return undefined;
    return [
      readFloat32(engine, leftPointer),
      readFloat32(engine, bottomPointer),
      readFloat32(engine, rightPointer),
      readFloat32(engine, topPointer),
    ];
  } finally {
    pointers.forEach((pointer) => free(engine, pointer));
  }
};

const readEffectiveCropBox = (engine: PdfiumEngine, page: number): PdfSpaceRect => {
  const rectPointer = malloc(engine, 16);
  try {
    // PDFium intersects inherited MediaBox/CropBox values in unrotated PDF
    // coordinates, the same space used by its saved object/character bounds.
    if (!engine.FPDF_GetPageBoundingBox(page, rectPointer)) {
      throw new Error('Direct text edit failed: the saved page bounds could not be verified.');
    }
    // FS_RECTF is stored as left, top, right, bottom.
    return [
      readFloat32(engine, rectPointer),
      readFloat32(engine, rectPointer + 12),
      readFloat32(engine, rectPointer + 8),
      readFloat32(engine, rectPointer + 4),
    ];
  } finally {
    free(engine, rectPointer);
  }
};

const readTextObjectFontSize = (engine: PdfiumEngine, object: number) => {
  const sizePointer = malloc(engine, 4);
  try {
    return engine.FPDFTextObj_GetFontSize(object, sizePointer)
      ? readFloat32(engine, sizePointer)
      : undefined;
  } finally {
    free(engine, sizePointer);
  }
};

const readObjectMatrix = (
  engine: PdfiumEngine,
  object: number,
): [number, number, number, number, number, number] | undefined => {
  const matrixPointer = malloc(engine, 24);
  try {
    if (!engine.FPDFPageObj_GetMatrix(object, matrixPointer)) return undefined;
    return Array.from({ length: 6 }, (_, index) => (
      readFloat32(engine, matrixPointer + index * 4)
    )) as [number, number, number, number, number, number];
  } finally {
    free(engine, matrixPointer);
  }
};

const readObjectFillColor = (
  engine: PdfiumEngine,
  object: number,
): [number, number, number, number] | undefined => {
  const pointers = [
    malloc(engine, 4),
    malloc(engine, 4),
    malloc(engine, 4),
    malloc(engine, 4),
  ] as [number, number, number, number];
  try {
    return engine.FPDFPageObj_GetFillColor(object, ...pointers)
      ? pointers.map((pointer) => readUint32(engine, pointer)) as [number, number, number, number]
      : undefined;
  } finally {
    pointers.forEach((pointer) => free(engine, pointer));
  }
};

const classifyFontFamily = (name: string, flags: number): NativePdfTextAppearance['fontFamily'] => {
  const normalized = name.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  if ((flags & 1) !== 0 || /courier|mono|typewriter/.test(normalized)) return 'Courier';
  if ((flags & 2) !== 0 || /times|serif|minion|garamond|georgia|cambria|palatino/.test(normalized)) {
    return 'TimesRoman';
  }
  return 'Helvetica';
};

const readFontName = (engine: PdfiumEngine, font: number) => {
  const byteLength = engine.FPDFFont_GetBaseFontName(font, 0, 0);
  if (byteLength <= 1) return '';
  const pointer = malloc(engine, byteLength);
  try {
    const written = engine.FPDFFont_GetBaseFontName(font, pointer, byteLength);
    return written > 1 ? readUtf8(engine, pointer, written) : '';
  } finally {
    free(engine, pointer);
  }
};

const readEffectiveTextSize = (engine: PdfiumEngine, object: number) => {
  const fontSize = readTextObjectFontSize(engine, object);
  if (!fontSize) return undefined;
  const matrix = readObjectMatrix(engine, object);
  if (!matrix) return fontSize;
  const verticalScale = Math.hypot(matrix[2], matrix[3]);
  return fontSize * (Number.isFinite(verticalScale) && verticalScale > 0 ? verticalScale : 1);
};

const readTextAppearance = (
  engine: PdfiumEngine,
  object: number,
): NativePdfTextAppearance | undefined => {
  const font = engine.FPDFTextObj_GetFont(object);
  const fontSize = readEffectiveTextSize(engine, object);
  if (!font || !fontSize) return undefined;
  const colorPointers = [malloc(engine, 4), malloc(engine, 4), malloc(engine, 4), malloc(engine, 4)];
  const [redPointer, greenPointer, bluePointer, alphaPointer] = colorPointers;
  try {
    const flags = engine.FPDFFont_GetFlags(font);
    const fontName = readFontName(engine, font);
    const hasColor = engine.FPDFPageObj_GetFillColor(object, redPointer, greenPointer, bluePointer, alphaPointer);
    const color = hasColor
      ? `#${[redPointer, greenPointer, bluePointer]
        .map((pointer) => Math.min(255, readUint32(engine, pointer)).toString(16).padStart(2, '0'))
        .join('')}`
      : '#000000';
    const weight = engine.FPDFFont_GetWeight(font);
    return {
      fontFamily: classifyFontFamily(fontName, flags),
      fontSize,
      color,
      fontWeight: Number.isFinite(weight) && weight > 0 ? Math.max(100, Math.min(900, weight)) : 400,
      fontStyle: (flags & 64) !== 0 || /italic|oblique/i.test(fontName) ? 'italic' : 'normal',
    };
  } finally {
    colorPointers.forEach((pointer) => free(engine, pointer));
  }
};

const collectTextObjects = (
  engine: PdfiumEngine,
  page: number,
  textPage: number,
): PdfTextObjectSnapshot[] => {
  const boundPointers = [malloc(engine, 4), malloc(engine, 4), malloc(engine, 4), malloc(engine, 4)];
  const [leftPointer, bottomPointer, rightPointer, topPointer] = boundPointers;
  const charPointers = [malloc(engine, 8), malloc(engine, 8), malloc(engine, 8), malloc(engine, 8)];
  const [charLeftPointer, charRightPointer, charBottomPointer, charTopPointer] = charPointers;
  const objects: PdfTextObjectSnapshot[] = [];
  const objectByPointer = new Map<number, PdfTextObjectSnapshot>();
  const rawCharactersByObject = new Map<number, Array<{
    pageCharacterIndex: number;
    text: string;
    generated: boolean;
    bounds: PdfSpaceRect;
  }>>();

  try {
    const count = engine.FPDFPage_CountObjects(page);
    for (let objectIndex = 0; objectIndex < count; objectIndex += 1) {
      const object = engine.FPDFPage_GetObject(page, objectIndex);
      if (!object || engine.FPDFPageObj_GetType(object) !== PDF_PAGE_OBJECT_TEXT) continue;
      if (engine.FPDFTextObj_GetTextRenderMode(object) === PDF_TEXT_RENDER_MODE_INVISIBLE) continue;
      if (!engine.FPDFPageObj_GetBounds(
        object,
        leftPointer,
        bottomPointer,
        rightPointer,
        topPointer,
      )) continue;

      const snapshot: PdfTextObjectSnapshot = {
        objectIndex,
        text: readTextObject(engine, object, textPage),
        bounds: [
          readFloat32(engine, leftPointer),
          readFloat32(engine, bottomPointer),
          readFloat32(engine, rightPointer),
          readFloat32(engine, topPointer),
        ],
        characters: [],
      };
      objects.push(snapshot);
      objectByPointer.set(object, snapshot);
    }

    const characterCount = engine.FPDFText_CountChars(textPage);
    for (let pageCharacterIndex = 0; pageCharacterIndex < characterCount; pageCharacterIndex += 1) {
      const object = engine.FPDFText_GetTextObject(textPage, pageCharacterIndex);
      const snapshot = objectByPointer.get(object);
      if (!snapshot) continue;
      const unicode = engine.FPDFText_GetUnicode(textPage, pageCharacterIndex);
      if (unicode <= 0 || unicode > 0x10ffff) continue;
      // Kept, not skipped. A PDF that positions each word separately stores no space characters,
      // so every space in this object's text is one the extractor generated. Dropping them leaves
      // a hole in the object's character run at each one, and a word whose text matches its object
      // exactly then fails to map onto it — which is what pushed whole documents onto the redraw
      // path. They are marked instead, and everything that measures or rewrites ink ignores them.
      const generated = engine.FPDFText_IsGenerated(textPage, pageCharacterIndex) === 1;
      const hasBounds = engine.FPDFText_GetCharBox(
        textPage,
        pageCharacterIndex,
        charLeftPointer,
        charRightPointer,
        charBottomPointer,
        charTopPointer,
      );
      if (!hasBounds && !generated) continue;
      const rawCharacters = rawCharactersByObject.get(object) ?? [];
      rawCharacters.push({
        pageCharacterIndex,
        text: String.fromCodePoint(unicode),
        generated,
        bounds: hasBounds
          ? [
            readFloat64(engine, charLeftPointer),
            readFloat64(engine, charBottomPointer),
            readFloat64(engine, charRightPointer),
            readFloat64(engine, charTopPointer),
          ]
          : [0, 0, 0, 0],
      });
      rawCharactersByObject.set(object, rawCharacters);
    }

    for (const [object, snapshot] of objectByPointer) {
      let searchFrom = 0;
      const alignedCharacters: PdfTextCharacterSnapshot[] = [];
      for (const character of rawCharactersByObject.get(object) ?? []) {
        const start = snapshot.text.indexOf(character.text, searchFrom);
        if (start < 0) continue;
        const end = start + character.text.length;
        alignedCharacters.push({ ...character, start, end });
        searchFrom = end;
      }
      snapshot.characters = alignedCharacters;
    }
  } finally {
    [...boundPointers, ...charPointers].forEach((pointer) => free(engine, pointer));
  }

  return objects;
};

const withDocument = async <T>(
  engine: PdfiumEngine,
  bytes: Uint8Array,
  operation: (document: number) => Promise<T> | T,
) => {
  const inputPointer = malloc(engine, bytes.byteLength);
  engine.pdfium.HEAPU8.set(bytes, inputPointer);
  const document = engine.FPDF_LoadMemDocument64(inputPointer, bytes.byteLength, '');
  if (!document) {
    free(engine, inputPointer);
    throw new Error('PDFium could not open this document for direct text editing.');
  }

  try {
    return await operation(document);
  } finally {
    engine.FPDF_CloseDocument(document);
    free(engine, inputPointer);
  }
};

const saveDocument = (engine: PdfiumEngine, document: number) => {
  const writer = engine.PDFiumExt_OpenFileWriter();
  if (!writer) throw new Error('PDFium could not create an output writer.');

  try {
    if (!engine.PDFiumExt_SaveAsCopy(document, writer)) {
      throw new Error('PDFium could not save the direct text edit.');
    }
    const size = engine.PDFiumExt_GetFileWriterSize(writer);
    if (size <= 0) throw new Error('PDFium produced an empty document.');
    const outputPointer = malloc(engine, size);
    try {
      if (!engine.PDFiumExt_GetFileWriterData(writer, outputPointer, size)) {
        throw new Error('PDFium could not read the edited document.');
      }
      return engine.pdfium.HEAPU8.slice(outputPointer, outputPointer + size);
    } finally {
      free(engine, outputPointer);
    }
  } finally {
    engine.PDFiumExt_CloseFileWriter(writer);
  }
};

const pageExists = (engine: PdfiumEngine, document: number, pageIndex: number) => (
  Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < engine.FPDF_GetPageCount(document)
);

const closeInspectionDocument = (file: File) => {
  const cached = inspectionDocuments.get(file);
  if (!cached) return;
  cached.engine.FPDF_CloseDocument(cached.document);
  free(cached.engine, cached.inputPointer);
  inspectionDocuments.delete(file);
};

const openInspectionDocument = async (engine: PdfiumEngine, file: File) => {
  const cached = inspectionDocuments.get(file);
  if (cached) return cached;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inputPointer = malloc(engine, bytes.byteLength);
  engine.pdfium.HEAPU8.set(bytes, inputPointer);
  const document = engine.FPDF_LoadMemDocument64(inputPointer, bytes.byteLength, '');
  if (!document) {
    free(engine, inputPointer);
    throw new Error('PDFium could not open this document for direct text editing.');
  }
  const opened = { engine, inputPointer, document };
  inspectionDocuments.set(file, opened);
  return opened;
};

export const releaseNativePdfTextDocument = (file: File): Promise<void> => (
  serializePdfiumOperation(async () => {
    closeInspectionDocument(file);
    inspectionDisabledReasons.delete(file);
  })
);

const inspectTarget = (
  engine: PdfiumEngine,
  document: number,
  pageIndex: number,
  target: NativePdfTextTarget,
) => {
  if (!pageExists(engine, document, pageIndex)) {
    return { supported: false as const, reason: 'The selected PDF page does not exist.' };
  }
  const page = engine.FPDF_LoadPage(document, pageIndex);
  if (!page) return { supported: false as const, reason: 'The selected PDF page could not be opened.' };
  const textPage = engine.FPDFText_LoadPage(page);
  if (!textPage) {
    engine.FPDF_ClosePage(page);
    return { supported: false as const, reason: 'The selected page has no editable PDF text layer.' };
  }

  try {
    const result = resolveNativePdfTextTarget(collectTextObjects(engine, page, textPage), target);
    if (result.supported) {
      const object = engine.FPDFPage_GetObject(page, result.target.objectIndex);
      result.target.appearance = object ? readTextAppearance(engine, object) : undefined;
    }
    return result;
  } finally {
    engine.FPDFText_ClosePage(textPage);
    engine.FPDF_ClosePage(page);
  }
};

export const inspectNativePdfTextTarget = async (
  file: File,
  pageIndex: number,
  target: NativePdfTextTarget,
): Promise<NativePdfTextCapability> => serializePdfiumOperation(async () => {
  try {
    if (file.size > MAX_NATIVE_TEXT_FILE_BYTES) {
      return {
        supported: false,
        reason: 'Direct text editing is limited to PDFs up to 64 MB to protect this device. Visual fallback is available.',
      };
    }
    const disabledReason = inspectionDisabledReasons.get(file);
    if (disabledReason) return { supported: false, reason: disabledReason };
    const engine = await loadEngine();
    const cached = await openInspectionDocument(engine, file);
    const startedAt = performance.now();
    const result = inspectTarget(engine, cached.document, pageIndex, target);
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > MAX_FIRST_INSPECTION_MS) {
      const reason = 'Direct text analysis is too slow for this PDF on this device. Visual fallback is available.';
      closeInspectionDocument(file);
      inspectionDisabledReasons.set(file, reason);
      return { supported: false, reason };
    }
    if ('reason' in result) return { supported: false, reason: result.reason };
    return {
      supported: true,
      match: {
        pdfRect: result.target.pdfRect,
        sourceRun: {
          text: result.target.objectText,
          start: result.target.start,
          end: result.target.end,
          pdfRect: result.target.objectPdfRect,
        },
        appearance: result.target.appearance,
      },
    };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : 'Direct text editing is unavailable for this word.',
    };
  }
});

const collectPageObjectStates = (
  engine: PdfiumEngine,
  page: number,
  textPage: number,
): PageObjectState[] => {
  const states: PageObjectState[] = [];
  const textSnapshots = new Map(
    collectTextObjects(engine, page, textPage).map((snapshot) => [snapshot.objectIndex, snapshot]),
  );
  const count = engine.FPDFPage_CountObjects(page);
  for (let objectIndex = 0; objectIndex < count; objectIndex += 1) {
    const object = engine.FPDFPage_GetObject(page, objectIndex);
    if (!object) continue;
    const type = engine.FPDFPageObj_GetType(object);
    states.push({
      objectIndex,
      type,
      bounds: readObjectBounds(engine, object),
      text: type === PDF_PAGE_OBJECT_TEXT ? readTextObject(engine, object, textPage) : undefined,
      fontSize: type === PDF_PAGE_OBJECT_TEXT ? readTextObjectFontSize(engine, object) : undefined,
      matrix: readObjectMatrix(engine, object),
      fillColor: readObjectFillColor(engine, object),
      characters: textSnapshots.get(objectIndex)?.characters,
    });
  }
  return states;
};

/** Only the characters the PDF actually stores; generated spacing is not ink and never matches. */
const inkCharacters = (characters: PdfTextCharacterSnapshot[] | undefined) => (
  characters?.filter((character) => !character.generated) ?? []
);

const withoutTrailingWhitespace = (characters: PdfTextCharacterSnapshot[]) => {
  let end = characters.length;
  while (end > 0 && !characters[end - 1].text.trim()) end -= 1;
  return characters.slice(0, end);
};

const closeEnough = (first: number, second: number) => (
  Math.abs(first - second) <= SERIALIZED_BOUNDS_TOLERANCE_POINTS
);

const verifyTextObjectFitsPage = (
  object: Pick<PageObjectState, 'bounds' | 'characters'>,
  cropBox: PdfSpaceRect,
) => {
  if (
    !object.bounds
    || !boundsFitWithinCropBox(object.bounds, cropBox)
    || inkCharacters(object.characters).some((character) => (
      character.text.trim() && !boundsFitWithinCropBox(character.bounds, cropBox)
    ))
  ) {
    throw new Error(PDF_TEXT_OVERFLOW_MESSAGE);
  }
};

/** Verify actual serialized ink, including standard-font overhang and advances. */
export const verifyPdfTextRunsFitWithinPage = async (
  output: Uint8Array,
  runs: PdfTextRunPlacement[],
): Promise<void> => {
  const visibleRuns = runs.filter((run) => run.text.trim());
  if (visibleRuns.length === 0) return;

  return serializePdfiumOperation(async () => {
    const engine = await loadEngine();
    await withDocument(engine, output, (document) => {
      const runsByPage = new Map<number, PdfTextRunPlacement[]>();
      for (const run of visibleRuns) {
        const pageRuns = runsByPage.get(run.pageIndex) ?? [];
        pageRuns.push(run);
        runsByPage.set(run.pageIndex, pageRuns);
      }
      for (const [pageIndex, pageRuns] of runsByPage) {
        const verificationError = 'Visual fallback failed: the saved replacement text could not be verified.';
        if (!pageExists(engine, document, pageIndex)) throw new Error(verificationError);
        const page = engine.FPDF_LoadPage(document, pageIndex);
        if (!page) throw new Error(verificationError);
        const textPage = engine.FPDFText_LoadPage(page);
        if (!textPage) {
          engine.FPDF_ClosePage(page);
          throw new Error(verificationError);
        }
        try {
          const cropBox = readEffectiveCropBox(engine, page);
          const objects = collectTextObjects(engine, page, textPage).map((object) => ({
            ...object,
            matrix: readObjectMatrix(engine, engine.FPDFPage_GetObject(page, object.objectIndex)),
          }));
          for (const run of pageRuns) {
            const matches = objects.filter((object) => object.matrix
              && Math.abs(object.matrix[4] - run.x) <= 0.25
              && Math.abs(object.matrix[5] - run.y) <= 0.25);
            if (!matches.some((object) => object.text === run.text)) throw new Error(verificationError);
            // PDFium suppresses extracted text for some overlapping duplicates.
            // Check every visible object at this baseline, even with empty text.
            for (const object of matches) verifyTextObjectFitsPage(object, cropBox);
          }
        } finally {
          engine.FPDFText_ClosePage(textPage);
          engine.FPDF_ClosePage(page);
        }
      }
    });
  });
};

const verifySerializedOutput = async (
  engine: PdfiumEngine,
  output: Uint8Array,
  expectations: SerializedPageExpectation[],
) => withDocument(engine, output, (document) => {
  for (const expectation of expectations) {
    if (!pageExists(engine, document, expectation.pageIndex)) {
      throw new Error('Direct text edit failed: the saved page could not be reopened.');
    }
    const page = engine.FPDF_LoadPage(document, expectation.pageIndex);
    if (!page) throw new Error('Direct text edit failed: the saved page could not be reopened.');
    const textPage = engine.FPDFText_LoadPage(page);
    if (!textPage) {
      engine.FPDF_ClosePage(page);
      throw new Error('Direct text edit failed: the saved text layer could not be reopened.');
    }

    try {
      const cropBox = readEffectiveCropBox(engine, page);
      const reopenedObjects = collectPageObjectStates(engine, page, textPage);
      if (reopenedObjects.length !== expectation.originalObjects.length) {
        throw new Error('Direct text edit failed: serialized page objects changed unexpectedly.');
      }
      const changes = new Map(expectation.changes.map((change) => [change.objectIndex, change]));
      for (const original of expectation.originalObjects) {
        const reopened = reopenedObjects.find((candidate) => candidate.objectIndex === original.objectIndex);
        if (!reopened || reopened.type !== original.type) {
          throw new Error('Direct text edit failed: a serialized page object changed unexpectedly.');
        }
        if (
          original.fontSize !== undefined
          && (reopened.fontSize === undefined || !closeEnough(original.fontSize, reopened.fontSize))
        ) {
          throw new Error('Direct text edit failed: a serialized PDF font size changed unexpectedly.');
        }
        if (
          original.matrix
          && (!reopened.matrix || original.matrix.some((value, index) => !closeEnough(value, reopened.matrix![index])))
        ) {
          throw new Error('Direct text edit failed: a serialized PDF text transform changed unexpectedly.');
        }
        if (
          original.fillColor
          && (!reopened.fillColor || original.fillColor.some((value, index) => value !== reopened.fillColor![index]))
        ) {
          throw new Error('Direct text edit failed: a serialized PDF text colour changed unexpectedly.');
        }
        const change = changes.get(original.objectIndex);
        if (change) {
          if (!sameSourceRun(reopened.text, change.replacementText)) {
            throw new Error('Direct text edit failed: saved text disagreed with the requested edit.');
          }
          // Check the serialized result with its retained font and transform.
          // The full object also includes any untouched suffix pushed by the
          // replacement, even if the text extractor omits off-page characters.
          if (change.replacementText.trim()) verifyTextObjectFitsPage(reopened, cropBox);
          const stablePrefixCharacters = inkCharacters(original.characters).filter(
            (character) => character.end <= change.stablePrefixLength,
          );
          for (const character of stablePrefixCharacters) {
            const reopenedCharacter = inkCharacters(reopened.characters).find((candidate) => (
              candidate.start === character.start
              && candidate.end === character.end
              && candidate.text === character.text
            ));
            if (
              !reopenedCharacter
              || character.bounds.some((value, index) => !closeEnough(value, reopenedCharacter.bounds[index]))
            ) {
              throw new Error('Direct text edit failed: unedited PDF text moved during serialization.');
            }
          }
          // A shorter replacement widens the gap to the next object, and extractors answer that by
          // generating a trailing space that was never in the file. It is not content, so it is
          // dropped from both sides before the untouched suffix is compared.
          const originalSuffixCharacters = withoutTrailingWhitespace(inkCharacters(original.characters).filter(
            (character) => character.start >= change.originalStableSuffixStart,
          ));
          const reopenedSuffixCharacters = withoutTrailingWhitespace(inkCharacters(reopened.characters).filter(
            (character) => character.start >= change.replacementStableSuffixStart,
          ));
          const suffixCharactersMatch = originalSuffixCharacters.length === reopenedSuffixCharacters.length
            && originalSuffixCharacters.every((character, index) => {
              const reopenedCharacter = reopenedSuffixCharacters[index];
              return reopenedCharacter
                && character.start - change.originalStableSuffixStart
                  === reopenedCharacter.start - change.replacementStableSuffixStart
                && character.end - change.originalStableSuffixStart
                  === reopenedCharacter.end - change.replacementStableSuffixStart
                && character.text === reopenedCharacter.text;
            });
          if (!suffixCharactersMatch) {
            throw new Error('Direct text edit failed: unedited PDF text moved during serialization.');
          }
          if (originalSuffixCharacters.length > 0) {
            const originalAnchor = originalSuffixCharacters[0].bounds;
            const reopenedAnchor = reopenedSuffixCharacters[0].bounds;
            for (let index = 0; index < originalSuffixCharacters.length; index += 1) {
              const originalBounds = originalSuffixCharacters[index].bounds;
              const reopenedBounds = reopenedSuffixCharacters[index].bounds;
              const originalRelativeBounds = [
                originalBounds[0] - originalAnchor[0],
                originalBounds[1] - originalAnchor[1],
                originalBounds[2] - originalAnchor[0],
                originalBounds[3] - originalAnchor[1],
              ];
              const reopenedRelativeBounds = [
                reopenedBounds[0] - reopenedAnchor[0],
                reopenedBounds[1] - reopenedAnchor[1],
                reopenedBounds[2] - reopenedAnchor[0],
                reopenedBounds[3] - reopenedAnchor[1],
              ];
              if (originalRelativeBounds.some((value, boundIndex) => (
                !closeEnough(value, reopenedRelativeBounds[boundIndex])
              ))) {
                throw new Error('Direct text edit failed: unedited PDF text moved during serialization.');
              }
            }
          }
          continue;
        }
        if (!sameSourceRun(original.text, reopened.text)) {
          throw new Error('Direct text edit failed: unrelated PDF text changed during serialization.');
        }
        if (
          original.bounds
          && (!reopened.bounds || original.bounds.some((value, index) => !closeEnough(value, reopened.bounds![index])))
        ) {
          throw new Error('Direct text edit failed: unrelated PDF content moved during serialization.');
        }
      }
    } finally {
      engine.FPDFText_ClosePage(textPage);
      engine.FPDF_ClosePage(page);
    }
  }
});

/** How far outside a run's rectangle a glyph may sit and still count as part of that run. */
const CLEARANCE_TOLERANCE_POINTS = 0.75;

const containedWithin = (bounds: PdfSpaceRect, area: PdfSpaceRect) => (
  bounds[0] >= area[0] - CLEARANCE_TOLERANCE_POINTS
  && bounds[1] >= area[1] - CLEARANCE_TOLERANCE_POINTS
  && bounds[2] <= area[2] + CLEARANCE_TOLERANCE_POINTS
  && bounds[3] <= area[3] + CLEARANCE_TOLERANCE_POINTS
);

type Matrix = [number, number, number, number, number, number];

/** `outer` applied after `inner`, so a nested form's contents land in page coordinates. */
const composeMatrix = (outer: Matrix, inner: Matrix): Matrix => [
  inner[0] * outer[0] + inner[1] * outer[2],
  inner[0] * outer[1] + inner[1] * outer[3],
  inner[2] * outer[0] + inner[3] * outer[2],
  inner[2] * outer[1] + inner[3] * outer[3],
  inner[4] * outer[0] + inner[5] * outer[2] + outer[4],
  inner[4] * outer[1] + inner[5] * outer[3] + outer[5],
];

/** Every corner is carried across, because a rotated form does not keep them in their corners. */
const mapRect = (matrix: Matrix, rect: PdfSpaceRect): PdfSpaceRect => {
  const corners: Array<[number, number]> = [
    [rect[0], rect[1]], [rect[2], rect[1]], [rect[0], rect[3]], [rect[2], rect[3]],
  ];
  const points = corners.map(([x, y]) => [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ]);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

const overlaps = (first: PdfSpaceRect, second: PdfSpaceRect) => (
  Math.min(first[2], second[2]) - Math.max(first[0], second[0]) > 0
  && Math.min(first[3], second[3]) - Math.max(first[1], second[1]) > 0
);

export interface NativePdfTextClearance {
  pageIndex: number;
  pdfRect: PdfSpaceRect;
}

// Form streams can be shared by multiple placements, including placements on other pages.
// PDFium mutates that shared stream when a child is removed. Record all untouched ink before
// doing so and reject the result if saving altered another occurrence.
const collectUntouchedCharacters = (
  engine: PdfiumEngine,
  document: number,
  areasByPage: Map<number, PdfSpaceRect[]>,
) => {
  const characters: Array<{ pageIndex: number; unicode: number; bounds: PdfSpaceRect }> = [];
  const pointers = [malloc(engine, 8), malloc(engine, 8), malloc(engine, 8), malloc(engine, 8)];
  try {
    for (let pageIndex = 0; pageIndex < engine.FPDF_GetPageCount(document); pageIndex += 1) {
      const page = engine.FPDF_LoadPage(document, pageIndex);
      if (!page) throw new Error('Direct text edit failed: unrelated page content could not be checked.');
      let textPage = 0;
      try {
        textPage = engine.FPDFText_LoadPage(page);
        if (!textPage) throw new Error('Direct text edit failed: unrelated page text could not be checked.');
        const areas = areasByPage.get(pageIndex) ?? [];
        for (let index = 0; index < engine.FPDFText_CountChars(textPage); index += 1) {
          if (engine.FPDFText_IsGenerated(textPage, index) === 1) continue;
          const unicode = engine.FPDFText_GetUnicode(textPage, index);
          if (!unicode) continue;
          if (!engine.FPDFText_GetCharBox(textPage, index, ...pointers as [number, number, number, number])) {
            throw new Error('Direct text edit failed: unrelated text bounds could not be checked.');
          }
          const bounds: PdfSpaceRect = [
            readFloat64(engine, pointers[0]), readFloat64(engine, pointers[2]),
            readFloat64(engine, pointers[1]), readFloat64(engine, pointers[3]),
          ];
          if (!areas.some((area) => containedWithin(bounds, area))) {
            characters.push({ pageIndex, unicode, bounds });
          }
        }
      } finally {
        if (textPage) engine.FPDFText_ClosePage(textPage);
        engine.FPDF_ClosePage(page);
      }
    }
  } finally {
    pointers.forEach((pointer) => free(engine, pointer));
  }
  return characters.sort((a, b) => a.pageIndex - b.pageIndex || a.unicode - b.unicode
    || a.bounds[0] - b.bounds[0] || a.bounds[1] - b.bounds[1]);
};

/**
 * Remove the text objects sitting inside a redrawn paragraph's own rectangles.
 *
 * A redraw paints the paragraph's area over and writes the new words on top, so whatever the PDF
 * drew there has to come out of the file as well — otherwise the old wording is still in the
 * content stream and still turns up in search and copy, which is exactly what someone editing a
 * name or a figure out of a document does not expect.
 *
 * Removing by area rather than by matching text is what makes this reliable. The previous approach
 * asked the PDF engine to find one text object whose whole text equalled a word the reader could
 * see, which fails whenever a document sets its words with individually positioned glyphs — a form
 * that draws "1040" as four separate objects, or anything typeset by TeX. Geometry has no such
 * blind spot: an object either lies inside the area being repainted or it does not.
 *
 * Objects that straddle the edge are deliberately left alone. A line that runs on past the
 * paragraph is not this paragraph's to delete, and leaving it is visibly better than cutting away
 * text the reader never touched.
 */
export const clearNativePdfTextInAreas = async (
  input: Uint8Array,
  clearances: NativePdfTextClearance[],
): Promise<{ bytes: Uint8Array; uncleared: number }> => {
  if (clearances.length === 0) return { bytes: input, uncleared: 0 };

  return serializePdfiumOperation(async () => {
    const engine = await loadEngine();
    return withDocument(engine, input, async (document) => {
      const areasByPage = new Map<number, PdfSpaceRect[]>();
      clearances.forEach((clearance) => {
        const areas = areasByPage.get(clearance.pageIndex) ?? [];
        areas.push(clearance.pdfRect);
        areasByPage.set(clearance.pageIndex, areas);
      });

      let removed = 0;
      let uncleared = 0;
      let untouchedCharacters: ReturnType<typeof collectUntouchedCharacters> | undefined;
      for (const [pageIndex, areas] of areasByPage) {
        if (!pageExists(engine, document, pageIndex)) continue;
        const page = engine.FPDF_LoadPage(document, pageIndex);
        if (!page) continue;
        const pointers = [malloc(engine, 4), malloc(engine, 4), malloc(engine, 4), malloc(engine, 4)];
        const [leftPointer, bottomPointer, rightPointer, topPointer] = pointers;

        /**
         * Remove the text this area covers, following the page into any form it draws.
         *
         * A page can draw part of itself through a form — that is how a stamp, a watermark or an
         * imposed page carries its text — and the objects inside one are not reachable from the
         * page. Walking only the top level leaves that text in the file after the paragraph above
         * it has been repainted, where a search still finds the words the reader thought they had
         * replaced. The form's own contents come out through the form instead, and their bounds
         * are stated in the form's coordinates, so they are carried into the page's by its matrix
         * before being compared with the area.
         */
        const clearWithin = (
          owner: number,
          count: number,
          childAt: (index: number) => number,
          toPage: [number, number, number, number, number, number],
          isPage: boolean,
        ) => {
          // Backwards, so removing one object does not renumber the ones still to be examined.
          for (let index = count - 1; index >= 0; index -= 1) {
            const object = childAt(index);
            if (!object) continue;
            const type = engine.FPDFPageObj_GetType(object);

            if (type === PDF_PAGE_OBJECT_FORM) {
              const own = readObjectMatrix(engine, object);
              clearWithin(
                object,
                engine.FPDFFormObj_CountObjects(object),
                (child) => engine.FPDFFormObj_GetObject(object, child),
                own ? composeMatrix(toPage, own) : toPage,
                false,
              );
              continue;
            }

            if (type !== PDF_PAGE_OBJECT_TEXT) continue;
            if (!engine.FPDFPageObj_GetBounds(object, leftPointer, bottomPointer, rightPointer, topPointer)) continue;
            const bounds = mapRect(toPage, [
              readFloat32(engine, leftPointer),
              readFloat32(engine, bottomPointer),
              readFloat32(engine, rightPointer),
              readFloat32(engine, topPointer),
            ]);
            if (!areas.some((area) => overlaps(bounds, area))) continue;
            if (!areas.some((area) => containedWithin(bounds, area))) {
              uncleared += 1;
              continue;
            }
            // A page owns its objects and hands them back to be destroyed; a form destroys its own.
            if (isPage) {
              if (engine.FPDFPage_RemoveObject(page, object)) {
                engine.FPDFPageObj_Destroy(object);
                removed += 1;
              } else {
                uncleared += 1;
              }
            } else {
              untouchedCharacters ??= collectUntouchedCharacters(engine, document, areasByPage);
              if (engine.FPDFFormObj_RemoveObject(owner, object)) removed += 1;
              else uncleared += 1;
            }
          }
        };

        try {
          clearWithin(
            page,
            engine.FPDFPage_CountObjects(page),
            (index) => engine.FPDFPage_GetObject(page, index),
            [1, 0, 0, 1, 0, 0],
            true,
          );
          if (removed > 0 && !engine.FPDFPage_GenerateContent(page)) {
            throw new Error('Direct text edit failed: the page could not be rewritten after removing its old text.');
          }
        } finally {
          pointers.forEach((pointer) => free(engine, pointer));
          engine.FPDF_ClosePage(page);
        }
      }

      const bytes = removed > 0 ? saveDocument(engine, document) : input;
      if (untouchedCharacters) {
        const original = untouchedCharacters;
        await withDocument(engine, bytes, (saved) => {
          const actual = collectUntouchedCharacters(engine, saved, areasByPage);
          if (actual.length !== original.length || original.some((character, index) => (
            character.pageIndex !== actual[index].pageIndex
            || character.unicode !== actual[index].unicode
            || character.bounds.some((bound, side) => !closeEnough(bound, actual[index].bounds[side]))
          ))) {
            throw new Error('Direct text edit failed: removing a shared form would change text outside the edited paragraph.');
          }
        });
      }
      return { bytes, uncleared };
    });
  });
};

export const applyNativePdfTextEdits = async (
  input: Uint8Array,
  edits: NativePdfTextEdit[],
): Promise<Uint8Array> => {
  if (edits.length === 0) return input;

  return serializePdfiumOperation(async () => {
    const engine = await loadEngine();
    return withDocument(engine, input, async (document) => {
      const serializedExpectations: SerializedPageExpectation[] = [];
      const editsByPage = new Map<number, NativePdfTextEdit[]>();
      edits.forEach((edit) => {
        const pageEdits = editsByPage.get(edit.pageIndex) ?? [];
        pageEdits.push(edit);
        editsByPage.set(edit.pageIndex, pageEdits);
      });

      for (const [pageIndex, pageEdits] of editsByPage) {
        if (!pageExists(engine, document, pageIndex)) {
          throw new Error(`Direct text edit failed: page ${pageIndex + 1} does not exist.`);
        }
        const page = engine.FPDF_LoadPage(document, pageIndex);
        if (!page) throw new Error(`Direct text edit failed: page ${pageIndex + 1} could not be opened.`);
        let textPage = engine.FPDFText_LoadPage(page);
        if (!textPage) {
          engine.FPDF_ClosePage(page);
          throw new Error(`Direct text edit failed: page ${pageIndex + 1} has no text layer.`);
        }

        try {
          const objects = collectTextObjects(engine, page, textPage);
          const originalObjects = collectPageObjectStates(engine, page, textPage);
          const rawPlan = planNativePdfTextEdits(objects, pageEdits as PlannedNativePdfTextEdit[]);
          if ('reason' in rawPlan) {
            throw new Error(`Direct text edit failed: ${rawPlan.reason}`);
          }
          // PDFium aborts when a text object is set to the empty string, so an object whose whole
          // content is removed keeps a single space. It draws nothing, and it means deleting the
          // last word of a run behaves like deleting any other word instead of trapping.
          const plan = {
            ...rawPlan,
            changes: rawPlan.changes.map((change) => (
              change.replacementText === '' ? { ...change, replacementText: ' ' } : change
            )),
          };
          serializedExpectations.push({
            pageIndex,
            originalObjects,
            changes: plan.changes.map(({ objectIndex, originalText, replacementText }) => {
              let stablePrefixLength = 0;
              const maxPrefixLength = Math.min(originalText.length, replacementText.length);
              while (
                stablePrefixLength < maxPrefixLength
                && originalText[stablePrefixLength] === replacementText[stablePrefixLength]
              ) stablePrefixLength += 1;
              let stableSuffixLength = 0;
              const maxSuffixLength = Math.min(
                originalText.length - stablePrefixLength,
                replacementText.length - stablePrefixLength,
              );
              while (
                stableSuffixLength < maxSuffixLength
                && originalText[originalText.length - stableSuffixLength - 1]
                  === replacementText[replacementText.length - stableSuffixLength - 1]
              ) stableSuffixLength += 1;
              return {
                objectIndex,
                replacementText,
                stablePrefixLength,
                originalStableSuffixStart: originalText.length - stableSuffixLength,
                replacementStableSuffixStart: replacementText.length - stableSuffixLength,
              };
            }),
          });

          for (const change of plan.changes) {
            if (change.originalText === change.replacementText) continue;
            const object = engine.FPDFPage_GetObject(page, change.objectIndex);
            if (!object || engine.FPDFPageObj_GetType(object) !== PDF_PAGE_OBJECT_TEXT) {
              throw new Error('Direct text edit failed: the source text object changed before save.');
            }
            const textPointer = utf16Pointer(engine, change.replacementText);
            try {
              if (!engine.FPDFText_SetText(object, textPointer)) {
                throw new Error('Direct text edit failed: the original font cannot draw the replacement text.');
              }
            } finally {
              free(engine, textPointer);
            }
          }

          engine.FPDFText_ClosePage(textPage);
          textPage = 0;
          if (!engine.FPDFPage_GenerateContent(page)) {
            throw new Error(`Direct text edit failed: page ${pageIndex + 1} could not be regenerated.`);
          }

          const verificationTextPage = engine.FPDFText_LoadPage(page);
          if (!verificationTextPage) {
            throw new Error('Direct text edit failed: the saved text could not be verified.');
          }
          try {
            for (const change of plan.changes) {
              const object = engine.FPDFPage_GetObject(page, change.objectIndex);
              const verified = object
                && engine.FPDFPageObj_GetType(object) === PDF_PAGE_OBJECT_TEXT
                // Text extractors add a trailing space of their own when the next object starts
                // after a gap, so the comparison ignores whitespace at the very end.
                && sameSourceRun(readTextObject(engine, object, verificationTextPage), change.replacementText);
              if (!verified) {
                throw new Error('Direct text edit failed: the saved text did not read back as written.');
              }
            }
          } finally {
            engine.FPDFText_ClosePage(verificationTextPage);
          }
        } finally {
          if (textPage) engine.FPDFText_ClosePage(textPage);
          engine.FPDF_ClosePage(page);
        }
      }

      const output = saveDocument(engine, document);
      await verifySerializedOutput(engine, output, serializedExpectations);
      return output;
    });
  });
};
