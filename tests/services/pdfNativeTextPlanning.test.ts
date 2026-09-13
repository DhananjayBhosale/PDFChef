import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planNativePdfTextEdits,
  resolveNativePdfTextTarget,
  sameSourceRun,
  type NativePdfTextTarget,
  type PdfTextObjectSnapshot,
} from '../../services/pdfNativeTextPlanning.ts';

/**
 * @param spacing How this document supplies the spaces between its words. `stored` means the file
 *   contains space characters. `generated` means it positions each word separately and stores none,
 *   so the extractor invents them — which is what most typeset PDFs do.
 */
const createObject = (
  text: string,
  objectIndex = 3,
  left = 72,
  spacing: 'stored' | 'generated' = 'stored',
): PdfTextObjectSnapshot => {
  let cursor = left;
  let textOffset = 0;
  const characters = Array.from(text).map((character, pageCharacterIndex) => {
    const width = character === 'W' ? 18 : character === 'i' ? 4 : character === ' ' ? 5 : 10;
    const start = textOffset;
    const end = start + character.length;
    const generated = spacing === 'generated' && character === ' ';
    const snapshot = {
      pageCharacterIndex,
      text: character,
      start,
      end,
      generated,
      // An invented space has no glyph, so the extractor reports no useful box for it.
      bounds: (generated ? [0, 0, 0, 0] : [cursor, 690, cursor + width, 708]) as [number, number, number, number],
    };
    cursor += width;
    textOffset = end;
    return snapshot;
  });
  return {
    objectIndex,
    text,
    bounds: [left, 690, cursor, 708],
    characters,
  };
};

const lineObject = createObject('This is a PDF file');

const targetFor = (
  object: PdfTextObjectSnapshot,
  sourceText: string,
  start = object.text.indexOf(sourceText),
): NativePdfTextTarget => {
  const end = start + sourceText.length;
  const selected = object.characters.filter((character) => character.start >= start && character.end <= end);
  return {
    sourceText,
    pdfRect: [
      Math.min(...selected.map((character) => character.bounds[0])),
      690,
      Math.max(...selected.map((character) => character.bounds[2])),
      708,
    ],
    sourceRun: {
      text: object.text,
      start,
      end,
      pdfRect: object.bounds,
    },
  };
};

test('a run the engine reports with a generated trailing space still resolves', () => {
  // Text extractors append a space when the next object on the line starts after a gap, so a run
  // that stands alone — a bold lead-in, a column, a table cell — reads back one character longer.
  assert.equal(sameSourceRun('Left column line 1 of text ', 'Left column line 1 of text'), true);
  assert.equal(sameSourceRun('Note: ', 'Note:'), true);
  assert.equal(sameSourceRun('Note:', 'Note: '), true);
  assert.equal(sameSourceRun('Note:', 'Note:'), true);
  // Anything before the trailing whitespace still has to be identical.
  assert.equal(sameSourceRun(' Note:', 'Note:'), false);
  assert.equal(sameSourceRun('Notes:', 'Note:'), false);
  assert.equal(sameSourceRun('Note: x', 'Note:'), false);
});

test('geometry resolves one word inside a larger PDF text object', () => {
  const result = resolveNativePdfTextTarget([lineObject], targetFor(lineObject, 'PDF'));

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.target.objectIndex, 3);
  assert.equal(lineObject.text.slice(result.target.start, result.target.end), 'PDF');
});

test('repeated words use the clicked geometry instead of text alone', () => {
  const object = createObject('PDF before PDF', 3, 50);
  const result = resolveNativePdfTextTarget([object], targetFor(object, 'PDF', 11));

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.target.start, 11);
});

test('ambiguous overlapping PDF text objects fail closed', () => {
  const result = resolveNativePdfTextTarget([
    lineObject,
    { ...lineObject, objectIndex: 4 },
  ], targetFor(lineObject, 'PDF'));

  assert.equal(result.supported, false);
  if (result.supported) return;
  assert.match(result.reason, /more than one PDF text object/);
});

