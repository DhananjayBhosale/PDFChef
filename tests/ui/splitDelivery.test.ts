import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SPLIT_DELIVERY, isSplitDelivery, resolveSplitDelivery, splitDeliveryLine } from '../../components/Tools/splitDelivery.ts';
import { separatePath } from '../../services/saveSeparately.ts';
import type { WorkspaceCapabilities } from '../../services/platform/contracts.ts';

const caps = (over: Partial<WorkspaceCapabilities> = {}) => ({ ...over } as WorkspaceCapabilities);
const noFeatures = { directoryPicker: false, shareFiles: false };

test('the untouched value is automatic; a kept value is either choice (overnight A10)', () => {
  assert.equal(DEFAULT_SPLIT_DELIVERY, 'auto');
  assert.equal(isSplitDelivery('auto'), true);
  assert.equal(isSplitDelivery('separate'), true);
  assert.equal(isSplitDelivery('zip'), true);
  assert.equal(isSplitDelivery('folder'), false, 'another version’s value falls back to the default');
  assert.equal(isSplitDelivery(undefined), false);
});

test('untouched: one ZIP above 10 parts on the downloads and share paths, separate PDFs otherwise (overnight A10)', () => {
  assert.equal(resolveSplitDelivery('auto', 'downloads', 12), 'zip', 'downloads, 12 parts');
  assert.equal(resolveSplitDelivery('auto', 'share', 12), 'zip', 'share, 12 parts');
  assert.equal(resolveSplitDelivery('auto', 'downloads', 11), 'zip', 'downloads, 11 parts');
  assert.equal(resolveSplitDelivery('auto', 'downloads', 10), 'separate', 'downloads, 10 parts');
  assert.equal(resolveSplitDelivery('auto', 'share', 3), 'separate', 'share, 3 parts');
  assert.equal(resolveSplitDelivery('auto', 'folder', 12), 'separate', 'folder, 12 parts');
  assert.equal(resolveSplitDelivery('auto', 'sequential', 80), 'separate', 'the Android app, 80 parts');
  assert.equal(resolveSplitDelivery('auto', 'native', 80), 'separate', 'a native set save, 80 parts');
  assert.equal(resolveSplitDelivery('auto', 'downloads', null), 'separate', 'a split by size: the count is unknown');
  assert.equal(resolveSplitDelivery('auto', 'share', null), 'separate', 'share, unknown count');
});

test('the person’s own pick wins at any count (overnight A10)', () => {
  for (const path of ['downloads', 'share', 'folder', 'sequential', 'native'] as const) {
    for (const count of [2, 3, 10, 12, 80, null]) {
      assert.equal(resolveSplitDelivery('separate', path, count), 'separate', `separate, ${path}, ${count}`);
      assert.equal(resolveSplitDelivery('zip', path, count), 'zip', `zip, ${path}, ${count}`);
    }
  }
});

test('no choice where the parts cannot be saved one by one (the iOS app)', () => {
  const iosApp = separatePath({ capabilities: caps({ durableDocuments: true, automaticExternalExport: false }) }, noFeatures);
  assert.equal(iosApp, null);
  assert.equal(splitDeliveryLine(iosApp, 12), null);
  assert.equal(splitDeliveryLine(iosApp, null), null);
});

test('no choice for a split that makes one part (or none yet)', () => {
  assert.equal(splitDeliveryLine('downloads', 1), null);
  assert.equal(splitDeliveryLine('downloads', 0), null);
});

test('the line names the exact part count for each choice', () => {
  const line = splitDeliveryLine('downloads', 12);
  assert.ok(line);
  assert.equal(line.template, 'split.delivery.line');
  assert.equal(line.separate, '12 separate PDFs');
  assert.equal(line.zip, 'one ZIP with 12 PDFs');
  const two = splitDeliveryLine('sequential', 2);
  assert.equal(two?.separate, '2 separate PDFs');
  assert.equal(two?.zip, 'one ZIP with 2 PDFs');
});

test('a split by size cannot count its parts in advance: the line names no number', () => {
  const line = splitDeliveryLine('folder', null);
  assert.ok(line);
  assert.equal(line.template, 'split.delivery.lineUnknown');
  assert.equal(line.separate, 'separate PDFs');
  assert.equal(line.zip, 'one ZIP');
});
