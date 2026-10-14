import { localizeError } from '../../services/i18n/errors.ts';
import { t, formatNumber } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { AnimatePresence, motion } from 'framer-motion';
import { Droplets, Loader2, Maximize2, X } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { ChefSliderField } from '../UI/ChefSlider';
import { Portal } from '../UI/Primitives';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolPanel, ToolShell } from '../UI/ToolLayout';
import { PDFFile, ProcessingStatus } from '../../types';
import { addWatermarkToPDF } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { loadPDFDocument, renderPageAsImage } from '../../services/pdfBrowser';
import { getPdfPreviewLayoutSize } from '../../services/pdfPageGeometry';
import { getPdfPreviewFont, unsupportedPdfPreviewCharacter } from '../../services/pdfPreviewFont';
import type { PDFFont } from 'pdf-lib';
import {
  DEFAULT_WATERMARK_COLOR_HEX,
  DEFAULT_WATERMARK_OPACITY,
  DEFAULT_WATERMARK_ROTATION_DEGREES,
  DEFAULT_WATERMARK_SIZE,
  DEFAULT_WATERMARK_TEXT,
  DEFAULT_WATERMARK_X_PERCENT,
  DEFAULT_WATERMARK_Y_PERCENT,
  MAX_PDF_TEXT_LENGTH,
  WATERMARK_MAX_ROTATION_DEGREES,
  WATERMARK_MAX_SIZE,
  WATERMARK_MIN_OPACITY,
  WATERMARK_MIN_ROTATION_DEGREES,
  WATERMARK_MIN_SIZE,
  androidExportFileName,
  sanitizeWatermarkText,
  watermarkLayout,
} from '../../services/androidParity';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Draw in the same page coordinate system as export; SVG scales with either preview size. */
const WatermarkPreviewSurface: React.FC<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  large: boolean;
  aspectRatio: string;
  isDragging: boolean;
  imageUrl: string | null;
  layout: ReturnType<typeof watermarkLayout>;
  pageWidth: number;
  pageHeight: number;
  color: string;
  opacity: number;
  onPointerDown: (event: React.PointerEvent) => void;
}> = ({
  containerRef,
  large,
  aspectRatio,
  isDragging,
  imageUrl,
  layout,
  pageWidth,
  pageHeight,
  color,
  opacity,
  onPointerDown,
}) => {
  useI18n();
  return (
    <div
      ref={containerRef}
      className={`relative ${large ? 'h-full max-w-full' : 'w-full'} overflow-hidden rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-white dark:bg-slate-900 ${
        isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
      style={{ aspectRatio, touchAction: 'none' }}
      onPointerDown={onPointerDown}
    >
      {imageUrl ? (
        <img src={imageUrl} alt={t("watermark-pdf.watermark.preview.bb6d55")} className="h-full w-full object-contain" draggable={false} />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-[var(--text-tertiary)]">{t("watermark-pdf.no.preview.4b8bac")}</div>
      )}

      {layout && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${pageWidth} ${pageHeight}`} aria-hidden>
          <text
            x={layout.baselineX}
            y={pageHeight - layout.baselineY}
            transform={`rotate(${-layout.rotationDegrees} ${layout.centerX} ${pageHeight - layout.centerY})`}
            fill={color}
            opacity={opacity}
            fontFamily="Helvetica, Arial, sans-serif"
            fontWeight="bold"
            fontSize={layout.fontSize}
            textLength={layout.textWidth || undefined}
            lengthAdjust="spacingAndGlyphs"
          >
            {layout.text}
          </text>
        </svg>
      )}
    </div>
  );
};

