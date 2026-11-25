import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

// Release QA NAV-29, FIL-01, FIL-04, ORG-51, ORG-60: the result sheet showed a name the saved
// file did not have, Rename never reached the copy in Downloads, and every Download added a
// duplicate. FIL-10: with both save switches off a result vanished without a word.
test('the result sheet renames the saved copy, reports where it went and guards unsaved work', () => {
  const output = source('components/UI/OutputCenter.tsx');
  assert.match(output, /platform\.renameSaved\(saved\.exportRef, requested\)/);
  assert.match(output, /setName\(next\.savedCopy\?\.savedName/);
  assert.doesNotMatch(output, /`Saved \$\{/);
  assert.match(output, /if \(unsaved\) discardPrompt\.ask\(dismiss\)/);
  assert.match(output, /const keep = Boolean\(recordRef\.current\?\.deliveryIssue\) \|\| unsavedRef\.current/);
  // ADD1J-07: no greyed "Saved" for a file that is only inside the app.
  assert.doesNotMatch(output, /output-center\.saved\.b5c120/);
  // FIL-02: the rename field opens focused with the name selected.
  assert.match(output, /data-sheet-initial-focus/);
  assert.match(source('components/UI/Primitives.tsx'), /field\.select\(\)/);
});

// On iOS the keyboard covers the layout viewport instead of shrinking it, and the rename sheet
// sat entirely behind it. Every sheet rises by the covered height and fits the space left.
test('a sheet with a field stays above the iOS keyboard', () => {
  const primitives = source('components/UI/Primitives.tsx');
  assert.match(primitives, /paddingBottom: 'var\(--chef-keyboard-inset, 0px\)'/);
  assert.match(primitives, /max-h-\[calc\(100dvh-env\(safe-area-inset-top\)-var\(--chef-keyboard-inset,0px\)\)\]/);
  assert.match(primitives, /sm:max-h-\[calc\(100dvh-2rem-var\(--chef-keyboard-inset,0px\)\)\]/);
});

// NAV-17, NAV-19: Recent closed the rename sheet on failure and said the wrong saved name.
test('Recent says the stored name and keeps a failed rename open', () => {
  const recent = source('components/Pages/RecentPage.tsx');
  assert.match(recent, /recent-page\.saved\.to\.as\.cf91b2/);
  assert.doesNotMatch(recent, /`Saved \$\{/);
  assert.match(recent, /setRenameError\(/);
  assert.match(recent, /maxLength=\{filenameStemLimit\(/);
});

// NAV-20: deleting a row far down Recent showed no Undo, and a tab switch dropped it.
test('the Recent Undo stays in view and survives a tab switch', () => {
  const recent = source('components/Pages/RecentPage.tsx');
  assert.match(recent, /let standingUndo: PendingUndo \| null = null;/);
  assert.match(recent, /useEffect\(\(\) => \{ standingUndo = pendingUndo; \}, \[pendingUndo\]\);/);
  assert.match(recent, /className=\{undoOffered \? 'sticky /);
});

// One filled button: Save until a copy is on the device, then Share or Open PDF. For a PDF,
// Download gives way once a copy exists; an archive (Batch, Split) cannot be opened here, so its
// Download stays, as a second button (research r3, h4-04). The location is stated once.
test('the result sheet has one primary action and states the location once', () => {
  const output = source('components/UI/OutputCenter.tsx');
  assert.equal(output.match(/tone=\{primary === /g)?.length, 3); // Share, Open PDF, Download
  assert.equal(output.match(/tone="primary"/g)?.length, 1); // the rename footer
  assert.match(output, /const savedOnDevice = Boolean\(saved\) \|\| exported;/);
  assert.match(output, /primary: 'save' \| 'share' \| 'open' = !savedOnDevice \? 'save'/);
  assert.match(output, /: canShare \? 'share' : isPdf \? 'open' : 'save';/);
  // One Download button in the sheet, and the strip's own Download word (path to 9, item 3).
  assert.equal(output.match(/output-center\.download\.9ce5b1/g)?.length, 2);
  assert.match(output, /const downloadButton = \(primary === 'save' \|\| !isPdf\) && \(/);
  assert.match(output, /\{primary !== 'save' && downloadButton\}/);
  // T-16: the other actions wrap at their own width, so no label wraps and no button is left alone at half width.
  assert.match(output, /flex flex-wrap gap-2 \[&>\*\]:w-auto \[&>\*\]:flex-\[1_1_auto\]/);
  assert.match(output, /output-center\.use\.in\.another\.tool\.a1c3e7/);
  assert.doesNotMatch(output, /setNotice|StatusLine tone="success"/);
  // T-07: where it is kept is said once, in the sheet's line; T-01: Compress's before/after figure
  // takes the size's place there.
  assert.match(output, /const sizeLine = detail \|\| formatBytes\(record\.size \?\? null\);/);
  assert.match(output, /const keptIn = savedIn \|\| \(retained/);
  // Round 5, mobile-09: the sheet's size keeps its number and unit together.
  assert.match(output, /const sheetSize = detail \? sizeLine : sizeLine\.replace\(\/ \/g, '\\u00a0'\);/);
  assert.match(output, /\$\{safeName\} · \$\{sheetSize\}\$\{keptIn\}/);
});
