import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import english from '../../services/i18n/en-US.ts';
import type {
  AndroidLegacyThemeResolution,
  SharedAppearanceTheme,
} from '../../services/platform/android/androidSettings.ts';

/**
 * T908. Appearance now has two stores behind it on Android: this app's own and
 * the older app's settings. The rules below are the ones that keep them from
 * drifting apart — which store is authoritative, what a launch is allowed to
 * import, what a press may claim before the device has confirmed it, and what
 * happens to a write that a dying process interrupted.
 *
 * The provider is a `.tsx` module, which the Node test runner cannot load, so it
 * is built once with the project's own bundler and its exported decisions and
 * bridge are driven directly. The accepted platform contract keeps its own
 * frozen tests in tests/platform/androidSettings.test.ts.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(root, 'tests/ui/.tmp-appearance');
const settingsSource = readFileSync(resolve(root, 'components/Pages/SettingsPage.tsx'), 'utf8');
const appearanceSource = readFileSync(resolve(root, 'hooks/useAppearance.tsx'), 'utf8');

type AppearanceModule = typeof import('../../hooks/useAppearance.tsx');
let appearance: AppearanceModule;

before(async () => {
  const { build } = await import('vite');
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      write: true,
      target: 'node22',
      lib: { entry: resolve(root, 'hooks/useAppearance.tsx'), formats: ['es'], fileName: 'appearance' },
      rollupOptions: { external: (id: string) => !id.startsWith('.') && !id.startsWith('/') },
    },
  });
  appearance = (await import(resolve(outDir, 'appearance.js'))) as AppearanceModule;
});

after(() => rmSync(outDir, { recursive: true, force: true }));

/* ------------------------------------------------------------ harness --- */

const THEME_KEY = 'theme';
const MARKER_KEY = 'pdfchef.appearance.android-theme-write.v1';

interface StorageStub {
  values: Map<string, string>;
  read(key: string): string | null;
  write(key: string, value: string): boolean;
  remove(key: string): boolean;
}

const storageStub = (
  initial: Record<string, string> = {},
  refuse: { write?: (key: string) => boolean; remove?: (key: string) => boolean } = {},
): StorageStub => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read: (key) => values.get(key) ?? null,
    write(key, value) {
      if (refuse.write?.(key)) return false;
      values.set(key, value);
      return true;
    },
    remove(key) {
      if (refuse.remove?.(key)) return false;
      values.delete(key);
      return true;
    },
  };
};

const resolutionOf = (
  preference: SharedAppearanceTheme | null,
  legacyMode: AndroidLegacyThemeResolution['legacyMode'],
  health: AndroidLegacyThemeResolution['health'] = 'ok',
): AndroidLegacyThemeResolution => ({ health, preference, legacyMode });

interface BridgeHarness {
  bridge: ReturnType<AppearanceModule['createThemeBridge']>;
  storage: StorageStub;
  applied: string[];
  reported: string[];
  reads: number;
  writes: SharedAppearanceTheme[];
  alive: { current: boolean };
}

const harness = (options: {
  storage?: StorageStub;
  isAndroid?: boolean;
  /** Absent means no accepted reader/writer at all. */
  legacy?: (() => Promise<AndroidLegacyThemeResolution>) | null;
  write?: (preference: SharedAppearanceTheme) => Promise<unknown>;
}): BridgeHarness => {
  const storage = options.storage ?? storageStub();
  const applied: string[] = [];
  const reported: string[] = [];
  const writes: SharedAppearanceTheme[] = [];
  const alive = { current: true };
  const state = { reads: 0 };
  const persistence = options.legacy === null
    ? null
    : {
        readLegacyTheme: async () => {
          state.reads += 1;
          return (options.legacy ?? (async () => resolutionOf(null, null, 'missing')))();
        },
        writeTheme: async (preference: SharedAppearanceTheme) => {
          writes.push(preference);
          return (options.write ?? (async () => ({ mode: 'SYSTEM', changed: true })))(preference);
        },
      };

  const bridge = appearance.createThemeBridge({
    persistence: persistence as never,
    isAndroid: options.isAndroid ?? options.legacy !== null,
    storage,
    apply: (theme) => applied.push(theme),
    report: (state) => reported.push(state),
    isAlive: () => alive.current,
  });

  return {
    bridge,
    storage,
    applied,
    reported,
    writes,
    alive,
    get reads() {
      return state.reads;
    },
  };
};

const settled = async () => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

/* -------------------------------------------------------- authority --- */

