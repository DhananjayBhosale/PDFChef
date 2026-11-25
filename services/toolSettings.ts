/**
 * Each tool's last settings, kept on this device only (owner decision, 2026-11-14: path to 9,
 * item 5). One record per tool route, one value per setting name, in localStorage.
 *
 * What may be kept is decided here, once, rather than in each tool:
 * - never a password (a name that looks like one is refused, whatever the caller passes);
 * - never anything tied to one file (page ranges, typed page lists, field positions, text taken
 *   from the file). Callers keep those in plain state; this store only takes plain values
 *   (strings, finite numbers, booleans) under 2 kB each, so a document cannot end up here.
 */

export const TOOL_SETTINGS_KEY = 'pdfchef.tool-settings.v1';

type ToolRecord = Record<string, string | number | boolean>;
type Store = Record<string, ToolRecord>;

/** Setting names that are never kept. */
const NEVER = /pass(word|code|phrase)?|pin\b|secret/i;
const MAX_TEXT = 2048;

export const mayRemember = (name: string): boolean => !NEVER.test(name);

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

const readStore = (): Store => {
  const raw = storage()?.getItem(TOOL_SETTINGS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Store : {};
  } catch {
    return {};
  }
};

const plain = (value: unknown): value is string | number | boolean =>
  (typeof value === 'string' && value.length <= MAX_TEXT)
  || (typeof value === 'number' && Number.isFinite(value))
  || typeof value === 'boolean';

/** The kept value of `name` for `tool`, or `fallback` when none is kept or it is not the same kind. */
export const readToolSetting = <T extends string | number | boolean>(tool: string, name: string, fallback: T): T => {
  if (!mayRemember(name)) return fallback;
  const value = readStore()[tool]?.[name];
  return value !== undefined && typeof value === typeof fallback && plain(value) ? value as T : fallback;
};

/** Keeps `value` as the last `name` of `tool`. Refused names and values that are not plain are dropped. */
export const writeToolSetting = (tool: string, name: string, value: unknown): void => {
  const store = storage();
  if (!store || !mayRemember(name) || !plain(value)) return;
  const next = readStore();
  next[tool] = { ...(next[tool] ?? {}), [name]: value };
  try {
    store.setItem(TOOL_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: the setting is simply not kept */
  }
};

/** Forgets every tool's settings (Settings → Reset). */
export const forgetToolSettings = (): void => {
  try {
    storage()?.removeItem(TOOL_SETTINGS_KEY);
  } catch {
    /* blocked storage keeps nothing anyway */
  }
};
