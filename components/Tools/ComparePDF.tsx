import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Download,
  Loader2,
  Move,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { Button } from '../UI/Primitives';
import { StatusToast } from '../UI/StatusToast';
import { ToolShell } from '../UI/ToolLayout';
import { ZoomControls } from '../UI/ZoomControls';
import { useZoom } from '../../hooks/useZoom';
import { getPageTextSignatures, loadPDFDocument, renderPageAsImage } from '../../services/pdfBrowser';
import { downloadBlob } from '../../services/pdfShared';
import { androidExportFileName } from '../../services/androidParity';
import { ProcessingStatus } from '../../types';
import { compareExtractedPageText } from '../../services/pdfToolResults';
import { createComparisonReport } from '../../services/comparisonReport.ts';
import { useMonetization, type JobAccessGrant } from '../../hooks/useMonetization';

interface PreviewState {
  left: string;
  right: string;
}

interface ComparisonResult {
  reportName: string;
  pagesCompared: number;
  identicalPageCount: number;
  differentPages: number[];
  matchRatio: number | null;
  unavailablePages: number[];
  pageCountEqual: boolean;
  firstPageTextEqual: boolean | null;
  limitedToFirstFifty: boolean;
}

const revokePreview = (url?: string) => {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
};

const emptyStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const ComparePDF: React.FC = () => {
  useI18n();
  const [file1, setFile1] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [pdf1, setPdf1] = useState<any>(null);
  const [pdf2, setPdf2] = useState<any>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [reportLoading, setReportLoading] = useState(false);
  const [selectingSlot, setSelectingSlot] = useState<'left' | 'right' | null>(null);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>(emptyStatus);
  const comparisonOperationIdRef = useRef<string | null>(null);
  const comparisonGrantRef = useRef<JobAccessGrant | null>(null);
  const { completeJob, runWithExportAccess } = useMonetization();

  const { zoom, zoomIn, zoomOut, resetZoom } = useZoom(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const previewRef = useRef<PreviewState | null>(null);

  const maxPageCount = Math.min(pdf1?.numPages ?? 0, pdf2?.numPages ?? 0);

  useEffect(() => () => {
    if (pdf1?.destroy) void pdf1.destroy();
  }, [pdf1]);

  useEffect(() => () => {
    if (pdf2?.destroy) void pdf2.destroy();
  }, [pdf2]);

  useEffect(() => () => {
    revokePreview(previewRef.current?.left);
    revokePreview(previewRef.current?.right);
  }, []);

  useEffect(() => {
    let active = true;

    const render = async () => {
      if (!pdf1 || !pdf2) return;
      setPreviewLoading(true);
      setPreviewError(null);
      revokePreview(previewRef.current?.left);
      revokePreview(previewRef.current?.right);
      previewRef.current = null;
      setPreview(null);

      try {
        const [left, right] = await Promise.all([
          renderPageAsImage(pdf1, pageIndex, { format: 'image/jpeg', quality: 0.9, scale: 1.5 }),
          renderPageAsImage(pdf2, pageIndex, { format: 'image/jpeg', quality: 0.9, scale: 1.5 }),
        ]);

        if (!active) {
          revokePreview(left.objectUrl);
          revokePreview(right.objectUrl);
          return;
        }

        const nextPreview = { left: left.objectUrl, right: right.objectUrl };
        previewRef.current = nextPreview;
        setPreview(nextPreview);
      } catch (error) {
        console.error(error);
        if (active) {
          setPreviewError(t("compare-pdf.this.page.could.not.be.shown.for.4435e1"));
        }
      } finally {
        if (active) setPreviewLoading(false);
      }
    };

    void render();
    return () => {
      active = false;
    };
  }, [pdf1, pdf2, pageIndex, previewAttempt]);

  useEffect(() => {
    if (zoom === 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  const handleFileSelection = async (slot: 'left' | 'right', file: File) => {
    const label = slot === 'left' ? t("compare-pdf.document.a.e39e3d") : t("compare-pdf.document.b.80d6f4");
    setSelectingSlot(slot);
    setResult(null);
    setStatus({ isProcessing: true, progress: 10, message: t("compare-pdf.opening.on.this.device.c5898b", { v0: label }) });
    try {
      const nextDocument = await loadPDFDocument(file);
      if (nextDocument.numPages < 1) throw new Error(t("compare-pdf.the.pdf.has.no.pages.264071"));
      if (slot === 'left') {
        setFile1(file);
        setPdf1(nextDocument);
      } else {
        setFile2(file);
        setPdf2(nextDocument);
      }
      setPageIndex(0);
      setPan({ x: 0, y: 0 });
      resetZoom();
      setStatus({
        isProcessing: false,
        progress: 100,
        message: slot === 'left' && !file2 || slot === 'right' && !file1
          ? t("compare-pdf.ready.0f18e7", { v0: label })
          : t("compare-pdf.both.pdfs.are.ready.to.compare.83c589"),
      });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: t("compare-pdf.could.not.be.opened.choose.a.readable.159d1d", { v0: label }),
      });
    } finally {
      setSelectingSlot(null);
    }
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    if (zoom <= 1) return;

    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setIsPanning(true);
    const startX = event.clientX - pan.x;
    const startY = event.clientY - pan.y;

    const onMove = (moveEvent: PointerEvent) => {
      setPan({ x: moveEvent.clientX - startX, y: moveEvent.clientY - startY });
    };

    const onUp = (upEvent: PointerEvent) => {
      setIsPanning(false);
      if (target.hasPointerCapture(upEvent.pointerId)) {
        target.releasePointerCapture(upEvent.pointerId);
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const reset = () => {
    revokePreview(previewRef.current?.left);
    revokePreview(previewRef.current?.right);
    previewRef.current = null;
    setPreview(null);
    setFile1(null);
    setFile2(null);
    setPdf1(null);
    setPdf2(null);
    setPageIndex(0);
    setPan({ x: 0, y: 0 });
    setPreviewError(null);
    setResult(null);
    comparisonOperationIdRef.current = null;
    comparisonGrantRef.current = null;
    setStatus(emptyStatus());
    resetZoom();
  };

  const handleExportReport = async () => {
    if (!file1 || !file2 || !pdf1 || !pdf2) return;
    const operationId = uuidv4();
    comparisonOperationIdRef.current = operationId;
    comparisonGrantRef.current = null;
    setReportLoading(true);
    setResult(null);
    setStatus({ isProcessing: true, progress: 10, message: t("compare-pdf.comparing.the.wording.on.your.device.4debd9") });
    try {
      const commonPages = Math.min(pdf1.numPages, pdf2.numPages);
      const maxPagesCompared = Math.min(commonPages, 50);

      const [leftSignatures, rightSignatures] = await Promise.all([
        getPageTextSignatures(file1, { maxPages: maxPagesCompared, maxCharsPerPage: Infinity }),
        getPageTextSignatures(file2, { maxPages: maxPagesCompared, maxCharsPerPage: Infinity }),
      ]);

      const differentPages: number[] = [];
      const identicalPages: number[] = [];
      const unavailablePages: number[] = [];

      for (let index = 0; index < maxPagesCompared; index += 1) {
        const left = (leftSignatures[index] || '').trim();
        const right = (rightSignatures[index] || '').trim();
        const comparison = compareExtractedPageText(left, right);
        if (comparison === 'unavailable') unavailablePages.push(index + 1);
        else if (comparison === 'matches') identicalPages.push(index + 1);
        else differentPages.push(index + 1);
      }

      const comparablePages = maxPagesCompared - unavailablePages.length;
      const matchRatio = comparablePages > 0
        ? Math.round((identicalPages.length / comparablePages) * 100)
        : null;
      const firstPageComparison = compareExtractedPageText(leftSignatures[0] || '', rightSignatures[0] || '');
      const firstPageTextEqual = firstPageComparison === 'unavailable' ? null : firstPageComparison === 'matches';

      const firstPageSignatureA = (leftSignatures[0] || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const firstPageSignatureB = (rightSignatures[0] || '').replace(/\s+/g, ' ').trim().slice(0, 500);

      // Text excerpts keep the report readable; equality uses the complete extracted text.
      const report = createComparisonReport({
        generatedAt: new Date(),
        fileA: { name: file1.name, pageCount: pdf1.numPages, sizeBytes: file1.size },
        fileB: { name: file2.name, pageCount: pdf2.numPages, sizeBytes: file2.size },
        pageCountEqual: pdf1.numPages === pdf2.numPages,
        firstPageTextEqual,
        firstPageSignatureA,
        firstPageSignatureB,
        pageSignaturesA: leftSignatures,
        pageSignaturesB: rightSignatures,
        pagesCompared: maxPagesCompared,
        identicalPageCount: identicalPages.length,
        differentPages,
        unavailablePages,
        matchRatio,
        commonPages,
      });

      const reportName = androidExportFileName('compare_summary', file1.name, 'txt');
      const grant = await completeJob(operationId).catch(() => 'preview-only' as const);
      if (comparisonOperationIdRef.current !== operationId) return;
      comparisonGrantRef.current = grant;
      setResult({
        reportName,
        pagesCompared: maxPagesCompared,
        identicalPageCount: identicalPages.length,
        differentPages,
        matchRatio,
        unavailablePages,
        pageCountEqual: pdf1.numPages === pdf2.numPages,
        firstPageTextEqual,
        limitedToFirstFifty: maxPagesCompared < commonPages,
      });
      const downloadReport = async () => {
        downloadBlob(new Blob([report], { type: 'text/plain;charset=utf-8' }), reportName, 'text/plain', { operationId });
      };
      if (grant === 'preview-only') {
        try {
          const access = await runWithExportAccess(downloadReport);
          if (access.status === 'blocked') {
            setStatus({ isProcessing: false, progress: 100, message: t("compare-pdf.comparison.ready.as.a.preview.unlock.to.3a971e") });
            return;
          }
        } catch {
          setStatus({ isProcessing: false, progress: 100, message: t("compare-pdf.comparison.ready.as.a.preview.unlock.to.3a971e") });
          return;
        }
      } else {
        await downloadReport();
      }
      setStatus({
        isProcessing: false,
        progress: 100,
        message: t("compare-pdf.comparison.summary.created.9faa19"),
      });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: t("compare-pdf.unable.to.create.the.comparison.report.check.924d37"),
      });
    } finally {
      setReportLoading(false);
    }
  };

  return (
    // The shell already reserves the tab bar with `chef-tab-inset`; the extra
    // bottom pad this route added was a second, unpaid-for one.
    <ToolShell width="full" centered={!file1 && !file2}>
      <div className="mb-3">
        <h1 className="text-3xl font-bold text-[var(--text-primary)]">{t("compare-pdf.compare.summary.62ec42")}</h1>
        {/* Kept: the report is text-based, so a visually different PDF can still
            report as matching. Stated once, here. */}
        <p className="mt-1 max-w-measure text-sm text-[var(--text-secondary)]">{t("compare-pdf.the.report.compares.page.count.and.extracted.c1f4a2")}</p>
        {file1 && file2 && (
          <div className="sticky top-[var(--size-nav-bar)] z-20 -mx-4 mt-3 flex flex-col gap-2 border-b border-[var(--border-hairline)] bg-[var(--surface-canvas)] px-4 py-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="flex items-center justify-between gap-1 rounded-[var(--radius-pill)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-1 text-sm sm:justify-start">
              <button
                type="button"
                aria-label={t("compare-pdf.previous.comparison.page.472b4c")}
                onClick={() => setPageIndex((value) => Math.max(0, value - 1))}
                disabled={pageIndex === 0}
                className="chef-pressable chef-target grid place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
              >
                <ArrowLeft aria-hidden size={18} className="rtl:rotate-180" />
              </button>
              <span className="min-w-[7.5rem] text-center font-medium text-[var(--text-primary)]">{t("compare-pdf.message.477c22095a", { v0: pageIndex + 1, v1: maxPageCount })}</span>
              <button
                type="button"
                aria-label={t("compare-pdf.next.comparison.page.ce0d56")}
                onClick={() => setPageIndex((value) => Math.min(maxPageCount - 1, value + 1))}
                disabled={pageIndex >= maxPageCount - 1}
                className="chef-pressable chef-target grid place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
              >
                <ArrowRight aria-hidden size={18} className="rtl:rotate-180" />
              </button>
            </div>
            <div className="scroll-mb-[calc(var(--size-tab-bar)+2rem)]">
              <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
            </div>
          </div>
        )}

      </div>

      <AnimatePresence mode="wait">
        {!file1 || !file2 ? (
          <motion.div key="selection" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <div className="grid gap-3 md:grid-cols-2">
              <section>
                <h2 className="mb-1.5 text-sm font-semibold text-[var(--text-secondary)]">{t("compare-pdf.document.a.e39e3d")}</h2>
                <FileUpload
                  onFilesSelected={(files) => files[0] && void handleFileSelection('left', files[0])}
                  accept=".pdf"
                  label={file1 ? file1.name : t("compare-pdf.choose.first.pdf.0434be")}
                />
              </section>
              <section>
                <h2 className="mb-1.5 text-sm font-semibold text-[var(--text-secondary)]">{t("compare-pdf.document.b.80d6f4")}</h2>
                <FileUpload
                  onFilesSelected={(files) => files[0] && void handleFileSelection('right', files[0])}
                  accept=".pdf"
                  label={file2 ? file2.name : t("compare-pdf.choose.second.pdf.479128")}
                  allowOpenedPdf={false}
                />
              </section>
            </div>
            {selectingSlot && (
              <p role="status" aria-live="polite" className="mt-3 flex items-center justify-center gap-2 text-sm font-medium text-[var(--text-secondary)]">
                <Loader2 aria-hidden className="h-4 w-4 animate-spin text-[var(--accent-text)]" />{t("compare-pdf.message.c5898b3744", { v0: selectingSlot === 'left' ? t('compare.documentA') : t('compare.documentB') })}</p>
            )}
          </motion.div>
        ) : (
          <motion.div key="comparison" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                tone="primary"
                icon={<Download aria-hidden size={18} />}
                busy={reportLoading}
                onClick={handleExportReport}
                className="w-full sm:w-auto"
              >{t("compare-pdf.save.the.summary.64af76")}</Button>
              <Button icon={<Undo2 aria-hidden size={18} />} onClick={reset} disabled={reportLoading} className="w-full sm:w-auto">{t("compare-pdf.choose.different.pdfs.ad084f")}</Button>
            </div>

            {result && (
              <section
                aria-live="polite"
                className="rounded-[var(--radius-panel)] border border-[var(--status-success-text)] bg-[var(--status-success-quiet)] p-3 text-[var(--status-success-text)]"
              >
                <div className="flex items-start gap-2">
                  <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
                  <div className="min-w-0">
                    <h2 className="font-semibold">{t("compare-pdf.comparison.summary.ready.a3f394")}</h2>
                    <p className="chef-filename mt-1 break-words text-sm">{result.reportName}</p>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-current/20 pt-3 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs font-medium">{t("compare-pdf.page.count.2905c1")}</dt>
                    <dd className="mt-0.5 font-semibold">{result.pageCountEqual ? t("compare-pdf.same.2a98b1") : t("compare-pdf.different.e9cdbd")}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium">{t("compare-pdf.first.page.text.c7e08a")}</dt>
                    <dd className="mt-0.5 font-semibold">{result.firstPageTextEqual === null ? t("compare-pdf.unavailable.ca1844") : result.firstPageTextEqual ? t("compare-pdf.matches.98abff") : t("compare-pdf.differs.627bb3")}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium">{t("compare-pdf.pages.checked.7f0722")}</dt>
                    <dd className="mt-0.5 font-semibold">{result.pagesCompared}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium">{t("compare-pdf.wording.that.matches.83d290")}</dt>
                    <dd className="mt-0.5 font-semibold">{result.matchRatio === null ? t("compare-pdf.unavailable.ca1844") : t("compare-pdf.match.9d6f0a", { v0: result.matchRatio })}</dd>
                  </div>
                </dl>
                <p className="type-footnote mt-2">
                  {result.differentPages.length === 0
                    ? result.identicalPageCount > 0
                      ? t("compare-pdf.wording.matches.on.the.checked.pages.with.dcb9c6")
                      : t("compare-pdf.these.pages.need.visual.comparison.inspect.the.80af94")
                    : t("compare-pdf.the.wording.differs.on.page.pictures.layout.ae9fa8", { v1: result.differentPages.join(', '), count: result.differentPages.length })}
                  {result.limitedToFirstFifty ? t("compare-pdf.only.the.first.50.common.pages.were.f8becd") : ''}
                  {result.unavailablePages.length > 0 ? t("compare-pdf.text.could.not.be.compared.on.pages.09f2e2", { v0: result.unavailablePages.join(', ') }) : ''}
                </p>
              </section>
            )}

            {previewError && (
              <div role="alert" className="flex flex-col gap-3 rounded-[var(--radius-field)] bg-[var(--status-danger-quiet)] p-3.5 text-[var(--status-danger-text)] sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2">
                  <AlertTriangle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
                  <p className="text-sm font-medium leading-5">{previewError}</p>
                </div>
                <Button
                  icon={<RefreshCw aria-hidden size={16} />}
                  onClick={() => setPreviewAttempt((value) => value + 1)}
                  className="shrink-0"
                >{t("compare-pdf.retry.preview.ceba35")}</Button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              {[
                { name: file1.name, src: preview?.left },
                { name: file2.name, src: preview?.right },
              ].map((entry, index) => (
                <figure key={`${index}-${entry.name}`} className="min-w-0">
                  <figcaption className="chef-filename mb-1.5 break-words rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] px-2 py-1.5 text-center text-xs font-semibold text-[var(--text-primary)] sm:px-4 sm:text-sm">
                    {entry.name}
                  </figcaption>
                  <div
                    className={`relative flex aspect-[210/297] items-center justify-center overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] ${zoom > 1 ? 'touch-none cursor-grab active:cursor-grabbing' : ''}`}
                    onPointerDown={handlePointerDown}
                  >
                    {previewLoading && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--surface-raised)]/80">
                        <Loader2 aria-label={t("compare-pdf.loading.page.preview.73f2ff", { v0: pageIndex + 1 })} className="h-6 w-6 animate-spin text-[var(--accent-text)]" />
                      </div>
                    )}
                    {entry.src && (
                      <img
                        src={entry.src}
                        alt={t("compare-pdf.page.of.477c22", { v0: pageIndex + 1, v1: entry.name })}
                        draggable={false}
                        className="max-h-full max-w-full select-none object-contain shadow-[var(--elevation-raised)] will-change-transform"
                        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                      />
                    )}
                    {zoom > 1 && isPanning && (
                      <div className="absolute left-2 top-2 flex items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 py-1 text-xs font-semibold text-[var(--text-primary)]">
                        <Move aria-hidden size={12} />{t("compare-pdf.synced.pan.5774cd")}</div>
                    )}
                  </div>
                </figure>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <StatusToast status={status} />
    </ToolShell>
  );
};
