import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPdfPagePreviews } from '../../services/pdfBrowser';
import {
  extractPages,
  getPDFPageCount,
  splitPDFByMaximumSize,
  splitPDFByPagesPerFile,
  type SplitResult,
} from '../../services/pdfDocument';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { androidExportDirectoryName, androidExportFileName } from '../../services/androidParity';
import { Download, FileText, Loader2, RefreshCw, Scissors } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { PageThumbnail } from '../UI/PageThumbnail';
import { StatusToast } from '../UI/StatusToast';
import { SegmentedControl } from '../UI/Primitives';
import { ToolHeader, ToolPanel, ToolSelectionBar, ToolShell } from '../UI/ToolLayout';
import { formatBytes } from '../UI/format';

type SplitMode = 'pageCount' | 'maximumSize';
type ActiveJob = 'split' | 'extract' | null;

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const SplitPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [splitMode, setSplitMode] = useState<SplitMode>('pageCount');
  const [pagesPerSplit, setPagesPerSplit] = useState('1');
  const [maximumSizeMb, setMaximumSizeMb] = useState('10');
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const [activeJob, setActiveJob] = useState<ActiveJob>(null);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const activeJobControllerRef = useRef<AbortController | null>(null);
  const fileInspectionRef = useRef(false);

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

    setSelectedPages([]);
    setPreviewError('');
    if (!file) {
      setLoadingPreviews(false);
      setPreviews([]);
      return () => {
        cancelled = true;
      };
    }

    setLoadingPreviews(true);
    setPreviews([]);
    getPdfPagePreviews(file.file)
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
        setPreviewError(error instanceof Error && error.message ? error.message : 'Unable to generate page previews.');
        setLoadingPreviews(false);
      });

    return () => {
      cancelled = true;
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
      setStatus({ ...idleStatus(), error: 'Choose a PDF file.' });
      return;
    }

    setStatus(idleStatus());
    fileInspectionRef.current = true;
    try {
      const pageCount = await getPDFPageCount(selected);
      if (pageCount < 1) {
        setStatus({ ...idleStatus(), error: 'Selected PDF has no pages.' });
        return;
      }
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
        error: error instanceof Error && error.message ? error.message : 'Unable to open this PDF.',
      });
    } finally {
      fileInspectionRef.current = false;
    }
  };

  const togglePage = (index: number) => {
    if (status.isProcessing || totalPages <= 0) return;
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
  };

  const parsedPagesPerSplit = Number(pagesPerSplit);
  const parsedMaximumSizeMb = Number(maximumSizeMb);
  const pagesPerSplitError = !pagesPerSplit
    ? 'Enter pages per file.'
    : !Number.isSafeInteger(parsedPagesPerSplit) || parsedPagesPerSplit < 1
      ? 'Pages per file must be a positive whole number.'
      : '';
  const maximumSizeError = !maximumSizeMb
    ? 'Enter a maximum file size in whole MB.'
    : !Number.isSafeInteger(parsedMaximumSizeMb) || parsedMaximumSizeMb < 1
      ? 'Maximum file size must be at least 1 MB.'
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
      downloadBlob(result.blob, `${androidExportDirectoryName(sourceFile.name, 'split_pdfs')}.zip`);
      return;
    }
    downloadBlob(result.blob, androidExportFileName('split', sourceFile.name, 'pdf'), 'application/pdf');
  };

  const reportFailure = (error: unknown, fallback: string, controller: AbortController) => {
    if (activeJobControllerRef.current !== controller) return;
    console.error(error);
    setActiveJob(null);
    setStatus({
      isProcessing: false,
      progress: 0,
      message: '',
      error: error instanceof Error && error.message ? error.message : fallback,
    });
  };

  const cancelJob = () => {
    const controller = activeJobControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setStatus((current) => ({
      ...current,
      isProcessing: true,
      message: activeJob === 'extract' ? 'Cancelling extraction...' : 'Cancelling split...',
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
        ? `Splitting ${parsedPagesPerSplit} page${parsedPagesPerSplit === 1 ? '' : 's'} per file...`
        : `Measuring parts up to ${parsedMaximumSizeMb} MB...`,
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
              message: `Writing part ${current} of ${total}...`,
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
              message: `Measuring page ${current} of ${total}...`,
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
        message: result.partCount === 1 ? 'One split PDF is ready.' : `${result.partCount} split PDFs are ready.`,
      });
    } catch (error) {
      if (activeJobControllerRef.current !== controller) return;
      if (controller.signal.aborted) {
        setActiveJob(null);
        setStatus({ ...idleStatus(), message: 'Split cancelled.' });
      } else {
        reportFailure(error, 'Split failed.', controller);
      }
    } finally {
      if (activeJobControllerRef.current === controller) {
        activeJobControllerRef.current = null;
      }
    }
  };

  const handleExtractSelected = async () => {
    if (!file || !canExtractSelection || activeJobControllerRef.current) return;
    const sourceFile = file;
    const pagesToExtract = [...effectiveSelectedPages];
    const controller = new AbortController();
    activeJobControllerRef.current = controller;
    setActiveJob('extract');
    setStatus({ isProcessing: true, progress: 15, message: 'Extracting selected pages...' });

    try {
      const pdfBytes = await extractPages(
        sourceFile.file,
        pagesToExtract,
        'Pages to extract',
        controller.signal,
      );
      if (controller.signal.aborted || activeJobControllerRef.current !== controller) return;
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        androidExportFileName('extract_pages', sourceFile.name, 'pdf'),
      );
      setActiveJob(null);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: `Extracted ${pagesToExtract.length} ${pagesToExtract.length === 1 ? 'page' : 'pages'}.`,
      });
    } catch (error) {
      if (activeJobControllerRef.current !== controller) return;
      if (controller.signal.aborted) {
        setActiveJob(null);
        setStatus({ ...idleStatus(), message: 'Extraction cancelled.' });
      } else {
        reportFailure(error, 'Extraction failed.', controller);
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
    setStatus(idleStatus());
  };

  // Only the non-obvious consequence survives: more than one part arrives as a
  // single ZIP, not as several PDFs. Everything else the controls already say.
  const footerSummary = splitMode === 'pageCount' && estimatedPartCount > 1
    ? `${estimatedPartCount} PDFs download together in one ZIP.`
    : '';

  return (
    <ToolShell width="full" centered={!file}>

      <ToolHeader title="Split PDF" />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mx-auto max-w-3xl"
          >
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a PDF to split" />
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
                    {totalPages} {totalPages === 1 ? 'page' : 'pages'} · {formatBytes(file.size)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={changeFile}
                  disabled={status.isProcessing}
                  className="chef-pressable chef-hit-y shrink-0 rounded-[var(--radius-pill)] px-2.5 py-1.5 text-sm font-semibold text-[var(--accent-text)] hover:bg-[var(--accent-quiet)] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  Change
                </button>
              </div>
              <ToolSelectionBar
                summary={allPagesIncluded
                  ? `All ${totalPages} pages included`
                  : `${effectiveSelectedPages.length} of ${totalPages} pages included`}
                actions={[
                  {
                    key: 'all-pages',
                    label: 'Use all pages',
                    hidden: allPagesIncluded,
                    disabled: status.isProcessing,
                    onClick: useAllPages,
                  },
                ]}
              />
            </ToolPanel>

            {/* A two-choice method is a strip, not two padded cards with a
                sub-line each: the input below already names what the number
                means, so the hints were saying it twice. */}
            <ToolPanel className="flex flex-col gap-2.5">
              <SegmentedControl
                label="Split method"
                value={splitMode}
                options={[
                  { value: 'pageCount', label: 'Pages per file' },
                  { value: 'maximumSize', label: 'Max file size' },
                ]}
                onChange={(next) => { if (!status.isProcessing) setSplitMode(next as SplitMode); }}
              />
              {splitMode === 'pageCount' ? (
                <label className="block">
                  <span className="type-footnote font-semibold text-[var(--text-secondary)]">Pages per output PDF</span>
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
                  <span className="type-footnote font-semibold text-[var(--text-secondary)]">Maximum file size (MB)</span>
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
                  <span className="type-caption mt-1 block text-[var(--text-tertiary)]">
                    If one page is larger than the limit on its own, compress it first.
                  </span>
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
                      {activeJob === 'extract' ? 'Extracting pages' : 'Processing your PDF'}
                    </p>
                    <p className="truncate text-sm text-[var(--text-secondary)]">{status.message}</p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-[var(--text-secondary)]">{status.progress}%</span>
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
                  {activeJobControllerRef.current?.signal.aborted ? 'Cancelling...' : 'Cancel'}
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
                  <span>Export split PDFs</span>
                </button>
              </div>
            )}
            <section aria-labelledby="split-pages-heading" className="flex flex-col gap-2">
              {/* The selection bar above already states the count. */}
              <h2 id="split-pages-heading" className="text-sm font-semibold text-[var(--text-primary)]">Pages to include</h2>

              {loadingPreviews ? (
                <div role="status" className="flex flex-col items-center justify-center gap-2 py-6 text-[var(--text-tertiary)]">
                  <Loader2 aria-hidden className="animate-spin" size={24} />
                  <p className="text-sm">Generating page previews...</p>
                </div>
              ) : previewError ? (
                <div role="status" className="flex flex-col items-center justify-center px-4 py-6 text-center">
                  <p className="font-semibold text-[var(--text-primary)]">Page previews are unavailable</p>
                  <p className="mt-1 max-w-measure text-sm text-[var(--text-secondary)]">
                    You can still split all pages. {previewError}
                  </p>
                  <button
                    type="button"
                    onClick={() => setPreviewReloadKey((current) => current + 1)}
                    className="chef-pressable chef-target mt-3 flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--accent-rest)]"
                  >
                    <RefreshCw aria-hidden size={17} /> Retry previews
                  </button>
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
                    />
                  ))}
                </div>
              ) : (
                <p className="py-4 text-center text-sm text-[var(--text-secondary)]">No page previews are available.</p>
              )}
            </section>

            {canExtractSelection && (
              <button
                type="button"
                onClick={handleExtractSelected}
                className="chef-pressable chef-target flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 text-sm font-semibold text-[var(--accent-text)] hover:border-[var(--accent-rest)]"
              >
                <Download aria-hidden size={18} />
                Extract {effectiveSelectedPages.length} {effectiveSelectedPages.length === 1 ? 'page' : 'pages'} as one PDF
              </button>
            )}

          </motion.div>
        )}
      </AnimatePresence>

      <StatusToast status={status} />
    </ToolShell>
  );
};
