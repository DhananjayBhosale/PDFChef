import { formatPercent } from '../../services/i18n/core.ts';
import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { AnimatePresence, motion } from 'framer-motion';
import { FileType2 } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { Badge, Button } from '../UI/Primitives';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { PDFFile, ProcessingStatus } from '../../types';
import {
  convertPDFToDocx,
  DOCX_MIME_TYPE,
  NO_EXTRACTABLE_TEXT_MESSAGE,
} from '../../services/docxExport';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { shouldWarnForFiles } from '../../services/workspace';
import { useReleasePdfDocument } from '../../hooks/useReleasePdfDocument';
import { formatBytes } from '../UI/format';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export const PDFToWord: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  useReleasePdfDocument(file?.file);
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const activeRun = useRef(0);

  useEffect(() => () => {
    activeRun.current += 1;
  }, []);

  const handleFilesSelected = (files: File[]) => {
    const selected = files[0];
    if (!selected) return;
    if (!isPdfFile(selected)) {
      setStatus({ ...idleStatus(), error: t("pdfto-word.choose.a.pdf.file.c2a7df") });
      return;
    }
    if (
      shouldWarnForFiles([selected]) &&
      !window.confirm(t("pdfto-word.this.is.a.large.pdf.and.may.848eab"))
    ) {
      return;
    }

    activeRun.current += 1;
    setFile({ id: uuidv4(), file: selected, name: selected.name, size: selected.size });
    setStatus(idleStatus());
  };

  const handleConvert = async () => {
    if (!file) return;
    const runId = activeRun.current + 1;
    activeRun.current = runId;
    setStatus({ isProcessing: true, progress: 5, message: t("pdfto-word.opening.pdf.070f6c") });

    try {
      const blob = await convertPDFToDocx(file.file, (current, total) => {
        if (activeRun.current !== runId) throw new DOMException(t("pdfto-word.operation.cancelled.386cf3"), 'AbortError');
        const progress = total > 0 ? Math.round((current / total) * 90) + 5 : 5;
        setStatus({ isProcessing: true, progress, message: t("pdfto-word.reading.page.of.71ef9b", { v0: current, v1: total }) });
      });
      if (activeRun.current !== runId) return;

      const baseName = file.name.replace(/\.pdf$/i, '') || 'converted';
      downloadBlob(blob, `${baseName}.docx`, DOCX_MIME_TYPE);
      setStatus({ isProcessing: false, progress: 100, message: t("pdfto-word.word.document.ready.a23679") });
    } catch (error) {
      if (activeRun.current !== runId || isAbortError(error)) return;
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error && error.message ? localizeError(error) : t("pdfto-word.pdf.to.word.conversion.failed.90ac9c"),
      });
    }
  };

  const cancelConversion = () => {
    activeRun.current += 1;
    setStatus({ isProcessing: false, progress: 0, message: t("pdfto-word.conversion.cancelled.nothing.was.saved.44e2e7") });
  };

  const chooseAnother = () => {
    activeRun.current += 1;
    setFile(null);
    setStatus(idleStatus());
  };

  const refusal = status.error === NO_EXTRACTABLE_TEXT_MESSAGE;

  return (
    <ToolShell centered={!file}>
      {/* The fidelity limits are stated once, beside the button, not here and
          there. */}
      <ToolHeader title={<>{t("pdfto-word.pdf.to.word.1a1bff")}<Badge tone="caution" className="align-middle">{t("pdfto-word.beta.703390")}</Badge></>} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div key="upload" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf,application/pdf" label={t("pdfto-word.choose.a.pdf.3ba70f")} />
          </motion.div>
        ) : (
          <motion.section
            key="selected"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300">
                <FileType2 aria-hidden size={18} />
              </div>
              <div className="min-w-0">
                <h2 className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
                <p className="type-caption text-[var(--text-tertiary)]">{t("pdfto-word.message.c12a048d6d", { v0: formatBytes(file.size) })}</p>
              </div>
            </div>

            {/* Kept: this is a beta text export, and a user who expects the page
                design back would only find out after opening the .docx. */}
            <p className="mt-2.5 border-t border-[var(--border-hairline)] pt-2.5 type-footnote text-[var(--text-secondary)]">{t("pdfto-word.text.is.exported.fonts.images.tables.and.6094ba")}</p>

            {status.isProcessing && (
              <div role="status" aria-live="polite" className="mt-3 rounded-[var(--radius-field)] border border-cyan-200 bg-cyan-50 p-3 dark:border-cyan-400 dark:bg-cyan-500/10">
                <div className="flex items-center justify-between gap-3 text-sm font-semibold text-cyan-900 dark:text-cyan-100">
                  <span>{status.message || 'Converting…'}</span>
                  <span className="tabular-nums">{formatPercent(status.progress)}</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={t("pdfto-word.pdf.to.word.progress.8b8b51")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={status.progress}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-cyan-100 dark:bg-cyan-950"
                >
                  <div className="h-full rounded-full bg-cyan-600 transition-[width]" style={{ width: `${status.progress}%` }} />
                </div>
              </div>
            )}

            {status.error && (
              <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200">
                <p className="font-bold">{refusal ? t("pdfto-word.there.are.no.words.to.convert.689a27") : t("pdfto-word.that.did.not.work.93a203")}</p>
                <p className="mt-1 leading-relaxed">{status.error}</p>
              </div>
            )}

            {!status.isProcessing && status.message && (
              <p role="status" aria-live="polite" className="mt-3 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                {status.message}
              </p>
            )}

            <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
              {status.isProcessing ? (
                <Button tone="secondary" block onClick={cancelConversion}>{t("pdfto-word.cancel.19766e")}</Button>
              ) : (
                <Button
                  tone="primary"
                  block
                  className="sm:w-auto"
                  icon={<FileType2 aria-hidden size={18} />}
                  onClick={() => void handleConvert()}
                >
                  {status.error ? t("pdfto-word.try.again.d8b839") : t("pdfto-word.save.word.file.document.c3f319")}
                </Button>
              )}
              <Button tone="secondary" block className="sm:w-auto" disabled={status.isProcessing} onClick={chooseAnother}>{t("pdfto-word.choose.another.8a2bca")}</Button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {!file && status.error && (
        <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-300">
          {status.error}
        </div>
      )}
    </ToolShell>
  );
};
