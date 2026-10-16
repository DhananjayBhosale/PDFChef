import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AndroidLegacyHistorySnapshot,
  AndroidLegacySettingsSnapshot,
} from '../../services/platform/android/legacyCompatibilityContracts.ts';
import {
  importAndroidOnboardingContinuity,
  legacyOnboardingIsComplete,
  resolveAndroidLegacyInterfaceFont,
  startAndroidOnboardingContinuity,
  type AndroidOnboardingContinuityRun,
  type AndroidOnboardingSettle,
} from '../../services/platform/android/androidOnboardingContinuity.ts';

const snapshot = (
  health: AndroidLegacySettingsSnapshot['health'],
  onboardingCompleted?: boolean,
  appFontOption?: string,
): AndroidLegacySettingsSnapshot => {
  const values: AndroidLegacySettingsSnapshot['values'] = {
    ...(onboardingCompleted !== undefined
      ? { onboarding_completed: onboardingCompleted }
      : {}),
    ...(appFontOption !== undefined ? { app_font_option: appFontOption } : {}),
  };
  return {
    health,
    invalidValueCount: health === 'partial_invalid' ? 1 : 0,
    values,
  };
};

const history = (
  health: AndroidLegacyHistorySnapshot['health'],
  returnedCount: number,
): AndroidLegacyHistorySnapshot => ({
  health,
  sourceCount: returnedCount,
  invalidRecordCount: health === 'partial_invalid' ? 1 : 0,
  returnedCount,
  truncated: false,
  entries: [],
});

test('T911: only an independently valid positive legacy completion is importable', () => {
  assert.equal(legacyOnboardingIsComplete(snapshot('ok', true)), true);
  assert.equal(legacyOnboardingIsComplete(snapshot('partial_invalid', true)), true);
  assert.equal(legacyOnboardingIsComplete(snapshot('ok', false)), false);
  assert.equal(legacyOnboardingIsComplete(snapshot('ok')), false);
  for (const health of ['missing', 'blank', 'corrupt'] as const) {
    assert.equal(legacyOnboardingIsComplete(snapshot(health)), false);
  }
});

test('T917: only exact shared legacy font families are mapped and readable absence converges', () => {
  assert.deepEqual(resolveAndroidLegacyInterfaceFont(snapshot('ok', true, 'DEFAULT')), {
    font: 'system', settled: true,
  });
  assert.deepEqual(resolveAndroidLegacyInterfaceFont(snapshot('ok', true, 'INTER')), {
    font: 'inter', settled: true,
  });
  assert.deepEqual(resolveAndroidLegacyInterfaceFont(snapshot('partial_invalid', true, 'MANROPE')), {
    font: 'manrope', settled: true,
  });
  assert.deepEqual(resolveAndroidLegacyInterfaceFont(snapshot('ok', true, 'ROBOTO')), {
    font: null, settled: true,
  });
  assert.deepEqual(resolveAndroidLegacyInterfaceFont(snapshot('missing')), {
    font: null, settled: true,
  });
  assert.deepEqual(resolveAndroidLegacyInterfaceFont(snapshot('corrupt')), {
    font: null, settled: false,
  });
});

