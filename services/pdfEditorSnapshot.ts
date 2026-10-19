import type { BlockEditState } from '../components/Tools/PdfTextBlockLayer.tsx';
import type { PdfFormFieldValue } from './pdfBrowser.ts';
import type { EditorElement } from './pdfDocument.ts';

/**
 * A picture's data URL can run to tens of megabytes, and the snapshot is rebuilt on every drag
 * frame, so the dirty check carries the picture's size instead. A picture is never re-encoded in
 * place: a different picture is a different element, and a moved or resized one changes its box.
 */
const snapshotElement = (element: EditorElement) => (
  element.type === 'image' ? { ...element, content: `image:${element.content.length}` } : element
);

/** The editor's state as one string, compared against the last saved one for the dirty check. */
export const serializeEditorState = (
  elements: EditorElement[],
  formValues: Record<string, PdfFormFieldValue>,
  blockEdits: Record<string, BlockEditState> = {},
) => JSON.stringify({
  elements: elements.map(snapshotElement),
  formValues,
  // Only the typed result matters for the dirty check; the cached repaint image does not.
  blocks: Object.values(blockEdits).map(({ blockId, text, fontOverride, color, fontSize }) => ({
    blockId,
    text,
    fontOverride,
    color,
    fontSize,
  })),
});
