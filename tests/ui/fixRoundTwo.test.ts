import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTemporaryLocale } from '../../services/i18n/core.ts';
import { joinSentences, sharedPictureNote } from '../../components/Tool/values.ts';
import { shouldWarnForBytes } from '../../services/workspace.ts';

// Fix round 2 (output/web/ui-redesign/audit/prompts/final-fix-2.md): the contracts behind each item.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('item 6: Extract Images says when one picture is used on several pages', () => {
  assert.equal(sharedPictureNote([{ pageNumbers: [1] }, { pageNumbers: [2] }]), '');
  assert.equal(sharedPictureNote([{ pageNumbers: [2, 2] }]), '', 'the same page twice is not sharing');
  assert.equal(sharedPictureNote([{ pageNumbers: [4, 1, 3, 2] }]), 'The same picture is used on pages ⁦1–4⁩, so it is saved once.');
  assert.equal(sharedPictureNote([{ pageNumbers: [1, 3] }]), 'The same picture is used on pages 1 and 3, so it is saved once.');
  assert.equal(sharedPictureNote([{ pageNumbers: [1, 2] }, { pageNumbers: [3, 4] }]), '2 pictures are used on more than one page. Each is saved once.');
  assert.equal(joinSentences('Found 1 embedded image.', ''), 'Found 1 embedded image.');
  assert.equal(joinSentences('A.', 'B.'), 'A. B.');
});

test('item 6: the note is translated, with the locale digits, and Japanese joins without a space', async () => {
  await setTemporaryLocale('ar-SA');
  try {
    assert.match(sharedPictureNote([{ pageNumbers: [1, 2, 3, 4] }]), /[١٤]/);
    assert.doesNotMatch(sharedPictureNote([{ pageNumbers: [1, 2, 3, 4] }]), /The same picture/);
  } finally {
    await setTemporaryLocale('en-US');
  }
  await setTemporaryLocale('ja-JP');
  try {
    assert.equal(joinSentences('一。', '二。'), '一。二。');
  } finally {
    await setTemporaryLocale('en-US');
  }
});

test('item 7: the heavy-job threshold is the setting, in bytes', () => {
  // No window: the defaults (on, 80 MB).
  assert.equal(shouldWarnForBytes(79 * 1024 * 1024), false);
  assert.equal(shouldWarnForBytes(80 * 1024 * 1024), true);
});