test('overlapping identical text objects remain ambiguous without a hit-score shortcut', () => {
  const twin = {
    ...lineObject,
    objectIndex: 4,
    characters: lineObject.characters.map((character) => ({
      ...character,
      pageCharacterIndex: character.pageCharacterIndex + 100,
    })),
  };
  const selected = targetFor(lineObject, 'PDF');
  const result = resolveNativePdfTextTarget([lineObject, twin], selected);

  assert.equal(result.supported, false);
  if (result.supported) return;
  assert.match(result.reason, /more than one PDF text object/);
});

test('multiple words in one object are replaced without discarding their neighbours', () => {
  const result = planNativePdfTextEdits([lineObject], [
    { ...targetFor(lineObject, 'This'), replacementText: 'That' },
    { ...targetFor(lineObject, 'PDF'), replacementText: 'DOC' },
  ]);

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.deepEqual(result.changes, [{
    objectIndex: 3,
    originalText: 'This is a PDF file',
    replacementText: 'That is a DOC file',
  }]);
});

test('overlapping edits inside one object are rejected', () => {
  const result = planNativePdfTextEdits([lineObject], [
    { ...targetFor(lineObject, 'PDF'), replacementText: 'A' },
    { ...targetFor(lineObject, 'PDF file'), replacementText: 'B' },
  ]);

  assert.equal(result.supported, false);
  if (result.supported) return;
  assert.match(result.reason, /overlap/);
});

test('a source item must agree exactly with the PDFium text object', () => {
  const target = targetFor(lineObject, 'PDF');
  const result = resolveNativePdfTextTarget([lineObject], {
    ...target,
    sourceRun: { ...target.sourceRun!, text: 'This is a PDF split file' },
  });

  assert.equal(result.supported, false);
  if (result.supported) return;
  assert.match(result.reason, /could not be mapped/);
});

test('real character boxes beat proportional word-width guesses', () => {
  const object = createObject('WWW iii target', 3, 50);
  const target = targetFor(object, 'target');
  const result = resolveNativePdfTextTarget([object], {
    ...target,
    pdfRect: [100, 690, 145, 708],
  });

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.deepEqual(result.target.pdfRect, target.pdfRect);
});

test('direct word deletion consumes one separator without joining neighbours', () => {
  const result = planNativePdfTextEdits([lineObject], [
    { ...targetFor(lineObject, 'PDF'), replacementText: '' },
  ]);

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.changes[0].replacementText, 'This is a file');
});

test('adjacent direct deletions compose without a double space or joined words', () => {
  const result = planNativePdfTextEdits([lineObject], [
    { ...targetFor(lineObject, 'is', 5), replacementText: '' },
    { ...targetFor(lineObject, 'a'), replacementText: '' },
  ]);

  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.equal(result.changes[0].replacementText, 'This PDF file');
});

/**
 * The case that pushed whole documents onto the redraw path.
 *
 * A PDF that positions each word separately stores no space characters at all, so every space in
 * the extracted text is one the reader generated. Those used to be dropped, which left a hole in
 * the object's character run at each space — and a word whose text matched its object exactly then
 * failed to map onto it, so the edit could not be written in place and could not delete the
 * original either.
 */
test('a word maps onto its object when the document stores no spaces of its own', () => {
  const object = createObject('This is a PDF file', 3, 72, 'generated');
  assert.equal(
    object.characters.filter((character) => character.generated).length,
    4,
    'the fixture is meant to have four invented spaces',
  );

  const whole = resolveNativePdfTextTarget([object], targetFor(object, object.text, 0));
  assert.equal(whole.supported, true, whole.supported === false ? whole.reason : '');

  const word = resolveNativePdfTextTarget([object], targetFor(object, 'PDF'));
  assert.equal(word.supported, true, word.supported === false ? word.reason : '');
});

test('a run spanning invented spaces is measured from its glyphs, not the gaps', () => {
  const object = createObject('This is a PDF file', 3, 72, 'generated');
  const resolution = resolveNativePdfTextTarget([object], targetFor(object, object.text, 0));
  assert.equal(resolution.supported, true);
  if (!resolution.supported) return;
  // A generated space reports an empty box at the origin. Including it would drag the run's
  // rectangle back to 0 and make every later fit check nonsense.
  assert.ok(
    resolution.target.pdfRect[0] >= 72,
    `run rectangle started at ${resolution.target.pdfRect[0]}, so an invented space was measured`,
  );
});

