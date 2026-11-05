/** Store identifiers are intentionally separate from BCP 47 application tags. */
export const locales = [
  ['en-US', 'English (United States)', 'en-US', 'en-US', 'ltr'],
  ['en-GB', 'English (United Kingdom)', 'en-GB', 'en-GB', 'ltr'],
  ['en-CA', 'English (Canada)', 'en-CA', 'en-CA', 'ltr'],
  ['fr-CA', 'Français (Canada)', 'fr-CA', 'fr-CA', 'ltr'],
  ['en-AU', 'English (Australia)', 'en-AU', 'en-AU', 'ltr'],
  ['de-DE', 'Deutsch', 'de-DE', 'de-DE', 'ltr'],
  ['fr-FR', 'Français (France)', 'fr-FR', 'fr-FR', 'ltr'],
  ['ja-JP', '日本語', 'ja', 'ja-JP', 'ltr'],
  ['pt-BR', 'Português (Brasil)', 'pt-BR', 'pt-BR', 'ltr'],
  ['ko-KR', '한국어', 'ko', 'ko-KR', 'ltr'],
  ['es-ES', 'Español (España)', 'es-ES', 'es-ES', 'ltr'],
  ['zh-Hans', '简体中文', 'zh-Hans', 'zh-CN', 'ltr'],
  ['it-IT', 'Italiano', 'it', 'it-IT', 'ltr'],
  ['nl-NL', 'Nederlands', 'nl-NL', 'nl-NL', 'ltr'],
  ['pt-PT', 'Português (Portugal)', 'pt-PT', 'pt-PT', 'ltr'],
  ['zh-Hant', '繁體中文', 'zh-Hant', 'zh-TW', 'ltr'],
  ['hi-IN', 'हिन्दी', 'hi', 'hi-IN', 'ltr'],
  ['pl-PL', 'Polski', 'pl', 'pl-PL', 'ltr'],
  ['id-ID', 'Bahasa Indonesia', 'id', 'id', 'ltr'],
  ['es-419', 'Español (Latinoamérica)', 'es-MX', 'es-419', 'ltr'],
  ['ar-SA', 'العربية', 'ar-SA', 'ar', 'rtl'],
  ['tr-TR', 'Türkçe', 'tr', 'tr-TR', 'ltr'],
  ['sv-SE', 'Svenska', 'sv', 'sv-SE', 'ltr'],
  ['da-DK', 'Dansk', 'da', 'da-DK', 'ltr'],
  ['ru-RU', 'Русский', 'ru', 'ru-RU', 'ltr'],
] as const;
export type Locale = typeof locales[number][0];
export type LocalePreference = Locale | 'system';
export const fallbackLocale: Locale = 'en-US';
const supported = new Set<string>(locales.map(([locale]) => locale));
export const isLocale = (value: unknown): value is Locale => typeof value === 'string' && supported.has(value);

const portugalRegions = new Set(['AO', 'CH', 'CV', 'FR', 'GQ', 'GW', 'LU', 'MO', 'MZ', 'PT', 'ST', 'TL']);
export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    let canonical: string;
    try { canonical = Intl.getCanonicalLocales(language)[0]; } catch { continue; }
    if (isLocale(canonical)) return canonical;
    const tag = new Intl.Locale(canonical);
    if (isLocale(tag.baseName)) return tag.baseName;
    if (tag.language === 'zh') return tag.maximize().script === 'Hant' ? 'zh-Hant' : 'zh-Hans';
    if (tag.language === 'fr') return 'fr-FR';
    if (tag.language === 'es') return tag.region && tag.region !== 'ES' ? 'es-419' : 'es-ES';
    // CLDR's parent for these regions is pt-PT, which Android's native screens also follow.
    if (tag.language === 'pt') return portugalRegions.has(tag.region ?? '') ? 'pt-PT' : 'pt-BR';
    const match = locales.find(([locale]) => locale.split('-')[0] === tag.language);
    if (match) return match[0];
  }
  return fallbackLocale;
}
export const direction = (locale: Locale): 'ltr' | 'rtl' => locale === 'ar-SA' ? 'rtl' : 'ltr';
