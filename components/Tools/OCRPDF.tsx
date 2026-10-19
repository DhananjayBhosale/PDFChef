import { formatPercent } from '../../services/i18n/core.ts';
import { LocalizedError, localizeError } from '../../services/i18n/errors.ts';
import english from '../../services/i18n/en-US.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Copy, Download, Loader2 } from 'lucide-react';
import { createWorker, OEM } from 'tesseract.js';
import { FileUpload } from '../UI/FileUpload';
import { SegmentedControl } from '../UI/Primitives';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { SelectablePagePreview, type SelectableTextLine } from '../UI/SelectablePagePreview';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPageSelectableTextLines, loadPDFDocument, loadProtectedPDFDocument, renderPageAsImage } from '../../services/pdfBrowser';
import { downloadBlob, isPdfFile, revokeObjectUrl } from '../../services/pdfShared';
import { NO_EXTRACTABLE_TEXT_MESSAGE } from '../../services/docxExport';
import { textFromSelectionTargets } from '../../services/pdfToolResults';
import { shouldWarnForFiles } from '../../services/workspace';
import { useOpenedPdf, type OpenedPdfRouteState } from '../../hooks/useOpenedPdf';
import { useMonetization, type JobAccessGrant } from '../../hooks/useMonetization';
import { useReleasePdfDocument } from '../../hooks/useReleasePdfDocument';
import { toolOutputName } from '../UI/format';

/**
 * Written by a page that found nothing. It is a placeholder for the on-screen preview only and
 * must never reach the exported .txt — see `EMPTY_PAGE_PLACEHOLDERS` below.
 */
const NO_TEXT_LAYER_PLACEHOLDER = english["ocrpdf.this.page.has.no.words.stored.in.e875a3"];
const NO_OCR_TEXT_PLACEHOLDER = english["ocrpdf.no.words.could.be.read.from.this.8ce507"];
const EMPTY_PAGE_PLACEHOLDERS = new Set<string>([NO_TEXT_LAYER_PLACEHOLDER, NO_OCR_TEXT_PLACEHOLDER]);

type ExtractionMode = 'text-layer' | 'ocr';

interface PreviewAsset {
  url: string;
  width: number;
  height: number;
}

interface OCRPageResult {
  pageNumber: number;
  text: string;
  previewUrl: string | null;
  previewWidth: number;
  previewHeight: number;
  selectionLines: SelectableTextLine[];
}

interface OCRResultMeta {
  processedPages: number;
  totalPages: number;
}

const PAGE_PREVIEW_CONFIG = {
  format: 'image/jpeg' as const,
  quality: 0.82,
  scale: 0.95,
};

const OCR_RENDER_CONFIG = {
  format: 'image/png' as const,
  quality: 0.95,
  scale: 2.0,
};

const LOCAL_OCR_ROOT = '/vendor/tesseract';

const revokePageResults = (results: OCRPageResult[]) => {
  results.forEach((result) => {
    if (result.previewUrl) revokeObjectUrl(result.previewUrl);
  });
};

type OCRWorker = Awaited<ReturnType<typeof createWorker>>;

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

const pageHasExtractedText = (page: OCRPageResult) => {
  const text = page.text.trim();
  return text.length > 0 && !EMPTY_PAGE_PLACEHOLDERS.has(text);
};

const createSelectableLine = (
  id: string,
  text: string,
  left: number,
  top: number,
  width: number,
  height: number,
): SelectableTextLine => ({
  id,
  text,
  left,
  top,
  width: Math.max(1, width),
  height: Math.max(1, height),
  fontSize: Math.max(12, height * 0.82),
});

const buildPdfSelectionLines = (
  pageNumber: number,
  textLines: Array<{ text: string; left: number; top: number; width: number; height: number }>,
) =>
  textLines.map((line, index) =>
    createSelectableLine(
      `pdf-page-${pageNumber}-line-${index}`,
      line.text,
      line.left,
      line.top,
      line.width,
      line.height,
    ),
  );

