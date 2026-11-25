import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sameWork, type WorkSnapshot } from '../../components/UI/workSignature.ts';

// The code review's fixes (output/web/ui-redesign/audit/prompts/review-fixes.md).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const snap = (wide: boolean, entries: Record<string, string>): WorkSnapshot => ({ wide, entries: new Map(Object.entries(entries)) });

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

test('findings 1, 3, 5, 6, 7: one heavy-job gate, Create PDF and Compare inputs, no repeat, Open PDF asks', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.match(screen, /export const pressMainAction = /);
  assert.match(screen, /const HEAVY_ACTION = '\[data-heavy-action\]';/);
  assert.match(screen, /if \(event\.repeat \|\| isOff\(main\)\) return;/);
  for (const tool of ['UnlockPDF', 'SecurityPDF']) assert.match(read(`components/Tools/${tool}.tsx`), /pressMainAction\(event\.currentTarget\)\) event\.preventDefault\(\);/, tool);
  assert.match(read('components/Tools/SplitPDF.tsx'), /data-heavy-action=""/);
  assert.match(read('components/Tools/MakePDF.tsx'), /className="tk-mtile" data-work-item=\{image\.id\}/);
  assert.match(read('components/Tools/ComparePDF.tsx'), /useWorkInput\(`\$\{file1\?\.name/);
  assert.match(read('components/UI/OutputCenter.tsx'), /navigate\('\/view', \{ state: \{ openTools: openTools && !accessLocked, openedPdfId: opened\.id, leavesWork: !openTools \} \}\);/);
});
