import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  TAB_ENTRY,
  historyIndex,
  openedByTab,
  rememberHistoryEntry,
  returnToTools,
} from '../../components/Layout/navigationHistory.ts';
import {
  keepsMakePdfDraftOnLeave,
  makePdfDraft,
  releaseMakePdfDraft,
  type DraftPage,
} from '../../components/Tools/makePdfDraft.ts';

/**
 * Root causes 3 and 5 from the Android pass: Back replayed every tab and tool
 * visit before leaving (NAV-37), Tools home lost its place (NAV-06), Back on a
 * Preview PDF dialog left the tool (ORG-46), and Create PDF, Flatten and the
 * invoice builder dropped work with no question asked (CRT-18).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const recordingNavigate = () => {
  const calls: unknown[][] = [];
  const navigate = ((...args: unknown[]) => { calls.push(args); }) as Parameters<typeof returnToTools>[0];
  return { calls, navigate };
};

test('the history index is React Router idx, and anything else is the first entry', () => {
  assert.equal(historyIndex({ idx: 3, key: 'a' }), 3);
  assert.equal(historyIndex({ idx: 0 }), 0);
  assert.equal(historyIndex(null), 0);
  assert.equal(historyIndex({ idx: -1 }), 0);
  assert.equal(historyIndex({ idx: 1.5 }), 0);
  assert.equal(historyIndex({ idx: '2' }), 0);
});

test('only an entry a tab opened is marked as one', () => {
  assert.equal(openedByTab(TAB_ENTRY), true);
  assert.equal(openedByTab({ from: '/settings' }), false);
  assert.equal(openedByTab(null), false);
  assert.equal(openedByTab(undefined), false);
});

test('Tools steps back to Tools home when it is just behind, so no second copy is stacked', () => {
  // Tools home, then a tool opened from it.
  rememberHistoryEntry('/', true, 0);
  rememberHistoryEntry('/merge', true, 1);
  const fromTool = recordingNavigate();
  returnToTools(fromTool.navigate, 1);
  assert.deepEqual(fromTool.calls, [[-1]]);

  // The Recent tab took the tool's place: Tools is still just behind.
  rememberHistoryEntry('/recent', false, 1);
  const fromRecent = recordingNavigate();
  returnToTools(fromRecent.navigate, 1);
  assert.deepEqual(fromRecent.calls, [[-1]]);
});

test('Tools replaces the entry when something other than Tools home is behind it', () => {
  // Create PDF's result opened in the reader: stepping back would land in Create PDF.
  rememberHistoryEntry('/', true, 0);
  rememberHistoryEntry('/make-pdf', true, 1);
  rememberHistoryEntry('/view', true, 2);
  const { calls, navigate } = recordingNavigate();
  returnToTools(navigate, 2);
  assert.deepEqual(calls, [['/', { replace: true, state: TAB_ENTRY }]]);
});

test('a new entry forgets the forward entries it replaced, and unknown entries never step back', () => {
  rememberHistoryEntry('/', true, 0);
  rememberHistoryEntry('/split', true, 1);
  rememberHistoryEntry('/', false, 0);
  rememberHistoryEntry('/compress', true, 1);
  const stepped = recordingNavigate();
  returnToTools(stepped.navigate, 1);
  assert.deepEqual(stepped.calls, [[-1]]);

  // After a reload the entries behind are not known, so there is nothing to step back to.
  rememberHistoryEntry('/settings', true, 0);
  rememberHistoryEntry('/recent', false, 4);
  const replaced = recordingNavigate();
  returnToTools(replaced.navigate, 4);
  assert.deepEqual(replaced.calls, [['/', { replace: true, state: TAB_ENTRY }]]);
});

test('Android Back leaves the app from Tools before it considers the history behind it', () => {
  const back = read('components/Layout/NativeBackHandler.tsx');
  const handler = back.slice(back.indexOf("addListener('backButton'"));
  const exit = handler.indexOf('CapacitorApp.exitApp()');
  const pop = handler.indexOf('navigate(-1)');
  assert.ok(exit > 0 && pop > 0 && exit < pop, 'exit on Tools must be checked before popping history');
  assert.match(handler, /if \(path === '\/'\) \{\s*void CapacitorApp\.exitApp\(\);\s*return;/);
  // Recent or Settings opened from the tab bar goes to Tools, not to the screen it replaced.
  assert.match(handler, /if \(tab\) \{\s*returnToTools\(navigate\);\s*return;/);
  // A modal still gets Back first.
  assert.ok(handler.indexOf('escape.defaultPrevented') < exit);
});

test('tabs replace the current entry instead of stacking a new one', () => {
  const shell = read('components/Layout/AppShell.tsx');
  const tabBar = shell.slice(shell.indexOf('const TabBar'), shell.indexOf('/* ---------------------------------------------------------- Side rail'));
  const sideRail = shell.slice(shell.indexOf('const SideRail'), shell.indexOf('/* ----------------------------------------------------------- Nav bar'));
  assert.match(tabBar, /<Link\s+to=\{to\}\s+replace\s+state=\{TAB_ENTRY\}\s+onClick=\{pressTab\(to, navigate\)\}/);
  assert.match(sideRail, /<NavLink\s+to=\{to\}\s+replace\s+state=\{TAB_ENTRY\}\s+onClick=\{pressTab\(to, navigate\)\}/);
  assert.match(sideRail, /<Link to="\/" replace state=\{TAB_ENTRY\} onClick=\{pressTab\('\/', navigate\)\}/);
  assert.match(shell, /rememberHistoryEntry\(location\.pathname, navigationType === 'PUSH'\)/);
  // A modified click (open in a new tab) is left to the browser.
  assert.match(shell, /event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
});

test('Tools home keeps its search, category and scroll position across a tool visit', () => {
  const shell = read('components/Layout/AppShell.tsx');
  const dashboard = read('components/Tools/Dashboard.tsx');
  // The shell no longer sends Tools home to the top; the page puts back its own place.
  assert.match(shell, /if \(path !== '\/'\) window\.scrollTo\(\{ top: 0, behavior: 'auto' \}\)/);
  assert.doesNotMatch(shell, /^\s*window\.scrollTo\(\{ top: 0, behavior: 'auto' \}\);/m);
  assert.match(dashboard, /const toolsHome: \{ query: string; category: CategoryFilter; scrollY: number \}/);
  assert.match(dashboard, /useState\(toolsHome\.query\)/);
  assert.match(dashboard, /useState<CategoryFilter>\(toolsHome\.category\)/);
  assert.match(dashboard, /toolsHome\.query = query;\s*toolsHome\.category = category;/);
  assert.match(dashboard, /useLayoutEffect\(\(\) => \{\s*window\.scrollTo\(\{ top: toolsHome\.scrollY, behavior: 'auto' \}\);/);
  assert.match(dashboard, /toolsHome\.scrollY = window\.scrollY;/);
});

test('Back on Preview PDF closes the preview, not the tool under it', () => {
  const preview = read('components/UI/PDFPreviewModal.tsx');
  // Back arrives as a non-bubbling Escape on the document, so a window listener never hears it.
  assert.doesNotMatch(preview, /window\.addEventListener\('keydown'/);
  assert.match(preview, /if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*onClose\(\);/);
  assert.match(preview, /document\.addEventListener\('keydown', handleEsc\)/);
  assert.match(preview, /document\.removeEventListener\('keydown', handleEsc\)/);
});

test('Create PDF, Flatten and the invoice builder ask before Back drops unsaved work, with one blocker each', () => {
  const guards: Array<[string, RegExp, RegExp]> = [
    ['components/Tools/MakePDF.tsx', /useConfirmDiscard\(images\.length > 0 && images !== exportedImages\)/, /downloadBlob\([^\n]+\);\s*setExportedImages\(images\);/],
    ['components/Tools/FlattenPDF.tsx', /useConfirmDiscard\(file !== null && file !== savedFile\)/, /'application\/pdf',\s*\);\s*setSavedFile\(file\);/],
    ['components/Tools/BusinessDocumentBuilder.tsx', /useConfirmDiscard\(work !== savedWork\)/, /return;\s*\}\s*setSavedWork\(work\);/],
  ];
  for (const [path, guard, saved] of guards) {
    const source = read(path);
    assert.match(source, guard, path);
    assert.match(source, saved, path);
    // React Router honours only the last blocker registered, so a second one would silently win.
    assert.equal(source.match(/useConfirmDiscard\(/g)?.length, 1, path);
    assert.doesNotMatch(source, /useBlocker/, path);
    assert.match(source, /\{discardSheet\}/, path);
  }
  // The invoice's own details are remembered as they are typed, so they are not counted as lost work.
  const invoice = read('components/Tools/BusinessDocumentBuilder.tsx');
  assert.match(invoice, /const work = JSON\.stringify\(\[recipient, reference, issuedOn, settledOn, paymentMethod, notes, items, logoName, logo !== null\]\)/);
  // A locked preview is not a save.
  assert.ok(invoice.indexOf("delivery.status === 'preview'") < invoice.indexOf('setSavedWork(work)'));
});

test('Create PDF keeps its pages for Back only, and starts empty any other way in', () => {
  const make = read('components/Tools/MakePDF.tsx');
  assert.match(make, /if \(navigationType !== 'POP'\) releaseMakePdfDraft\(\);/);
  assert.match(make, /useState<CapturedImage\[\]>\(\(\) => makePdfDraft\.pages\)/);
  assert.match(make, /useState<string \| null>\(\(\) => makePdfDraft\.typedName\)/);
  assert.match(make, /if \(keepsMakePdfDraftOnLeave\(entry\.index, nextIndex\)\) return;/);
});

const page = (name: string): DraftPage => ({
  id: name,
  file: new File(['x'], `${name}.jpg`, { type: 'image/jpeg' }),
  previewUrl: URL.createObjectURL(new Blob(['x'], { type: 'image/jpeg' })),
});

test('exported pages survive a result opened on top, and nothing else', () => {
  const pages = [page('one'), page('two')];
  makePdfDraft.pages = pages;
  makePdfDraft.exported = pages;
  // Open PDF or Show in Recent moves forward from Create PDF's entry.
  assert.equal(keepsMakePdfDraftOnLeave(2, 3), true);
  // Back, or a tab taking the same entry, lets them go.
  assert.equal(keepsMakePdfDraftOnLeave(2, 1), false);
  assert.equal(keepsMakePdfDraftOnLeave(2, 2), false);
  // A page added after the export is not exported, so Discard means discard.
  makePdfDraft.pages = [...pages, page('three')];
  assert.equal(keepsMakePdfDraftOnLeave(2, 3), false);
  makePdfDraft.pages = [];
  makePdfDraft.exported = [];
  assert.equal(keepsMakePdfDraftOnLeave(2, 3), false);
});

test('letting the draft go frees every page preview', () => {
  const pages = [page('one'), page('two')];
  makePdfDraft.pages = pages;
  makePdfDraft.typedName = 'Receipts';
  makePdfDraft.exported = pages;
  for (const { previewUrl } of pages) assert.ok(resolveObjectURL(previewUrl));
  releaseMakePdfDraft();
  for (const { previewUrl } of pages) assert.equal(resolveObjectURL(previewUrl), undefined);
  assert.deepEqual(makePdfDraft, { pages: [], typedName: null, exported: null });
});
