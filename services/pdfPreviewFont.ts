import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';

const fonts = new Map<boolean, Promise<PDFFont>>();

/** Use the export's real Helvetica metrics for preview widths and edge clamping. */
export const getPdfPreviewFont = (bold = false): Promise<PDFFont> => {
  let font = fonts.get(bold);
  if (!font) {
    font = PDFDocument.create().then((pdf) => pdf.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica));
    fonts.set(bold, font);
  }
  return font;
};
