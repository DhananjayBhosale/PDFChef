import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { countZipParts, numberedPartName, pickSeparateFolder, readZipParts, saveParts, separatePartName, separatePath, type SeparatePart } from '../../services/saveSeparately.ts';
import type { WorkspaceCapabilities } from '../../services/platform/contracts.ts';

const caps = (over: Partial<WorkspaceCapabilities> = {}) => ({ ...over } as WorkspaceCapabilities);
const browser = { directoryPicker: false, shareFiles: false };
const parts = (count: number): SeparatePart[] =>
  Array.from({ length: count }, (_, index) => ({ name: `report-split-part_${index + 1}.pdf`, blob: new Blob([`%PDF-${index}`]) }));

test('each part is named "<ZIP name without .zip>-<entry name>"', () => {
  assert.equal(separatePartName('report-split.zip', 'part_2.pdf'), 'report-split-part_2.pdf');
  assert.equal(separatePartName('Report.ZIP', 'folder/part_10.pdf'), 'Report-part_10.pdf');
});

test('the ZIP is read in natural order, PDFs only', async () => {
  const zip = new JSZip();
  zip.file('part_10.pdf', 'ten');
  zip.file('part_2.pdf', 'two');
  zip.file('part_1.pdf', 'one');
  zip.file('readme.txt', 'skip');
  const blob = new Blob([await zip.generateAsync({ type: 'uint8array' })]);
  assert.equal(await countZipParts(blob), 3);
  const read = await readZipParts(blob, 'report-split.zip');
  assert.deepEqual(read.map((part) => part.name), ['report-split-part_1.pdf', 'report-split-part_2.pdf', 'report-split-part_10.pdf']);
  assert.equal(await read[2].blob.text(), 'ten');
  assert.equal(read[0].blob.type, 'application/pdf');
});

test('the path follows what the platform can do', () => {
  const many = async () => {};
  assert.equal(separatePath({ capabilities: caps({ multipleFileExport: true }), saveFreshMany: many }, browser), 'native');
  assert.equal(separatePath({ capabilities: caps({ multipleFileExport: true }) }, browser), 'downloads', 'the flag alone is not enough');
  assert.equal(separatePath({ capabilities: caps({ durableDocuments: true }) }, browser), 'sequential', 'Android saves without a picker');
  assert.equal(separatePath({ capabilities: caps({ durableDocuments: true, automaticExternalExport: false }) }, browser), null, 'iOS app: hidden');
  assert.equal(separatePath({ capabilities: caps() }, { directoryPicker: true, shareFiles: true }), 'folder');
  assert.equal(separatePath({ capabilities: caps() }, { directoryPicker: false, shareFiles: true }), 'share');
  assert.equal(separatePath({ capabilities: caps() }, browser), 'downloads');
});

test('downloads: one per file, in order, with progress', async () => {
  const names: string[] = [];
  const progress: string[] = [];
  const outcome = await saveParts(parts(3), 'downloads', {
    pauseMs: 0,
    download: (_blob, name) => { names.push(name); },
    onProgress: (current, total) => progress.push(`${current}/${total}`),
  });
  assert.deepEqual(names, ['report-split-part_1.pdf', 'report-split-part_2.pdf', 'report-split-part_3.pdf']);
  assert.deepEqual(progress, ['1/3', '2/3', '3/3']);
  assert.deepEqual(outcome.saved, [0, 1, 2]);
});

test('a partial run is retried for the files that were not saved', async () => {
  let fail = true;
  const savedNames: string[] = [];
  const saveFresh = async ({ name }: { name: string }) => {
    if (fail && name.endsWith('_2.pdf')) throw new Error('disk full');
    savedNames.push(name);
  };
  const first = await saveParts(parts(3), 'sequential', { saveFresh });
  assert.deepEqual(first.saved, [0, 2]);
  fail = false;
  const progress: string[] = [];
  const retry = await saveParts(parts(3), 'sequential', { saveFresh, skip: first.saved, onProgress: (current, total) => progress.push(`${current}/${total}`) });
  assert.deepEqual(retry.saved.sort(), [0, 1, 2]);
  assert.deepEqual(savedNames, ['report-split-part_1.pdf', 'report-split-part_3.pdf', 'report-split-part_2.pdf'], 'the retry saves only the missing file');
  assert.deepEqual(progress, ['3/3']);
});

