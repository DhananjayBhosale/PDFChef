import 'regenerator-runtime/runtime.js';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  PDFPage,
  PDFFont,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFillingColor,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  type Color,
} from 'pdf-lib';

import {
  embeddedPdfFont,
  matchingEmbeddedPdfFont,
  type EmbeddedPdfFontId,
  type ShapingFace,
} from './pdfEmbeddedFonts.ts';
export {
  loadDocumentEmbeddedFonts as loadDocumentDevanagariFonts,
  documentEmbeddedFontsReady as documentDevanagariFontsReady,
} from './pdfEmbeddedFonts.ts';

/** PDF standard fonts cannot encode this script, and Unicode code points alone do not shape it. */
export const hasDevanagari = (text: string) => /[\u0900-\u097f]/u.test(text);

type BundledFontId = 'MuktaRegular' | 'MuktaBold' | 'MartelRegular' | 'MartelBold';
export type DevanagariFontId = BundledFontId | EmbeddedPdfFontId;

const fontAssets: Record<BundledFontId, { url: string; cssFamily: string }> = {
  MuktaRegular: { url: new URL('../assets/fonts/pdf-edit/Mukta-Regular.ttf', import.meta.url).href, cssFamily: 'PDF Chef Mukta Regular' },
  MuktaBold: { url: new URL('../assets/fonts/pdf-edit/Mukta-Bold.ttf', import.meta.url).href, cssFamily: 'PDF Chef Mukta Bold' },
  MartelRegular: { url: new URL('../assets/fonts/pdf-edit/Martel-Regular.ttf', import.meta.url).href, cssFamily: 'PDF Chef Martel Regular' },
  MartelBold: { url: new URL('../assets/fonts/pdf-edit/Martel-Bold.ttf', import.meta.url).href, cssFamily: 'PDF Chef Martel Bold' },
};

interface LoadedFont {
  bytes: Uint8Array;
  face: ShapingFace;
  cssFamily: string;
}

const loadedFonts = new Map<DevanagariFontId, LoadedFont>();
let loadingFonts: Promise<void> | null = null;

export const devanagariFontId = (klass: 'serif' | 'sans-serif' | 'monospace', bold: boolean): DevanagariFontId => (
  klass === 'serif' ? (bold ? 'MartelBold' : 'MartelRegular') : (bold ? 'MuktaBold' : 'MuktaRegular')
);

export const devanagariCssFamily = (id: DevanagariFontId) => `"${(loadedFonts.get(id) ?? embeddedPdfFont(id as EmbeddedPdfFontId))?.cssFamily ?? fontAssets[id as BundledFontId]?.cssFamily}", sans-serif`;

