import { localizeError, pdfProblemMessage } from '../../services/i18n/errors.ts';
import { formatPercent, t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorText } from '../UI/ErrorText';
import { v4 as uuidv4 } from 'uuid';
import { Hash, Maximize2, Move, MoveDiagonal2, Type } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { ChefSliderField } from '../UI/ChefSlider';
import { PDFFile, ProcessingStatus } from '../../types';
import { addPageNumbersToPDF, getPDFPageCount, loadPDFDocument, renderPageAsImage } from '../../services/pdfLazy';
import { getPdfPreviewLayoutSize } from '../../services/pdfPageGeometry';
import { getPdfPreviewFont, unsupportedPdfPreviewCharacter } from '../../services/pdfPreviewFont';
import type { PDFFont } from 'pdf-lib';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { useReleasePdfDocument } from '../../hooks/useReleasePdfDocument';
import { DEFAULT_PAGE_NUMBER_FONT_SIZE, DEFAULT_PAGE_NUMBER_FORMAT, DEFAULT_PAGE_NUMBER_X_PERCENT, DEFAULT_PAGE_NUMBER_Y_PERCENT, MAX_PAGE_NUMBER_FONT_SIZE, MAX_PDF_TEXT_LENGTH, MIN_PAGE_NUMBER_FONT_SIZE, PAGE_NUMBER_FORMAT_PRESETS, buildPageNumberText, pageNumberLayout } from '../../services/androidParity';
import { StatusToast } from '../UI/StatusToast';
import { formatBytes, toolOutputName } from '../UI/format';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { ChipEditor, Sentence } from '../Tool/Sentence';
import { EnterCloses, PREVIEW_FLOOR_TALL } from '../Tool/Popover';
import { Notice, ProgressLine, TapChoices } from '../Tool/parts';
import { FitStage } from '../Tool/FitStage';
import { PagePager, PreviewFrame } from '../Tool/PreviewFrame';
import { LargePagePreview } from '../Tool/LargePagePreview';
import { SharpPageLayer } from '../Tool/SharpPageLayer';
import { usePinchToOpen } from '../Tool/PagePeek';
import { clip, clipLength, pair, points, quoted, spanPhrase, type PageKeys } from '../Tool/values';
import { useWide } from '../../hooks/useMediaQuery';
import { useReplaceOnDrop } from '../../hooks/useFileDrop';
import { useRemembered } from '../Tool/useRemembered';

/** The page phrases this sentence owns: the numbered pages are always one run (plan 2.11). */
const NUMBER_PAGE_KEYS: PageKeys = {
  all: 'sentence.pageNumbers.pages.all',
  single: 'sentence.pageNumbers.pages.single',
  range: 'sentence.pageNumbers.pages.range',
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Formats a person picks instead of typing braces (path to 9, part 2). The field keeps any other format. */
const FORMAT_PRESETS = PAGE_NUMBER_FORMAT_PRESETS;

/** Six places in words (path to 9, part 2): across, then from the bottom, as the sliders set them. */
const POSITION_PRESETS = [
  { key: 'pageNumbers.position.topLeft', x: 0.1, y: 1 - DEFAULT_PAGE_NUMBER_Y_PERCENT },
  { key: 'pageNumbers.position.topCenter', x: 0.5, y: 1 - DEFAULT_PAGE_NUMBER_Y_PERCENT },
  { key: 'pageNumbers.position.topRight', x: 0.9, y: 1 - DEFAULT_PAGE_NUMBER_Y_PERCENT },
  { key: 'pageNumbers.position.bottomLeft', x: 0.1, y: DEFAULT_PAGE_NUMBER_Y_PERCENT },
  { key: 'pageNumbers.position.bottomCenter', x: DEFAULT_PAGE_NUMBER_X_PERCENT, y: DEFAULT_PAGE_NUMBER_Y_PERCENT },
  { key: 'pageNumbers.position.bottomRight', x: 0.9, y: DEFAULT_PAGE_NUMBER_Y_PERCENT },
] as const;
type PositionKey = typeof POSITION_PRESETS[number]['key'];
const positionAt = (x: number, y: number) => POSITION_PRESETS.find((preset) => Math.abs(preset.x - x) < 0.005 && Math.abs(preset.y - y) < 0.005);

type EditMode = 'drag' | 'resize' | null;

const parsePageInput = (value: string) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.floor(numeric);
  return rounded > 0 ? rounded : null;
};



