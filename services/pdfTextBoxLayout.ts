import { LocalizedError } from './i18n/errors.ts';
import { substituteForStandardFont } from './pdfFontResolution.ts';
import { measureParagraphText, normalizeParagraphLineBreaks, paragraphStandardFontKey } from './pdfParagraphLayout.ts';

export const TEXT_BOX_PADDING_X = 6;
export const TEXT_BOX_PADDING_Y = 4;

export interface TextBoxStyle {
  content: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
}

/** PDF font metrics, line breaks and padding shared by the new-box preview and writer. */
export const layoutTextBox = (text: TextBoxStyle, width: number, height: number) => {
  const fontSize = text.fontSize || 12;
  const lineHeight = fontSize * 1.2;
  const face = { family: text.fontFamily || 'Helvetica', bold: (text.fontWeight ?? 400) >= 600, italic: text.fontStyle === 'italic' };
  const fontKey = paragraphStandardFontKey(face);
  // Standard-font drawText writes a Tj string without kerning adjustments. Its
  // real advance is the sum of glyph widths, whereas widthOfTextAtSize includes
  // kerning pairs. Measure the advances actually written to the PDF.
  const glyphWidths = new Map<string, number>();
  const measure = (value: string) => Array.from(value).reduce((sum, character) => {
    let advance = glyphWidths.get(character);
    if (advance === undefined) {
      advance = measureParagraphText(character, face, fontSize);
      glyphWidths.set(character, advance);
    }
    return sum + advance;
  }, 0);
  const availableWidth = Math.max(0, width - TEXT_BOX_PADDING_X * 2);
  const normalized = normalizeParagraphLineBreaks(substituteForStandardFont(text.content).text).replace(/\t/g, '    ');
  const wrapped: string[] = [];
  if (normalized) {
    for (const explicitLine of normalized.split('\n')) {
      let current = '';
      for (const token of explicitLine.match(/ +|[^ ]+/g) ?? []) {
        if (/^ +$/.test(token)) {
          current += token;
          continue;
        }
        if (current.trim() && measure(current + token) > availableWidth) {
          wrapped.push(current.trimEnd());
          current = '';
        }
        // Break long URLs/words as the textarea does; never shrink their point size.
        for (const character of token) {
          if (current && measure(current + character) > availableWidth) {
            wrapped.push(current.trimEnd());
            current = '';
          }
          current += character;
        }
      }
      wrapped.push(current.trimEnd());
    }
  }
  const lines = wrapped.map((value, index) => ({
    text: value,
    width: measure(value),
    x: TEXT_BOX_PADDING_X,
    baseline: TEXT_BOX_PADDING_Y + fontSize + index * lineHeight,
  }));
  const requiredHeight = lines.length ? TEXT_BOX_PADDING_Y * 2 + lines.length * lineHeight : 0;
  return {
    lines, fontKey, fontSize, lineHeight, requiredHeight,
    overflow: requiredHeight > height + 0.01 || lines.some(line => line.width > availableWidth + 0.01),
  };
};

export class PdfTextBoxError extends LocalizedError {
  readonly elementId: string;
  constructor(elementId: string, key: 'error.pdfTextBoxOverflow' | 'error.pdfTextBoxUnsupported') {
    super(key);
    this.name = 'PdfTextBoxError';
    this.elementId = elementId;
  }
}
