import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createJpegPhotoPdf } from '../../services/jpegPhotoPdf.ts';

// A copy, not Node's pooled Buffer: pdf-lib reads a JPEG through its whole underlying ArrayBuffer.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/photos/${name}`, import.meta.url)));
const photo = (name: string) => new File([fixture(name)], name, { type: 'image/jpeg' });

/** What createPDFFromImages draws for the same photos: A4, fitted whole, centred. */
const pdfLibPhotoPdf = async (names: string[]) => {
  const pdf = await PDFDocument.create();
  for (const name of names) {
    const image = await pdf.embedJpg(fixture(name));
    const page = pdf.addPage([595.28, 841.89]);
    const scale = Math.min(595.28 / image.width, 841.89 / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, { x: (595.28 - width) / 2, y: (841.89 - height) / 2, width, height });
  }
  return pdf.save();
};

const multiply = (m: number[], n: number[]) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Each page as PDF.js sees it: its size, and where and how big each decoded picture lands. */
const readPages = async (bytes: Uint8Array) => {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const operators = await page.getOperatorList();
    const stack: number[][] = [];
    let matrix = [1, 0, 0, 1, 0, 0];
    const images = [];
    for (let index = 0; index < operators.fnArray.length; index += 1) {
      const fn = operators.fnArray[index];
      const args = operators.argsArray[index];
      if (fn === pdfjs.OPS.save) stack.push(matrix);
      else if (fn === pdfjs.OPS.restore) matrix = stack.pop() ?? matrix;
      else if (fn === pdfjs.OPS.transform) matrix = multiply(matrix, args);
      else if (fn === pdfjs.OPS.paintImageXObject) {
        const decoded = await new Promise<any>((resolve) => page.objs.get(args[0], resolve));
        images.push({ placement: matrix.map((value) => Math.round(value * 100) / 100), decoded: [decoded.width, decoded.height] });
      }
    }
    pages.push({ size: page.view, images });
  }
  return pages;
};

test('a photo PDF written from the JPEG files reads exactly like the pdf-lib one', async () => {
  const names = ['wide.jpg', 'tall.jpg', 'wide.jpg'];
  const blob = await createJpegPhotoPdf(names.map(photo));
  assert.ok(blob);
  assert.equal(blob.type, 'application/pdf');
  const streamed = new Uint8Array(await blob.arrayBuffer());
  const expected = await readPages(await pdfLibPhotoPdf(names));
  const actual = await readPages(streamed);
  assert.equal(actual.length, 3);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.map((page) => page.images[0].decoded), [[40, 20], [20, 40], [40, 20]]);
});

test('each photo is stored byte for byte, as a JPEG pdf-lib can reopen', async () => {
  const blob = await createJpegPhotoPdf([photo('wide.jpg'), photo('tall.jpg')]);
  const pdf = await PDFDocument.load(new Uint8Array(await blob!.arrayBuffer()), { throwOnInvalidObject: true });
  assert.equal(pdf.getPageCount(), 2);
  for (const page of pdf.getPages()) assert.deepEqual(page.getSize(), { width: 595.28, height: 841.89 });
  const images = pdf.context.enumerateIndirectObjects().map(([, object]) => object)
    .filter((object): object is PDFRawStream => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  assert.equal(images.length, 2);
  assert.deepEqual(images.map((image) => image.dict.get(PDFName.of('Filter'))), [PDFName.of('DCTDecode'), PDFName.of('DCTDecode')]);
  assert.deepEqual(new Uint8Array(images[0].contents), fixture('wide.jpg'));
  assert.deepEqual(new Uint8Array(images[1].contents), fixture('tall.jpg'));
});

test('anything that is not a placeable JPEG is left to the general writer', async () => {
  assert.equal(await createJpegPhotoPdf([]), null);
  assert.equal(await createJpegPhotoPdf([photo('wide.jpg'), new File([fixture('wide.jpg')], 'x.png', { type: 'image/png' })]), null);
  assert.equal(await createJpegPhotoPdf([new File(['not a jpeg'], 'broken.jpg', { type: 'image/jpeg' })]), null);
});
