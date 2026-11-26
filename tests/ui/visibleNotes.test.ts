import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Notes that prevent a mistake or promise privacy are visible.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('notes that prevent a mistake or promise privacy are visible beside their control (desktop-01, mobile-05)', () => {
  const protect = read('components/Tools/SecurityPDF.tsx');
  assert.match(protect, /<span id="protect-password-help" className="tk-hintfield-hint"[^>]*>\{t\("security-pdf\.at\.least\.4\.characters\.with\.spaces\.preserved\.e0bf40"\)\}<\/span>/);
  const invoice = read('components/Tools/BusinessDocumentBuilder.tsx');
  assert.match(invoice, /<p id=\{yourDetailsHintId\} className="tk-bizsec-note">[\s\S]*?business-document-builder\.filled\.in\.for\.you\.next\.time\.on\.833430/);
  assert.doesNotMatch(invoice, /<p id=\{yourDetailsHintId\} className="sr-only"/);
});
