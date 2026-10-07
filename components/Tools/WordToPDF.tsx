import { formatPercent } from '../../services/i18n/core.ts';
import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { FileUpload } from '../UI/FileUpload';
import { Badge, Button } from '../UI/Primitives';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { convertDocxToPdf } from '../../services/officeDocument';
import { downloadBytes } from '../../services/pdfShared';
import { shouldWarnForFiles } from '../../services/workspace';
import type { ProcessingStatus } from '../../types';
import { formatBytes } from '../UI/format';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export const WordToPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const activeRun = useRef(0);

  useEffect(() => () => {
    activeRun.current += 1;
  }, []);

  const select = (files: File[]) => {
    const selected = files[0];
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith('.docx')) {
      setStatus({ ...idleStatus(), error: t("word-to-pdf.choose.a.docx.word.file.older.doc.334d2c") });
      return;
    }
    if (
      shouldWarnForFiles([selected]) &&
      !window.confirm(t("word-to-pdf.this.is.a.large.word.file.and.1543cf"))
    ) {
      return;
    }

    activeRun.current += 1;
    setFile(selected);
    setStatus(idleStatus());
  };

  const convert = async () => {
    if (!file) return;
    const runId = activeRun.current + 1;
    activeRun.current = runId;
    setStatus({ isProcessing: true, progress: 5, message: t("word-to-pdf.opening.word.document.fe5d6e") });

    try {
      const bytes = await convertDocxToPdf(file, (current, total) => {
        if (activeRun.current !== runId) throw new DOMException(t("word-to-pdf.operation.cancelled.386cf3"), 'AbortError');
        const progress = Math.round(10 + (current / Math.max(1, total)) * 85);
        setStatus({
          isProcessing: true,
          progress,
          message: t("word-to-pdf.laying.out.paragraph.of.fd57af", { v0: current, v1: total }),
        });
      });
      if (activeRun.current !== runId) return;

      downloadBytes(bytes, `${file.name.replace(/\.docx$/i, '')}.pdf`, 'application/pdf');
      setStatus({ isProcessing: false, progress: 100, message: t("word-to-pdf.pdf.ready.cf5972") });
    } catch (error) {
      if (activeRun.current !== runId || isAbortError(error)) return;
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error && error.message ? localizeError(error) : t("word-to-pdf.word.to.pdf.conversion.failed.2f69fc"),
      });
    }
  };

  const cancel = () => {
    activeRun.current += 1;
    setStatus({ isProcessing: false, progress: 0, message: t("word-to-pdf.conversion.cancelled.nothing.was.saved.44e2e7") });
  };

  const chooseAnother = () => {
    activeRun.current += 1;
    setFile(null);
    setStatus(idleStatus());
  };

  const refusal = Boolean(status.error && /no readable text|does not contain a word document|not a readable word file/i.test(status.error));

  return (
    <ToolShell centered={!file}>
      <ToolHeader title={<>{t("word-to-pdf.word.to.pdf.8d26d0")}<Badge tone="caution" className="align-middle">{t("word-to-pdf.beta.703390")}</Badge></>} />

      <div>
        {!file ? (
          <FileUpload
            onFilesSelected={select}
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            label={t("word-to-pdf.choose.a.docx.word.file.055d87")}
          />
        ) : (
          <section className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
                <FileText aria-hidden size={18} />
              </div>
              <div className="min-w-0">
                <h2 className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
                <p className="type-caption text-[var(--text-tertiary)]">{t("word-to-pdf.message.d3f3b1b69d", { v0: formatBytes(file.size) })}</p>
              </div>
            </div>

            {/* Kept: a user who expects the styled document back would only find
                out after opening the PDF. */}
            <p className="mt-2.5 border-t border-[var(--border-hairline)] pt-2.5 type-footnote text-[var(--text-secondary)]">{t("word-to-pdf.text.and.page.breaks.are.kept.fonts.75cce8")}</p>

            {status.isProcessing && (
              <div role="status" aria-live="polite" className="mt-3 rounded-[var(--radius-field)] border border-blue-200 bg-blue-50 p-3 dark:border-blue-400 dark:bg-blue-500/10">
                <div className="flex items-center justify-between gap-3 text-sm font-semibold text-blue-900 dark:text-blue-100">
                  <span>{status.message || 'Converting…'}</span>
                  <span className="tabular-nums">{formatPercent(status.progress)}</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={t("word-to-pdf.word.to.pdf.progress.1ff4d9")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={status.progress}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950"
                >
                  <div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${status.progress}%` }} />
                </div>
              </div>
            )}

            {status.error && (
              <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200">
                <p className="font-bold">{refusal ? t("word-to-pdf.there.is.nothing.to.convert.16ffb2") : t("word-to-pdf.that.did.not.work.93a203")}</p>
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
                <Button tone="secondary" block onClick={cancel}>{t("word-to-pdf.cancel.19766e")}</Button>
              ) : (
                !refusal && (
                  <Button
                    tone="primary"
                    block
                    className="sm:w-auto"
                    icon={<FileText aria-hidden size={18} />}
                    onClick={() => void convert()}
                  >
                    {status.error ? t("word-to-pdf.try.again.d8b839") : t("word-to-pdf.save.pdf.2462a8")}
                  </Button>
                )
              )}
              <Button
                tone={refusal ? 'primary' : 'secondary'}
                block
                className="sm:w-auto"
                disabled={status.isProcessing}
                onClick={chooseAnother}
              >{t("word-to-pdf.choose.another.8a2bca")}</Button>
            </div>
          </section>
        )}
      </div>

      {!file && status.error && (
        <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-300">
          {status.error}
        </div>
      )}
    </ToolShell>
  );
};
