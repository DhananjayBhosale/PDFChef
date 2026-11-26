import { t } from '../../services/i18n/core.ts';
import { pdfProblemMessage } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Download,
  Loader2,
  Move,
  RefreshCw,
} from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { StatusToast } from '../UI/StatusToast';
import { ToolScreen } from '../Tool/ToolScreen';
import { useWorkInput } from '../UI/workSignature';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { useStatusNotice } from '../Tool/parts';
import { useWide } from '../../hooks/useMediaQuery';
import { ZoomControls } from '../UI/ZoomControls';
import { PreviewFrame } from '../Tool/PreviewFrame';
import { usePanZoom } from '../../hooks/usePanZoom';
import { MAX_ZOOM } from '../../hooks/useZoom';
import { PeekButton, usePagePreview } from '../Tool/PagePeek';
import { getPageTextSignatures, loadPDFDocument, renderPageAsImage } from '../../services/pdfLazy';
import { downloadBlob } from '../../services/pdfShared';
import { ProcessingStatus } from '../../types';
import { compareExtractedPageText } from '../../services/pdfToolResults';
import { createComparisonReport } from '../../services/comparisonReport.ts';
import { useMonetization, type JobAccessGrant } from '../../hooks/useMonetization';
import { datedOutputName } from '../UI/format';
import { SharpPageLayer } from '../Tool/SharpPageLayer';

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
  // The two files are inputs of the report ("Earlier result" once either changes).
  useWorkInput(`${file1?.name ?? ''}:${file1?.size ?? 0}\u0000${file2?.name ?? ''}:${file2?.size ?? 0}`);
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

  // Both pages zoom and move together: two fingers on either, Ctrl+wheel, or − and + (about the
  // top of the page), with the shared page zoom (pass 5), up to 400% like the other viewers.
  const { zoom, zoomIn, zoomOut, reset: resetZoom, panning: isPanning, gestureRef, onPointerDown: handlePointerDown, transform, touchAction } = usePanZoom({ max: MAX_ZOOM });
  // Each pane's eye opens its own document large, at the page shown (fable-2 item 3).
  const previewA = usePagePreview(file1, file1?.name);
  const previewB = usePagePreview(file2, file2?.name);
  const wide = useWide();
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

  // Two PDFs dropped together fill both documents, the first where they were dropped (research r3,
  // desktop-05). One at a time, so the status names each.
  const takeFiles = async (slot: 'left' | 'right', files: File[]) => {
    const other = slot === 'left' ? 'right' : 'left';
    if (files[0]) await handleFileSelection(slot, files[0]);
    if (files[1] && !(other === 'left' ? file1 : file2)) await handleFileSelection(other, files[1]);
  };

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
        error: pdfProblemMessage(error) ?? t("compare-pdf.could.not.be.opened.choose.a.readable.159d1d", { v0: label }),
      });
    } finally {
      setSelectingSlot(null);
    }
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

      const reportName = datedOutputName(t("tool-catalog.compare.summary.62ec42"), 'txt');
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

  const title = t("compare-pdf.compare.summary.62ec42");
  // "Document A ready." is never a floating box that looks like a text field (T-16). With both
  // files open it is the notice line's plain text; before that the zone already shows the file's
  // name, so it is only said. The toast keeps progress and failures.
  const statusNotice = useStatusNotice(status);
  const loadedToast = <StatusToast status={status.error || status.isProcessing ? status : { ...status, message: '' }} />;
  const readySaid = !status.error && !status.isProcessing && status.message
    ? <p role="status" className="sr-only">{status.message}</p>
    : null;

  // Kept: the report is text-based, so a visually different PDF can still report as matching.
  const statement = (
    <Sentence
      template="compare-pdf.the.report.compares.page.count.and.extracted.c1f4a2"
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={reportLoading}
    />
  );

  if (!file1 || !file2) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty tk-compare-empty">
            <div className="tk-compare-pickers">
              <section>
                <h2 className="tk-compare-cap">{t("compare-pdf.document.a.e39e3d")}</h2>
                <FileUpload
                  onFilesSelected={(files) => takeFiles('left', files)}
                  accept=".pdf"
                  dropsAll
                  label={file1 ? file1.name : t("compare-pdf.choose.first.pdf.0434be")}
                />
              </section>
              <section>
                <h2 className="tk-compare-cap">{t("compare-pdf.document.b.80d6f4")}</h2>
                <FileUpload
                  onFilesSelected={(files) => takeFiles('right', files)}
                  accept=".pdf"
                  dropsAll
                  label={file2 ? file2.name : t("compare-pdf.choose.second.pdf.479128")}
                  allowOpenedPdf={false}
                />
              </section>
            </div>
            {selectingSlot && (
              <p role="status" aria-live="polite" className="tk-compare-opening">
                <Loader2 aria-hidden className="h-4 w-4 animate-spin text-[var(--accent-text)]" />{t("compare-pdf.message.c5898b3744", { v0: selectingSlot === 'left' ? t('compare.documentA') : t('compare.documentB') })}</p>
            )}
            {readySaid}
          </div>
        )}
        toast={loadedToast}
      />
    );
  }

  const summary = result ? (
    <section aria-live="polite" className="tk-compare-summary">
      <div className="tk-compare-summary-head">
        <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0">
          <h2 className="tk-compare-summary-title">{t("compare-pdf.comparison.summary.ready.a3f394")}</h2>
          <p className="chef-filename tk-compare-summary-name">{result.reportName}</p>
        </div>
      </div>
      <dl className="tk-compare-facts">
        <div>
          <dt>{t("compare-pdf.page.count.2905c1")}</dt>
          <dd>{result.pageCountEqual ? t("compare-pdf.same.2a98b1") : t("compare-pdf.different.e9cdbd")}</dd>
        </div>
        <div>
          <dt>{t("compare-pdf.first.page.text.c7e08a")}</dt>
          <dd>{result.firstPageTextEqual === null ? t("compare-pdf.unavailable.ca1844") : result.firstPageTextEqual ? t("compare-pdf.matches.98abff") : t("compare-pdf.differs.627bb3")}</dd>
        </div>
        <div>
          <dt>{t("compare-pdf.pages.checked.7f0722")}</dt>
          <dd>{result.pagesCompared}</dd>
        </div>
        <div>
          <dt>{t("compare-pdf.wording.that.matches.83d290")}</dt>
          <dd>{result.matchRatio === null ? t("compare-pdf.unavailable.ca1844") : t("compare-pdf.match.9d6f0a", { v0: result.matchRatio })}</dd>
        </div>
      </dl>
      <p className="tk-compare-summary-lines">
        {result.differentPages.length === 0
          ? result.identicalPageCount > 0
            ? t("compare-pdf.wording.matches.on.the.checked.pages.with.dcb9c6")
            : t("compare-pdf.these.pages.need.visual.comparison.inspect.the.80af94")
          : t("compare-pdf.the.wording.differs.on.page.pictures.layout.ae9fa8", { v1: result.differentPages.join(', '), count: result.differentPages.length })}
        {result.limitedToFirstFifty ? t("compare-pdf.only.the.first.50.common.pages.were.f8becd") : ''}
        {result.unavailablePages.length > 0 ? t("compare-pdf.text.could.not.be.compared.on.pages.09f2e2", { v0: result.unavailablePages.join(', ') }) : ''}
      </p>
    </section>
  ) : null;

  const pager = (
    <div className="tk-pager">
        <button
          type="button"
          aria-label={t("compare-pdf.previous.comparison.page.472b4c")}
          onClick={() => setPageIndex((value) => Math.max(0, value - 1))}
          disabled={pageIndex === 0}
          className="tk-iconbtn chef-pressable"
        >
          <ArrowLeft aria-hidden size={18} className="rtl:rotate-180" />
        </button>
        <span className="tk-compare-pagelabel tabular">{t("compare-pdf.message.477c22095a", { v0: pageIndex + 1, v1: maxPageCount })}</span>
        <button
          type="button"
          aria-label={t("compare-pdf.next.comparison.page.ce0d56")}
          onClick={() => setPageIndex((value) => Math.min(maxPageCount - 1, value + 1))}
          disabled={pageIndex >= maxPageCount - 1}
          className="tk-iconbtn chef-pressable"
        >
          <ArrowRight aria-hidden size={18} className="rtl:rotate-180" />
        </button>
    </div>
  );

  // Phone: the summary sits under the pager, in the canvas, where it has room to show whole
  // (fable-2 item 3); the pager is drawn inside so the summary can follow it.
  const body = (
    <PreviewFrame
      className="tk-compare"
      tools={<ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} max={MAX_ZOOM} />}
      pager={wide ? pager : undefined}
    >
      {previewError && (
        <div role="alert" className="tk-compare-error">
          <div className="flex items-start gap-2">
            <AlertTriangle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
            <p className="text-sm font-medium leading-5">{previewError}</p>
          </div>
          <button type="button" onClick={() => setPreviewAttempt((value) => value + 1)} className="tk-btn chef-pressable">
            <RefreshCw aria-hidden size={16} />
            <span>{t("compare-pdf.retry.preview.ceba35")}</span>
          </button>
        </div>
      )}
      <div ref={gestureRef} className="tk-compare-panes" style={{ touchAction }}>
        {[
          { name: file1.name, src: preview?.left, large: previewA, pdf: pdf1 },
          { name: file2.name, src: preview?.right, large: previewB, pdf: pdf2 },
        ].map((entry, index) => (
          <figure key={`${index}-${entry.name}`} className="tk-compare-pane">
            <figcaption className="chef-filename tk-compare-name" title={entry.name}>
              {entry.name}
            </figcaption>
            <div
              data-zoom-frame=""
              className={`tk-compare-page ${zoom > 1 ? 'touch-none cursor-grab active:cursor-grabbing' : ''}`}
              onPointerDown={handlePointerDown}
            >
              {previewLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--surface-raised)]/80">
                  <Loader2 aria-label={t("compare-pdf.loading.page.preview.73f2ff", { v0: pageIndex + 1 })} className="h-6 w-6 animate-spin text-[var(--accent-text)]" />
                </div>
              )}
              {entry.src && (
                // The page and its sharp layer move together, about the frame's centre.
                <div className="absolute inset-0 flex items-center justify-center will-change-transform" style={{ transform }}>
                  <img
                    src={entry.src}
                    alt={t("compare-pdf.page.of.477c22", { v0: pageIndex + 1, v1: entry.name })}
                    draggable={false}
                    className="select-none"
                  />
                  <SharpPageLayer source={{ pdfDoc: entry.pdf }} pageIndex={pageIndex} zoom={zoom > 1 ? zoom : undefined} transform={transform} fitted />
                </div>
              )}
              {zoom > 1 && isPanning && (
                <div className="tk-compare-synced">
                  <Move aria-hidden size={12} />{t("compare-pdf.synced.pan.5774cd")}</div>
              )}
              <PeekButton page={pageIndex + 1} label={t('queue-row.preview.file', { v0: entry.name })} onOpen={() => entry.large.open(pageIndex)} disabled={!entry.src} />
            </div>
          </figure>
        ))}
      </div>
      {!wide && pager}
      {!wide && summary}
      {previewA.modal}
      {previewB.modal}
    </PreviewFrame>
  );

  const action = (
    <button
      type="button"
      onClick={() => void handleExportReport()}
      disabled={reportLoading}
      aria-busy={reportLoading || undefined}
      className="tk-primary chef-pressable"
    >
      {reportLoading ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <Download aria-hidden size={18} />}
      <span>{t("compare-pdf.save.the.summary.64af76")}</span>
    </button>
  );

  return (
    <ToolScreen
      title={title}
      // Desktop: the two pages fill the canvas under the band. Phone: the panes scroll above a
      // foot sheet, because the summary needs the room (plan 2.22).
      kind={wide ? 'preview' : 'file'}
      className="tk-comparetool"
      heavyJob={{ bytes: (file1?.size ?? 0) + (file2?.size ?? 0), files: 2 }}
      change={<ChangeFile label={t("compare-pdf.choose.different.pdfs.ad084f")} onClick={reset} disabled={reportLoading} />}
      bodyLabel={title}
      body={body}
      sentence={statement}
      notice={wide ? <>{summary}{statusNotice}</> : statusNotice}
      action={action}
      toast={loadedToast}
    />
  );
};
