import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from 'pdf-lib';

// Hidden info: the document information dictionary, XMP packets and catalog actions. Kept apart
// from pdfDocument.ts (which needs the browser) so the removal is checked by a unit test.

export const clearPDFMetadataAndCatalogActions = (pdfDoc: PDFDocument) => {
  // Remove the whole document information dictionary, not just blank its values: title, author,
  // subject, keywords, creator, producer, both dates and any custom key go (h4 F1, F2). Callers
  // load and save with `updateMetadata: false`, so pdf-lib adds no Producer or dates back.
  const infoRef = pdfDoc.context.trailerInfo.Info;
  const info = infoRef ? pdfDoc.context.lookup(infoRef) : undefined;
  if (info instanceof PDFDict) {
    for (const key of info.keys()) info.delete(key);
  }
  delete pdfDoc.context.trailerInfo.Info;

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

/** An XMP packet on the catalog, a page, or an image or form object (what the clear step removes). */
const holdsXmpMetadata = (pdfDoc: PDFDocument): boolean => {
  for (const [, object] of pdfDoc.context.enumerateIndirectObjects()) {
    const dictionary = object instanceof PDFStream ? object.dict : object;
    if (!(dictionary instanceof PDFDict)) continue;
    const metadata = pdfDoc.context.lookup(dictionary.get(PDFName.of('Metadata')));
    if (metadata instanceof PDFStream && (
      metadata.dict.lookup(PDFName.of('Type')) === PDFName.of('Metadata')
      || metadata.dict.lookup(PDFName.of('Subtype')) === PDFName.of('XML')
    )) return true;
  }
  return false;
};

export type HiddenInfoKey = 'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer' | 'created' | 'modified' | 'xmp';
export interface HiddenInfoItem { key: HiddenInfoKey; value: string | Date | true }

/**
 * The hidden info a PDF holds, in the order Remove hidden info lists it (path to 9, part 2):
 * only what is there, so an empty title is not listed. Read again from the saved file, it shows
 * what is gone.
 */
export const readHiddenInfo = async (source: Blob | Uint8Array): Promise<HiddenInfoItem[]> => {
  const bytes = source instanceof Uint8Array ? source : await source.arrayBuffer();
  const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const text = (value: string | undefined) => (value ?? '').trim();
  const items: HiddenInfoItem[] = [];
  const add = (key: HiddenInfoKey, value: string | Date | true | undefined) => {
    if (value === undefined || value === '' || (value instanceof Date && Number.isNaN(value.getTime()))) return;
    items.push({ key, value });
  };
  // A date or string pdf-lib cannot decode is still there: it is listed without its value.
  const safely = <T,>(read: () => T): T | undefined => { try { return read(); } catch { return undefined; } };
  add('title', text(safely(() => pdfDoc.getTitle())));
  add('author', text(safely(() => pdfDoc.getAuthor())));
  add('subject', text(safely(() => pdfDoc.getSubject())));
  add('keywords', text(safely(() => pdfDoc.getKeywords())));
  add('creator', text(safely(() => pdfDoc.getCreator())));
  add('producer', text(safely(() => pdfDoc.getProducer())));
  add('created', safely(() => pdfDoc.getCreationDate()));
  add('modified', safely(() => pdfDoc.getModificationDate()));
  if (holdsXmpMetadata(pdfDoc)) add('xmp', true);
  return items;
};

export const removeUnusedPdfObjects = (pdfDoc: PDFDocument) => {
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

/** Remove hidden info (the tool): the saved bytes carry no information keys and no XMP. */
export const removeHiddenInfo = async (bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
  clearPDFMetadataAndCatalogActions(pdfDoc);
  removeUnusedPdfObjects(pdfDoc);
  return pdfDoc.save();
};
