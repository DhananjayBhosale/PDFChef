import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getVisualPageSize,
  normalizePageRotation,
  rotatePointAroundCenter,
  rotatedBoxOrigin,
  visualPointToPdf,
  visualRectangleToPdf,
} from '../../services/pdfEditorGeometry.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const closeTo = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to equal ${expected}`);

test('a rotated box origin keeps the box centre fixed', () => {
  const origin = rotatedBoxOrigin(20, 75, 20, 10, 90);
  closeTo(origin.x, 25);
  closeTo(origin.y, 65);
});

test('a text baseline point rotates with its containing box', () => {
  const origin = rotatePointAroundCenter(10, 70, 20, 75, 90);
  closeTo(origin.x, 25);
  closeTo(origin.y, 65);
});

test('zero rotation preserves the original draw origin', () => {
  assert.deepEqual(rotatedBoxOrigin(20, 75, 20, 10, 0), { x: 10, y: 70 });
  assert.deepEqual(rotatePointAroundCenter(10, 70, 20, 75, 0), { x: 10, y: 70 });
});

test('viewport coordinates map through crop offsets and page rotation', () => {
  const base = { cropX: 20, cropY: 30, cropWidth: 600, cropHeight: 800 };
  assert.deepEqual(visualPointToPdf({ ...base, rotation: 0 }, 10, 15), { x: 30, y: 815 });
  assert.deepEqual(visualPointToPdf({ ...base, rotation: 90 }, 10, 15), { x: 35, y: 40 });
  assert.deepEqual(visualPointToPdf({ ...base, rotation: 180 }, 10, 15), { x: 610, y: 45 });
  assert.deepEqual(visualPointToPdf({ ...base, rotation: 270 }, 10, 15), { x: 605, y: 820 });
  assert.deepEqual(getVisualPageSize({ ...base, rotation: 90 }), { width: 800, height: 600 });
  assert.equal(normalizePageRotation(-90), 270);
});

test('viewport rectangles become positive PDF-space bounds', () => {
  const rectangle = visualRectangleToPdf(
    { cropX: 20, cropY: 30, cropWidth: 600, cropHeight: 800, rotation: 90 },
    10,
    15,
    100,
    20,
  );
  assert.deepEqual(rectangle, { x: 35, y: 40, width: 20, height: 100 });
});

test('the annotation exporter uses centre-corrected origins without changing ellipse semantics', () => {
  const source = readFileSync(resolve(root, 'services/pdfDocument.ts'), 'utf8');
  const exporter = source.slice(source.indexOf('export const savePDFWithAnnotations'), source.indexOf('export interface SignaturePlacement'));

  assert.equal((exporter.match(/const origin = rotatedBoxOrigin\(/g) ?? []).length, 3);
  assert.match(exporter, /page\.drawRectangle\(\{\s*x: origin\.x,\s*y: origin\.y,/);
  assert.match(exporter, /page\.drawImage\(image, \{\s*x: origin\.x,\s*y: origin\.y,/);
  assert.match(exporter, /const origin = rotatePointAroundCenter\([\s\S]*page\.drawText\(line, \{\s*x: origin\.x,\s*y: origin\.y,/);
  assert.match(exporter, /page\.drawEllipse\(\{\s*x: center\.x,\s*y: center\.y,/);
  assert.match(exporter, /const start = visualPointToPdf\(geometry, visualX, visualY\)/);
  assert.match(exporter, /rotate: degrees\(geometry\.rotation \+ rotation\)/);
});

test('a redrawn paragraph is repainted before it is redrawn, and before any annotation', () => {
  const source = readFileSync(resolve(root, 'services/pdfDocument.ts'), 'utf8');
  const exporter = source.slice(source.indexOf('export const savePDFWithAnnotations'), source.indexOf('export interface SignaturePlacement'));
  const reflowLoop = exporter.indexOf('for (const edit of reflowParagraphEdits)');
  const annotationLoop = exporter.indexOf('for (const element of elements)');

  assert.ok(reflowLoop >= 0, 'paragraph reflow loop is missing');
  assert.ok(annotationLoop > reflowLoop, 'paragraphs must be redrawn before annotations are placed on top');

  const reflow = exporter.slice(reflowLoop, annotationLoop);
  const patch = reflow.indexOf('pdfDoc.embedPng(edit.backgroundImage)');
  const redraw = reflow.indexOf('page.drawText(piece.text');
  assert.ok(patch >= 0 && redraw > patch, 'the paragraph area must be painted out before new text lands on it');
  // Each stretch is drawn in the face it carries, so a bold lead-in survives a redraw.
  assert.match(reflow, /font: fonts\[paragraphStandardFontKey\(piece\.face\)\]/);

  // A page whose drawing operations cannot be reconstructed falls back to the sampled paper
  // colour rather than an assumed white rectangle.
  assert.match(reflow, /page\.drawRectangle\(\{ \.\.\.patch, color: hexToRgb\(edit\.backgroundColor\) \}\)/);
  assert.match(reflow, /visualRectangleToPdf/);
  assert.match(reflow, /rotate: degrees\(geometry\.rotation\)/);
  // The document's own program is deliberately NOT re-embedded: what PDF.js exposes is a copy
  // transcoded for the browser, and drawing Unicode through it lost characters off the page.
  assert.doesNotMatch(exporter, /embedFont\(face\.data/);
  assert.match(exporter, /layoutParagraphLines\(edit\.lines/);
});

test('direct paragraph edits rewrite text objects and never reach the pdf-lib redraw', () => {
  const source = readFileSync(resolve(root, 'services/pdfDocument.ts'), 'utf8');
  const exporter = source.slice(source.indexOf('export const savePDFWithAnnotations'), source.indexOf('export interface SignaturePlacement'));

  assert.match(exporter, /applyNativePdfTextEdits/);
  assert.match(exporter, /directParagraphEdits\.flatMap\(\(edit\) => edit\.runEdits\.map/);
  // A run edit replaces a whole source run, so the target span is the run itself.
  assert.match(exporter, /start: 0,\s*end: run\.sourceText\.length,/);
  assert.match(exporter, /if \(containsOnlyDirectText\) return sourceBytes/);
});
