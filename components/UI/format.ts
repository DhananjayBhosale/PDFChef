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
  stem = stem.replace(/[\s.]+$/u, '');
  return stem ? `${stem}${extension}` : currentName;
};

/** "Scanned PDF 14 October": says what it is and the day it was made, in the app's language. */
export const datedFileStem = (word: string, date: Date, locale: string): string => {
  // English reads "14 October" rather than the US "October 14".
  const dayMonth = new Intl.DateTimeFormat(locale.startsWith('en') ? 'en-GB' : locale, { day: 'numeric', month: 'long' });
  return `${word} ${dayMonth.format(date)}`;
};

// Android's photo picker hides real names, so the WebView names a photo by its media id
// ("66.png"). A bare number is no name at all.
export const imagePdfOutputName = (filename: string): string => {
  const baseName = filename.replace(/\.[^/.]+$/, '').trim();
  return `${baseName && !/^\d+$/u.test(baseName) ? baseName : 'images'}.pdf`;
};

/** Keep editable names safe for the iOS Files/share handoff and its byte limit. */
export const sanitizeFilenameStem = (value: string): string => {
  let result = '';
  let bytes = 0;
  for (const character of value.replace(/[\\/\0]/g, '-')) {
    const width = new TextEncoder().encode(character).length;
    if (bytes + width > 200) break;
    result += character;
    bytes += width;
  }
  return result;
};
