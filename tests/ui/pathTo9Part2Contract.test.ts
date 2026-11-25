import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import english from '../../services/i18n/en-US.ts';
import { buildPageNumberText } from '../../services/androidParity.ts';
import { photoOutputName, photoStem } from '../../components/UI/format.ts';
import { numberList } from '../../components/Tool/values.ts';

// Path to 9, part 2. Behaviour is checked in the browser by
// scripts/verify-path-to-9-part2.mjs and by
// scripts/verify-forced-colors.mjs; these pin the contracts in the source.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('item 1: Remove hidden info lists what the file holds, and reads the saved file again', () => {
  // Final fix, item 4: the hidden-info code lives in pdfHiddenInfo.ts (pdf-lib only, so a unit
  // test can run it); pdfDocument.ts passes it on.
  const hidden = read('services/pdfHiddenInfo.ts');
  assert.match(hidden, /export type HiddenInfoKey = 'title' \| 'author' \| 'subject' \| 'keywords' \| 'creator' \| 'producer' \| 'created' \| 'modified' \| 'xmp';/);
  assert.match(hidden, /export const readHiddenInfo = async \(source: Blob \| Uint8Array\): Promise<HiddenInfoItem\[\]>/);
  assert.match(read('services/pdfDocument.ts'), /export \{ readHiddenInfo, type HiddenInfoItem, type HiddenInfoKey \} from '\.\/pdfHiddenInfo\.ts';/);
  const tools = read('components/Tools/PdfAdvancedTools.tsx');
  // Before: the list comes from the chosen file. After: from the bytes that were saved.
  assert.match(tools, /readHiddenInfo\(next\.file\)/);
  assert.match(tools, /const bytes = await removePDFMetadata\(file\.file\);[\s\S]{0,300}readHiddenInfo\(bytes\)/);
  assert.equal(english['hiddenInfo.gone'], 'The saved file has none of it.');
  assert.equal(english['hiddenInfo.removed'], 'Removed');
});

