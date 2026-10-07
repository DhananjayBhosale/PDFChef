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
  if (!(error instanceof LocalizedError)) return error.message;
  const values = { ...error.values };
  for (const [name, key] of Object.entries(error.translatedValues)) {
    if (key) values[name] = translateError(key, {});
  }
  return translateError(error.translationKey, values);
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
