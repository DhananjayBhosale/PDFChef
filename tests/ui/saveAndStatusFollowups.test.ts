import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const between = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  assert.ok(from > -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
};

test('Edit PDF cannot save, or spend a free job, before anything has changed', () => {
  const source = read('components/Tools/EditPDF.tsx');
  const saves = source.match(/onClick=\{handleSave\}[^>]*>/g) ?? [];
  assert.ok(saves.length >= 2);
  for (const button of saves) assert.match(button, /disabled=\{status\.isProcessing \|\| !hasUnsavedEdits\}/);
});

test('Reorder Pages cannot save the original order', () => {
  const source = read('components/Tools/ReorderPDF.tsx');
  assert.match(source, /disabled=\{loadingPreviews \|\| items\.length === 0 \|\| !hasOrderChanges\}/);
});

test('Rotate Pages names how the selected pages now face, not the last tap', () => {
  const block = between(read('components/Tools/RotatePDF.tsx'), 'const rotateSelected', 'const resetRotation');
  assert.match(block, /new Set\(selectedPages\.map\(index => next\[index\]\)\)/);
  assert.match(block, /turn === 90 \|\| turn === -90/);
  assert.doesNotMatch(block, /angle < 0 \? 'rotate\.turned/);
});

test('Recent treats a closed picker as a choice, not a failure', () => {
  const block = between(read('components/Pages/RecentPage.tsx'), 'const run = useCallback', 'const openRef');
  const cancel = block.indexOf("caught.name === 'AbortError') return false;");
  assert.ok(cancel > -1);
  assert.ok(cancel < block.indexOf("haptic('error')"));
  assert.ok(cancel < block.indexOf("report('danger'"));
});

test('a Recent message never times out and pulls the list from under a finger', () => {
  const block = between(read('components/Pages/RecentPage.tsx'), 'const report = useCallback', 'const run = useCallback');
  assert.doesNotMatch(block, /setTimeout/);
});

test('Storage used is read again whenever files change', () => {
  const hook = between(read('hooks/useWorkspaceRuntime.tsx'), 'export const useStorageInformation', 'export const useApplicationMetadata');
  assert.match(hook, /addEventListener\(OUTPUT_EVENT, read\)/);
  assert.match(hook, /addEventListener\(RECORDS_CHANGED_EVENT, read\)/);
  assert.match(hook, /removeEventListener\(RECORDS_CHANGED_EVENT, read\)/);
  const clear = between(read('components/Pages/SettingsPage.tsx'), 'await platform.records.clearRecords();', 'setNotice(');
  assert.match(clear, /announceRecordsChanged\(\)/);
});

test('Home does not say 0 free jobs while the App Store is still answering', () => {
  const source = read('components/Tools/Dashboard.tsx');
  assert.match(source, /loading: monetizationLoading/);
  const line = between(source, '{access?.unlocked', '</span>');
  assert.match(line, /access \|\| !monetizationLoading\s*\?\s*t\("dashboard\.full\.job\.left/);
});
