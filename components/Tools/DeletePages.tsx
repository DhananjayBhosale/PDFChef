import { localizeError, pdfFailureNotice } from '../../services/i18n/errors.ts';
import { useWide } from '../../hooks/useMediaQuery';
import { formatPercent, t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ErrorText } from '../UI/ErrorText';
import { FileUpload } from '../UI/FileUpload';
import { PDFLoadingProgress } from '../UI/PDFLoadingProgress';
import { PDFFile, ProcessingStatus } from '../../types';
import { deletePagesFromPDF, getPdfPagePreviews, type PdfPreviewProgress } from '../../services/pdfLazy';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { Trash2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { StatusToast } from '../UI/StatusToast';
import { parseBoundedPageRange } from '../../services/pageRange';
import { formatBytes, toolOutputName } from '../UI/format';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { ChipActions, Notice, ProgressLine } from '../Tool/parts';
import { PageGrid } from '../Tool/PageGrid';
import { usePagePreview } from '../Tool/PagePeek';
import { rangePlaceholder } from '../UI/PageRangeSelector';
import { ApplyButton } from '../Tool/Popover';
import { useSharpPreviews, PREVIEW_SCALES } from '../Tool/useSharpPreviews';
import { pagesPhrase, type PageKeys } from '../Tool/values';
import { isConfirmEnter } from '../UI/keys';

/** The page phrases this sentence owns (plan 2.1); Delete says "marked", as its screen does. */
const DELETE_PAGE_KEYS: PageKeys = {
  all: 'sentence.delete.pages.all',
  single: 'sentence.delete.pages.single',
  range: 'sentence.delete.pages.range',
  list: 'sentence.delete.pages.list',
  selected: 'sentence.delete.pages.selected',
  none: 'sentence.delete.pages.none',
};

type Message = { text: string; tone: 'error' | 'caution' | 'outcome' };

/** The notice line's id, so the range field can point at its error. */
const NOTICE_ID = 'delete-pages-notice';

export const DeletePages: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  // Two fingers on a page, or its eye, open it large (pass 5).
  const preview = usePagePreview(file?.file, file?.name);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pagesToDelete, setPagesToDelete] = useState<number[]>([]);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<PdfPreviewProgress | null>(null);
  const [previewError, setPreviewError] = useState<{ title: string; detail?: string } | null>(null);
  const [rangeInput, setRangeInput] = useState('');
  // The typed range was rejected: the slot shows what was typed, in the error tone (A-015).
  const [rangeInvalid, setRangeInvalid] = useState(false);
  // A range typed and not marked yet: Save stays off until Mark takes it or the field is emptied
  // (DESIGN.md, "value typed but not applied"; overnight 2026-11-24, s3-02).
  const [rangeDraft, setRangeDraft] = useState(false);
  const rangeRef = useRef<HTMLInputElement>(null);
  // Phone (owner decision 2026-11-15, item 1): a setting appears once, as a value in the sentence
  // whose card holds its control. Desktop keeps the control on the screen beside the sentence.
  const wide = useWide();
  const [selectionMessage, setSelectionMessage] = useState<Message | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const totalPages = previews.length || file?.pageCount || 0;
  const pagesToDeleteSet = useMemo(() => new Set(pagesToDelete), [pagesToDelete]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setPreviewProgress(null);

    if (file) {
      setLoadingPreviews(true);
      setPreviewError(null);
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
        })
        .catch((error) => {
          if (cancelled) return;
          console.error(error);
          setPreviewError(pdfFailureNotice(error, t("delete-pages.the.pages.could.not.be.shown.choose.9884e4")));
          setLoadingPreviews(false);
        });
    } else {
      setPreviews([]);
      setPagesToDelete([]);
      setRangeInput('');
      setRangeInvalid(false);
      setRangeDraft(false);
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

  const onGridFit = useSharpPreviews(file?.file ?? null, previews, setPreviews, !loadingPreviews && !previewError);

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0) return;
    const f = files[0];
    if (!isPdfFile(f)) return;
    setFile({ id: uuidv4(), file: f, name: f.name, size: f.size });
  };

  const togglePage = (idx: number) => {
    setSelectionMessage(null);
    setRangeInvalid(false);
    setPagesToDelete((previous) => {
      if (previous.includes(idx)) return previous.filter((pageIndex) => pageIndex !== idx);
      if (totalPages > 0 && previous.length >= totalPages - 1) {
        setSelectionMessage({ text: t("delete-pages.at.least.one.page.must.remain.in.ba102e"), tone: 'caution' });
        return previous;
      }
      return [...previous, idx].sort((left, right) => left - right);
    });
  };

  /** Marks the typed range. False when it was rejected (its card then stays open with the error). */
  const markRange = (): boolean => {
    try {
      const requested = parseBoundedPageRange(rangeInput, totalPages);
      const next = new Set([...pagesToDelete, ...requested]);
      if (next.size >= totalPages) {
        setRangeInvalid(true);
        setSelectionMessage({ text: t("delete-pages.that.range.would.delete.every.page.at.59f472"), tone: 'error' });
        return false;
      }
      setRangeInvalid(false);
      setRangeDraft(false);
      setPagesToDelete([...next].sort((left, right) => left - right));
      setSelectionMessage({ text: t("delete-pages.page.marked.from.the.range.46e48c", { count: requested.length }), tone: 'outcome' });
      return true;
    } catch (error) {
      setRangeInvalid(Boolean(rangeInput.trim()));
      setSelectionMessage({
        text: error instanceof Error ? localizeError(error) : t("delete-pages.enter.a.valid.page.range.b43573"),
        tone: 'error',
      });
      return false;
    }
  };

  const handleDelete = async () => {
    if (!file || pagesToDelete.length === 0) return;
    if (pagesToDelete.length >= totalPages) {
      setSelectionMessage({ text: t("delete-pages.at.least.one.page.must.remain.in.ba102e"), tone: 'caution' });
      return;
    }
    setStatus({ isProcessing: true, progress: 10, message: t("delete-pages.removing.pages.ea3a94") });
    try {
      const pdfBytes = await deletePagesFromPDF(file.file, pagesToDelete);

      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        toolOutputName('delete-pages', file.name, 'pdf'),
      );
      setStatus({ isProcessing: false, progress: 100, message: t("delete-pages.trimmed.pdf.ready.fb86b7") });
    } catch (error) {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? localizeError(error) : t("delete-pages.the.pages.could.not.be.removed.try.cdda1c"),
      });
    }
  };

  const title = t("delete-pages.delete.pages.7c7be5");
  const toast = <StatusToast status={status} />;

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("delete-pages.choose.a.pdf.to.delete.pages.638ec0")} />
          </div>
        )}
        toast={toast}
      />
    );
  }

  const ready = !loadingPreviews && !previewError && totalPages > 0;
  const marked = pagesPhrase(DELETE_PAGE_KEYS, pagesToDelete, totalPages);
  const noneMarked = pagesToDelete.length === 0;
  const allMarked = totalPages > 0 && pagesToDelete.length >= totalPages;
  const liveLine = selectionMessage?.text ?? (allMarked
    ? t("delete-pages.at.least.one.page.must.remain.16f6e2")
    : t("delete-pages.remaining.marked.cd3caf", { v0: totalPages - pagesToDelete.length, v1: pagesToDelete.length }));

  // Today's field and Mark: on the screen at rest on desktop (owner decision 1), in the slot's card
  // on a phone, so the setting shows once (owner decision 2026-11-15). The slot reads the marks back.
  const rangeEditor = (
    <div className="tk-inline-field">
      <label className="tk-field">
        <span className="sr-only">{t("delete-pages.mark.a.page.range.145bb3")}</span>
        <input
          ref={rangeRef}
          value={rangeInput}
          onChange={(event) => {
            setRangeInput(event.target.value);
            setRangeInvalid(false);
            setRangeDraft(event.target.value.trim() !== '');
            // The rejected range's error goes with the text it was about.
            if (selectionMessage?.tone === 'error') setSelectionMessage(null);
          }}
          aria-invalid={rangeInvalid || undefined}
          // The field names its error (polish item 16): the notice line says what is wrong.
          aria-describedby={rangeInvalid && selectionMessage?.tone === 'error' ? NOTICE_ID : undefined}
          // A rejected range keeps its card open (the editor closes on Enter otherwise).
          onKeyDown={(event) => { if (isConfirmEnter(event) && !markRange()) event.preventDefault(); }}
          placeholder={rangePlaceholder(totalPages)}
          inputMode="text"
          maxLength={512}
          dir="ltr"
          className="chef-field"
        />
      </label>
      <ApplyButton apply={markRange} className="tk-btn chef-pressable">{t("delete-pages.mark.d7cda0")}</ApplyButton>
    </div>
  );

  const pagesSlot = {
    label: t("delete-pages.mark.a.page.range.145bb3"),
    // The sentence reads back only what is marked. A rejected range stays in the field,
    // and the notice says what is wrong with it.
    text: marked.text,
    bidi: marked.ltr ? 'ltr' as const : undefined,
    ...(wide ? { focusTarget: () => rangeRef.current } : { editor: rangeEditor }),
  };

  const sentence = ready ? (
    noneMarked ? (
      <Sentence
        template="sentence.delete.none"
        groupLabel={t('sentence.groupLabel', { tool: title })}
        disabled={status.isProcessing}
        slots={{ pages: pagesSlot }}
      />
    ) : (
      <Sentence
        template="sentence.delete.some"
        values={{ rest: t('sentence.delete.rest', { count: Math.max(1, totalPages - pagesToDelete.length) }) }}
        groupLabel={t('sentence.groupLabel', { tool: title })}
        disabled={status.isProcessing}
        slots={{ pages: pagesSlot }}
      />
    )
  ) : undefined;

  const chips = ready ? (
    <>
      {wide && rangeEditor}
      <ChipActions
        actions={[{
          key: 'restore',
          label: t("delete-pages.restore.all.a9c39c"),
          hidden: noneMarked,
          onClick: () => { setPagesToDelete([]); setRangeInvalid(false); setSelectionMessage({ text: t("delete-pages.all.pages.restored.4c39f1"), tone: 'outcome' }); },
        }]}
      />
    </>
  ) : undefined;

  // The sr-only live line above the grid already speaks this message.
  const notice = selectionMessage ? <Notice id={NOTICE_ID} tone={selectionMessage.tone}>{selectionMessage.text}</Notice> : null;

  const runLabel = (
    <>
      <Trash2 aria-hidden size={18} />
      <span>{t("delete-pages.save.without.those.pages.3b9676")}</span>
    </>
  );

  const progress = status.isProcessing ? (
    <ProgressLine label={status.message} percent={formatPercent(status.progress)} value={status.progress} />
  ) : undefined;

  const body = (
    <>
      {preview.modal}
      <h2 id="delete-pages-heading" className="sr-only">{title}</h2>
      {/* The sentence shows the choice; this line speaks today's messages when it changes. */}
      <p className="sr-only" role="status" aria-live="polite">{liveLine}</p>
      {loadingPreviews ? <PDFLoadingProgress progress={previewProgress} /> : previewError ? (
        <div className="tk-grid-state tk-grid-error">
          <p className="font-semibold"><ErrorText text={previewError.title} file={file?.file} /></p>
          {previewError.detail && <p className="mt-1 text-sm text-[var(--text-secondary)]">{previewError.detail}</p>}
          <button type="button" onClick={() => setFile(null)} className="tk-btn chef-pressable mt-3">{t("delete-pages.choose.another.pdf.9434e3")}</button>
        </div>
      ) : (
        <PageGrid count={previews.length} onFit={onGridFit} gestureRef={preview.pinchRef}>
          {previews.map((url, index) => {
            const isMarked = pagesToDeleteSet.has(index);
            return (
              <div key={index} className="tk-peekbox" data-peek-page={index}>
              <button
                type="button"
                onClick={() => togglePage(index)}
                aria-pressed={isMarked}
                aria-label={t("delete-pages.page.893387", { v0: isMarked ? t("delete-pages.restore.a76e13") : t("delete-pages.mark.d7cda0"), v1: index + 1 })}
                data-marked={isMarked ? '' : undefined}
                className="tk-tile chef-pressable"
              >
                <span className="tk-tile-page">
                  <img src={url} alt={t("delete-pages.page.preview.7f7e5e", { v0: index + 1 })} loading="lazy" decoding="async" draggable={false} />
                  {isMarked && <span aria-hidden className="tk-tile-mark"><Trash2 size={22} /></span>}
                </span>
                <span className="tk-tile-label tabular">{t("delete-pages.message.c140ba4857", { v0: index + 1 })}</span>
              </button>
              {preview.peek(index)}
              </div>
            );
          })}
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
      bodyLabelledBy="delete-pages-heading"
      body={body}
      sentence={sentence}
      chips={chips}
      notice={notice}
      onRun={() => void handleDelete()}
      runDisabled={loadingPreviews || noneMarked || allMarked || rangeInvalid || rangeDraft || status.isProcessing}
      runDescribedBy={rangeInvalid && selectionMessage?.tone === 'error' ? NOTICE_ID : undefined}
      runLabel={runLabel}
      progress={progress}
      toast={toast}
    />
  );
};
