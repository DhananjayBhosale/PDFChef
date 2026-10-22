import english from './en-US.ts';
import { formatMessage, t, type TranslationKey } from './core.ts';
/** Keep diagnostic text stable for existing processing guards; translate only at the UI boundary. */
export class LocalizedError extends Error {
  readonly translationKey: TranslationKey;
  readonly values: Record<string, string | number>;
  readonly translatedValues: Partial<Record<string, TranslationKey>>;
  constructor(key: TranslationKey, values: Record<string, string | number> = {}, translatedValues: Partial<Record<string, TranslationKey>> = {}) {
    super(formatMessage(english[key], values, 'en-US'));
    this.translationKey = key;
    this.values = values;
    this.translatedValues = translatedValues;
  }
}
export function localizeError(error: Error): string {
  if (!(error instanceof LocalizedError)) return pdfProblemMessage(error) ?? error.message;
  const values = { ...error.values };
  for (const [name, key] of Object.entries(error.translatedValues)) {
    if (key) values[name] = translateError(key, {});
  }
  return translateError(error.translationKey, values);
}

/** A PDF problem the reader can fix: a password, a file that is not a PDF, or a file that cannot be read. */
export type PdfProblem = 'locked' | 'notPdf' | 'unreadable';
// Each problem has a message, and a message that names the file for screens that take several.
const problemKeys: Record<PdfProblem, readonly [TranslationKey, TranslationKey]> = {
  locked: ['error.pdfLocked', 'error.pdfLockedNamed'],
  notPdf: ['error.pdfNotPdf', 'error.pdfNotPdfNamed'],
  unreadable: ['error.pdfUnreadable', 'error.pdfUnreadableNamed'],
};

/**
 * pdf.js keeps its exception name across the worker. pdf-lib's errors carry only a message, and
 * it says "is encrypted" for any encrypted file, including one that opens without a password.
 */
export function classifyPdfError(error: unknown): PdfProblem | null {
  if (error instanceof LocalizedError) {
    for (const problem of Object.keys(problemKeys) as PdfProblem[]) {
      if (problemKeys[problem].includes(error.translationKey)) return problem;
    }
    return null;
  }
  if (!error || typeof error !== 'object') return null;
  const { name, message } = error as { name?: unknown; message?: unknown };
  const text = typeof message === 'string' ? message : '';
  if (name === 'PasswordException' || /\bis encrypted\b|No password given|Incorrect Password/i.test(text)) return 'locked';
  if (/No PDF header found|PDF file is empty/.test(text)) return 'notPdf';
  if (name === 'InvalidPDFException' || /Failed to parse PDF document|Invalid PDF structure/.test(text)) return 'unreadable';
  return null;
}

/** The message for a PDF problem the reader can fix, or null when the cause is something else. */
export function pdfProblemMessage(error: unknown): string | null {
  const problem = classifyPdfError(error);
  if (!problem) return null;
  return error instanceof LocalizedError ? localizeError(error) : translateError(problemKeys[problem][0], {});
}

/** What a failed PDF job tells the reader: a cause they can fix, this app's own message, or the screen's fallback. */
export function pdfFailureMessage(error: unknown, fallback: string): string {
  return pdfProblemMessage(error) ?? (error instanceof LocalizedError ? localizeError(error) : fallback);
}

/**
 * A screen's own failure title with the error below it. A PDF problem the reader can fix replaces
 * both, so a locked file is not also told to run Repair PDF.
 */
export function pdfFailureNotice(error: unknown, title: string): { title: string; detail?: string } {
  const problem = pdfProblemMessage(error);
  if (problem) return { title: problem };
  return { title, detail: error instanceof Error && error.message ? localizeError(error) : undefined };
}

/** Names the file a PDF problem belongs to, for a job that works through several files. */
export function namedPdfError(error: unknown, fileName: string): unknown {
  const problem = classifyPdfError(error);
  if (!problem) return error;
  const named = new LocalizedError(problemKeys[problem][1], { v0: fileName });
  named.cause = error;
  return named;
}

/** pdf.js accepts a header anywhere in the first kilobyte. A file with none there was never a PDF. */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const last = Math.min(bytes.length, 1024) - 5;
  for (let index = 0; index <= last; index += 1) {
    if (bytes[index] === 0x25 && bytes[index + 1] === 0x50 && bytes[index + 2] === 0x44
      && bytes[index + 3] === 0x46 && bytes[index + 4] === 0x2d) return true;
  }
  return false;
}

// Planning diagnostics stay unchanged; only the displayed reason uses a catalog key.
const textPlanningReasons = [
  'error.textPlan.emptySource', 'error.textPlan.invalidCoordinates',
  'error.textPlan.missingSourceRun', 'error.textPlan.changedSourceRun',
  'error.textPlan.unmatchedObject', 'error.textPlan.ambiguousObject',
  'error.textPlan.overlappingEdits',
] as const;
export function nativeTextPlanningError(reason: string): LocalizedError {
  const key = textPlanningReasons.find(key => english[key] === reason);
  return new LocalizedError('pdf-native-text-editor.direct.text.edit.failed.c3332b', { v0: reason }, key ? { v0: key } : {});
}
// The constructor already retains a checked catalog key; variables are validated by catalog checks.
const translateError = (key: TranslationKey, values: Record<string, string | number>) =>
  (t as (key: TranslationKey, values: Record<string, string | number>) => string)(key, values);
