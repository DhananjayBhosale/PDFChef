import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldWarnForBytes } from '../../services/workspace.ts';

// A big file asks before a heavy job, through one shared sheet.
// Fix round 2 (output/web/ui-redesign/audit/prompts/final-fix-2.md): the contracts behind each item.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

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

test('findings 1, 3, 5, 6, 7: one heavy-job gate, Create PDF and Compare inputs, no repeat, Open PDF asks', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.match(screen, /export const pressMainAction = /);
  assert.match(screen, /const HEAVY_ACTION = '\[data-heavy-action\]';/);
  assert.match(screen, /if \(event\.repeat \|\| isOff\(main\)\) return;/);
  for (const tool of ['UnlockPDF', 'SecurityPDF']) assert.match(read(`components/Tools/${tool}.tsx`), /pressMainAction\(event\.currentTarget\)\) event\.preventDefault\(\);/, tool);
  assert.match(read('components/Tools/SplitPDF.tsx'), /data-heavy-action=""/);
  assert.match(read('components/Tools/MakePDF.tsx'), /className="tk-mtile" data-work-item=\{image\.id\}/);
  assert.match(read('components/Tools/ComparePDF.tsx'), /useWorkInput\(`\$\{file1\?\.name/);
  assert.match(read('components/UI/OutputCenter.tsx'), /navigate\('\/view', \{ state: \{ openTools: openTools && !accessLocked, openedPdfId: opened\.id, leavesWork: !openTools \} \}\);/);
});

test('the screen draws the main button a tool gives as onRun, and asks before it runs', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.match(screen, /<button type="button" data-run="" onClick=\{runMain\} disabled=\{runDisabled\} aria-describedby=\{runDescribedBy\} className="tk-primary chef-pressable">/);
  // A press, Ctrl+Enter and pressMainAction all reach runMain, which asks the heavy-job question first.
  assert.match(screen, /const ask = heavyQuestion\(\);\s*if \(!ask\) \{ runRef\.current\?\.\(\); return; \}\s*void ask\(\)\.then\(\(go\) => \{ if \(go\) runRef\.current\?\.\(\); \}\);/);
  // The click capture leaves that button alone, or the question would be asked twice.
  assert.match(screen, /isOff\(target\) \|\| target\.matches\(RUN_BUTTON\)\) return;/);
  for (const tool of ['MergePDF', 'SplitPDF', 'ExtractPages', 'DeletePages', 'RotatePDF', 'ReorderPDF', 'CompressPDF', 'WatermarkPDF',
    'PageNumbersPDF', 'PDFToImage', 'MetadataPDF', 'FlattenPDF', 'RepairPDF', 'UnlockPDF', 'SecurityPDF', 'BatchPDF', 'MakePDF', 'PdfAdvancedTools']) {
    const source = read(`components/Tools/${tool}.tsx`);
    assert.match(source, /onRun=\{/, tool);
    assert.doesNotMatch(source, /\baction=\{/, tool);
  }
  assert.match(read('components/Tool/ConverterScreen.tsx'), /onRun=\{refused \? onChooseAnother : onConvert\}/);
});
