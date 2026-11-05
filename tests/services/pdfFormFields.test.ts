import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { getPdfFormFields } from '../../services/pdfFormFields.ts';

// Found on a phone: no radio button could be selected, because each option's value was read from
// the checkbox property and came back empty.
test('each radio option carries its own value, and a saved choice reads back as selected', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([300, 300]);
  const form = source.getForm();
  const plan = form.createRadioGroup('plan');
  plan.addOptionToPage('Basic', page, { x: 20, y: 200, width: 16, height: 16 });
  plan.addOptionToPage('Pro', page, { x: 80, y: 200, width: 16, height: 16 });
  plan.select('Pro');
  form.createCheckBox('agree').addToPage(page, { x: 20, y: 150, width: 16, height: 16 });

  const document = await pdfjs.getDocument({ data: await source.save() }).promise;
  const fields = await getPdfFormFields(document);
  const radios = fields.filter((field) => field.kind === 'radio');

  assert.deepEqual(radios.map((field) => field.radioValue), ['Basic', 'Pro']);
  assert.ok(radios.every((field) => field.value === 'Pro'), 'the saved choice is the group value');
  assert.equal(fields.find((field) => field.kind === 'checkbox')?.radioValue, undefined);
  await document.cleanup();
});

test('a radio group with nothing chosen reads as empty, not as an option called Off', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([300, 300]);
  const plan = source.getForm().createRadioGroup('plan');
  plan.addOptionToPage('Basic', page, { x: 20, y: 200, width: 16, height: 16 });
  plan.addOptionToPage('Pro', page, { x: 80, y: 200, width: 16, height: 16 });
  plan.acroField.dict.set(PDFName.of('V'), PDFName.of('Off'));

  const document = await pdfjs.getDocument({ data: await source.save() }).promise;
  const fields = await getPdfFormFields(document);
  assert.deepEqual(fields.map((field) => field.value), ['', '']);
  await document.cleanup();
});
