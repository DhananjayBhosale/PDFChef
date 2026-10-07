import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { RecentRecord, StoredCollection } from '../../services/domain/workspaceModels.ts';

/**
 * T906. Recent can now rename a durable Android row and take back a deletion of
 * one. The rules below are the ones a later edit would quietly break: which row
 * is eligible, what is said when only part of a batch worked, and the fact that
 * an expired or failed undo still reports a failure instead of a success.
 *
 * The page is a `.tsx` module, which the Node test runner cannot load on its
 * own, so it is built once with the project's own bundler and its exported pure
 * decisions are exercised directly. Everything that needs a platform is tested
 * against the real adapter in tests/platform/androidWorkspacePlatform.test.ts.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(root, 'tests/ui/.tmp-recent-page');
const source = readFileSync(resolve(root, 'components/Pages/RecentPage.tsx'), 'utf8');

type RecentPageModule = typeof import('../../components/Pages/RecentPage.tsx');
let page: RecentPageModule;

before(async () => {
  const { build } = await import('vite');
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      write: true,
      target: 'node22',
      lib: { entry: resolve(root, 'components/Pages/RecentPage.tsx'), formats: ['es'], fileName: 'recent-page' },
      // Bundle this product's own modules, leave every package where it is so
      // the built file resolves React from the repository's node_modules.
      rollupOptions: { external: (id: string) => !id.startsWith('.') && !id.startsWith('/') },
    },
  });
  page = (await import(resolve(outDir, 'recent-page.js'))) as RecentPageModule;
});

after(() => rmSync(outDir, { recursive: true, force: true }));

/* ------------------------------------------------------- eligibility --- */

