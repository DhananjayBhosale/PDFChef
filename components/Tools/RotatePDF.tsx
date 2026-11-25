import { formatPercent, t } from '../../services/i18n/core.ts';
import { localizeError, pdfFailureNotice } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorText } from '../UI/ErrorText';
import { FileUpload } from '../UI/FileUpload';
import { PDFLoadingProgress } from '../UI/PDFLoadingProgress';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPdfPagePreviews, rotateSpecificPages, type PdfPreviewProgress } from '../../services/pdfLazy';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { RotateCw, Save } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { PageThumbnail } from '../UI/PageThumbnail';
import { StatusToast } from '../UI/StatusToast';
import { sanitizePageRotationDegrees } from '../../services/androidParity';
import { formatBytes, toolOutputName } from '../UI/format';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { ChipActions, Notice, ProgressLine } from '../Tool/parts';
import { PageGrid, type GridFit } from '../Tool/PageGrid';
import { usePagePreview } from '../Tool/PagePeek';
import { pagesPhrase, turnOutcome, type PageKeys } from '../Tool/values';

/** What the two words will turn (plan 2.10, line 1). Literal keys for the localization check. */
const ROTATE_PAGE_KEYS: PageKeys = {
  all: 'sentence.rotate.pages.all',
  single: 'sentence.rotate.pages.single',
  range: 'sentence.rotate.pages.range',
  list: 'sentence.rotate.pages.list',
  selected: 'sentence.rotate.pages.selected',
};

/** What Save will write (line 2): four or more scattered pages read "{count} pages". */
const TURNED_PAGE_KEYS: PageKeys = {
  all: 'sentence.rotate.turned.all',
  single: 'sentence.rotate.turned.single',
  range: 'sentence.rotate.turned.range',
  list: 'sentence.rotate.turned.list',
  selected: 'sentence.rotate.turned.selected',
};

const OUTCOME_KEYS = {
  right: 'rotate.outcome.right',
  left: 'rotate.outcome.left',
  flip: 'rotate.outcome.flip',
  mixed: 'rotate.outcome.mixed',
} as const;

/** Preview render scales: a grid that draws tiles larger than the bitmap asks for the next one (plan 2.4). */
const PREVIEW_SCALES = [0.3, 0.6, 1, 1.5] as const;
const SHARP_PREVIEW_LIMIT = 24;