test('folder: one pick, each file written, a failed write left for a retry', async () => {
  const written: string[] = [];
  // An empty folder: a name is found only once it is created (the save looks a name up first, s2-01).
  const folder = {
    name: 'Splits',
    getFileHandle: async (name: string, options?: { create?: boolean }) => (options?.create ? {
      createWritable: async () => {
        if (name.endsWith('_3.pdf')) throw new Error('denied');
        return { write: async () => { written.push(name); }, close: async () => {} };
      },
    } : Promise.reject(new DOMException(name, 'NotFoundError'))),
  } as unknown as FileSystemDirectoryHandle;
  let picks = 0;
  const outcome = await saveParts(parts(3), 'folder', { showDirectoryPicker: async () => { picks += 1; return folder; } });
  assert.equal(picks, 1);
  assert.deepEqual(written, ['report-split-part_1.pdf', 'report-split-part_2.pdf']);
  assert.deepEqual(outcome, { saved: [0, 1], folder: 'Splits' });
});

test('a dismissed picker or share sheet changes nothing', async () => {
  const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
  assert.deepEqual(await saveParts(parts(2), 'folder', { showDirectoryPicker: async () => { throw abort; } }), { saved: [], cancelled: true });
  assert.deepEqual(await saveParts(parts(2), 'share', { share: async () => { throw abort; } }), { saved: [], cancelled: true });
  assert.deepEqual(await saveParts(parts(2), 'native', { saveFreshMany: async () => { throw abort; } }), { saved: [], cancelled: true });
});

test('share and native send the whole set at once', async () => {
  let shared = 0;
  assert.deepEqual((await saveParts(parts(3), 'share', { share: async (data) => { shared = data.files?.length ?? 0; } })).saved, [0, 1, 2]);
  assert.equal(shared, 3);
  let sent: string[] = [];
  await saveParts(parts(3), 'native', { saveFreshMany: async (results) => { sent = results.map((result) => result.name); } });
  assert.equal(sent.length, 3);
});

test('a folder picked before the split is used as it is: no second picker', async () => {
  const written: string[] = [];
  // An empty folder: a name is found only once it is created (the save looks a name up first, s2-01).
  const folder = {
    name: 'Picked',
    getFileHandle: async (name: string, options?: { create?: boolean }) => (options?.create ? {
      createWritable: async () => ({ write: async () => { written.push(name); }, close: async () => {} }),
    } : Promise.reject(new DOMException(name, 'NotFoundError'))),
  } as unknown as FileSystemDirectoryHandle;
  let picks = 0;
  const outcome = await saveParts(parts(2), 'folder', { folder, showDirectoryPicker: async () => { picks += 1; return folder; } });
  assert.equal(picks, 0);
  assert.deepEqual(written, ['report-split-part_1.pdf', 'report-split-part_2.pdf']);
  assert.deepEqual(outcome, { saved: [0, 1], folder: 'Picked' });
});

test('asking for the folder at the tap: dismissed is null, a real failure is thrown', async () => {
  const folder = { name: 'Splits' } as unknown as FileSystemDirectoryHandle;
  const asked: object[] = [];
  assert.equal(await pickSeparateFolder(async (options) => { asked.push(options ?? {}); return folder; }), folder);
  assert.deepEqual(asked, [{ mode: 'readwrite', id: 'pdf-chef-split' }], 'the same folder memory as the result sheet’s button');
  const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
  assert.equal(await pickSeparateFolder(async () => { throw abort; }), null);
  await assert.rejects(pickSeparateFolder(async () => { throw new Error('SecurityError'); }));
  assert.equal(await pickSeparateFolder(undefined), null, 'no picker: nothing to ask');
});

/** A folder in memory that answers as a real one does: a name it does not hold is not found unless created. */
const memoryFolder = (name: string, files: Map<string, Blob>) => ({
  name,
  getFileHandle: async (file: string, options?: { create?: boolean }) => {
    if (!files.has(file) && !options?.create) throw new DOMException(`${file} was not found`, 'NotFoundError');
    return {
      createWritable: async () => {
        let pending: Blob | undefined;
        return { write: async (blob: Blob) => { pending = blob; }, close: async () => { files.set(file, pending!); } };
      },
    };
  },
}) as unknown as FileSystemDirectoryHandle;

