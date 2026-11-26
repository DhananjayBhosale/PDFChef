import assert from 'node:assert/strict';
import test from 'node:test';
import { fitMiddleName, middleNameParts } from '../../components/UI/format.ts';

// A long file name is cut in the middle, never inside its date.
// A monospaced stand-in for the browser's measure: 7 px a character.
const mono = (text: string) => Array.from(text).length * 7;

test('item 4: the tail of a cut name starts at a word, so the date stays whole', () => {
  assert.deepEqual(middleNameParts('Merge PDF 16 Nov.pdf'), { head: 'Merge PDF', tail: ' 16 Nov.pdf' });
  assert.deepEqual(middleNameParts('qa-sample.pdf'), { head: 'qa-s', tail: 'ample.pdf' });
  // Never between the two halves of an emoji.
  assert.equal(middleNameParts(`ab${'😀'.repeat(6)}.pdf`).tail, '😀😀😀.pdf');
  assert.equal(middleNameParts('a.pdf').head, '');
});

test('item 4: a name that does not fit is cut in the middle, never inside the date', () => {
  const name = 'Merge PDF 16 Nov.pdf';
  assert.equal(fitMiddleName(name, mono(name), mono), null, 'a name that fits is left whole');
  assert.equal(fitMiddleName(name, 15 * 7, mono), 'Mer… 16 Nov.pdf');
  assert.equal(fitMiddleName(name, 13 * 7, mono), 'M… 16 Nov.pdf', 'a tail of whole words keeps one letter of the start');
  for (let room = 0; room < name.length; room += 1) {
    const shown = fitMiddleName(name, room * 7, mono);
    assert.ok(shown !== null && shown.endsWith('.pdf'), `room ${room}: ${shown}`);
    assert.doesNotMatch(shown, /…6 Nov/u, `room ${room}: "6 Nov" reads as the 6th`);
    assert.ok(mono(shown) <= room * 7 || shown === '….pdf', `room ${room}: ${shown} is too wide`);
  }
  // A short name in little room keeps its start and its end (Read PDF's title on a 360 px phone).
  assert.equal(fitMiddleName('qa-sample.pdf', 10 * 7, mono), 'qa-…le.pdf');
  assert.equal(fitMiddleName('Merge PDF 16 Nov.pdf', 14 * 7, mono), 'Me… 16 Nov.pdf');
});
