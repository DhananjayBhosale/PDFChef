import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, PDFTextField, StandardFonts } from 'pdf-lib';
import { copyPagesWithForms } from '../../services/pdfPageCopy.ts';

const fixture = async (answer = 'First answer', fontName = StandardFonts.Courier) => {
  const pdf = await PDFDocument.create();
  const pages = [pdf.addPage(), pdf.addPage(), pdf.addPage()];
  const font = await pdf.embedFont(fontName);
  const form = pdf.getForm();
  const customer = form.createTextField('group.Customer');
  customer.setText(answer);
  customer.addToPage(pages[0], { x: 40, y: 600, width: 150, height: 25, font });
  customer.addToPage(pages[2], { x: 40, y: 500, width: 150, height: 25, font });
  const removed = form.createTextField('OnlyOnMiddlePage');
  removed.setText('Private middle-page answer');
  removed.addToPage(pages[1], { x: 40, y: 600, width: 150, height: 25 });
  const check = form.createCheckBox('Accepted');
  check.addToPage(pages[0], { x: 40, y: 550, width: 20, height: 20 });
  check.check();
  const radio = form.createRadioGroup('Choice');
  radio.addOptionToPage('A', pages[0], { x: 80, y: 550, width: 20, height: 20 });
  radio.addOptionToPage('B', pages[2], { x: 80, y: 550, width: 20, height: 20 });
  radio.select('A');
  const select = form.createDropdown('Priority');
  select.addOptions(['Normal', 'High']);
  select.select('High');
  select.addToPage(pages[2], { x: 40, y: 400, width: 150, height: 25 });
  form.updateFieldAppearances();
  // Exercise inherited default resources, including a colliding name in a second donor.
  const acro = pdf.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  acro.set(PDFName.of('DR'), pdf.context.obj({ Font: { F0: font.ref } }));
  acro.set(PDFName.of('DA'), PDFString.of('/F0 12 Tf 0 g'));
  const root = customer.acroField.getParent()!.dict;
  customer.acroField.dict.delete(PDFName.of('DA'));
  root.delete(PDFName.of('DA'));
  return pdf;
};

const append = async (output: PDFDocument, source: PDFDocument, indices: number[]) => {
  const copied = await copyPagesWithForms(output, source, indices);
  copied.forEach(page => output.addPage(page));
};
const reload = async (pdf: PDFDocument) => PDFDocument.load(await pdf.save());

test('selected pages retain text fields, checkbox, radio and dropdown values and widget geometry', async () => {
  const source = await fixture();
  const output = await PDFDocument.create();
  await append(output, source, [2, 0]);
  const saved = await reload(output);
  const form = saved.getForm();
  assert.deepEqual(form.getFields().map(field => field.getName()).sort(), ['Accepted', 'Choice', 'Priority', 'group.Customer']);
  assert.equal(form.getTextField('group.Customer').getText(), 'First answer');
  assert.equal(form.getCheckBox('Accepted').isChecked(), true);
  assert.equal(form.getRadioGroup('Choice').getSelected(), 'A');
  assert.deepEqual(form.getDropdown('Priority').getSelected(), ['High']);
  for (const [index, original] of [2, 0].entries()) {
    const annotations = saved.getPage(index).node.Annots()!;
    const originalAnnotations = source.getPage(original).node.Annots()!;
    assert.equal(annotations.size(), originalAnnotations.size());
    for (let i = 0; i < annotations.size(); i += 1) {
      const widget = annotations.lookup(i, PDFDict);
      assert.equal(widget.get(PDFName.of('P')), saved.getPage(index).ref);
      assert.equal(widget.lookup(PDFName.of('Rect'), PDFArray).toString(),
        originalAnnotations.lookup(i, PDFDict).lookup(PDFName.of('Rect'), PDFArray).toString());
    }
  }
});

test('a partial copy filters shared widgets without mutating the donor or later split parts', async () => {
  const source = await fixture();
  const first = await PDFDocument.create();
  await append(first, source, [0]);
  assert.equal(first.getForm().getTextField('group.Customer').acroField.getWidgets().length, 1);
  assert.equal(source.getForm().getTextField('group.Customer').acroField.getWidgets().length, 2);
  const second = await PDFDocument.create();
  await append(second, source, [1]);
  assert.deepEqual(second.getForm().getFields().map(field => field.getName()), ['OnlyOnMiddlePage']);
  assert.equal(source.getPageCount(), 3);
});

