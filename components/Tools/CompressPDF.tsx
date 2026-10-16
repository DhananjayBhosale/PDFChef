import { formatPercent } from '../../services/i18n/core.ts';
import { formatBytes as formatSize, sanitizeFilenameStem, splitFilename } from '../UI/format';
import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { getInterpolatedConfig, type AdaptiveConfig } from '../../services/pdfCompressionConfig';
import { downloadBlob } from '../../services/pdfShared';
import { Layers, ArrowRight, Loader2, CheckCircle2, AlertTriangle, ShieldAlert, Eye, Trash2, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { StatusToast } from '../UI/StatusToast';
import { ChefSlider } from '../UI/ChefSlider';
import { Switch } from '../UI/Primitives';
import { recordSavings } from '../../services/workspace';

const ReadabilityPreview = React.lazy(() => import('./ReadabilityPreview').then((module) => ({
  default: module.ReadabilityPreview,
})));

/** The slider stop that lands on a given DPI, for the three preset chips. */
const sliderForDPI = (dpi: number, isTextHeavy: boolean): number => {
  const minDPI = isTextHeavy ? 96 : 72;
  return Math.max(0, Math.min(100, ((dpi - minDPI) / (300 - minDPI)) * 100));
};

const PRESET_DPI = { Low: 72, Medium: 144, High: 200 } as const;
// File extensions are the same in every language.
const PDF_EXTENSION = '.pdf';
type PresetName = keyof typeof PRESET_DPI;

const qualityLabel = (dpi: number): string => (dpi < 110 ? t("compress-pdf.low.f793de") : dpi < 175 ? t("compress-pdf.medium.8e588c") : t("compress-pdf.high.c4ebc6"));


/** One finished-but-unsaved result, held in memory until it is kept or dropped. */
interface TrialResult {
  id: string;
  name: string;
  outputStem: string;
  originalSize: number;
  blob: Blob;
  /** The compressed copy was not smaller, so the original is what would be kept. */
  skipped: boolean;
}

export const CompressPDF: React.FC = () => {
  useI18n();
  const [files, setFiles] = useState<PDFFile[]>([]);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);

  /**
   * The compressed copies, made but not written anywhere yet. Holding them here
   * is what lets the screen report the size the export actually produced instead
   * of a prediction, and lets someone walk away without a file they did not want
   * landing in their downloads.
   */
  const [trial, setTrial] = useState<TrialResult[] | null>(null);

  const [showPreview, setShowPreview] = useState(false);
  const [previewConfig, setPreviewConfig] = useState<AdaptiveConfig | null>(null);

  const [analysis, setAnalysis] = useState<{
    byId: Record<string, boolean>;
    pageCountById: Record<string, number>;
    isTextHeavy: boolean;
    done: boolean;
  }>({ byId: {}, pageCountById: {}, isTextHeavy: false, done: false });

  /** 0–100, the same axis the preview's own slider uses. Medium to start. */
  const [quality, setQuality] = useState(32);
  /** Off by default: the point of this tool is a smaller file, and the preview
      shows exactly what that costs before anything is written. */
  const [keepText, setKeepText] = useState(false);

  /** Sizes measured by encoding real pages, per preset and for the live slider. */
  const [presetSizes, setPresetSizes] = useState<Partial<Record<PresetName, number>>>({});
  const [measuredEstimate, setMeasuredEstimate] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const measureToken = useRef(0);

  const previewFiles = useMemo(
    () => files.map((selectedFile) => ({ file: selectedFile.file, name: selectedFile.name })),
    [files],
  );

  useEffect(() => {
    let cancelled = false;

    if (files.length > 0) {
      setTrial(null);
      setShowPreview(false);
      setAnalysis({ byId: {}, pageCountById: {}, isTextHeavy: false, done: false });
      setPresetSizes({});
      setMeasuredEstimate(null);

      void import('../../services/pdfBrowser')
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

    setStatus({ isProcessing: false, progress: 0, message: '' });
    setKeepText(false);

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
    return { name, stop, size: presetSizes[name], selected: Math.abs(quality - stop) <= 4 };
  });

  const executeCompression = async (overrideSafety = false, customConfig?: AdaptiveConfig) => {
    if (files.length === 0) return;

    const effectiveConfig = customConfig ?? config;
    setStatus({ isProcessing: true, progress: 5, message: t("compress-pdf.compressing.b5a754") });

    try {
      const { compressPDFAdaptive } = await import('../../services/pdfBrowser');
      const results: TrialResult[] = [];

      for (let index = 0; index < files.length; index += 1) {
        const selectedFile = files[index];
        const resultObj = await compressPDFAdaptive(
          selectedFile.file,
          'recommended',
          (p) => {
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

        const finalSize = resultObj.meta.compressedSize;
        const skipped = finalSize >= selectedFile.size || resultObj.data.length === 0;

        // Held, not written. Nothing reaches the downloads folder or Recent
        // until the size below has been seen and accepted.
        results.push({
          id: selectedFile.id,
          name: selectedFile.name,
          outputStem: sanitizeFilenameStem(`compress-${splitFilename(selectedFile.name).stem}`),
          originalSize: selectedFile.size,
          blob: new Blob([resultObj.data], { type: 'application/pdf' }),
          skipped,
        });
      }

      setTrial(results);
      setStatus({ isProcessing: false, progress: 100, message: '' });
    } catch (error) {
      console.error(error);
      const detail = error instanceof Error ? localizeError(error) : '';
      const message = /password|encrypted/i.test(detail)
        ? t("compress-pdf.this.pdf.is.encrypted.unlock.it.first.7621b1")
        : t("compress-pdf.compression.failed.your.original.was.not.changed.b7e5e0");
      setStatus({ isProcessing: false, progress: 0, message: '', error: message });
    }
  };

  /** Keep it: the only point at which anything is written. */
  const keepTrial = () => {
    if (!trial || trial.some(result => !result.skipped && !result.outputStem.trim())) return;
    for (const result of trial) {
      if (result.skipped) continue;
      recordSavings(result.originalSize, result.blob.size);
      downloadBlob(result.blob, `${result.outputStem.trim()}.pdf`);
    }
    setTrial(null);
    setFiles([]);
    setStatus({ isProcessing: false, progress: 0, message: t("compress-pdf.saved.b5c120") });
  };

  /** Drop it. Nothing was ever written, so there is nothing to clean up. */
  const discardTrial = () => {
    setTrial(null);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  };

  const trialOriginalTotal = trial?.reduce((total, result) => total + result.originalSize, 0) ?? 0;
  const trialCompressedTotal = trial?.reduce(
    (total, result) => total + (result.skipped ? result.originalSize : result.blob.size),
    0,
  ) ?? 0;
  const totalReduction = trialOriginalTotal > 0 && trialCompressedTotal < trialOriginalTotal
    ? Math.round(((trialOriginalTotal - trialCompressedTotal) / trialOriginalTotal) * 100)
    : 0;
  const hasResults = Boolean(trial);
  const isSkipped = Boolean(trial && trial.every((result) => result.skipped));
  const fileCountLabel = t('format.pdfCount', { count: files.length });
  const processingProgress = Number.isFinite(status.progress)
    ? Math.max(0, Math.min(100, status.progress))
    : 0;

  const reset = () => {
    setFiles([]);
    setTrial(null);
    setUploadWarning(null);
    setKeepText(false);
    setAnalysis({ byId: {}, pageCountById: {}, isTextHeavy: false, done: false });
  };

  return (
    <div className={`relative mx-auto w-full max-w-3xl px-4 py-4 sm:py-10 ${files.length === 0 ? 'chef-tool-landing-centered' : ''}`}>
      <StatusToast status={status} />

      <div className="mb-3 sm:mb-6">
        <h1 className="text-3xl font-bold text-[var(--text-primary)]">{t("compress-pdf.compress.pdf.932c3c")}</h1>
        <p className="mt-1 text-[var(--text-secondary)]">{t("compress-pdf.make.the.file.smaller.and.see.how.ce9f74")}</p>
      </div>

      <AnimatePresence mode="wait">
        {files.length === 0 ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf,application/pdf" multiple label={t("compress-pdf.choose.pdfs.to.compress.8399ff")} />
            {uploadWarning && (
              <div className="mt-3 flex items-start gap-2 rounded-[var(--radius-field)] border border-[var(--status-caution-text)] bg-[var(--status-caution-quiet)] px-3 py-2.5 text-sm font-medium text-[var(--status-caution-text)]">
                <AlertTriangle aria-hidden size={18} className="mt-0.5 shrink-0" />
                <span>{uploadWarning}</span>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4"
          >
            {hasResults && (
              <div
                className={`mb-3 rounded-[var(--radius-field)] border p-3 ${
                  isSkipped
                    ? 'border-[var(--status-caution-text)] bg-[var(--status-caution-quiet)]'
                    : 'border-[var(--status-success-text)] bg-[var(--status-success-quiet)]'
                }`}
              >
                <div className={`mb-2 flex items-center gap-2 font-bold ${isSkipped ? 'text-[var(--status-caution-text)]' : 'text-[var(--status-success-text)]'}`}>
                  {isSkipped ? <ShieldAlert size={18} /> : <CheckCircle2 size={18} />}
                  {isSkipped ? t("compress-pdf.already.as.small.as.it.gets.c4d3a1") : t("compress-pdf.ready.to.save.255249")}
                </div>

                {isSkipped ? (
                  <p className="text-sm text-[var(--text-body)]">{t("compress-pdf.compressing.this.file.would.have.made.it.346a00")}</p>
                ) : (
                  <div className="flex items-center justify-between text-sm">
                    <div>
                      <div className="type-caption text-[var(--text-tertiary)]">{t("compress-pdf.original.88d759")}</div>
                      <div className="tabular text-[var(--text-body)] line-through">{formatSize(trialOriginalTotal)}</div>
                    </div>
                    <div className="flex flex-col items-center px-4">
                      <ArrowRight aria-hidden size={18} className="rtl:rotate-180 text-[var(--text-tertiary)]" />
                      <span className="mt-1 rounded-[var(--radius-pill)] bg-[var(--status-success-quiet)] px-2 py-0.5 text-xs font-bold text-[var(--status-success-text)]">
                        {formatPercent(-totalReduction)}
                      </span>
                    </div>
                    <div className="text-end">
                      <div className="type-caption text-[var(--status-success-text)]">{t("compress-pdf.compressed.e2d1ca")}</div>
                      <div className="tabular text-xl font-bold text-[var(--status-success-text)]">{formatSize(trialCompressedTotal)}</div>
                    </div>
                  </div>
                )}

                {/* The file exists but is still only in memory. This is where it
                    is either written or dropped. */}
                {!isSkipped && trial?.filter(result => !result.skipped).map(result => (
                  <label key={result.id} className="mb-2 block text-sm font-medium text-[var(--text-body)]">
                    <span>{t("output-center.file.name.3efed3")}{trial.length > 1 ? ` · ${result.name}` : ''}</span>
                    <span className="mt-1 flex items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] focus-within:ring-2 focus-within:ring-[var(--focus-ring)]">
                      <input
                        className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[var(--text-primary)] outline-none"
                        value={result.outputStem}
                        maxLength={200}
                        aria-describedby={`compress-extension-${result.id}`}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={event => setTrial(current => current?.map(item => item.id === result.id
                          ? { ...item, outputStem: sanitizeFilenameStem(event.target.value) }
                          : item) ?? null)}
                      />
                      <span id={`compress-extension-${result.id}`} className="pe-3 text-[var(--text-secondary)]">{PDF_EXTENSION}</span>
                    </span>
                  </label>
                ))}
                <div className="mt-3 flex flex-row gap-2">
                  {!isSkipped && (
                    <button
                      type="button"
                      onClick={keepTrial}
                      disabled={trial?.some(result => !result.skipped && !result.outputStem.trim())}
                      className="chef-target chef-pressable flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 text-sm font-bold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      <CheckCircle2 aria-hidden size={18} />{t("compress-pdf.save.52453d")}</button>
                  )}
                  <button
                    type="button"
                    onClick={discardTrial}
                    className="chef-target chef-pressable flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-4 text-sm font-bold text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)]"
                  >
                    <Trash2 aria-hidden size={18} />{t("compress-pdf.discard.cdbc8d")}</button>
                </div>
              </div>
            )}

            {!hasResults && (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] pb-3">
                  <div className="flex min-w-0 grow basis-[12rem] items-center gap-2.5">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]">
                      <Layers aria-hidden size={18} />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold text-[var(--text-primary)]">{fileCountLabel}</h2>
                      <div className="type-caption tabular text-[var(--text-tertiary)]">
                        {analysis.done ? formatSize(totalOriginalSize) : <span className="animate-pulse">{t("compress-pdf.analysing.095f29")}</span>}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={reset}
                    className="chef-target ml-auto shrink-0 rounded-[var(--radius-control)] border border-[var(--status-danger-text)] px-3 text-sm font-semibold text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)]"
                  >{t("compress-pdf.clear.83b12c")}</button>
                </div>

                {files.length > 1 && (
                  <div className="chef-scroller mb-3 max-h-40 space-y-1 overflow-y-auto rounded-[var(--radius-field)] bg-[var(--surface-sunken)] p-2">
                    {files.map((selectedFile) => (
                      <div key={selectedFile.id} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm">
                        <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-body)]">{selectedFile.name}</span>
                        <span className="tabular shrink-0 text-xs text-[var(--text-tertiary)]">{formatSize(selectedFile.size)}</span>
                        <button
                          type="button"
                          onClick={() => setFiles((current) => current.filter((file) => file.id !== selectedFile.id))}
                          className="chef-target inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)]"
                          aria-label={t("compress-pdf.remove.9fc927", { v0: selectedFile.name })}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {uploadWarning && (
                  <div className="mb-3 flex items-start gap-2 rounded-[var(--radius-field)] border border-[var(--status-caution-text)] bg-[var(--status-caution-quiet)] px-3 py-2.5 text-sm font-medium text-[var(--status-caution-text)]">
                    <AlertTriangle aria-hidden size={18} className="mt-0.5 shrink-0" />
                    <span>{uploadWarning}</span>
                  </div>
                )}

                <div className="mb-3">
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <h2 className="text-sm font-bold text-[var(--text-body)]">{t("compress-pdf.quality.1b2c08")}</h2>
                      {/* The label alone. DPI is the one number that predicts
                          readability, and it is shown in the preview, where its
                          effect is actually visible. */}
                      <span className="type-caption text-[var(--text-secondary)]">
                        {qualityLabel(config.projectedDPI)}
                      </span>
                    </div>

                    <div className="rounded-[var(--radius-field)] border border-[var(--border-hairline)] p-3">
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
                          {measuredEstimate ? (
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

                      <div className="mt-3 grid grid-cols-3 gap-2">
                        {presets.map((preset) => (
                          <button
                            type="button"
                            key={preset.name}
                            onClick={() => setQuality(preset.stop)}
                            disabled={status.isProcessing}
                            aria-pressed={preset.selected}
                            className={`chef-pressable rounded-[var(--radius-control)] border px-2 py-2 text-start transition-colors disabled:opacity-55 ${
                              preset.selected
                                ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)]'
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
                  </div>

                {/* Selectable text and forms remain in place while eligible embedded
                    photos use the same quality setting. */}
                <div className="mb-3">
                  <Switch
                    label={t("compress-pdf.keep.text.selectable.89e827")}
                    checked={keepText}
                    disabled={status.isProcessing}
                    onChange={setKeepText}
                  />
                </div>
              </>
            )}

            <div className={`flex flex-col gap-2 ${hasResults ? 'hidden' : ''}`}>
              {status.isProcessing && (
                <div className="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                  <div
                    aria-hidden="true"
                    className="h-full bg-[var(--accent-rest)] transition-[width] duration-200 ease-linear motion-reduce:transition-none"
                    style={{ width: `${processingProgress}%` }}
                  />
                </div>
              )}

              {!hasResults ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  {/* Always reachable while pages are being re-rendered, which is
                      the only time there is anything to look at. */}
                  {!keepText && (
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewConfig(config);
                        setShowPreview(true);
                      }}
                      disabled={!analysis.done || status.isProcessing}
                      className="chef-target chef-pressable flex items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-4 text-sm font-bold text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)] disabled:opacity-55 sm:w-40"
                    >
                      <Eye aria-hidden size={18} />{t("compress-pdf.preview.74b76f")}</button>
                  )}

                  <button
                    type="button"
                    onClick={() => void executeCompression(false)}
                    disabled={status.isProcessing || !analysis.done}
                    className="chef-target chef-pressable flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 text-sm font-bold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-55"
                  >
                    {status.isProcessing || !analysis.done ? (
                      <Loader2 aria-hidden className="animate-spin" size={18} />
                    ) : (
                      <Layers aria-hidden size={18} />
                    )}
                    <span>{t("compress-pdf.compress.033fc0")}</span>
                  </button>
                </div>
              ) : null}
            </div>
          </motion.div>
        )}

        {showPreview && files[0] && previewConfig && (
          <React.Suspense fallback={null}>
            <ReadabilityPreview
              file={files[0].file}
              files={previewFiles}
              config={previewConfig}
              isTextHeavy={analysis.byId[files[0].id] ?? analysis.isTextHeavy}
              onClose={() => setShowPreview(false)}
              onConfirm={(finalConfig) => {
                setShowPreview(false);
                void executeCompression(true, finalConfig);
              }}
            />
          </React.Suspense>
        )}
      </AnimatePresence>
    </div>
  );
};
