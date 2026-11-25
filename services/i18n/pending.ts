import type { TranslationKey } from './core.ts';

/**
 * Keys whose text is still English in the other languages. Each one is present in every
 * locale catalog and draft with the English message (written by scripts/sync-locale-fallbacks.mjs),
 * so nothing is missing at runtime; this list records what a translator still has to do.
 *
 * - `t()` wraps these messages in Unicode isolates in right-to-left locales (see core.ts).
 * - Take a key off this list when its translation is in the locale file and the draft.
 * - When the list is empty, `node scripts/check-localization.mjs --no-pending` passes.
 *
 * Every entry is a string literal so the localization check can read the list.
 */
export const pendingTranslation: ReadonlySet<TranslationKey> = new Set<TranslationKey>([
]);
