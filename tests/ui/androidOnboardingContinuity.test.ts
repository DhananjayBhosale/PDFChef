import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = async (relative: string): Promise<string> =>
  readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('T911: Android constructs one platform before one bounded pre-render continuity gate', async () => {
  const entry = await source('index.tsx');
  assert.match(entry, /import\s*\{\s*startAndroidOnboardingContinuity\s*\}\s*from\s*['"]\.\/services\/platform\/android\/androidOnboardingContinuity['"]/);
  const branch = entry.slice(
    entry.indexOf("} else if (shellTarget === 'android') {"),
    entry.indexOf('} else {', entry.indexOf("} else if (shellTarget === 'android') {")),
  );
  const construct = branch.indexOf('const androidPlatform = createAndroidWorkspacePlatform(browserPlatform);');
  const start = branch.indexOf('startAndroidOnboardingContinuity(settleWithin, () => render(androidPlatform))');
  assert.ok(construct >= 0 && start > construct);
  assert.equal((branch.match(/createAndroidWorkspacePlatform\(/g) ?? []).length, 1);
  assert.equal((branch.match(/render\(/g) ?? []).length, 1);
  assert.doesNotMatch(branch, /console\./);
});

test('T911: compact onboarding component bytes remain frozen', async () => {
  const onboarding = await source('components/UI/Onboarding.tsx');
  assert.equal(
    createHash('sha256').update(onboarding).digest('hex'),
    'b959300d8876ea49310af0d9216ede9d52b70ed22fe2abe4692b407cfb52d218',
  );
});

test('T911: continuity module has no logging or legacy mutation surface', async () => {
  const continuity = await source('services/platform/android/androidOnboardingContinuity.ts');
  assert.doesNotMatch(continuity, /console\.|setThemeMode|AndroidLegacySettingsWriter|writeLegacy|onboarding_completed\s*:/);
  assert.match(continuity, /snapshot\.values\.onboarding_completed === true/);
  assert.match(continuity, /if \(!ports\.isCommitAllowed\(\)\) return 'abandoned'/);
});

test('T917: legacy font continuity is precedence-aware and keeps visible source frozen', async () => {
  const continuity = await source('services/platform/android/androidOnboardingContinuity.ts');
  const settings = await source('services/workspace.ts');
  assert.match(continuity, /readExplicitSharedInterfaceFont\(\) === null/);
  assert.match(continuity, /legacy === 'DEFAULT'/);
  assert.match(continuity, /legacy === 'INTER'/);
  assert.match(continuity, /legacy === 'MANROPE'/);
  assert.doesNotMatch(continuity, /legacy === 'ROBOTO'|legacy === 'POPPINS'/);
  assert.match(settings, /WORKSPACE_INTERFACE_FONT_AUTHORITY_KEY/);
  assert.match(settings, /ANDROID_LEGACY_INTERFACE_FONT_CHECK_KEY/);
  assert.doesNotMatch(continuity, /SettingsPage|interface-font|document\./);
});
