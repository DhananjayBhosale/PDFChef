import assert from 'node:assert/strict';
import test from 'node:test';
import { imagePdfOutputName } from '../../components/UI/format.ts';

// Cycle-3 QA: a photo from Android's picker arrives as "66.png", so the PDF was "66.pdf".
test('an image PDF is named after the image, or "images" when the image has no real name', () => {
  assert.equal(imagePdfOutputName('Holiday.jpg'), 'Holiday.pdf');
  assert.equal(imagePdfOutputName('IMG_20261014_1200.jpg'), 'IMG_20261014_1200.pdf');
  assert.equal(imagePdfOutputName('66.png'), 'images.pdf');
  assert.equal(imagePdfOutputName('66'), 'images.pdf');
  assert.equal(imagePdfOutputName('.png'), 'images.pdf');
  assert.equal(imagePdfOutputName('page 2.png'), 'page 2.pdf');
});
