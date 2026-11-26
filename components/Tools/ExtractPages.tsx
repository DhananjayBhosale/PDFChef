import { formatPercent, t } from '../../services/i18n/core.ts';
import { useWide } from '../../hooks/useMediaQuery';
import { pdfFailureMessage, pdfProblemMessage } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorText } from '../UI/ErrorText';
import { v4 as uuidv4 } from 'uuid';
import { Download } from 'lucide-react';
import { PDFLoadingProgress } from '../UI/PDFLoadingProgress';
import { FileUpload } from '../UI/FileUpload';
import { PageThumbnail } from '../UI/PageThumbnail';
import { PageRangeSelector } from '../UI/PageRangeSelector';
import { StatusToast } from '../UI/StatusToast';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { ChipActions, Notice, ProgressLine } from '../Tool/parts';
import { PageGrid, type GridFit } from '../Tool/PageGrid';
import { usePagePreview } from '../Tool/PagePeek';
import { pagesPhrase, type PageKeys } from '../Tool/values';
import { PDFFile, ProcessingStatus } from '../../types';
import { extractPages, getPDFPageCount, loadDisposablePDFDocument, renderPageAsImage } from '../../services/pdfLazy';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { formatBytes, toolOutputName } from '../UI/format';

/** The page phrases this sentence owns (plan 2.1); literal keys for the localization check. */
const EXTRACT_PAGE_KEYS: PageKeys = {
  all: 'sentence.extract.pages.all',
  single: 'sentence.extract.pages.single',
  range: 'sentence.extract.pages.range',
  list: 'sentence.extract.pages.list',
  selected: 'sentence.extract.pages.selected',
  none: 'sentence.extract.pages.none',
};

/** Thumbnails are drawn at the scale the grid's tiles ask for (plan 2.4); small PDFs only. */
const DEFAULT_SCALE = 0.35;
const SHARP_PREVIEW_LIMIT = 24;
const NOMINAL_PAGE_WIDTH = 612;

