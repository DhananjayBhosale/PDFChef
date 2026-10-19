import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RENDERER_RECOVERY_HASH, wasRendererRestarted } from '../../services/rendererRecovery.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('the Android shell and the page agree on the recovery marker, and only that marker counts', () => {
  const policy = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/security/PdfChefWebViewPolicy.java');
  assert.match(policy, new RegExp(`RENDERER_RECOVERY_FRAGMENT = "${RENDERER_RECOVERY_HASH.slice(1)}"`));
  const activity = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/MainActivity.java');
  assert.match(activity, /PdfChefWebViewPolicy\.rendererRecoveryUrl\(recoveryUrl\)/);
  assert.match(read('App.tsx'), /<RendererRecoveryNotice \/>/);

  assert.equal(wasRendererRestarted('#renderer-restarted'), true);
  assert.equal(wasRendererRestarted(''), false);
  assert.equal(wasRendererRestarted('#/compress'), false);
  assert.equal(wasRendererRestarted('#renderer-restarted-again'), false);
});
