import { formatPercent } from '../../services/i18n/core.ts';
import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { Download, FileSliders } from 'lucide-react';
import { Link } from 'react-router-dom';
import { FileUpload } from '../UI/FileUpload';
import { Badge, Button } from '../UI/Primitives';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import type { PptxPageRotation } from '../../services/officeDocument';
import { downloadBytes } from '../../services/pdfShared';
import { shouldWarnForFiles } from '../../services/workspace';
import type { ProcessingStatus } from '../../types';
import { formatBytes } from '../UI/format';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export const PowerPointToPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [rotation, setRotation] = useState<PptxPageRotation>('keep');
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const activeRun = useRef(0);

  useEffect(() => () => {
    activeRun.current += 1;
  }, []);

  const select = (files: File[]) => {
    const selected = files[0];
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith('.pptx')) {
      setStatus({ ...idleStatus(), error: t("power-point-to-pdf.choose.a.pptx.powerpoint.file.older.ppt.e54210") });
      return;
    }
    if (
      shouldWarnForFiles([selected]) &&
      !window.confirm(t("power-point-to-pdf.this.is.a.large.presentation.and.may.797adf"))
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
    setStatus({ isProcessing: true, progress: 5, message: t("power-point-to-pdf.opening.presentation.0efdbf") });

    try {
      const { convertPptxToPdf } = await import('../../services/officeDocument');
      const bytes = await convertPptxToPdf(file, rotation, (current, total) => {
        if (activeRun.current !== runId) throw new DOMException(t("power-point-to-pdf.operation.cancelled.386cf3"), 'AbortError');
        const progress = Math.round(5 + (current / Math.max(1, total)) * 90);
        setStatus({
          isProcessing: true,
          progress,
          message: t("power-point-to-pdf.rendering.slide.of.f9574b", { v0: current, v1: total }),
        });
      });
      if (activeRun.current !== runId) return;

      downloadBytes(bytes, `${file.name.replace(/\.pptx$/i, '')}.pdf`, 'application/pdf');
      setStatus({ isProcessing: false, progress: 100, message: t("power-point-to-pdf.pdf.ready.cf5972") });
    } catch (error) {
      if (activeRun.current !== runId || isAbortError(error)) return;
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error && error.message ? localizeError(error) : t("power-point-to-pdf.powerpoint.to.pdf.conversion.failed.8ad688"),
      });
    }
  };

  const cancel = () => {
    activeRun.current += 1;
    setStatus({ isProcessing: false, progress: 0, message: t("power-point-to-pdf.conversion.cancelled.nothing.was.saved.44e2e7") });
  };

  const chooseAnother = () => {
    activeRun.current += 1;
    setFile(null);
    setStatus(idleStatus());
  };

  const unsupported = Boolean(status.error && /choose a \.pptx|does not contain any slides|unable to read this powerpoint/i.test(status.error));

  return (
    <ToolShell centered={!file}>
      <ToolHeader title={<>{t("power-point-to-pdf.powerpoint.to.pdf.7f2bc0")}<Badge tone="caution" className="align-middle">{t("power-point-to-pdf.beta.703390")}</Badge></>} />

      <div>
        {!file ? (
          <FileUpload
            onFilesSelected={select}
            accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            label={t("power-point-to-pdf.choose.a.pptx.presentation.b0468b")}
          />
        ) : (
          <section className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300">
                <FileSliders aria-hidden size={18} />
              </div>
              <div className="min-w-0">
                <h2 className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
                <p className="type-caption text-[var(--text-tertiary)]">{t("power-point-to-pdf.message.ee74da6d62", { v0: formatBytes(file.size) })}</p>
              </div>
            </div>

            <fieldset className="mt-3" disabled={status.isProcessing}>
              <legend className="type-footnote font-semibold text-[var(--text-secondary)]">{t("power-point-to-pdf.page.orientation.6a6e01")}</legend>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {([
                  ['keep', t("power-point-to-pdf.keep.183f00"), t("power-point-to-pdf.a.16.9.slide.stays.a.16.57bd28")],
                  ['rotate_clockwise', t("power-point-to-pdf.rotate.c3613b"), t("power-point-to-pdf.turn.pages.without.stretching.or.cropping.9361e1")],
                ] as const).map(([value, label, detail]) => (
                  <label
                    key={value}
                    className={`chef-target flex cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-control)] border px-3 text-sm font-bold transition-colors ${
                      rotation === value
                        ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
                        : 'border-[var(--border-strong)] text-[var(--text-primary)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="rotation"
                      value={value}
                      checked={rotation === value}
                      onChange={() => setRotation(value)}
                      className="sr-only"
                    />
                    <span>{label}</span>
                    <span className="sr-only">{detail}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <p className="mt-2.5 border-t border-[var(--border-hairline)] pt-2.5 type-footnote text-[var(--text-secondary)]">{t("power-point-to-pdf.slides.become.page.images.so.text.is.432ba2")}</p>

            {status.isProcessing && (
              <div role="status" aria-live="polite" className="mt-3 rounded-[var(--radius-field)] border border-orange-200 bg-orange-50 p-3 dark:border-orange-400 dark:bg-orange-500/10">
                <div className="flex items-center justify-between gap-3 text-sm font-semibold text-orange-900 dark:text-orange-100">
                  <span>{status.message || 'Converting…'}</span>
                  <span className="tabular-nums">{formatPercent(status.progress)}</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={t("power-point-to-pdf.powerpoint.to.pdf.progress.9809f6")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={status.progress}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-orange-100 dark:bg-orange-950"
                >
                  <div className="h-full rounded-full bg-orange-500 transition-[width]" style={{ width: `${status.progress}%` }} />
                </div>
              </div>
            )}

            {status.error && (
              <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200">
                <p className="font-bold">{unsupported ? t("power-point-to-pdf.presentation.not.supported.b3641f") : t("power-point-to-pdf.conversion.failed.7e3dcd")}</p>
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
                <Button tone="secondary" block onClick={cancel}>{t("power-point-to-pdf.cancel.19766e")}</Button>
              ) : (
                !unsupported && (
                  <Button
                    tone="primary"
                    block
                    className="sm:w-auto"
                    icon={<Download aria-hidden size={18} />}
                    onClick={() => void convert()}
                  >
                    {status.error ? t("power-point-to-pdf.try.again.d8b839") : t("power-point-to-pdf.save.pdf.2462a8")}
                  </Button>
                )
              )}
              <Button
                tone={unsupported ? 'primary' : 'secondary'}
                block
                className="sm:w-auto"
                disabled={status.isProcessing}
                onClick={chooseAnother}
              >{t("power-point-to-pdf.choose.another.8a2bca")}</Button>
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
