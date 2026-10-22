import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'components/Tools/ViewPDF.tsx'), 'utf8');
const between = (start: string, end: string) => {
  const from = source.indexOf(start);
  assert.ok(from > -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
};

// CNV-01: the Android WebView has no navigator.share, so Read PDF had no Share button there.
test('Read PDF offers Share whenever the platform can share, not only with Web Share', () => {
  const gate = between('const canShare = Boolean(', ');');
  assert.match(gate, /shareFresh/);
  assert.doesNotMatch(gate, /typeof navigator\.share === 'function'/);
  assert.match(source, /const shareFresh = platform\.shareFresh;/);
});

test('Read PDF shares the open file through the platform', () => {
  const share = between('const sharePdf = async', 'const signatureVerification');
  assert.match(share, /shareFresh\(\{ blob: openedPdf\.file, name: openedPdf\.name, mimeType: 'application\/pdf' \}\)/);
  assert.doesNotMatch(share, /navigator\.share\(/);
  // A locked preview still asks for access first, and a closed sheet is not an error.
  assert.match(share, /runWithExportAccess\(performShare\)/);
  assert.match(share, /error\?\.name !== 'AbortError'/);
  assert.match(share, /finally \{\s*setSharing\(false\);/);
});

test('the browser platform still shares through Web Share', () => {
  const runtime = readFileSync(resolve(root, 'hooks/useWorkspaceRuntime.tsx'), 'utf8');
  const browser = runtime.slice(runtime.indexOf('export const browserPlatform'));
  assert.match(browser, /shareFresh: canWebShare\(\)/);
  assert.match(browser, /await webShareFile\(fileFrom\(result\.blob, resolved, result\.mimeType\), resolved\)/);
});
