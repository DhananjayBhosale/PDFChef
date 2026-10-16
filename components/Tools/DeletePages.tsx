import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState, useEffect, useMemo } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFLoadingProgress } from '../UI/PDFLoadingProgress';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPdfPagePreviews, type PdfPreviewProgress } from '../../services/pdfBrowser';
import { deletePagesFromPDF } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { Trash2, Undo2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { StatusToast } from '../UI/StatusToast';
import { Button } from '../UI/Primitives';
import { ToolHeader, ToolPanel, ToolSelectionBar, ToolShell } from '../UI/ToolLayout';
import { parseBoundedPageRange } from '../../services/pageRange';
import { toolOutputName } from '../UI/format';

export const DeletePages: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pagesToDelete, setPagesToDelete] = useState<number[]>([]);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<PdfPreviewProgress | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [rangeInput, setRangeInput] = useState('');
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const totalPages = previews.length || file?.pageCount || 0;
  const pagesToDeleteSet = useMemo(() => new Set(pagesToDelete), [pagesToDelete]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setPreviewProgress(null);

    if (file) {
      setLoadingPreviews(true);
      setPreviewError(null);
      getPdfPagePreviews(file.file, {
        signal: controller.signal,
        onProgress: (progress) => { if (!cancelled) setPreviewProgress(progress); },
      })
        .then(urls => {
          if (cancelled) {
            revokeObjectUrls(urls);
            return;
          }
          setPreviews(urls);
          setLoadingPreviews(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error(error);
          setPreviewError(error instanceof Error ? localizeError(error) : t("delete-pages.the.pages.could.not.be.shown.choose.9884e4"));
          setLoadingPreviews(false);
        });
    } else {
      setPreviews([]);
      setPagesToDelete([]);
      setRangeInput('');
      setSelectionMessage(null);
      setPreviewError(null);
    }

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file]);

  useEffect(() => {
    return () => {
      revokeObjectUrls(previews);
    };
  }, [previews]);

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0) return;
    const f = files[0];
    if (!isPdfFile(f)) return;
    setFile({ id: uuidv4(), file: f, name: f.name, size: f.size });
  };

  const togglePage = (idx: number) => {
    setSelectionMessage(null);
    setPagesToDelete((previous) => {
      if (previous.includes(idx)) return previous.filter((pageIndex) => pageIndex !== idx);
      if (totalPages > 0 && previous.length >= totalPages - 1) {
        setSelectionMessage(t("delete-pages.at.least.one.page.must.remain.in.ba102e"));
        return previous;
      }
      return [...previous, idx].sort((left, right) => left - right);
    });
  };

  const markRange = () => {
    try {
      const requested = parseBoundedPageRange(rangeInput, totalPages);
      const next = new Set([...pagesToDelete, ...requested]);
      if (next.size >= totalPages) {
        setSelectionMessage(t("delete-pages.that.range.would.delete.every.page.at.59f472"));
        return;
      }
      setPagesToDelete([...next].sort((left, right) => left - right));
      setSelectionMessage(t("delete-pages.page.marked.from.the.range.46e48c", { count: requested.length }));
    } catch (error) {
      setSelectionMessage(error instanceof Error ? localizeError(error) : t("delete-pages.enter.a.valid.page.range.b43573"));
    }
  };

  const handleDelete = async () => {
    if (!file || pagesToDelete.length === 0) return;
    if (pagesToDelete.length >= totalPages) {
      setSelectionMessage(t("delete-pages.at.least.one.page.must.remain.in.ba102e"));
      return;
    }
    setStatus({ isProcessing: true, progress: 10, message: t("delete-pages.removing.pages.ea3a94") });
    try {
      const pdfBytes = await deletePagesFromPDF(file.file, pagesToDelete);
      
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        toolOutputName('delete-pages', file.name, 'pdf'),
      );
      setStatus({ isProcessing: false, progress: 100, message: t("delete-pages.trimmed.pdf.ready.fb86b7") });
    } catch (error) {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? localizeError(error) : t("delete-pages.the.pages.could.not.be.removed.try.cdda1c"),
      });
    }
  };

  return (
    <ToolShell width="full" centered={!file}>
      <ToolHeader title={t("delete-pages.delete.pages.7c7be5")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-3xl mx-auto">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("delete-pages.choose.a.pdf.to.delete.pages.638ec0")} />
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-3">
            <ToolPanel className="flex flex-col gap-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  disabled={status.isProcessing}
                  className="chef-pressable chef-target -ml-1 flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
                  aria-label={t("delete-pages.choose.another.pdf.9434e3")}
                >
                  <Undo2 aria-hidden size={18} />
                </button>
                <h2 className="chef-filename min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
              </div>

              {!loadingPreviews && !previewError && totalPages > 0 && (
                <div className="flex items-end gap-2">
                  <label className="min-w-0 flex-1 type-footnote font-semibold text-[var(--text-secondary)]">{t("delete-pages.mark.a.page.range.145bb3")}<input
                      value={rangeInput}
                      onChange={(event) => setRangeInput(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') markRange(); }}
                      placeholder="2,4-6"
                      inputMode="text"
                      maxLength={512}
                      className="chef-field mt-1 h-10 w-full px-3 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={markRange}
                    className="chef-pressable chef-hit-y h-10 shrink-0 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--accent-rest)]"
                  >{t("delete-pages.mark.d7cda0")}</button>
                </div>
              )}

              <ToolSelectionBar
                summary={
                  selectionMessage ??
                  (totalPages > 0 && pagesToDelete.length >= totalPages
                    ? t("delete-pages.at.least.one.page.must.remain.16f6e2")
                    : t("delete-pages.remaining.marked.cd3caf", { v0: totalPages - pagesToDelete.length, v1: pagesToDelete.length }))
                }
                actions={[
                  {
                    key: 'restore',
                    label: t("delete-pages.restore.all.a9c39c"),
                    hidden: pagesToDelete.length === 0,
                    onClick: () => { setPagesToDelete([]); setSelectionMessage(t("delete-pages.all.pages.restored.4c39f1")); },
                  },
                ]}
              />
            </ToolPanel>
            {loadingPreviews && <PDFLoadingProgress progress={previewProgress} />}

            <Button
              tone="primary"
              block
              busy={status.isProcessing}
              disabled={loadingPreviews || pagesToDelete.length === 0 || pagesToDelete.length >= totalPages}
              icon={<Trash2 aria-hidden size={18} />}
              onClick={() => void handleDelete()}
            >{t("delete-pages.save.without.those.pages.3b9676")}</Button>

            {loadingPreviews ? null : previewError ? (
              <div className="flex flex-col items-center gap-2 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] px-4 py-4 text-center">
                <p className="font-semibold text-[var(--status-danger-text)]">{t("delete-pages.the.pages.could.not.be.shown.choose.9884e4")}</p>
                <p className="max-w-measure text-sm text-[var(--text-secondary)]">{previewError}</p>
                <Button tone="secondary" onClick={() => setFile(null)}>{t("delete-pages.choose.another.pdf.9434e3")}</Button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5">
                {previews.map((url, index) => (
                  <button
                    type="button"
                    key={index}
                    onClick={() => togglePage(index)}
                    aria-pressed={pagesToDeleteSet.has(index)}
                    aria-label={t("delete-pages.page.893387", { v0: pagesToDeleteSet.has(index) ? t("delete-pages.restore.a76e13") : t("delete-pages.mark.d7cda0"), v1: index + 1 })}
                    className={`relative rounded-xl text-start transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-canvas)] ${pagesToDeleteSet.has(index) ? 'opacity-60 grayscale scale-[0.98]' : 'hover:-translate-y-1'}`}
                  >
                     <div className={`rounded-lg overflow-hidden border-2 ${pagesToDeleteSet.has(index) ? 'border-rose-500' : 'border-[var(--border-strong)]'}`}>
                        <img src={url} alt={t("delete-pages.page.preview.7f7e5e", { v0: index + 1 })} loading="lazy" decoding="async" className="w-full h-auto" />
                        {pagesToDeleteSet.has(index) && (
                          <div className="absolute inset-0 flex items-center justify-center bg-rose-500/20">
                            <div className="bg-rose-500 text-white p-2 rounded-full"><Trash2 size={24}/></div>
                          </div>
                        )}
                     </div>
                     <div className="tabular mt-1 text-center text-xs text-[var(--text-tertiary)]">{t("delete-pages.message.c140ba4857", { v0: index + 1 })}</div>
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <StatusToast status={status} />
    </ToolShell>
  );
};