/** Load only when the editor encounters Devanagari; the same TTF drives preview and PDF export. */
export const loadDevanagariFonts = async (
  readBytes: (id: DevanagariFontId, url: string) => Promise<Uint8Array> = async (_id, url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load Devanagari font (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  },
): Promise<void> => {
  if ((Object.keys(fontAssets) as BundledFontId[]).every((id) => loadedFonts.has(id))) return;
  if (loadingFonts) return loadingFonts;
  loadingFonts = (async () => {
    const module = await import('@pdf-lib/fontkit');
    const fontkit = (module as any).default ?? module;
    await Promise.all((Object.entries(fontAssets) as Array<[BundledFontId, typeof fontAssets[BundledFontId]]>).map(async ([id, asset]) => {
      if (loadedFonts.has(id)) return;
      const bytes = await readBytes(id, asset.url);
      const face = fontkit.create(bytes) as ShapingFace;
      if (!face.unitsPerEm || !face.numGlyphs || !face.hasGlyphForCodePoint(0x0915)) throw new Error(`Invalid Devanagari font: ${id}`);
      if (typeof document !== 'undefined' && typeof FontFace !== 'undefined') {
        const browserFace = new FontFace(asset.cssFamily, bytes.slice().buffer);
        await browserFace.load();
        document.fonts.add(browserFace);
      }
      loadedFonts.set(id, { bytes, face, cssFamily: asset.cssFamily });
    }));
  })().finally(() => { loadingFonts = null; });
  return loadingFonts;
};

export const devanagariFontsReady = () => (Object.keys(fontAssets) as BundledFontId[]).every((id) => loadedFonts.has(id));
/** Reuse the document's font when it can shape the entire replacement. */
export const matchingDevanagariFont = (
  file: File | undefined, psName: string | undefined, text: string,
): EmbeddedPdfFontId | null => {
  const id = matchingEmbeddedPdfFont(file, psName, text);
  // This positioned writer uses CIDToGIDMap, which is defined only for TrueType CID fonts.
  return id && !embeddedPdfFont(id)?.face.cff ? id : null;
};

export const selectDevanagariFont = (
  file: File | undefined, psName: string | undefined, text: string,
  klass: 'serif' | 'sans-serif' | 'monospace', bold: boolean, preserveOriginal = true,
): DevanagariFontId => {
  const original = preserveOriginal ? matchingDevanagariFont(file, psName, text) : null;
  if (original) return original;
  const preferred = devanagariFontId(klass, bold);
  if (canShapeDevanagari(text, preferred)) return preferred;
  const alternate = devanagariFontId(klass === 'serif' ? 'sans-serif' : 'serif', bold);
  return canShapeDevanagari(text, alternate) ? alternate : preferred;
};

const fontFor = (id: DevanagariFontId): LoadedFont => {
  const font = loadedFonts.get(id) ?? embeddedPdfFont(id as EmbeddedPdfFontId);
  if (!font) throw new Error('Devanagari fonts are still loading');
  return font;
};

/** Code point coverage alone is insufficient; the shaped line must produce valid glyphs. */
export const canShapeDevanagari = (text: string, id: DevanagariFontId): boolean => {
  const face = (loadedFonts.get(id) ?? embeddedPdfFont(id as EmbeddedPdfFontId))?.face;
  if (!face) return false;
  try {
    for (const line of text.replace(/\t/g, '    ').split(/\r\n|\r|\n/)) {
      for (const character of line) {
        const codePoint = character.codePointAt(0)!;
        if (/\s/u.test(character) || codePoint === 0x200c || codePoint === 0x200d) continue;
        if (!face.hasGlyphForCodePoint(codePoint)) return false;
      }
      if (face.layout(line).glyphs.some((glyph) => glyph.id === 0 || glyph.id >= face.numGlyphs)) return false;
    }
    return true;
  } catch {
    return false;
  }
};

export const measureDevanagariText = (text: string, id: DevanagariFontId, size: number): number => {
  const face = fontFor(id).face;
  return face.layout(text.replace(/\t/g, '    ')).positions.reduce((sum, position) => sum + position.xAdvance, 0)
    * size / face.unitsPerEm;
};

const utf16Hex = (text: string) => Array.from({ length: text.length }, (_, index) =>
  text.charCodeAt(index).toString(16).padStart(4, '0')).join('').toUpperCase();

interface EmbeddedFont {
  font: PDFFont;
  face: ShapingFace;
  nextCid: number;
  gids: number[];
  unicode: string[];
  widths: number[];
}

export interface ShapedLinePiece {
  text: string;
  fontId: DevanagariFontId;
  italic?: boolean;
  x: number;
  y: number;
  width: number;
  fontSize?: number;
}

/**
 * Draw positioned OpenType glyphs as vector PDF text. A separate invisible logical text run keeps
 * copy, search, and the editor's next import in Unicode order, including pre-base vowel signs.
 * The visible glyphs carry empty ActualText for readers that honor it and soft-hyphen mappings
 * for PDF.js, which currently ignores ActualText. Both readers then see only the logical run.
 */
export class DevanagariPdfWriter {
  private readonly fonts = new Map<DevanagariFontId, EmbeddedFont>();
  private readonly pageKeys = new Map<PDFPage, Map<DevanagariFontId, PDFName>>();
  private readonly document: PDFDocument;

  constructor(document: PDFDocument) { this.document = document; }

  private async font(id: DevanagariFontId): Promise<EmbeddedFont> {
    const existing = this.fonts.get(id);
    if (existing) return existing;
    const loaded = fontFor(id);
    const module = await import('@pdf-lib/fontkit');
    this.document.registerFontkit((module as any).default ?? module);
    const font = await this.document.embedFont(loaded.bytes, { subset: false });
    await font.embed();
    const embedded = { font, face: loaded.face, nextCid: 1, gids: [0], unicode: [''], widths: [0] };
    this.fonts.set(id, embedded);
    return embedded;
  }

  private pageKey(page: PDFPage, id: DevanagariFontId, font: PDFFont): PDFName {
    let keys = this.pageKeys.get(page);
    if (!keys) { keys = new Map(); this.pageKeys.set(page, keys); }
    let key = keys.get(id);
    if (!key) {
      key = page.node.newFontDictionary(font.name, font.ref);
      keys.set(id, key);
    }
    return key;
  }

  private cid(state: EmbeddedFont, gid: number, unicode: string, width: number): string {
    if (state.nextCid > 0xffff) throw new Error('This paragraph exceeds the PDF font character limit');
    const cid = state.nextCid++;
    state.gids[cid] = gid;
    state.unicode[cid] = unicode;
    state.widths[cid] = Number.isFinite(width) ? Math.max(0, width) : 0;
    return cid.toString(16).padStart(4, '0');
  }

  async drawLine(page: PDFPage, pieces: ShapedLinePiece[], fontSize: number, color: Color, rotationDegrees: number): Promise<void> {
    if (pieces.length === 0) return;
    const angle = rotationDegrees * Math.PI / 180;
    const a = Math.cos(angle), b = Math.sin(angle), c = -b, d = a;
    const emptyActualText = this.document.context.obj({ ActualText: PDFHexString.fromText('') });
    page.pushOperators(
      pushGraphicsState(),
      PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('Span'), emptyActualText as any]),
      beginText(),
      setFillingColor(color),
    );
    for (const piece of pieces) {
      const size = piece.fontSize ?? fontSize;
      const state = await this.font(piece.fontId);
      const key = this.pageKey(page, piece.fontId, state.font);
      page.pushOperators(setFontAndSize(key, size));
      const slant = piece.italic && !piece.fontId.startsWith('Embedded') ? 0.2 : 0;
      let advance = 0;
      const shaped = state.face.layout(piece.text);
      if (shaped.glyphs.some((glyph) => glyph.id === 0 || glyph.id >= state.face.numGlyphs)) throw new Error('The selected font cannot draw this paragraph');
      shaped.glyphs.forEach((glyph, index) => {
        const position = shaped.positions[index];
        const dx = (advance + position.xOffset) * size / state.face.unitsPerEm;
        const dy = position.yOffset * size / state.face.unitsPerEm;
        const x = piece.x + a * dx + c * dy;
        const y = piece.y + b * dx + d * dy;
        const code = this.cid(state, glyph.id, '00AD', glyph.advanceWidth * 1000 / state.face.unitsPerEm);
        page.pushOperators(setTextMatrix(a, b, c + a * slant, d + b * slant, x, y), showText(PDFHexString.of(code)));
        advance += position.xAdvance;
      });
    }
    page.pushOperators(endText(), PDFOperator.of(PDFOperatorNames.EndMarkedContent), popGraphicsState());

    // One hidden run per line avoids space guesses between the visible, individually positioned glyphs.
    const first = pieces[0];
    const logicalText = pieces.map((piece) => piece.text).join('');
    const logicalCharacters = [...logicalText];
    if (logicalCharacters.length === 0) return;
    const state = await this.font(first.fontId);
    const key = this.pageKey(page, first.fontId, state.font);
    const width = Math.max(0, pieces.reduce((sum, piece) => sum + piece.width, 0));
    const glyphWidth = width / logicalCharacters.length / fontSize * 1000;
    const codes = logicalCharacters.map((character) => this.cid(state, 0, utf16Hex(character), glyphWidth)).join('');
    page.pushOperators(
      pushGraphicsState(), beginText(), setFontAndSize(key, fontSize), setTextRenderingMode(3),
      setTextMatrix(a, b, c, d, first.x, first.y), showText(PDFHexString.of(codes)),
      endText(), popGraphicsState(),
    );
  }

  /** Replace pdf-lib's one-to-one cmap with this export's visible glyphs and logical text CIDs. */
  finish(): void {
    for (const state of this.fonts.values()) {
      const dictionary = this.document.context.lookup(state.font.ref, PDFDict);
      const descendants = dictionary.lookup(PDFName.of('DescendantFonts'), PDFArray);
      const descendant = descendants.lookup(0, PDFDict);
      const glyphMap = new Uint8Array(state.nextCid * 2);
      const widths: Array<number | number[]> = [];
      const entries: string[] = [];
      for (let cid = 1; cid < state.nextCid; cid += 1) {
        const gid = state.gids[cid];
        glyphMap[cid * 2] = gid >> 8;
        glyphMap[cid * 2 + 1] = gid & 0xff;
        widths.push(cid, [state.widths[cid]]);
        entries.push(`<${cid.toString(16).padStart(4, '0')}> <${state.unicode[cid]}>`);
      }
      descendant.set(PDFName.of('CIDToGIDMap'), this.document.context.register(this.document.context.flateStream(glyphMap)));
      descendant.set(PDFName.of('W'), this.document.context.obj(widths));
      const sections: string[] = [];
      for (let start = 0; start < entries.length; start += 100) {
        const chunk = entries.slice(start, start + 100);
        sections.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
      }
      const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000><ffff>\nendcodespacerange\n${sections.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
      dictionary.set(PDFName.of('ToUnicode'), this.document.context.register(this.document.context.flateStream(cmap)));
    }
  }
}