test('a real local choice stays authoritative and the older store is not read', async () => {
  const test = harness({
    storage: storageStub({ [THEME_KEY]: 'dark' }),
    legacy: async () => {
      throw new Error('the older store must not be consulted');
    },
  });
  await test.bridge.start();
  assert.equal(test.reads, 0);
  assert.deepEqual(test.applied, []);
  assert.deepEqual(test.reported, []);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
});

test('LIGHT and DARK are imported exactly, once, without writing the older store', async () => {
  for (const [mode, theme] of [['LIGHT', 'light'], ['DARK', 'dark']] as const) {
    const test = harness({ legacy: async () => resolutionOf(theme, mode) });
    await test.bridge.start();
    assert.deepEqual(test.applied, [theme]);
    assert.deepEqual(test.reported, ['imported']);
    assert.equal(test.storage.values.get(THEME_KEY), theme);
    // Importing is a read. Nothing is written back to the device.
    assert.deepEqual(test.writes, []);
    assert.equal(test.reads, 1);
  }
});

test('SYSTEM and DYNAMIC both become the shared system appearance, and DYNAMIC is never rewritten', async () => {
  for (const mode of ['SYSTEM', 'DYNAMIC'] as const) {
    const test = harness({ legacy: async () => resolutionOf('system', mode) });
    await test.bridge.start();
    assert.deepEqual(test.applied, ['system']);
    assert.deepEqual(test.reported, ['imported']);
    assert.equal(test.storage.values.get(THEME_KEY), 'system');
    assert.deepEqual(test.writes, []);
  }
});

test('missing, blank, corrupt and unreadable settings never become an imported default', async () => {
  for (const health of ['missing', 'blank', 'corrupt'] as const) {
    const test = harness({ legacy: async () => resolutionOf(null, null, health) });
    await test.bridge.start();
    assert.deepEqual(test.applied, []);
    assert.deepEqual(test.reported, []);
    assert.equal(test.storage.values.has(THEME_KEY), false);
  }
  const thrown = harness({
    legacy: async () => {
      throw Object.assign(new Error('LEGACY_SETTINGS_UNAVAILABLE'), { code: 'LEGACY_SETTINGS_UNAVAILABLE' });
    },
  });
  await thrown.bridge.start();
  assert.deepEqual(thrown.applied, []);
  assert.deepEqual(thrown.reported, []);
  assert.equal(thrown.storage.values.has(THEME_KEY), false);
});

/* ----------------------------------------------------------- marker --- */

test('the in-flight marker is parsed strictly or not at all', () => {
  assert.deepEqual(appearance.parseThemeMarker('{"confirmed":"light","target":"dark"}'), {
    confirmed: 'light',
    target: 'dark',
  });
  const rejected = [
    null,
    42,
    '',
    'not json',
    '[]',
    '"dark"',
    'null',
    '{"target":"dark"}',
    '{"confirmed":"light","target":"dark","extra":1}',
    '{"confirmed":"light","target":"dynamic"}',
    '{"confirmed":"","target":"dark"}',
    '{"confirmed":"light","target":null}',
    `{"confirmed":"light","target":"dark","pad":"${'x'.repeat(200)}"}`,
  ];
  for (const raw of rejected) assert.equal(appearance.parseThemeMarker(raw), null, String(raw).slice(0, 40));
  // What it writes is what it accepts.
  assert.deepEqual(
    appearance.parseThemeMarker(appearance.serializeThemeMarker({ target: 'system', confirmed: 'dark' })),
    { target: 'system', confirmed: 'dark' },
  );
});

test('reconciliation commits an exact match, adopts another real choice, and retains the rest', () => {
  const marker = { target: 'dark', confirmed: 'light' } as const;
  assert.deepEqual(appearance.reconcilePendingTheme(marker, resolutionOf('dark', 'DARK')), {
    action: 'commit-target',
    theme: 'dark',
  });
  assert.deepEqual(appearance.reconcilePendingTheme(marker, resolutionOf('light', 'LIGHT')), {
    action: 'adopt-native',
    theme: 'light',
  });
  // A target of System against a device still on DYNAMIC adopts the device's
  // own resolved preference rather than rewriting it.
  assert.deepEqual(
    appearance.reconcilePendingTheme({ target: 'system', confirmed: 'dark' }, resolutionOf('system', 'DYNAMIC')),
    { action: 'adopt-native', theme: 'system' },
  );
  assert.deepEqual(appearance.reconcilePendingTheme(marker, resolutionOf(null, null, 'corrupt')), {
    action: 'retain',
  });
  assert.deepEqual(appearance.reconcilePendingTheme(marker, null), { action: 'retain' });
});

