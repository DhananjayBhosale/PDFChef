import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PDFContentStream, PDFDict, PDFDocument, PDFName, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  canShapeDevanagari,
  DevanagariPdfWriter,
  hasDevanagari,
  loadDevanagariFonts,
  loadDocumentDevanagariFonts,
  matchingDevanagariFont,
  measureDevanagariText,
  selectDevanagariFont,
  type DevanagariFontId,
} from '../../services/pdfDevanagari.ts';

const fontNames: Record<DevanagariFontId, string> = {
  MuktaRegular: 'Mukta-Regular.ttf',
  MuktaBold: 'Mukta-Bold.ttf',
  MartelRegular: 'Martel-Regular.ttf',
  MartelBold: 'Martel-Bold.ttf',
};

test('shaped Devanagari stays visible PDF text and reopens in logical Unicode order', async () => {
  await loadDevanagariFonts(async (id) => new Uint8Array(readFileSync(
    new URL(`../../assets/fonts/pdf-edit/${fontNames[id]}`, import.meta.url),
  )));
  assert.equal(hasDevanagari('Invoice 2026'), false);
  assert.equal(hasDevanagari('Invoice राशि'), true);
  assert.equal(selectDevanagariFont(undefined, undefined, 'कॎ', 'serif', false), 'MuktaRegular');

  const lines: Array<[DevanagariFontId, string]> = [
    ['MuktaRegular', 'नमस्ते कि कृपया PDF 2026'],
    ['MuktaBold', 'किं क्षेत्र शक्ति ₹५०'],
    ['MartelRegular', 'हिंदी दस्तावेज़ 123'],
    ['MartelBold', 'संस्कृत और English'],
  ];
  const document = await PDFDocument.create();
  const page = document.addPage([600, 300]);
  const writer = new DevanagariPdfWriter(document);
  for (const [index, [fontId, value]] of lines.entries()) {
    assert.ok(canShapeDevanagari(value, fontId), `${fontId} lacks a glyph`);
    const width = measureDevanagariText(value, fontId, 18);
    assert.ok(width > 50 && width < 550);
    await writer.drawLine(page, [{ text: value, fontId, x: 30, y: 260 - index * 55, width }], 18, rgb(0, 0, 0), 0);
  }
  writer.finish();
  const bytes = await document.save();
  const reopened = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const text = await (await reopened.getPage(1)).getTextContent();
  assert.deepEqual(text.items.map((item: any) => item.str).filter(Boolean), lines.map((line) => line[1]));
  assert.ok(bytes.length > 100_000, 'the export must embed real font programs');

  const originalFile = new File([bytes], 'hindi.pdf', { type: 'application/pdf' });
  await loadDocumentDevanagariFonts(originalFile);
  const fontDescriptor = document.context.enumerateIndirectObjects()
    .map(([, value]) => value)
    .find((value) => value instanceof PDFDict && value.get(PDFName.of('Type'))?.toString() === '/FontDescriptor') as PDFDict;
  const psName = fontDescriptor.get(PDFName.of('FontName'))?.toString().slice(1);
  assert.ok(psName);
  assert.match(matchingDevanagariFont(originalFile, psName, 'नमस्ते भारत') ?? '', /^Embedded/);
  assert.equal(matchingDevanagariFont(originalFile, 'another-font', 'नमस्ते भारत'), null);
});


test('Devanagari glyph advances and mark offsets rotate with the page', async () => {
  await loadDevanagariFonts(async (id) => new Uint8Array(readFileSync(
    new URL(`../../assets/fonts/pdf-edit/${fontNames[id]}`, import.meta.url),
  )));
  const document = await PDFDocument.create();
  const writer = new DevanagariPdfWriter(document);
  const text = 'कि कृ नमस्ते क्षेत्र';
  const origin = { x: 150, y: 150 };
  const rotations = [0, 90, 180, 270];
  for (const angle of rotations) {
    await writer.drawLine(document.addPage([400, 400]), [{
      text, fontId: 'MuktaRegular', ...origin,
      width: measureDevanagariText(text, 'MuktaRegular', 18),
    }], 18, rgb(0, 0, 0), angle);
  }
  writer.finish();
  const positions = document.context.enumerateIndirectObjects()
    .map(([, value]) => value)
    .filter((value): value is PDFContentStream => value instanceof PDFContentStream)
    .map(stream => [...stream.getContentsString().matchAll(/^([^\n]+) Tm$/gm)]
      .map(match => match[1].split(' ').map(Number).slice(4)));
  assert.equal(positions.length, rotations.length);
  assert.ok(positions[0].length > 8, 'the fixture needs several visible glyphs and marks');
  for (let index = 1; index < rotations.length; index += 1) {
    const radians = rotations[index] * Math.PI / 180;
    assert.equal(positions[index].length, positions[0].length);
    positions[0].forEach(([x, y], glyph) => {
      const dx = x - origin.x, dy = y - origin.y;
      const [actualX, actualY] = positions[index][glyph];
      assert.ok(Math.abs(actualX - (origin.x + dx * Math.cos(radians) - dy * Math.sin(radians))) < 1e-8,
        `${rotations[index]} degree glyph ${glyph} has an unrotated x position`);
      assert.ok(Math.abs(actualY - (origin.y + dx * Math.sin(radians) + dy * Math.cos(radians))) < 1e-8,
        `${rotations[index]} degree glyph ${glyph} has an unrotated y position`);
    });
  }
});
