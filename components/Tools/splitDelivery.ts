import { t, type TranslationKey } from '../../services/i18n/core.ts';
import type { SeparatePath } from '../../services/saveSeparately.ts';

/**
 * How a Split into several parts is saved (owner decision 2026-11-17): separate PDFs or one ZIP.
 * The ZIP is always the result; this choice decides only what is saved automatically.
 * `'auto'` is the untouched value (overnight debate Q2): it is never written, and
 * `resolveSplitDelivery` turns it into one of the two choices.
 */
export type SplitDelivery = 'auto' | 'separate' | 'zip';
export type SplitDeliveryChoice = Exclude<SplitDelivery, 'auto'>;

export const DEFAULT_SPLIT_DELIVERY: SplitDelivery = 'auto';

/** Above this many parts, an untouched choice saves one ZIP where each part is its own download or share item. */
export const SEPARATE_PARTS_LIMIT = 10;

export const isSplitDelivery = (value: unknown): value is SplitDelivery => value === 'auto' || value === 'separate' || value === 'zip';

/**
 * The choice in effect. A choice the person made wins at any count. Untouched, it is one ZIP when
 * the parts would arrive as more than 10 downloads or share items, and separate PDFs otherwise:
 * a folder, the Android app, and a split by size (count unknown).
 */
export const resolveSplitDelivery = (
  stored: SplitDelivery,
  path: SeparatePath | null,
  partCount: number | null,
): SplitDeliveryChoice => {
  if (stored !== 'auto') return stored;
  if ((path === 'downloads' || path === 'share') && partCount !== null && partCount > SEPARATE_PARTS_LIMIT) return 'zip';
  return 'separate';
};

export interface SplitDeliveryLine {
  /** The sentence frame, with one `{delivery}` slot. */
  template: TranslationKey;
  /** The slot's words for each choice. */
  separate: string;
  zip: string;
}

/**
 * The line under the sentence, or null when there is no choice: the platform cannot save parts
 * one by one (the iOS app), or the split makes one part. A split by size cannot know its part
 * count in advance (`partCount` null), so its line names no number.
 */
export const splitDeliveryLine = (path: SeparatePath | null, partCount: number | null): SplitDeliveryLine | null => {
  if (!path) return null;
  if (partCount === null) {
    return {
      template: 'split.delivery.lineUnknown',
      separate: t('split.delivery.separate.unknown'),
      zip: t('split.delivery.zip.unknown'),
    };
  }
  if (partCount < 2) return null;
  return {
    template: 'split.delivery.line',
    separate: t('split.delivery.separate', { count: partCount }),
    zip: t('split.delivery.zip', { count: partCount }),
  };
};