export const RotatePDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  // Two fingers on a page, or its eye, open it large (pass 5).
  const preview = usePagePreview(file?.file, file?.name);
  const [previews, setPreviews] = useState<string[]>([]);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<PdfPreviewProgress | null>(null);
  const [previewError, setPreviewError] = useState<{ title: string; detail?: string } | null>(null);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({}); // Map pageIndex -> rotation
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const loadedScaleRef = useRef<number>(PREVIEW_SCALES[0]);
  const [wantedScale, setWantedScale] = useState<number>(PREVIEW_SCALES[0]);
  const [pageWidthPoints, setPageWidthPoints] = useState(0);
  const totalPages = previews.length || file?.pageCount || 0;
  const rotationArray = (Object.entries(pageRotations) as Array<[string, number]>)
    .filter(([_, rotation]) => sanitizePageRotationDegrees(rotation) !== 0)
    .map(([pageIndex, rotation]) => ({ pageIndex: Number(pageIndex), rotation: sanitizePageRotationDegrees(rotation) }));
  const hasRotationChanges = rotationArray.length > 0;

  // Load previews
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setPreviewProgress(null);

    if (file) {
      setLoadingPreviews(true);
      setPreviewError(null);
      loadedScaleRef.current = PREVIEW_SCALES[0];
      setWantedScale(PREVIEW_SCALES[0]);
      getPdfPagePreviews(file.file, {
        scale: PREVIEW_SCALES[0],
        signal: controller.signal,
        onProgress: (progress) => { if (!cancelled) setPreviewProgress(progress); },
      })
        .then(urls => {
          if (cancelled) {
            revokeObjectUrls(urls);
            return;
          }
          setPreviews(urls);
          setLoadingPreviews(false);
          // Initialize rotations to 0
          const initialRotations: Record<number, number> = {};
          for (let i = 0; i < urls.length; i += 1) initialRotations[i] = 0;
          setPageRotations(initialRotations);
          setSelectedPages(Array.from({ length: urls.length }, (_, index) => index));
          setSelectionMessage(null);
        })
        .catch(err => {
          if (cancelled) return;
          console.error(err);
          setPreviewError(pdfFailureNotice(err, t("rotate-pdf.the.pages.could.not.be.shown.choose.9884e4")));
          setLoadingPreviews(false);
        });
    } else {
      setPreviews([]);
      setPageRotations({});
      setSelectedPages([]);
      setSelectionMessage(null);
      setPreviewError(null);
    }

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file]);

  useEffect(() => {
    return () => {
      revokeObjectUrls(previews);
    };
  }, [previews]);

  // Sharper thumbnails when the grid draws tiles wider than the preview bitmap (plan 2.4).
  // Only the pictures are replaced: the selection and the turns stay.
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
    const count = previews.length;
    getPdfPagePreviews(file.file, { scale, signal: controller.signal })
      .then((urls) => {
        if (cancelled || urls.length !== count) { revokeObjectUrls(urls); return; }
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

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0) return;
    const f = files[0];
    if (!isPdfFile(f)) return;

    setFile({
      id: uuidv4(),
      file: f,
      name: f.name,
      size: f.size,
    });
  };

  const togglePage = (index: number) => {
    setSelectionMessage(null);
    setSelectedPages(prev =>
      prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]
    );
  };

  const rotateSelected = (angle: 90 | -90) => {
    if (selectedPages.length === 0) {
      setSelectionMessage(t("rotate-pdf.select.at.least.one.page.to.rotate.0729e0"));
      return;
    }
    const next = { ...pageRotations };
    selectedPages.forEach(index => {
      next[index] = sanitizePageRotationDegrees((next[index] || 0) + angle);
    });
    setPageRotations(next);
    // Say how the selected pages now face, not what this tap did: two right turns
    // are 180°, and right then left is upright again. Upright, upside down or a
    // mix has no 90° turn to name, so the line goes back to the selection count.
    const turns = new Set(selectedPages.map(index => next[index]));
    const turn = turns.size === 1 ? [...turns][0] : 0;
    setSelectionMessage(
      turn === 90 || turn === -90
        ? t(turn < 0 ? 'rotate.turned.left' : 'rotate.turned.right', { count: selectedPages.length })
        : null,
    );
  };

  const resetRotation = () => {
    const next: Record<number, number> = {};
    for (let i = 0; i < totalPages; i += 1) next[i] = 0;
    setPageRotations(next);
    setSelectionMessage(t("rotate-pdf.all.rotation.changes.reset.6ccc9a"));
  };

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: t("rotate-pdf.applying.rotations.dbe0c1") });

    try {
      if (rotationArray.length === 0) {
        setStatus({ isProcessing: false, progress: 0, message: '', error: t("rotate-pdf.select.at.least.one.page.and.a.18a7e9") });
        return;
      }

      const pdfBytes = await rotateSpecificPages(file.file, rotationArray, (current, total) => {
        setStatus({
          isProcessing: true,
          progress: Math.round((current / Math.max(1, total)) * 100),
          message: t("rotate-pdf.rotating.page.of.c99b01", { v0: current, v1: total }),
        });
      });

      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        toolOutputName('rotate', file.name, 'pdf'),
      );
      setStatus({ isProcessing: false, progress: 100, message: t("rotate-pdf.rotated.pdf.ready.d9ab7a") });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? localizeError(error) : t("rotate-pdf.rotation.failed.7a64b8"),
      });
    }
  };

  const title = t("rotate-pdf.rotate.pages.0cbe65");
  const toast = <StatusToast status={status} />;

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("rotate-pdf.choose.a.pdf.to.rotate.123e33")} />
          </div>
        )}
        toast={toast}
      />
    );
  }

  const selectionActions = [
    {
      key: 'select-all',
      label: t("rotate-pdf.select.all.1fc9a3"),
      disabled: totalPages === 0 || selectedPages.length === totalPages,
      onClick: () => {
        setSelectedPages(Array.from({ length: totalPages }, (_, index) => index));
        setSelectionMessage(t("rotate-pdf.all.pages.selected.044753"));
      },
    },
    {
      // Clear only drops the selection. Turns stay, and Reset is
      // the one control that undoes them.
      key: 'clear',
      label: t("rotate-pdf.clear.83b12c"),
      disabled: selectedPages.length === 0,
      onClick: () => {
        setSelectedPages([]);
        setSelectionMessage(null);
      },
    },
    // Reset only exists once there is something to undo.
    { key: 'reset', label: t("rotate-pdf.reset.daee76"), hidden: !hasRotationChanges, onClick: resetRotation },
  ];

  const ready = !loadingPreviews && !previewError && totalPages > 0;
  const nothingSelected = selectedPages.length === 0;
  const pages = pagesPhrase(ROTATE_PAGE_KEYS, selectedPages, totalPages);

  // The two words act at once (D5): outlined pills with today's accessible names.
  const word = (direction: 'left' | 'right') => {
    const left = direction === 'left';
    return (
      <button
        type="button"
        onClick={() => rotateSelected(left ? -90 : 90)}
        disabled={nothingSelected || status.isProcessing}
        // The accessible name starts with the visible label (WCAG 2.5.3).
        aria-label={left
          ? t("rotate-pdf.left.90.rotate.selected.pages.counterclockwise.0fd123")
          : t("rotate-pdf.right.90.rotate.selected.pages.clockwise.a6de0a")}
        data-turn={direction}
        className="tk-word chef-pressable"
      >
        <RotateCw aria-hidden size={16} strokeWidth={2} className={left ? '-scale-x-100' : undefined} />
        <span>{left ? t('sentence.rotate.left') : t('sentence.rotate.right')}</span>
      </button>
    );
  };
  const wordSlot = (direction: 'left' | 'right') => ({
    label: direction === 'left' ? t("rotate-pdf.left.90.4b87de") : t("rotate-pdf.right.90.471b9b"),
    text: direction === 'left' ? t('sentence.rotate.left') : t('sentence.rotate.right'),
    inline: word(direction),
  });

  const sentence = ready ? (
    nothingSelected ? (
      <Sentence
        template="sentence.rotate.none"
        groupLabel={t('sentence.groupLabel', { tool: title })}
        disabled={status.isProcessing}
        slots={{ left: wordSlot('left'), right: wordSlot('right') }}
      />
    ) : (
      <Sentence
        template="sentence.rotate.some"
        groupLabel={t('sentence.groupLabel', { tool: title })}
        disabled={status.isProcessing}
        slots={{
          pages: { label: t("pdfto-image.pages.9046da"), text: pages.text, bidi: pages.ltr ? 'ltr' : undefined, static: true },
          left: wordSlot('left'),
          right: wordSlot('right'),
        }}
      />
    )
  ) : undefined;

  // Line 2: what Save will write, from the pages that now face a new way.
  const outcome = turnOutcome(pageRotations);
  const turnedPhrase = outcome ? pagesPhrase(TURNED_PAGE_KEYS, outcome.pages, totalPages) : null;
  const notice = outcome && turnedPhrase ? (
    <Notice>
      {t(OUTCOME_KEYS[outcome.direction], { pages: turnedPhrase.ltr ? `⁦${turnedPhrase.text}⁩` : turnedPhrase.text })}
    </Notice>
  ) : null;

  const action = (
    <button
      type="button"
      onClick={() => void handleSave()}
      disabled={!hasRotationChanges || status.isProcessing}
      className="tk-primary chef-pressable"
    >
      <Save aria-hidden size={18} />
      <span>{t("rotate-pdf.save.turned.pdf.fa1cfd")}</span>
    </button>
  );

  const progress = status.isProcessing ? (
    <ProgressLine
      label={t("rotate-pdf.rotating.pages.a6d7f2")}
      detail={status.message}
      percent={formatPercent(status.progress)}
      value={status.progress}
    />
  ) : undefined;

  const body = (
    <>
      {preview.modal}
      <h2 id="rotate-pages-heading" className="sr-only">{title}</h2>
      {/* The sentence shows the choice; this line speaks today's messages when it changes. */}
      <p className="sr-only" role="status" aria-live="polite">
        {selectionMessage ?? t("rotate-pdf.of.selected.2d057c", { v0: selectedPages.length, v1: totalPages })}
      </p>
      {loadingPreviews ? <PDFLoadingProgress progress={previewProgress} /> : previewError ? (
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
          <p className="font-semibold text-[var(--status-danger-text)]"><ErrorText text={previewError.title} file={file?.file} /></p>
          {previewError.detail && <p className="max-w-measure text-sm text-[var(--text-secondary)]">{previewError.detail}</p>}
          <button type="button" onClick={() => setFile(null)} className="tk-btn chef-pressable">{t('tool.chooseAnotherFile')}</button>
        </div>
      ) : (
        <PageGrid count={previews.length} onFit={onGridFit} gestureRef={preview.pinchRef}>
          {previews.map((url, index) => (
            <div key={index} className="tk-peekbox" data-peek-page={index}>
              <PageThumbnail
                pageIndex={index}
                imageUrl={url}
                isSelected={selectedPages.includes(index)}
                onToggle={() => togglePage(index)}
                rotation={pageRotations[index] || 0}
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
      file={{ name: file.name, meta: <>{totalPages > 0 && <>{t('format.pageCount', { count: totalPages })} · </>}{formatBytes(file.size)}</> }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={() => setFile(null)} disabled={status.isProcessing} />}
      kind="grid"
      bodyLabelledBy="rotate-pages-heading"
      body={body}
      sentence={sentence}
      chips={ready ? <ChipActions actions={selectionActions} /> : undefined}
      notice={notice}
      action={action}
      progress={progress}
      toast={toast}
    />
  );
};
