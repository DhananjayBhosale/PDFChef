import { formatPercent } from '../../services/i18n/core.ts';
import { useWide } from '../../hooks/useMediaQuery';
import { EnterCloses } from '../Tool/Popover';
import { localizeError, pdfFailureMessage } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFLoadingProgress } from '../UI/PDFLoadingProgress';
import { PDFFile, ProcessingStatus } from '../../types';
import { extractPages, getPDFPageCount, getPdfPagePreviews, splitPDFByMaximumSize, splitPDFByPagesPerFile, type PdfPreviewProgress, type SplitResult } from '../../services/pdfLazy';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { Download, RefreshCw, Scissors } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { PageThumbnail } from '../UI/PageThumbnail';
import { PageRangeSelector } from '../UI/PageRangeSelector';
import { StatusToast } from '../UI/StatusToast';
import { SegmentedControl } from '../UI/Primitives';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { Notice, ProgressLine, Stepper } from '../Tool/parts';
import { PageGrid, type GridFit } from '../Tool/PageGrid';
import { usePagePreview } from '../Tool/PagePeek';
import { pagesPhrase, type PageKeys } from '../Tool/values';
import { formatBytes, toolOutputName } from '../UI/format';
import { useRemembered } from '../Tool/useRemembered';
import { ToggleValue } from '../Tool/ToggleValue';
import { useWorkspacePlatform } from '../../hooks/useWorkspaceRuntime';
import { getWorkspaceSettings } from '../../services/workspace';
import { pickSeparateFolder, separatePath } from '../../services/saveSeparately';
import { DEFAULT_SPLIT_DELIVERY, isSplitDelivery, resolveSplitDelivery, splitDeliveryLine, type SplitDelivery } from './splitDelivery';

type SplitMode = 'pageCount' | 'maximumSize';

/** The page phrases this sentence owns (plan 2.1); literal keys for the localization check. */
const SPLIT_PAGE_KEYS: PageKeys = {
  all: 'sentence.split.pages.all',
  single: 'sentence.split.pages.single',
  range: 'sentence.split.pages.range',
  list: 'sentence.split.pages.list',
  selected: 'sentence.split.pages.selected',
};

