import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptsDroppedFile } from '../../services/fileDrop.ts';

test('PDF drops recognize MIME or extension, including missing Finder MIME', () => {
  for (const file of [{ name: 'statement.PDF', type: '' }, { name: 'document', type: 'application/pdf' }]) {
    assert.equal(acceptsDroppedFile(file, '.pdf, application/pdf'), true);
  }
  assert.equal(acceptsDroppedFile({ name: 'signature.png', type: 'image/png' }, '.pdf'), false);
});

test('image drops honor MIME wildcards and explicit extensions without accepting other files', () => {
  assert.equal(acceptsDroppedFile({ name: 'signature', type: 'image/png' }, 'image/*'), true);
  assert.equal(acceptsDroppedFile({ name: 'signature.PNG', type: '' }, 'image/*,.png'), true);
  assert.equal(acceptsDroppedFile({ name: 'notes.txt', type: 'text/plain' }, 'image/*,.png'), false);
  assert.equal(acceptsDroppedFile({ name: 'file', type: '' }, ''), false);
});