test('every withheld ability states a reason a person can read', () => {
  for (const limitation of ['legacy-read-only', 'session-only', 'file-missing'] as const) {
    const reason = page.limitationReason(limitation);
    assert.equal(typeof reason, 'string');
    assert.ok(reason && reason.length > 0);
    // A reason is a sentence about the file, never a token, path or ref.
    assert.doesNotMatch(reason!, /d1_|a1_|u1_|content:\/\/|\/storage\//);
  }
  assert.equal(page.limitationReason(null), null);
});

const recordFor = (id: string): RecentRecord => ({
  entry: {
    id,
    documentRef: null,
    name: `${id}.pdf`,
    mimeType: 'application/pdf',
    toolId: null,
    createdAt: 1,
    inputSizeBytes: null,
    outputSizeBytes: 25,
    spaceSavedBytes: null,
  },
  document: null,
  available: true,
});

test('only rows the platform calls reversible are offered an undo', () => {
  const reversibleIds = new Set(['a', 'c']);
  const split = page.partitionDeletion([recordFor('a'), recordFor('b'), recordFor('c')], (record) => {
    const reversible = reversibleIds.has(String(record.entry.id));
    return {
      rename: reversible,
      reversibleDelete: reversible,
      limitation: reversible ? null : 'session-only',
    };
  });
  assert.deepEqual(split.reversible.map((record) => record.entry.id), ['a', 'c']);
  assert.deepEqual(split.permanent.map((record) => record.entry.id), ['b']);
});

/* -------------------------------------------------- delete reporting --- */

test('a complete deletion names what went, one row or many', () => {
  assert.deepEqual(page.deletionFeedback({ deleted: 1, failed: 0, total: 1, name: 'Scan.pdf' }), {
    tone: 'success',
    message: 'Deleted Scan.pdf.',
  });
  assert.deepEqual(page.deletionFeedback({ deleted: 3, failed: 0, total: 3, name: null }), {
    tone: 'success',
    message: 'Deleted 3 results.',
  });
});

test('a partial deletion is never reported as a complete one', () => {
  const outcome = page.deletionFeedback({ deleted: 2, failed: 1, total: 3, name: null });
  assert.equal(outcome!.tone, 'danger');
  assert.equal(outcome!.message, 'Deleted 2 of 3. 1 could not be deleted.');
  // The success wording must not appear for a batch that came back short.
  assert.doesNotMatch(outcome!.message, /^Deleted 3 results\.$/);
});

test('a deletion that did nothing says so rather than staying silent', () => {
  assert.deepEqual(page.deletionFeedback({ deleted: 0, failed: 1, total: 1, name: 'Scan.pdf' }), {
    tone: 'danger',
    message: 'That result could not be deleted.',
  });
  assert.deepEqual(page.deletionFeedback({ deleted: 0, failed: 4, total: 4, name: null }), {
    tone: 'danger',
    message: 'None of the selected results could be deleted.',
  });
});

/* ---------------------------------------------------- undo reporting --- */

test('a restore reports exactly how many rows came back', () => {
  assert.deepEqual(page.undoFeedback(1, 1, 'Scan.pdf'), { tone: 'success', message: 'Restored Scan.pdf.' });
  assert.deepEqual(page.undoFeedback(3, 3, null), { tone: 'success', message: 'Restored 3 results.' });
  assert.deepEqual(page.undoFeedback(2, 3, null), {
    tone: 'danger',
    message: 'Restored 2 of 3. The rest could not be brought back.',
  });
  assert.deepEqual(page.undoFeedback(0, 2, null), { tone: 'danger', message: page.UNDO_FAILED });
});

test('undo copy is fixed plain language, never a native message', () => {
  for (const message of [page.UNDO_EXPIRED, page.UNDO_UNAVAILABLE, page.UNDO_FAILED]) {
    assert.doesNotMatch(message, /d1_|u1_|Error|null|undefined|content:\/\//);
    assert.match(message, /\.$/);
  }
});

/* ---------------------------------------------------------- the window --- */

test('the undo offer ends at expiry and is never shown without a receipt', () => {
  const offer = { receipts: [{ undoRef: 'u1_x', expiresAt: 1_000 }], name: 'Scan.pdf', expiresAt: 1_000 };
  assert.equal(page.undoIsOffered(offer, 999), true);
  assert.equal(page.undoIsOffered(offer, 1_000), false);
  assert.equal(page.undoIsOffered(offer, 5_000), false);
  assert.equal(page.undoIsOffered({ ...offer, receipts: [] }, 0), false);
  assert.equal(page.undoIsOffered(null, 0), false);
});

/* ------------------------------------------------- an offer over time --- */

const receiptFor = (undoRef: string, expiresAt: number) => ({ undoRef, expiresAt });
const offerFor = (receipts: ReturnType<typeof receiptFor>[], name: string | null, expiresAt: number) => ({
  receipts,
  name,
  expiresAt,
  message: 'Deleted Scan.pdf.',
  retry: false,
});

test('a later deletion that reversed nothing leaves a live offer exactly as it was', () => {
  const live = offerFor([receiptFor('u1_a', 5_000)], 'Scan.pdf', 5_000);
  // A permanent-only deletion and a deletion whose trash calls all failed both
  // arrive here with nothing added.
  assert.equal(page.mergeUndo(live, [], 'Deleted Browser.pdf.', 1_000), live);
  assert.equal(page.mergeUndo(live, [], 'That result could not be deleted.', 1_000), live);
});

test('a live offer that has already expired is not carried forward', () => {
  const stale = offerFor([receiptFor('u1_a', 5_000)], 'Scan.pdf', 5_000);
  assert.equal(page.mergeUndo(stale, [], 'Deleted Browser.pdf.', 5_000), null);
  const merged = page.mergeUndo(
    stale,
    [{ receipt: receiptFor('u1_b', 9_000), name: 'Later.pdf' }],
    'Deleted Later.pdf.',
    5_000,
  );
  assert.deepEqual(merged, {
    receipts: [receiptFor('u1_b', 9_000)],
    name: 'Later.pdf',
    expiresAt: 9_000,
    message: 'Deleted Later.pdf.',
    retry: false,
  });
});

test('only successful new trash calls join the offer, on the earliest window', () => {
  const live = offerFor([receiptFor('u1_a', 5_000)], 'Scan.pdf', 5_000);
  const merged = page.mergeUndo(
    live,
    [{ receipt: receiptFor('u1_b', 9_000), name: 'Later.pdf' }],
    'Deleted Later.pdf.',
    1_000,
  );
  assert.deepEqual(merged, {
    receipts: [receiptFor('u1_a', 5_000), receiptFor('u1_b', 9_000)],
    // Two files in one offer are counted, never spoken for by one name.
    name: null,
    expiresAt: 5_000,
    message: 'Deleted Later.pdf.',
    retry: false,
  });
  // A first offer keeps the name of the single file it can restore.
  assert.deepEqual(
    page.mergeUndo(null, [{ receipt: receiptFor('u1_b', 9_000), name: 'Later.pdf' }], 'Deleted Later.pdf.', 1_000),
    {
      receipts: [receiptFor('u1_b', 9_000)],
      name: 'Later.pdf',
      expiresAt: 9_000,
      message: 'Deleted Later.pdf.',
      retry: false,
    },
  );
});

test('a partial restore keeps exactly the receipts that refused, on the original window', () => {
  const offer = offerFor([receiptFor('u1_a', 5_000), receiptFor('u1_b', 5_000)], null, 5_000);
  const message = 'Restored 1 of 2. The rest could not be brought back.';
  assert.deepEqual(page.remainingUndo(offer, [receiptFor('u1_b', 5_000)], message, 1_000), {
    receipts: [receiptFor('u1_b', 5_000)],
    name: null,
    expiresAt: 5_000,
    message,
    // A refused receipt is offered again as a retry, on its own window.
    retry: true,
  });
  // Everything restored, or the window gone: there is nothing left to offer.
  assert.equal(page.remainingUndo(offer, [], 'Restored 2 results.', 1_000), null);
  assert.equal(page.remainingUndo(offer, [receiptFor('u1_b', 5_000)], message, 5_000), null);
});

test('a retryable single receipt keeps the name it was deleted under', () => {
  const offer = offerFor([receiptFor('u1_a', 5_000)], 'Scan.pdf', 5_000);
  const retry = page.remainingUndo(offer, [receiptFor('u1_a', 5_000)], page.UNDO_FAILED, 1_000);
  assert.equal(retry!.name, 'Scan.pdf');
  assert.equal(page.undoIsOffered(retry, 1_000), true);
});

/* ------------------------------------------------------ the surface --- */

test('the action names itself honestly before and after a refused restore', () => {
  const offer = offerFor([receiptFor('u1_a', 5_000)], 'Scan.pdf', 5_000);
  assert.equal(page.undoActionLabel(offer), 'Undo delete');
  assert.equal(page.undoActionLabel({ ...offer, retry: true }), 'Try undo again');
});

test('a standing undo is one panel, not a strip with a loose control beneath it', () => {
  const region = source.slice(
    source.indexOf('<div role="status" aria-live="polite">'),
    source.indexOf('{state.status === \'ready\' && records.length > 0 && ('),
  );
  // One bordered, status-toned panel in the page rhythm, carrying the line and
  // the action together.
  assert.match(region, /rounded-\[var\(--radius-panel\)\] border px-4 py-3\.5/);
  assert.match(region, /undoPanelTone\[feedback\?\.tone \?\? 'success'\]/);
  // The action is full width inside that panel, so it can never come back as a
  // small box floating on its own.
  assert.match(region, /<Button\s+block\s+tone="secondary"/);
  const panelStart = region.indexOf('rounded-[var(--radius-panel)]');
  assert.ok(panelStart > -1 && region.indexOf('<Button') > panelStart);
  // In flow above the list: never a floating toast.
  assert.doesNotMatch(region, /fixed|absolute|z-\[|inset-x/);
  // Entrance only, which already has its reduced-motion equivalent.
  assert.match(region, /chef-enter/);
});

test('the undo control keeps its visible label inside its accessible name', () => {
  const region = source.slice(source.indexOf('{undoOffered && pendingUndo ? ('), source.indexOf('{state.status ==='));
  assert.match(region, /aria-label=\{t\("recent-page\.for\.eca73a", \{ v0: undoActionLabel\(pendingUndo\), v1:/);
  assert.match(region, /\{undoActionLabel\(pendingUndo\)\}/);
  assert.match(region, /pendingUndo\.name \?\? t\("recent-page\.results\.a9c6d9", \{ v0: pendingUndo\.receipts\.length \}\)/);
});

/* -------------------------------------------------------- the wiring --- */

test('a later deletion never withdraws an offer it did not create', () => {
  const block = source.slice(source.indexOf('const deleteRecords'), source.indexOf('const undoDelete'));
  assert.doesNotMatch(block, /setPendingUndo\(null\)/);
  assert.match(block, /setPendingUndo\(\(current\) => mergeUndo\(current, trashed, outcome\.message, Date\.now\(\)\)\)/);
});

test('a failed restore is put back on the offer instead of being dropped', () => {
  const block = source.slice(source.indexOf('const undoDelete'), source.indexOf('const deleteSelected'));
  assert.match(block, /unrestored\.push\(receipt\)/);
  assert.match(block, /remainingUndo\(offer, unrestored, outcome\.message, Date\.now\(\)\)/);
  assert.match(block, /setPendingUndo\(retry\)/);
});

test('the mixed-selection confirmation states the scope without claiming browser storage', () => {
  const confirm = source.slice(
    source.indexOf('open={confirmDeleteSelected}'),
    source.indexOf('onCancel={() => setConfirmDeleteSelected(false)}'),
  );
  assert.match(confirm, /t\("recent-page\.one\.of\.them\.cannot\.be\.undone\.9f0ace"\)/);
  assert.match(confirm, /t\("recent-page\.of\.them\.cannot\.be\.undone\.c8e64b"/);
  // A permanent row can be a durable one whose file is gone, so no wording may
  // say where every one of them is kept.
  assert.doesNotMatch(confirm, /kept in this browser/);
  assert.match(confirm, /t\("recent-page\.frees\.this\.cannot\.be\.undone\.5d87d1"/);
  assert.match(confirm, /formatBytes\(selectedBytes\)/);
});

test('deletion is routed by per-row ability, and only the reversible path skips the confirmation', () => {
  assert.match(source, /recordAbilities\(platform, record\)/);
  assert.match(source, /service\.deleteReversibly\(target\)/);
  assert.match(source, /service\.restore\(receipt\)/);
  assert.match(source, /if \(activeAbilities\?\.reversibleDelete\) void deleteRecords\(\[target\], \[\]\);/);
  assert.match(source, /else setConfirmDelete\(target\);/);
  // A permanent row still goes through the existing destructive deletion.
  assert.match(source, /platform\.records\.delete\(target\.entry\.id\)/);
});

test('an expired receipt is checked before the platform is asked to restore', () => {
  const undo = source.slice(source.indexOf('const undoDelete'));
  const expiryCheck = undo.indexOf('Date.now() >= offer.expiresAt');
  const restoreCall = undo.indexOf('service.restore(receipt)');
  assert.ok(expiryCheck > -1 && restoreCall > -1);
  assert.ok(expiryCheck < restoreCall);
});

test('clearing stays destructive and never carries an undo', () => {
  const clear = source.slice(source.indexOf('const mode = confirmClear;'));
  assert.match(clear, /setPendingUndo\(null\)/);
  assert.doesNotMatch(clear, /deleteReversibly|deleteRecords/);
});

test('no undo token can reach the interface', () => {
  // Receipts are passed to the platform whole; nothing reads the token out of
  // one, so no render path can print it.
  assert.equal(source.includes('undoRef'), false);
});

/* ------------------------------------------- legacy groups of files --- */

/**
 * T928. A legacy batch output arrives as one logical collection: no document
 * ref, no MIME type, no byte size, and an opaque `a1_` collection ref. The
 * rules below are the ones a later edit would quietly break: that Recent still
 * recognises it as an older Android read-only row, that it is counted in items
 * rather than given a fake size, and that it is never opened as one document.
 */
const collectionRecordFor = (ref: string, itemCount: number, available = true): RecentRecord => ({
  entry: {
    id: `android:${ref}`,
    documentRef: null,
    name: 'Scanned batch',
    mimeType: null,
    toolId: '/split-pdf',
    createdAt: 2,
    inputSizeBytes: null,
    outputSizeBytes: null,
    spaceSavedBytes: null,
  },
  document: null,
  collection: {
    ref: ref as StoredCollection['ref'],
    name: 'Scanned batch',
    sizeBytes: null,
    retainedAt: 2,
    itemCount,
  },
  available,
});

test('a collection is classified by its own opaque ref, not by a document ref it lacks', () => {
  const collection = collectionRecordFor('a1_7', 4);
  assert.equal(page.isCollectionRecord(collection), true);
  // A browser record has no collection at all and is untouched by any of this.
  assert.equal(page.isCollectionRecord(recordFor('browser')), false);
  // Only the older app's own opaque form counts; nothing else is promoted.
  assert.equal(page.isCollectionRecord(collectionRecordFor('d1_7', 4)), false);
  assert.equal(page.isCollectionRecord(collectionRecordFor('a1_0', 4)), false);
});

test('a collection is an older Android read-only row, so it never joins a selection', () => {
  const collection = collectionRecordFor('a1_7', 4);
  assert.equal(page.isLegacyRecord(collection), true);
  assert.equal(page.isLegacyRecord(recordFor('browser')), false);
  // The row, the select-all set and the toggle all filter on this one answer.
  assert.match(source, /const selectable = selectionMode && !legacy;/);
  assert.match(source, /visibleRecords\.filter\(\(record\) => !isLegacyRecord\(record\)\)/);
  assert.match(source, /if \(isLegacyRecord\(record\)\) return;/);
  // Rename, delete and undo are refused by the platform's own limitation code,
  // which the sheet reads rather than deciding for itself.
  assert.match(source, /disabled=\{!activeAbilities\?\.rename\}/);
  assert.match(source, /disabled=\{activeAbilities\?\.limitation === 'legacy-read-only'\}/);
});

test('a collection is described in items, never in bytes and never as a PDF', () => {
  assert.equal(page.collectionItemLabel(4), '4 items');
  assert.equal(page.collectionItemLabel(1), '1 item');
  // Nothing invents a count the older app did not record.
  assert.equal(page.collectionItemLabel(0), 'Item count not recorded');
  // The row's own meta line asks for an item count where a file would show a
  // size, so a group can never borrow or invent one.
  assert.match(source, /\{collection \? collectionItemLabel\(items\) : formatBytes\(entry\.outputSizeBytes\)\}/);
  // The sheet describes it the same way, in place of a size it does not have.
  assert.match(
    source,
    /activeIsCollection \? collectionItemLabel\(activeItems\) : formatBytes\(active\.entry\.outputSizeBytes\)/,
  );
});

test('reopen is refused for a collection and says why in plain language', () => {
  const collection = collectionRecordFor('a1_7', 4);
  assert.equal(page.isReopenable(collection), false);
  // Even a group whose name ends in .pdf is still a group, not a document.
  assert.equal(
    page.isReopenable({ ...collection, entry: { ...collection.entry, name: 'Scanned batch.pdf' } }),
    false,
  );
  assert.equal(page.isReopenable(recordFor('browser')), true);
  // A group is never offered an Open it cannot honour, and its sheet says in
  // visible text why — never a hover-only title.
  assert.match(page.COLLECTION_READ_ONLY_REASON, /not one PDF/);
  assert.match(source, /\{isReopenable\(active\) && \(/);
  // The platform is never asked to open one, even if a press got through.
  const reopen = source.slice(source.indexOf('const reopen = useCallback'), source.indexOf('const closeActions'));
  const guard = reopen.indexOf('if (isCollectionRecord(record)) return;');
  assert.ok(guard > -1 && guard < reopen.indexOf('platform.pdfReader'));
});

test('the collection reason replaces the legacy sentence that promises opening', () => {
  const collection = collectionRecordFor('a1_7', 4);
  assert.equal(page.recordReason(collection, 'legacy-read-only'), page.COLLECTION_READ_ONLY_REASON);
  // A legacy single file keeps the wording it had, opening included.
  assert.equal(page.recordReason(recordFor('browser'), 'legacy-read-only'), page.limitationReason('legacy-read-only'));
  assert.doesNotMatch(page.COLLECTION_READ_ONLY_REASON, /opening still work|a1_|content:\/\//);
  assert.match(source, /recordReason\(active, activeAbilities\?\.limitation \?\? null\)/);
});

test('the actions a collection genuinely has are named by how many files they act on', () => {
  assert.equal(page.collectionActionLabel('Save', 4), 'Save 4 files');
  assert.equal(page.collectionActionLabel('Share', 4), 'Share 4 files');
  assert.equal(page.collectionActionLabel('Save', 1), 'Save 1 file');
  assert.equal(page.collectionActionLabel('Share', 0), 'Share files');
  // No wording anywhere may imply an archive or a conversion into one document.
  for (const copy of [
    page.collectionActionLabel('Save', 4),
    page.collectionActionLabel('Share', 4),
    page.collectionItemLabel(4),
    page.COLLECTION_READ_ONLY_REASON,
  ]) {
    assert.doesNotMatch(copy, /\bZIP\b|\barchive\b|\bcombine\b|\bconvert\b|\bmerged?\b/i);
  }
  // Save and share stay enabled only while the platform can actually perform
  // them, exactly as they were for every other row.
  const actions = source.slice(source.indexOf('{active && ('), source.indexOf('{/* Rename */}'));
  assert.match(actions, /disabled=\{!active\.available\}/);
  // Share exists only where the platform has a share sheet at all, so there is
  // no dead control and no sentence explaining one.
  assert.match(actions, /\{platform\.share && \(/);
  assert.match(actions, /activeIsCollection \? collectionActionLabel\('Save', activeItems\) : t\("recent-page\.save\.a\.copy\.2c2a76"\)/);
  assert.match(actions, /activeIsCollection \? collectionActionLabel\('Share', activeItems\) : t\("recent-page\.share\.29887a"\)/);
});

test('a disabled control carries its reason in text, not in a hover title', () => {
  const actions = source.slice(source.indexOf('{active && ('), source.indexOf('{/* Rename */}'));
  assert.doesNotMatch(actions, /title=\{/);
  assert.match(actions, /disabled=\{!activeAbilities\?\.rename\}/);
  assert.match(actions, /disabled=\{activeAbilities\?\.limitation === 'legacy-read-only'\}/);
  assert.match(actions, /\{activeReason && <p/);
});
