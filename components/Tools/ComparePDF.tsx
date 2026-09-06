import React, { useEffect, useRef, useState } from 'react';
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

interface PreviewState {
  left: string;
  right: string;
}

interface ComparisonResult {
  reportName: string;
  pagesCompared: number;
  identicalPageCount: number;
  differentPages: number[];
  matchRatio: number;
  pageCountEqual: boolean;
  firstPageTextEqual: boolean;
  limitedToFirstFifty: boolean;
}

/** `SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)` in `ComparePdfToolProcessor`, in local time. */
const formatGeneratedAt = (value: Date): string => {
  const pad = (part: number) => String(part).padStart(2, '0');
  return (
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
  );
};

const revokePreview = (url?: string) => {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
};

const emptyStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const ComparePDF: React.FC = () => {
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
          setPreviewError('Unable to render this page in one or both PDFs; you can still export the text summary.');
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
    const label = slot === 'left' ? 'Document A' : 'Document B';
    setSelectingSlot(slot);
    setResult(null);
    setStatus({ isProcessing: true, progress: 10, message: `Opening ${label} on this device…` });
    try {
      const nextDocument = await loadPDFDocument(file);
      if (nextDocument.numPages < 1) throw new Error('The PDF has no pages.');
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
          ? `${label} ready.`
          : 'Both PDFs are ready to compare.',
      });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: `${label} could not be opened. Choose a readable PDF and try again.`,
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
    setStatus(emptyStatus());
    resetZoom();
  };

  const handleExportReport = async () => {
    if (!file1 || !file2 || !pdf1 || !pdf2) return;
    setReportLoading(true);
    setResult(null);
    setStatus({ isProcessing: true, progress: 10, message: 'Comparing extracted text on this device…' });
    try {
      const commonPages = Math.min(pdf1.numPages, pdf2.numPages);
      const maxPagesCompared = Math.min(commonPages, 50);

      const [leftSignatures, rightSignatures] = await Promise.all([
        getPageTextSignatures(file1, { maxPages: maxPagesCompared, maxCharsPerPage: 600 }),
        getPageTextSignatures(file2, { maxPages: maxPagesCompared, maxCharsPerPage: 600 }),
      ]);

      const differentPages: number[] = [];
      const identicalPages: number[] = [];

      for (let index = 0; index < maxPagesCompared; index += 1) {
        const left = (leftSignatures[index] || '').trim();
        const right = (rightSignatures[index] || '').trim();
        if (left === right) identicalPages.push(index + 1);
        else differentPages.push(index + 1);
      }

      const matchRatio = maxPagesCompared > 0
        ? Math.round((identicalPages.length / maxPagesCompared) * 100)
        : 0;

      const mismatchDetails = differentPages.slice(0, 20).map((pageNumber) => {
        const left = leftSignatures[pageNumber - 1] || '<empty>';
        const right = rightSignatures[pageNumber - 1] || '<empty>';
        return [
          `Page ${pageNumber}`,
          `A extracted text: ${left.slice(0, 180)}`,
          `B extracted text: ${right.slice(0, 180)}`,
        ].join('\n');
      }).join('\n\n');

      const firstPageSignatureA = (leftSignatures[0] || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const firstPageSignatureB = (rightSignatures[0] || '').replace(/\s+/g, ' ').trim().slice(0, 500);

      /**
       * The first block is `ComparePdfToolProcessor`'s report verbatim: same title, local timestamp,
       * two summary lines and 500-character first-page signatures. The clearly labelled browser
       * section adds per-page extracted-text checks without implying a visual PDF diff.
       */
      const report = [
        'PDF Chef Compare Summary',
        `Generated: ${formatGeneratedAt(new Date())}`,
        '',
        `File A: ${file1.name}`,
        `Pages: ${pdf1.numPages}`,
        `Size: ${file1.size} bytes`,
        '',
        `File B: ${file2.name}`,
        `Pages: ${pdf2.numPages}`,
        `Size: ${file2.size} bytes`,
        '',
        'Summary',
        `- Page count equal: ${pdf1.numPages === pdf2.numPages}`,
        `- Approx text signature equal: ${firstPageSignatureA === firstPageSignatureB}`,
        '',
        'First-page text signature A:',
        firstPageSignatureA || '<empty>',
        '',
        'First-page text signature B:',
        firstPageSignatureB || '<empty>',
        '',
        'Per-page extracted-text detail (browser build)',
        '- Method: normalized extracted text only; layout, images, fonts and annotations are not compared',
        `- Pages compared: ${maxPagesCompared}`,
        `- Matching text signatures: ${identicalPages.length}`,
        `- Different text signatures: ${differentPages.length}`,
        `- Text-signature match ratio: ${matchRatio}%`,
        ...(maxPagesCompared < commonPages ? [`- Note: compared first ${maxPagesCompared} common pages only`] : []),
        '',
        'Pages with different extracted text:',
        differentPages.length > 0 ? differentPages.join(', ') : '<none>',
        '',
        'Extracted-text details (truncated):',
        mismatchDetails || '<none>',
      ].join('\n');

      const reportName = androidExportFileName('compare_summary', file1.name, 'txt');
      downloadBlob(new Blob([report], { type: 'text/plain;charset=utf-8' }), reportName, 'text/plain');
      setResult({
        reportName,
        pagesCompared: maxPagesCompared,
        identicalPageCount: identicalPages.length,
        differentPages,
        matchRatio,
        pageCountEqual: pdf1.numPages === pdf2.numPages,
        firstPageTextEqual: firstPageSignatureA === firstPageSignatureB,
        limitedToFirstFifty: maxPagesCompared < commonPages,
      });
      setStatus({
        isProcessing: false,
        progress: 100,
        message: 'Comparison summary created.',
      });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: 'Unable to create the comparison report. Check both PDFs and try again.',
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
        <h1 className="text-3xl font-bold text-[var(--text-primary)]">Compare Summary</h1>
        {/* Kept: the report is text-based, so a visually different PDF can still
            report as matching. Stated once, here. */}
        <p className="mt-1 max-w-measure text-sm text-[var(--text-secondary)]">
          The report compares page count and extracted text, not layout, images, fonts, or annotations.
        </p>
        {file1 && file2 && (
          <div className="sticky top-[var(--size-nav-bar)] z-20 -mx-4 mt-3 flex flex-col gap-2 border-b border-[var(--border-hairline)] bg-[var(--surface-canvas)] px-4 py-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="flex items-center justify-between gap-1 rounded-[var(--radius-pill)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-1 text-sm sm:justify-start">
              <button
                type="button"
                aria-label="Previous comparison page"
                onClick={() => setPageIndex((value) => Math.max(0, value - 1))}
                disabled={pageIndex === 0}
                className="chef-pressable chef-target grid place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
              >
                <ArrowLeft aria-hidden size={18} />
              </button>
              <span className="min-w-[7.5rem] text-center font-medium text-[var(--text-primary)]">
                Page {pageIndex + 1} of {maxPageCount}
              </span>
              <button
                type="button"
                aria-label="Next comparison page"
                onClick={() => setPageIndex((value) => Math.min(maxPageCount - 1, value + 1))}
                disabled={pageIndex >= maxPageCount - 1}
                className="chef-pressable chef-target grid place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
              >
                <ArrowRight aria-hidden size={18} />
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
                <h2 className="mb-1.5 text-sm font-semibold text-[var(--text-secondary)]">Document A</h2>
                <FileUpload
                  onFilesSelected={(files) => files[0] && void handleFileSelection('left', files[0])}
                  accept=".pdf"
                  label={file1 ? file1.name : 'Choose first PDF'}
                />
              </section>
              <section>
                <h2 className="mb-1.5 text-sm font-semibold text-[var(--text-secondary)]">Document B</h2>
                <FileUpload
                  onFilesSelected={(files) => files[0] && void handleFileSelection('right', files[0])}
                  accept=".pdf"
                  label={file2 ? file2.name : 'Choose second PDF'}
                  allowOpenedPdf={false}
                />
              </section>
            </div>
            {selectingSlot && (
              <p role="status" aria-live="polite" className="mt-3 flex items-center justify-center gap-2 text-sm font-medium text-[var(--text-secondary)]">
                <Loader2 aria-hidden className="h-4 w-4 animate-spin text-[var(--accent-text)]" />
                Opening {selectingSlot === 'left' ? 'Document A' : 'Document B'} on this device…
              </p>
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
              >
                Export comparison report
              </Button>
              <Button icon={<Undo2 aria-hidden size={18} />} onClick={reset} disabled={reportLoading} className="w-full sm:w-auto">
                Choose different PDFs
              </Button>
            </div>

            {result && (
              <section
                aria-live="polite"
                className="rounded-[var(--radius-panel)] border border-[var(--status-success-text)] bg-[var(--status-success-quiet)] p-3 text-[var(--status-success-text)]"
              >
                <div className="flex items-start gap-2">
                  <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
                  <div className="min-w-0">
                    <h2 className="font-semibold">Comparison summary ready</h2>
                    <p className="chef-filename mt-1 break-words text-sm">{result.reportName}</p>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-current/20 pt-3 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs font-medium">Page count</dt>
                    <dd className="mt-0.5 font-semibold">{result.pageCountEqual ? 'Same' : 'Different'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium">First-page text</dt>
                    <dd className="mt-0.5 font-semibold">{result.firstPageTextEqual ? 'Matches' : 'Differs'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium">Pages checked</dt>
                    <dd className="mt-0.5 font-semibold">{result.pagesCompared}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium">Text signatures</dt>
                    <dd className="mt-0.5 font-semibold">{result.matchRatio}% match</dd>
                  </div>
                </dl>
                <p className="type-footnote mt-2">
                  {result.differentPages.length === 0
                    ? 'No extracted-text differences were found in the checked common pages.'
                    : `Different extracted text on page${result.differentPages.length === 1 ? '' : 's'} ${result.differentPages.join(', ')}.`}
                  {result.limitedToFirstFifty ? ' Only the first 50 common pages were checked.' : ''}
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
                >
                  Retry preview
                </Button>
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
                        <Loader2 aria-label={`Loading page ${pageIndex + 1} preview`} className="h-6 w-6 animate-spin text-[var(--accent-text)]" />
                      </div>
                    )}
                    {entry.src && (
                      <img
                        src={entry.src}
                        alt={`Page ${pageIndex + 1} of ${entry.name}`}
                        draggable={false}
                        className="max-h-full max-w-full select-none object-contain shadow-[var(--elevation-raised)] will-change-transform"
                        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                      />
                    )}
                    {zoom > 1 && isPanning && (
                      <div className="absolute left-2 top-2 flex items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 py-1 text-xs font-semibold text-[var(--text-primary)]">
                        <Move aria-hidden size={12} />
                        Synced pan
                      </div>
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
