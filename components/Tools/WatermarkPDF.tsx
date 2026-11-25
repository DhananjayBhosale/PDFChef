import { localizeError } from '../../services/i18n/errors.ts';
import { t, formatNumber, formatPercent } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { Blend, Droplets, Maximize2, X } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { ChefSliderField } from '../UI/ChefSlider';
import { StatusToast } from '../UI/StatusToast';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { ChipEditor, Sentence } from '../Tool/Sentence';
import { EnterCloses } from '../Tool/Popover';
import { Notice, ProgressLine } from '../Tool/parts';
import { FitStage } from '../Tool/FitStage';
import { LargePagePreview } from '../Tool/LargePagePreview';
import { PreviewFrame } from '../Tool/PreviewFrame';
import { usePinchToOpen } from '../Tool/PagePeek';
import { clip, clipLength, degrees, pair, percent, points } from '../Tool/values';
import { useWide } from '../../hooks/useMediaQuery';
import { useReplaceOnDrop } from '../../hooks/useFileDrop';
import { PDFFile, ProcessingStatus } from '../../types';
import { addWatermarkToPDF, loadPDFDocument, pdfFileProblem, renderPageAsImage } from '../../services/pdfLazy';
import { WATERMARK_DEVANAGARI_FONT } from '../../services/pdfDevanagari';
import { devanagariCssFamily, devanagariFontsReady, firstUnshapedDevanagariCharacter, hasDevanagari, loadDevanagariFonts, measureDevanagariText } from '../../services/pdfDevanagari';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { getPdfPreviewLayoutSize } from '../../services/pdfPageGeometry';
import { getPdfPreviewFont, unsupportedPdfPreviewCharacter } from '../../services/pdfPreviewFont';
import type { PDFFont } from 'pdf-lib';
import { toolOutputName } from '../UI/format';
import { DEFAULT_WATERMARK_COLOR_HEX, DEFAULT_WATERMARK_OPACITY, DEFAULT_WATERMARK_ROTATION_DEGREES, DEFAULT_WATERMARK_SIZE, DEFAULT_WATERMARK_TEXT, DEFAULT_WATERMARK_X_PERCENT, DEFAULT_WATERMARK_Y_PERCENT, MAX_PDF_TEXT_LENGTH, WATERMARK_MAX_ROTATION_DEGREES, WATERMARK_MAX_SIZE, WATERMARK_MIN_OPACITY, WATERMARK_MIN_ROTATION_DEGREES, WATERMARK_MIN_SIZE, isOnWatermark, sanitizeWatermarkText, watermarkLayout } from '../../services/androidParity';
import { useRemembered } from '../Tool/useRemembered';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Draw in the same page coordinate system as export; SVG scales with either preview size. */
const WatermarkPreviewSurface: React.FC<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  large: boolean;
  isDragging: boolean;
  imageUrl: string | null;
  layout: ReturnType<typeof watermarkLayout>;
  pageWidth: number;
  pageHeight: number;
  color: string;
  opacity: number;
  /** Devanagari text is drawn in the face the saved page embeds; anything else in Helvetica Bold. */
  devanagari?: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
}> = ({
  containerRef,
  large,
  isDragging,
  imageUrl,
  layout,
  pageWidth,
  pageHeight,
  color,
  opacity,
  devanagari,
  onPointerDown,
}) => {
  useI18n();
  return (
    <div
      ref={containerRef}
      className={`tk-wm-surface relative h-full w-full overflow-hidden bg-white ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{ touchAction: 'none' }}
      data-large={large ? '' : undefined}
      onPointerDown={onPointerDown}
    >
      {imageUrl ? (
        <img src={imageUrl} alt={t("watermark-pdf.watermark.preview.bb6d55")} className="h-full w-full object-contain" draggable={false} />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-[var(--text-tertiary)]">{t("watermark-pdf.no.preview.4b8bac")}</div>
      )}

      {layout && (
        // Left to right in every language, like the saved page: in Arabic the text started at its
        // right end and ran off the page's left edge (polish item 12).
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${pageWidth} ${pageHeight}`} style={{ direction: 'ltr' }} aria-hidden>
          <text
            x={layout.baselineX}
            y={pageHeight - layout.baselineY}
            transform={`rotate(${-layout.rotationDegrees} ${layout.centerX} ${pageHeight - layout.centerY})`}
            fill={color}
            opacity={opacity}
            fontFamily={devanagari ? devanagariCssFamily(WATERMARK_DEVANAGARI_FONT) : 'Helvetica, Arial, sans-serif'}
            fontWeight={devanagari ? 'normal' : 'bold'}
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
  const wide = useWide();
  const settingsRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<PDFFile | null>(null);
  const [previewFont, setPreviewFont] = useState<PDFFont | null>(null);
  const [text, setText] = useRemembered<string>('text', DEFAULT_WATERMARK_TEXT);
  const [size, setSize] = useRemembered<number>('size', DEFAULT_WATERMARK_SIZE, (value) => value >= WATERMARK_MIN_SIZE && value <= WATERMARK_MAX_SIZE);
  const [opacity, setOpacity] = useRemembered<number>('opacity', DEFAULT_WATERMARK_OPACITY, (value) => value >= WATERMARK_MIN_OPACITY && value <= 1);
  const [rotation, setRotation] = useRemembered<number>('rotation', DEFAULT_WATERMARK_ROTATION_DEGREES, (value) => value >= WATERMARK_MIN_ROTATION_DEGREES && value <= WATERMARK_MAX_ROTATION_DEGREES);
  const [color, setColor] = useRemembered<string>('color', DEFAULT_WATERMARK_COLOR_HEX, (value) => /^#[0-9a-f]{6}$/i.test(value));
  // Fractions of the page, 0-1, with Y measured from the bottom, matching the app's option string.
  const [xPercent, setXPercent] = useState(DEFAULT_WATERMARK_X_PERCENT);
  const [yPercent, setYPercent] = useState(DEFAULT_WATERMARK_Y_PERCENT);

  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  /** The loaded file cannot be read (damaged, locked, not a PDF): Save stays off until another is chosen. */
  const [unreadable, setUnreadable] = useState(false);
  const [showLargePreview, setShowLargePreview] = useState(false);
  // Two fingers spread on the page open it large, as on Header & Footer and Crop (fable-2 item 7);
  // the second finger already puts a dragged text back where it was.
  const previewPinchRef = usePinchToOpen(() => setShowLargePreview(true));
  const largePreviewTriggerRef = useRef<HTMLButtonElement>(null);
  const [previewDimensions, setPreviewDimensions] = useState({ width: 595, height: 842 });

  const [isDragging, setIsDragging] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const inlinePreviewRef = useRef<HTMLDivElement | null>(null);
  const modalPreviewRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragContainerRef = useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  const opacityPercent = Number((opacity * 100).toFixed(1));

  /**
   * The exact layout the export will use, in page points. Reusing it for the overlay is what makes
   * the preview honest about the rotated-bounding-box clamp and about rotation happening around
   * the mark's centre.
   */
  // Devanagari (Hindi, Marathi) is shaped with the bundled Mukta Bold that Edit PDF and Invoice
  // embed; it loads the first time such text is typed (research r2, mobile-01).
  const safeText = sanitizeWatermarkText(text);
  const devanagari = hasDevanagari(safeText);
  const [devanagariFonts, setDevanagariFonts] = useState<'idle' | 'ready' | 'failed'>(() => (devanagariFontsReady() ? 'ready' : 'idle'));
  useEffect(() => {
    if (!devanagari || devanagariFonts !== 'idle') return undefined;
    let live = true;
    loadDevanagariFonts()
      .then(() => { if (live) setDevanagariFonts('ready'); })
      .catch(() => { if (live) setDevanagariFonts('failed'); });
    return () => { live = false; };
  }, [devanagari, devanagariFonts]);
  const devanagariReady = devanagari && devanagariFonts === 'ready';
  const unsupportedCharacter = !devanagari
    ? unsupportedPdfPreviewCharacter(previewFont, safeText)
    : devanagariReady
      ? firstUnshapedDevanagariCharacter(safeText, WATERMARK_DEVANAGARI_FONT)
      : devanagariFonts === 'failed' ? [...safeText].find((character) => hasDevanagari(character)) ?? null : null;
  // Waiting for the Devanagari face: nothing to draw or save yet.
  const textPending = devanagari && !devanagariReady;
  const textValidationMessage = unsupportedCharacter ? t("business-document.error.b7890f176a", {
    v0: unsupportedCharacter,
    v1: unsupportedCharacter.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'),
  }) : null;
  const layout = useMemo(
    () =>
      unsupportedCharacter || !previewFont || textPending ? null : watermarkLayout({
        pageWidth: previewDimensions.width,
        pageHeight: previewDimensions.height,
        text,
        fontSize: size,
        rotationDegrees: rotation,
        placement: { xPercent, yPercent },
        measureTextWidth: (value, fontSize) => (devanagari
          ? measureDevanagariText(value, WATERMARK_DEVANAGARI_FONT, fontSize)
          : previewFont?.widthOfTextAtSize(value, fontSize) ?? 0),
      }),
    [previewFont, previewDimensions.height, previewDimensions.width, rotation, size, text, xPercent, yPercent, unsupportedCharacter, textPending, devanagari],
  );

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
    setUnreadable(false);
    setXPercent(DEFAULT_WATERMARK_X_PERCENT);
    setYPercent(DEFAULT_WATERMARK_Y_PERCENT);
    setShowLargePreview(false);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  };

  const handleApplyWatermark = async () => {
    if (!file || !previewFont || textValidationMessage || textPending || !sanitizeWatermarkText(text)) return;
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
      const outputName = toolOutputName('watermark', file.name, 'pdf');
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
        error: (await pdfFileProblem(file.file, error).catch(() => null))
          ?? (error instanceof Error ? localizeError(error) : t("watermark-pdf.failed.to.add.watermark.dade5d")),
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
      } catch (error) {
        // A file that cannot be read says so, with Repair PDF or Unlock PDF as the way on, and
        // Save stays off. Otherwise only the picture failed: the font still loads, so "You can
        // still add the watermark" is true (mobile-10).
        const problem = await pdfFileProblem(file.file, error).catch(() => null);
        const font = problem ? null : await getPdfPreviewFont(true).catch(() => null);
        if (!cancelled) {
          if (font) setPreviewFont(font);
          setUnreadable(Boolean(problem));
          setStatus({
            isProcessing: false,
            progress: 0,
            message: '',
            error: problem ?? t("watermark-pdf.the.preview.could.not.be.shown.you.bc2975"),
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

  /** Where the finger is on the page, 0–1 from the left and from the bottom. */
  const pointerOnPage = (container: HTMLDivElement, clientX: number, clientY: number) => {
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    // Pointer Y grows downwards; the option value is measured from the bottom of the page.
    return { x: (clientX - rect.left) / rect.width, y: 1 - (clientY - rect.top) / rect.height };
  };

  // A drag that starts on the text keeps the point it was grabbed by (🍎 sync 25 Nov 2026): the
  // text follows the finger instead of jumping its centre under it. A tap elsewhere places it.
  const grabOffsetRef = useRef({ x: 0, y: 0 });

  const placeWatermarkFromPointer = useCallback((clientX: number, clientY: number) => {
    const container = dragContainerRef.current;
    const point = container && pointerOnPage(container, clientX, clientY);
    if (!point) return;
    setXPercent(clamp(point.x + grabOffsetRef.current.x, 0, 1));
    setYPercent(clamp(point.y + grabOffsetRef.current.y, 0, 1));
  }, []);

  const grabsText = (event: React.PointerEvent, container: HTMLDivElement): boolean => {
    const point = layout && pointerOnPage(container, event.clientX, event.clientY);
    return Boolean(point && layout && isOnWatermark(layout, point.x * previewDimensions.width, point.y * previewDimensions.height));
  };

  // Large preview, zoomed in (C4, owner 25 Nov 2026): only a drag that starts on the text moves it;
  // one finger on blank page scrolls the page, as on Page Numbers. Not zoomed, a tap places the text.
  const panInsteadOfDrag = (event: React.PointerEvent, container: HTMLDivElement): boolean => {
    const view = container.closest<HTMLElement>('.tk-largepreview-view');
    if (!view || !layout || (view.scrollWidth <= view.clientWidth + 1 && view.scrollHeight <= view.clientHeight + 1)) return false;
    if (grabsText(event, container)) return false;
    const start = { x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop };
    const id = event.pointerId;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== id) return;
      view.scrollLeft = start.left - (next.clientX - start.x);
      view.scrollTop = start.top - (next.clientY - start.y);
    };
    const stop = (next: PointerEvent) => {
      // A second finger is a pinch: the preview's own two-finger handling takes over.
      if (next.type === 'pointerdown' ? next.pointerId === id : next.pointerId !== id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('pointerdown', stop, { capture: true });
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', stop, { passive: true });
    window.addEventListener('pointercancel', stop, { passive: true });
    window.addEventListener('pointerdown', stop, { capture: true, passive: true });
    return true;
  };

  const beginWatermarkDrag = (event: React.PointerEvent, container: HTMLDivElement | null) => {
    // Only the first finger drags; a second one is a pinch.
    if (!sanitizeWatermarkText(text) || !container || !event.isPrimary) return;
    event.preventDefault();
    if (panInsteadOfDrag(event, container)) return;
    event.stopPropagation();

    dragContainerRef.current = container;
    activePointerIdRef.current = event.pointerId;
    dragStartRef.current = { x: xPercent, y: yPercent };
    const point = pointerOnPage(container, event.clientX, event.clientY);
    grabOffsetRef.current = point && grabsText(event, container)
      ? { x: xPercent - point.x, y: yPercent - point.y }
      : { x: 0, y: 0 };
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
    // A second finger means a pinch (the large preview zooms): the text goes back where it was.
    const handleSecond = (event: PointerEvent) => {
      if (activePointerIdRef.current === null || event.pointerId === activePointerIdRef.current) return;
      const start = dragStartRef.current;
      if (start) { setXPercent(start.x); setYPercent(start.y); }
      setIsDragging(false);
      activePointerIdRef.current = null;
      dragContainerRef.current = null;
    };
    window.addEventListener('pointerdown', handleSecond, { capture: true, passive: true });

    window.addEventListener('pointermove', handleMove, { passive: true });
    window.addEventListener('pointerup', handleStop, { passive: true });
    window.addEventListener('pointercancel', handleStop, { passive: true });

    return () => {
      window.removeEventListener('pointerdown', handleSecond, { capture: true });
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleStop);
      window.removeEventListener('pointercancel', handleStop);
    };
  }, [isDragging, placeWatermarkFromPointer]);

  const title = t("watermark-pdf.watermark.pdf.903ce9");
  const toast = <StatusToast status={status} />;

  // Below 768 px the header has no Change control, so the screen takes a dropped file itself.
  useReplaceOnDrop({ onReplace: () => setFile(null), busy: status.isProcessing, off: wide || !file });

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("watermark-pdf.choose.a.pdf.to.watermark.a7c360")} />
          </div>
        )}
        toast={toast}
      />
    );
  }

  const trimmed = text.trim();
  const noText = !sanitizeWatermarkText(text);
  const textInvalid = noText || Boolean(textValidationMessage);
  const textLabel = t("watermark-pdf.watermark.text.9429e8");
  const sizeLabel = t("watermark-pdf.size.1af851");
  const opacityLabel = t("watermark-pdf.opacity.606265");
  const rotationLabel = t("watermark-pdf.rotation.57b5e2");
  const colorLabel = t("watermark-pdf.color.6b7319");
  const canSave = !status.isProcessing && !unreadable && Boolean(previewFont) && !textValidationMessage && !noText && !textPending;

  // The editors' controls: in each slot's editor on phones, beside the preview on desktop
  // (owner decision 1, A-005), so each change is one step. Same nodes, names and handlers.
  const textEditor = (
    <div>
      <div className="tk-field">
        <input
          value={text}
          aria-label={textLabel}
          aria-invalid={!!textValidationMessage}
          aria-describedby={textValidationMessage ? "watermark-text-error" : undefined}
          onChange={(event) => setText(event.target.value)}
          maxLength={MAX_PDF_TEXT_LENGTH}
          className="chef-field"
          placeholder={DEFAULT_WATERMARK_TEXT}
        />
      </div>
      {/* On phones the message is the page's notice line, which the open editor repeats, so it
          stays on screen once the editor closes (research r2, mobile-02). */}
      {wide && textValidationMessage && <p id="watermark-text-error" role="alert" className="tk-caution mt-2 !text-[var(--status-danger-text)]">{textValidationMessage}</p>}
    </div>
  );
  const sizeEditor = (
    <ChefSliderField
      label={sizeLabel}
      suffix="pt"
      decimals={1}
      min={WATERMARK_MIN_SIZE}
      max={WATERMARK_MAX_SIZE}
      step={0.5}
      keyStep={1}
      value={size}
      onChange={setSize}
      ariaLabel={t("watermark-pdf.watermark.size.2dccd4")}
      presets={[24, 36, 50, 72]}
      presetText={(value) => points(value)}
    />
  );
  const opacityEditor = (
    <ChefSliderField
      label={opacityLabel}
      suffix="%"
      decimals={1}
      min={WATERMARK_MIN_OPACITY * 100}
      max={100}
      step={0.5}
      keyStep={1}
      value={opacityPercent}
      onChange={(next) => setOpacity(next / 100)}
      ariaLabel={t("watermark-pdf.watermark.opacity.d101b5")}
      presets={[10, 30, 50, 75]}
      presetText={(value) => percent(value)}
    />
  );
  const rotationEditor = (
    <ChefSliderField
      label={rotationLabel}
      suffix="°"
      decimals={1}
      min={WATERMARK_MIN_ROTATION_DEGREES}
      max={WATERMARK_MAX_ROTATION_DEGREES}
      step={0.5}
      keyStep={1}
      pageStep={15}
      value={rotation}
      onChange={setRotation}
      ariaLabel={t("watermark-pdf.watermark.rotation.f52934")}
      presets={[-45, 0, 45, 90]}
      presetText={(value) => degrees(value)}
    />
  );
  const settingSlot = (name: string, editor: React.ReactNode) => (wide
    ? { focusTarget: () => settingsRef.current?.querySelector<HTMLElement>(`[data-setting="${name}"] :is(input, [role="slider"])`) ?? null }
    : { editor });

  // "Stamp CONFIDENTIAL ■ at 50 pt, 30% · −45°." Two lines at most on a phone (owner decision 2026-11-24).
  const sentence = (
    <Sentence
      template="sentence.watermark.short"
      compact
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      slots={{
        text: {
          label: textLabel,
          text: noText ? t('sentence.watermark.text.unset') : clip(trimmed, clipLength(wide)),
          nameText: noText ? undefined : trimmed,
          tone: textInvalid ? 'error' : undefined,
          quiet: true,
          ...settingSlot('text', <EnterCloses valid={!textInvalid}>{textEditor}</EnterCloses>),
        },
        color: {
          label: colorLabel,
          inline: (
            <input
              type="color"
              value={color}
              aria-label={colorLabel}
              onChange={(event) => setColor(event.target.value)}
              disabled={status.isProcessing}
              className="tk-swatch"
            />
          ),
        },
        size: {
          label: sizeLabel,
          text: points(size, 1),
          quiet: true,
          ...settingSlot('size', sizeEditor),
        },
        // Opacity and rotation as one value whose card holds both sliders (owner decision
        // 2026-11-24, "short and quick"); desktop keeps both beside the preview.
        look: {
          label: pair(opacityLabel, rotationLabel),
          text: pair(percent(opacityPercent), degrees(rotation)),
          bidi: 'ltr',
          icon: <Blend size={15} strokeWidth={2} />,
          quiet: true,
          ...settingSlot('opacity', <div className="tk-sliders">{opacityEditor}{rotationEditor}</div>),
        },
      }}
    />
  );

  const positionEditor = (
    <div className="tk-sliders">
      <ChefSliderField label={t("watermark-pdf.horizontal.0abba4")} suffix="%" decimals={1} min={0} max={100} step={0.1} keyStep={1} value={xPercent * 100} onChange={(next) => setXPercent(next / 100)} ariaLabel={t("watermark-pdf.watermark.horizontal.position.a594dc")} row={!wide} />
      <ChefSliderField label={t("watermark-pdf.vertical.727cd3")} suffix="%" decimals={1} min={0} max={100} step={0.1} keyStep={1} value={yPercent * 100} onChange={(next) => setYPercent(next / 100)} ariaLabel={t("watermark-pdf.watermark.vertical.position.793ba3")} row={!wide} />
    </div>
  );
  const positionText = t("watermark-pdf.message.374fc52abe", { v0: formatNumber(xPercent * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), v1: formatNumber(yPercent * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });

  const renderPreviewCanvas = (containerRef: React.RefObject<HTMLDivElement | null>) => (
    <FitStage width={previewDimensions.width} height={previewDimensions.height}>
      <WatermarkPreviewSurface
        containerRef={containerRef}
        large={false}
        isDragging={isDragging}
        imageUrl={originalPreviewUrl}
        layout={layout}
        pageWidth={previewDimensions.width}
        pageHeight={previewDimensions.height}
        color={color}
        opacity={opacity}
        devanagari={devanagari}
        onPointerDown={(event) => beginWatermarkDrag(event, containerRef.current)}
      />
    </FitStage>
  );

  const body = (
    <PreviewFrame
      tools={(
        <button
          ref={largePreviewTriggerRef}
          type="button"
          onClick={() => setShowLargePreview(true)}
          aria-label={t("watermark-pdf.large.preview.ab2772")}
          title={t("watermark-pdf.large.preview.ab2772")}
          className="tk-iconbtn chef-pressable"
        >
          <Maximize2 aria-hidden size={18} />
        </button>
      )}
      foot={wide ? undefined : (
        <ChipEditor
          label={pair(t("watermark-pdf.horizontal.0abba4"), t("watermark-pdf.vertical.727cd3"))}
          text={positionText}
          editor={positionEditor}
          quiet
          disabled={status.isProcessing}
        />
      )}
    >
      <h2 className="sr-only">{t("watermark-pdf.live.preview.page.1.e4a4b6")}</h2>
      {previewLoading ? (
        <p role="status" className="tk-crop-state">{t("watermark-pdf.rendering.5d9292")}</p>
      ) : <div ref={previewPinchRef} className="tk-pinchbox">{renderPreviewCanvas(inlinePreviewRef)}</div>}
    </PreviewFrame>
  );

  const settings = wide ? (
    <div ref={settingsRef} className="tk-side-settings">
      <div data-setting="text" className="tk-side-setting">
        <span className="tk-side-label">{textLabel}</span>
        {textEditor}
      </div>
      <div data-setting="size" className="tk-side-setting">{sizeEditor}</div>
      <div data-setting="opacity" className="tk-side-setting">{opacityEditor}</div>
      <div data-setting="rotation" className="tk-side-setting">{rotationEditor}</div>
      <div data-setting="position" className="tk-side-setting">{positionEditor}</div>
    </div>
  ) : undefined;

  const action = (
    <button
      type="button"
      onClick={handleApplyWatermark}
      disabled={!canSave}
      className="tk-primary chef-pressable"
    >
      <Droplets aria-hidden size={18} />
      <span>{t("watermark-pdf.save.stamped.pdf.4051c0")}</span>
    </button>
  );

  const progress = status.isProcessing ? (
    <ProgressLine
      label={status.message || t("watermark-pdf.applying.watermark.339c47")}
      percent={formatPercent(Math.max(0, Math.min(100, status.progress)))}
      value={status.progress}
    />
  ) : undefined;

  return (
    <>
      <ToolScreen
        title={title}
        file={{ name: file.name }}
        heavyJob={{ bytes: file.size }}
        // In the header on phones too, as every tool's change-file control is: the foot keeps one row,
        // so a slot editor leaves more of the page in view (round 6, mobile-03 and the lead's note 1).
        change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={() => setFile(null)} disabled={status.isProcessing} />}
        kind="preview"
        bodyLabel={title}
        body={body}
        side={settings}
        sentence={sentence}
        notice={!wide && textValidationMessage ? <Notice tone="error" id="watermark-text-error" role="alert">{textValidationMessage}</Notice> : undefined}
        action={action}
        progress={progress}
        toast={toast}
      />

      {/* The shared full-screen preview (pass 3): zoom with − / + or two fingers, as on Page Numbers;
          one finger still drags the text, and the position reads under the page. */}
      {showLargePreview && file && (
        <LargePagePreview
          width={previewDimensions.width}
          height={previewDimensions.height}
          opener={largePreviewTriggerRef}
          onClose={() => setShowLargePreview(false)}
          foot={<><span>{t("watermark-pdf.drag.the.text.to.position.it.18cc0d")}</span><bdi className="tabular">{positionText}</bdi></>}
        >
          <WatermarkPreviewSurface
            containerRef={modalPreviewRef}
            large
            isDragging={isDragging}
            imageUrl={originalPreviewUrl}
            layout={layout}
            pageWidth={previewDimensions.width}
            pageHeight={previewDimensions.height}
            color={color}
            opacity={opacity}
            devanagari={devanagari}
            onPointerDown={(event) => beginWatermarkDrag(event, modalPreviewRef.current)}
          />
        </LargePagePreview>
      )}
    </>
  );
};
