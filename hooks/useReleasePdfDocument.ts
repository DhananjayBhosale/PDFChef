import { useEffect } from 'react';
import { releasePDFDocument } from '../services/pdfBrowser';

/**
 * Closes a file's shared PDF.js document when the screen that opened it switches files or closes.
 *
 * The shared cache keeps one worker and a full copy of the file per document until something
 * destroys it. Tools that only ever read a file once left theirs open for the rest of the session,
 * so every tool visited added a worker that nothing would release before the page reloaded.
 */
export const useReleasePdfDocument = (file: File | null | undefined) => {
  useEffect(() => () => {
    if (file) void releasePDFDocument(file).catch(() => undefined);
  }, [file]);
};