test('a pending marker is reconciled even when a valid local theme exists', async () => {
  const test = harness({
    storage: storageStub({
      [THEME_KEY]: 'light',
      [MARKER_KEY]: appearance.serializeThemeMarker({ target: 'dark', confirmed: 'light' }),
    }),
    legacy: async () => resolutionOf('dark', 'DARK'),
  });
  await test.bridge.start();
  assert.equal(test.reads, 1);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.equal(test.storage.values.has(MARKER_KEY), false);
  assert.deepEqual(test.applied, ['dark']);
  // A launch that simply agrees with the device announces nothing.
  assert.deepEqual(test.reported, []);
});

test('a device holding another real choice makes that choice the confirmed one', async () => {
  const test = harness({
    storage: storageStub({
      [THEME_KEY]: 'light',
      [MARKER_KEY]: appearance.serializeThemeMarker({ target: 'dark', confirmed: 'light' }),
    }),
    legacy: async () => resolutionOf('light', 'LIGHT'),
  });
  await test.bridge.start();
  assert.equal(test.storage.values.get(THEME_KEY), 'light');
  assert.equal(test.storage.values.has(MARKER_KEY), false);
  assert.deepEqual(test.applied, ['light']);
  assert.deepEqual(test.reported, []);
});

test('an unhealthy reconciliation keeps the marker, claims nothing, and puts back the last confirmed theme', async () => {
  const test = harness({
    storage: storageStub({
      [THEME_KEY]: 'light',
      [MARKER_KEY]: appearance.serializeThemeMarker({ target: 'dark', confirmed: 'light' }),
    }),
    legacy: async () => resolutionOf(null, null, 'corrupt'),
  });
  await test.bridge.start();
  assert.equal(test.storage.values.get(THEME_KEY), 'light');
  assert.equal(test.storage.values.has(MARKER_KEY), true);
  assert.deepEqual(test.applied, ['light']);
  assert.deepEqual(test.reported, ['failed']);
});

test('the last confirmed theme is restored on screen even when the local key is gone', async () => {
  const test = harness({
    storage: storageStub({
      [MARKER_KEY]: appearance.serializeThemeMarker({ target: 'dark', confirmed: 'light' }),
    }),
    legacy: async () => resolutionOf(null, null, 'corrupt'),
  });
  await test.bridge.start();
  // Nothing was invented into the store, the marker survives for a retry, and
  // the screen shows the preference that was last actually confirmed.
  assert.equal(test.storage.values.has(THEME_KEY), false);
  assert.equal(test.storage.values.has(MARKER_KEY), true);
  assert.deepEqual(test.applied, ['light']);
  assert.deepEqual(test.reported, ['failed']);
});

test('a marker that is not exactly ours is discarded rather than acted on', async () => {
  const test = harness({
    storage: storageStub({ [THEME_KEY]: 'dark', [MARKER_KEY]: '{"target":"light"}' }),
    legacy: async () => {
      throw new Error('a discarded marker must not trigger a legacy read');
    },
  });
  await test.bridge.start();
  assert.equal(test.storage.values.has(MARKER_KEY), false);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.deepEqual(test.reported, []);
});

/* ------------------------------------------------------ explicit choice --- */

test('an explicit choice paints and saves locally before compatibility sync finishes', async () => {
  const test = harness({ legacy: async () => resolutionOf(null, null, 'missing') });
  const pending = test.bridge.choose('dark');
  assert.deepEqual(test.applied, ['dark']);
  assert.deepEqual(test.reported, ['saving']);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.equal(test.storage.values.has(MARKER_KEY), false);
  await pending;
  assert.deepEqual(test.reported, ['saving', 'saved']);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.equal(test.storage.values.has(MARKER_KEY), false);
  assert.deepEqual(test.writes, ['dark']);
});

test('a refused legacy write keeps the current app theme selected and durable', async () => {
  const test = harness({
    storage: storageStub({ [THEME_KEY]: 'light' }),
    legacy: async () => resolutionOf('light', 'LIGHT'),
    write: async () => {
      throw Object.assign(new Error('LEGACY_THEME_WRITE_FAILED at /data/settings.xml'), {
        code: 'LEGACY_THEME_WRITE_FAILED',
      });
    },
  });
  await test.bridge.start();
  await test.bridge.choose('dark');
  assert.deepEqual(test.applied, ['dark']);
  assert.deepEqual(test.reported, ['saving', 'saved']);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.equal(test.storage.values.has(MARKER_KEY), false);
});

