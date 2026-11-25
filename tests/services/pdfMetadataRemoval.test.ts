import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';

import { readFileSync } from 'node:fs';
import { clearPDFMetadataAndCatalogActions, readHiddenInfo, removeHiddenInfo, removeUnusedPdfObjects } from '../../services/pdfHiddenInfo.ts';

const INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'];

const fileWithEveryField = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.setTitle('Secret title');
  doc.setAuthor('A. Person');
  doc.setSubject('Subject');
  doc.setKeywords(['one', 'two']);
  doc.setCreator('Word');
  doc.setProducer('Some PDF maker');
  doc.setCreationDate(new Date('2026-04-10T10:00:00Z'));
  doc.setModificationDate(new Date('2026-04-11T10:00:00Z'));
  const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
  info.set(PDFName.of('Company'), PDFString.of('Acme'));
  const xmp = doc.context.stream('<x:xmpmeta/>', { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(xmp));
  const bytes = await doc.save();
  return bytes;
};

// What Clean up PDF does after it removes comments.
const cleanUp = async (bytes: Uint8Array) => {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  clearPDFMetadataAndCatalogActions(doc);
  removeUnusedPdfObjects(doc);
  return doc.save();
};

// h4 F1/F2: the output kept today's date and "pdf-lib" as the producer, and blank keys stayed.
for (const [name, run] of [['Remove hidden info', removeHiddenInfo], ['Clean up PDF', cleanUp]] as const) {
  test(`${name} leaves no information keys, dates, producer or XMP in the saved file`, async () => {
    const source = await fileWithEveryField();
    assert.ok((await readHiddenInfo(source)).length >= 9);
    const output = await run(source);
    assert.deepEqual(await readHiddenInfo(output), []);

    const saved = await PDFDocument.load(output, { updateMetadata: false });
    const infoRef = saved.context.trailerInfo.Info;
    const info = infoRef ? saved.context.lookup(infoRef) : undefined;
    for (const key of INFO_KEYS) {
      assert.equal(info instanceof PDFDict ? info.has(PDFName.of(key)) : false, false, `${key} is still in the file`);
    }
    assert.equal(info instanceof PDFDict ? info.keys().length : 0, 0, 'a custom key is still in the file');
    assert.equal(saved.catalog.has(PDFName.of('Metadata')), false);
    const text = Buffer.from(output).toString('latin1');
    assert.doesNotMatch(text, /pdf-lib|Producer|CreationDate|ModDate|Secret title|Acme|xmpmeta/);
  });
}

test('both tools load and save without pdf-lib adding its own Producer and dates', () => {
  const source = readFileSync(new URL('../../services/pdfDocument.ts', import.meta.url), 'utf8');
  assert.match(source, /export const removePDFMetadata = async \(file: File\): Promise<Uint8Array> =>\s+removeHiddenInfo\(/);
  assert.match(source, /export const sanitizePDF = [\s\S]{0,200}updateMetadata: false[\s\S]{0,500}clearPDFMetadataAndCatalogActions\(pdfDoc\)/);
});
