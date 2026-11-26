import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalNumberValue, liveNumberValue } from '../../components/UI/numberDraft.ts';

// A slider and its number box.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('a slider and its number box: the last one used wins (mobile-01)', () => {
  const field = read('components/UI/ChefSlider.tsx');
  // Focus alone does not make the box's text the value; only a keystroke does.
  assert.doesNotMatch(field, /onFocus=\{\(event\) => \{[^}]*editing/);
  assert.match(field, /onChange=\{\(event\) => \{\s*typed\.current = true;/);
  // Leaving a box nobody typed in changes nothing.
  assert.match(field, /const commit = \(\) => \{\s*if \(!typed\.current\) \{\s*setDraft\(format\(value\)\);\s*return;/);
  // Moving the slider drops typed text.
  assert.match(field, /const slide = \(next: number\) => \{\s*typed\.current = false;\s*onChange\(next\);/);
  assert.match(field, /<ChefSlider[\s\S]*?onChange=\{slide\}/);
});

test('a slider slot on a touch screen opens on its slider, not its box (mobile-02)', () => {
  const popover = read('components/Tool/Popover.tsx');
  assert.match(popover, /if \(target\?\.matches\(TYPING\) && window\.matchMedia\?\.\('\(pointer: coarse\)'\)\.matches\) \{\s*target = body\?\.querySelector<HTMLElement>\(SLIDER\) \?\? body\?\.querySelector<HTMLElement>\(STEP\) \?\? target;/);
});

test('a typed font size or part size is clamped when the box is left, not per key (mobile-03)', () => {
  // "12" on its way through "1" is not applied as 8, and "12" stays 12.
  assert.equal(liveNumberValue('1', 8, 48), null);
  assert.equal(liveNumberValue('12', 8, 48), 12);
  assert.equal(finalNumberValue('120', 8, 48), 48);
  assert.equal(finalNumberValue('', 8, 48), null);
  assert.match(read('components/Tools/PdfAdvancedTools.tsx'), /<ClampedNumberInput\s+min=\{8\}\s+max=\{48\}\s+value=\{fontSize\}/);
  assert.match(read('components/Tools/BatchPDF.tsx'), /<ClampedNumberInput[\s\S]{0,200}?value=\{pagesPerSplit\}/);
});