export const WatermarkPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [previewFont, setPreviewFont] = useState<PDFFont | null>(null);
  const [text, setText] = useState(DEFAULT_WATERMARK_TEXT);
  const [size, setSize] = useState(DEFAULT_WATERMARK_SIZE);
  const [opacity, setOpacity] = useState(DEFAULT_WATERMARK_OPACITY);
  const [rotation, setRotation] = useState(DEFAULT_WATERMARK_ROTATION_DEGREES);
  const [color, setColor] = useState(DEFAULT_WATERMARK_COLOR_HEX);
  // Fractions of the page, 0-1, with Y measured from the bottom, matching the app's option string.
  const [xPercent, setXPercent] = useState(DEFAULT_WATERMARK_X_PERCENT);
  const [yPercent, setYPercent] = useState(DEFAULT_WATERMARK_Y_PERCENT);

  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showLargePreview, setShowLargePreview] = useState(false);
  const largePreviewTriggerRef = useRef<HTMLButtonElement>(null);
  const largePreviewCloseRef = useRef<HTMLButtonElement>(null);
  const largePreviewRef = useRef<HTMLDivElement>(null);
  const [previewDimensions, setPreviewDimensions] = useState({ width: 595, height: 842 });

  const [isDragging, setIsDragging] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const inlinePreviewRef = useRef<HTMLDivElement | null>(null);
  const modalPreviewRef = useRef<HTMLDivElement | null>(null);
  const dragContainerRef = useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  const opacityPercent = Number((opacity * 100).toFixed(1));
  const previewAspect = useMemo(() => `${previewDimensions.width} / ${previewDimensions.height}`, [previewDimensions]);

  /**
   * The exact layout the export will use, in page points. Reusing it for the overlay is what makes
   * the preview honest about the rotated-bounding-box clamp and about rotation happening around
   * the mark's centre.
   */
  const unsupportedCharacter = unsupportedPdfPreviewCharacter(previewFont, sanitizeWatermarkText(text));
  const textValidationMessage = unsupportedCharacter ? t("business-document.error.b7890f176a", {
    v0: unsupportedCharacter,
    v1: unsupportedCharacter.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'),
  }) : null;
  const layout = useMemo(
    () =>
      unsupportedCharacter || !previewFont ? null : watermarkLayout({
        pageWidth: previewDimensions.width,
        pageHeight: previewDimensions.height,
        text,
        fontSize: size,
        rotationDegrees: rotation,
        placement: { xPercent, yPercent },
        measureTextWidth: (value, fontSize) => previewFont?.widthOfTextAtSize(value, fontSize) ?? 0,
      }),
    [previewFont, previewDimensions.height, previewDimensions.width, rotation, size, text, xPercent, yPercent, unsupportedCharacter],
  );

  // Opening the preview after scrolling used to leave Close wherever the page
  // happened to be. Portalled and viewport-fixed, it now behaves like every
  // other modal: focus in, trapped, Escape out, focus restored.
  useEffect(() => {
    if (!showLargePreview) return undefined;
    const opener = largePreviewTriggerRef.current;
    const selector = 'button:not([disabled]), [href], input:not([disabled]), canvas, [tabindex]:not([tabindex="-1"])';
    const focusables = (): HTMLElement[] =>
      largePreviewRef.current ? Array.from(largePreviewRef.current.querySelectorAll<HTMLElement>(selector)) : [];
    largePreviewCloseRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowLargePreview(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [showLargePreview]);

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0 || !isPdfFile(files[0])) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("watermark-pdf.choose.a.pdf.file.to.watermark.e31cf9") });
      return;
    }
    const selected = files[0];
    setFile({
      id: uuidv4(),
      file: selected,
      name: selected.name,
      size: selected.size,
    });
    setXPercent(DEFAULT_WATERMARK_X_PERCENT);
    setYPercent(DEFAULT_WATERMARK_Y_PERCENT);
    setShowLargePreview(false);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  };

  const handleApplyWatermark = async () => {
    if (!file || !previewFont || textValidationMessage || !sanitizeWatermarkText(text)) return;
    setStatus({ isProcessing: true, progress: 10, message: t("watermark-pdf.applying.watermark.339c47") });
    try {
      const bytes = await addWatermarkToPDF(file.file, {
        text,
        size,
        opacity,
        rotation,
        color,
        xPercent,
        yPercent,
      });
      const outputName = androidExportFileName('watermark', file.name, 'pdf');
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), outputName);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: t("watermark-pdf.watermarked.copy.ready.2cb9a8", { v0: outputName }),
      });
    } catch (error) {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? localizeError(error) : t("watermark-pdf.failed.to.add.watermark.dade5d"),
      });
    }
  };

  useEffect(() => {
    const revoke = (value: string | null) => {
      if (value && value.startsWith('blob:')) URL.revokeObjectURL(value);
    };
    return () => {
      revoke(previewUrlRef.current);
    };
  }, []);

  useEffect(() => {
    const revoke = (value: string | null) => {
      if (value && value.startsWith('blob:')) URL.revokeObjectURL(value);
    };

    if (!file) {
      revoke(previewUrlRef.current);
      previewUrlRef.current = null;
      setOriginalPreviewUrl(null);
      setPreviewLoading(false);
      return;
    }

    let cancelled = false;
    let pdfDoc: any = null;

    const renderOriginal = async () => {
      setPreviewLoading(true);
      try {
        pdfDoc = await loadPDFDocument(file.file);
        const rendered = await renderPageAsImage(pdfDoc, 0, {
          scale: 1.4,
          format: 'image/jpeg',
          quality: 0.9,
        });

        const font = await getPdfPreviewFont(true);
        const layoutSize = getPdfPreviewLayoutSize(await pdfDoc.getPage(1));
        if (cancelled) {
          URL.revokeObjectURL(rendered.objectUrl);
          return;
        }

        revoke(previewUrlRef.current);
        previewUrlRef.current = rendered.objectUrl;
        setOriginalPreviewUrl(rendered.objectUrl);
        setPreviewFont(font);
        setPreviewDimensions(layoutSize);
      } catch {
        if (!cancelled) {
          setStatus({
            isProcessing: false,
            progress: 0,
            message: '',
            error: t("watermark-pdf.the.preview.could.not.be.shown.you.bc2975"),
          });
        }
      } finally {
        if (typeof pdfDoc?.destroy === 'function') {
          void pdfDoc.destroy();
        }
        if (!cancelled) setPreviewLoading(false);
      }
    };

    void renderOriginal();

    return () => {
      cancelled = true;
    };
  }, [file]);

  const placeWatermarkFromPointer = useCallback((clientX: number, clientY: number) => {
    const container = dragContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // Pointer Y grows downwards; the option value is measured from the bottom of the page.
    setXPercent(clamp((clientX - rect.left) / rect.width, 0, 1));
    setYPercent(clamp(1 - (clientY - rect.top) / rect.height, 0, 1));
  }, []);

  const beginWatermarkDrag = (event: React.PointerEvent, container: HTMLDivElement | null) => {
    if (!sanitizeWatermarkText(text) || !container) return;
    event.preventDefault();
    event.stopPropagation();

    dragContainerRef.current = container;
    activePointerIdRef.current = event.pointerId;
    setIsDragging(true);
    placeWatermarkFromPointer(event.clientX, event.clientY);
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (event: PointerEvent) => {
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return;
      placeWatermarkFromPointer(event.clientX, event.clientY);
    };

    const handleStop = (event: PointerEvent) => {
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return;
      setIsDragging(false);
      activePointerIdRef.current = null;
      dragContainerRef.current = null;
    };

    window.addEventListener('pointermove', handleMove, { passive: true });
    window.addEventListener('pointerup', handleStop, { passive: true });
    window.addEventListener('pointercancel', handleStop, { passive: true });

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleStop);
      window.removeEventListener('pointercancel', handleStop);
    };
  }, [isDragging, placeWatermarkFromPointer]);

  const renderPreviewCanvas = (containerRef: React.RefObject<HTMLDivElement | null>, large = false) => (
    <div className="rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] p-2">
      <div className={`mx-auto ${large ? 'h-[70vh] max-h-[70vh] max-w-full' : 'w-full max-w-[460px]'}`}>
        <WatermarkPreviewSurface
          containerRef={containerRef}
          large={large}
          aspectRatio={previewAspect}
          isDragging={isDragging}
          imageUrl={originalPreviewUrl}
          layout={layout}
          pageWidth={previewDimensions.width}
          pageHeight={previewDimensions.height}
          color={color}
          opacity={opacity}
          onPointerDown={(event) => beginWatermarkDrag(event, containerRef.current)}
        />
      </div>

      <p className="tabular mt-1.5 text-end text-xs text-[var(--text-secondary)]">{t("watermark-pdf.message.374fc52abe", { v0: formatNumber(xPercent * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), v1: formatNumber(yPercent * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</p>
    </div>
  );

  return (
    <ToolShell width="wide" centered={!file}>
      <ToolHeader title={t("watermark-pdf.watermark.pdf.903ce9")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-3xl mx-auto">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("watermark-pdf.choose.a.pdf.to.watermark.a7c360")} />
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_420px]">
            <ToolPanel className="order-2 min-w-0 space-y-3 lg:order-1">
              <div>
                <label className="block type-footnote font-semibold text-[var(--text-secondary)] mb-1">{t("watermark-pdf.watermark.text.9429e8")}</label>
                <input
                  value={text}
                  aria-invalid={!!textValidationMessage}
                  aria-describedby={textValidationMessage ? "watermark-text-error" : undefined}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={MAX_PDF_TEXT_LENGTH}
                  className="chef-field h-10 w-full px-3 text-sm"
                  placeholder={DEFAULT_WATERMARK_TEXT}
                />
                {textValidationMessage && <p id="watermark-text-error" role="alert" className="mt-2 text-xs text-[var(--status-danger-text)]">{textValidationMessage}</p>}
              </div>

              <div>
                <ChefSliderField
                  label={t("watermark-pdf.size.1af851")}
                  suffix="pt"
                  decimals={1}
                  min={WATERMARK_MIN_SIZE}
                  max={WATERMARK_MAX_SIZE}
                  step={0.5}
                  value={size}
                  onChange={setSize}
                  ariaLabel={t("watermark-pdf.watermark.size.2dccd4")}
                />
              </div>

              <div>
                <ChefSliderField
                  label={t("watermark-pdf.opacity.606265")}
                  suffix="%"
                  decimals={1}
                  min={WATERMARK_MIN_OPACITY * 100}
                  max={100}
                  step={0.5}
                  value={opacityPercent}
                  onChange={(next) => setOpacity(next / 100)}
                  ariaLabel={t("watermark-pdf.watermark.opacity.d101b5")}
                />
              </div>

              <div>
                <ChefSliderField
                  label={t("watermark-pdf.rotation.57b5e2")}
                  suffix="°"
                  decimals={1}
                  min={WATERMARK_MIN_ROTATION_DEGREES}
                  max={WATERMARK_MAX_ROTATION_DEGREES}
                  step={0.5}
                  value={rotation}
                  onChange={setRotation}
                  ariaLabel={t("watermark-pdf.watermark.rotation.f52934")}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <ChefSliderField label={t("watermark-pdf.horizontal.0abba4")} suffix="%" decimals={1} min={0} max={100} step={0.1} value={xPercent * 100} onChange={(next) => setXPercent(next / 100)} ariaLabel={t("watermark-pdf.watermark.horizontal.position.a594dc")} />
                </div>
                <div>
                  <ChefSliderField label={t("watermark-pdf.vertical.727cd3")} suffix="%" decimals={1} min={0} max={100} step={0.1} value={yPercent * 100} onChange={(next) => setYPercent(next / 100)} ariaLabel={t("watermark-pdf.watermark.vertical.position.793ba3")} />
                </div>
              </div>

              <div>
                <label className="block type-footnote font-semibold text-[var(--text-secondary)] mb-1">{t("watermark-pdf.color.6b7319")}</label>
                <input
                  type="color"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                  className="h-10 w-20 rounded-[var(--radius-control)] border border-[var(--border-hairline)] bg-transparent"
                />
              </div>
            </ToolPanel>

            <ToolPanel className="order-1 h-fit space-y-2.5 lg:order-2">
              <div className="flex items-center justify-between">
                <div className="type-caption uppercase tracking-[0.18em] text-[var(--text-tertiary)]">{t("watermark-pdf.live.preview.page.1.e4a4b6")}</div>
                <button
                  ref={largePreviewTriggerRef}
                  type="button"
                  onClick={() => setShowLargePreview(true)}
                  className="chef-pressable chef-hit-y inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-2.5 py-1.5 type-footnote font-semibold text-[var(--text-secondary)] hover:border-[var(--accent-rest)]"
                >
                  <Maximize2 aria-hidden size={16} />{t("watermark-pdf.large.preview.ab2772")}</button>
              </div>

              {previewLoading ? (
                <div className="flex items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-hairline)] py-6 text-sm text-[var(--text-secondary)]">
                  <Loader2 aria-hidden className="mr-2 animate-spin" size={18} />{t("watermark-pdf.rendering.5d9292")}</div>
              ) : (
                renderPreviewCanvas(inlinePreviewRef)
              )}

              <button
                onClick={handleApplyWatermark}
                disabled={status.isProcessing || !previewFont || !!textValidationMessage || !sanitizeWatermarkText(text)}
                className="chef-target chef-pressable flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-5 font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-55"
              >
                {status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <Droplets aria-hidden size={18} />}
                <span>{t("watermark-pdf.save.stamped.pdf.4051c0")}</span>
              </button>
              <button type="button" onClick={() => setFile(null)} className="chef-target w-full text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]">{t("watermark-pdf.choose.another.file.26eac8")}</button>
            </ToolPanel>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showLargePreview && file && (
          <Portal>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            ref={largePreviewRef}
            className="chef-safe-x chef-safe-bottom fixed inset-0 z-[100] flex items-center justify-center p-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:p-6"
          >
            <button className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowLargePreview(false)} aria-label={t("watermark-pdf.close.large.preview.10665d")} />
            <motion.div
              initial={{ scale: 0.98, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.98, opacity: 0 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="large-watermark-preview-title"
              className="relative z-10 max-h-[calc(100dvh-1.5rem)] w-full max-w-6xl overflow-y-auto rounded-2xl border border-paper-500 bg-slate-900 p-4 sm:p-5"
            >
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div id="large-watermark-preview-title" className="text-sm font-semibold text-white">{t("watermark-pdf.large.preview.6b8047")}</div>
                  {/* Kept: inside the modal, dragging is the only way to place
                      the text — the position sliders are behind it. */}
                  <div className="type-caption text-paper-400">{t("watermark-pdf.drag.the.text.to.position.it.18cc0d")}</div>
                </div>
                <button
                  ref={largePreviewCloseRef}
                  type="button"
                  onClick={() => setShowLargePreview(false)}
                  className="chef-target chef-pressable grid shrink-0 place-items-center rounded-lg text-paper-300 hover:bg-slate-800 hover:text-white"
                  aria-label={t("watermark-pdf.close.large.preview.10665d")}
                >
                  <X aria-hidden size={20} />
                </button>
              </div>

              {renderPreviewCanvas(modalPreviewRef, true)}
            </motion.div>
          </motion.div>
          </Portal>
        )}
      </AnimatePresence>

      <StatusToast status={status} />
    </ToolShell>
  );
};
