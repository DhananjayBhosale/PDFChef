import { getLocale, isPendingTranslation, t, type TranslationKey } from '../../services/i18n/core.ts';

/**
 * Value phrases for the sentences (plan 2.1). Numbers come from formatters; every
 * phrase is one message owned by one sentence, and every key is written out as a
 * string literal by the tool that owns it (the localization check counts a key as
 * used only when it finds the literal).
 */

type Values = Record<string, string | number>;
/** `t` for a key chosen at run time from a literal key object. */
const tr = t as unknown as (key: TranslationKey, values?: Values) => string;

/**
 * The locale for a number inside `key`'s message: English while that message is still
 * English (pending), so a sentence never mixes English words with Arabic-Indic digits
 * ("T ١٠ pt", r4 mobile-12c; decision 2026-11-13). `t()` does the same for numbers it formats.
 */
const numberLocale = (key: TranslationKey) => (isPendingTranslation(key) ? 'en-US' : getLocale());
const num = (key: TranslationKey, value: number, options?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(numberLocale(key), options).format(value);
/** Percent and degrees have no message of their own: they follow the sentence value messages. */
const VALUE_KEY: TranslationKey = 'sentence.value.points';

/**
 * A tool's page-phrase keys, e.g.
 * `{ all: 'sentence.split.pages.all', single: 'sentence.split.pages.single', … }`.
 * `list` and `selected` are absent where a selection is always one run (Page numbers).
 */
export interface PageKeys {
  /** "the only page" / "all {count} pages" */
  all: TranslationKey;
  /** "page {page}" */
  single: TranslationKey;
  /** "pages {from}–{to}" */
  range: TranslationKey;
  /** "pages {list}" (two or three pages that are not one run) */
  list?: TranslationKey;
  /** "the {count} selected pages" (four or more that are not one run) */
  selected?: TranslationKey;
  /** The word for an empty choice in a "nothing chosen" sentence. */
  none?: TranslationKey;
}

export interface PagesPhrase {
  text: string;
  /** A range or a list of numbers: drawn left to right inside its `<bdi>`. */
  ltr: boolean;
  none: boolean;
}

type ListFormatter = { format: (items: string[]) => string };
const listFormat = (key: TranslationKey, items: string[]): string => {
  const ListFormat = (Intl as unknown as { ListFormat?: new (locale: string, options: object) => ListFormatter }).ListFormat;
  if (!ListFormat) return items.join(', ');
  try {
    return new ListFormat(numberLocale(key), { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
};

/** Sorted, unique, in-range 0-based indices. */
const normalise = (selection: readonly number[], total: number) =>
  [...new Set(selection)].filter((index) => Number.isInteger(index) && index >= 0 && index < total).sort((a, b) => a - b);

/**
 * The page phrase for a selection of 0-based page indices (D6): "all 12 pages",
 * "the only page", "page 4", "pages 2–5", "pages 1 and 3", "pages 1, 3 and 5",
 * "the 5 selected pages". "N of M pages" is not used anywhere.
 */
export const pagesPhrase = (keys: PageKeys, selection: readonly number[], total: number): PagesPhrase => {
  const sorted = normalise(selection, total);
  if (!sorted.length) return { text: keys.none ? tr(keys.none) : '', ltr: false, none: true };
  if (sorted.length === total) return { text: tr(keys.all, { count: total }), ltr: false, none: false };
  if (sorted.length === 1) return { text: tr(keys.single, { page: num(keys.single, sorted[0] + 1) }), ltr: false, none: false };
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (last - first === sorted.length - 1) {
    return { text: tr(keys.range, { from: num(keys.range, first + 1), to: num(keys.range, last + 1) }), ltr: true, none: false };
  }
  if (sorted.length <= 3 && keys.list) {
    const list = keys.list;
    return { text: tr(list, { list: listFormat(list, sorted.map((index) => num(list, index + 1))) }), ltr: true, none: false };
  }
  if (keys.selected) return { text: tr(keys.selected, { count: sorted.length }), ltr: false, none: false };
  if (keys.list) {
    const list = keys.list;
    return { text: tr(list, { list: listFormat(list, sorted.map((index) => num(list, index + 1))) }), ltr: true, none: false };
  }
  return { text: tr(keys.range, { from: num(keys.range, first + 1), to: num(keys.range, last + 1) }), ltr: true, none: false };
};

/** A 1-based inclusive page span (Page numbers' Start / End). */
export const spanPhrase = (keys: PageKeys, start: number, end: number, total: number) =>
  pagesPhrase(keys, Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start - 1 + index), total);

/** Page numbers as a list in the app's language: "2", "2 and 4", "2, 4 and 6". */
export const numberList = (values: readonly number[]) => listFormat(VALUE_KEY, values.map((value) => num(VALUE_KEY, value)));

/**
 * Extract Images (fix round 2, item 6): a picture used on more than one page is saved once, so the
 * ZIP has fewer files than the pages suggest. Says where: "The same picture is used on pages 1–4, so
 * it is saved once." Empty when every picture sits on one page.
 */
export const sharedPictureNote = (images: ReadonlyArray<{ pageNumbers: readonly number[] }>) => {
  const shared = images.filter((image) => new Set(image.pageNumbers).size > 1);
  if (shared.length === 0) return '';
  if (shared.length > 1) return t('extract-images.shared-pictures', { count: shared.length });
  const pages = [...new Set(shared[0].pageNumbers)].sort((a, b) => a - b);
  const last = pages[pages.length - 1];
  const run = last - pages[0] === pages.length - 1;
  return t('extract-images.same-picture', {
    pages: run ? `\u2066${num(VALUE_KEY, pages[0])}–${num(VALUE_KEY, last)}\u2069` : numberList(pages),
  });
};

/** Two whole sentences as one line: no space between them in Chinese and Japanese. */
export const joinSentences = (...sentences: string[]) =>
  sentences.filter(Boolean).join(/^(ja|zh)/.test(getLocale()) ? '' : ' ');

export const percent = (value: number) => num(VALUE_KEY, value / 100, { style: 'percent', maximumFractionDigits: 0 });

export const degrees = (value: number) =>
  num(VALUE_KEY, value, { style: 'unit', unit: 'degree', unitDisplay: 'narrow', maximumFractionDigits: 0 });

export const points = (value: number, digits = 0) =>
  t('sentence.value.points', { value: num('sentence.value.points', Number(value.toFixed(digits)), { maximumFractionDigits: digits }) });

export const times = (value: number) =>
  t('sentence.value.times', { value: num('sentence.value.times', value, { maximumFractionDigits: 2 }) });

export const pair = (first: string, second: string) => t('sentence.value.pair', { first, second });

type Segmenter = new (locale?: string, options?: { granularity: string }) => { segment: (input: string) => Iterable<{ segment: string }> };

/** Cuts user text on grapheme boundaries and adds an ellipsis. */
export const clip = (text: string, max: number) => {
  const Segment = (Intl as unknown as { Segmenter?: Segmenter }).Segmenter;
  const parts = Segment ? [...new Segment(getLocale(), { granularity: 'grapheme' }).segment(text)].map((item) => item.segment) : Array.from(text);
  return parts.length > max ? `${parts.slice(0, max).join('').trimEnd()}…` : text;
};

export const quoted = (text: string, max?: number) => t('sentence.quoted', { text: max ? clip(text, max) : text });

/** Phone 14, desktop 28 characters of user text in a slot. */
export const clipLength = (wide: boolean) => (wide ? 28 : 14);

/** A switch's value in a sentence: "on" / "off". */
export const onOff = (value: boolean) => (value ? t('switch.on') : t('switch.off'));

export type TurnDirection = 'right' | 'left' | 'flip' | 'mixed';

/**
 * What Save will write in Rotate Pages (plan 2.10, line 2): the pages that face a new
 * way and how they face. `rotations` maps a 0-based page index to its turn in degrees,
 * wrapped to (−180, 180] (a right turn then a left one is 0 again and leaves the set).
 * Null when nothing will change.
 */
export const turnOutcome = (rotations: Readonly<Record<number, number>>): { pages: number[]; direction: TurnDirection } | null => {
  const turned = Object.entries(rotations)
    .map(([index, rotation]) => ({ index: Number(index), rotation: (((rotation % 360) + 540) % 360) - 180 }))
    .filter(({ rotation }) => Math.abs(rotation) > 0.05)
    .sort((a, b) => a.index - b.index);
  if (!turned.length) return null;
  const kinds = new Set(turned.map(({ rotation }) => (
    Math.abs(rotation - 90) < 0.05 ? 'right' : Math.abs(rotation + 90) < 0.05 ? 'left' : Math.abs(Math.abs(rotation) - 180) < 0.05 ? 'flip' : 'mixed'
  )));
  const direction = kinds.size === 1 ? ([...kinds][0] as TurnDirection) : 'mixed';
  return { pages: turned.map(({ index }) => index), direction };
};
