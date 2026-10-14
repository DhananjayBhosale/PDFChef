import { PDFArray, PDFName, PDFRef, type PDFDocument } from 'pdf-lib';

/**
 * Bake form fields into the page. pdf-lib deletes the widgets but can leave them listed in
 * the page's /Annots, which readers then report as broken references.
 */
export const flattenFormFields = (pdfDoc: PDFDocument): void => {
  pdfDoc.getForm().flatten();
  for (const page of pdfDoc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const entry = annots.get(index);
      if (entry instanceof PDFRef && pdfDoc.context.lookup(entry) === undefined) annots.remove(index);
    }
    if (annots.size() === 0) page.node.delete(PDFName.of('Annots'));
  }
};