export const ExtractPages: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  // Two fingers on a page, or its eye, open it large (pass 5).
  const preview = usePagePreview(file?.file, file?.name);
  const [pdfDoc, setPdfDoc] = useState<any | null>(null);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [rangePending, setRangePending] = useState(false);
  // A rejected typed range: the slot shows it in the error tone until the field changes.
  const [rangeRejected, setRangeRejected] = useState(false);
  const rangeRef = useRef<HTMLInputElement>(null);
  // Phone (owner decision 2026-11-15, item 1): a setting appears once, as a value in the sentence
  // whose card holds its control. Desktop keeps the control on the screen beside the sentence.
  const wide = useWide();
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [inspectingFile, setInspectingFile] = useState(false);
  const [thumbnailProgress, setThumbnailProgress] = useState<{ document: any; completed: number; total: number; active: number } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const fileInspectionRef = useRef(false);
  const activeJobControllerRef = useRef<AbortController | null>(null);
  const totalPages = file?.pageCount ?? 0;
  // Read when a thumbnail loads: the grid has measured its tiles by then.
  const thumbScaleRef = useRef(DEFAULT_SCALE);
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
          setThumbnailProgress({ document, completed: 0, total: 0, active: 0 });
          setLoadingPreviews(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error(error);
          setPreviewError(pdfProblemMessage(error) ?? t("extract-pages.the.pages.could.not.be.shown.choose.9884e4"));
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
    setInspectingFile(true);
    try {
      const pageCount = await getPDFPageCount(selected);
      if (pageCount < 1) throw new Error(t("split-pdf.selected.pdf.has.no.pages.3882f9"));
      setSelectedPages([]);
      setRangePending(false);
      setSelectionRevision(0);
      setPdfDoc(null);
      setFile({ id: uuidv4(), file: selected, name: selected.name, size: selected.size, pageCount });
    } catch (error) {
      // A damaged file gets the friendly line, not the engine's text (M-33).
      setStatus({ isProcessing: false, progress: 0, message: '', error: pdfFailureMessage(error, t('error.pdfUnreadable')) });
    } finally {
      fileInspectionRef.current = false;
      setInspectingFile(false);
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
    setThumbnailProgress(current => current?.document === pdfDoc ? { ...current, total: current.total + 1, active: current.active + 1 } : current);
    try {
      const rendered = await renderPageAsImage(pdfDoc, pageIndex, { format: 'image/jpeg', quality: 0.72, scale: thumbScaleRef.current });
      setThumbnailProgress(current => current?.document === pdfDoc ? { ...current, completed: current.completed + 1 } : current);
      return rendered.objectUrl;
    } finally {
      setThumbnailProgress(current => current?.document === pdfDoc ? { ...current, active: current.active - 1 } : current);
    }
  }), [pdfDoc, totalPages]);

  const onGridFit = useCallback((fit: GridFit) => {
    if (totalPages > SHARP_PREVIEW_LIMIT) return;
    const needed = (fit.tile * (window.devicePixelRatio || 1)) / NOMINAL_PAGE_WIDTH;
    thumbScaleRef.current = Math.min(1.5, Math.max(DEFAULT_SCALE, needed));
  }, [totalPages]);

  const resetRangeDraft = () => {
    setRangePending(false);
    setRangeRejected(false);
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
        toolOutputName('extract', sourceFile.name, 'pdf'),
        'application/pdf',
      );
      setStatus({ isProcessing: false, progress: 100, message: t("extract-pages.page.extracted.4dfc6c", { count: pages.length }) });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: pdfFailureMessage(error, t("extract-pages.the.selected.pages.could.not.be.extracted.d4ba78")) });
    } finally {
      if (activeJobControllerRef.current === controller) activeJobControllerRef.current = null;
    }
  };

  const title = t("extract-pages.extract.pages.1ea574");
  const toast = <StatusToast status={status} />;

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("extract-pages.choose.a.pdf.to.extract.pages.e82bf1")} />
            {inspectingFile && <PDFLoadingProgress />}
          </div>
        )}
        toast={toast}
      />
    );
  }

  const pages = pagesPhrase(EXTRACT_PAGE_KEYS, selectedPages, totalPages);
  const noticeId = `extract-notice-${file.id}`;

  // Today's typed field and Select: on the screen at rest on desktop (owner decision 1), in the
  // slot's card on a phone, so the setting shows once (owner decision 2026-11-15).
  const rangeField = (
    <PageRangeSelector
      key={`${file.id}-${selectionRevision}`}
      totalPages={totalPages}
      disabled={status.isProcessing}
      onApply={applyPageRange}
      onPendingChange={setRangePending}
      onDraftChange={(_draft, invalid) => setRangeRejected(invalid)}
      // A valid range enables Export as it is typed (research r2, H2-02).
      live
      inputRef={rangeRef}
      hideLabel
      compact
    />
  );

  const sentence = (
    <Sentence
      template={selectedPages.length ? 'sentence.extract.someExport' : 'sentence.extract.noneExport'}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      slots={{
        pages: {
          label: t('page-range-selector.label'),
          text: pages.text,
          bidi: pages.ltr ? 'ltr' : undefined,
          // Only the chosen pages: a rejected range stays in the field with its error line.
          ...(rangePending ? { tone: 'pending' as const } : {}),
          ...(wide ? { focusTarget: () => rangeRef.current } : { editor: rangeField }),
        },
      }}
    />
  );

  const chips = (
    <>
    {wide && rangeField}
    <ChipActions
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
    </>
  );

  // A rejected range: the field's own error line says what is wrong, so no "Press Select" here.
  const notice = rangePending && !rangeRejected ? <Notice tone="pending" id={noticeId}>{t('page-range-selector.pending.select')}</Notice> : null;

  const runLabel = (
    <>
      <Download aria-hidden size={18} />
      {/* Nothing chosen: what to do, not "Export 0 selected pages" (review 2, item 17). */}
      <span>{selectedPages.length ? t("extract-pages.message.2f2b9d8bc2", { count: selectedPages.length }) : t('extract-pages.chooseToExport')}</span>
    </>
  );

  const progress = status.isProcessing ? (
    <ProgressLine label={status.message} percent={formatPercent(status.progress)} value={status.progress} />
  ) : undefined;

  const body = (
    <>
      {preview.modal}
      <h2 id="extract-pages-heading" className="sr-only">{title}</h2>
      {/* The slot shows the choice; this line speaks today's count when it changes. */}
      <p className="sr-only" role="status" aria-live="polite">{t("extract-pages.of.selected.2d057c", { v0: selectedPages.length, v1: totalPages })}</p>
      {thumbnailProgress?.document === pdfDoc && thumbnailProgress.active > 0 && <PDFLoadingProgress progress={thumbnailProgress} lazy />}
      {loadingPreviews ? (
        <PDFLoadingProgress />
      ) : previewError ? (
        <div role="alert" className="tk-grid-state tk-grid-error"><ErrorText text={previewError} file={file?.file} /></div>
      ) : totalPages === 0 ? (
        <p className="tk-grid-state">{t("extract-pages.this.pdf.has.no.pages.in.it.8c754b")}</p>
      ) : (
        <PageGrid count={totalPages} onFit={onGridFit} gestureRef={preview.pinchRef}>
          {Array.from({ length: totalPages }, (_, index) => (
            <div key={index} className="tk-peekbox" data-peek-page={index}>
              <PageThumbnail
                pageIndex={index}
                loadPreview={pagePreviewLoaders[index]}
                isSelected={selectedPageSet.has(index)}
                onToggle={() => togglePage(index)}
                disabled={status.isProcessing}
              />
              {preview.peek(index)}
            </div>
          ))}
        </PageGrid>
      )}
    </>
  );

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: <>{t('format.pageCount', { count: totalPages })} · {formatBytes(file.size)}</> }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={reset} disabled={status.isProcessing} />}
      kind="grid"
      bodyLabelledBy="extract-pages-heading"
      body={body}
      sentence={sentence}
      chips={chips}
      notice={notice}
      onRun={() => void handleExtract()}
      runDisabled={!canExtract}
      runDescribedBy={notice ? noticeId : undefined}
      runLabel={runLabel}
      progress={progress}
      toast={toast}
    />
  );
};
