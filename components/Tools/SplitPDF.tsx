import { formatPercent } from '../../services/i18n/core.ts';
import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFLoadingProgress } from '../UI/PDFLoadingProgress';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPdfPagePreviews, type PdfPreviewProgress } from '../../services/pdfBrowser';
import {
  extractPages,
  getPDFPageCount,
  splitPDFByMaximumSize,
  splitPDFByPagesPerFile,
  type SplitResult,
} from '../../services/pdfDocument';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { Download, FileText, Loader2, RefreshCw, Scissors } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { PageThumbnail } from '../UI/PageThumbnail';
import { PageRangeSelector } from '../UI/PageRangeSelector';
import { StatusToast } from '../UI/StatusToast';
import { Button, SegmentedControl } from '../UI/Primitives';
import { ToolHeader, ToolPanel, ToolSelectionBar, ToolShell } from '../UI/ToolLayout';
import { formatBytes, toolOutputName } from '../UI/format';

type SplitMode = 'pageCount' | 'maximumSize';
type ActiveJob = 'split' | 'extract' | null;

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const SplitPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [rangePending, setRangePending] = useState(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [splitMode, setSplitMode] = useState<SplitMode>('pageCount');
  const [pagesPerSplit, setPagesPerSplit] = useState('1');
  const [maximumSizeMb, setMaximumSizeMb] = useState('10');
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const [activeJob, setActiveJob] = useState<ActiveJob>(null);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<PdfPreviewProgress | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const activeJobControllerRef = useRef<AbortController | null>(null);
  const fileInspectionRef = useRef(false);
  const [inspectingFile, setInspectingFile] = useState(false);

  useEffect(() => () => {
    activeJobControllerRef.current?.abort();
  }, []);

  const totalPages = file?.pageCount ?? previews.length;
  const allPageIndices = useMemo(
    () => Array.from({ length: totalPages }, (_, index) => index),
    [totalPages],
  );
  const effectiveSelectedPages = useMemo(() => {
    if (totalPages <= 0) return [];
    if (selectedPages.length === 0) return allPageIndices;
    return selectedPages.filter((index) => index >= 0 && index < totalPages);
  }, [allPageIndices, selectedPages, totalPages]);
  const selectedPageSet = useMemo(() => new Set(effectiveSelectedPages), [effectiveSelectedPages]);
  const allPagesIncluded = totalPages > 0 && effectiveSelectedPages.length === totalPages;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setPreviewProgress(null);

    setPreviewError('');
    if (!file) {
      setLoadingPreviews(false);
      setPreviews([]);
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    setLoadingPreviews(true);
    setPreviews([]);
    getPdfPagePreviews(file.file, {
      signal: controller.signal,
      onProgress: (progress) => { if (!cancelled) setPreviewProgress(progress); },
    })
      .then((urls) => {
        if (cancelled) {
          revokeObjectUrls(urls);
          return;
        }
        setPreviews(urls);
        setLoadingPreviews(false);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to load previews', error);
        setPreviewError(error instanceof Error && error.message ? localizeError(error) : t("split-pdf.the.pages.could.not.be.shown.you.33159a"));
        setLoadingPreviews(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file, previewReloadKey]);

  useEffect(() => {
    return () => {
      revokeObjectUrls(previews);
    };
  }, [previews]);

  const handleFilesSelected = async (files: File[]) => {
    if (
      status.isProcessing ||
      activeJobControllerRef.current ||
      fileInspectionRef.current ||
      files.length === 0
    ) return;
    const selected = files[0];
    if (!isPdfFile(selected)) {
      setStatus({ ...idleStatus(), error: t("split-pdf.choose.a.pdf.file.c2a7df") });
      return;
    }

    setStatus(idleStatus());
    fileInspectionRef.current = true;
    setInspectingFile(true);
    try {
      const pageCount = await getPDFPageCount(selected);
      if (pageCount < 1) {
        setStatus({ ...idleStatus(), error: t("split-pdf.selected.pdf.has.no.pages.3882f9") });
        return;
      }
      setSelectedPages([]);
      setRangePending(false);
      setSelectionRevision(0);
      setFile({
        id: uuidv4(),
        file: selected,
        name: selected.name,
        size: selected.size,
        pageCount,
      });
    } catch (error) {
      console.error(error);
      setStatus({
        ...idleStatus(),
        error: error instanceof Error && error.message ? localizeError(error) : t("split-pdf.unable.to.open.this.pdf.9c2826"),
      });
    } finally {
      fileInspectionRef.current = false;
      setInspectingFile(false);
    }
  };

  const togglePage = (index: number) => {
    if (status.isProcessing || totalPages <= 0) return;
    setRangePending(false);
    setSelectionRevision((current) => current + 1);
    setSelectedPages((current) => {
      const explicitSelection = current.length === 0 ? allPageIndices : current;
      if (explicitSelection.includes(index)) {
        // A split must always include at least one page. Empty is reserved for the Android-compatible
        // meaning of "all pages", so it cannot also represent "no pages".
        if (explicitSelection.length === 1) return explicitSelection;
        return explicitSelection.filter((pageIndex) => pageIndex !== index);
      }
      return [...explicitSelection, index].sort((left, right) => left - right);
    });
  };

  const useAllPages = () => {
    if (status.isProcessing) return;
    setSelectedPages([]);
    setRangePending(false);
    setSelectionRevision((current) => current + 1);
  };

  const applyPageRange = (pages: number[]) => {
    if (status.isProcessing) return;
    setSelectedPages(pages.length === totalPages ? [] : pages);
    setRangePending(false);
  };

  const parsedPagesPerSplit = Number(pagesPerSplit);
  const parsedMaximumSizeMb = Number(maximumSizeMb);
  const pagesPerSplitError = !pagesPerSplit
    ? t("split-pdf.enter.pages.per.file.c0df04")
    : !Number.isSafeInteger(parsedPagesPerSplit) || parsedPagesPerSplit < 1
      ? t("split-pdf.pages.per.file.must.be.a.positive.85ff63")
      : '';
  const maximumSizeError = !maximumSizeMb
    ? t("split-pdf.enter.a.maximum.file.size.in.whole.0ae395")
    : !Number.isSafeInteger(parsedMaximumSizeMb) || parsedMaximumSizeMb < 1
      ? t("split-pdf.maximum.file.size.must.be.at.least.9404a7")
      : '';
  const settingsError = splitMode === 'pageCount' ? pagesPerSplitError : maximumSizeError;
  const estimatedPartCount = !pagesPerSplitError && effectiveSelectedPages.length > 0
    ? Math.ceil(effectiveSelectedPages.length / parsedPagesPerSplit)
    : 0;
  const canExport = Boolean(
    file &&
    totalPages > 0 &&
    effectiveSelectedPages.length > 0 &&
    !settingsError &&
    !rangePending &&
    !status.isProcessing,
  );
  const canExtractSelection = Boolean(
    file &&
    selectedPages.length > 0 &&
    effectiveSelectedPages.length > 0 &&
    effectiveSelectedPages.length < totalPages &&
    !status.isProcessing,
  );

  const deliverSplitResult = (result: SplitResult, sourceFile: PDFFile) => {
    if (result.isArchive) {
      downloadBlob(result.blob, toolOutputName('split', sourceFile.name, 'zip'));
      return;
    }
    downloadBlob(result.blob, toolOutputName('split', sourceFile.name, 'pdf'), 'application/pdf');
  };

  const reportFailure = (error: unknown, fallback: string, controller: AbortController) => {
    if (activeJobControllerRef.current !== controller) return;
    console.error(error);
    setActiveJob(null);
    setStatus({
      isProcessing: false,
      progress: 0,
      message: '',
      error: error instanceof Error && error.message ? localizeError(error) : fallback,
    });
  };

  const cancelJob = () => {
    const controller = activeJobControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setStatus((current) => ({
      ...current,
      isProcessing: true,
      message: activeJob === 'extract' ? t("split-pdf.cancelling.extraction.aeb50e") : t("split-pdf.cancelling.split.9acb39"),
    }));
  };

  const handleExport = async () => {
    if (!file || !canExport || activeJobControllerRef.current) return;
    const sourceFile = file;
    const pageSelection = selectedPages.length === 0 ? [] : [...effectiveSelectedPages];
    const mode = splitMode;
    const controller = new AbortController();
    activeJobControllerRef.current = controller;
    setActiveJob('split');
    setStatus({
      isProcessing: true,
      progress: 5,
      message: mode === 'pageCount'
        ? t("split-pdf.splitting.page.per.file.8e33d8", { count: parsedPagesPerSplit })
        : t("split-pdf.measuring.parts.up.to.mb.ba2367", { v0: parsedMaximumSizeMb }),
    });

    try {
      const result = mode === 'pageCount'
        ? await splitPDFByPagesPerFile(
          sourceFile.file,
          parsedPagesPerSplit,
          pageSelection,
          (current, total) => {
            if (activeJobControllerRef.current !== controller || controller.signal.aborted) return;
            setStatus({
              isProcessing: true,
              progress: Math.max(5, Math.round((current / Math.max(1, total)) * 95)),
              message: t("split-pdf.writing.part.of.cfb774", { v0: current, v1: total }),
            });
          },
          controller.signal,
        )
        : await splitPDFByMaximumSize(
          sourceFile.file,
          parsedMaximumSizeMb,
          pageSelection,
          (current, total) => {
            if (activeJobControllerRef.current !== controller || controller.signal.aborted) return;
            setStatus({
              isProcessing: true,
              progress: Math.max(5, Math.round((current / Math.max(1, total)) * 95)),
              message: t("split-pdf.measuring.page.of.7fd068", { v0: current, v1: total }),
            });
          },
          controller.signal,
        );

      if (controller.signal.aborted || activeJobControllerRef.current !== controller) return;
      deliverSplitResult(result, sourceFile);
      setActiveJob(null);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: t('split.ready', { count: result.partCount }),
      });
    } catch (error) {
      if (activeJobControllerRef.current !== controller) return;
      if (controller.signal.aborted) {
        setActiveJob(null);
        setStatus({ ...idleStatus(), message: t("split-pdf.split.cancelled.14898b") });
      } else {
        reportFailure(error, t("split-pdf.split.failed.81d4dd"), controller);
      }
    } finally {
      if (activeJobControllerRef.current === controller) {
        activeJobControllerRef.current = null;
      }
    }
  };

  const handleExtractSelected = async () => {
    if (!file || !canExtractSelection || rangePending || activeJobControllerRef.current) return;
    const sourceFile = file;
    const pagesToExtract = [...effectiveSelectedPages];
    const controller = new AbortController();
    activeJobControllerRef.current = controller;
    setActiveJob('extract');
    setStatus({ isProcessing: true, progress: 15, message: t("split-pdf.extracting.selected.pages.3ee72b") });

    try {
      const pdfBytes = await extractPages(
        sourceFile.file,
        pagesToExtract,
        t("split-pdf.pages.to.extract.693228"),
        controller.signal,
      );
      if (controller.signal.aborted || activeJobControllerRef.current !== controller) return;
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        toolOutputName('extract', sourceFile.name, 'pdf'),
      );
      setActiveJob(null);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: t("split-pdf.extracted.38699c", { count: pagesToExtract.length }),
      });
    } catch (error) {
      if (activeJobControllerRef.current !== controller) return;
      if (controller.signal.aborted) {
        setActiveJob(null);
        setStatus({ ...idleStatus(), message: t("split-pdf.extraction.cancelled.d9b217") });
      } else {
        reportFailure(error, t("split-pdf.extraction.failed.73c701"), controller);
      }
    } finally {
      if (activeJobControllerRef.current === controller) {
        activeJobControllerRef.current = null;
      }
    }
  };

  const changeFile = () => {
    if (status.isProcessing) return;
    setActiveJob(null);
    setFile(null);
    setSelectedPages([]);
    setRangePending(false);
    setStatus(idleStatus());
  };

  // Only the non-obvious consequence survives: more than one part arrives as a
  // single ZIP, not as several PDFs. Everything else the controls already say.
  const footerSummary = splitMode === 'pageCount' && estimatedPartCount > 1
    ? t("split-pdf.pdfs.download.together.in.one.zip.795019", { v0: estimatedPartCount })
    : '';

  return (
    <ToolShell width="full" centered={!file}>

      <ToolHeader title={t("split-pdf.split.pdf.4f1b84")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mx-auto max-w-3xl"
          >
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("split-pdf.choose.a.pdf.to.split.90f382")} />
            {inspectingFile && <PDFLoadingProgress />}
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, scale: 0.99 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col gap-3"
          >
            <ToolPanel className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]">
                  <FileText aria-hidden size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
                  <p className="type-caption text-[var(--text-tertiary)]">
                    {t('format.pageCount', { count: totalPages })} · {formatBytes(file.size)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={changeFile}
                  disabled={status.isProcessing}
                  className="chef-pressable chef-hit-y shrink-0 rounded-[var(--radius-pill)] px-2.5 py-1.5 text-sm font-semibold text-[var(--accent-text)] hover:bg-[var(--accent-quiet)] disabled:cursor-not-allowed disabled:opacity-55"
                >{t("split-pdf.change.c0bf75")}</button>
              </div>
              <PageRangeSelector
                key={`${file.id}-${selectionRevision}`}
                totalPages={totalPages}
                disabled={status.isProcessing}
                onApply={applyPageRange}
                onPendingChange={setRangePending}
              />
              <ToolSelectionBar
                summary={allPagesIncluded
                  ? t("split-pdf.all.pages.included.6d0a41", { v0: totalPages })
                  : t("split-pdf.of.pages.included.d15033", { v0: effectiveSelectedPages.length, v1: totalPages })}
                actions={[
                  {
                    key: 'all-pages',
                    label: t("split-pdf.use.all.pages.7dd824"),
                    hidden: allPagesIncluded,
                    disabled: status.isProcessing,
                    onClick: useAllPages,
                  },
                ]}
              />
              {selectedPages.length > 0 && effectiveSelectedPages.length < totalPages && (
                <Button
                  tone="secondary"
                  block
                  disabled={!canExtractSelection || rangePending}
                  icon={<Download aria-hidden size={18} />}
                  onClick={() => void handleExtractSelected()}
                >{t("split-pdf.message.eff1a10749", { count: effectiveSelectedPages.length })}</Button>
              )}
            </ToolPanel>
            {loadingPreviews && <PDFLoadingProgress progress={previewProgress} />}

            {/* A two-choice method is a strip, not two padded cards with a
                sub-line each: the input below already names what the number
                means, so the hints were saying it twice. */}
            <ToolPanel className="flex flex-col gap-2.5">
              <SegmentedControl
                label={t("split-pdf.split.method.400c8a")}
                value={splitMode}
                options={[
                  { value: 'pageCount', label: t("split-pdf.pages.per.file.436b5b") },
                  { value: 'maximumSize', label: t("split-pdf.max.file.size.5a4e0f") },
                ]}
                onChange={(next) => { if (!status.isProcessing) setSplitMode(next as SplitMode); }}
              />
              {splitMode === 'pageCount' ? (
                <label className="block">
                  <span className="type-footnote font-semibold text-[var(--text-secondary)]">{t("split-pdf.pages.per.output.pdf.b5ce50")}</span>
                  <input
                    value={pagesPerSplit}
                    onChange={(event) => setPagesPerSplit(event.target.value.replace(/[^\d]/g, ''))}
                    disabled={status.isProcessing}
                    className="chef-field mt-1 h-10 w-full px-3 text-sm disabled:opacity-55"
                    inputMode="numeric"
                    min="1"
                    step="1"
                  />
                </label>
              ) : (
                <label className="block">
                  <span className="type-footnote font-semibold text-[var(--text-secondary)]">{t("split-pdf.maximum.file.size.mb.85e619")}</span>
                  <input
                    value={maximumSizeMb}
                    onChange={(event) => setMaximumSizeMb(event.target.value.replace(/[^\d]/g, ''))}
                    disabled={status.isProcessing}
                    className="chef-field mt-1 h-10 w-full px-3 text-sm disabled:opacity-55"
                    inputMode="numeric"
                    min="1"
                    step="1"
                  />
                  {/* Kept: a single page can exceed the limit on its own, and the
                      only way out is another tool. */}
                  <span className="type-caption mt-1 block text-[var(--text-tertiary)]">{t("split-pdf.if.one.page.is.larger.than.the.098718")}</span>
                </label>
              )}
              {settingsError && <p role="alert" className="type-footnote font-medium text-[var(--status-caution-text)]">{settingsError}</p>}
            </ToolPanel>

            {status.isProcessing ? (
              <div role="status" aria-live="polite" className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3">
                <div className="flex items-center gap-3">
                  <Loader2 aria-hidden className="shrink-0 animate-spin text-[var(--accent-text)]" size={22} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-[var(--text-primary)]">
                      {activeJob === 'extract' ? t("split-pdf.extracting.pages.7e290c") : t("split-pdf.processing.your.pdf.b14adc")}
                    </p>
                    <p className="truncate text-sm text-[var(--text-secondary)]">{status.message}</p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-[var(--text-secondary)]">{formatPercent(status.progress)}</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                  <div className="h-full rounded-full bg-[var(--accent-rest)] transition-[width]" style={{ width: `${status.progress}%` }} />
                </div>
                <button
                  type="button"
                  onClick={cancelJob}
                  disabled={activeJobControllerRef.current?.signal.aborted}
                  className="chef-pressable chef-target mt-2 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--accent-rest)] disabled:opacity-55"
                >
                  {activeJobControllerRef.current?.signal.aborted ? t("split-pdf.cancelling.7b2613") : t("split-pdf.cancel.19766e")}
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {footerSummary && <p className="type-footnote text-[var(--text-secondary)]">{footerSummary}</p>}
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={!canExport}
                  className="chef-pressable chef-target flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 text-sm font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <Scissors aria-hidden size={18} />
                  <span>{t("split-pdf.save.the.split.files.33c422")}</span>
                </button>
              </div>
            )}
            <section aria-labelledby="split-pages-heading" className="flex flex-col gap-2">
              {/* The selection bar above already states the count. */}
              <h2 id="split-pages-heading" className="text-sm font-semibold text-[var(--text-primary)]">{t("split-pdf.pages.to.include.225127")}</h2>

              {loadingPreviews ? null : previewError ? (
                <div role="status" className="flex flex-col items-center justify-center px-4 py-6 text-center">
                  <p className="font-semibold text-[var(--text-primary)]">{t("split-pdf.page.previews.are.unavailable.318997")}</p>
                  <p className="mt-1 max-w-measure text-sm text-[var(--text-secondary)]">{t("split-pdf.message.a68d961425", { v0: previewError })}</p>
                  <button
                    type="button"
                    onClick={() => setPreviewReloadKey((current) => current + 1)}
                    className="chef-pressable chef-target mt-3 flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--accent-rest)]"
                  >
                    <RefreshCw aria-hidden size={17} />{t("split-pdf.retry.previews.7e9483")}</button>
                </div>
              ) : previews.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5">
                  {previews.map((url, index) => (
                    <PageThumbnail
                      key={url}
                      pageIndex={index}
                      imageUrl={url}
                      isSelected={selectedPageSet.has(index)}
                      onToggle={() => togglePage(index)}
                      disabled={status.isProcessing}
                    />
                  ))}
                </div>
              ) : (
                <p className="py-4 text-center text-sm text-[var(--text-secondary)]">{t("split-pdf.the.pages.could.not.be.shown.here.a4b115")}</p>
              )}
            </section>

          </motion.div>
        )}
      </AnimatePresence>

      <StatusToast status={status} />
    </ToolShell>
  );
};
