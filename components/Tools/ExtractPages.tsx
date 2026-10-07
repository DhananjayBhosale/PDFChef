import { t } from '../../services/i18n/core.ts';
import { localizeError } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { PageThumbnail } from '../UI/PageThumbnail';
import { PageRangeSelector } from '../UI/PageRangeSelector';
import { StatusToast } from '../UI/StatusToast';
import { Button } from '../UI/Primitives';
import { ToolHeader, ToolPanel, ToolSelectionBar, ToolShell } from '../UI/ToolLayout';
import { PDFFile, ProcessingStatus } from '../../types';
import { loadDisposablePDFDocument, renderPageAsImage } from '../../services/pdfBrowser';
import { extractPages, getPDFPageCount } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';

const extractedOutputName = (filename: string) => {
  const baseName = filename.replace(/\.pdf$/i, '').trim() || 'document';
  return `${baseName} (extracted).pdf`;
};

export const ExtractPages: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any | null>(null);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [rangePending, setRangePending] = useState(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const fileInspectionRef = useRef(false);
  const activeJobControllerRef = useRef<AbortController | null>(null);
  const totalPages = file?.pageCount ?? 0;
  const selectedPageSet = useMemo(() => new Set(selectedPages), [selectedPages]);
  const canExtract = Boolean(file && totalPages > 0 && selectedPages.length > 0 && !rangePending && !status.isProcessing);

  useEffect(() => () => { activeJobControllerRef.current?.abort(); }, []);

  useEffect(() => {
    let cancelled = false;
    let openedDocument: any | null = null;

    if (file) {
      setLoadingPreviews(true);
      setPreviewError('');
      setPdfDoc(null);
      void loadDisposablePDFDocument(file.file)
        .then((document) => {
          openedDocument = document;
          if (cancelled) {
            if (document?.destroy) void document.destroy();
            return;
          }
          setPdfDoc(document);
          setLoadingPreviews(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error(error);
          setPreviewError(t("extract-pages.the.pages.could.not.be.shown.choose.9884e4"));
          setLoadingPreviews(false);
        });
    } else {
      setPdfDoc(null);
      setLoadingPreviews(false);
      setPreviewError('');
    }

    return () => {
      cancelled = true;
      if (openedDocument?.destroy) void openedDocument.destroy();
    };
  }, [file]);

  const handleFilesSelected = async (files: File[]) => {
    if (status.isProcessing || activeJobControllerRef.current || fileInspectionRef.current || files.length === 0 || !isPdfFile(files[0])) return;
    const selected = files[0];
    setStatus({ isProcessing: false, progress: 0, message: '' });
    fileInspectionRef.current = true;
    try {
      const pageCount = await getPDFPageCount(selected);
      if (pageCount < 1) throw new Error(t("split-pdf.selected.pdf.has.no.pages.3882f9"));
      setSelectedPages([]);
      setRangePending(false);
      setSelectionRevision(0);
      setPdfDoc(null);
      setFile({ id: uuidv4(), file: selected, name: selected.name, size: selected.size, pageCount });
    } catch (error) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: localizeError(error) });
    } finally {
      fileInspectionRef.current = false;
    }
  };

  const reset = () => {
    if (status.isProcessing || activeJobControllerRef.current) return;
    setFile(null);
    setSelectedPages([]);
    setRangePending(false);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  };

  const pagePreviewLoaders = useMemo(() => Array.from({ length: totalPages }, (_, pageIndex) => async () => {
    if (!pdfDoc) throw new Error(t("extract-pages.pdf.is.not.ready.fb76b6"));
    const rendered = await renderPageAsImage(pdfDoc, pageIndex, { format: 'image/jpeg', quality: 0.72, scale: 0.35 });
    return rendered.objectUrl;
  }), [pdfDoc, totalPages]);

  const resetRangeDraft = () => {
    setRangePending(false);
    setSelectionRevision((current) => current + 1);
  };

  const togglePage = (index: number) => {
    if (status.isProcessing) return;
    resetRangeDraft();
    setSelectedPages((prev) => (
      prev.includes(index)
        ? prev.filter((value) => value !== index)
        : [...prev, index].sort((a, b) => a - b)
    ));
  };

  const selectAll = () => {
    if (status.isProcessing) return;
    resetRangeDraft();
    setSelectedPages(Array.from({ length: totalPages }, (_, index) => index));
  };

  const clearSelection = () => {
    if (status.isProcessing) return;
    resetRangeDraft();
    setSelectedPages([]);
  };

  const applyPageRange = (pages: number[]) => {
    if (status.isProcessing) return;
    setSelectedPages(pages);
    setRangePending(false);
  };

  const handleExtract = async () => {
    if (!file || !canExtract || fileInspectionRef.current || activeJobControllerRef.current) return;
    const sourceFile = file;
    const pages = [...selectedPages];
    const controller = new AbortController();
    activeJobControllerRef.current = controller;
    setStatus({ isProcessing: true, progress: 10, message: t("extract-pages.extracting.selected.pages.3ee72b") });
    try {
      const pdfBytes = await extractPages(sourceFile.file, pages, t("split-pdf.pages.to.extract.693228"), controller.signal);
      if (controller.signal.aborted) return;
      setStatus({ isProcessing: true, progress: 90, message: t("extract-pages.preparing.extracted.pdf.c9b02d") });
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        extractedOutputName(sourceFile.name),
        'application/pdf',
      );
      setStatus({ isProcessing: false, progress: 100, message: t("extract-pages.page.extracted.4dfc6c", { count: pages.length }) });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("extract-pages.the.selected.pages.could.not.be.extracted.d4ba78") });
    } finally {
      if (activeJobControllerRef.current === controller) activeJobControllerRef.current = null;
    }
  };

  return (
    <ToolShell width="full" centered={!file}>
      <ToolHeader title={t("extract-pages.extract.pages.1ea574")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mx-auto w-full max-w-3xl">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("extract-pages.choose.a.pdf.to.extract.pages.e82bf1")} />
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-3">
            <ToolPanel className="flex flex-col gap-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  onClick={reset}
                  disabled={status.isProcessing}
                  aria-label={t("extract-pages.choose.another.pdf.9434e3")}
                  className="chef-pressable chef-target -ml-1 grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                >
                  <ArrowLeft aria-hidden size={18} className="rtl:rotate-180" />
                </button>
                <h2 className="chef-filename min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
              </div>

              <PageRangeSelector
                key={`${file.id}-${selectionRevision}`}
                totalPages={totalPages}
                disabled={status.isProcessing}
                onApply={applyPageRange}
                onPendingChange={setRangePending}
              />
              <ToolSelectionBar
                summary={t("extract-pages.of.selected.2d057c", { v0: selectedPages.length, v1: totalPages })}
                actions={[
                  {
                    key: 'select-all',
                    label: t("extract-pages.select.all.1fc9a3"),
                    disabled: status.isProcessing || totalPages === 0 || selectedPages.length === totalPages,
                    onClick: selectAll,
                  },
                  {
                    key: 'clear',
                    label: t("extract-pages.clear.83b12c"),
                    hidden: selectedPages.length === 0,
                    disabled: status.isProcessing,
                    onClick: clearSelection,
                  },
                ]}
              />
            </ToolPanel>

            <Button
              tone="primary"
              block
              busy={status.isProcessing}
              disabled={!canExtract}
              icon={<Download aria-hidden size={18} />}
              onClick={() => void handleExtract()}
            >{t("extract-pages.message.2f2b9d8bc2", { count: selectedPages.length })}</Button>

            {loadingPreviews ? (
              <div className="flex flex-col items-center justify-center gap-2 py-6 text-[var(--text-tertiary)]">
                <Loader2 aria-hidden className="animate-spin" size={24} />
                <p className="text-sm">{t("extract-pages.loading.pages.1b27e2")}</p>
              </div>
            ) : previewError ? (
              <div role="alert" className="px-4 py-4 text-center text-sm font-medium text-[var(--status-danger-text)]">
                {previewError}
              </div>
            ) : totalPages === 0 ? (
              <p className="px-4 py-4 text-center text-sm text-[var(--text-secondary)]">{t("extract-pages.this.pdf.has.no.pages.in.it.8c754b")}</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5">
                {Array.from({ length: totalPages }, (_, index) => (
                  <PageThumbnail
                    key={index}
                    pageIndex={index}
                    loadPreview={pagePreviewLoaders[index]}
                    isSelected={selectedPageSet.has(index)}
                    onToggle={() => togglePage(index)}
                    disabled={status.isProcessing}
                  />
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