/** Preview render scales: a grid that draws tiles larger than the bitmap asks for the next one. */
const PREVIEW_SCALES = [0.3, 0.6, 1, 1.5] as const;
/** Above this many pages the previews keep today's scale (memory). */
const SHARP_PREVIEW_LIMIT = 24;
type ActiveJob = 'split' | 'extract' | null;

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const SplitPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  // Two fingers on a page, or its eye, open it large (pass 5).
  const preview = usePagePreview(file?.file, file?.name);
  const [previews, setPreviews] = useState<string[]>([]);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [rangePending, setRangePending] = useState(false);
  // A rejected typed range: the slot shows it in the error tone until the field changes.
  const [rangeRejected, setRangeRejected] = useState(false);
  const rangeRef = useRef<HTMLInputElement>(null);
  const countRef = useRef<HTMLInputElement>(null);
  // Phone (owner decision 2026-11-15, item 1): a setting appears once, as a value in the sentence
  // whose card holds its control. Desktop keeps the control on the screen beside the sentence.
  const wide = useWide();
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [splitMode, setSplitMode] = useRemembered<SplitMode>('mode', 'pageCount', (value) => value === 'pageCount' || value === 'maximumSize');
  const [pagesPerSplit, setPagesPerSplit] = useRemembered<string>('pagesPerFile', '1');
  const [maximumSizeMb, setMaximumSizeMb] = useRemembered<string>('maximumSizeMb', '10');
  // Separate PDFs or one ZIP (owner decision 2026-11-17). Hidden where parts cannot be saved one by
  // one (the iOS app): there the parts arrive in one ZIP, as before. Untouched it is 'auto'
  // (overnight A10); every reader below uses the resolved `effectiveDelivery`.
  const [storedDelivery, setDelivery] = useRemembered<SplitDelivery>('delivery', DEFAULT_SPLIT_DELIVERY, isSplitDelivery);
  const platform = useWorkspacePlatform();
  const separateSavePath = useMemo(() => separatePath(platform), [platform]);
  const deliveryRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const [activeJob, setActiveJob] = useState<ActiveJob>(null);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<PdfPreviewProgress | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  // The scale the previews were drawn at, and the scale the grid's tiles ask for (plan 2.4).
  const loadedScaleRef = useRef<number>(PREVIEW_SCALES[0]);
  const [wantedScale, setWantedScale] = useState<number>(PREVIEW_SCALES[0]);
  const [pageWidthPoints, setPageWidthPoints] = useState(0);
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
    loadedScaleRef.current = PREVIEW_SCALES[0];
    setWantedScale(PREVIEW_SCALES[0]);
    getPdfPagePreviews(file.file, {
      scale: PREVIEW_SCALES[0],
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
        // A damaged file gets the friendly line, not the engine's text (M-33).
        error: pdfFailureMessage(error, error instanceof Error ? t('error.pdfUnreadable') : t("split-pdf.unable.to.open.this.pdf.9c2826")),
      });
    } finally {
      fileInspectionRef.current = false;
      setInspectingFile(false);
    }
  };

  const togglePage = (index: number) => {
    if (status.isProcessing || totalPages <= 0) return;
    setRangePending(false);
    setRangeRejected(false);
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
    setRangeRejected(false);
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
  // A fraction ("0.5") is kept as typed and refused in words; it used to lose its point and
  // become 5 MB (round 6, mobile-02).
  const maximumSizeError = !maximumSizeMb || !Number.isSafeInteger(parsedMaximumSizeMb)
    ? t("split-pdf.enter.a.maximum.file.size.in.whole.0ae395")
    : parsedMaximumSizeMb < 1
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

  // The line under the sentence: how many parts, and whether they are saved separately or as one
  // ZIP. A split by size cannot count its parts in advance.
  const deliveryPartCount = splitMode === 'pageCount' ? estimatedPartCount : effectiveSelectedPages.length === 1 ? 1 : null;
  const deliveryLine = splitDeliveryLine(separateSavePath, deliveryPartCount);
  // The choice in effect: the person's own pick, or (untouched) one ZIP above 10 downloads or share items.
  const delivery = resolveSplitDelivery(storedDelivery, separateSavePath, deliveryPartCount);

  const deliverSplitResult = (result: SplitResult, sourceFile: PDFFile, separately: boolean, folder?: FileSystemDirectoryHandle) => {
    if (result.isArchive) {
      // The ZIP stays the result (strip, sheet, Recent); with "separate PDFs" its parts are saved
      // instead of it (the strip's "Save N files separately", run at once).
      downloadBlob(
        result.blob,
        toolOutputName('split', sourceFile.name, 'zip'),
        undefined,
        separately ? { separateSave: folder ? { folder } : {} } : undefined,
      );
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
    // Nothing is saved automatically when the person turned that off; then the choice has nothing to do.
    const separately = Boolean(deliveryLine) && delivery === 'separate' && getWorkspaceSettings().autoDownload;
    let folder: FileSystemDirectoryHandle | undefined;
    if (separately && separateSavePath === 'folder') {
      // The folder picker needs this tap; the split finishes later (h3 F1 in pdfShared.ts).
      // Dismissing it starts nothing. A picker that fails leaves the choice to the result sheet.
      try {
        const picked = await pickSeparateFolder();
        if (!picked) return;
        folder = picked;
      } catch (error) {
        console.warn('The folder picker failed; the result sheet offers the parts instead.', error);
      }
      if (activeJobControllerRef.current) return;
    }
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
      deliverSplitResult(result, sourceFile, separately, folder);
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

  // Where parts cannot be saved one by one (the iOS app) the line keeps today's consequence:
  // more than one part arrives as a single ZIP, not as several PDFs.
  const footerSummary = splitMode === 'pageCount' && estimatedPartCount > 1
    ? t("split-pdf.pdfs.download.together.in.one.zip.795019", { v0: estimatedPartCount })
    : '';

  // Sharper thumbnails when the grid draws tiles wider than the preview bitmap (plan 2.4).
  useEffect(() => {
    const first = previews[0];
    if (!first) return undefined;
    let alive = true;
    const image = new Image();
    image.onload = () => { if (alive && image.naturalWidth) setPageWidthPoints(image.naturalWidth / loadedScaleRef.current); };
    image.src = first;
    return () => { alive = false; };
  }, [previews]);

  const onGridFit = useCallback((fit: GridFit) => {
    if (totalPages > SHARP_PREVIEW_LIMIT || !pageWidthPoints) return;
    const needed = (fit.tile * (window.devicePixelRatio || 1)) / pageWidthPoints;
    const next = PREVIEW_SCALES.find((scale) => scale >= needed) ?? PREVIEW_SCALES[PREVIEW_SCALES.length - 1];
    setWantedScale((current) => Math.max(current, next));
  }, [pageWidthPoints, totalPages]);

  useEffect(() => {
    if (!file || loadingPreviews || previewError || !previews.length || wantedScale <= loadedScaleRef.current) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    const scale = wantedScale;
    getPdfPagePreviews(file.file, { scale, signal: controller.signal })
      .then((urls) => {
        if (cancelled) { revokeObjectUrls(urls); return; }
        loadedScaleRef.current = scale;
        setPreviews(urls);
      })
      .catch(() => { /* the smaller previews stay */ });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `previews` changes when this effect itself succeeds; the scale check stops a second run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, loadingPreviews, previewError, wantedScale]);

  const title = t("split-pdf.split.pdf.4f1b84");
  const toast = <StatusToast status={status} />;

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("split-pdf.choose.a.pdf.to.split.90f382")} />
            {inspectingFile && <PDFLoadingProgress />}
          </div>
        )}
        toast={toast}
      />
    );
  }

  const selectionSummary = allPagesIncluded
    ? t("split-pdf.all.pages.included.6d0a41", { v0: totalPages })
    : t("split-pdf.of.pages.included.d15033", { v0: effectiveSelectedPages.length, v1: totalPages });
  const showExtract = selectedPages.length > 0 && effectiveSelectedPages.length < totalPages;
  const countLabel = splitMode === 'pageCount' ? t("split-pdf.pages.per.output.pdf.b5ce50") : t("split-pdf.maximum.file.size.mb.85e619");
  const countValue = splitMode === 'pageCount' ? pagesPerSplit : maximumSizeMb;
  const count = Number(countValue);
  const validCount = countValue !== '' && Number.isSafeInteger(count) && count >= 1;
  // One page cannot go "into files" (pass 5, item 6): it is saved as its own PDF. The size setting
  // has nothing to do then, so the sentence leaves it out (review 2, item 4); it comes back with a
  // second page, and stays beside the sentence on desktop. An invalid size keeps the split form, so
  // the error that holds the action is still on screen.
  // In "max file size" mode the limit still applies to one page (a page over it is refused), so the
  // size stays in the sentence there and the split form is kept (s3-03).
  const onePageSelected = effectiveSelectedPages.length === 1 && !settingsError;
  const onePage = onePageSelected && splitMode === 'pageCount';
  // One file comes out: the action says so.
  const oneOutput = onePageSelected || (splitMode === 'pageCount' && estimatedPartCount === 1);
  // An invalid typed value shows as typed, in the error style (DESIGN.md "Sentences").
  const sizeText = countValue !== '' && !validCount ? countValue
    : splitMode === 'pageCount'
      ? (validCount ? t('sentence.split.size.pages', { count }) : t('sentence.split.size.pagesUnset'))
      : (validCount ? t('sentence.split.size.megabytes', { count }) : t('sentence.split.size.megabytesUnset'));
  const pages = pagesPhrase(SPLIT_PAGE_KEYS, effectiveSelectedPages, totalPages);
  const stepCount = (delta: 1 | -1) => {
    if (status.isProcessing) return;
    const set = splitMode === 'pageCount' ? setPagesPerSplit : setMaximumSizeMb;
    set((current) => {
      const value = Number(current.replace(',', '.'));
      const base = Number.isFinite(value) ? (delta > 0 ? Math.floor(value) : Math.ceil(value)) : 0;
      return String(Math.max(1, base + delta));
    });
  };

  const countInput = (
    <input
      ref={countRef}
      value={countValue}
      onChange={(event) => (splitMode === 'pageCount' ? setPagesPerSplit : setMaximumSizeMb)(event.target.value.replace(/[^\d.,]/g, ''))}
      disabled={status.isProcessing}
      className="chef-field tk-num disabled:opacity-55"
      inputMode="numeric"
      min="1"
      step="1"
    />
  );

  // The method and its number sit on the screen beside the range field on desktop (owner decision
  // D-3 (b)), and in the size slot's card on a phone, so the setting shows once (owner decision
  // 2026-11-15). The slot reads them back. The caution is the notice line's (M-10).
  const sizeInline = (
    <div className="tk-split-size">
      <SegmentedControl
        fit
        className="tk-seg"
        label={t("split-pdf.split.method.400c8a")}
        value={splitMode}
        options={[
          { value: 'pageCount', label: t("split-pdf.pages.per.file.436b5b") },
          { value: 'maximumSize', label: t("split-pdf.max.file.size.5a4e0f") },
        ]}
        onChange={(next) => { if (!status.isProcessing) setSplitMode(next as SplitMode); }}
      />
      <Stepper
        label={countLabel}
        field={<label className="tk-field"><span className="sr-only">{countLabel}</span>{countInput}</label>}
        onStep={stepCount}
        disabled={status.isProcessing}
        decreaseDisabled={!validCount || count <= 1}
      />
    </div>
  );

  // Today's typed field and Select: on the screen at rest on desktop (owner decision 1), in the
  // "Pages to include" card on a phone (owner decision 2026-11-15). The slot reads the choice back.
  const rangeField = (
    <PageRangeSelector
      key={`${file.id}-${selectionRevision}`}
      totalPages={totalPages}
      disabled={status.isProcessing}
      onApply={applyPageRange}
      onPendingChange={setRangePending}
      onDraftChange={(_draft, invalid) => setRangeRejected(invalid)}
      // A valid range enables Save as it is typed, as in Extract (h1-01).
      live
      inputRef={rangeRef}
      hideLabel
      compact
    />
  );
  // One line, the first that applies (D10): today's settings error, the pending line, then the save
  // choice or the outcome. An open card repeats only the error or pending line: the choice is a
  // control and shows once.
  const noticeId = `split-notice-${file.id}`;
  const editorLine = settingsError
    ? <Notice tone="error" role="alert" id={noticeId}>{settingsError}</Notice>
    : rangePending && !rangeRejected
      ? <Notice tone="pending" id={noticeId}>{t('page-range-selector.pending.select')}</Notice>
      : null;
  const deliveryLabel = t('split.delivery.label');
  const deliveryOptions = [
    { value: 'separate' as const, label: t('split.delivery.separate.option') },
    { value: 'zip' as const, label: t('split.delivery.zip.option') },
  ];
  // The choice as a one-slot line (owner decision 2026-11-17). Phone: the words are the two radios
  // and a tap switches them. Desktop: the radios are beside the sentence and the slot reads them,
  // as PowerPoint to PDF's orientation and OCR's mode do. It does not change the result, only how
  // it is saved, so it is not part of the work an earlier result is compared with.
  const deliveryChoice = deliveryLine && (
    <Sentence
      template={deliveryLine.template}
      groupLabel={deliveryLabel}
      disabled={status.isProcessing}
      compact
      work={false}
      slots={{
        delivery: {
          label: deliveryLabel,
          text: delivery === 'zip' ? deliveryLine.zip : deliveryLine.separate,
          ...(wide
            ? { focusTarget: () => deliveryRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? null }
            : {
              inline: (
                <ToggleValue
                  label={deliveryLabel}
                  value={delivery}
                  onChange={setDelivery}
                  disabled={status.isProcessing}
                  options={[
                    { ...deliveryOptions[0], text: deliveryLine.separate },
                    { ...deliveryOptions[1], text: deliveryLine.zip },
                  ]}
                />
              ),
            }),
        },
      }}
    />
  );
  // Desktop: under "Save the split files", in the band's end column, so it adds no row to the band.
  const deliverySegments = wide && deliveryLine && (
    <div ref={deliveryRef} className="tk-choice-seg" data-work-ignore="">
      <SegmentedControl
        fit
        className="tk-seg"
        label={deliveryLabel}
        value={delivery}
        options={deliveryOptions}
        onChange={(next) => { if (!status.isProcessing) setDelivery(next); }}
      />
    </div>
  );

  const sentence = (
    <Sentence
      template={onePage ? 'sentence.split.onePageAlone' : splitMode === 'pageCount' ? 'sentence.split.byPages' : 'sentence.split.bySize'}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      slots={{
        pages: {
          label: t("split-pdf.pages.to.include.225127"),
          notice: editorLine,
          text: pages.text,
          bidi: pages.ltr ? 'ltr' : undefined,
          // Only the chosen pages: a rejected range stays in the field with its error line.
          tone: rangePending ? 'pending' : undefined,
          ...(wide ? { focusTarget: () => rangeRef.current } : { editor: rangeField }),
        },
        ...(onePage ? {} : { size: {
          label: splitMode === 'pageCount' ? t("split-pdf.pages.per.file.436b5b") : t("split-pdf.max.file.size.5a4e0f"),
          text: sizeText,
          tone: settingsError ? 'error' : undefined,
          notice: editorLine,
          ...(wide ? { focusTarget: () => countRef.current } : { editor: <EnterCloses valid={validCount}>{sizeInline}</EnterCloses> }),
        } }),
      }}
    />
  );

  const outcome = splitMode === 'pageCount'
    ? estimatedPartCount > 1 ? footerSummary : estimatedPartCount === 1 ? t('split.outcome.onePdf') : ''
    : '';
  // Today's caution stays on the screen while Max file size is on (M-10), under the choice.
  const caution = <Notice tone="caution" id={deliveryChoice ? undefined : noticeId}>{t("split-pdf.if.one.page.is.larger.than.the.098718")}</Notice>;
  const notice = editorLine
    ?? (splitMode === 'maximumSize'
      ? (deliveryChoice ? <>{deliveryChoice}{caution}</> : caution)
      : deliveryChoice || (outcome ? <Notice id={noticeId}>{outcome}</Notice> : null));

  const chips = (
    <>
      {wide && rangeField}
      {wide && sizeInline}
      {!allPagesIncluded && (
        <button type="button" onClick={useAllPages} disabled={status.isProcessing} className="tk-chip chef-pressable">
          {t("split-pdf.use.all.pages.7dd824")}
        </button>
      )}
      {showExtract && (
        <button
          type="button"
          onClick={() => void handleExtractSelected()}
          disabled={!canExtractSelection || rangePending}
          className="tk-chip chef-pressable"
          // Starts a job too: the heavy-job warning asks before it (ToolScreen).
          data-heavy-action=""
        >
          <Download aria-hidden size={15} />
          {t("split-pdf.message.eff1a10749", { count: effectiveSelectedPages.length })}
        </button>
      )}
    </>
  );

  const action = (
    <button
      type="button"
      onClick={handleExport}
      disabled={!canExport}
      aria-describedby={!canExport && (settingsError || (rangePending && !rangeRejected)) ? noticeId : undefined}
      className="tk-primary chef-pressable"
    >
      <Scissors aria-hidden size={18} />
      <span>{oneOutput ? t('split-pdf.save.the.pdf') : t("split-pdf.save.the.split.files.33c422")}</span>
    </button>
  );

  const progress = status.isProcessing ? (
    <ProgressLine
      label={activeJob === 'extract' ? t("split-pdf.extracting.pages.7e290c") : t("split-pdf.processing.your.pdf.b14adc")}
      detail={status.message}
      percent={formatPercent(status.progress)}
      value={status.progress}
      cancel={(
        <button
          type="button"
          onClick={cancelJob}
          disabled={activeJobControllerRef.current?.signal.aborted}
          className="tk-btn chef-pressable"
        >
          {activeJobControllerRef.current?.signal.aborted ? t("split-pdf.cancelling.7b2613") : t("split-pdf.cancel.19766e")}
        </button>
      )}
    />
  ) : undefined;

  const body = (
    <>
      {preview.modal}
      <h2 id="split-pages-heading" className="tk-cap">{t("split-pdf.pages.to.include.225127")}</h2>
      {/* The slot shows the choice; this line speaks it when it changes. */}
      <p className="sr-only" role="status" aria-live="polite">{selectionSummary}</p>
      {loadingPreviews ? <PDFLoadingProgress progress={previewProgress} /> : previewError ? (
        <div role="status" className="flex flex-col items-center justify-center px-4 py-6 text-center">
          <p className="font-semibold text-[var(--text-primary)]">{t("split-pdf.page.previews.are.unavailable.318997")}</p>
          <p className="mt-1 max-w-measure text-sm text-[var(--text-secondary)]">{t("split-pdf.message.a68d961425", { v0: previewError })}</p>
          <button
            type="button"
            onClick={() => setPreviewReloadKey((current) => current + 1)}
            className="tk-btn chef-pressable mt-3"
          >
            <RefreshCw aria-hidden size={17} />{t("split-pdf.retry.previews.7e9483")}</button>
        </div>
      ) : previews.length > 0 ? (
        <PageGrid count={previews.length} onFit={onGridFit} gestureRef={preview.pinchRef}>
          {previews.map((url, index) => (
            <div key={index} className="tk-peekbox" data-peek-page={index}>
              <PageThumbnail
                pageIndex={index}
                imageUrl={url}
                isSelected={selectedPageSet.has(index)}
                onToggle={() => togglePage(index)}
                disabled={status.isProcessing}
              />
              {preview.peek(index)}
            </div>
          ))}
        </PageGrid>
      ) : (
        <p className="tk-grid-state">{t("split-pdf.the.pages.could.not.be.shown.here.a4b115")}</p>
      )}
    </>
  );

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: <>{t('format.pageCount', { count: totalPages })} · {formatBytes(file.size)}</> }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={changeFile} disabled={status.isProcessing} />}
      kind="grid"
      bodyLabelledBy="split-pages-heading"
      body={body}
      sentence={sentence}
      chips={chips}
      notice={notice}
      action={action}
      endControl={deliverySegments}
      progress={progress}
      toast={toast}
    />
  );
};
