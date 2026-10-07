import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import fontkit from '@pdf-lib/fontkit';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import {
  documentEmbeddedFontsReady,
  embeddedPdfFont,
  loadDocumentEmbeddedFonts,
  matchingEmbeddedPdfFont,
  matchingSimpleEmbeddedPdfFont,
  measureEmbeddedText,
  releaseDocumentEmbeddedFonts,
} from '../../services/pdfEmbeddedFonts.ts';
import { matchingDevanagariFont } from '../../services/pdfDevanagari.ts';
import { layoutParagraphLines } from '../../services/pdfParagraphLayout.ts';
import type { ParagraphFace } from '../../services/pdfDocument.ts';

test('redraw reuses original regular, bold, italic and bold italic programs at their original sizes', async () => {
  for (const style of ['Regular', 'Bold', 'Italic', 'BoldItalic']) {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(readFileSync(`node_modules/pdfjs-dist/standard_fonts/LiberationSans-${style}.ttf`));
    pdf.addPage().drawText('AV text', { font, size: 15.96 });
    const bytes = await pdf.save();
    const descriptor = pdf.context.enumerateIndirectObjects().map(([, value]) => value).find(value =>
      value instanceof PDFDict && value.get(PDFName.of('Type'))?.toString() === '/FontDescriptor') as PDFDict;
    const name = descriptor.get(PDFName.of('FontName')) as PDFName;
    const file = new File([bytes], `${style}.pdf`);
    assert.equal(documentEmbeddedFontsReady(file), false);
    await loadDocumentEmbeddedFonts(file);
    const id = matchingEmbeddedPdfFont(file, name.decodeText(), 'AV text and more');
    assert.ok(id, `${style}: the original font was lost`);
    assert.equal(matchingEmbeddedPdfFont(new File([bytes], 'other.pdf'), name.decodeText(), 'AV text'), null,
      'font lookup must be confined to the current document');
    assert.equal(matchingEmbeddedPdfFont(file, name.decodeText(), '日本語'), null,
      'missing glyphs must select the existing fallback');
    const original = embeddedPdfFont(id)!;
    const exportPdf = await PDFDocument.create();
    exportPdf.registerFontkit(fontkit);
    const exportFont = await exportPdf.embedFont(original.bytes, { subset: true });
    const face: ParagraphFace = { key: style, family: 'Helvetica', bold: false, italic: false, embeddedFontId: id };
    for (const size of [10, 15.96, 24]) {
      const text = 'AV text and more';
      assert.ok(Math.abs(measureEmbeddedText(text, id, size) - exportFont.widthOfTextAtSize(text, size)) < 0.001,
        'preview advances must match the actual PDF writer');
      const [piece] = layoutParagraphLines([[{ text, face, fontSize: size }]], {
        width: 400, fontSize: 12, lineHeight: 16, align: 'left',
      });
      assert.equal(piece.fontSize, size);
      assert.equal(piece.face.embeddedFontId, id);
      assert.ok(Math.abs(piece.width - exportFont.widthOfTextAtSize(text, size)) < 0.001);
    }
  }
});

test('embedded font lookup decodes escaped PDF font names', async () => {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
  pdf.addPage().drawText('A heading', { font, size: 16 });
  await pdf.save();
  const descriptor = pdf.context.enumerateIndirectObjects().map(([, value]) => value).find(value =>
    value instanceof PDFDict && value.get(PDFName.of('Type'))?.toString() === '/FontDescriptor') as PDFDict;
  descriptor.set(PDFName.of('FontName'), PDFName.of('ABCDEF+Face With Spaces'));
  const file = new File([await pdf.save()], 'escaped-name.pdf');
  await loadDocumentEmbeddedFonts(file);
  const id = matchingEmbeddedPdfFont(file, 'ABCDEF+Face With Spaces', 'A heading and more');
  assert.ok(id);
  assert.equal(matchingEmbeddedPdfFont(file, 'ABCDEF+Face#20With#20Spaces', 'A heading'), id);
});

test('a PDF without a usable embedded font retains the fallback path', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const file = new File([await pdf.save()], 'no-font.pdf');
  await loadDocumentEmbeddedFonts(file);
  assert.equal(documentEmbeddedFontsReady(file), true);
  assert.equal(matchingEmbeddedPdfFont(file, 'Helvetica', 'Text'), null);
});

async function embeddedFixture(fontBytes = readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes);
  pdf.addPage().drawText('A heading', { font, size: 16 });
  const bytes = await pdf.save();
  const descriptor = pdf.context.enumerateIndirectObjects().map(([, value]) => value).find(value =>
    value instanceof PDFDict && value.get(PDFName.of('Type'))?.toString() === '/FontDescriptor') as PDFDict;
  const psName = (descriptor.get(PDFName.of('FontName')) as PDFName).decodeText();
  return { file: new File([bytes], 'font.pdf'), psName, bytes };
}

