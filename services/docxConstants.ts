/**
 * Kept apart from the converter so a screen can use them before the converter loads.
 *
 * `NO_EXTRACTABLE_TEXT_MESSAGE` mirrors `NO_EXTRACTABLE_TEXT_MESSAGE` in the Android app
 * (`data/repository/processors/OcrTextToolProcessor.kt`).
 *
 * A .docx whose only content is "no text found" is not a conversion, so both platforms
 * fail instead of handing back a junk file.
 */
export const NO_EXTRACTABLE_TEXT_MESSAGE =
  'This PDF is a scan, so its pages are pictures rather than words. Run Extract Text on it first to make the words readable, then try again.';

export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
