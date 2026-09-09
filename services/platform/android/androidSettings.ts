import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  AndroidLegacyInspectorClient,
  isAndroidLegacyInspectorAvailable,
} from './androidLegacyInspector.ts';
import type {
  AndroidLegacySettingsSnapshot,
  AndroidLegacyStoreHealth,
} from './legacyCompatibilityContracts.ts';

export const ANDROID_THEME_MODES = Object.freeze(['SYSTEM', 'DYNAMIC', 'LIGHT', 'DARK'] as const);
export type AndroidThemeMode = typeof ANDROID_THEME_MODES[number];

export interface AndroidThemeModeWriteResult {
  readonly mode: AndroidThemeMode;
  readonly changed: boolean;
}

export type SharedAppearanceTheme = 'system' | 'light' | 'dark';

export interface AndroidLegacyThemeResolution {
  readonly health: AndroidLegacyStoreHealth;
  readonly preference: SharedAppearanceTheme | null;
  /** Preserved so DYNAMIC is never silently rewritten as SYSTEM during import. */
  readonly legacyMode: AndroidThemeMode | null;
}

export interface AndroidLegacySettingsWriterNativePlugin {
  setThemeMode(options: { readonly mode: AndroidThemeMode }): Promise<unknown>;
}

const AndroidLegacySettingsWriter =
  registerPlugin<AndroidLegacySettingsWriterNativePlugin>('AndroidLegacySettingsWriter');

export const isAndroidSettingsAvailable = (): boolean =>
  isAndroidLegacyInspectorAvailable()
  && Capacitor.getPlatform() === 'android'
  && Capacitor.isPluginAvailable('AndroidLegacySettingsWriter');

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
};

const isAndroidThemeMode = (value: unknown): value is AndroidThemeMode =>
  typeof value === 'string' && (ANDROID_THEME_MODES as readonly string[]).includes(value);

const parseThemeModeWriteResult = (
  value: unknown,
  requestedMode: AndroidThemeMode,
): AndroidThemeModeWriteResult => {
  if (!isPlainObject(value)) throw new TypeError('Android theme write result must be an own plain object');
  const keys = Reflect.ownKeys(value).sort((left, right) => String(left).localeCompare(String(right)));
  if (keys.length !== 2 || keys[0] !== 'changed' || keys[1] !== 'mode') {
    throw new TypeError('Android theme write result must contain exactly mode and changed');
  }
  if (value.mode !== requestedMode || typeof value.changed !== 'boolean') {
    throw new TypeError('Android theme write result is invalid');
  }
  return Object.freeze({ mode: requestedMode, changed: value.changed });
};

export class AndroidSettingsClient {
  private readonly inspector: AndroidLegacyInspectorClient;
  private readonly writer: AndroidLegacySettingsWriterNativePlugin;

  constructor(
    inspector: AndroidLegacyInspectorClient = new AndroidLegacyInspectorClient(),
    writer: AndroidLegacySettingsWriterNativePlugin = AndroidLegacySettingsWriter,
  ) {
    this.inspector = inspector;
    this.writer = writer;
  }

  async readSettings(): Promise<AndroidLegacySettingsSnapshot> {
    return this.inspector.readSettings();
  }

  async setThemeMode(mode: AndroidThemeMode): Promise<AndroidThemeModeWriteResult> {
    if (!isAndroidThemeMode(mode)) throw new TypeError('invalid Android theme mode');
    return parseThemeModeWriteResult(await this.writer.setThemeMode({ mode }), mode);
  }
}

export const resolveAndroidLegacyTheme = (
  snapshot: AndroidLegacySettingsSnapshot,
): AndroidLegacyThemeResolution => {
  const mode = snapshot.values.theme_mode;
  if ((snapshot.health !== 'ok' && snapshot.health !== 'partial_invalid')
      || !isAndroidThemeMode(mode)) {
    return Object.freeze({
      health: snapshot.health,
      preference: null,
      legacyMode: null,
    });
  }
  const preference: SharedAppearanceTheme = mode === 'LIGHT'
    ? 'light'
    : mode === 'DARK'
      ? 'dark'
      : 'system';
  return Object.freeze({ health: snapshot.health, preference, legacyMode: mode });
};

export const androidThemeModeFor = (preference: SharedAppearanceTheme): AndroidThemeMode => {
  if (preference === 'system') return 'SYSTEM';
  if (preference === 'light') return 'LIGHT';
  if (preference === 'dark') return 'DARK';
  throw new TypeError('invalid shared theme');
};

/**
 * One ordered seam between optimistic shared appearance and the legacy writer.
 * A failed write never blocks a later explicit choice, and concurrent presses
 * cannot finish out of order with the older mode winning last.
 */
export class AndroidThemePersistence {
  private readonly client: Pick<AndroidSettingsClient, 'readSettings' | 'setThemeMode'>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    client: Pick<AndroidSettingsClient, 'readSettings' | 'setThemeMode'> = new AndroidSettingsClient(),
  ) {
    this.client = client;
  }

  async readLegacyTheme(): Promise<AndroidLegacyThemeResolution> {
    return resolveAndroidLegacyTheme(await this.client.readSettings());
  }

  writeTheme(preference: SharedAppearanceTheme): Promise<AndroidThemeModeWriteResult> {
    const mode = androidThemeModeFor(preference);
    const write = this.writeTail.then(() => this.client.setThemeMode(mode));
    this.writeTail = write.then(() => undefined, () => undefined);
    return write;
  }
}

export const createAndroidThemePersistence = (): AndroidThemePersistence | null =>
  // MainActivity registers this fixed plugin before bridge startup. Construct
  // its proxy for every Android shell instead of permanently disabling theme
  // sync when Capacitor's header discovery is briefly unavailable at first
  // render. The appearance layer keeps the current local choice even if the
  // compatibility call itself later fails.
  Capacitor.getPlatform() === 'android' ? new AndroidThemePersistence() : null;