test('extractor-owned spaces without an object character still permit exact source matching', () => {
  const object = createObject('one home, ', 3, 72, 'generated');
  const target = targetFor(object, object.text, 0);
  object.characters = object.characters.filter(character => !character.generated);
  assert.equal(resolveNativePdfTextTarget([object], target).supported, true);
  // A missing visible glyph must still refuse; only gaps made entirely of whitespace are safe.
  object.characters = object.characters.filter(character => character.start !== 1);
  assert.equal(resolveNativePdfTextTarget([object], target).supported, false);
});

const fragmentedRun = (parts: string[]) => {
  let left = 72;
  const objects = parts.map((part, index) => {
    const object = { ...createObject(part, index, left), fontId: 1, baseline: [left, 690] as [number, number] };
    left = object.bounds[2];
    return object;
  });
  const text = parts.join('');
  const rect: [number, number, number, number] = [72, 690, left, 710];
  return { objects, target: {
    sourceText: text, pdfRect: rect,
    sourceRun: { text, start: 0, end: text.length, pdfRect: rect },
  } };
};

test('a fitting whole-run replacement preserves separately stored word objects', () => {
  const { objects, target } = fragmentedRun(['DEVICE ', 'PAD']);
  const result = planNativePdfTextEdits(objects, [{ ...target, replacementText: 'DEVICE PAP' }]);
  assert.equal(result.supported, true);
  if (result.supported) assert.deepEqual(result.changes, [{
    objectIndex: 1, originalText: 'PAD', replacementText: 'PAP',
  }]);
});

test('a fragmented word is rewritten in its original font without introducing artificial spaces', () => {
  const { objects, target } = fragmentedRun([...('Career note')]);
  const result = planNativePdfTextEdits(objects, [{ ...target, replacementText: 'Career tone' }]);
  assert.equal(result.supported, true);
  if (result.supported) assert.deepEqual(result.changes, [
    { objectIndex: 7, originalText: 'n', replacementText: 'tone' },
    { objectIndex: 8, originalText: 'o', replacementText: '' },
    { objectIndex: 9, originalText: 't', replacementText: '' },
    { objectIndex: 10, originalText: 'e', replacementText: '' },
  ]);
});

test('appending to a fragmented run keeps its existing objects and font', () => {
  const { objects, target } = fragmentedRun(['100 ', 'Dr']);
  const result = planNativePdfTextEdits(objects, [{ ...target, replacementText: '100 Dr extra' }]);
  assert.equal(result.supported, true);
  if (result.supported) assert.deepEqual(result.changes, [{
    objectIndex: 1, originalText: 'Dr', replacementText: 'Dr extra',
  }]);
});

test('fragment matching rejects duplicate, incomplete, other-row and mixed-font objects', () => {
  const { objects, target } = fragmentedRun(['DEVICE ', 'PAD']);
  for (const candidates of [
    [...objects, { ...objects[1], objectIndex: 99 }],
    objects.slice(0, 1),
    [objects[0], { ...objects[1], baseline: [objects[1].bounds[0], 696] as [number, number] }],
    [objects[0], { ...objects[1], fontId: 2 }],
  ]) {
    const result = planNativePdfTextEdits(candidates, [{ ...target, replacementText: 'DEVICE PAP' }]);
    assert.equal(result.supported, false);
  }
});

test('a comma below the baseline remains part of a fragmented original-font word', () => {
  const { objects, target } = fragmentedRun(['Go ', 'h', 'o', 'm', 'e, ', 'again']);
  const comma = objects[4].characters.find(character => character.text === ',')!;
  comma.bounds[1] = 687;
  comma.bounds[3] = 689;
  const result = planNativePdfTextEdits(objects, [{ ...target, replacementText: 'Go hone, again' }]);
  assert.equal(result.supported, true);
  if (result.supported) {
    assert.equal(result.changes[0].replacementText, 'hone, ');
    assert.deepEqual(result.changes.map(change => change.objectIndex), [1, 2, 3, 4]);
  }
});
