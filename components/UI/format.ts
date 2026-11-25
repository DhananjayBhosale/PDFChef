import { t, formatNumber, formatDate, getLocale } from '../../services/i18n/core.ts';
import type { ByteCount } from '../../services/domain/workspaceModels';

/**
 * One formatter for every byte count in the product, so a size never reads two
 * ways on two screens. `null` means the store genuinely does not know the value;
 * it is shown as "Unknown", never as zero.
 */
export const formatBytes = (bytes: ByteCount): string => {
  // 1024-based with one decimal, which is what the Android app has always shown
  // and what Compress shows. Two screens reporting the same file as 131.3 KB and
  // 134 KB is a bug report waiting to happen.
  if (bytes === null) return t('format.unknown');
  const power = bytes < 1024 ? 0 : bytes < 1024 ** 2 ? 1 : bytes < 1024 ** 3 ? 2 : 3;
  const digits = power === 0 ? 0 : power === 3 ? 2 : 1;
  // The short byte unit has no plural in English ("0 byte"); the long one does.
  return formatNumber(bytes / 1024 ** power, {
    style: 'unit', unit: ['byte', 'kilobyte', 'megabyte', 'gigabyte'][power], unitDisplay: power === 0 ? 'long' : 'short',
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Short, glanceable timestamp for a list row. */
export const formatTimestamp = (value: number, now = Date.now()): string => {
  if (!Number.isFinite(value) || value <= 0) return t('format.unknownTime');
  const date = new Date(value);
  const elapsed = now - value;

  if (elapsed < MINUTE) return t('format.justNow');
  if (elapsed < HOUR) {
    const minutes = Math.round(elapsed / MINUTE);
    return new Intl.RelativeTimeFormat(getLocale(), { style: 'short' }).format(-minutes, 'minute');
  }
  // Calendar days, not 24-hour spans: a bare time means today, so last night shows its weekday.
  // Rounding absorbs the hour a daylight-saving change adds or removes.
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / DAY);
  if (days === 0) {
    return formatDate(date, { hour: 'numeric', minute: '2-digit' });
  }
  if (days < 7) {
    return formatDate(date, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  return formatDate(date, { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Full timestamp for assistive technology and the detail sheet. */
export const formatTimestampLong = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return t('format.unknownTime');
  return formatDate(value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
};

/**
 * Splits a filename so a long name can wrap on the stem while the extension
 * stays attached and readable. Long names wrap; they are never cut off.
 */
export const splitFilename = (name: string): { stem: string; extension: string } => {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
};

/**
 * A name cut in the middle on one line (the result strip, Read PDF's title): the head gives way
 * first and the tail always shows. The tail is the extension and a few letters before it, and it
 * starts at a space when the cut would fall inside the last word, so "Merge PDF 16 Nov.pdf" keeps
 * " 16 Nov.pdf" whole rather than "6 Nov.pdf", which read as the 6th (pass 5, item 4).
 */
export const middleNameParts = (name: string): { head: string; tail: string } => {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.length - dot : 0;
  let cut = Math.max(0, name.length - Math.max(8, extension + 5));
  // Inside a word: the tail takes the whole word, from the space before it, unless it is long.
  if (cut > 0 && !/\s/u.test(name[cut - 1]) && !/\s/u.test(name[cut])) {
    const space = name.slice(0, cut).search(/\s\S*$/u);
    if (space >= 0 && cut - space <= 8) cut = space;
  }
  // Never between the two halves of one character (an emoji).
  if (cut > 0 && /[\uDC00-\uDFFF]/u.test(name[cut])) cut -= 1;
  return { head: name.slice(0, cut), tail: name.slice(cut) };
};

/** The largest `n` in 0…`max` for which `fits(n)` holds, or -1 (fits grows false as n grows). */
const largestFitting = (max: number, fits: (n: number) => boolean): number => {
  let low = 0;
  let high = max;
  let best = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (fits(middle)) { best = middle; low = middle + 1; } else high = middle - 1;
  }
  return best;
};

/**
 * The name as it fits `room` pixels on one line, cut in the middle with "…", or null when the
 * whole name fits. `width` measures a string in the name's font. The tail of `middleNameParts`
 * stays whole while some of the start fits beside it ("Merge P… 16 Nov.pdf": one letter for a
 * tail of whole words, three otherwise); in less room the start and end of the stem share it, the
 * end from a word's start, and the extension stays ("qa-sa…le.pdf").
 */
export const fitMiddleName = (name: string, room: number, width: (text: string) => number): string | null => {
  if (width(name) <= room) return null;
  const { head, tail } = middleNameParts(name);
  const headChars = Array.from(head);
  const withTail = (count: number) => `${headChars.slice(0, count).join('').trimEnd()}…${tail}`;
  const kept = largestFitting(headChars.length, (count) => width(withTail(count)) <= room);
  // A tail of whole words (a date, a version) stays with one letter of the start beside it.
  if (kept >= Math.min(/^\s/u.test(tail) ? 1 : 3, headChars.length)) return withTail(kept);
  const { stem, extension } = splitFilename(name);
  const stemChars = Array.from(stem);
  const balanced = (count: number) => {
    let end = Math.floor(count / 2);
    // The end starts at a word, never inside one: "…6 Nov" read as the 6th.
    const words = stemChars.slice(-end).join('');
    const space = end && !/\s/u.test(stemChars[stemChars.length - end - 1] ?? ' ') ? words.search(/\s/u) : -1;
    if (space > 0) end -= Array.from(words.slice(0, space)).length;
    return `${stemChars.slice(0, count - end).join('').trimEnd()}…${end ? stemChars.slice(-end).join('') : ''}${extension}`;
  };
  return balanced(Math.max(0, largestFitting(stemChars.length - 1, (count) => width(balanced(count)) <= room)));
};

/**
 * A rename changes the name, never the kind of file. The extension is always kept, so
 * "Report.docx" on a PDF becomes "Report.docx.pdf", a typed ".pdf" is not doubled, and a
 * name with nothing usable left (".pdf", ".", spaces) keeps the current name.
 */
export const renameKeepingExtension = (typed: string, extension: string, currentName: string): string => {
  let stem = sanitizeFilenameStem(typed).trim();
  if (extension && stem.toLowerCase().endsWith(extension.toLowerCase())) stem = stem.slice(0, -extension.length);
  stem = limitLength(stem, filenameStemLimit(extension)).replace(/[\s.]+$/u, '');
  return stem ? `${stem}${extension}` : currentName;
};

/** The longest whole name Android and the native stores accept, in UTF-16 units. */
export const MAXIMUM_FILENAME_LENGTH = 180;

/** How long the part before the extension can be, for a rename field's maxLength. */
export const filenameStemLimit = (extension: string): number =>
  Math.max(1, MAXIMUM_FILENAME_LENGTH - extension.length);

const limitLength = (value: string, limit: number): string => {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
};

/** "13 Oct" in the app's language. Dots are dropped so none sits next to the extension. */
export const shortDayMonth = (date: Date, locale: string): string => {
  if (locale.startsWith('en')) {
    // English reads "13 Oct" everywhere, and every month keeps three letters ("Sep", not "Sept").
    const parts = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' }).formatToParts(date);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('day')} ${part('month')}`;
  }
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date)
    .replace(/\./g, '').replace(/\s+/g, ' ').trim();
};

/** "Scanned PDF 13 Oct": says what it is and the day it was made, in the app's language. */
export const datedFileStem = (word: string, date: Date, locale: string): string =>
  `${word} ${shortDayMonth(date, locale)}`;

// Android's file store refuses a name longer than 180 UTF-16 units, extension included.
const outputName = (stem: string, extension: string): string => {
  let result = '';
  for (const character of sanitizeFilenameStem(stem)) {
    if (result.length + character.length + extension.length + 1 > 180) break;
    result += character;
  }
  return `${result.trim()}.${extension}`;
};

/** "Merge PDF 13 Oct.pdf": for a result that has no single file's name to build on. */
export const datedOutputName = (word: string, extension: string, date = new Date(), locale = getLocale()): string =>
  outputName(datedFileStem(word, date, locale), extension);

/**
 * The first photo's name without its extension ("IMG_2041" from "IMG_2041.jpg"): a PDF made from
 * photos is named after them (owner decision, path to 9). Empty when the name has nothing usable.
 */
export const photoStem = (photoName: string | undefined): string =>
  sanitizeFilenameStem(splitFilename(photoName ?? '').stem).replace(/[\s.]+$/u, '').trim();

/** "IMG_2041.pdf" from the first photo, or "<word> 13 Oct.pdf" when it has no usable name. */
export const photoOutputName = (photoName: string | undefined, word: string): string => {
  const stem = photoStem(photoName);
  return stem ? outputName(stem, 'pdf') : datedOutputName(word, 'pdf');
};

/** "compress-Invoice.pdf": the tool, then the name the file already had. */
export const toolOutputName = (toolWord: string, sourceName: string, extension: string): string => {
  const stem = sourceName.trim().replace(/\.[^.]*$/u, '').trim();
  return outputName(`${toolWord}-${stem || 'document'}`, extension);
};

/** A PDF kept as it came in (Batch Compress could not shrink it): its own name, with ".pdf". */
export const keptPdfName = (sourceName: string): string =>
  outputName(sourceName.trim().replace(/\.pdf$/iu, '').trim() || 'document', 'pdf');

/**
 * Keep editable names safe for the iOS Files/share handoff and its byte limit. Android stores
 * : ? * " < > | as "_", so the app uses "_" too and shows the name the file really has.
 */
export const sanitizeFilenameStem = (value: string): string => {
  let result = '';
  let bytes = 0;
  const safe = value.replace(/[\\/\0]/g, '-').replace(/[\u0001-\u001f\u007f]/g, '').replace(/[:?*"<>|]/g, '_');
  for (const character of safe) {
    const width = new TextEncoder().encode(character).length;
    if (bytes + width > 200) break;
    result += character;
    bytes += width;
  }
  return result;
};