test('item 1: Remove blank pages marks the pages first and drops exactly the marked ones', () => {
  const doc = read('services/pdfDocument.ts');
  assert.match(doc, /export const findBlankPages = async \(/);
  assert.match(doc, /pages\?: readonly number\[\]/);
  const tools = read('components/Tools/PdfAdvancedTools.tsx');
  assert.match(tools, /findBlankPages\(/);
  assert.match(tools, /removeBlankPagesFromPDF\(file\.file, \{ pages: marked\.map\(\(index\) => index \+ 1\) \}\)/);
  // At least one page stays: the action is off when every page is marked.
  assert.match(tools, /const allMarked = totalPages > 0 && marked\.length >= totalPages;/);
  assert.match(tools, /marked\.length === 0 \|\| allMarked/);
  assert.deepEqual(english['blankPages.marked'], { one: 'Page {v0} will be removed.', other: 'Pages {v0} will be removed.' });
  assert.equal(numberList([2, 5]), '2 and 5');
});

test('item 1: Compress gives no size estimate while it keeps the text', () => {
  assert.match(read('components/Tools/CompressPDF.tsx'), /if \(files\.length === 0 \|\| !analysis\.done \|\| keepText\) \{/);
});

test('item 2: Page Numbers offers format presets and names positions in words', () => {
  const page = read('components/Tools/PageNumbersPDF.tsx');
  // The list lives beside the formatter, so Header & Footer offers the same ones (pass 5, item 5).
  assert.match(page, /const FORMAT_PRESETS = PAGE_NUMBER_FORMAT_PRESETS;/);
  assert.match(readFileSync(new URL('../../services/androidParity.ts', import.meta.url), 'utf8'), /export const PAGE_NUMBER_FORMAT_PRESETS = \['\{n\}', 'Page \{n\}', 'Page \{n\} of \{total\}', '\{n\} \/ \{total\}'\] as const;/);
  assert.deepEqual(
    ['{n}', 'Page {n}', 'Page {n} of {total}', '{n} / {total}'].map((format) => buildPageNumberText(format, 1, 3)),
    ['1', 'Page 1', 'Page 1 of 3', '1 / 3'],
  );
  for (const key of ['topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomCenter', 'bottomRight']) {
    assert.ok(page.includes(`key: 'pageNumbers.position.${key}'`), key);
    assert.ok(english[`pageNumbers.position.${key}` as keyof typeof english], key);
  }
  assert.match(page, /const positionAt = \(x: number, y: number\) => POSITION_PRESETS\.find/);
});

test('item 3: Edit PDF says add, move, delete, undo and redo, and choosing a paragraph moves nothing', () => {
  const edit = read('components/Tools/EditPDF.tsx');
  assert.match(edit, /const elementAdded = \(kind: EditorElement\['type'\], page: number\) => t\(`editor\.\$\{kind\}\.added`/);
  assert.match(edit, /editAnnounce\?\.\(t\(MOVED_KEYS\[/);
  for (const key of ['edit.deleted', 'edit.undone', 'edit.redone']) assert.ok(edit.includes(`t('${key}')`), key);
  // The desktop formatting row is drawn in the page panel's top band, beside the zoom, not
  // above the panel where it pushed the page down.
  assert.match(edit, /<div ref=\{deskBandRef\}[^>]*>\s*\{paragraphInspector\(false\)\}/);
  assert.equal(edit.match(/paragraphInspector\(false\)/g)?.length, 1);
  assert.match(edit, /if \(deskBandRef\.current\) observer\.observe\(deskBandRef\.current\);/);
  const inspector = read('components/Tools/PdfParagraphInspector.tsx');
  // The status line takes room only once it has something to say.
  assert.match(inspector, /<div className=\{status \? 'mt-1 flex min-h-8 items-center gap-1 px-0\.5' : 'sr-only'\}>/);
});

test('item 4: Home shows recently used tools from local history, and nothing when there are none', () => {
  const home = read('components/Tools/Dashboard.tsx');
  assert.match(home, /if \(!getWorkspaceSettings\(\)\.keepLocalHistory\) return \[\];/);
  assert.match(home, /\{!searching && category === 'All' && recentTools\.length > 0 && \(/);
  assert.equal(english['home.recentTools'], 'Recently used');
});

test('item 5: Sign resets zoom to its starting view', () => {
  const zoom = read('components/UI/ZoomControls.tsx');
  assert.match(zoom, /resetTo = 1/);
  assert.match(zoom, /Math\.abs\(zoom - resetTo\) < 0\.001/);
  const sign = read('components/Tools/SignPDF.tsx');
  // Fable-2 item 15: the fitted view is 100%, so Reset returns to 1 and both zoom clusters show it.
  assert.equal(sign.match(/zoom=\{view\}/g)?.length, 2);
  assert.match(sign, /const resetZoom = useCallback\(\(\) => setExactZoom\(1\), \[setExactZoom\]\);/);
});

test('item 5: a photos PDF is named after its first photo', () => {
  assert.equal(photoStem('IMG_2041.HEIC'), 'IMG_2041');
  assert.equal(photoOutputName('Receipt March.jpg', 'Image to PDF'), 'Receipt March.pdf');
  assert.match(photoOutputName(undefined, 'Image to PDF'), /^Image to PDF .+\.pdf$/);
  assert.match(read('components/Tools/MakePDF.tsx'), /const photosPdfName = \(\) => photoStem\(images\[0\]\?\.file\.name\) \|\| freshPdfName\(\);/);
  assert.match(read('components/Tools/ImageToPDF.tsx'), /photoOutputName\(firstImage\?\.file\.name/);
});

test('item 5: Batch Unlock asks for a password only for locked files, and leaving cancels the run', () => {
  const batch = read('components/Tools/BatchPDF.tsx');
  assert.match(batch, /useEffect\(\(\) => \(\) => \{ cancelRequestedRef\.current = true; \}, \[\]\);/);
  assert.match(batch, /if \(action === 'unlock' && noneLocked\) return null;/);
  assert.match(batch, /locks\[fileKey\(file\)\] === false \? '' : password/);
  assert.deepEqual(english['sentence.batch.option.password.forLocked'], {
    one: 'a password for the {count} locked PDF',
    other: 'a password for the {count} locked PDFs',
  });
  // The other long jobs stop with the screen too.
  assert.match(read('components/Tools/CompressPDF.tsx'), /useEffect\(\(\) => \(\) => \{ cancelRef\.current = true; \}, \[\]\);/);
  assert.match(read('components/Tools/PDFToImage.tsx'), /exportCancelRef\.current = true;/);
});

test('item 5: onboarding says results are kept, which is the default', () => {
  assert.match(read('services/workspace.ts'), /keepLocalHistory: true,/);
  // The key keeps its old name: Onboarding.tsx is frozen byte for byte (T911), so only its words change.
  assert.match(read('components/UI/Onboarding.tsx'), /t\("onboarding\.you\.choose\.when\.eligible\.results\.are\.kept\.e76303"\)/);
  assert.match(english['onboarding.you.choose.when.eligible.results.are.kept.e76303'], /^Results are kept in Recent/);
});

test('item 6: forced colours keep an edge on slots, chips and buttons over a page picture', () => {
  const css = read('index.css');
  const block = css.slice(css.indexOf('@media (forced-colors: active)'));
  assert.match(block, /\.tk-slot:not\(\[aria-disabled\]\) \{ border-bottom: 2px solid ButtonText !important; \}/);
  assert.match(block, /\.tk-chip-editor \{ border: 1px solid ButtonText !important; \}/);
  assert.match(block, /\.tk-rtile-eyebtn \{ border: 1px solid ButtonText !important; \}/);
  assert.match(read('scripts/verify-forced-colors.mjs'), /emulateMedia\(\{ forcedColors: 'active' \}\)/);
  // A check to run by hand, not part of the package scripts.
  assert.doesNotMatch(read('package.json'), /verify-forced-colors/);
});
