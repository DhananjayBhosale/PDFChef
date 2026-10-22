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
  return formatNumber(bytes / 1024 ** power, {
    style: 'unit', unit: ['byte', 'kilobyte', 'megabyte', 'gigabyte'][power], unitDisplay: 'short',
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short, glanceable timestamp for a list row. */
export const formatTimestamp = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return t('format.unknownTime');
  const date = new Date(value);
  const elapsed = Date.now() - value;

  if (elapsed < MINUTE) return t('format.justNow');
  if (elapsed < HOUR) {
    const minutes = Math.round(elapsed / MINUTE);
    return new Intl.RelativeTimeFormat(getLocale(), { style: 'short' }).format(-minutes, 'minute');
  }
  if (elapsed < DAY) {
    return formatDate(date, { hour: 'numeric', minute: '2-digit' });
  }
  if (elapsed < 7 * DAY) {
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

/** "compress-Invoice.pdf": the tool, then the name the file already had. */
export const toolOutputName = (toolWord: string, sourceName: string, extension: string): string => {
  const stem = sourceName.trim().replace(/\.[^.]*$/u, '').trim();
  return outputName(`${toolWord}-${stem || 'document'}`, extension);
};

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