test('ordinary redraw keeps simple Unicode text but refuses bidirectional positioning', async () => {
  const { file, psName } = await embeddedFixture(readFileSync('tests/fixtures/fonts/NotoSansHebrew.ttf'));
  await loadDocumentEmbeddedFonts(file);
  assert.ok(matchingSimpleEmbeddedPdfFont(file, psName, 'AV text'));
  assert.ok(matchingEmbeddedPdfFont(file, psName, 'אבג 123 text'), 'The embedded font covers Hebrew');
  assert.equal(matchingSimpleEmbeddedPdfFont(file, psName, 'אבג 123 text'), null,
    'The ordinary writer must not reorder digits and Latin words inside Hebrew');
  assert.equal(matchingSimpleEmbeddedPdfFont(file, psName, 'Latin 123 אבג'), null,
    'An ltr run still needs bidi when Hebrew appears inside it');
  releaseDocumentEmbeddedFonts(file);
});

test('positioned Devanagari fonts stay available only to the shaped TrueType writer', async () => {
  const { file, psName } = await embeddedFixture(readFileSync('assets/fonts/pdf-edit/Mukta-Regular.ttf'));
  await loadDocumentEmbeddedFonts(file);
  const id = matchingDevanagariFont(file, psName, 'किं');
  assert.ok(id);
  assert.equal(matchingSimpleEmbeddedPdfFont(file, psName, 'किं'), null, 'Mark offsets need the shaped writer');
  assert.equal(matchingSimpleEmbeddedPdfFont(file, psName, 'कि'), null, 'Non-Latin advances need the shaped writer');
  Object.defineProperty(embeddedPdfFont(id)!.face, 'cff', { value: {}, configurable: true });
  assert.equal(matchingDevanagariFont(file, psName, 'किं'), null, 'CFF cannot use a TrueType CIDToGIDMap');
  assert.equal(matchingEmbeddedPdfFont(file, psName, 'किं'), id, 'The CFF restriction belongs to the shaped writer');
  releaseDocumentEmbeddedFonts(file);
});

test('numeric-only text keeps its original font even when the font kerns punctuation', async () => {
  const { file, psName } = await embeddedFixture();
  await loadDocumentEmbeddedFonts(file);
  const id = matchingEmbeddedPdfFont(file, psName, '123.45')!;
  const face = embeddedPdfFont(id)!.face;
  const layout = face.layout.bind(face);
  assert.equal(layout('123.45').script, 'zzzz');
  Object.defineProperty(face, 'layout', { value: (text: string) => {
    const run = layout(text);
    if (text === '123.45') run.positions[2].xAdvance -= 20;
    return run;
  } });
  assert.equal(matchingSimpleEmbeddedPdfFont(file, psName, '123.45'), id,
    'Kerning does not make an ordinary numeric line need the positioned writer');
  const expected = layout('123.45').glyphs.reduce((width, glyph) => width + glyph.advanceWidth, 0) * 16 / face.unitsPerEm;
  assert.equal(measureEmbeddedText('123.45', id, 16), expected, 'Measurements still use the export writer advances');
  releaseDocumentEmbeddedFonts(file);
});

test('releasing one document clears its fonts and allows a fresh reload without affecting another file', async () => {
  const { file, psName, bytes } = await embeddedFixture();
  const other = new File([bytes], 'other.pdf');
  await loadDocumentEmbeddedFonts(file);
  await loadDocumentEmbeddedFonts(other);
  const id = matchingEmbeddedPdfFont(file, psName, 'A heading')!;
  releaseDocumentEmbeddedFonts(file);
  assert.equal(embeddedPdfFont(id), undefined);
  assert.equal(documentEmbeddedFontsReady(file), false);
  assert.equal(matchingEmbeddedPdfFont(file, psName, 'A heading'), null);
  assert.ok(matchingEmbeddedPdfFont(other, psName, 'A heading'));
  await loadDocumentEmbeddedFonts(file);
  assert.ok(matchingEmbeddedPdfFont(file, psName, 'A heading'));
  assert.notEqual(matchingEmbeddedPdfFont(file, psName, 'A heading'), id);
  releaseDocumentEmbeddedFonts(file);
  releaseDocumentEmbeddedFonts(other);
});

test('a released in-flight font load cannot repopulate the registry', async () => {
  const { file, psName, bytes } = await embeddedFixture();
  let finish: (value: ArrayBuffer) => void;
  const buffer = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
  Object.defineProperty(file, 'arrayBuffer', { value: () => buffer });
  const pending = loadDocumentEmbeddedFonts(file);
  releaseDocumentEmbeddedFonts(file);
  finish!(bytes.slice().buffer);
  await pending;
  assert.equal(documentEmbeddedFontsReady(file), false);
  assert.equal(matchingEmbeddedPdfFont(file, psName, 'A heading'), null);
  await loadDocumentEmbeddedFonts(file);
  assert.ok(matchingEmbeddedPdfFont(file, psName, 'A heading'));
  releaseDocumentEmbeddedFonts(file);
});
