import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Research round 1 (output/web/ui-redesign/audit/research-r1): fixes whose loss no other check
 * would notice, because the controls check allows extra controls and the notes are plain text.
 */

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

test('Enter in the Home search opens the first match of what was typed (desktop-06)', () => {
  const home = read('components/Tools/Dashboard.tsx');
  assert.match(home, /onKeyDown=\{openFirstMatch\}/);
  const handler = home.slice(home.indexOf('const openFirstMatch'), home.indexOf('const reset'));
  assert.match(handler, /isConfirmEnter\(event\)/);
  assert.match(handler, /rankTools\(query\.trim\(\), category\)\[0\]/);
  assert.match(handler, /navigate\(first\.path/);
});

test('notes that prevent a mistake or promise privacy are visible beside their control (desktop-01, mobile-05)', () => {
  const protect = read('components/Tools/SecurityPDF.tsx');
  assert.match(protect, /<span id="protect-password-help" className="tk-hintfield-hint"[^>]*>\{t\("security-pdf\.at\.least\.4\.characters\.with\.spaces\.preserved\.e0bf40"\)\}<\/span>/);
  const invoice = read('components/Tools/BusinessDocumentBuilder.tsx');
  assert.match(invoice, /<p id=\{yourDetailsHintId\} className="tk-bizsec-note">[\s\S]*?business-document-builder\.filled\.in\.for\.you\.next\.time\.on\.833430/);
  assert.doesNotMatch(invoice, /<p id=\{yourDetailsHintId\} className="sr-only"/);
});

test('closing a result sheet that opened by itself returns focus to its More actions button (desktop-11)', () => {
  const sheet = read('components/UI/Primitives.tsx');
  assert.match(sheet, /if \(!previous \|\| previous === document\.body \|\| document\.activeElement !== previous\) returnFocusRefRef\.current\?\.current\?\.focus\(\);/);
  const output = read('components/UI/OutputCenter.tsx');
  assert.match(output, /returnFocusRef=\{moreButtonRef\}/);
  assert.match(output, /ref=\{moreButtonRef\}/);
});
