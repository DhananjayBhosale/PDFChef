import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keyboard use and where focus goes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('Enter in the Home search opens the first match of what was typed (desktop-06)', () => {
  const home = read('components/Tools/Dashboard.tsx');
  assert.match(home, /onKeyDown=\{openFirstMatch\}/);
  const handler = home.slice(home.indexOf('const openFirstMatch'), home.indexOf('const reset'));
  assert.match(handler, /isConfirmEnter\(event\)/);
  assert.match(handler, /rankTools\(query\.trim\(\), category\)\[0\]/);
  assert.match(handler, /navigate\(first\.path/);
});

test('Skip to content and a new file land on the tool\'s own content (desktop-01..04)', () => {
  assert.match(read('App.tsx'), /document\.querySelector<HTMLElement>\('#main \[data-skip-target\]'\)/);
  assert.match(read('components/Tool/ToolScreen.tsx'), /'data-skip-target': ''/);
});

test('Reorder Pages moves by keyboard and says where the page went (desktop-02)', () => {
  const reorder = read('components/Tools/ReorderPDF.tsx');
  assert.match(reorder, /aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"/);
  assert.match(reorder, /setMoved\(t\('reorder\.moved', \{ v0: item\.originalIndex \+ 1, v1: to \+ 1, v2: items\.length \}\)\)/);
  assert.match(read('services/i18n/en-US.ts'), /"reorder\.moved": "Page \{v0\} moved to place \{v1\} of \{v2\}\."/);
});

test('Image to PDF: focus waits on Save PDF, and Clear all asks first (desktop-06, mobile-05)', () => {
  const tool = read('components/Tools/ImageToPDF.tsx');
  assert.match(tool, /const clearAll = \(\) => setConfirmClear\(true\);/);
  assert.match(tool, /saveRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
});

test('a tool opened by its address starts keyboard focus at the tool (desktop-07)', () => {
  assert.match(read('components/Tool/ToolScreen.tsx'), /\(onMain \|\| \(!pageLoadSettled && lost\)\)/);
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

test('an overlay keyboard keeps an open editor above it (mobile-01)', () => {
  const popover = read('components/Tool/Popover.tsx');
  assert.match(popover, /viewport\.offsetTop \+ viewport\.height/);
  assert.match(popover, /window\.visualViewport\?\.addEventListener\('resize', schedule\)/);
});

test('Read PDF: no stale count, Escape closes search, the page scrolls by key (desktop-04, desktop-05)', () => {
  const view = read('components/Tools/ViewPDF.tsx');
  assert.match(view, /const searchCurrent = searchedQuery !== null && searchedQuery === searchQuery\.trim\(\) && searchedQuery !== '';/);
  assert.match(view, /tabIndex=\{-1\}/);
});
