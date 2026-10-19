import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeEditorState } from '../../services/pdfEditorSnapshot.ts';
import type { EditorElement } from '../../services/pdfDocument.ts';

const dataUrl = `data:image/png;base64,${'A'.repeat(50_000)}`;
const image: EditorElement = {
  id: 'img-1', type: 'image', pageIndex: 0, x: 0.1, y: 0.1, width: 0.28, height: 0.2, content: dataUrl,
};
const text: EditorElement = { id: 'txt-1', type: 'text', pageIndex: 0, x: 0.2, y: 0.3, content: 'Hello' };

test('the snapshot never carries an image data URL', () => {
  const snapshot = serializeEditorState([image, text], {});
  assert.ok(!snapshot.includes('base64'));
  assert.ok(snapshot.length < 1000, `snapshot is ${snapshot.length} characters`);
  assert.ok(snapshot.includes('Hello'), 'text content is still compared in full');
});

test('adding, moving, resizing and removing an image each change the snapshot', () => {
  const empty = serializeEditorState([], {});
  const added = serializeEditorState([image], {});
  const moved = serializeEditorState([{ ...image, x: 0.5 }], {});
  const resized = serializeEditorState([{ ...image, width: 0.4 }], {});
  const removed = serializeEditorState([], {});
  assert.notEqual(added, empty);
  assert.notEqual(moved, added);
  assert.notEqual(resized, added);
  assert.notEqual(resized, moved);
  assert.equal(removed, empty);
});

test('the same state serializes identically, so a saved document reads as clean', () => {
  const formValues = { name: 'Ada', agree: true };
  assert.equal(
    serializeEditorState([image, text], formValues, { b1: { blockId: 'b1', pageIndex: 0, text: 'x', reflowing: false, patch: dataUrl } }),
    serializeEditorState([{ ...image }, { ...text }], { ...formValues }, { b1: { blockId: 'b1', pageIndex: 0, text: 'x', reflowing: false } }),
  );
});

test('a different picture of the same size on the same box is still a different element', () => {
  const other = { ...image, id: 'img-2' };
  assert.notEqual(serializeEditorState([image], {}), serializeEditorState([other], {}));
});