test('item 7: every tool that can take long on a big file warns through the shared sheet', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.match(screen, /heavyJob\?: \{ bytes: number; files\?: number; title\?: string \}/);
  assert.match(screen, /!shouldWarnForBytes\(job\.bytes\)/);
  for (const tool of ['UnlockPDF', 'SecurityPDF', 'MetadataPDF', 'FlattenPDF', 'SplitPDF', 'RepairPDF', 'RotatePDF', 'PageNumbersPDF',
    'ExtractPages', 'DeletePages', 'ReorderPDF', 'WatermarkPDF', 'CompressPDF', 'MergePDF', 'BatchPDF', 'ComparePDF', 'PdfAdvancedTools']) {
    assert.match(read(`components/Tools/${tool}.tsx`), /heavyJob=\{/, tool);
  }
  for (const tool of ['WordToPDF', 'PowerPointToPDF', 'PDFToWord']) {
    assert.match(read(`components/Tools/${tool}.tsx`), /heavyTitle=\{t\(/, tool);
  }
  for (const tool of ['OCRPDF', 'MakeFillable']) {
    assert.match(read(`components/Tools/${tool}.tsx`), /await heavy\.confirm\(/, tool);
  }
  // No tool asks with the browser's own English confirm any more, and Cancel keeps the file.
  for (const tool of ['BatchPDF', 'WordToPDF', 'PowerPointToPDF', 'PDFToWord', 'OCRPDF']) {
    assert.doesNotMatch(read(`components/Tools/${tool}.tsx`), /window\.confirm\(/, tool);
  }
  // PDF to Image counts its working memory against the same setting (fable C7).
  assert.match(read('components/Tools/PDFToImage.tsx'), /requiresLargeJobConfirmation = shouldWarnForBytes\(estimatedWorkingMemoryBytes\)/);
});

test('item 1: the earlier-result snapshot reads every input from the screen, not a list per tool', () => {
  const signature = read('components/UI/workSignature.ts');
  assert.match(signature, /const READ = 'input, select, textarea, \[role="slider"\], \[aria-pressed\], \[aria-checked\], \[aria-selected\], \[data-work-item\], \[data-page-item\]'/);
  assert.match(signature, /attributeFilter: \['aria-pressed', 'aria-checked', 'aria-selected', 'aria-valuenow', 'data-work-item', 'data-page-item', 'value', 'data-kind'\]/);
  assert.match(read('components/Tool/QueueRow.tsx'), /data-work-item=\{`\$\{name\}:\$\{file\.size\}`\}/);
  assert.match(read('components/UI/PageThumbnail.tsx'), /data-work-item=\{`\$\{pageIndex\}:\$\{normalizedRotation\}`\}/);
  for (const [tool, model] of [['EditPDF', 'currentSnapshot'], ['SignPDF', 'signatures'], ['ImageToPDF', 'pages'], ['MakeFillable', 'fields']]) {
    assert.match(read(`components/Tools/${tool}.tsx`), new RegExp(`useWorkInput\\(${model}\\)`), tool);
  }
  // Every input back as it was: the result is current again.
  assert.match(read('components/UI/OutputCenter.tsx'), /if \(sameWork\(now, base\.baseline\)\) \{ setStale\(false\); return; \}/);
});

test('item 2: one blocker asks on Back as the links do, and not after a save', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.equal(screen.match(/useBlocker\(/g)?.length, 1);
  assert.match(screen, /if \(currentLocation\.pathname === nextLocation\.pathname\) return false;/);
  assert.match(screen, /historyAction === NavigationType\.Replace && nextLocation\.pathname === '\/'/);
  assert.match(screen, /return asks && wouldLose\(\);/);
  assert.match(screen, /getStripSaved/);
  for (const file of ['hooks/useConfirmDiscard.tsx', 'components/Tools/EditPDF.tsx']) assert.doesNotMatch(read(file), /useBlocker/, file);
});

test('item 5: Ctrl/Cmd+Enter runs the main action, and a disabled main action stays reachable with its reason', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.match(screen, /event\.key !== 'Enter' \|\| !\(event\.ctrlKey \|\| event\.metaKey\)/);
  assert.match(screen, /\[aria-modal="true"\]/);
  const parts = read('components/Tool/parts.tsx');
  assert.match(parts, /'aria-disabled': true/);
  assert.match(parts, /export const ActionReasonContext = createContext\(''\)/);
  assert.match(read('components/Tool/tool.css'), /\.tk-primary\[aria-disabled="true"\]/);
});

test('item 8: a very short screen (400% zoom) gets a compact tab bar; normal sizes do not change', () => {
  const css = read('components/Layout/tabBarGlass.css');
  const block = css.slice(css.indexOf('@media (max-height: 320px)'));
  assert.match(block, /--size-tab-bar: 48px;/);
  assert.match(block, /flex-direction: row;/);
  assert.match(read('assets/design-tokens.css'), /--size-tab-bar: 60px;/);
});

test('item 9: Sign measures its fitted view again when the page view changes size', () => {
  const sign = read('components/Tools/SignPDF.tsx');
  assert.match(sign, /new ResizeObserver\(\(\) => fitToViewport\(\)\)/);
  // The zoom is held relative to the fitted view, so a view at the fit follows a new fit.
  assert.match(sign, /const zoom = view \* startZoom;/);
  assert.match(sign, /startZoomRef\.current = start;\n    setStartZoom\(start\);\n  \}, \[\]\);/);
});

test('item 10: small fixes from the reports', () => {
  // desktop-r9-04: a rejected range is not also told to press Select.
  assert.match(read('components/UI/PageRangeSelector.tsx'), /const pendingLine = pending && !error;/);
  // desktop-r9-06: a colour code reads left to right in Arabic.
  assert.match(read('components/Tools/BusinessDocumentBuilder.tsx'), /dir="ltr"\n\s+spellCheck=\{false\}\n\s+aria-label=\{t\("business-document-builder\.colour\.code\.3a26d6"\)\}/);
  // fable K11: "Edit PDF Beta", not "Edit PDFBETA".
  assert.match(read('components/Tool/ToolTop.tsx'), /<span className="sr-only">\{` \$\{betaWord\}`\}<\/span>/);
  // fable C9: Compress words a locked file as every other tool does.
  assert.match(read('components/Tools/CompressPDF.tsx'), /\? t\('error\.pdfLocked'\)/);
  // fable C5: Sign keeps a drawing while another tab is looked at.
  assert.match(read('components/Tools/SignPDF.tsx'), /drawnSnapshotRef\.current = canvas\.toDataURL\('image\/png'\)/);
});
