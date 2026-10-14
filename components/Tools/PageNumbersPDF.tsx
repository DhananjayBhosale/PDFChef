import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Expand, Hash, Loader2 } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { ChefSliderField } from '../UI/ChefSlider';
import { PDFFile, ProcessingStatus } from '../../types';
import { addPageNumbersToPDF, getPDFPageCount } from '../../services/pdfDocument';
import { loadPDFDocument, renderPageAsImage } from '../../services/pdfBrowser';
import { getPdfPreviewLayoutSize } from '../../services/pdfPageGeometry';
import { getPdfPreviewFont, unsupportedPdfPreviewCharacter } from '../../services/pdfPreviewFont';
import type { PDFFont } from 'pdf-lib';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import {
  DEFAULT_PAGE_NUMBER_FONT_SIZE,
  DEFAULT_PAGE_NUMBER_FORMAT,
  DEFAULT_PAGE_NUMBER_X_PERCENT,
  DEFAULT_PAGE_NUMBER_Y_PERCENT,
  MAX_PAGE_NUMBER_FONT_SIZE,
  MAX_PDF_TEXT_LENGTH,
  MIN_PAGE_NUMBER_FONT_SIZE,
  androidExportFileName,
  buildPageNumberText,
  pageNumberLayout,
} from '../../services/androidParity';
import { StatusToast } from '../UI/StatusToast';
import { Button } from '../UI/Primitives';
import { ToolHeader, ToolPanel, ToolShell } from '../UI/ToolLayout';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type EditMode = 'drag' | 'resize' | null;

const parsePageInput = (value: string) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.floor(numeric);
  return rounded > 0 ? rounded : null;
};