const buildOcrSelectionLines = (
  pageNumber: number,
  ocrData: any,
  sourceWidth: number,
  sourceHeight: number,
): SelectableTextLine[] => {
  if (sourceWidth <= 0 || sourceHeight <= 0) return [];

  const detectedLines = ocrData?.lines ?? ocrData?.blocks?.flatMap((block: any) =>
    (block.paragraphs ?? []).flatMap((paragraph: any) => paragraph.lines ?? []));
  const entries = Array.isArray(detectedLines) && detectedLines.length > 0
    ? detectedLines.map((line: any, index: number) => ({
        id: `ocr-page-${pageNumber}-line-${index}`,
        text: typeof line?.text === 'string' ? line.text.trim() : '',
        bbox: line?.bbox,
      }))
    : Array.isArray(ocrData?.words) && ocrData.words.length > 0
      ? ocrData.words.map((word: any, index: number) => ({
          id: `ocr-page-${pageNumber}-word-${index}`,
          text: typeof word?.text === 'string' ? word.text.trim() : '',
          bbox: word?.bbox,
        }))
      : [];

  return entries
    .filter((entry) =>
      entry.text &&
      entry.bbox &&
      Number.isFinite(entry.bbox.x0) &&
      Number.isFinite(entry.bbox.y0) &&
      Number.isFinite(entry.bbox.x1) &&
      Number.isFinite(entry.bbox.y1),
    )
    .map((entry) =>
      createSelectableLine(
        entry.id,
        entry.text,
        entry.bbox.x0,
        entry.bbox.y0,
        entry.bbox.x1 - entry.bbox.x0,
        entry.bbox.y1 - entry.bbox.y0,
      ),
    );
};

