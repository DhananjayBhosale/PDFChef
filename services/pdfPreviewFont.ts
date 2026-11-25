import type { PDFFont } from 'pdf-lib';

const fonts = new Map<boolean, Promise<PDFFont>>();

/** Use the export's real Helvetica metrics for preview widths and edge clamping. */
export const getPdfPreviewFont = (bold = false): Promise<PDFFont> => {
  let font = fonts.get(bold);
  if (!font) {
    // pdf-lib loads with the first preview that measures text, not with the tool's first screen.
    font = import('pdf-lib').then(async ({ PDFDocument, StandardFonts }) =>
      (await PDFDocument.create()).embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica));
    fonts.set(bold, font);
  }
  return font;
};

/** Validate before measuring: pdf-lib throws for unsupported characters during render. */
export const unsupportedPdfPreviewCharacter = (font: PDFFont | null, text: string): string | null => {
  if (!font) return null;
  const supported = new Set(font.getCharacterSet());
  return [...text].find(character => !supported.has(character.codePointAt(0)!)) ?? null;
};