export const PageNumbersPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [previewFont, setPreviewFont] = useState<PDFFont | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });

  const [format, setFormat] = useState(DEFAULT_PAGE_NUMBER_FORMAT);
  const [fontSize, setFontSize] = useState(DEFAULT_PAGE_NUMBER_FONT_SIZE);
  // Fractions of the page, 0-1, with Y measured from the bottom, matching the app's option string.
  const [xPercent, setXPercent] = useState(DEFAULT_PAGE_NUMBER_X_PERCENT);
  const [yPercent, setYPercent] = useState(DEFAULT_PAGE_NUMBER_Y_PERCENT);
  const [startPage, setStartPage] = useState('1');
  const [endPage, setEndPage] = useState('1');
  const [totalPages, setTotalPages] = useState(1);

  const [previewPageIndex, setPreviewPageIndex] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewDimensions, setPreviewDimensions] = useState({ width: 595, height: 842 });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const previewRequestRef = useRef(0);
  const editModeRef = useRef<EditMode>(null);
  const dragRef = useRef({
    startX: 0,
    startY: 0,
    startXPercent: DEFAULT_PAGE_NUMBER_X_PERCENT,
    startYPercent: DEFAULT_PAGE_NUMBER_Y_PERCENT,
    startFontSize: DEFAULT_PAGE_NUMBER_FONT_SIZE,
  });
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!previewContainerRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setPreviewSize({ width, height });
    });
    observer.observe(previewContainerRef.current);
    return () => observer.disconnect();
  }, [previewUrl]);

  const renderPreviewPage = useCallback(async (sourceFile: File, requestedPageIndex: number) => {
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setPreviewLoading(true);
    try {
      const pdf = await loadPDFDocument(sourceFile);
      const count = Math.max(1, pdf.numPages || 1);
      const clampedPage = clamp(requestedPageIndex, 0, count - 1);
      const preview = await renderPageAsImage(pdf, clampedPage, {
        format: 'image/jpeg',
        quality: 0.9,
        scale: 1.4,
      });

      const font = await getPdfPreviewFont();
      const layoutSize = getPdfPreviewLayoutSize(await pdf.getPage(clampedPage + 1));
      if (requestId !== previewRequestRef.current) {
        URL.revokeObjectURL(preview.objectUrl);
        return;
      }

      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      previewUrlRef.current = preview.objectUrl;

      setPreviewUrl(preview.objectUrl);
      setPreviewFont(font);
      setPreviewDimensions(layoutSize);
      setPreviewPageIndex(clampedPage);
      setPreviewError(null);
      setTotalPages(count);
    } catch (error) {
      if (requestId !== previewRequestRef.current) return;
      console.error(error);
      setPreviewError(t("page-numbers-pdf.the.preview.could.not.be.shown.you.e766b7"));
    } finally {
      if (requestId === previewRequestRef.current) setPreviewLoading(false);
    }
  }, []);

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0 || !isPdfFile(files[0])) return;
    const selected = files[0];
    const count = await getPDFPageCount(selected).catch(() => 1);
    const normalizedCount = Math.max(1, count);

    setFile({
      id: uuidv4(),
      file: selected,
      name: selected.name,
      size: selected.size,
      pageCount: normalizedCount,
    });
    setTotalPages(normalizedCount);
    setStartPage('1');
    setEndPage(String(normalizedCount));
    setPreviewPageIndex(0);

    void renderPreviewPage(selected, 0);
  };

  const validationMessage = useMemo(() => {
    const start = parsePageInput(startPage);
    const end = parsePageInput(endPage);

    if (startPage.trim() !== '' && start === null) return t("page-numbers-pdf.start.page.must.be.a.whole.number.4ab1c4");
    if (endPage.trim() !== '' && end === null) return t("page-numbers-pdf.end.page.must.be.a.whole.number.13a8fe");
    if (start !== null && start > totalPages) return t("page-numbers-pdf.start.page.must.be.within.1.cd1c4d", { v0: totalPages });
    if (end !== null && end > totalPages) return t("page-numbers-pdf.end.page.must.be.within.1.af1f39", { v0: totalPages });
    if (start !== null && end !== null && start > end) return t("page-numbers-pdf.start.page.must.be.less.than.or.28c57b");

    return null;
  }, [endPage, startPage, totalPages]);

  const resolvedStartPage = parsePageInput(startPage) ?? 1;
  const resolvedEndPage = parsePageInput(endPage) ?? totalPages;
  const previewPageNumber = previewPageIndex + 1;
  const previewIsNumbered = previewPageNumber >= resolvedStartPage && previewPageNumber <= resolvedEndPage;
  const previewText = buildPageNumberText(format, previewPageNumber, totalPages);

  /**
   * The layout the export will use, in page points, so the dashed box shows the label's real
   * clamped position and size instead of a separately invented one.
   */
  const unsupportedCharacter = unsupportedPdfPreviewCharacter(previewFont, previewText);
  const textValidationMessage = unsupportedCharacter ? t("business-document.error.b7890f176a", {
    v0: unsupportedCharacter,
    v1: unsupportedCharacter.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'),
  }) : null;
  const layout = useMemo(
    () =>
      unsupportedCharacter || !previewFont ? null : pageNumberLayout({
        pageWidth: previewDimensions.width,
        pageHeight: previewDimensions.height,
        text: previewText,
        placement: { xPercent, yPercent },
        fontSize,
        measureTextWidth: (value, fontSize) => previewFont?.widthOfTextAtSize(value, fontSize) ?? 0,
      }),
    [previewFont, fontSize, previewDimensions.height, previewDimensions.width, previewText, xPercent, yPercent, unsupportedCharacter],
  );

  const previewScaleX = previewSize.width / Math.max(1, previewDimensions.width);
  const previewScaleY = previewSize.height / Math.max(1, previewDimensions.height);
  const overlayFontPx = (layout?.fontSize ?? fontSize) * previewScaleY;
  const overlayBoxWidth = Math.max((layout?.boxWidth ?? 0) * previewScaleX + 16, 48);
  const overlayBoxHeight = Math.max(overlayFontPx * 1.6, 24);
  const overlayCenterX = (layout?.placement.xPercent ?? xPercent) * previewSize.width;
  // The layout's Y is measured from the bottom of the page; CSS `top` runs the other way.
  const overlayCenterY = layout
    ? (previewDimensions.height - layout.baselineY - layout.fontSize * 0.35) * previewScaleY
    : (1 - yPercent) * previewSize.height;
  const overlayLeft = clamp(overlayCenterX - overlayBoxWidth / 2, 0, Math.max(0, previewSize.width - overlayBoxWidth));
  const overlayTop = clamp(overlayCenterY - overlayBoxHeight / 2, 0, Math.max(0, previewSize.height - overlayBoxHeight));

  const startEditing = (event: React.PointerEvent, mode: Exclude<EditMode, null>) => {
    if (!previewSize.width || !previewSize.height) return;
    event.stopPropagation();

    editModeRef.current = mode;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startXPercent: xPercent,
      startYPercent: yPercent,
      startFontSize: fontSize,
    };
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) return;

    const onPointerMove = (event: PointerEvent) => {
      const mode = editModeRef.current;
      if (!mode || !previewSize.width || !previewSize.height) return;

      const dx = event.clientX - dragRef.current.startX;
      const dy = event.clientY - dragRef.current.startY;

      if (mode === 'drag') {
        // Dragging down lowers the value, because the value is measured up from the page bottom.
        setXPercent(clamp(dragRef.current.startXPercent + dx / previewSize.width, 0, 1));
        setYPercent(clamp(dragRef.current.startYPercent - dy / previewSize.height, 0, 1));
      } else if (mode === 'resize') {
        const primaryDelta = Math.max(dx, dy * 0.7);
        const scaled = dragRef.current.startFontSize * (1 + primaryDelta / 180);
        setFontSize(clamp(Math.round(scaled), MIN_PAGE_NUMBER_FONT_SIZE, MAX_PAGE_NUMBER_FONT_SIZE));
      }
    };

    const onPointerUp = () => {
      editModeRef.current = null;
      setEditing(false);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [editing, previewSize.height, previewSize.width]);

  const handleApply = async () => {
    if (!file || !previewFont || validationMessage || textValidationMessage) return;
    setStatus({ isProcessing: true, progress: 10, message: t("page-numbers-pdf.applying.page.numbers.e12e84") });

    try {
      const bytes = await addPageNumbersToPDF(file.file, {
        format,
        fontSize,
        xPercent,
        yPercent,
        startPage: resolvedStartPage,
        endPage: resolvedEndPage,
      });

      downloadBlob(
        new Blob([bytes], { type: 'application/pdf' }),
        androidExportFileName('page_numbers', file.name, 'pdf'),
      );
      setStatus({ isProcessing: false, progress: 100, message: t("page-numbers-pdf.numbered.pdf.ready.ff0828") });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? localizeError(error) : t("page-numbers-pdf.failed.to.add.page.numbers.57d338"),
      });
    }
  };

  const jumpPreviewPage = (next: number) => {
    if (!file) return;
    const clampedPage = clamp(next, 0, totalPages - 1);
    void renderPreviewPage(file.file, clampedPage);
  };

  return (
    <ToolShell width="full" centered={!file}>
      <ToolHeader title={t("page-numbers-pdf.page.numbers.78c8fa")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mx-auto max-w-3xl">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("page-numbers-pdf.choose.a.pdf.for.page.numbers.b73bd2")} />
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
            <ToolPanel className="space-y-2.5">
              <div className="flex items-center justify-between">
                {/* The rendered page is the preview; only its position needs saying. */}
                <div className="text-sm font-semibold text-[var(--text-primary)]">{t("page-numbers-pdf.message.8693d5b8c4", { v0: previewPageIndex + 1, v1: totalPages, v2: previewLoading ? " · Rendering…" : "" })}</div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onPointerDown={(event) => startEditing(event, 'resize')}
                    disabled={previewLoading || !previewUrl || !previewIsNumbered}
                    className="chef-hit-y flex h-10 w-touch items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                    aria-label={t("page-numbers-pdf.resize.page.number.ce2930")}
                  >
                    <Expand aria-hidden size={17} />
                  </button>
                  <button
                    onClick={() => jumpPreviewPage(previewPageIndex - 1)}
                    disabled={previewLoading || previewPageIndex <= 0}
                    className="chef-hit-y flex h-10 w-touch items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                    aria-label={t("page-numbers-pdf.previous.preview.page.030555")}
                  >
                    <ChevronLeft aria-hidden size={18} className="rtl:rotate-180" />
                  </button>
                  <button
                    onClick={() => jumpPreviewPage(previewPageIndex + 1)}
                    disabled={previewLoading || previewPageIndex >= totalPages - 1}
                    className="chef-hit-y flex h-10 w-touch items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                    aria-label={t("page-numbers-pdf.next.preview.page.48ae03")}
                  >
                    <ChevronRight aria-hidden size={18} className="rtl:rotate-180" />
                  </button>
                </div>
              </div>

              <div className="rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] p-2">
                {previewLoading && !previewUrl && (
                  <div className="flex items-center justify-center py-6 text-sm text-[var(--text-secondary)]">
                    <Loader2 aria-hidden className="mr-2 animate-spin" size={18} />{t("page-numbers-pdf.rendering.preview.f0a8e2")}</div>
                )}

                {previewError && !previewUrl && <div className="p-4 text-sm text-[var(--status-danger-text)]">{previewError}</div>}

                {previewUrl && (
                  <div
                    ref={previewContainerRef}
                    className="relative w-full overflow-hidden rounded-lg bg-white"
                    style={{ aspectRatio: `${previewDimensions.width} / ${previewDimensions.height}` }}
                  >
                    <img src={previewUrl} alt={t("page-numbers-pdf.page.preview.39a278")} className="absolute inset-0 h-full w-full object-contain" />

                    {previewIsNumbered && layout && (
                      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${previewDimensions.width} ${previewDimensions.height}`} aria-hidden>
                        <text
                          x={layout.baselineX}
                          y={previewDimensions.height - layout.baselineY}
                          fontFamily="Helvetica, Arial, sans-serif"
                          fontSize={layout.fontSize}
                          fill="#4d4d4d"
                          textLength={previewFont?.widthOfTextAtSize(layout.text, layout.fontSize) || undefined}
                          lengthAdjust="spacingAndGlyphs"
                        >{layout.text}</text>
                      </svg>
                    )}
                    {previewIsNumbered && (
                      <div
                        className={`absolute border-2 border-dashed ${editing ? 'border-ink-600' : 'border-ink-500'}`}
                        aria-label={t("page-numbers-pdf.drag.page.number.to.reposition.ff2e2e")}
                        style={{
                          left: overlayLeft,
                          top: overlayTop,
                          width: overlayBoxWidth,
                          height: overlayBoxHeight,
                          fontSize: overlayFontPx,
                          touchAction: 'none',
                        }}
                        onPointerDown={(event) => startEditing(event, 'drag')}
                      >
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* The drag/resize hint is gone: the Horizontal and Vertical
                  sliders below do the same job with visible labels. Only the
                  case the preview cannot explain itself is kept. */}
              {!previewIsNumbered && (
                <p className="type-caption text-[var(--text-secondary)]">{t("page-numbers-pdf.this.preview.page.is.outside.the.selected.d7d778")}</p>
              )}
            </ToolPanel>

            <ToolPanel className="space-y-3">
              <div>
                <label htmlFor="page-numbers-format" className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">{t("page-numbers-pdf.format.2f3436")}</label>
                <input id="page-numbers-format"
                  aria-invalid={!!textValidationMessage}
                  aria-describedby={textValidationMessage ? "page-number-text-error" : undefined}
                  value={format}
                  onChange={(event) => setFormat(event.target.value)}
                  maxLength={MAX_PDF_TEXT_LENGTH}
                  className="chef-field"
                />
                {/* Kept: the token syntax is not guessable from the field. */}
                <p className="type-caption mt-1 text-[var(--text-tertiary)]">
                  <code>{'{n}'}</code>{t("page-numbers-pdf.is.the.page.number.cc3209")}<code>{'{total}'}</code>{t("page-numbers-pdf.the.total.fa2f83")}</p>
              </div>

              <div>
                <ChefSliderField
                  label={t("page-numbers-pdf.font.size.6d784d")}
                  suffix="pt"
                  decimals={1}
                  min={MIN_PAGE_NUMBER_FONT_SIZE}
                  max={MAX_PAGE_NUMBER_FONT_SIZE}
                  step={0.5}
                  value={fontSize}
                  onChange={setFontSize}
                  ariaLabel={t("page-numbers-pdf.page.number.font.size.23be36")}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
                <div>
                  <ChefSliderField label={t("page-numbers-pdf.horizontal.0abba4")} suffix="%" decimals={2} min={0} max={100} step={0.25} value={xPercent * 100} onChange={(next) => setXPercent(next / 100)} ariaLabel={t("page-numbers-pdf.page.number.horizontal.position.8e73c1")} />
                </div>
                <div>
                  <ChefSliderField label={t("page-numbers-pdf.from.bottom.9104dd")} suffix="%" decimals={2} min={0} max={100} step={0.25} value={yPercent * 100} onChange={(next) => setYPercent(next / 100)} ariaLabel={t("page-numbers-pdf.page.number.vertical.position.876aaa")} />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="page-numbers-start" className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">{t("page-numbers-pdf.start.page.d0b3b9")}</label>
                  <input id="page-numbers-start"
                    value={startPage}
                    onChange={(event) => setStartPage(event.target.value.replace(/[^\d]/g, ''))}
                    className="chef-field"
                    inputMode="numeric"
                  />
                </div>
                <div>
                  <label htmlFor="page-numbers-end" className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">{t("page-numbers-pdf.end.page.54dbe3")}</label>
                  <input id="page-numbers-end"
                    value={endPage}
                    onChange={(event) => setEndPage(event.target.value.replace(/[^\d]/g, ''))}
                    className="chef-field"
                    inputMode="numeric"
                  />
                </div>
              </div>

              {/* The healthy state only restated the two fields above it, so the
                  box now appears solely when the range is invalid. */}
              {textValidationMessage && <p id="page-number-text-error" role="alert" className="text-xs text-[var(--status-danger-text)]">{textValidationMessage}</p>}
              {validationMessage && (
                <div role="alert" className="rounded-[var(--radius-field)] bg-[var(--status-danger-quiet)] px-3 py-2 text-xs text-[var(--status-danger-text)]">
                  {validationMessage}
                </div>
              )}

              <Button
                tone="primary"
                block
                busy={status.isProcessing}
                disabled={!previewFont || !!validationMessage || !!textValidationMessage}
                icon={<Hash aria-hidden size={18} />}
                onClick={() => void handleApply()}
              >
                {status.isProcessing ? status.message || t("page-numbers-pdf.applying.page.numbers.e12e84") : t("page-numbers-pdf.save.numbered.pdf.5815aa")}
              </Button>

              <button
                onClick={() => {
                  previewRequestRef.current += 1;
                  setFile(null);
                  if (previewUrlRef.current) {
                    URL.revokeObjectURL(previewUrlRef.current);
                    previewUrlRef.current = null;
                  }
                  setPreviewUrl(null);
                }}
                className="chef-pressable chef-hit-y w-full rounded-[var(--radius-control)] py-2 text-sm font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
              >{t("page-numbers-pdf.choose.another.file.26eac8")}</button>
            </ToolPanel>
          </motion.div>
        )}
      </AnimatePresence>

      <StatusToast status={status} />
    </ToolShell>
  );
};