export const OCRPDF: React.FC = () => {
  useI18n();
  const location = useLocation();
  const { openedPdf, takeProtectedPdfPassword } = useOpenedPdf();
  const [file, setFile] = useState<PDFFile | null>(null);
  useReleasePdfDocument(file?.file);
  const [pageResults, setPageResults] = useState<OCRPageResult[]>([]);
  const [resultMeta, setResultMeta] = useState<OCRResultMeta | null>(null);
  const extractionOperationIdRef = useRef<string | null>(null);
  const extractionGrantRef = useRef<JobAccessGrant | null>(null);
  const { completeJob, runWithExportAccess } = useMonetization();
  const [pageFilter, setPageFilter] = useState('all');
  const [mode, setMode] = useState<ExtractionMode>('text-layer');
  const [ocrMaxPages, setOcrMaxPages] = useState('5');
  const [status, setStatus] = useState<ProcessingStatus & { noticeKind?: 'cancelled' | 'copied' }>({ isProcessing: false, progress: 0, message: '' });
  const pageResultsRef = useRef<OCRPageResult[]>([]);
  const activeRunRef = useRef(0);
  const activeWorkerRef = useRef<OCRWorker | null>(null);
  const protectedPasswordRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      activeRunRef.current += 1;
      protectedPasswordRef.current = null;
      const worker = activeWorkerRef.current;
      activeWorkerRef.current = null;
      if (worker) void Promise.resolve(worker.terminate()).catch(() => undefined);
      revokePageResults(pageResultsRef.current);
    };
  }, []);

  const replacePageResults = (nextResults: OCRPageResult[]) => {
    revokePageResults(pageResultsRef.current);
    pageResultsRef.current = nextResults;
    setPageResults(nextResults);
  };

  const invalidateActiveRun = () => {
    activeRunRef.current += 1;
    const worker = activeWorkerRef.current;
    activeWorkerRef.current = null;
    if (worker) void Promise.resolve(worker.terminate()).catch(() => undefined);
  };

  const clearExtraction = () => {
    invalidateActiveRun();
    extractionOperationIdRef.current = null;
    extractionGrantRef.current = null;
    replacePageResults([]);
    setResultMeta(null);
    setPageFilter('all');
    protectedPasswordRef.current = null;
    setFile(null);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  };

  /**
   * The page has no text layer to export. Re-run the same file through OCR
   * rather than sending the reader back to the picker, clearing the refusal
   * results first so nothing stale is shown mid-run.
   */
  const switchToOcr = () => {
    if (!file) return;
    invalidateActiveRun();
    replacePageResults([]);
    setResultMeta(null);
    setPageFilter('all');
    setMode('ocr');
    void runExtraction(file, 'ocr');
  };

  const createPagePreview = async (pdfDoc: any, pageIndex: number): Promise<PreviewAsset | null> => {
    try {
      const rendered = await renderPageAsImage(pdfDoc, pageIndex, PAGE_PREVIEW_CONFIG);
      return {
        url: rendered.objectUrl,
        width: rendered.width,
        height: rendered.height,
      };
    } catch (error) {
      console.error('Preview generation failed', error);
      return null;
    }
  };

  const extractTextLayer = async (inputFile: File, runId: number, protectedPassword: string | null) => {
    const pdfDoc = protectedPassword === null
      ? await loadPDFDocument(inputFile)
      : await loadProtectedPDFDocument(inputFile, protectedPassword);
    if (activeRunRef.current !== runId) throw new DOMException(t("ocrpdf.operation.cancelled.386cf3"), 'AbortError');
    const totalPages = pdfDoc.numPages || 0;
    if (totalPages < 1) throw new Error(t("ocrpdf.selected.pdf.has.no.pages.3882f9"));
    const nextResults: OCRPageResult[] = [];

    try {
      for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
        if (activeRunRef.current !== runId) throw new DOMException(t("ocrpdf.operation.cancelled.386cf3"), 'AbortError');
        setStatus({
          isProcessing: true,
          progress: Math.max(5, Math.round(5 + (pageIndex / totalPages) * 90)),
          message: t("ocrpdf.reading.page.of.71ef9b", { v0: pageIndex + 1, v1: totalPages }),
        });

        const [preview, textLines] = await Promise.all([
          createPagePreview(pdfDoc, pageIndex),
          getPageSelectableTextLines(pdfDoc, pageIndex, PAGE_PREVIEW_CONFIG.scale),
        ]);
        if (activeRunRef.current !== runId) {
          if (preview?.url) revokeObjectUrl(preview.url);
          throw new DOMException(t("ocrpdf.operation.cancelled.386cf3"), 'AbortError');
        }

        const selectionLines = buildPdfSelectionLines(pageIndex + 1, textLines);
        const pageText = textFromSelectionTargets(selectionLines) || NO_TEXT_LAYER_PLACEHOLDER;

        nextResults.push({
          pageNumber: pageIndex + 1,
          text: pageText,
          previewUrl: preview?.url ?? null,
          previewWidth: preview?.width ?? 0,
          previewHeight: preview?.height ?? 0,
          selectionLines,
        });
      }
    } catch (error) {
      revokePageResults(nextResults);
      throw error;
    }

    if (activeRunRef.current !== runId) {
      revokePageResults(nextResults);
      throw new DOMException(t("ocrpdf.operation.cancelled.386cf3"), 'AbortError');
    }
    replacePageResults(nextResults);
    setResultMeta({ processedPages: totalPages, totalPages });
  };

  const extractWithOCR = async (inputFile: File, runId: number, protectedPassword: string | null) => {
    const pdfDoc = protectedPassword === null
      ? await loadPDFDocument(inputFile)
      : await loadProtectedPDFDocument(inputFile, protectedPassword);
    if (activeRunRef.current !== runId) throw new DOMException(t("ocrpdf.operation.cancelled.386cf3"), 'AbortError');
    const totalPages = pdfDoc.numPages || 0;
    if (totalPages < 1) throw new Error(t("ocrpdf.selected.pdf.has.no.pages.3882f9"));
    const limit = Math.max(1, Math.min(totalPages, Number(ocrMaxPages) || 1));
    const worker = await createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${LOCAL_OCR_ROOT}/worker.min.js`,
      corePath: `${LOCAL_OCR_ROOT}/core`,
      langPath: `${LOCAL_OCR_ROOT}/lang`,
      // Android asset packaging strips .gz; use the same uncompressed URL everywhere.
      gzip: false,
    });
    if (activeRunRef.current !== runId) {
      await worker.terminate();
      throw new DOMException(t("ocrpdf.operation.cancelled.386cf3"), 'AbortError');
    }
    activeWorkerRef.current = worker;
    const nextResults: OCRPageResult[] = [];

    try {
      for (let pageIndex = 0; pageIndex < limit; pageIndex += 1) {
        if (activeRunRef.current !== runId) throw new DOMException(t("ocrpdf.operation.cancelled.386cf3"), 'AbortError');
        setStatus({
          isProcessing: true,
          progress: Math.max(5, Math.round(5 + (pageIndex / limit) * 90)),
          message: t("ocrpdf.running.ocr.on.page.of.108941", { v0: pageIndex + 1, v1: limit }),
        });

        const rendered = await renderPageAsImage(pdfDoc, pageIndex, OCR_RENDER_CONFIG);

        try {
          if (activeRunRef.current !== runId) throw new DOMException(t("ocrpdf.operation.cancelled.386cf3"), 'AbortError');
          const result = await worker.recognize(rendered.objectUrl, {}, { text: true, blocks: true });
          if (activeRunRef.current !== runId) throw new DOMException(t("ocrpdf.operation.cancelled.386cf3"), 'AbortError');
          const selectionLines = buildOcrSelectionLines(pageIndex + 1, result.data, rendered.width, rendered.height);
          const pageText = result.data.text?.trim() || textFromSelectionTargets(selectionLines) || NO_OCR_TEXT_PLACEHOLDER;

          nextResults.push({
            pageNumber: pageIndex + 1,
            text: pageText,
            previewUrl: rendered.objectUrl,
            previewWidth: rendered.width,
            previewHeight: rendered.height,
            selectionLines,
          });
        } catch (error) {
          revokeObjectUrl(rendered.objectUrl);
          throw error;
        }
      }
    } catch (error) {
      revokePageResults(nextResults);
      throw error;
    } finally {
      if (activeWorkerRef.current === worker) activeWorkerRef.current = null;
      try {
        await worker.terminate();
      } catch {
        // Cancel may already have terminated this worker.
      }
    }

    if (activeRunRef.current !== runId) {
      revokePageResults(nextResults);
      throw new DOMException(t("ocrpdf.operation.cancelled.386cf3"), 'AbortError');
    }
    replacePageResults(nextResults);
    setResultMeta({ processedPages: limit, totalPages });
  };

  const runExtraction = async (
    selectedFile: PDFFile,
    modeOverride?: ExtractionMode,
    protectedPassword = protectedPasswordRef.current,
  ) => {
    const runId = activeRunRef.current + 1;
    activeRunRef.current = runId;
    const extractionMode = modeOverride ?? mode;
    const operationId = uuidv4();
    extractionOperationIdRef.current = operationId;
    extractionGrantRef.current = null;

    replacePageResults([]);
    setResultMeta(null);
    setPageFilter('all');
    setStatus({
      isProcessing: true,
      progress: 5,
      message: extractionMode === 'ocr' ? t("ocrpdf.getting.ready.to.read.the.pages.on.ceb774") : t("ocrpdf.opening.the.pdf.c4c2f5"),
    });

    try {
      if (extractionMode === 'ocr') {
        await extractWithOCR(selectedFile.file, runId, protectedPassword);
      } else {
        await extractTextLayer(selectedFile.file, runId, protectedPassword);
      }
      if (activeRunRef.current !== runId) return;

      // The extraction result is already on screen at this point. If the native
      // bridge cannot answer, keep that result visible but treat every export as
      // a preview until access can be unlocked.
      const grant = await completeJob(operationId).catch(() => 'preview-only' as const);
      if (activeRunRef.current !== runId) return;
      extractionGrantRef.current = grant;

      setStatus({ isProcessing: false, progress: 100, message: t("ocrpdf.done.the.words.are.below.f67bb8") });
    } catch (error) {
      if (activeRunRef.current !== runId || isAbortError(error)) return;
      replacePageResults([]);
      setResultMeta(null);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: extractionMode === 'ocr'
          ? t("ocrpdf.the.words.could.not.be.read.from.1c2bd4")
          : error instanceof LocalizedError
            ? localizeError(error)
            : t("ocrpdf.the.words.could.not.be.read.from.f9fba8"),
      });
    }
  };

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0) return;
    const selected = files[0];
    if (!isPdfFile(selected)) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("ocrpdf.choose.a.pdf.file.c2a7df") });
      return;
    }
    const routeState = location.state as OpenedPdfRouteState | null;
    const matchesOpenedPdfHandoff = Boolean(
      routeState?.useOpenedPdf
      && openedPdf
      && routeState.openedPdfId === openedPdf.id
      && selected === openedPdf.file,
    );
    const stagedPassword = matchesOpenedPdfHandoff && openedPdf
      ? takeProtectedPdfPassword(openedPdf.id)
      : null;

    if (
      shouldWarnForFiles([selected]) &&
      !window.confirm(t("ocrpdf.this.is.a.large.pdf.and.may.848eab"))
    ) {
      protectedPasswordRef.current = null;
      return;
    }

    if (matchesOpenedPdfHandoff && openedPdf) {
      if (stagedPassword !== null) protectedPasswordRef.current = stagedPassword;
    } else {
      protectedPasswordRef.current = null;
    }

    const nextFile = { id: uuidv4(), file: selected, name: selected.name, size: selected.size };
    setFile(nextFile);
    void runExtraction(nextFile, undefined, protectedPasswordRef.current);
  };

  const cancelExtraction = () => {
    invalidateActiveRun();
    extractionOperationIdRef.current = null;
    extractionGrantRef.current = null;
    replacePageResults([]);
    setResultMeta(null);
    setPageFilter('all');
    setStatus({ isProcessing: false, progress: 0, noticeKind: 'cancelled', message: t("ocrpdf.extraction.cancelled.nothing.was.saved.bacf02") });
  };

  const copyTextToClipboard = async (content: string, successMessage: string) => {
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(content);
        setStatus({ isProcessing: false, progress: 100, noticeKind: 'copied', message: successMessage });
      } catch {
        setStatus({ isProcessing: false, progress: 0, message: '', error: t('ocr.clipboardFailed') });
      }
    };
    if (extractionGrantRef.current !== 'preview-only') {
      await copy();
      return;
    }
    try {
      const access = await runWithExportAccess(copy);
      if (access.status === 'blocked') {
        setStatus({ isProcessing: false, progress: 100, message: t("ocrpdf.preview.ready.unlock.to.copy.the.extracted.f9b7af") });
      }
    } catch {
      setStatus({ isProcessing: false, progress: 100, message: t("ocrpdf.preview.ready.unlock.to.copy.the.extracted.f9b7af") });
    }
  };

  const visiblePageResults = useMemo(() => {
    if (pageFilter === 'all') return pageResults;
    return pageResults.filter((page) => String(page.pageNumber) === pageFilter);
  }, [pageFilter, pageResults]);

  const exportText = useMemo(
    () => pageResults
      .map((page) => (pageHasExtractedText(page) ? page.text.trimEnd() : ''))
      .join('\n\n')
      .trim(),
    [pageResults],
  );

  // The Android tool's whole output is a .txt file, so the same export belongs here. It is only
  // offered when at least one page actually yielded text: a .txt whose entire content is
  // "nothing found" is a failure wearing a success screen, which is why the Android processor
  // fails outright in that case rather than writing the file.
  const hasExtractedText = useMemo(
    () => pageResults.some(pageHasExtractedText),
    [pageResults],
  );

  const downloadExtractedText = async () => {
    if (!file || !hasExtractedText) return;
    const outputName = toolOutputName(mode === 'ocr' ? 'ocr' : 'text', file.name, 'txt');
    const operationId = extractionOperationIdRef.current;
    if (!operationId) return;
    const download = async () => {
      downloadBlob(new Blob([exportText], { type: 'text/plain;charset=utf-8' }), outputName, 'text/plain', { operationId });
      setStatus({ isProcessing: false, progress: 100, message: t("ocrpdf.text.file.ready.8917e3") });
    };
    if (extractionGrantRef.current !== 'preview-only') {
      await download();
      return;
    }
    try {
      const access = await runWithExportAccess(download);
      if (access.status === 'blocked') {
        setStatus({ isProcessing: false, progress: 100, message: t("ocrpdf.preview.ready.unlock.to.save.the.extracted.e7b174") });
      }
    } catch {
      setStatus({ isProcessing: false, progress: 100, message: t("ocrpdf.preview.ready.unlock.to.save.the.extracted.e7b174") });
    }
  };

  const processedSummary = resultMeta
    ? resultMeta.processedPages < resultMeta.totalPages
      ? t("ocrpdf.showing.of.pages.increase.the.ocr.page.947d19", { v0: resultMeta.processedPages, v1: resultMeta.totalPages })
      : t("ocrpdf.showing.page.c19f4d", { count: resultMeta.processedPages })
    : '';

  return (
    <ToolShell width="full" centered={!file}>
      {/* The mode strip below names both paths and says what each one costs, so
          the title needs no gloss. */}
      <ToolHeader title={t("ocrpdf.extract.text.9ab592")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-3"
          >
            {/* Source first, then options, then status — the order every other
                tool route keeps. The mode panel had been standing above the
                drop zone, so this was the one screen that asked for a setting
                before it asked for a file. */}
            <FileUpload
              onFilesSelected={handleFilesSelected}
              accept=".pdf,application/pdf"
              label={mode === 'ocr' ? t("ocrpdf.choose.a.scanned.pdf.cf38d5") : t("ocrpdf.choose.a.pdf.3ba70f")}
            />
            <div className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-secondary)]">{t("ocrpdf.how.should.we.read.this.pdf.593a93")}</div>
              {/* The product's one segmented control: a raised chip on a sunken
                  track, with arrow-key radiogroup semantics. The pair of flat
                  accent-filled buttons this replaced read as a status block
                  rather than as a choice. */}
              <SegmentedControl
                label={t("ocrpdf.how.should.we.read.this.pdf.593a93")}
                value={mode}
                options={[
                  { value: 'text-layer', label: t("ocrpdf.normal.pdf.d68bc0") },
                  { value: 'ocr', label: t("ocrpdf.scanned.pages.5e7ba2") },
                ]}
                onChange={setMode}
              />

              {/* Kept: each mode fails in a way the label does not show. */}
              <p className="type-footnote mt-2 text-[var(--text-secondary)]">
                {mode === 'text-layer'
                  ? t("ocrpdf.fast.works.when.the.pdf.already.carries.030add")
                  : t("ocrpdf.slower.reads.the.words.off.a.picture.9cb859")}
              </p>

              {mode === 'ocr' && (
                <div className="mt-2.5">
                  <label htmlFor="ocr-page-limit" className="mb-1 block type-footnote font-semibold text-[var(--text-secondary)]">{t("ocrpdf.how.many.pages.to.read.36331f")}</label>
                  <input
                    id="ocr-page-limit"
                    value={ocrMaxPages}
                    onChange={(event) => setOcrMaxPages(event.target.value.replace(/[^\d]/g, ''))}
                    inputMode="numeric"
                    min={1}
                    className="chef-field w-28"
                  />
                </div>
              )}
            </div>

            {status.error && (
              <div role="alert" className="rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200">
                {status.error}
              </div>
            )}

          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={status.isProcessing ? cancelExtraction : clearExtraction}
                className="chef-target chef-pressable rounded-[var(--radius-control)] px-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--text-primary)]"
              >
                <span className="flex items-center gap-2"><ArrowLeft aria-hidden size={16} className="rtl:rotate-180" /> {status.isProcessing ? t("ocrpdf.cancel.extraction.8f2c87") : t("ocrpdf.extract.another.e104f8")}</span>
              </button>
              <div className="min-w-0 text-end">
                <div className="inline-flex rounded-full bg-[var(--surface-sunken)] px-2 py-1 text-xs font-semibold text-[var(--text-secondary)]">
                  {mode === 'ocr' ? t("ocrpdf.scanned.pages.5e7ba2") : t("ocrpdf.normal.pdf.d68bc0")}
                </div>
                <p className="mt-1 max-w-[12rem] truncate text-xs text-[var(--text-tertiary)]">{file.name}</p>
              </div>
            </div>

            {status.isProcessing ? (
              <div role="status" aria-live="polite" className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--accent-quiet)] p-3 text-blue-950 dark:border-blue-400 dark:bg-[var(--accent-quiet)] dark:text-blue-100 sm:p-4">
                <div className="flex items-center gap-3">
                  <Loader2 aria-hidden className="shrink-0 animate-spin" size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3 text-sm font-semibold">
                      <span>{status.message || t("ocrpdf.extracting.text.c3e98c")}</span>
                      <span className="tabular-nums">{formatPercent(status.progress)}</span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={t("ocrpdf.text.extraction.progress.4a7d2e")}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={status.progress}
                      className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950"
                    >
                      <div className="h-full rounded-full bg-[var(--accent-rest)] transition-[width]" style={{ width: `${status.progress}%` }} />
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={cancelExtraction}
                  className="chef-target chef-pressable mt-3 w-full rounded-[var(--radius-control)] border border-current px-4 text-sm font-semibold hover:bg-[var(--surface-raised)] sm:w-auto"
                >{t("ocrpdf.cancel.19766e")}</button>
              </div>
            ) : (
              <>
                {pageResults.length === 0 && (status.error || status.noticeKind === 'cancelled') && (
                  <div
                    role={status.error ? 'alert' : 'status'}
                    className={`rounded-[var(--radius-panel)] border p-3 text-sm ${
                      status.error
                        ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200'
                        : 'border-[var(--border-hairline)] bg-[var(--surface-sunken)] text-[var(--text-body)]'
                    }`}
                  >
                    <p className="font-bold">{status.error ? t("ocrpdf.extraction.failed.ed874a") : t("ocrpdf.extraction.cancelled.ea6842")}</p>
                    <p className="mt-1 leading-relaxed">{status.error || status.message}</p>
                    <div className="mt-4 grid gap-2 sm:flex">
                      <button
                        type="button"
                        onClick={() => void runExtraction(file)}
                        className="chef-target chef-pressable rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 font-semibold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)]"
                      >{t("ocrpdf.try.again.d8b839")}</button>
                      <button
                        type="button"
                        onClick={clearExtraction}
                        className="chef-target chef-pressable rounded-[var(--radius-control)] border border-[var(--border-strong)] px-4 font-semibold hover:border-[var(--accent-rest)]"
                      >{t("ocrpdf.choose.another.8a2bca")}</button>
                    </div>
                  </div>
                )}

                {pageResults.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2.5">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-secondary)]">{t("ocrpdf.results.219c4a")}</div>
                      <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
                        {processedSummary}
                      </p>
                    </div>

                    <div className="grid w-full gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
                      {pageResults.length > 1 && (
                        <label className="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-1 text-sm text-[var(--text-secondary)]">
                          <span>{t("ocrpdf.jump.to.page.d35c8c")}</span>
                          <select
                            value={pageFilter}
                            onChange={(event) => setPageFilter(event.target.value)}
                            className="bg-transparent font-medium outline-none"
                          >
                            <option value="all">{t("ocrpdf.all.pages.903542")}</option>
                            {pageResults.map((page) => (
                              <option key={page.pageNumber} value={String(page.pageNumber)}>{t("ocrpdf.message.c140ba4857", { v0: page.pageNumber })}</option>
                            ))}
                          </select>
                        </label>
                      )}

                      {hasExtractedText && (
                        <>
                          <button
                            type="button"
                            onClick={() => copyTextToClipboard(exportText, t("ocrpdf.copied.all.extracted.text.0c13a8"))}
                            className="chef-target chef-pressable flex items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-quiet)] px-4 font-medium text-[var(--accent-on-quiet)] transition-colors"
                          >
                            <Copy aria-hidden size={18} />{t("ocrpdf.copy.all.64f07c")}</button>

                          <button
                            type="button"
                            onClick={downloadExtractedText}
                            className="chef-target chef-pressable flex items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)]"
                          >
                            <Download aria-hidden size={18} />{t("ocrpdf.download.txt.c300e5")}</button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {pageResults.length > 0 && !hasExtractedText && (
                  <div className="rounded-[var(--radius-field)] border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm font-medium text-amber-800 dark:border-amber-500 dark:bg-amber-500/10 dark:text-amber-200">
                    {mode === 'text-layer' ? (
                      <div className="flex flex-col gap-3">
                        <p>{NO_EXTRACTABLE_TEXT_MESSAGE}</p>
                        <button
                          type="button"
                          onClick={switchToOcr}
                          className="chef-target chef-pressable inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] sm:w-auto"
                        >{t("ocrpdf.use.ocr.on.this.pdf.ae24db")}</button>
                      </div>
                    ) : (
                      t("ocrpdf.ocr.did.not.detect.readable.english.text.03435f")
                    )}
                  </div>
                )}

                <div className="grid gap-3">
                  {visiblePageResults.map((page) => (
                    <motion.article
                      key={page.pageNumber}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]"
                    >
                      <SelectablePagePreview
                        imageUrl={page.previewUrl}
                        pageNumber={page.pageNumber}
                        previewWidth={page.previewWidth}
                        previewHeight={page.previewHeight}
                        lines={page.selectionLines}
                      />

                      <div className="min-w-0">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t("ocrpdf.message.c140ba4857", { v0: page.pageNumber })}</h2>

                          {pageHasExtractedText(page) && (
                            <button
                              type="button"
                              onClick={() => copyTextToClipboard(page.text, t("ocrpdf.copied.page.text.7fbe3c", { v0: page.pageNumber }))}
                              className="chef-target chef-pressable flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)]"
                            >
                              <Copy aria-hidden size={18} />{t("ocrpdf.copy.page.b89db0")}</button>
                          )}
                        </div>

                        <pre className="select-text chef-scroller max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-field)] bg-[var(--surface-sunken)] p-3 text-sm text-[var(--text-body)]">
                          {page.text === NO_TEXT_LAYER_PLACEHOLDER ? t("ocrpdf.this.page.has.no.words.stored.in.e875a3")
                            : page.text === NO_OCR_TEXT_PLACEHOLDER ? t("ocrpdf.no.words.could.be.read.from.this.8ce507") : page.text}
                        </pre>
                      </div>
                    </motion.article>
                  ))}
                </div>
              </>
            )}

            {status.noticeKind === 'copied' && (
              <div
                role="status"
                aria-live="polite"
                className="chef-above-tabbar fixed inset-x-3 rounded-[var(--radius-field)] bg-emerald-600 px-3 py-2 text-sm text-paper-25 shadow-[var(--elevation-panel)] sm:inset-x-auto sm:right-3"
              >
                {status.message}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </ToolShell>
  );
};
