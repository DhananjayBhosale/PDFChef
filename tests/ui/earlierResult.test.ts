import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameWork, type WorkSnapshot } from '../../components/UI/workSignature.ts';

// "Earlier result": what the result strip compares to tell a result is out of date.
// Fix round 2 (output/web/ui-redesign/audit/prompts/final-fix-2.md): the contracts behind each item.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const snap = (wide: boolean, entries: Record<string, string>): WorkSnapshot => ({ wide, entries: new Map(Object.entries(entries)) });

test('item 1: the earlier-result snapshot reads every input from the screen, not a list per tool', () => {
  const signature = read('components/UI/workSignature.ts');
  assert.match(signature, /const READ = 'input, select, textarea, \[role="slider"\], \[aria-pressed\], \[aria-checked\], \[aria-selected\], \[data-work-item\], \[data-page-item\]'/);
  assert.match(signature, /attributeFilter: \['aria-pressed', 'aria-checked', 'aria-selected', 'aria-valuenow', 'data-work-item', 'data-page-item', 'value', 'data-kind'\]/);
  assert.match(read('components/Tool/QueueRow.tsx'), /data-work-item=\{`\$\{name\}:\$\{file\.size\}`\}/);
  assert.match(read('components/UI/PageThumbnail.tsx'), /data-work-item=\{`\$\{pageIndex\}:\$\{normalizedRotation\}`\}/);
  for (const [tool, model] of [['EditPDF', 'currentSnapshot'], ['SignPDF', 'signatures'], ['ImageToPDF', 'pages'], ['MakeFillable', 'fields']]) {
    assert.match(read(`components/Tools/${tool}.tsx`), new RegExp(`useWorkInput\\(${model}\\)`), tool);
  }
  // Every input back as it was: the result is current again.
  assert.match(read('components/UI/OutputCenter.tsx'), /if \(sameWork\(now, base\.baseline\)\) \{ setStale\(false\); return; \}/);
});

test('finding 4: "Earlier result" compares by name, and a layout change alone changes nothing', () => {
  const phone = snap(false, { 'part:source': 'a.pdf', 'part:sentence:narrow:t': 'medium', 'DIV:Quality|aria-valuenow': '50' });
  // The same settings drawn in the wide layout: a new sentence, the slider in the band.
  assert.equal(sameWork(phone, snap(true, { 'part:source': 'a.pdf', 'part:sentence:wide:t': '50%', 'DIV:Quality|aria-valuenow': '50' })), true);
  assert.equal(sameWork(phone, snap(true, { 'part:source': 'a.pdf', 'part:sentence:wide:t': '50%', 'DIV:Quality|aria-valuenow': '53' })), false);
  // Same layout: order does not matter, an entry that came or went does.
  assert.equal(sameWork(phone, snap(false, { 'DIV:Quality|aria-valuenow': '50', 'part:sentence:narrow:t': 'medium', 'part:source': 'a.pdf' })), true);
  assert.equal(sameWork(phone, snap(false, { 'part:source': 'a.pdf', 'part:sentence:narrow:t': 'medium' })), false);
  assert.equal(sameWork(phone, snap(false, { ...Object.fromEntries(phone.entries), extra: '1' })), false);
});