test('T911: shared completion is authoritative and never touches the legacy bridge', async () => {
  let reads = 0;
  let writes = 0;
  const status = await importAndroidOnboardingContinuity({
    readSharedOnboardingComplete: () => true,
    readLegacySettings: async () => { reads += 1; return snapshot('ok', true); },
    markSharedOnboardingComplete: () => { writes += 1; },
    isCommitAllowed: () => true,
  });
  assert.equal(status, 'already-complete');
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('T917: explicit shared font and completed onboarding avoid the legacy bridge', async () => {
  let reads = 0;
  let writes = 0;
  const status = await importAndroidOnboardingContinuity({
    readSharedOnboardingComplete: () => true,
    readLegacySettings: async () => { reads += 1; return snapshot('ok', true, 'MANROPE'); },
    markSharedOnboardingComplete: () => { writes += 1; },
    readExplicitSharedInterfaceFont: () => 'inter',
    isLegacyInterfaceFontChecked: () => false,
    markSharedInterfaceFont: () => { writes += 1; },
    markLegacyInterfaceFontChecked: () => { writes += 1; },
    isCommitAllowed: () => true,
  });
  assert.equal(status, 'already-complete');
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('T917: a materialized default does not block one-read Manrope import', async () => {
  let reads = 0;
  let onboardingWrites = 0;
  let importedFont: string | null = null;
  let checked = 0;
  const status = await importAndroidOnboardingContinuity({
    readSharedOnboardingComplete: () => true,
    readLegacySettings: async () => { reads += 1; return snapshot('ok', true, 'MANROPE'); },
    markSharedOnboardingComplete: () => { onboardingWrites += 1; },
    // Null means the stored Inter value has no explicit shared-authority marker.
    readExplicitSharedInterfaceFont: () => null,
    isLegacyInterfaceFontChecked: () => false,
    markSharedInterfaceFont: font => { importedFont = font; },
    markLegacyInterfaceFontChecked: () => { checked += 1; },
    isCommitAllowed: () => true,
  });
  assert.equal(status, 'imported');
  assert.equal(reads, 1);
  assert.equal(onboardingWrites, 0);
  assert.equal(importedFont, 'manrope');
  assert.equal(checked, 1);
});

test('T917: unsupported readable font converges without approximation and corrupt state retries', async () => {
  for (const [legacy, expectedChecked] of [
    [snapshot('ok', true, 'ROBOTO'), 1],
    [snapshot('corrupt'), 0],
  ] as const) {
    let importedFont: string | null = null;
    let checked = 0;
    const status = await importAndroidOnboardingContinuity({
      readSharedOnboardingComplete: () => true,
      readLegacySettings: async () => legacy,
      markSharedOnboardingComplete: () => { throw new Error('must not write onboarding'); },
      readExplicitSharedInterfaceFont: () => null,
      isLegacyInterfaceFontChecked: () => false,
      markSharedInterfaceFont: font => { importedFont = font; },
      markLegacyInterfaceFontChecked: () => { checked += 1; },
      isCommitAllowed: () => true,
    });
    assert.equal(status, 'unchanged');
    assert.equal(importedFont, null);
    assert.equal(checked, expectedChecked);
  }
});

test('T911: ok and partial-invalid positive values each perform exactly one bounded write', async () => {
  for (const health of ['ok', 'partial_invalid'] as const) {
    let writes = 0;
    const status = await importAndroidOnboardingContinuity({
      readSharedOnboardingComplete: () => false,
      readLegacySettings: async () => snapshot(health, true),
      markSharedOnboardingComplete: () => { writes += 1; },
      isCommitAllowed: () => true,
    });
    assert.equal(status, 'imported');
    assert.equal(writes, 1);
  }
});

test('T911: false, absent and unhealthy legacy state preserve genuine first run', async () => {
  const cases = [
    snapshot('ok', false),
    snapshot('ok'),
    snapshot('missing'),
    snapshot('blank'),
    snapshot('corrupt'),
  ];
  for (const legacy of cases) {
    let writes = 0;
    const status = await importAndroidOnboardingContinuity({
      readSharedOnboardingComplete: () => false,
      readLegacySettings: async () => legacy,
      markSharedOnboardingComplete: () => { writes += 1; },
      isCommitAllowed: () => true,
    });
    assert.equal(status, 'unchanged');
    assert.equal(writes, 0);
  }
});

test('an existing legacy history suppresses repeated onboarding when its preference is unavailable', async () => {
  for (const settings of [snapshot('ok'), snapshot('corrupt')] as const) {
    let writes = 0;
    const status = await importAndroidOnboardingContinuity({
      readSharedOnboardingComplete: () => false,
      readLegacySettings: async () => settings,
      readLegacyHistory: async () => history('ok', 1),
      markSharedOnboardingComplete: () => { writes += 1; },
      isCommitAllowed: () => true,
    });
    assert.equal(status, 'imported');
    assert.equal(writes, 1);
  }
});

test('an explicit legacy first-run value is authoritative even when history exists', async () => {
  let historyReads = 0;
  let writes = 0;
  const status = await importAndroidOnboardingContinuity({
    readSharedOnboardingComplete: () => false,
    readLegacySettings: async () => snapshot('ok', false),
    readLegacyHistory: async () => { historyReads += 1; return history('ok', 1); },
    markSharedOnboardingComplete: () => { writes += 1; },
    isCommitAllowed: () => true,
  });
  assert.equal(status, 'unchanged');
  assert.equal(historyReads, 0);
  assert.equal(writes, 0);
});

test('T911: storage and bridge failures are contained without suppressing onboarding', async () => {
  const failingRead = await importAndroidOnboardingContinuity({
    readSharedOnboardingComplete: () => { throw new Error('storage disabled'); },
    readLegacySettings: async () => snapshot('ok', true),
    markSharedOnboardingComplete: () => { throw new Error('must not write'); },
    isCommitAllowed: () => true,
  });
  assert.equal(failingRead, 'unavailable');

  const failingBridge = await importAndroidOnboardingContinuity({
    readSharedOnboardingComplete: () => false,
    readLegacySettings: async () => { throw new Error('bridge failed'); },
    markSharedOnboardingComplete: () => { throw new Error('must not write'); },
    isCommitAllowed: () => true,
  });
  assert.equal(failingBridge, 'unavailable');

  const failingWrite = await importAndroidOnboardingContinuity({
    readSharedOnboardingComplete: () => false,
    readLegacySettings: async () => snapshot('ok', true),
    markSharedOnboardingComplete: () => { throw new Error('quota'); },
    isCommitAllowed: () => true,
  });
  assert.equal(failingWrite, 'unavailable');
});

test('T911: a closed commit window refuses a late positive native read', async () => {
  let writes = 0;
  const status = await importAndroidOnboardingContinuity({
    readSharedOnboardingComplete: () => false,
    readLegacySettings: async () => snapshot('ok', true),
    markSharedOnboardingComplete: () => { writes += 1; },
    isCommitAllowed: () => false,
  });
  assert.equal(status, 'abandoned');
  assert.equal(writes, 0);
});

test('T911: bootstrap never commits before settle and commits exactly once after it', async () => {
  let releaseSettle: (() => void) | null = null;
  const settle: AndroidOnboardingSettle = () => new Promise(resolve => {
    releaseSettle = () => resolve('unchanged');
  });
  let commits = 0;
  const started = startAndroidOnboardingContinuity(
    settle,
    () => { commits += 1; },
    async () => 'unchanged',
  );
  assert.equal(commits, 0);
  assert.ok(releaseSettle);
  releaseSettle();
  await started;
  assert.equal(commits, 1);
});

test('T911: bootstrap renders once even if the bounded settle seam rejects', async () => {
  const settle: AndroidOnboardingSettle = async () => { throw new Error('unexpected settle failure'); };
  let commits = 0;
  await startAndroidOnboardingContinuity(
    settle,
    () => { commits += 1; },
    async () => 'unchanged',
  );
  assert.equal(commits, 1);
});

test('T911: timeout closes the window before a delayed native result can write', async () => {
  let releaseLegacy: ((value: AndroidLegacySettingsSnapshot) => void) | null = null;
  const legacy = new Promise<AndroidLegacySettingsSnapshot>(resolve => { releaseLegacy = resolve; });
  let writes = 0;
  let background: Promise<unknown> | null = null;
  const run: AndroidOnboardingContinuityRun = isCommitAllowed =>
    importAndroidOnboardingContinuity({
      readSharedOnboardingComplete: () => false,
      readLegacySettings: () => legacy,
      markSharedOnboardingComplete: () => { writes += 1; },
      isCommitAllowed,
    });
  const settle: AndroidOnboardingSettle = (start, fallback) => {
    background = start();
    return Promise.resolve(fallback);
  };
  let commits = 0;
  await startAndroidOnboardingContinuity(settle, () => { commits += 1; }, run);
  assert.equal(commits, 1);
  assert.equal(writes, 0);
  assert.ok(releaseLegacy);
  releaseLegacy(snapshot('ok', true));
  assert.equal(await background, 'abandoned');
  assert.equal(writes, 0);
});

test('T917: timeout also refuses a late legacy font import and completion marker', async () => {
  let releaseLegacy: ((value: AndroidLegacySettingsSnapshot) => void) | null = null;
  const legacy = new Promise<AndroidLegacySettingsSnapshot>(resolve => { releaseLegacy = resolve; });
  let fontWrites = 0;
  let checked = 0;
  let background: Promise<unknown> | null = null;
  const run: AndroidOnboardingContinuityRun = isCommitAllowed =>
    importAndroidOnboardingContinuity({
      readSharedOnboardingComplete: () => true,
      readLegacySettings: () => legacy,
      markSharedOnboardingComplete: () => { throw new Error('must not write onboarding'); },
      readExplicitSharedInterfaceFont: () => null,
      isLegacyInterfaceFontChecked: () => false,
      markSharedInterfaceFont: () => { fontWrites += 1; },
      markLegacyInterfaceFontChecked: () => { checked += 1; },
      isCommitAllowed,
    });
  const settle: AndroidOnboardingSettle = (start, fallback) => {
    background = start();
    return Promise.resolve(fallback);
  };
  await startAndroidOnboardingContinuity(settle, () => undefined, run);
  assert.ok(releaseLegacy);
  releaseLegacy(snapshot('ok', true, 'MANROPE'));
  assert.equal(await background, 'abandoned');
  assert.equal(fontWrites, 0);
  assert.equal(checked, 0);
});