export const PageNumbersPDF: React.FC = () => {
  useI18n();
  const wide = useWide();
  const settingsRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<PDFFile | null>(null);
  useReleasePdfDocument(file?.file);
  const [previewFont, setPreviewFont] = useState<PDFFont | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });

  const [format, setFormat] = useRemembered<string>('format', DEFAULT_PAGE_NUMBER_FORMAT);
  const [fontSize, setFontSize] = useRemembered<number>('size', DEFAULT_PAGE_NUMBER_FONT_SIZE, (value) => value >= MIN_PAGE_NUMBER_FONT_SIZE && value <= MAX_PAGE_NUMBER_FONT_SIZE);
  // Fractions of the page, 0-1, with Y measured from the bottom, matching the app's option string.
  const [xPercent, setXPercent] = useRemembered<number>('x', DEFAULT_PAGE_NUMBER_X_PERCENT, (value) => value >= 0 && value <= 1);
  const [yPercent, setYPercent] = useRemembered<number>('y', DEFAULT_PAGE_NUMBER_Y_PERCENT, (value) => value >= 0 && value <= 1);
  const [startPage, setStartPage] = useState('1');
  const [endPage, setEndPage] = useState('1');
  const [totalPages, setTotalPages] = useState(1);

  const [previewPageIndex, setPreviewPageIndex] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [largePreview, setLargePreview] = useState(false);
  const largeOpenerRef = useRef<HTMLButtonElement>(null);
  const closeLargePreview = useCallback(() => setLargePreview(false), []);
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
      setPreviewError(pdfProblemMessage(error) ?? t("page-numbers-pdf.the.preview.could.not.be.shown.you.e766b7"));
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
    // Only the first finger drags; a second one is a pinch.
    if (!previewSize.width || !previewSize.height || !event.isPrimary) return;
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

  // Two fingers spread on the page open it large, as on Header & Footer and Crop (fable-2 item 7);
  // a number being dragged goes back where it was.
  const previewPinchRef = usePinchToOpen(() => {
    if (editModeRef.current) {
      setXPercent(dragRef.current.startXPercent);
      setYPercent(dragRef.current.startYPercent);
      setFontSize(dragRef.current.startFontSize);
      editModeRef.current = null;
      setEditing(false);
    }
    setLargePreview(true);
  });

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
        toolOutputName('page-numbers', file.name, 'pdf'),
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

  const title = t("page-numbers-pdf.page.numbers.78c8fa");
  const toast = <StatusToast status={status} />;
  const chooseAnotherFile = () => {
    previewRequestRef.current += 1;
    setFile(null);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
  };

  // Below 768 px the header has no Change control, so the screen takes a dropped file itself.
  useReplaceOnDrop({ onReplace: chooseAnotherFile, busy: status.isProcessing, off: wide || !file });

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("page-numbers-pdf.choose.a.pdf.for.page.numbers.b73bd2")} />
          </div>
        )}
        toast={toast}
      />
    );
  }

  const numberedCount = Math.max(0, resolvedEndPage - resolvedStartPage + 1);
  const spanInvalid = Boolean(validationMessage);
  const pagesPhrase = spanPhrase(NUMBER_PAGE_KEYS, resolvedStartPage, resolvedEndPage, totalPages);
  const pagesText = spanInvalid ? clip(`${startPage}–${endPage}`, clipLength(wide)) : pagesPhrase.text;
  // The format as the first numbered page will carry it: what Save writes, even when the field is empty.
  const formatted = buildPageNumberText(format, spanInvalid ? 1 : resolvedStartPage, totalPages);
  const formatLabel = t("page-numbers-pdf.format.2f3436");
  const sizeLabel = t("page-numbers-pdf.font.size.6d784d");
  const pagesLabel = t('sentence.pageNumbers.pagesLabel');
  const noticeId = `page-numbers-notice-${file.id}`;
  const blocked = !previewFont || Boolean(validationMessage) || Boolean(textValidationMessage);

  const hintId = `page-numbers-format-hint-${file.id}`;
  // Errors in the notice line (M-17): Save says why it is off, and the open editor shows the line too.
  const errorNoticeId = validationMessage || textValidationMessage ? noticeId : undefined;

  // The editors' controls: in each slot's editor on phones, beside the page on desktop
  // (owner decision 1, B-017), so each change is one step. Same nodes, names and handlers.
  const pagesEditor = (
    <div className="tk-fieldrow">
      <label className="tk-field" htmlFor="page-numbers-start">
        <span>{t("page-numbers-pdf.start.page.d0b3b9")}</span>
        <input id="page-numbers-start"
          value={startPage}
          onChange={(event) => setStartPage(event.target.value.replace(/[^\d]/g, ''))}
          aria-invalid={spanInvalid || undefined}
          aria-describedby={validationMessage ? noticeId : undefined}
          className="chef-field tk-num"
          inputMode="numeric"
        />
      </label>
      <label className="tk-field" htmlFor="page-numbers-end">
        <span>{t("page-numbers-pdf.end.page.54dbe3")}</span>
        <input id="page-numbers-end"
          value={endPage}
          onChange={(event) => setEndPage(event.target.value.replace(/[^\d]/g, ''))}
          aria-invalid={spanInvalid || undefined}
          aria-describedby={validationMessage ? noticeId : undefined}
          className="chef-field tk-num"
          inputMode="numeric"
        />
      </label>
    </div>
  );
  const formatEditor = (
    <div className="tk-fieldcol">
      {/* On a wide screen the word "Format" heads the presets and the box together; on a phone
          the editor's title says it. The group and the box are each named by it as well. */}
      <div className="tk-field">
        {wide && <span aria-hidden>{formatLabel}</span>}
        <TapChoices
          label={formatLabel}
          values={FORMAT_PRESETS}
          current={format as typeof FORMAT_PRESETS[number]}
          text={(preset) => buildPageNumberText(preset, 1, totalPages)}
          onPick={setFormat}
          disabled={status.isProcessing}
          columns={wide ? 2 : undefined}
          dense={!wide}
        />
      </div>
      <label htmlFor="page-numbers-format" className="tk-field">
        <span className="sr-only">{formatLabel}</span>
        {/* The token syntax is not guessable from the field, so it is drawn inside the field's
            box, under the text (T-14), and is the field's description (B-017 (2)). */}
        <span className="tk-hintfield">
          {/* Named by its label alone: the hint sits inside the label's box, so without this
              its words would join the name (it stays the description). */}
          <input id="page-numbers-format"
            aria-label={formatLabel}
            aria-invalid={!!textValidationMessage}
            aria-describedby={[hintId, textValidationMessage ? noticeId : null].filter(Boolean).join(' ')}
            value={format}
            onChange={(event) => setFormat(event.target.value)}
            maxLength={MAX_PDF_TEXT_LENGTH}
            className="chef-field"
          />
          <span id={hintId} className="tk-hintfield-hint">
            <code>{'{n}'}</code>{t("page-numbers-pdf.is.the.page.number.cc3209")}<code>{'{total}'}</code>{t("page-numbers-pdf.the.total.fa2f83")}
          </span>
        </span>
      </label>
    </div>
  );
  const sizeEditor = (
    <ChefSliderField
      label={sizeLabel}
      suffix="pt"
      decimals={1}
      min={MIN_PAGE_NUMBER_FONT_SIZE}
      max={MAX_PAGE_NUMBER_FONT_SIZE}
      step={0.5}
      keyStep={1}
      value={fontSize}
      onChange={setFontSize}
      ariaLabel={t("page-numbers-pdf.page.number.font.size.23be36")}
      presets={[8, 10, 12, 14]}
      presetText={(value) => points(value)}
    />
  );
  const settingSlot = (name: string, editor: React.ReactNode) => (wide
    ? { focusTarget: () => settingsRef.current?.querySelector<HTMLElement>(`[data-setting="${name}"] :is(input, [role="slider"])`) ?? null }
    : { editor });

  const sentence = (
    <Sentence
      template={numberedCount === 1 && !spanInvalid ? 'sentence.pageNumbers.one' : 'sentence.pageNumbers.many'}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      slots={{
        pages: {
          label: pagesLabel,
          text: pagesText,
          bidi: spanInvalid || pagesPhrase.ltr ? 'ltr' : undefined,
          tone: spanInvalid ? 'error' : undefined,
          quiet: true,
          ...settingSlot('pages', <EnterCloses valid={!spanInvalid}>{pagesEditor}</EnterCloses>),
        },
        format: {
          label: formatLabel,
          text: quoted(formatted, clipLength(wide)),
          nameText: quoted(formatted),
          tone: textValidationMessage ? 'error' : undefined,
          quiet: true,
          ...settingSlot('format', <EnterCloses valid={!textValidationMessage}>{formatEditor}</EnterCloses>),
        },
        size: {
          label: sizeLabel,
          text: points(fontSize, 1),
          icon: <Type size={15} strokeWidth={2} />,
          quiet: true,
          ...settingSlot('size', sizeEditor),
        },
      }}
    />
  );

  const notice = validationMessage
    ? <Notice tone="error" role="alert" id={noticeId}>{validationMessage}</Notice>
    : textValidationMessage
      ? <Notice tone="error" role="alert" id={noticeId}>{textValidationMessage}</Notice>
      : !previewIsNumbered && previewUrl
        ? <Notice tone="caution">{t("page-numbers-pdf.this.preview.page.is.outside.the.selected.d7d778")}</Notice>
        : null;

  const runLabel = (
    <>
      <Hash aria-hidden size={18} />
      <span>{t("page-numbers-pdf.save.numbered.pdf.5815aa")}</span>
    </>
  );

  const progress = status.isProcessing ? (
    <ProgressLine
      label={status.message || t("page-numbers-pdf.applying.page.numbers.e12e84")}
      percent={formatPercent(Math.max(0, Math.min(100, status.progress)))}
      value={status.progress}
    />
  ) : undefined;

  const positionPreset = positionAt(xPercent, yPercent);
  const positionLabel = t('pageNumbers.position');
  const positionEditor = (
    <div className="tk-sliders">
      {/* Left and right are the page's own sides, in every language. */}
      <div className="tk-field">
        {wide && <span aria-hidden>{positionLabel}</span>}
        <div dir="ltr">
          <TapChoices<PositionKey>
            label={positionLabel}
            values={POSITION_PRESETS.map((preset) => preset.key)}
            current={positionPreset?.key ?? POSITION_PRESETS[4].key}
            isCurrent={(key) => positionPreset?.key === key}
            text={(key) => t(key)}
            onPick={(key) => {
              const preset = POSITION_PRESETS.find((item) => item.key === key)!;
              setXPercent(preset.x);
              setYPercent(preset.y);
            }}
            disabled={status.isProcessing}
            columns={3}
            ltr={false}
            // Dense on desktop too: the side column is as narrow as a phone card, and "Bottom center"
            // broke onto two lines there (pass 3).
            dense
          />
        </div>
      </div>
      <ChefSliderField label={t("page-numbers-pdf.horizontal.0abba4")} suffix="%" decimals={2} min={0} max={100} step={0.25} keyStep={1} value={xPercent * 100} onChange={(next) => setXPercent(next / 100)} ariaLabel={t("page-numbers-pdf.page.number.horizontal.position.8e73c1")} row={!wide} />
      <ChefSliderField label={t("page-numbers-pdf.from.bottom.9104dd")} suffix="%" decimals={2} min={0} max={100} step={0.25} keyStep={1} value={yPercent * 100} onChange={(next) => setYPercent(next / 100)} ariaLabel={t("page-numbers-pdf.page.number.vertical.position.876aaa")} row={!wide} />
    </div>
  );

  const pageDrawing = previewUrl ? (
    <>
      <img src={previewUrl} alt={t("page-numbers-pdf.page.preview.39a278")} className="absolute inset-0 h-full w-full object-contain" draggable={false} />
      {/* In the large preview only: the part in sight at full detail, under the number. */}
      <SharpPageLayer source={{ file: file?.file ?? null }} pageIndex={previewPageIndex} />
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
    </>
  ) : null;

  const body = (
    <PreviewFrame
      tools={(
        // Full screen, to look closely (owner 2026-11-15: this place held the resize handle,
        // which read as full screen and did nothing when tapped; the handle is on the box now).
        <button
          ref={largeOpenerRef}
          type="button"
          onClick={() => setLargePreview(true)}
          disabled={!previewUrl}
          className="tk-iconbtn chef-pressable"
          aria-label={t("watermark-pdf.large.preview.6b8047")}
          title={t("watermark-pdf.large.preview.6b8047")}
        >
          <Maximize2 aria-hidden size={18} />
        </button>
      )}
      pager={<PagePager index={previewPageIndex} total={totalPages} onChange={jumpPreviewPage} disabled={previewLoading} />}
      foot={wide ? undefined : (
        <ChipEditor
          label={positionLabel}
          text={positionPreset ? t(positionPreset.key) : pair(formatPercent(xPercent * 100), formatPercent(yPercent * 100))}
          icon={<Move size={15} strokeWidth={2} />}
          editor={positionEditor}
          // Taller than other cards when it needs to be, so "From bottom" is never cut (pass 5, item 10).
          previewFloor={PREVIEW_FLOOR_TALL}
          quiet
          disabled={status.isProcessing}
        />
      )}
    >
      <h2 className="sr-only">{title}</h2>
      {previewLoading && !previewUrl && <p role="status" className="tk-crop-state">{t("page-numbers-pdf.rendering.preview.f0a8e2")}</p>}
      {previewError && !previewUrl && <p role="alert" className="tk-crop-state tk-grid-error"><ErrorText text={previewError} file={file?.file} /></p>}

      {previewUrl && (
        <div ref={previewPinchRef} className="tk-pinchbox">
        <FitStage width={previewDimensions.width} height={previewDimensions.height}>
          <div ref={previewContainerRef} className="tk-wm-surface relative h-full w-full overflow-hidden bg-white">
            {pageDrawing}
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
                  cursor: editing ? 'grabbing' : 'grab',
                }}
                onPointerDown={(event) => startEditing(event, 'drag')}
              >
                <button
                  type="button"
                  onPointerDown={(event) => startEditing(event, 'resize')}
                  disabled={previewLoading}
                  className="tk-pn-resize chef-pressable"
                  aria-label={t("page-numbers-pdf.resize.page.number.ce2930")}
                >
                  <MoveDiagonal2 aria-hidden size={12} />
                </button>
              </div>
            )}
          </div>
        </FitStage>
        </div>
      )}
      {largePreview && pageDrawing && (
        <LargePagePreview width={previewDimensions.width} height={previewDimensions.height} opener={largeOpenerRef} onClose={closeLargePreview}>
          {pageDrawing}
        </LargePagePreview>
      )}
    </PreviewFrame>
  );

  const settings = wide ? (
    <div ref={settingsRef} className="tk-side-settings">
      <div data-setting="format" className="tk-side-setting">{formatEditor}</div>
      <div data-setting="size" className="tk-side-setting">{sizeEditor}</div>
      <div data-setting="position" className="tk-side-setting">{positionEditor}</div>
      <div data-setting="pages" className="tk-side-setting">{pagesEditor}</div>
    </div>
  ) : undefined;

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: <>{t('format.pageCount', { count: totalPages })} · {formatBytes(file.size)}</> }}
      heavyJob={{ bytes: file.size }}
      // In the header on phones too, as Watermark (round 6, mobile-03).
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={chooseAnotherFile} disabled={status.isProcessing} />}
      kind="preview"
      bodyLabel={title}
      body={body}
      side={settings}
      sentence={sentence}
      notice={notice}
      onRun={() => void handleApply()}
      runDisabled={blocked || status.isProcessing}
      runDescribedBy={errorNoticeId}
      runLabel={runLabel}
      progress={progress}
      toast={toast}
    />
  );
};
