import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { finalNumberValue, liveNumberValue } from '../../components/UI/numberDraft.ts';

/**
 * Research round 5 (output/web/ui-redesign/audit/research-r5): fixes whose loss no other unit check
 * would notice. The browser check for the slider fields is tests/browser/sliderFieldCommit.mjs;
 * the others are in that round's fix-scripts/.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('a slider and its number box: the last one used wins (mobile-01)', () => {
  const field = read('components/UI/ChefSlider.tsx');
  // Focus alone does not make the box's text the value; only a keystroke does.
  assert.doesNotMatch(field, /onFocus=\{\(event\) => \{[^}]*editing/);
  assert.match(field, /onChange=\{\(event\) => \{\s*typed\.current = true;/);
  // Leaving a box nobody typed in changes nothing.
  assert.match(field, /const commit = \(\) => \{\s*if \(!typed\.current\) \{\s*setDraft\(format\(value\)\);\s*return;/);
  // Moving the slider drops typed text.
  assert.match(field, /const slide = \(next: number\) => \{\s*typed\.current = false;\s*onChange\(next\);/);
  assert.match(field, /<ChefSlider[\s\S]*?onChange=\{slide\}/);
});

test('a slider slot on a touch screen opens on its slider, not its box (mobile-02)', () => {
  const popover = read('components/Tool/Popover.tsx');
  assert.match(popover, /if \(target\?\.matches\(TYPING\) && window\.matchMedia\?\.\('\(pointer: coarse\)'\)\.matches\) \{\s*target = body\?\.querySelector<HTMLElement>\(SLIDER\) \?\? body\?\.querySelector<HTMLElement>\(STEP\) \?\? target;/);
});

test('a typed font size or part size is clamped when the box is left, not per key (mobile-03)', () => {
  // "12" on its way through "1" is not applied as 8, and "12" stays 12.
  assert.equal(liveNumberValue('1', 8, 48), null);
  assert.equal(liveNumberValue('12', 8, 48), 12);
  assert.equal(finalNumberValue('120', 8, 48), 48);
  assert.equal(finalNumberValue('', 8, 48), null);
  assert.match(read('components/Tools/PdfAdvancedTools.tsx'), /<ClampedNumberInput\s+min=\{8\}\s+max=\{48\}\s+value=\{fontSize\}/);
  assert.match(read('components/Tools/BatchPDF.tsx'), /<ClampedNumberInput[\s\S]{0,200}?value=\{pagesPerSplit\}/);
});

test('the Compress preview shows no size it cannot stand behind (desktop-02)', () => {
  const browser = read('services/pdfBrowser.ts');
  // Keep-text mode has no honest estimate; pictures mode measures as the Compress screen does.
  assert.match(browser, /metrics: \{ estimatedTotalSize: 0 \}/);
  assert.match(browser, /const estimatedTotalSize = await measureProjectedSize\(file, config, \{ maxSamples: 2 \}\);/);
  assert.match(read('components/Tools/ReadabilityPreview.tsx'), /setSizeEstimate\(result\.metrics\.estimatedTotalSize > 0 \?/);
});

test('Image to PDF: focus waits on Save PDF, and Clear all asks first (desktop-06, mobile-05)', () => {
  const tool = read('components/Tools/ImageToPDF.tsx');
  assert.match(tool, /const clearAll = \(\) => setConfirmClear\(true\);/);
  assert.match(tool, /saveRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
});

test('a tool opened by its address starts keyboard focus at the tool (desktop-07)', () => {
  assert.match(read('components/Tool/ToolScreen.tsx'), /\(onMain \|\| \(!pageLoadSettled && lost\)\)/);
});

test('Read PDF: no stale count, Escape closes search, the page scrolls by key (desktop-04, desktop-05)', () => {
  const view = read('components/Tools/ViewPDF.tsx');
  assert.match(view, /const searchCurrent = searchedQuery !== null && searchedQuery === searchQuery\.trim\(\) && searchedQuery !== '';/);
  assert.match(view, /tabIndex=\{-1\}/);
});

test('Edit PDF marks text that no longer fits while it is typed (desktop-08)', () => {
  assert.match(read('components/Tools/EditPDF.tsx'), /data-overflow=\{textLayout\?\.overflow \? '' : undefined\}/);
  assert.match(read('components/Tool/tool.css'), /\[data-testid="inline-text-editor"\]\[data-overflow\]/);
});

test('Sign and Reorder keep their handles apart (mobile-06, mobile-07, mobile-08)', () => {
  const sign = read('components/Tools/SignPDF.tsx');
  assert.match(sign, /nextSignature\.x = Math\.min\(nextSignature\.x \+ 0\.04, 1 - nextSignature\.width\);/);
  // Round 6 (gpt-terra): Remove sits outside the stamp's top-left corner, so a tap on the stamp never deletes it.
  assert.match(sign, /tk-sign-handle tk-sign-remove [^"]*absolute bottom-full right-full/);
  // Reorder's grid handle sits in the thumbnail's bottom corner, off the page's title.
  assert.match(read('components/Tool/tool.css'), /\.tk-rgrid \.tk-drag \{ inset-block-start: auto; inset-block-end: 4px; inset-inline-end: 4px;/);
});

test('another tab follows Recent and Settings without a reload (desktop-11)', () => {
  const workspace = read('services/workspace.ts');
  assert.match(workspace, /new BroadcastChannel\('pdfchef-workspace'\)/);
  assert.ok((workspace.match(/tellOtherTabs\(\);/g) ?? []).length >= 5);
  assert.match(read('components/Pages/SettingsPage.tsx'), /window\.addEventListener\('pdfchef:settings-changed', follow\);/);
});