test('under rapid choices the newest local choice stays authoritative when native sync fails', async () => {
  const releases: Array<(failed?: boolean) => void> = [];
  const test = harness({
    storage: storageStub({ [THEME_KEY]: 'system' }),
    legacy: async () => resolutionOf('system', 'SYSTEM'),
    write: () =>
      new Promise((resolveWrite, rejectWrite) => {
        releases.push((failed) =>
          failed
            ? rejectWrite(Object.assign(new Error('LEGACY_THEME_WRITE_FAILED'), { code: 'LEGACY_THEME_WRITE_FAILED' }))
            : resolveWrite({ mode: 'X', changed: true }),
        );
      }),
  });
  await test.bridge.start();

  const light = test.bridge.choose('light');
  const dark = test.bridge.choose('dark');
  assert.deepEqual(test.applied, ['light', 'dark']);

  releases[0]!();
  await light;
  await settled();
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.equal(test.storage.values.has(MARKER_KEY), false);
  assert.deepEqual(test.reported, ['saving', 'saving']);

  releases[1]!(true);
  await dark;
  await settled();
  assert.deepEqual(test.applied, ['light', 'dark']);
  assert.deepEqual(test.reported, ['saving', 'saving', 'saved']);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.equal(test.storage.values.has(MARKER_KEY), false);
});

test('a first-launch compatibility read cannot overwrite a theme chosen while it is pending', async () => {
  let releaseRead!: (resolution: AndroidLegacyThemeResolution) => void;
  const test = harness({
    legacy: () => new Promise((resolveRead) => {
      releaseRead = resolveRead;
    }),
  });

  const starting = test.bridge.start();
  await settled();
  const choosing = test.bridge.choose('dark');
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.deepEqual(test.applied, ['dark']);

  releaseRead(resolutionOf('light', 'LIGHT'));
  await starting;
  await choosing;
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.deepEqual(test.applied, ['dark']);
  assert.deepEqual(test.writes, ['dark']);
});

test('nothing is painted or announced after the surface is gone', async () => {
  const releases: Array<() => void> = [];
  const test = harness({
    legacy: async () => resolutionOf(null, null, 'missing'),
    write: () => new Promise((resolveWrite) => releases.push(() => resolveWrite({ mode: 'X', changed: true }))),
  });
  const pending = test.bridge.choose('dark');
  test.alive.current = false;
  releases[0]!();
  await pending;
  await settled();
  // The choice is still stored, because durability does not depend on a screen.
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.deepEqual(test.applied, ['dark']);
  assert.deepEqual(test.reported, ['saving']);
});