test('merged forms keep colliding field names and default fonts independent', async () => {
  const output = await PDFDocument.create();
  await append(output, await fixture('First answer', StandardFonts.Courier), [0]);
  await append(output, await fixture('Second answer', StandardFonts.TimesRoman), [0]);
  const saved = await reload(output);
  const form = saved.getForm();
  const first = form.getTextField('group.Customer');
  const second = form.getTextField('group_2.Customer');
  assert.equal(first.getText(), 'First answer');
  assert.equal(second.getText(), 'Second answer');
  const fonts = saved.catalog.lookup(PDFName.of('AcroForm'), PDFDict)
    .lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
  for (const [field, expected] of [[first, 'Courier'], [second, 'Times-Roman']] as const) {
    const appearance = field.acroField.getParent()!.getDefaultAppearance()!;
    const fontKey = /\/([^ ]+) 12 Tf/.exec(appearance)![1];
    assert.equal(fonts.lookup(PDFName.of(fontKey), PDFDict).get(PDFName.of('BaseFont'))?.toString(), `/${expected}`);
  }
  second.setText('Changed separately');
  assert.equal(first.getText(), 'First answer');
});

test('page copying refuses unsupported XFA rather than returning broken form controls', async () => {
  const source = await fixture();
  source.catalog.lookup(PDFName.of('AcroForm'), PDFDict).set(PDFName.of('XFA'), PDFString.of('fixture'));
  await assert.rejects(copyPagesWithForms(await PDFDocument.create(), source, [0]), /uses XFA forms/);
});

test('indirect widget subtypes and field names survive partial copies and merges', async () => {
  const output = await PDFDocument.create();
  for (const answer of ['First', 'Second']) {
    const source = await fixture(answer);
    for (const page of source.getPages()) {
      for (const ref of page.node.Annots()?.asArray() ?? []) {
        source.context.lookup(ref, PDFDict).set(PDFName.of('Subtype'), source.context.register(PDFName.of('Widget')));
      }
    }
    const root = source.getForm().getTextField('group.Customer').acroField.getParent()!.dict;
    root.set(PDFName.of('T'), source.context.register(root.get(PDFName.of('T'))!));
    await append(output, source, [0]);
  }
  const saved = await reload(output);
  assert.equal(saved.getForm().getTextField('group.Customer').getText(), 'First');
  assert.equal(saved.getForm().getTextField('group_2.Customer').getText(), 'Second');
});

test('unnamed field groups keep their names unless real descendant names collide', async () => {
  const output = await PDFDocument.create();
  for (const [leafName, answer] of [['Customer', 'First'], ['OtherCustomer', 'Second'], ['Customer', 'Third']]) {
    const source = await fixture(answer);
    const field = source.getForm().getTextField('group.Customer');
    field.acroField.setPartialName(leafName);
    field.acroField.getParent()!.dict.delete(PDFName.of('T'));
    await append(output, source, [0]);
  }
  const form = (await reload(output)).getForm();
  const textFields = form.getFields().filter(field => field instanceof PDFTextField);
  for (const value of ['First', 'Second']) {
    assert.equal(textFields.find(field => field.getText() === value)!.acroField.getParent()!.dict.has(PDFName.of('T')), false);
  }
  const names = form.getFields().map(field => field.getName());
  assert.equal(new Set(names).size, names.length, 'actual collisions still require independent names');
  assert.ok(textFields.some(field => field.getText() === 'Third'));
});

test('default font and colour-space aliases are rewritten in their own resource categories', async () => {
  const output = await PDFDocument.create();
  for (const index of [0, 1]) {
    const source = await fixture('Answer', index ? StandardFonts.TimesRoman : StandardFonts.Courier);
    const acro = source.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    acro.lookup(PDFName.of('DR'), PDFDict).set(PDFName.of('ColorSpace'), source.context.obj(
      index ? { F0: 'DeviceCMYK' } : { F0: 'DeviceRGB', F0_2: 'DeviceRGB' },
    ));
    acro.set(PDFName.of('DA'), PDFString.of('/F0 12 Tf /F0 cs'));
    await append(output, source, [0]);
  }
  const saved = await reload(output);
  const appearance = saved.getForm().getTextField('group_2.Customer').acroField.getParent()!.getDefaultAppearance()!;
  const resources = saved.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('DR'), PDFDict);
  const fontName = /\/([^ ]+) 12 Tf/.exec(appearance)![1];
  const colorName = /\/([^ ]+) cs/.exec(appearance)![1];
  assert.equal(resources.lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of(fontName), PDFDict)
    .get(PDFName.of('BaseFont')), PDFName.of('Times-Roman'));
  assert.equal(resources.lookup(PDFName.of('ColorSpace'), PDFDict).lookup(PDFName.of(colorName)), PDFName.of('DeviceCMYK'));
});