// s2-01 (overnight A3): saving into a folder never replaces a file that is already there.
test('a folder save keeps a file already there and saves the part under the next free name', async () => {
  const someoneElses = new Blob(['%PDF- a different document']);
  const olderCopy = new Blob(['%PDF- an older copy']);
  const files = new Map<string, Blob>([
    ['report-split-part_1.pdf', someoneElses],
    ['report-split-part_1 (1).pdf', olderCopy],
  ]);
  const outcome = await saveParts(parts(2), 'folder', { folder: memoryFolder('Splits', files) });
  assert.deepEqual(outcome, { saved: [0, 1], folder: 'Splits' });
  assert.equal(files.get('report-split-part_1.pdf'), someoneElses, 'the file already there is untouched');
  assert.equal(files.get('report-split-part_1 (1).pdf'), olderCopy, 'so is the first numbered name');
  assert.equal(await files.get('report-split-part_1 (2).pdf')?.text(), '%PDF-0', 'the part takes the next free name');
  assert.equal(await files.get('report-split-part_2.pdf')?.text(), '%PDF-1', 'a free name is used as it is');
  assert.equal(files.size, 4);
});

// s2-03 (overnight A5): a retry with no folder to reuse asks for one and writes the whole set there.
test('a folder retry writes into the folder it is given, or the whole set into a newly picked one', async () => {
  const a = new Map<string, Blob>([['report-split-part_1.pdf', new Blob(['%PDF-0'])]]);
  const reused = await saveParts(parts(2), 'folder', { skip: [0], folder: memoryFolder('A', a) });
  assert.deepEqual(reused.saved, [0, 1]);
  assert.equal(reused.folder, 'A');
  assert.equal(a.size, 2, 'only the missing part is added to the same folder');

  const b = new Map<string, Blob>();
  const picked = await saveParts(parts(2), 'folder', { skip: [0], showDirectoryPicker: async () => memoryFolder('B', b) });
  assert.deepEqual(picked.saved.sort(), [0, 1]);
  assert.equal(picked.folder, 'B');
  assert.deepEqual([...b.keys()].sort(), ['report-split-part_1.pdf', 'report-split-part_2.pdf'], 'a new folder gets the whole set');
});

// s2-08 (overnight A6): part names stay within the 180-character name limit (Android refuses longer).
test('a long ZIP name gives part names of at most 180 characters, all different, each keeping its part', async () => {
  const { toolOutputName } = await import('../../components/UI/format.ts');
  const { buildPageExportLabel } = await import('../../services/androidParity.ts');
  const { AndroidDocumentsClient } = await import('../../services/platform/android/androidDocuments.ts');
  const zipName = toolOutputName('split', `${'a'.repeat(172)}.pdf`, 'zip');
  assert.equal(zipName.length, 180);
  const entries = Array.from({ length: 12 }, (_, n) => `part_${n + 1}_${buildPageExportLabel([n])}.pdf`);
  const names = entries.map((entry) => separatePartName(zipName, entry));
  for (const [index, name] of names.entries()) {
    assert.ok(name.length <= 180, `${name.length} characters`);
    assert.ok(name.endsWith(`-${entries[index]}`), 'the part suffix and .pdf are kept');
    assert.ok(name.startsWith('split-aaaa'), 'the name still starts with the ZIP’s');
  }
  assert.equal(new Set(names).size, names.length, 'all different');
  assert.equal(separatePartName('report-split.zip', 'part_2.pdf'), 'report-split-part_2.pdf', 'a short name is unchanged');

  // Each name passes the Android app's own check and reaches the native write.
  const requested: string[] = [];
  const client = new AndroidDocumentsClient({
    async beginWrite(request: { displayName?: string; name?: string }) { requested.push(request.displayName ?? request.name ?? ''); throw new Error('stop here'); },
  } as never);
  await saveParts(names.slice(0, 2).map((name) => ({ name, blob: new Blob(['%PDF']) })), 'sequential', {
    saveFresh: async (part) => { await client.beginWrite('application/pdf', part.name); },
  });
  assert.equal(requested.length, 2, 'both names reach the native write');
});

test('a numbered free name stays within the limit too', () => {
  const long = `${'b'.repeat(169)}-part_1.pdf`;
  assert.equal(long.length, 180);
  const numbered = numberedPartName(long, 12);
  assert.ok(numbered.length <= 180, `${numbered.length} characters`);
  assert.ok(numbered.endsWith('-part_1 (12).pdf'), numbered);
  assert.equal(numberedPartName('report-split-part_1.pdf', 2), 'report-split-part_1 (2).pdf');
});

test('an Android browser downloads the parts instead of opening the folder picker', async () => {
  const { usesFolderPicker } = await import('../../services/saveSeparately.ts');
  const androidChrome = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/132.0.0.0 Mobile Safari/537.36';
  const desktopChrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/132.0.0.0 Safari/537.36';
  assert.equal(usesFolderPicker(androidChrome, true), false);
  assert.equal(usesFolderPicker(desktopChrome, true), true);
  assert.equal(usesFolderPicker(desktopChrome, false), false);
});
