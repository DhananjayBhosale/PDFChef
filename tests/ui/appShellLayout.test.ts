import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The app shell: tool header links, the tab bar, and Recent and Settings across tabs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

// Research r2 (web-lead decision): tablet portrait, 768 px and wider, gets the same links; phones
// under 768 px keep only Tools.
test('desktop and tablet tool headers reach Recent and Settings in one click; phones keep only Tools (desktop-07)', () => {
  const top = read('components/Tool/ToolTop.tsx');
  assert.match(top, /const links = useHeaderLinks\(\) && !bare;/);
  assert.match(read('hooks/useMediaQuery.ts'), /export const useHeaderLinks = \(\) => useMediaQuery\(MQ_MD\);/);
  assert.match(read('hooks/useMediaQuery.ts'), /export const MQ_MD = MQ_LG;/);
  assert.match(top, /\{links \? \(\s*<nav ref=\{navFit\.ref\}[^>]*className="tk-topnav">[\s\S]{0,200}?<DesktopNavLinks compact=\{wide && navFit\.level > 0\} \/>\s*<BackOrTools \/>\s*<\/nav>\s*\) : <BackOrTools \/>\}/);
  // Recent and Settings are the side rail's own links, minus the one "‹ Settings" already goes to.
  assert.match(top, /nav\.items\.slice\(1\)\.filter\(\(item\) => !\(fromSettings && item\.to === backTab\.to\)\)/);
  // Cramped, a link shows its icon alone, but its name stays the same word.
  assert.match(top, /<span className=\{compact \? 'sr-only' : undefined\}>\{item\.label\}<\/span>/);
  const reader = read('components/Tools/ViewPDF.tsx');
  assert.match(reader, /const links = useHeaderLinks\(\);/);
  assert.match(reader, /\{links && \(\s*<nav ref=\{navFit\.ref\}[^>]*className="tk-topnav">\s*<DesktopNavLinks compact=\{navFit\.level > 0\} \/>/);
});

test('phones keep the Tools word until the name needs more than two lines; tablets get Recent and Settings (mobile-03, mobile-05)', () => {
  const css = read('components/Tool/tool.css');
  assert.match(css, /\.tk-top-row:is\(\[data-compact="4"\], \[data-compact="5"\]\) \.tk-tools > span \{ position: absolute;/);
  assert.match(css, /\.tk-top-row\[data-compact="5"\] \.tk-top-title \{ -webkit-hyphens: auto; hyphens: auto; \}/);
  const top = read('components/Tool/ToolTop.tsx');
  assert.match(top, /const MAX_LEVEL = 5;/);
  assert.match(top, /const links = useHeaderLinks\(\) && !bare;/);
});

test('the tool header is the page\'s banner, outside <main> (desktop-10)', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.ok(screen.indexOf('<ToolTop title={title}') < screen.indexOf('<main className={`tk-tool'));
  assert.match(read('components/Layout/AppShell.tsx'), /const MainBox = \(tabbed \? 'main' : 'div'\) as 'main';/);
});

test('item 8: a very short screen (400% zoom) gets a compact tab bar; normal sizes do not change', () => {
  const css = read('components/Layout/tabBarGlass.css');
  const block = css.slice(css.indexOf('@media (max-height: 320px)'));
  assert.match(block, /--size-tab-bar: 48px;/);
  assert.match(block, /flex-direction: row;/);
  assert.match(read('assets/design-tokens.css'), /--size-tab-bar: 60px;/);
});

test('another tab follows Recent and Settings without a reload (desktop-11)', () => {
  const workspace = read('services/workspace.ts');
  assert.match(workspace, /new BroadcastChannel\('pdfchef-workspace'\)/);
  assert.ok((workspace.match(/tellOtherTabs\(\);/g) ?? []).length >= 5);
  assert.match(read('components/Pages/SettingsPage.tsx'), /window\.addEventListener\('pdfchef:settings-changed', follow\);/);
});
