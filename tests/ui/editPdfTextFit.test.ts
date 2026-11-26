import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Edit PDF and text that no longer fits.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('Edit PDF marks text that no longer fits while it is typed (desktop-08)', () => {
  assert.match(read('components/Tools/EditPDF.tsx'), /data-overflow=\{textLayout\?\.overflow \? '' : undefined\}/);
  assert.match(read('components/Tool/tool.css'), /\[data-testid="inline-text-editor"\]\[data-overflow\]/);
});
