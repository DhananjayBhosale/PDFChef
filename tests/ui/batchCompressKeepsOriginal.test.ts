import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Cycle-2 QA: Batch > Compress turned a 2.8 kB PDF into 337 kB, while Compress PDF keeps the
// original when the new copy is not smaller. Batch must make the same choice.
test('batch compress keeps the original file when compression would not make it smaller', () => {
  const batch = readFileSync(new URL('../../components/Tools/BatchPDF.tsx', import.meta.url), 'utf8');
  assert.match(batch, /result\.data\.length >= file\.size\) return \{ blob: file, filename: file\.name \}/);
});
