import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// What Unlock PDF says about its password field.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('Unlock says why its action waits, in the field, like Protect (H2-03)', () => {
  const unlock = read('components/Tools/UnlockPDF.tsx');
  assert.match(unlock, /<span id="unlock-password-required" className="tk-hintfield-hint">\{t\("android-parity\.password\.is\.required\.to\.unlock\.the\.pdf\.be2e2e"\)\}<\/span>/);
  assert.match(unlock, /runDescribedBy=\{needsPassword && password\.length === 0 \? 'unlock-password-required' : undefined\}/);
});

test('Unlock does not say a password is required next to a wrong-password error (H2-02)', () => {
  assert.match(read('components/Tools/UnlockPDF.tsx'), /\{!status\.error && <span id="unlock-password-required"/);
});
