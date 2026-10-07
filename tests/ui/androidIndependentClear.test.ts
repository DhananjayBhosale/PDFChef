import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { withoutOutputPayload, type OutputRecord } from '../../services/workspace.ts';
import english from '../../services/i18n/en-US.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const recent = readFileSync(resolve(root, 'components/Pages/RecentPage.tsx'), 'utf8');
const workspace = readFileSync(resolve(root, 'services/workspace.ts'), 'utf8');

const record = (): OutputRecord => ({
  id: 'session-1',
  filename: 'Scan.pdf',
  mimeType: 'application/pdf',
  size: 23,
  toolPath: '/make-pdf',
  createdAt: 42,
  blob: new Blob(['%PDF-1.7\n%%EOF'], { type: 'application/pdf' }),
});

test('payload-only clear removes bytes while preserving every session record field', () => {
  const original = record();
  const cleared = withoutOutputPayload(original);
  assert.deepEqual(cleared, { ...original, blob: null });
  assert.equal(original.blob instanceof Blob, true);
  assert.equal(withoutOutputPayload(cleared), cleared);
});

test('session payload clearing is one read-write cursor transaction', () => {
  const body = workspace.slice(
    workspace.indexOf('export const clearOutputDocuments'),
    workspace.indexOf('export const recordOutput'),
  );
  assert.match(body, /db\.transaction\(OUTPUT_STORE, 'readwrite'\)/);
  assert.match(body, /store\.openCursor\(\)/);
  assert.match(body, /cursor\.update\(withoutOutputPayload\(record\)\)/);
  assert.match(body, /await transactionComplete\(transaction\)/);
  assert.doesNotMatch(body, /\.clear\(\)/);
});

test('the frozen Recent surface keeps the two destructive choices distinct and non-undoable', () => {
  assert.equal(english["recent-page.delete.files.only.911496"], 'Delete files only');
  assert.match(recent, /t\("recent-page\.delete\.files\.only\.911496"\)/);
  assert.match(recent, /mode === 'documents' \? platform\.records\.clearDocuments\(\) : platform\.records\.clearRecords\(\)/);
  assert.match(recent, /setPendingUndo\(null\)/);
  assert.equal(english["recent-page.the.list.of.what.you.made.stays.d6827e"], 'The list of what you made stays. ');
  assert.equal(english["recent-page.files.from.the.older.android.app.stay.610916"], ' Files from the older Android app stay where they are.');
  assert.match(recent, /t\("recent-page\.this\.cannot\.be\.undone\.copies\.you\.saved\.098cb0"/);
});
