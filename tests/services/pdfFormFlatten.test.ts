import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFArray, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { flattenFormFields } from '../../services/pdfFormFlatten.ts';

// Cycle-3 QA: flattened forms kept /Annots entries for deleted widgets, so pdfinfo printed
// "Invalid XRef entry" for every field.
test('a flattened form keeps no page annotation that points at a deleted widget', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage();
  const form = source.getForm();
  form.createTextField('name').addToPage(page, { x: 50, y: 700 });
  form.createCheckBox('agree').addToPage(page, { x: 50, y: 650 });
  const link = source.context.register(source.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] }));
  page.node.lookup(PDFName.of('Annots'), PDFArray).push(link);

  const doc = await PDFDocument.load(await source.save());
  flattenFormFields(doc);
  const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  const refs = annots?.asArray() ?? [];
  assert.equal(refs.length, 1, 'only the link annotation stays');
  assert.ok(refs.every((ref) => ref instanceof PDFRef && doc.context.lookup(ref) !== undefined));
  assert.equal(doc.getForm().getFields().length, 0);
});
