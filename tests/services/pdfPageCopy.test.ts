import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString, PDFTextField, StandardFonts } from 'pdf-lib';
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

const linkedFixture = async (withForm = false) => {
  const pdf = await PDFDocument.create();
  const pages = [pdf.addPage(), pdf.addPage()];
  pages[0].drawText('Public page');
  pages[1].drawText('PRIVATE-EXCLUDED-PAGE');
  const target = pdf.context.obj([pages[1].ref, 'Fit']);
  const link = (entries: Record<string, unknown>) => pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [20, 20, 100, 40], P: pages[0].ref, ...entries,
  }));
  pages[0].node.set(PDFName.of('Annots'), pdf.context.obj([
    link({ Dest: target }),
    link({ A: { S: 'GoTo', D: target } }),
    link({ A: { S: 'URI', URI: PDFString.of('https://example.com/') } }),
    link({ A: { S: 'GoToR', F: PDFString.of('other.pdf'), D: [0, 'Fit'] } }),
  ]));
  if (withForm) {
    const field = pdf.getForm().createTextField('Customer');
    field.setText('Retain this answer');
    for (const page of pages) field.addToPage(page, { x: 40, y: 600, width: 150, height: 25 });
  }
  return pdf;
};
const annotationAt = (pdf: PDFDocument, pageIndex: number, index: number) =>
  pdf.getPage(pageIndex).node.Annots()!.lookup(index, PDFDict);

// The caller prunes detached objects before export. No excluded page must remain
// reachable through a retained page, action, annotation, or form field.
const reachablePageRefs = (pdf: PDFDocument) => {
  const pending: unknown[] = [pdf.catalog];
  const visited = new Set<unknown>();
  const pages = new Set<string>();
  while (pending.length) {
    const object = pending.pop();
    if (!object || visited.has(object)) continue;
    visited.add(object);
    if (object instanceof PDFRef) {
      const target = pdf.context.lookup(object);
      if (target instanceof PDFDict && target.lookup(PDFName.of('Type')) === PDFName.of('Page')) pages.add(object.toString());
      pending.push(target);
    } else if (object instanceof PDFDict) pending.push(...object.values());
    else if (object instanceof PDFArray) pending.push(...object.asArray());
  }
  return [...pages].sort();
};

test('reorder and merge remap direct and GoTo links to the actual output pages without forms', async () => {
  const source = await linkedFixture();
  const output = await PDFDocument.create();
  await append(output, source, [1, 0]);
  await append(output, source, [0, 1]);
  const saved = await reload(output);
  for (const [from, to] of [[1, 0], [2, 3]]) {
    assert.equal(annotationAt(saved, from, 0).lookup(PDFName.of('Dest'), PDFArray).get(0), saved.getPage(to).ref);
    assert.equal(annotationAt(saved, from, 1).lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('D'), PDFArray).get(0), saved.getPage(to).ref);
  }
  assert.deepEqual(reachablePageRefs(saved), saved.getPages().map(page => page.ref.toString()).sort());
  assert.equal(annotationAt(source, 0, 0).lookup(PDFName.of('Dest'), PDFArray).get(0), source.getPage(1).ref);
});

test('excluding a linked page severs its reachable content while retaining remote links and form answers', async () => {
  for (const withForm of [false, true]) {
    const source = await linkedFixture(withForm);
    const output = await PDFDocument.create();
    await append(output, source, [0]);
    const saved = await reload(output);
    assert.equal(annotationAt(saved, 0, 0).has(PDFName.of('Dest')), false);
    assert.equal(annotationAt(saved, 0, 1).has(PDFName.of('A')), false);
    assert.equal(annotationAt(saved, 0, 2).lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI'), PDFString).decodeText(), 'https://example.com/');
    assert.equal(annotationAt(saved, 0, 3).lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('S')), PDFName.of('GoToR'));
    assert.deepEqual(reachablePageRefs(saved), [saved.getPage(0).ref.toString()]);
    if (withForm) {
      assert.equal(saved.getForm().getTextField('Customer').getText(), 'Retain this answer');
      assert.equal(saved.getForm().getTextField('Customer').acroField.getWidgets().length, 1);
      assert.equal(source.getForm().getTextField('Customer').acroField.getWidgets().length, 2);
    }
  }
});

test('named destinations resolve within each donor and are removed when their target is excluded', async () => {
  const source = await linkedFixture();
  const destination = source.context.obj([source.getPage(1).ref, 'Fit']);
  source.catalog.set(PDFName.of('Dests'), source.context.obj({ LegacyTarget: { D: destination } }));
  source.catalog.set(PDFName.of('Names'), source.context.obj({ Dests: {
    Kids: [{ Names: [PDFString.of('TreeTarget'), { D: destination }] }],
  } }));
  annotationAt(source, 0, 0).set(PDFName.of('Dest'), PDFName.of('LegacyTarget'));
  annotationAt(source, 0, 1).lookup(PDFName.of('A'), PDFDict).set(PDFName.of('D'), PDFString.of('TreeTarget'));
  const reordered = await PDFDocument.create();
  await append(reordered, source, [1, 0]);
  const saved = await reload(reordered);
  assert.equal(annotationAt(saved, 1, 0).lookup(PDFName.of('Dest'), PDFArray).get(0), saved.getPage(0).ref);
  assert.equal(annotationAt(saved, 1, 1).lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('D'), PDFArray).get(0), saved.getPage(0).ref);
  const extracted = await PDFDocument.create();
  await append(extracted, source, [0]);
  assert.equal(annotationAt(extracted, 0, 0).has(PDFName.of('Dest')), false);
  assert.equal(annotationAt(extracted, 0, 1).has(PDFName.of('A')), false);
  assert.equal(annotationAt(source, 0, 0).lookup(PDFName.of('Dest')), PDFName.of('LegacyTarget'));
});

test('excluded targets in chained and additional actions do not keep deleted pages reachable', async () => {
  const source = await linkedFixture();
  const target = source.context.obj([source.getPage(1).ref, 'Fit']);
  const local = source.context.obj({ S: 'GoTo', D: target });
  const remote = source.context.obj({ S: 'URI', URI: PDFString.of('https://example.com/next') });
  annotationAt(source, 0, 2).lookup(PDFName.of('A'), PDFDict).set(PDFName.of('Next'), source.context.obj([local, remote]));
  source.getPage(0).node.set(PDFName.of('AA'), source.context.obj({ O: local }));
  const output = await PDFDocument.create();
  await append(output, source, [0]);
  const saved = await reload(output);
  const next = annotationAt(saved, 0, 2).lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('Next'), PDFArray);
  assert.equal(next.size(), 1);
  assert.equal(next.lookup(0, PDFDict).lookup(PDFName.of('S')), PDFName.of('URI'));
  assert.equal(saved.getPage(0).node.lookup(PDFName.of('AA'), PDFDict).has(PDFName.of('O')), false);
  assert.deepEqual(reachablePageRefs(saved), [saved.getPage(0).ref.toString()]);
});
