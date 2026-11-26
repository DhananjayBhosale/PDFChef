import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A main action is offered only when it can produce output.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('Extract applies a valid typed range as it is typed (H2-02)', () => {
  assert.match(read('components/UI/PageRangeSelector.tsx'), /if \(live && next\.trim\(\) && !unavailable && !composingRef\.current\)/);
  assert.match(read('components/Tools/ExtractPages.tsx'), /<PageRangeSelector[\s\S]{0,600}?\blive\b/);
});

test('an all-blank file leaves no main action that cannot produce output (h4-03)', () => {
  // Remove blank pages marks the blank pages before it runs (path to 9, part 2): an all-blank file
  // has every page marked, and the action stays off while every page is marked.
  const tools = read('components/Tools/PdfAdvancedTools.tsx');
  assert.match(tools, /const allMarked = totalPages > 0 && marked\.length >= totalPages;/);
  assert.match(tools, /runDisabled=\{status\.isProcessing \|\| scanning \|\| marked\.length === 0 \|\| allMarked \|\| Boolean\(previewError\)\}/);
});
