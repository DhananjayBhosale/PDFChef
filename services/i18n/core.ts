import english from './en-US.ts';
import { direction, fallbackLocale, isLocale, resolveLocale, type Locale, type LocalePreference } from './locales.ts';
import { pendingTranslation } from './pending.ts';
export type TranslationKey = keyof typeof english;
export type PluralMessage = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Message = string | PluralMessage;
export type Catalog = Record<TranslationKey, Message>;
type Variables<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Variables<Rest> : never;
type MessageText<M> = M extends string ? M : M[keyof M] & string;
type Params<K extends TranslationKey> = Variables<MessageText<typeof english[K]>> | (typeof english[K] extends string ? never : "count");
type Value = string | number;
type Arguments<K extends TranslationKey> = [Params<K>] extends [never] ? [values?: Record<string, Value>] : [values: Record<Params<K>, Value>];
const storageKey = 'pdfchef.locale.v1';
const listeners = new Set<() => void>();
const catalogs = new Map<Locale, Catalog>([['en-US', english]]);
const pending = new Map<Locale, Promise<Catalog>>();
// Vite turns this bounded import into separate locale chunks; Node can also load it in tests.
const importCatalog = (target: Locale): Promise<{ default: Catalog }> => import(`./locales/${target}.ts`);
const numberFormats = new Map<Locale, Intl.NumberFormat>();
const pluralRules = new Map<Locale, Intl.PluralRules>();
let locale: Locale = fallbackLocale;
let catalog: Catalog = english;
let preference: LocalePreference = 'system';
let revision = 0;
let request = 0;
const missing = new Set<string>();
export const getLocale = () => locale;
export const getLocalePreference = () => preference;
export const getLocaleRevision = () => revision;
export const subscribeLocale = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Tells native screens what to follow: "system" while Settings follows the phone, else the
 * chosen language. Waits for the saved choice to load, so a start never sends a stale default. */
export function subscribeNativeLanguage(send: (language: LocalePreference) => void): () => void {
  let sent: LocalePreference | undefined;
  const update = () => { if (revision > 0 && preference !== sent) { sent = preference; send(preference); } };
  update();
  return subscribeLocale(update);
}

function report(message: string) {
  if (import.meta.env?.DEV && !missing.has(message)) { missing.add(message); console.warn(`[i18n] ${message}`); }
}
export function formatMessage(message: Message, values: Record<string, Value>, language: Locale): string {
  if (!numberFormats.has(language)) numberFormats.set(language, new Intl.NumberFormat(language));
  if (typeof message !== 'string' && !pluralRules.has(language)) pluralRules.set(language, new Intl.PluralRules(language));
  const template = typeof message === 'string' ? message : message[pluralRules.get(language)!.select(Number(values.count))] ?? message.other;
  return template.replace(/\{([a-zA-Z]\w*)\}/g, (token, name: string) => {
    const value = values[name];
    if (value === undefined) { report(`Missing variable ${name}`); return token; }
    return typeof value === 'number' ? numberFormats.get(language)!.format(value) : value;
  });
}
// An English message in a right-to-left locale would put its full stop and any trailing punctuation on the
// wrong side of an Arabic sentence. Left-to-right isolates (U+2066 ... U+2069) keep it intact; they are
// invisible and ignored by screen readers.
const LRI = '\u2066';
const PDI = '\u2069';
/** True when `key` still shows English text in the current language. */
export const isPendingTranslation = (key: TranslationKey) => !locale.startsWith('en-') && pendingTranslation.has(key);
/** Attributes for an element that renders a pending message: it reads left to right, in English. */
export const pendingTextProps = (key: TranslationKey): { lang: 'en'; dir: 'ltr' } | undefined =>
  isPendingTranslation(key) ? { lang: 'en', dir: 'ltr' } : undefined;
export function t<K extends TranslationKey>(key: K, ...args: Arguments<K>): string {
  if (!catalog[key]) report(`Missing ${locale}:${key}`);
  // A message still in English formats its numbers and plurals as English too, so a sentence
  // never mixes English words with Arabic-Indic digits ("these ٢ files").
  const englishText = isPendingTranslation(key);
  const text = formatMessage(catalog[key] ?? english[key] ?? key, args[0] ?? {}, englishText ? 'en-US' : locale);
  return direction(locale) === 'rtl' && englishText ? `${LRI}${text}${PDI}` : text;
}
export async function loadCatalog(target: Locale): Promise<Catalog> {
  const cached = catalogs.get(target);
  if (cached) return cached;
  if (target.startsWith('en-')) { catalogs.set(target, english); return english; }
  let promise = pending.get(target);
  if (!promise) {
    promise = importCatalog(target).then(module => {
      const result = module.default;
      for (const key of Object.keys(english) as TranslationKey[]) if (!result[key]) report(`Missing ${target}:${key}`);
      catalogs.set(target, result);
      return result;
    }).finally(() => pending.delete(target));
    pending.set(target, promise);
  }
  return promise;
}
function systemLocale() { return resolveLocale(typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]); }
/** Commit only after the catalog loads. A failed load never changes the saved choice. */
async function activateLocale(target: Locale, next: LocalePreference, persist: boolean): Promise<void> {
  const version = ++request;
  const loaded = await loadCatalog(target);
  if (version !== request) return;
  locale = target; catalog = loaded; preference = next;
  if (persist) { try { localStorage.setItem(storageKey, next); } catch { /* Available for this session even in private storage. */ } }
  if (typeof document !== 'undefined') { document.documentElement.lang = locale; document.documentElement.dir = direction(locale); }
  revision += 1;
  listeners.forEach(listener => listener());
}
export function setLocalePreference(next: LocalePreference, persist = true): Promise<void> {
  return activateLocale(next === 'system' ? systemLocale() : next, next, persist);
}
/** Show authoritative legal copy without changing the selected or saved language. */
export function setTemporaryLocale(target: Locale): Promise<void> {
  return activateLocale(target, preference, false);
}
export async function initializeLocale(): Promise<void> {
  let stored: string | null = null;
  try { stored = localStorage.getItem(storageKey); } catch { /* System preference is the storage-free default. */ }
  const requested = isLocale(stored) ? stored : 'system';
  try { await setLocalePreference(requested, false); }
  catch { await activateLocale(fallbackLocale, requested, false); }
  window.addEventListener('languagechange', () => { if (preference === 'system') void setLocalePreference('system', false).catch(() => {}); });
}
export const formatNumber = (value: number, options?: Intl.NumberFormatOptions) => {
  if (options) return new Intl.NumberFormat(locale, options).format(value);
  if (!numberFormats.has(locale)) numberFormats.set(locale, new Intl.NumberFormat(locale));
  return numberFormats.get(locale)!.format(value);
};
export const formatDate = (value: Date | number, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(value);
export const formatCurrency = (value: number, currency: string) => formatNumber(value, { style: 'currency', currency });
/** UI percentages only. CSS geometry and numeric input values retain their machine format. */
export const formatPercent = (value: number) => formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 0 });
