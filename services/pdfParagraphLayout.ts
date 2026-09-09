import { StandardFontEmbedder, StandardFonts } from 'pdf-lib';
import type { ParagraphFace } from './pdfDocument';
import { substituteForStandardFont } from './pdfFontResolution.ts';

type StandardParagraphFace = { family: string; bold?: boolean; italic?: boolean };
type ParagraphStandardFontKey = Exclude<keyof typeof StandardFonts, 'Symbol' | 'ZapfDingbats'>;

/** The redraw preview and PDF writer must choose the same face, including its style. */
export const paragraphStandardFontKey = (face: StandardParagraphFace): ParagraphStandardFontKey =>
  face.family === 'TimesRoman'
    ? face.bold && face.italic ? 'TimesRomanBoldItalic' : face.bold ? 'TimesRomanBold' : face.italic ? 'TimesRomanItalic' : 'TimesRoman'
    : face.family === 'Courier'
      ? face.bold && face.italic ? 'CourierBoldOblique' : face.bold ? 'CourierBold' : face.italic ? 'CourierOblique' : 'Courier'
      : face.bold && face.italic ? 'HelveticaBoldOblique' : face.bold ? 'HelveticaBold' : face.italic ? 'HelveticaOblique' : 'Helvetica';

const exportText = (text: string) => substituteForStandardFont(text).text.replace(/\t/g, '    ');

const metricFaces = new Map<ParagraphStandardFontKey, StandardFontEmbedder>();

/**
 * Use the PDF writer's advances and kerning, independently of browser or embedded preview fonts.
 * An unsupported character throws so the caller can report that it cannot export this text;
 * guessing an advance would produce a preview that cannot be reproduced in the PDF.
 */
export const measureParagraphText = (text: string, face: StandardParagraphFace, fontSize: number): number => {
  const key = paragraphStandardFontKey(face);
  let metricFace = metricFaces.get(key);
  if (!metricFace) {
    // pdf-lib exposes equivalent font-name enums from its API and core as distinct TS types.
    metricFace = StandardFontEmbedder.for(StandardFonts[key] as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
    metricFaces.set(key, metricFace);
  }
  return metricFace.widthOfTextAtSize(exportText(text), fontSize);
};

export interface ParagraphLayoutPiece {
  text: string;
  face: ParagraphFace;
  x: number;
  /** Baseline measured down from the top of the paragraph. */
  y: number;
  width: number;
  lineIndex: number;
}

/** Place already wrapped lines once, for both the rendered preview and PDF drawing. */
export const layoutParagraphLines = (
  lines: Array<Array<{ text: string; face: ParagraphFace }>>,
  { width, fontSize, lineHeight, align }: {
    width: number;
    fontSize: number;
    lineHeight: number;
    align: 'left' | 'center' | 'right' | 'justify';
  },
): ParagraphLayoutPiece[] => {
  const positioned: ParagraphLayoutPiece[] = [];
  lines.forEach((line, lineIndex) => {
    const pieces = line.map((piece) => ({ ...piece, text: exportText(piece.text) }));
    if (!pieces.some((piece) => piece.text.trim())) return;
    const y = fontSize + lineIndex * lineHeight;

    // A style boundary inside a word is not a word gap. Keep those fragments adjacent and
    // distribute justification only over actual interior whitespace, even across run boundaries.
    if (align === 'justify' && lineIndex < lines.length - 1) {
      const tokens: Array<{ blank: boolean; pieces: typeof pieces }> = [];
      pieces.forEach((piece) => piece.text.split(/(\s+)/).filter(Boolean).forEach((text) => {
        const blank = /^\s+$/.test(text);
        const previous = tokens[tokens.length - 1];
        if (previous?.blank === blank) previous.pieces.push({ text, face: piece.face });
        else tokens.push({ blank, pieces: [{ text, face: piece.face }] });
      }));
      const gaps = tokens.filter((token, index) => token.blank && index > 0 && index < tokens.length - 1).length;
      if (gaps > 0) {
        const naturalWidth = tokens.reduce((total, token) => total + token.pieces.reduce(
          (tokenWidth, piece) => tokenWidth + measureParagraphText(piece.text, piece.face, fontSize), 0,
        ), 0);
        const extraGap = Math.max(0, width - naturalWidth) / gaps;
        let x = 0;
        tokens.forEach((token, index) => {
          token.pieces.forEach((piece) => {
            const pieceWidth = measureParagraphText(piece.text, piece.face, fontSize);
            positioned.push({ ...piece, x, y, width: pieceWidth, lineIndex });
            x += pieceWidth;
          });
          if (token.blank && index > 0 && index < tokens.length - 1) x += extraGap;
        });
        return;
      }
    }

    const measured = pieces.map((piece) => ({ ...piece, width: measureParagraphText(piece.text, piece.face, fontSize) }));
    const lineWidth = measured.reduce((total, piece) => total + piece.width, 0);
    let x = align === 'right'
      ? Math.max(0, width - lineWidth)
      : align === 'center' ? Math.max(0, (width - lineWidth) / 2) : 0;
    measured.forEach((piece) => {
      if (piece.text) positioned.push({ ...piece, x, y, lineIndex });
      x += piece.width;
    });
  });
  return positioned;
};
