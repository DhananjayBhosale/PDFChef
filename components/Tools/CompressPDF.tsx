import { formatPercent } from '../../services/i18n/core.ts';
import { datedOutputName, formatBytes as formatSize, sanitizeFilenameStem, splitFilename } from '../UI/format';
import { classifyPdfError, pdfProblemMessage } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { getInterpolatedConfig, type AdaptiveConfig } from '../../services/pdfCompressionConfig';
import { downloadBlob } from '../../services/pdfShared';
import { loadJSZip, pdfFileProblem } from '../../services/pdfLazy';
import { reserveArchiveName } from '../../services/pdfToolResults';
import { useWorkspacePlatform } from '../../hooks/useWorkspaceRuntime';
import { Layers, Loader2, AlertTriangle, Eye, Trash2, X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { StatusToast } from '../UI/StatusToast';
import { ChefSlider } from '../UI/ChefSlider';
import { getWorkspaceSettings, recordSavings } from '../../services/workspace';
import { useWide } from '../../hooks/useMediaQuery';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { Notice, ProgressLine, useAnnouncer } from '../Tool/parts';
import { setNextOutputDetail } from '../UI/outputNote';
import { FilePreview } from '../Tool/FilePreview';
import { useRemembered } from '../Tool/useRemembered';


const ReadabilityPreview = React.lazy(() => import('./ReadabilityPreview').then((module) => ({
  default: module.ReadabilityPreview,
})));

/** The slider stop that lands on a given DPI, for the three preset chips. */
const sliderForDPI = (dpi: number, isTextHeavy: boolean): number => {
  const minDPI = isTextHeavy ? 96 : 72;
  return Math.max(0, Math.min(100, ((dpi - minDPI) / (300 - minDPI)) * 100));
};

const PRESET_DPI = { Low: 72, Medium: 144, High: 200 } as const;
type PresetName = keyof typeof PRESET_DPI;

/** Low, medium or high: the word the sentence and the card show, and the preset chip that is selected. */
const qualityBand = (dpi: number): PresetName => (dpi < 110 ? 'Low' : dpi < 175 ? 'Medium' : 'High');
const qualityLabel = (dpi: number): string => ({ Low: t("compress-pdf.low.f793de"), Medium: t("compress-pdf.medium.8e588c"), High: t("compress-pdf.high.c4ebc6") })[qualityBand(dpi)];

/** A cancelled run: thrown from the progress callback, so the compressor stops at its next page. */
const cancelledRun = () => new DOMException('cancelled', 'AbortError');

export const CompressPDF: React.FC = () => {
  useI18n();
  const platform = useWorkspacePlatform();
  const wide = useWide();
  const [files, setFiles] = useState<PDFFile[]>([]);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);

  /**
   * The last run made nothing smaller, so nothing was written (T-01). The result itself goes
   * straight to the standard strip and sheet, like every other tool: Download is one press away.
   */
  const [skipped, setSkipped] = useState(false);
  /** Cancel pressed: the running compressor stops at its next page (T-05). */
  const cancelRef = useRef(false);
  // Leaving the tool discards its files, as its question says: a running job stops with it.
  useEffect(() => () => { cancelRef.current = true; }, []);
  const [cancelling, setCancelling] = useState(false);
  /** The last run was cancelled: said once to screen readers and shown until the next run (r4 desktop-05). */
  const [cancelled, setCancelled] = useState(false);
  const [announcer, announce] = useAnnouncer();

  const [showPreview, setShowPreview] = useState(false);
  const [previewConfig, setPreviewConfig] = useState<AdaptiveConfig | null>(null);

  const [analysis, setAnalysis] = useState<{
    byId: Record<string, boolean>;
    pageCountById: Record<string, number>;
    isTextHeavy: boolean;
    done: boolean;
  }>({ byId: {}, pageCountById: {}, isTextHeavy: false, done: false });

  /** 0–100, the same axis the preview's own slider uses. Medium to start. */
  const [quality, setQuality] = useRemembered<number>('quality', 32, (value) => value >= 0 && value <= 100);
  /** On by default, as Help promises: text stays searchable and copyable, and only
      embedded photos are re-encoded. Turning it off makes every page a picture. */
  const [keepText, setKeepText] = useRemembered<boolean>('keepText', true);

  /** Sizes measured by encoding real pages, per preset and for the live slider. */
  const [presetSizes, setPresetSizes] = useState<Partial<Record<PresetName, number>>>({});
  const [measuredEstimate, setMeasuredEstimate] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const measureToken = useRef(0);

  // Analysing, previewing and compressing all open the file through the shared document cache;
  // closing the tool is what lets those documents, and their workers, go.
  // The release starts in the same tick the tool closes, so a next screen that picks up the same
  // file afterwards is counted and keeps its document.
  const heldFiles = useRef(files);
  heldFiles.current = files;
  const pdfBrowser = useRef<typeof import('../../services/pdfBrowser') | null>(null);
  useEffect(() => () => {
    const held = heldFiles.current;
    if (held.length === 0) return;
    const release = (module: typeof import('../../services/pdfBrowser')) => {
      held.forEach(({ file }) => void module.releasePDFDocument(file).catch(() => undefined));
    };
    if (pdfBrowser.current) release(pdfBrowser.current);
    else void import('../../services/pdfBrowser').then(release);
  }, []);

  const previewFiles = useMemo(
    () => files.map((selectedFile) => ({ file: selectedFile.file, name: selectedFile.name })),
    [files],
  );

  useEffect(() => {
    let cancelled = false;

    if (files.length > 0) {
      setSkipped(false);
      setCancelled(false);
      setShowPreview(false);
      setAnalysis({ byId: {}, pageCountById: {}, isTextHeavy: false, done: false });
      setPresetSizes({});
      setMeasuredEstimate(null);

      void import('../../services/pdfBrowser')
        .then((module) => {
          pdfBrowser.current = module;
          return module;
        })
        .then(({ analyzePDF }) => Promise.all(files.map(async (selectedFile) => {
          const result = await analyzePDF(selectedFile.file);
          return [selectedFile.id, result] as const;
        })))
        .then((entries) => {
          if (cancelled) return;

          setAnalysis({
            byId: Object.fromEntries(entries.map(([id, result]) => [id, result.isTextHeavy])),
            pageCountById: Object.fromEntries(entries.map(([id, result]) => [id, result.pageCount])),
            isTextHeavy: entries.some(([, result]) => result.isTextHeavy),
            done: true,
          });
        })
        .catch(() => {
          if (cancelled) return;
          setAnalysis({ byId: {}, pageCountById: {}, isTextHeavy: false, done: true });
        });
    } else {
      setAnalysis({ byId: {}, pageCountById: {}, isTextHeavy: false, done: false });
      setPresetSizes({});
      setMeasuredEstimate(null);
    }

    return () => {
      cancelled = true;
    };
  }, [files]);

  const handleFilesSelected = async (selected: File[]) => {
    const pdfFiles = selected.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    const skippedCount = selected.length - pdfFiles.length;

    if (pdfFiles.length === 0) {
      setUploadWarning(t("compress-pdf.only.pdf.files.are.supported.87db25"));
      return;
    }

    setUploadWarning(skippedCount > 0
      ? t("compress-pdf.skipped.only.pdf.files.are.supported.ec7ff0", { count: skippedCount })
      : null
    );

    // The keep-text choice is left as the person set it.
    setStatus({ isProcessing: false, progress: 0, message: '' });

    setFiles(pdfFiles.map((f) => ({
      id: uuidv4(),
      file: f,
      name: f.name,
      size: f.size,
      pageCount: 0,
    })));
  };

  const config = useMemo(
    () => getInterpolatedConfig(quality, analysis.isTextHeavy),
    [quality, analysis.isTextHeavy],
  );

  const totalOriginalSize = files.reduce((total, selectedFile) => total + selectedFile.size, 0);

  /** Encode a sample of real pages for every file and add the results up. */
  const measureAll = useCallback(
    async (candidate: AdaptiveConfig, maxSamples: number): Promise<number> => {
      const { measureProjectedSize } = await import('../../services/pdfBrowser');
      const sizes = await Promise.all(
        files.map((selectedFile) => measureProjectedSize(selectedFile.file, candidate, { maxSamples })),
      );
      // A file that could not be sampled contributes nothing rather than a guess,
      // which would leave the total somewhere between measured and invented.
      return sizes.some((size) => size <= 0) ? 0 : sizes.reduce((total, size) => total + size, 0);
    },
    [files],
  );

  // The three presets, measured once per document. Two pages each is enough to
  // tell a scan from a text page and keeps a long document responsive.
  useEffect(() => {
    if (files.length === 0 || !analysis.done || keepText) return;
    let cancelled = false;

    void (async () => {
      for (const name of Object.keys(PRESET_DPI) as PresetName[]) {
        const stop = sliderForDPI(PRESET_DPI[name], analysis.isTextHeavy);
        const size = await measureAll(getInterpolatedConfig(stop, analysis.isTextHeavy), 2);
        if (cancelled) return;
        if (size > 0) setPresetSizes((current) => ({ ...current, [name]: size }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [files, analysis.done, analysis.isTextHeavy, keepText, measureAll]);

  // The live estimate follows the slider, debounced so a drag does not queue a
  // page render per pixel.
  useEffect(() => {
    if (files.length === 0 || !analysis.done || keepText) {
      setMeasuredEstimate(null);
      return;
    }

    const token = measureToken.current + 1;
    measureToken.current = token;
    setMeasuring(true);

    const timer = window.setTimeout(() => {
      void measureAll(config, 2).then((size) => {
        if (measureToken.current !== token) return;
        setMeasuredEstimate(size > 0 ? size : null);
        setMeasuring(false);
      });
    }, 220);

    return () => {
      window.clearTimeout(timer);
    };
  }, [config, files.length, analysis.done, keepText, measureAll]);

  const estimatedReduction = totalOriginalSize > 0 && measuredEstimate
    ? Math.max(0, Math.round(((totalOriginalSize - measuredEstimate) / totalOriginalSize) * 100))
    : 0;

  const presets = (Object.keys(PRESET_DPI) as PresetName[]).map((name) => {
    const stop = sliderForDPI(PRESET_DPI[name], analysis.isTextHeavy);
    // The chip of the word the sentence says is selected, so "medium" always has its chip
    // (iOS sync, 2026-11-15: a text-heavy file said "medium" with no chip selected).
    return { name, stop, size: presetSizes[name], selected: qualityBand(config.projectedDPI) === name };
  });

  const executeCompression = async (overrideSafety = false, customConfig?: AdaptiveConfig) => {
    if (files.length === 0) return;

    const effectiveConfig = customConfig ?? config;
    cancelRef.current = false;
    setCancelling(false);
    setSkipped(false);
    setCancelled(false);
    setStatus({ isProcessing: true, progress: 5, message: t("compress-pdf.compressing.b5a754") });

    // The file being compressed when a failure comes, so its own problem can be named.
    let working: PDFFile | null = null;
    try {
      const { compressPDFAdaptive } = await import('../../services/pdfBrowser');
      const made: { name: string; originalSize: number; blob: Blob }[] = [];

      for (let index = 0; index < files.length; index += 1) {
        if (cancelRef.current) throw cancelledRun();
        const selectedFile = files[index];
        working = selectedFile;
        const resultObj = await compressPDFAdaptive(
          selectedFile.file,
          'recommended',
          (p) => {
            if (cancelRef.current) throw cancelledRun();
            const batchProgress = ((index + p / 100) / files.length) * 100;
            setStatus((prev) => ({ ...prev, progress: Math.max(5, Math.round(batchProgress)) }));
          },
          overrideSafety,
          effectiveConfig,
          !keepText,
          analysis.byId[selectedFile.id] ?? analysis.isTextHeavy,
        );

        if (resultObj.status === 'blocked') {
          setStatus({ isProcessing: false, progress: 0, message: '' });
          setPreviewConfig(effectiveConfig);
          setShowPreview(true);
          return;
        }

        // A copy that is not smaller is not written: the original is what would be kept.
        if (resultObj.meta.compressedSize >= selectedFile.size || resultObj.data.length === 0) continue;
        made.push({
          name: `${sanitizeFilenameStem(`compress-${splitFilename(selectedFile.name).stem}`)}.pdf`,
          originalSize: selectedFile.size,
          blob: new Blob([resultObj.data], { type: 'application/pdf' }),
        });
      }
      if (cancelRef.current) throw cancelledRun();

      // s5-01: the strip holds one result. When nothing saves or keeps a result by itself
      // (automatic download off, or a platform that cannot export without a picker, and Recent
      // off), each would replace the one before it. Such a run of several files gives one ZIP.
      const settings = getWorkspaceSettings();
      const savedByItself = settings.autoDownload && platform.capabilities.automaticExternalExport !== false;
      if (made.length > 1 && !settings.keepLocalHistory && !savedByItself) {
        const zip = new (await loadJSZip())();
        const names = new Set<string>();
        for (const result of made) {
          recordSavings(result.originalSize, result.blob.size);
          zip.file(reserveArchiveName(result.name, names), result.blob);
        }
        const archive = await zip.generateAsync({ type: 'blob' });
        if (cancelRef.current) throw cancelledRun();
        downloadBlob(archive, datedOutputName(title, 'zip'), 'application/zip');
        setSkipped(false);
        setStatus({ isProcessing: false, progress: 100, message: '' });
        return;
      }

      // One step to the file, as every other tool (T-01): the result strip and sheet, Download
      // first, with the before and after sizes as the strip's line.
      for (const result of made) {
        recordSavings(result.originalSize, result.blob.size);
        const change = Math.round(((result.originalSize - result.blob.size) / result.originalSize) * 100);
        setNextOutputDetail(result.name, t('compress-pdf.size.change', {
          before: formatSize(result.originalSize),
          after: formatSize(result.blob.size),
          change: formatPercent(-change),
        }));
        downloadBlob(result.blob, result.name);
      }
      setSkipped(made.length === 0);
      setStatus({ isProcessing: false, progress: 100, message: '' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus({ isProcessing: false, progress: 0, message: '' });
        setCancelled(true);
        announce(t("ocrpdf.operation.cancelled.386cf3"));
        return;
      }
      console.error(error);
      // Classified from the error itself: the displayed text is translated and cannot be matched.
      // A damaged file fails inside the compressor with a plain error, so the file is read once
      // more to give the cause and the way on (Repair PDF) instead of "Compression failed" (mobile-10).
      // A locked file is worded as in every other tool (fable C9).
      const message = classifyPdfError(error) === 'locked'
        ? t('error.pdfLocked')
        : (working ? await pdfFileProblem(working.file, error, files.length > 1 ? working.name : undefined) : pdfProblemMessage(error))
          ?? t("compress-pdf.compression.failed.your.original.was.not.changed.b7e5e0");
      setStatus({ isProcessing: false, progress: 0, message: '', error: message });
    } finally {
      cancelRef.current = false;
      setCancelling(false);
    }
  };

  const cancelCompression = () => {
    cancelRef.current = true;
    setCancelling(true);
  };

  const fileCountLabel = t('format.pdfCount', { count: files.length });
  const processingProgress = Number.isFinite(status.progress)
    ? Math.max(0, Math.min(100, status.progress))
    : 0;

  const reset = () => {
    setFiles([]);
    setSkipped(false);
    setCancelled(false);
    setUploadWarning(null);
    setAnalysis({ byId: {}, pageCountById: {}, isTextHeavy: false, done: false });
  };

  const title = t("compress-pdf.compress.pdf.932c3c");
  const toast = <StatusToast status={status} />;
  const warning = uploadWarning ? (
    <div className="flex items-start gap-2 rounded-[var(--radius-field)] border border-[var(--status-caution-text)] bg-[var(--status-caution-quiet)] px-3 py-2.5 text-sm font-medium text-[var(--status-caution-text)]">
      <AlertTriangle aria-hidden size={18} className="mt-0.5 shrink-0" />
      <span>{uploadWarning}</span>
    </div>
  ) : null;

  if (files.length === 0) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf,application/pdf" multiple label={t("compress-pdf.choose.pdfs.to.compress.8399ff")} />
            {warning}
          </div>
        )}
        toast={toast}
      />
    );
  }

  const openPreview = () => {
    setPreviewConfig(config);
    setShowPreview(true);
  };

  /* ---- body: the files ---- */
  const fileList = (
    <div className="tk-compress-files">
      {/* The file line above already says "2 PDFs · 3.0 MB" (A-019), and Clear is the header's
          "change the file" control (polish item 8), so no row is left holding it alone. */}
      <h2 className="sr-only">{fileCountLabel}</h2>

      {files.length > 1 && (
        <div className="chef-scroller max-h-48 space-y-1 overflow-y-auto rounded-[var(--radius-field)] bg-[var(--surface-sunken)] p-2">
          {files.map((selectedFile) => (
            <div key={selectedFile.id} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-body)]">{selectedFile.name}</span>
              <span className="tabular shrink-0 text-xs text-[var(--text-tertiary)]">{formatSize(selectedFile.size)}</span>
              <button
                type="button"
                onClick={() => setFiles((current) => current.filter((file) => file.id !== selectedFile.id))}
                disabled={status.isProcessing}
                className="chef-target inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)]"
                aria-label={t("compress-pdf.remove.9fc927", { v0: selectedFile.name })}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {warning}

      {/* The canvas shows the first file's first page (D13); on a phone too, now that the quality
          setting is in its value's card (owner decision 2026-11-15, item 1). */}
      {files[0] && (
        <div className="tk-compress-page">
          <FilePreview file={files[0].file} name={files[0].name} meta={formatSize(files[0].size)} />
        </div>
      )}
    </div>
  );

  /* ---- the quality block: always visible while there are files and no result (R6) ---- */
  const qualityWord = qualityLabel(config.projectedDPI);
  const qualityBlock = (
    <section aria-labelledby="compress-quality-heading" className="tk-compress-quality">
      <div className="tk-compress-qhead">
        <h2 id="compress-quality-heading" className="text-sm font-bold text-[var(--text-body)]">{t("compress-pdf.quality.1b2c08")}</h2>
        {/* The label alone. DPI is the one number that predicts
            readability, and it is shown in the preview, where its
            effect is actually visible. */}
        <span className="type-caption flex-1 text-[var(--text-secondary)]">{qualityWord}</span>
        {/* Today's preview, in both text modes (D12): a compact control on the heading row (A-019). */}
        <button
          type="button"
          onClick={openPreview}
          disabled={!analysis.done || status.isProcessing}
          className="tk-chip chef-pressable"
        >
          <Eye aria-hidden size={16} />{t("compress-pdf.preview.74b76f")}</button>
      </div>

      {/* No border box (A-019): the section's heading groups it. */}
      <div>
        {!keepText && <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <div className="type-caption text-[var(--text-tertiary)]">{t("compress-pdf.actual.c40642")}</div>
            <div className="tabular font-semibold text-[var(--text-body)]">{formatSize(totalOriginalSize)}</div>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-end">
              <div className="type-caption text-[var(--text-tertiary)]">{t("compress-pdf.estimated.b77459")}</div>
              <div className={`tabular text-xl font-bold text-[var(--text-primary)] ${measuring ? 'opacity-60' : ''}`}>
                {measuredEstimate ? t("compress-pdf..24577b", { v0: formatSize(measuredEstimate) }) : '—'}
              </div>
            </div>
            {/* No badge when the estimate is not smaller: "-0%" read as a saving (iOS sync, 2026-11-15). */}
            {measuredEstimate && estimatedReduction > 0 ? (
              <span className="rounded-[var(--radius-pill)] bg-[var(--accent-quiet)] px-2 py-0.5 text-xs font-bold text-[var(--accent-on-quiet)]">
                {formatPercent(-estimatedReduction)}
              </span>
            ) : null}
          </div>
        </div>}

        <ChefSlider
          min={0}
          max={100}
          step={1}
          value={quality}
          onChange={setQuality}
          ariaLabel={t("compress-pdf.compression.quality.4038b0")}
        />

        <div className="tk-compress-presets mt-3">
          {presets.map((preset) => (
            <button
              type="button"
              key={preset.name}
              onClick={() => setQuality(preset.stop)}
              disabled={status.isProcessing}
              aria-pressed={preset.selected}
              className={`chef-pressable min-h-touch rounded-[var(--radius-control)] border px-3 py-2 text-center transition-colors disabled:opacity-55 ${
                preset.selected
                  ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] ring-1 ring-inset ring-[var(--accent-rest)]'
                  : 'border-[var(--border-strong)] hover:border-[var(--accent-rest)]'
              }`}
            >
              <span className={`block text-sm font-semibold ${preset.selected ? 'text-[var(--accent-on-quiet)]' : 'text-[var(--text-primary)]'}`}>
                {qualityLabel(PRESET_DPI[preset.name])}
              </span>
              {!keepText && <span className="tabular type-caption block text-[var(--text-secondary)]">
                {preset.size ? t("compress-pdf..24577b", { v0: formatSize(preset.size) }) : '…'}
              </span>}
            </button>
          ))}
        </div>

      </div>
    </section>
  );

  /* ---- the sentence: files and quality are plain text, the text mode is a slot ---- */
  const qualityPhrase = config.projectedDPI < 110
    ? t('sentence.compress.quality.low')
    : config.projectedDPI < 175 ? t('sentence.compress.quality.medium') : t('sentence.compress.quality.high');
  // The switch keeps its meaning, "keep the text selectable", on or off: words that changed to
  // "turn the pages into pictures" beside an off switch read as the opposite (iOS sync,
  // 2026-11-15). The sentence around it follows the switch, so it is true in both states:
  // "…and keep the text selectable." / "…and do not keep the text selectable." (pass 5, item 3).
  const textPhrase = t('sentence.compress.text.keep');
  const switchLabel = t("compress-pdf.keep.text.selectable.89e827");
  const sentence = (
    <Sentence
      template={keepText ? 'sentence.compress' : 'sentence.compress.pictures'}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      values={wide
        ? { files: t('sentence.compress.files', { count: files.length }), quality: qualityPhrase }
        : { files: t('sentence.compress.files', { count: files.length }) }}
      slots={{
        // Phone: the quality is a value whose card holds the slider, the three presets with their
        // estimates and Preview, so the setting shows once (owner decision 2026-11-15, item 1).
        // Desktop keeps them in the column beside the page, and the words stay plain text.
        ...(wide ? {} : {
          quality: {
            label: t("compress-pdf.quality.1b2c08"),
            text: qualityPhrase,
            editor: qualityBlock,
            showTitle: false,
            width: 380,
          },
        }),
        // One tap (owner decision 1): the words are the switch, as Rotate's words act at once.
        text: {
          label: switchLabel,
          text: textPhrase,
          inline: (
            <button
              type="button"
              role="switch"
              aria-checked={keepText}
              aria-label={switchLabel}
              onClick={() => setKeepText((current) => !current)}
              disabled={status.isProcessing}
              data-on={keepText ? 'true' : 'false'}
              className="tk-word tk-word-switch chef-pressable"
            >
              {/* A drawn switch, so the words read as a control that turns on and off. */}
              <span aria-hidden className="tk-switch-track"><span className="tk-switch-knob" /></span>
              <span className="tk-word-switch-text">{textPhrase}</span>
            </button>
          ),
        },
      }}
    />
  );

  // One line (D10): analysing; the estimate lives in the quality section.
  // A file that cannot shrink says so here, and how to make it smaller (T-01).
  const notice = !analysis.done
    ? <Notice tone="pending">{t("compress-pdf.analysing.095f29")}</Notice>
    : skipped ? (
      <Notice tone="caution" role="status">
        {/* Discard sits on the heading's line, not on a row of its own (owner 2026-11-15). */}
        <span className="flex items-center justify-between gap-3">
          <span className="font-semibold">{t("compress-pdf.already.as.small.as.it.gets.c4d3a1")}</span>
          {!status.isProcessing && (
            <button
              type="button"
              onClick={() => setSkipped(false)}
              className="tk-notice-action chef-pressable"
            >
              <Trash2 aria-hidden size={14} />
              {t("compress-pdf.discard.cdbc8d")}
            </button>
          )}
        </span>
        <span className="block">{t("compress-pdf.compressing.this.file.would.have.made.it.346a00")}</span>
        {/* With text kept, only photos are re-encoded, so a text-only PDF
            cannot shrink. Name the switch that trades text for size. */}
        {keepText && (
          <span className="block">{t("compress-pdf.to.make.it.smaller.turn.off.pages.4ef0d4", { v0: t("compress-pdf.keep.text.selectable.89e827") })}</span>
        )}
      </Notice>
    )
    : cancelled && !status.isProcessing ? <Notice>{t("ocrpdf.operation.cancelled.386cf3")}</Notice>
    // The estimate is shown once, in the quality section beside its slider (A-019).
    : null;

  const action = (
    <button
      type="button"
      onClick={() => void executeCompression(false)}
      disabled={status.isProcessing || !analysis.done}
      className="tk-primary chef-pressable"
    >
      {status.isProcessing || !analysis.done ? (
        <Loader2 aria-hidden className="animate-spin" size={18} />
      ) : (
        <Layers aria-hidden size={18} />
      )}
      <span>{t("compress-pdf.compress.033fc0")}</span>
    </button>
  );

  const progress = status.isProcessing ? (
    <ProgressLine
      label={status.message || t("compress-pdf.compressing.b5a754")}
      percent={formatPercent(processingProgress)}
      value={processingProgress}
      quietCancel
      cancel={(
        <button type="button" onClick={cancelCompression} disabled={cancelling} className="tk-btn chef-pressable">
          {t("output-center.cancel.19766e")}
        </button>
      )}
    />
  ) : undefined;

  return (
    <ToolScreen
      title={title}
      file={files.length === 1 ? { name: files[0].name, meta: formatSize(files[0].size) } : { name: fileCountLabel, meta: analysis.done ? formatSize(totalOriginalSize) : undefined }}
      change={<ChangeFile label={t("compress-pdf.clear.83b12c")} onClick={reset} disabled={status.isProcessing} />}
      heavyJob={{ bytes: files.reduce((sum, item) => sum + item.size, 0), files: files.length }}
      kind="file"
      className="tk-compress"
      bodyLabel={title}
      body={fileList}
      side={wide ? qualityBlock : undefined}
      sentence={sentence}
      notice={notice}
      action={action}
      progress={progress}
      toast={toast}
      extra={<>{announcer}{showPreview && files[0] && previewConfig ? (
        <React.Suspense fallback={null}>
          <ReadabilityPreview
            file={files[0].file}
            files={previewFiles}
            config={previewConfig}
            isTextHeavy={analysis.byId[files[0].id] ?? analysis.isTextHeavy}
            keepText={keepText}
            onClose={() => setShowPreview(false)}
            onConfirm={(finalConfig) => {
              setShowPreview(false);
              void executeCompression(true, finalConfig);
            }}
          />
        </React.Suspense>
      ) : null}</>}
    />
  );
};
