import 'regenerator-runtime/runtime.js';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

export type EmbeddedPdfFontId = `Embedded${number}`;
export type ShapingFace = {
  unitsPerEm: number;
  numGlyphs: number;
  cff?: unknown;
  'OS/2'?: { fsType?: { noEmbedding?: boolean; viewOnly?: boolean; bitmapOnly?: boolean } };
  cmap?: { tables?: Array<{ platformID: number; encodingID: number }> };
  hasGlyphForCodePoint: (codePoint: number) => boolean;
  layout: (text: string) => {
    direction: string;
    script: string;
    glyphs: Array<{ id: number; advanceWidth: number }>;
    positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  };
};

export interface EmbeddedPdfFont {
  bytes: Uint8Array;
  face: ShapingFace;
  cssFamily: string;
  browserFace?: FontFace;
}

const fonts = new Map<EmbeddedPdfFontId, EmbeddedPdfFont>();
const loads = new WeakMap<File, { promise: Promise<void>; active: boolean; ids: Set<EmbeddedPdfFontId> }>();
const documentFonts = new WeakMap<File, Map<string, EmbeddedPdfFontId>>();
let nextFont = 1;

/**
 * Subsets written by macOS and iOS often map characters only through the old Mac table.
 * The PDF writer reads that table, but WebKit draws such a font with blank and stand-in
 * letters, so only a font with a Unicode table is handed to the browser.
 */
export const browserCanDrawFont = (face: Pick<ShapingFace, 'cmap'>): boolean =>
  face.cmap?.tables?.some(({ platformID, encodingID }) =>
    platformID === 0 || (platformID === 3 && (encodingID === 1 || encodingID === 10))) ?? false;

export const embeddedPdfFont = (id: EmbeddedPdfFontId) => fonts.get(id);
export const documentEmbeddedFontsReady = (file: File) => documentFonts.has(file);

/** Read the original font stream, rather than PDF.js's browser-rewritten copy of it. */
export const loadDocumentEmbeddedFonts = (file: File): Promise<void> => {
  const previous = loads.get(file);
  if (previous) return previous.promise;
  const load = { promise: Promise.resolve(), active: true, ids: new Set<EmbeddedPdfFontId>() };
  load.promise = (async () => {
    const pdf = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
    const module = await import('@pdf-lib/fontkit');
    const fontkit = (module as any).default ?? module;
    const matched = new Map<string, EmbeddedPdfFontId>();
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (!load.active) return;
      if (!(object instanceof PDFDict) || object.get(PDFName.of('Type'))?.toString() !== '/FontDescriptor') continue;
      const nameObject = object.get(PDFName.of('FontName'));
      const name = nameObject instanceof PDFName ? nameObject.decodeText() : null;
      const streamRef = object.get(PDFName.of('FontFile2')) ?? object.get(PDFName.of('FontFile3'));
      if (!name || !streamRef || matched.has(name)) continue;
      const stream = pdf.context.lookup(streamRef);
      if (!(stream instanceof PDFRawStream)) continue;
      try {
        const bytes = decodePDFRawStream(stream).decode();
        const face = fontkit.create(bytes) as ShapingFace;
        const rights = face['OS/2']?.fsType;
        if (!face.unitsPerEm || !face.numGlyphs || typeof face.layout !== 'function'
          || typeof face.hasGlyphForCodePoint !== 'function'
          || rights?.noEmbedding || rights?.viewOnly || rights?.bitmapOnly) continue;
        const id: EmbeddedPdfFontId = `Embedded${nextFont++}`;
        const cssFamily = `PDF Chef ${id}`;
        let browserFace: FontFace | undefined;
        if (typeof document !== 'undefined' && typeof FontFace !== 'undefined' && browserCanDrawFont(face)) {
          browserFace = new FontFace(cssFamily, bytes.slice().buffer);
          await browserFace.load();
          if (!load.active) return;
          document.fonts.add(browserFace);
        }
        fonts.set(id, { bytes, face, cssFamily, browserFace });
        load.ids.add(id);
        matched.set(name, id);
        // PDFName escapes spaces as #20; PDF.js reports the decoded PostScript name.
        matched.set(nameObject!.toString().slice(1), id);
      } catch {
        // Some subsets lack a usable Unicode cmap or font program. Keep the existing fallback.
      }
    }
    if (load.active) documentFonts.set(file, matched);
  })().catch(() => { if (load.active) documentFonts.set(file, new Map()); });
  loads.set(file, load);
  return load.promise;
};

/** Release both parsed font programs and browser faces, including a load still in progress. */
export const releaseDocumentEmbeddedFonts = (file: File): void => {
  const load = loads.get(file);
  if (load) {
    load.active = false;
    for (const id of load.ids) {
      const browserFace = fonts.get(id)?.browserFace;
      if (browserFace && typeof document !== 'undefined') document.fonts.delete(browserFace);
      fonts.delete(id);
    }
  }
  loads.delete(file);
  documentFonts.delete(file);
};

export const canDrawEmbeddedText = (text: string, id: EmbeddedPdfFontId): boolean => {
  const face = fonts.get(id)?.face;
  if (!face) return false;
  try {
    for (const line of text.replace(/\t/g, '    ').split(/\r\n|\r|\n/)) {
      for (const character of line) {
        const codePoint = character.codePointAt(0)!;
        if (/\s/u.test(character) || codePoint === 0x200c || codePoint === 0x200d) continue;
        if (!face.hasGlyphForCodePoint(codePoint)) return false;
      }
      if (face.layout(line).glyphs.some(glyph => glyph.id === 0 || glyph.id >= face.numGlyphs)) return false;
    }
    return true;
  } catch {
    return false;
  }
};

export const matchingEmbeddedPdfFont = (
  file: File | undefined, psName: string | undefined, text: string,
): EmbeddedPdfFontId | null => {
  const id = file && psName ? documentFonts.get(file)?.get(psName) : undefined;
  return id && canDrawEmbeddedText(text, id) ? id : null;
};

/** The ordinary PDF writer cannot position marks or apply bidirectional text layout. */
export const matchingSimpleEmbeddedPdfFont = (
  file: File | undefined, psName: string | undefined, text: string,
): EmbeddedPdfFontId | null => {
  const id = matchingEmbeddedPdfFont(file, psName, text);
  if (!id) return null;
  const face = fonts.get(id)!.face;
  try {
    if (/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)) return null;
    // A Latin-leading line can report ltr even though an embedded Hebrew/Arabic stretch needs bidi.
    for (const character of new Set(text)) {
      if (character.codePointAt(0)! > 0x7f && face.layout(character).direction !== 'ltr') return null;
    }
    for (const line of text.replace(/\t/g, '    ').split(/\r\n|\r|\n/)) {
      if (!line) continue;
      const run = face.layout(line);
      if (run.direction !== 'ltr' || run.positions.length !== run.glyphs.length) return null;
      const simpleKerning = ['latn', 'grek', 'cyrl', 'zzzz', 'zyyy'].includes(run.script);
      if (run.positions.some((position, index) => position.xOffset !== 0 || position.yOffset !== 0
        || position.yAdvance !== 0 || (!simpleKerning && position.xAdvance !== run.glyphs[index].advanceWidth))) return null;
    }
    return id;
  } catch { return null; }
};

export const measureEmbeddedText = (text: string, id: EmbeddedPdfFontId, size: number): number => {
  const face = fonts.get(id)?.face;
  if (!face) throw new Error('The document font is not loaded');
  // pdf-lib's Latin writer emits glyph advances without applying OpenType positioning.
  return face.layout(text.replace(/\t/g, '    ')).glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0)
    * size / face.unitsPerEm;
};