test('reset takes the same explicit System write path a press takes', async () => {
  const test = harness({ legacy: async () => resolutionOf(null, null, 'missing') });
  await test.bridge.choose('system');
  assert.deepEqual(test.writes, ['system']);
  assert.equal(test.storage.values.get(THEME_KEY), 'system');
  assert.deepEqual(test.reported, ['saving', 'saved']);
  // Reset has no second way of writing the same preference.
  assert.match(appearanceSource, /const resetAppearance = useCallback\(\(\) => \{\s*setTheme\('system'\);/);
  assert.match(appearanceSource, /const setTheme = useCallback\(\s*\(next: ThemePreference\) => \{\s*void bridge\.choose\(next\);/);
  assert.match(settingsSource, /resetAppearance\(\);/);
});

/* ---------------------------------------------------- durability edges --- */

test('a local store that refuses the write is never reported as imported', async () => {
  const test = harness({
    storage: storageStub({}, { write: (key) => key === THEME_KEY }),
    legacy: async () => resolutionOf('dark', 'DARK'),
  });
  await test.bridge.start();
  assert.deepEqual(test.applied, ['dark']);
  assert.deepEqual(test.reported, ['unsaved']);
  assert.equal(test.storage.values.has(THEME_KEY), false);
});

test('a refused local store is reported unsaved even if compatibility sync succeeds', async () => {
  const test = harness({
    storage: storageStub({ [THEME_KEY]: 'light' }, { write: (key) => key === THEME_KEY }),
    legacy: async () => resolutionOf('light', 'LIGHT'),
  });
  await test.bridge.start();
  await test.bridge.choose('dark');
  assert.deepEqual(test.reported, ['unsaved']);
  assert.equal(test.storage.values.get(THEME_KEY), 'light');
  assert.equal(test.storage.values.has(MARKER_KEY), false);
});

test('a theme choice no longer depends on publishing a legacy marker', async () => {
  const test = harness({
    storage: storageStub({ [THEME_KEY]: 'light' }, { write: (key) => key === MARKER_KEY }),
    legacy: async () => resolutionOf('light', 'LIGHT'),
  });
  await test.bridge.start();
  await test.bridge.choose('dark');
  assert.deepEqual(test.writes, ['dark']);
  assert.deepEqual(test.applied, ['dark']);
  assert.deepEqual(test.reported, ['saving', 'saved']);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.equal(test.storage.values.has(MARKER_KEY), false);
});

test('an obsolete marker removal failure cannot undo a saved current theme', async () => {
  const test = harness({
    storage: storageStub({ [THEME_KEY]: 'light' }, { remove: (key) => key === MARKER_KEY }),
    legacy: async () => resolutionOf('light', 'LIGHT'),
  });
  await test.bridge.start();
  await test.bridge.choose('dark');
  assert.deepEqual(test.reported, ['saving', 'saved']);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
});

test('Android keeps a local theme when its legacy compatibility bridge is unavailable', async () => {
  const test = harness({
    storage: storageStub({ [THEME_KEY]: 'light' }),
    legacy: null,
    isAndroid: true,
  });
  await test.bridge.start();
  await test.bridge.choose('dark');
  assert.deepEqual(test.applied, ['dark']);
  assert.deepEqual(test.reported, ['saved']);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.equal(test.storage.values.has(MARKER_KEY), false);
});

test('text size paints the Settings surface and persists during the press', () => {
  const root = { dataset: {} as DOMStringMap };
  const storage = storageStub();
  assert.equal(appearance.applyTextScaleImmediately('larger', root as never, storage), true);
  assert.equal(root.dataset.textScale, 'larger');
  assert.equal(storage.values.get('pdfchef.appearance.text-scale.v1'), 'larger');
});

test('the browser and iOS keep the one-store behaviour they already had', async () => {
  const test = harness({ storage: storageStub({ [THEME_KEY]: 'light' }), legacy: null, isAndroid: false });
  await test.bridge.start();
  await test.bridge.choose('dark');
  assert.deepEqual(test.applied, ['dark']);
  assert.deepEqual(test.reported, []);
  assert.equal(test.storage.values.get(THEME_KEY), 'dark');
  assert.equal(test.storage.values.has(MARKER_KEY), false);

  const refused = harness({
    storage: storageStub({ [THEME_KEY]: 'light' }, { write: () => true }),
    legacy: null,
    isAndroid: false,
  });
  await refused.bridge.choose('dark');
  assert.deepEqual(refused.reported, ['unsaved']);
  assert.equal(refused.storage.values.get(THEME_KEY), 'light');
});

/* ---------------------------------------------------------- the surface --- */

test('theme feedback is fixed, plain, and free of anything from the device', () => {
  const block = settingsSource.slice(
    settingsSource.indexOf('const THEME_SYNC_FEEDBACK'),
    settingsSource.indexOf('export const SettingsPage'),
  );
  const keys = [...block.matchAll(/get message\(\) \{ return t\("([^"]+)"\); \}/g)].map((match) => match[1]);
  const messages = keys.map((key) => english[key as keyof typeof english]);
  assert.equal(messages.length, 5);
  for (const message of messages) {
    assert.equal(typeof message, 'string');
    if (typeof message !== 'string') continue;
    assert.match(message, /[.…]$/);
    assert.doesNotMatch(message, /SYSTEM|DYNAMIC|LIGHT|DARK|localStorage|Error|null|undefined|\/|_/);
  }
  // Every state the hook can report has copy, and only that copy.
  for (const state of ['idle', 'saving', 'saved', 'imported', 'failed', 'unsaved']) {
    assert.ok(block.includes(`${state}:`), state);
  }
  assert.match(appearanceSource, /export type ThemeSyncState =[^;]*'unsaved'/);
});

test('the feedback is anchored in the Theme row, in flow, and announced politely', () => {
  const themeRow = settingsSource.slice(
    settingsSource.indexOf('<Row label={t("settings-page.theme.efb52e")} stacked>'),
    settingsSource.indexOf('<Row label={t("settings-page.text.size.d68761")} stacked>'),
  );
  assert.match(themeRow, /role="status" aria-live="polite"/);
  assert.match(themeRow, /<StatusLine tone=\{themeFeedback\.tone\}>/);
  assert.match(themeRow, /chef-enter/);
  // In the row it belongs to: no toast, no overlay, no modal.
  assert.doesNotMatch(themeRow, /fixed|absolute|z-\[|createPortal|Sheet/);
  // The control stays usable while a write is in flight or after one failed.
  assert.doesNotMatch(themeRow, /disabled/);
});
