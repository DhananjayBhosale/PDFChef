import { t, formatNumber, formatPercent, type TranslationKey } from '../../services/i18n/core.ts';
import { LocalizedError, pdfFailureMessage, pdfProblemMessage } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useId, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Archive, Check, ChevronLeft, ChevronRight, Crop, Download, FileCheck, PanelBottom, PanelLeft, PanelRight, PanelTop, Trash2, Type } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { addHeaderFooterToPDF, cropPDFMargins, extractEmbeddedImagesFromPDF, findBlankPages, getPdfPagePreviews, loadDisposablePDFDocument, loadJSZip, loadPDFDocument, readHiddenInfo, removeBlankPagesFromPDF, removePDFAnnotations, removePDFMetadata, renderPageAsImage, sanitizePDF, type EmbeddedPdfImageAsset, type HeaderFooterOptions } from '../../services/pdfLazy';
import { headerFooterFontSize, headerFooterLines, interpolateHeaderFooterText } from '../../services/headerFooterText';
import { PAGE_NUMBER_FORMAT_PRESETS } from '../../services/androidParity';
import { downloadBlob, revokeObjectUrls } from '../../services/pdfShared';
import { formatBytes, formatTimestampLong, toolOutputName } from '../UI/format';
import type { HiddenInfoItem, HiddenInfoKey } from '../../services/pdfDocument';
import { useMonetization, type JobAccessGrant } from '../../hooks/useMonetization';
import { useReleasePdfDocument } from '../../hooks/useReleasePdfDocument';
import { StatusToast } from '../UI/StatusToast';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { EnterCloses, FieldLabel } from '../Tool/Popover';
import { ClampedNumberInput } from '../UI/ClampedNumberInput';
import { Notice, ProgressLine, Stepper, TapChoices, useStatusNotice } from '../Tool/parts';
import { useSharpPreviews, PREVIEW_SCALES } from '../Tool/useSharpPreviews';
import { ErrorText } from '../UI/ErrorText';
import { CropFrame } from '../Tool/CropFrame';
import { CROP_EDGES, clampMargin, cropForm, type CropEdge, type CropMargins } from '../Tool/cropMath';
import { FilePreview } from '../Tool/FilePreview';
import { FitStage } from '../Tool/FitStage';
import { PagePager, PreviewFrame } from '../Tool/PreviewFrame';
import { PageGrid } from '../Tool/PageGrid';
import { ExpandButton, usePagePreview, usePinchToOpen } from '../Tool/PagePeek';
import { LargePagePreview } from '../Tool/LargePagePreview';
import { SharpPageLayer } from '../Tool/SharpPageLayer';
import { joinSentences, numberList, pair, points, quoted, clipLength, sharedPictureNote } from '../Tool/values';
import { useWide } from '../../hooks/useMediaQuery';
import { useRemembered } from '../Tool/useRemembered';
import type { PDFFont } from 'pdf-lib';
import { getPdfPreviewFont, unsupportedPdfPreviewCharacter } from '../../services/pdfPreviewFont';

interface FileToolScreenProps {
  title: string;
  uploadLabel: string;
  /** Today's consequence line, moved from under the title to the sentence position (plan D9). */
  statement: TranslationKey;
  file: PDFFile | null;
  status: ProcessingStatus;
  onFilesSelected: (files: File[]) => void;
  onReset: () => void;
  actionLabel: string;
  onAction: () => void;
  /** Replaces the first-page preview in the canvas (Extract images draws the pictures it found). */
  body?: React.ReactNode;
  /** Replaces the status message as the outcome line. */
  outcome?: React.ReactNode;
  /** An extra line above the notice (today's second result line). */
  notice?: React.ReactNode;
  /** Beside the page on a wide screen, under it on a phone (Remove hidden info's list). */
  side?: React.ReactNode;
  className?: string;
}

/** The one-action file tools (plan 2.17): the file's first page, a statement, one notice line and the action. */
const FileToolScreen: React.FC<FileToolScreenProps> = ({
  title, uploadLabel, statement, file, status, onFilesSelected, onReset, actionLabel, onAction, body, outcome, notice,
  side, className,
}) => {
  useI18n();
  const statusNotice = useStatusNotice(status);

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={onFilesSelected} accept=".pdf,application/pdf" label={uploadLabel} error={status.error} />
          </div>
        )}
      />
    );
  }

  // The error, then the tool's own outcome, then its finished message (unless the result
  // strip already shows it, owner decision 2).
  const noticeLine = status.error ? statusNotice : outcome ?? statusNotice;

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: formatBytes(file.size) }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={onReset} disabled={status.isProcessing} />}
      kind="file"
      className={className}
      bodyLabel={title}
      body={body ?? <FilePreview file={file.file} name={file.name} meta={formatBytes(file.size)} />}
      side={side}
      sentence={<Sentence template={statement} groupLabel={t('sentence.groupLabel', { tool: title })} disabled={status.isProcessing} />}
      notice={notice || noticeLine ? <>{notice}{noticeLine}</> : null}
      onRun={onAction}
      runDisabled={status.isProcessing}
      runLabel={(
        <>
          <Download aria-hidden size={18} />
          <span>{actionLabel}</span>
        </>
      )}
      progress={status.isProcessing ? (
        <ProgressLine
          label={status.message || t("pdf-advanced-tools.processing.on.this.device.83aab2")}
          percent={formatPercent(Math.max(0, Math.min(100, status.progress)))}
          value={status.progress}
        />
      ) : undefined}
    />
  );
};

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

const toPdfFile = (files: File[]) => {
  const selected = files.find((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
  if (!selected) return null;
  return { id: uuidv4(), file: selected, name: selected.name, size: selected.size };
};

interface SimpleTransformToolProps {
  title: string;
  statement: TranslationKey;
  uploadLabel: string;
  actionLabel: string;
  outputPrefix: string;
  transform: (file: File) => Promise<Uint8Array>;
}

const SimpleTransformTool: React.FC<SimpleTransformToolProps> = ({
  title,
  statement,
  uploadLabel,
  actionLabel,
  outputPrefix,
  transform,
}) => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });

  const handleFilesSelected = (files: File[]) => {
    const next = toPdfFile(files);
    if (!next) {
      setStatus({ ...idleStatus(), error: t("pdf-advanced-tools.choose.a.pdf.file.c2a7df") });
      return;
    }
    setStatus(idleStatus());
    setFile(next);
  };

  const handleTransform = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 20, message: t("pdf-advanced-tools.processing.pdf.3087fc") });
    try {
      const bytes = await transform(file.file);
      const outputName = toolOutputName(outputPrefix, file.name, 'pdf');
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), outputName);
      setStatus({ isProcessing: false, progress: 100, message: t("pdf-advanced-tools.created.21ab7c", { v0: outputName }) });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: pdfProblemMessage(error) ?? t("pdf-advanced-tools.this.pdf.could.not.be.changed.if.82905a") });
    }
  };

  return (
    <FileToolScreen
      title={title}
      statement={statement}
      uploadLabel={uploadLabel}
      file={file}
      status={status}
      onFilesSelected={handleFilesSelected}
      onReset={() => {
        setFile(null);
        setStatus(idleStatus());
      }}
      actionLabel={actionLabel}
      onAction={handleTransform}
    />
  );
};

/** Each piece of hidden info by name: Document Info's own words for the six text fields. */
const HIDDEN_INFO_LABELS: Record<HiddenInfoKey, () => string> = {
  title: () => t('metadata-pdf.title.7e8cd2'),
  author: () => t('metadata-pdf.author.d95082'),
  subject: () => t('metadata-pdf.subject.689712'),
  keywords: () => t('metadata-pdf.keywords.8bfdb9'),
  creator: () => t('metadata-pdf.made.with.42c6b8'),
  producer: () => t('metadata-pdf.saved.as.pdf.by.854dda'),
  created: () => t('hiddenInfo.created'),
  modified: () => t('hiddenInfo.modified'),
  xmp: () => t('hiddenInfo.xmp'),
};

const hiddenInfoValue = (item: HiddenInfoItem): string => (
  item.value === true ? t('hiddenInfo.xmp.present')
    : item.value instanceof Date ? formatTimestampLong(item.value.getTime())
      : item.value
);

/**
 * What the file holds before the run, and what is gone after it (path to 9, part 2): read from the
 * chosen file, then again from the saved one. `left` is what the saved file still holds.
 */
const HiddenInfoList: React.FC<{ items: HiddenInfoItem[] | null; left: HiddenInfoItem[] | null; unreadable?: boolean }> = ({ items, left, unreadable }) => {
  useI18n();
  const headingId = useId();
  const saved = left !== null;
  const stillThere = new Set(left?.map((item) => item.key));
  return (
    <section className="tk-hidinfo" aria-labelledby={headingId}>
      <h2 id={headingId} className="tk-side-label">{t('hiddenInfo.heading')}</h2>
      {items === null ? (
        <p className="tk-hidinfo-state">{t('metadata-pdf.reading.this.pdf.s.details.on.your.3b0103')}</p>
      ) : items.length === 0 ? (
        <p className="tk-hidinfo-state">{unreadable ? t('metadata-pdf.this.pdf.s.details.could.not.be.ac723c') : t('hiddenInfo.none')}</p>
      ) : (
        <dl className="tk-hidinfo-list">
          {items.map((item) => {
            const removed = saved && !stillThere.has(item.key);
            return (
              <div key={item.key} className="tk-hidinfo-row" data-removed={removed ? '' : undefined}>
                <dt>{HIDDEN_INFO_LABELS[item.key]()}</dt>
                <dd>
                  <bdi className="tk-hidinfo-value">{hiddenInfoValue(item)}</bdi>
                  {removed && <span className="tk-hidinfo-gone"><Check aria-hidden size={14} strokeWidth={2.5} />{t('hiddenInfo.removed')}</span>}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {saved && items && items.length > 0 && (
        <p role="status" className="tk-hidinfo-state">
          {left.length === 0
            ? t('hiddenInfo.gone')
            : t('hiddenInfo.left', { v0: left.map((item) => HIDDEN_INFO_LABELS[item.key]()).join(', ') })}
        </p>
      )}
    </section>
  );
};

export const RemoveMetadataPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const [found, setFound] = useState<HiddenInfoItem[] | null>(null);
  const [left, setLeft] = useState<HiddenInfoItem[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const readRef = useRef(0);

  const choose = (files: File[]) => {
    const next = toPdfFile(files);
    if (!next) {
      setStatus({ ...idleStatus(), error: t('pdf-advanced-tools.choose.a.pdf.file.c2a7df') });
      return;
    }
    const read = readRef.current + 1;
    readRef.current = read;
    setStatus(idleStatus());
    setFile(next);
    setFound(null);
    setLeft(null);
    setUnreadable(false);
    // A file pdf-lib cannot read lists nothing and says its details could not be read, never that
    // it has no hidden info (s5-02). The run says why it cannot be cleaned.
    readHiddenInfo(next.file).then(
      (items) => { if (readRef.current === read) setFound(items); },
      () => { if (readRef.current === read) { setFound([]); setUnreadable(true); } },
    );
  };

  const run = async () => {
    if (!file) return;
    setLeft(null);
    setStatus({ isProcessing: true, progress: 20, message: t('pdf-advanced-tools.processing.pdf.3087fc') });
    try {
      const bytes = await removePDFMetadata(file.file);
      const outputName = toolOutputName('remove-hidden-info', file.name, 'pdf');
      // What the saved file still holds, read from its own bytes before it is handed over.
      const remaining = await readHiddenInfo(bytes).catch(() => null);
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), outputName);
      setLeft(remaining);
      setStatus({ isProcessing: false, progress: 100, message: t('pdf-advanced-tools.created.21ab7c', { v0: outputName }) });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: pdfProblemMessage(error) ?? t('pdf-advanced-tools.this.pdf.could.not.be.changed.if.82905a') });
    }
  };

  return (
    <FileToolScreen
      title={t('pdf-advanced-tools.remove.hidden.info.fa4793')}
      statement="pdf-advanced-tools.clears.the.author.the.dates.and.the.3fc978"
      uploadLabel={t('pdf-advanced-tools.choose.a.pdf.to.clean.e0a661')}
      file={file}
      status={status}
      onFilesSelected={choose}
      onReset={() => {
        readRef.current += 1;
        setFile(null);
        setFound(null);
        setLeft(null);
        setUnreadable(false);
        setStatus(idleStatus());
      }}
      actionLabel={t('pdf-advanced-tools.remove.hidden.info.fa4793')}
      onAction={run}
      className="tk-hidinfo-tool"
      side={<HiddenInfoList items={found} left={left} unreadable={unreadable} />}
    />
  );
};

export const RemoveAnnotationsPDF: React.FC = () => { useI18n(); return (
  <SimpleTransformTool
    title={t("pdf-advanced-tools.remove.comments.0788e6")}
    statement="pdf-advanced-tools.removes.comments.notes.highlights.and.links.form.e7de67"
    uploadLabel={t("pdf-advanced-tools.choose.a.pdf.to.clean.e0a661")}
    actionLabel={t("pdf-advanced-tools.remove.comments.0788e6")}
    outputPrefix="remove-comments"
    transform={removePDFAnnotations}
  />
); };

export const SanitizePDF: React.FC = () => { useI18n(); return (
  <SimpleTransformTool
    title={t("pdf-advanced-tools.clean.up.pdf.33d903")}
    statement="pdf-advanced-tools.removes.hidden.info.and.comments.in.one.732679"
    uploadLabel={t("pdf-advanced-tools.choose.a.pdf.to.clean.e0a661")}
    actionLabel={t("pdf-advanced-tools.clean.up.pdf.0b4aaa")}
    outputPrefix="clean"
    transform={sanitizePDF}
  />
); };

/** The four edges as the sentence and the frame name them (plan 2.13). Literal keys. */
const CROP_EDGE_KEYS = {
  top: 'crop.edge.top',
  right: 'crop.edge.right',
  bottom: 'crop.edge.bottom',
  left: 'crop.edge.left',
} as const;
const CROP_EDGE_ICONS: Record<CropEdge, React.ReactNode> = {
  top: <PanelTop size={15} strokeWidth={2} />,
  right: <PanelRight size={15} strokeWidth={2} />,
  bottom: <PanelBottom size={15} strokeWidth={2} />,
  left: <PanelLeft size={15} strokeWidth={2} />,
};

/**
 * A number field showing 0 that is typed into reads "012": the browser keeps the text because it
 * equals the state's 12 as a number (polish item 17). Drop the leading zeros as it is typed.
 */
const dropLeadingZeros = (input: HTMLInputElement) => {
  if (/^0\d/.test(input.value)) input.value = input.value.replace(/^0+(?=\d)/, '');
};

export const CropPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [margins, setMargins] = useState({ top: 5, right: 5, bottom: 5, left: 5 });
  // The live preview: one page of the file, drawn as it is seen (plan 2.13).
  const [pageCount, setPageCount] = useState(0);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [preview, setPreview] = useState<{ url: string; width: number; height: number } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  // Watermark's expand button and two fingers on the page open it large, frame and all (pass 5).
  const [largeCrop, setLargeCrop] = useState(false);
  const largeCropOpener = useRef<HTMLButtonElement>(null);
  const cropPinchRef = usePinchToOpen(() => setLargeCrop(true));
  // While the "all edges" editor is open the sentence keeps its frame, so typing one
  // edge there does not close the editor under the person's fingers.
  const [openEditor, setOpenEditor] = useState<string | null>(null);
  const [heldForm, setHeldForm] = useState<'none' | 'same' | 'each' | null>(null);
  const wide = useWide();
  const cropFieldsRef = useRef<HTMLDivElement>(null);
  useReleasePdfDocument(file?.file ?? null);
  const cropStatusNotice = useStatusNotice(status);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      setPageCount(0);
      setPreviewFailed(false);
      return undefined;
    }
    let active = true;
    let created: string | null = null;
    setPreviewFailed(false);
    (async () => {
      try {
        const pdf = await loadPDFDocument(file.file);
        const count = Math.max(1, pdf.numPages || 1);
        const index = Math.max(0, Math.min(count - 1, previewIndex));
        const scale = Math.min(2, Math.max(1.25, window.devicePixelRatio || 1));
        const rendered = await renderPageAsImage(pdf, index, { format: 'image/jpeg', quality: 0.9, scale });
        if (!active) { URL.revokeObjectURL(rendered.objectUrl); return; }
        created = rendered.objectUrl;
        setPageCount(count);
        setPreview({ url: rendered.objectUrl, width: rendered.width, height: rendered.height });
      } catch (error) {
        console.error(error);
        if (active) { setPreview(null); setPreviewFailed(true); }
      }
    })();
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [file, previewIndex]);

  const clearStatus = () => {
    if (!status.isProcessing && (status.error || status.progress === 100)) setStatus(idleStatus());
  };

  const setMargin = (key: keyof typeof margins, value: string) => {
    clearStatus();
    setMargins((current) => ({ ...current, [key]: Math.max(0, Math.min(40, Number(value) || 0)) }));
  };

  /** The frame and the "All edges" stepper set whole numbers 0–40 the same way. */
  const changeMargins = (next: CropMargins) => {
    if (status.isProcessing) return;
    clearStatus();
    setMargins({
      top: clampMargin(next.top),
      right: clampMargin(next.right),
      bottom: clampMargin(next.bottom),
      left: clampMargin(next.left),
    });
  };

  const handleCrop = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 20, message: t("pdf-advanced-tools.trimming.the.edges.bf7d52") });
    try {
      const bytes = await cropPDFMargins(file.file, margins);
      const outputName = toolOutputName('crop', file.name, 'pdf');
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), outputName);
      setStatus({ isProcessing: false, progress: 100, message: t("pdf-advanced-tools.created.21ab7c", { v0: outputName }) });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: pdfProblemMessage(error) ?? t("pdf-advanced-tools.this.pdf.could.not.be.cropped.try.b13377") });
    }
  };

  const reset = () => {
    setFile(null);
    setStatus(idleStatus());
    setPreviewIndex(0);
  };

  const title = t("pdf-advanced-tools.crop.pdf.dc4bdb");
  const toast = <StatusToast status={status} />;

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload
              onFilesSelected={(files) => {
                const next = toPdfFile(files);
                if (!next) {
                  setStatus({ ...idleStatus(), error: t("pdf-advanced-tools.choose.a.pdf.file.c2a7df") });
                  return;
                }
                setStatus(idleStatus());
                setPreviewIndex(0);
                setFile(next);
              }}
              accept=".pdf,application/pdf"
              label={t("pdf-advanced-tools.choose.a.pdf.to.crop.35fb47")} error={status.error} />
          </div>
        )}
        toast={toast}
      />
    );
  }

  const edgeLabel = (edge: CropEdge) => t(CROP_EDGE_KEYS[edge]);
  const ofPage = t("pdf-advanced-tools.of.page.42a4a1");
  const valueText = (value: number) => `${formatNumber(value)}${ofPage}`;
  const allZero = Object.values(margins).every((value) => value === 0);

  // Today's four fields; "% of page" is the unit inside each field (T-14), not a line under it.
  const field = (edge: CropEdge) => (
    <label key={edge} className="tk-field">
      <span>{edgeLabel(edge)}</span>
      <span className="tk-unitfield" style={{ '--unit-len': ofPage.length } as React.CSSProperties}>
        <input
          type="number"
          min={0}
          max={40}
          value={margins[edge]}
          onChange={(event) => { dropLeadingZeros(event.currentTarget); setMargin(edge, event.target.value); }}
          disabled={status.isProcessing}
          inputMode="decimal"
          className="chef-field tk-num disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="tk-unitfield-unit">{ofPage}</span>
      </span>
    </label>
  );

  const edgeStepper = (edge: CropEdge) => (
    <Stepper
      label={edgeLabel(edge)}
      field={field(edge)}
      onStep={(delta) => changeMargins({ ...margins, [edge]: margins[edge] + delta })}
      disabled={status.isProcessing}
      decreaseDisabled={margins[edge] <= 0}
      increaseDisabled={margins[edge] >= 40}
    />
  );

  const same = margins.top === margins.right && margins.top === margins.bottom && margins.top === margins.left;
  const allLabel = t('crop.edge.all');
  const allEditor = (
    <>
      <Stepper
        label={allLabel}
        field={(
          <label className="tk-field">
            <FieldLabel>{allLabel}</FieldLabel>
            <input
              type="number"
              min={0}
              max={40}
              value={same ? margins.top : ''}
              onChange={(event) => {
                dropLeadingZeros(event.currentTarget);
                const value = clampMargin(Number(event.target.value) || 0);
                changeMargins({ top: value, right: value, bottom: value, left: value });
              }}
              disabled={status.isProcessing}
              inputMode="decimal"
              className="chef-field tk-num disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
        )}
        onStep={(delta) => {
          const base = same ? margins.top : Math.max(margins.top, margins.right, margins.bottom, margins.left);
          const value = clampMargin(base + delta);
          changeMargins({ top: value, right: value, bottom: value, left: value });
        }}
        disabled={status.isProcessing}
        decreaseDisabled={same && margins.top <= 0}
        increaseDisabled={same && margins.top >= 40}
      />
      {/* On desktop the four fields are on the screen under the sentence (A-007). */}
      {!wide && <div className="tk-crop-fields">{CROP_EDGES.map((edge) => field(edge))}</div>}
    </>
  );
  const cropFields = wide ? (
    <div ref={cropFieldsRef} className="tk-crop-fields tk-crop-inline">{CROP_EDGES.map((edge) => field(edge))}</div>
  ) : undefined;
  const focusEdge = (edge: CropEdge) => () => cropFieldsRef.current?.querySelectorAll<HTMLElement>('input')[CROP_EDGES.indexOf(edge)] ?? null;

  const liveForm = cropForm(margins);
  // The sentence keeps its form while any of its editors is open, and changes when the last one
  // closes: with the other edges at 5, typing "50" into Top must not close the editor at "5"
  // (round 6, found while checking mobile-07).
  const form = openEditor && heldForm ? heldForm : liveForm;
  const onEditorChange = (name: string | null) => {
    setOpenEditor(name);
    setHeldForm((held) => (name ? held ?? cropForm(margins) : null));
  };
  // One decimal, as the fields and the frame allow (M-32): 2.5 % reads "2.5%", not "3%".
  const percentOf = (value: number) => formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 1 });
  const allText = form === 'none'
    ? (allZero ? t('sentence.crop.nothing') : pair(pair(percentOf(margins.top), percentOf(margins.right)), pair(percentOf(margins.bottom), percentOf(margins.left))))
    : same ? percentOf(margins.top)
      : pair(pair(percentOf(margins.top), percentOf(margins.right)), pair(percentOf(margins.bottom), percentOf(margins.left)));
  const allSlot = {
    label: allLabel,
    text: allText,
    icon: <Crop size={15} strokeWidth={2} />,
    tone: (form === 'none' && allZero) || !same ? 'pending' as const : undefined,
    bidi: same ? undefined : 'ltr' as const,
    editorTitle: allLabel,
    editor: <EnterCloses>{allEditor}</EnterCloses>,
    quiet: true,
  };
  const sentence = (
    <Sentence
      template={form === 'each' ? 'sentence.crop.each' : form === 'same' ? 'sentence.crop.same' : 'sentence.crop.none'}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      onEditorChange={onEditorChange}
      slots={form === 'each' ? Object.fromEntries(CROP_EDGES.map((edge) => [edge, {
        label: edgeLabel(edge),
        text: percentOf(margins[edge]),
        icon: CROP_EDGE_ICONS[edge],
        editorTitle: edgeLabel(edge),
        ...(wide ? { focusTarget: focusEdge(edge) } : { editor: <EnterCloses>{edgeStepper(edge)}</EnterCloses> }),
        quiet: true,
      }])) : { all: allSlot }}
    />
  );

  const noticeId = `crop-notice-${file.id}`;
  // The error first (inline, as an alert, A-014), then the all-zero line, then the
  // finished line when no result strip carries it.
  const notice = status.error
    ? cropStatusNotice
    : allZero
      ? <Notice tone="pending" id={noticeId}>{t("pdf-advanced-tools.increase.at.least.one.margin.559863")}</Notice>
      : cropStatusNotice;

  const runLabel = (
    <>
      <Download aria-hidden size={18} />
      <span>{t("pdf-advanced-tools.crop.pdf.dc4bdb")}</span>
    </>
  );

  const progress = status.isProcessing ? (
    <ProgressLine
      label={status.message || t("pdf-advanced-tools.processing.on.this.device.83aab2")}
      percent={formatPercent(Math.max(0, Math.min(100, status.progress)))}
      value={status.progress}
    />
  ) : undefined;

  const total = Math.max(1, pageCount);
  const body = (
    <PreviewFrame
      className="tk-crop"
      tools={previewFailed ? undefined : <ExpandButton ref={largeCropOpener} onClick={() => setLargeCrop(true)} disabled={!preview} />}
      // The pager row carries the expand button at its end, as Watermark's pill row does, so the
      // page keeps the row the button had on its own (fable-2 item 12).
      foot={previewFailed ? undefined : <PagePager index={previewIndex} total={total} onChange={setPreviewIndex} />}
    >
      {previewFailed ? (
        <p role="status" className="tk-crop-state">{t('crop.preview.failed')}</p>
      ) : preview ? (
        <div ref={cropPinchRef} className="tk-pinchbox">
        <CropFrame
          src={preview.url}
          pageWidth={preview.width}
          pageHeight={preview.height}
          margins={margins}
          onChange={changeMargins}
          labels={{ top: edgeLabel('top'), right: edgeLabel('right'), bottom: edgeLabel('bottom'), left: edgeLabel('left') }}
          valueText={valueText}
          alt={t('file-preview.alt', { name: file.name })}
          disabled={status.isProcessing}
        />
        </div>
      ) : (
        <p role="status" className="tk-crop-state">{t('file-preview.loading')}</p>
      )}
      {largeCrop && preview && (
        <LargePagePreview width={preview.width} height={preview.height} opener={largeCropOpener} onClose={() => setLargeCrop(false)}>
          <div className="tk-largecrop">
            <CropFrame
              src={preview.url}
              pageWidth={preview.width}
              pageHeight={preview.height}
              margins={margins}
              onChange={changeMargins}
              labels={{ top: edgeLabel('top'), right: edgeLabel('right'), bottom: edgeLabel('bottom'), left: edgeLabel('left') }}
              valueText={valueText}
              alt={t('file-preview.alt', { name: file.name })}
              disabled={status.isProcessing}
              underlay={<SharpPageLayer source={{ file: file.file }} pageIndex={Math.max(0, Math.min(pageCount - 1, previewIndex))} />}
            />
          </div>
        </LargePagePreview>
      )}
    </PreviewFrame>
  );

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: <>{pageCount > 0 && <>{t('format.pageCount', { count: pageCount })} · </>}{formatBytes(file.size)}</> }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={reset} disabled={status.isProcessing} />}
      kind="preview"
      bodyLabel={title}
      body={body}
      sentence={sentence}
      chips={cropFields}
      notice={notice}
      onRun={() => void handleCrop()}
      runDisabled={status.isProcessing || allZero}
      runDescribedBy={allZero ? noticeId : undefined}
      runLabel={runLabel}
      progress={progress}
      toast={toast}
    />
  );
};

/**
 * Header & Footer's live preview (T-13): one page as it will print, with the header and
 * footer drawn where the PDF gets them (same lines, size and baselines as `addHeaderFooterToPDF`).
 */
const HeaderFooterPreview: React.FC<{ file: File; name: string; options: HeaderFooterOptions; onPages: (count: number) => void }> = ({ file, name, options, onPages }) => {
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState<{ url: string; width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [large, setLarge] = useState(false);
  const largeOpener = useRef<HTMLButtonElement>(null);
  const pinchRef = usePinchToOpen(() => setLarge(true));
  const pagesRef = useRef(onPages);
  pagesRef.current = onPages;

  useEffect(() => { setIndex(0); }, [file]);
  useEffect(() => {
    let active = true;
    let created: string | null = null;
    setFailed(false);
    (async () => {
      try {
        const pdf = await loadPDFDocument(file);
        const count = Math.max(1, pdf.numPages || 1);
        if (active) { setTotal(count); pagesRef.current(count); }
        const scale = Math.min(2, Math.max(1.25, window.devicePixelRatio || 1));
        const rendered = await renderPageAsImage(pdf, Math.min(count - 1, index), { format: 'image/jpeg', quality: 0.9, scale });
        if (!active) { URL.revokeObjectURL(rendered.objectUrl); return; }
        created = rendered.objectUrl;
        setPage({ url: rendered.objectUrl, width: rendered.width / scale, height: rendered.height / scale });
      } catch {
        if (active) { setPage(null); setFailed(true); }
      }
    })();
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [file, index]);

  if (failed) return <FilePreview file={file} name={name} />;
  const size = headerFooterFontSize(options.fontSize);
  const lines = headerFooterLines(options, index + 1, Math.max(1, total));
  const line = (text: string, y: number) => (
    <text x={(page?.width ?? 0) / 2} y={y} textAnchor="middle" fontFamily="Helvetica, Arial, sans-serif" fontSize={size} fill="#404040">{text}</text>
  );
  const pageWithLines = page && (
    <>
      <img src={page.url} alt={t('file-preview.alt', { name })} className="absolute inset-0 h-full w-full" draggable={false} />
      {/* In the large preview only: the part in sight at full detail, under the header and footer. */}
      <SharpPageLayer source={{ file }} pageIndex={Math.max(0, Math.min(total - 1, index))} />
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${page.width} ${page.height}`} aria-hidden>
        {lines.header && line(lines.header, size + 18)}
        {lines.footer && line(lines.footer, page.height - 18)}
      </svg>
    </>
  );
  return (
    <PreviewFrame
      // The expand button sits at the end of the pager row, as on Watermark (fable-2 item 12).
      foot={<PagePager index={index} total={total} onChange={setIndex} />}
      tools={<ExpandButton ref={largeOpener} onClick={() => setLarge(true)} disabled={!page} />}
    >
      {page ? (
        <div ref={pinchRef} className="tk-pinchbox">
          <FitStage width={page.width} height={page.height}>
            {pageWithLines}
          </FitStage>
        </div>
      ) : (
        <p role="status" className="tk-crop-state">{t('file-preview.loading')}</p>
      )}
      {large && page && (
        <LargePagePreview width={page.width} height={page.height} opener={largeOpener} onClose={() => setLarge(false)}>
          {pageWithLines}
        </LargePagePreview>
      )}
    </PreviewFrame>
  );
};

export const HeaderFooterPDF: React.FC = () => {
  useI18n();
  const wide = useWide();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [headerText, setHeaderText] = useRemembered<string>('header', '');
  const [footerText, setFooterText] = useRemembered<string>('footer', 'Page {n} of {total}');
  const [fontSize, setFontSize] = useRemembered<number>('size', 10, (value) => value >= 8 && value <= 48);
  const [includePageNumbers, setIncludePageNumbers] = useRemembered<boolean>('pageNumbers', true);
  const [pageTotal, setPageTotal] = useState(0);
  const hfSettingsRef = useRef<HTMLDivElement>(null);
  const hasContent = Boolean(headerText.trim() || footerText.trim() || includePageNumbers);
  const hfStatusNotice = useStatusNotice(status);
  // The saved lines use Helvetica, as Watermark and Page Numbers do: a character it cannot print
  // keeps Add off and is named, instead of a save that fails with a general message (s3-06).
  const [previewFont, setPreviewFont] = useState<PDFFont | null>(null);
  useEffect(() => {
    let live = true;
    getPdfPreviewFont().then((font) => { if (live) setPreviewFont(font); }, () => undefined);
    return () => { live = false; };
  }, []);

  const clearTerminalStatus = () => {
    if (!status.isProcessing && (status.error || status.progress === 100)) setStatus(idleStatus());
  };

  const handleApply = async () => {
    if (!file) return;
    if (!hasContent) {
      setStatus({ ...idleStatus(), error: t("pdf-advanced-tools.add.header.text.footer.text.or.page.0b0900") });
      return;
    }
    setStatus({ isProcessing: true, progress: 20, message: t("pdf-advanced-tools.adding.header.and.footer.c9c262") });
    try {
      const bytes = await addHeaderFooterToPDF(file.file, { headerText, footerText, fontSize, includePageNumbers });
      const outputName = toolOutputName('header-footer', file.name, 'pdf');
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), outputName);
      setStatus({ isProcessing: false, progress: 100, message: t("pdf-advanced-tools.created.21ab7c", { v0: outputName }) });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: pdfProblemMessage(error) ?? t("pdf-advanced-tools.the.header.and.footer.could.not.be.90a336") });
    }
  };

  const title = t("pdf-advanced-tools.header.footer.aaf783");
  const toast = <StatusToast status={status} />;
  const reset = () => {
    setFile(null);
    setPageTotal(0);
    setStatus(idleStatus());
  };

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload
              onFilesSelected={(files) => {
                const next = toPdfFile(files);
                if (!next) {
                  setStatus({ ...idleStatus(), error: t("pdf-advanced-tools.choose.a.pdf.file.c2a7df") });
                  return;
                }
                setStatus(idleStatus());
                setFile(next);
              }}
              accept=".pdf,application/pdf"
              label={t("pdf-advanced-tools.choose.a.pdf.for.header.and.footer.a944a3")} error={status.error} />
          </div>
        )}
        toast={toast}
      />
    );
  }

  // The desktop length on phones too. The sentence takes its rows form when it needs a third line.
  const clipTo = clipLength(true);
  // The slots show page 1 as it will print ("Page 1 of 3"), once the page count is known (T-13).
  const options: HeaderFooterOptions = { headerText, footerText, fontSize, includePageNumbers };
  const printed = pageTotal ? headerFooterLines(options, 1, pageTotal) : { header: headerText.trim(), footer: footerText.trim() };
  const headerLabel = t("pdf-advanced-tools.header.text.a16987");
  const footerLabel = t("pdf-advanced-tools.footer.text.0b0272");
  const sizeLabel = t("pdf-advanced-tools.font.size.6d784d");
  // The values carry their own noun (pass 5, item 6), and the sentence leads with what is added
  // (review 2, item 6): "Add the footer “Page 1 of 3” in 10 pt, with no header.", not "Add no
  // header and …". With neither, the sentence asks for one.
  const hasHeader = Boolean(headerText.trim());
  const hasFooter = Boolean(footerText.trim());
  const hasFooterLine = hasFooter || includePageNumbers;
  const headerValue = hasHeader ? quoted(printed.header, clipTo)
    : hasFooterLine ? t('sentence.headerFooter.header.none') : t('sentence.headerFooter.header.unset');
  const footerValue = hasFooter
    ? quoted(printed.footer, clipTo)
    : includePageNumbers ? t('sentence.headerFooter.footer.numbers')
      : hasHeader ? t('sentence.headerFooter.footer.none') : t('sentence.headerFooter.footer.unset');
  const headerFooterTemplate: TranslationKey = !hasHeader && !hasFooterLine ? 'sentence.headerFooter.neither'
    : hasHeader && hasFooter ? 'sentence.headerFooter'
      : hasHeader ? 'sentence.headerFooter.addHeader'
        : hasFooter ? 'sentence.headerFooter.addFooter' : 'sentence.headerFooter.addNumbers';
  const noticeId = `header-footer-notice-${file.id}`;
  const unsupportedCharacter = unsupportedPdfPreviewCharacter(previewFont, `${printed.header}${printed.footer}`);
  const fontMessage = unsupportedCharacter ? t("business-document.error.b7890f176a", {
    v0: unsupportedCharacter,
    v1: unsupportedCharacter.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'),
  }) : null;

  const sizeField = (
    <label className="tk-field">
      <span className="sr-only">{sizeLabel}</span>
      {/* Clamped when the box is left, not per key: "12" no longer passes through 8 and 48 (round 5, mobile-03). */}
      <ClampedNumberInput
        min={8}
        max={48}
        value={fontSize}
        onCommit={(next) => {
          clearTerminalStatus();
          setFontSize(next);
        }}
        disabled={status.isProcessing}
        inputMode="numeric"
        className="chef-field tk-num disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  );

  // The editors' controls: in each slot's editor on phones, beside the page on desktop
  // (owner decision 1, B-017), so each change is one step. Same nodes, names and handlers.
  const visibleLabel = wide ? undefined : 'sr-only';
  const headerEditor = (
    <label className="tk-field">
      <span className={visibleLabel}>{headerLabel}</span>
      <input
        value={headerText}
        onChange={(event) => {
          clearTerminalStatus();
          setHeaderText(event.target.value);
        }}
        placeholder={t("pdf-advanced-tools.optional.header.8bc58e")}
        disabled={status.isProcessing}
        className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  );
  // Page Numbers' formats as taps, shown as page 1 prints them ("Page 1 of 3"), so nobody has to
  // learn {n} and {total} to number the footer (pass 5, item 5). The field keeps any other text.
  const footerNow = footerText.trim() || (includePageNumbers ? 'Page {n} of {total}' : '');
  const footerPresets = (
    <TapChoices
      label={footerLabel}
      values={PAGE_NUMBER_FORMAT_PRESETS}
      current={PAGE_NUMBER_FORMAT_PRESETS[2]}
      isCurrent={(preset) => preset === footerNow}
      text={(preset) => interpolateHeaderFooterText(preset, 1, Math.max(1, pageTotal))}
      onPick={(preset) => {
        clearTerminalStatus();
        setFooterText(preset);
      }}
      disabled={status.isProcessing}
      columns={wide ? 2 : undefined}
      dense={!wide}
    />
  );
  // On a phone the taps lead the card, as in Page Numbers; beside the page on desktop the field's
  // visible label heads the setting and the taps follow it.
  const footerEditor = (
    <div className="tk-fieldcol">
      {!wide && footerPresets}
      <label className="tk-field">
        <span className={visibleLabel}>{footerLabel}</span>
        <input
          value={footerText}
          onChange={(event) => {
            clearTerminalStatus();
            setFooterText(event.target.value);
          }}
          placeholder={t("pdf-advanced-tools.page.of.373437", { pageToken: "{n}", totalToken: "{total}" })}
          disabled={status.isProcessing}
          className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>
      {wide && footerPresets}
    </div>
  );
  // Its own choice, on the screen at every width (B-017 (1)): not part of the footer text.
  const numbersCheck = (
    <label className="tk-check">
      <input
        type="checkbox"
        checked={includePageNumbers}
        onChange={(event) => {
          clearTerminalStatus();
          setIncludePageNumbers(event.target.checked);
        }}
        disabled={status.isProcessing}
        className="h-5 w-5 disabled:cursor-not-allowed disabled:opacity-60"
      />{t("pdf-advanced-tools.use.page.numbers.if.footer.is.blank.b67db0")}</label>
  );
  const sizeStepper = (
    <Stepper
      label={sizeLabel}
      field={sizeField}
      onStep={(delta) => {
        if (status.isProcessing) return;
        clearTerminalStatus();
        setFontSize((current) => Math.max(8, Math.min(48, current + delta)));
      }}
      disabled={status.isProcessing}
      decreaseDisabled={fontSize <= 8}
      increaseDisabled={fontSize >= 48}
    />
  );
  // Phones: the size's editor also offers the common sizes as taps (path to 9, item 1).
  const sizeEditor = wide ? sizeStepper : (
    <>
      {sizeStepper}
      <TapChoices
        label={sizeLabel}
        values={[10, 12, 14, 18]}
        current={fontSize}
        text={(value) => points(value)}
        onPick={(value) => { clearTerminalStatus(); setFontSize(value); }}
        disabled={status.isProcessing}
      />
    </>
  );
  const settingSlot = (name: string, editor: React.ReactNode) => (wide
    ? { focusTarget: () => hfSettingsRef.current?.querySelector<HTMLElement>(`[data-setting="${name}"] input`) ?? null }
    // A live-preview tool: the editor leaves the preview undimmed and the next slot tappable.
    : { editor: <EnterCloses>{editor}</EnterCloses>, quiet: true });

  const pendingTone = hasContent ? undefined : 'pending' as const;
  const sentence = (
    <Sentence
      template={headerFooterTemplate}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      slots={{
        header: {
          label: headerLabel,
          text: headerValue,
          tone: pendingTone,
          ...settingSlot('header', headerEditor),
        },
        footer: {
          label: footerLabel,
          text: footerValue,
          tone: pendingTone,
          ...settingSlot('footer', footerEditor),
        },
        size: {
          label: sizeLabel,
          text: points(fontSize),
          icon: <Type size={15} strokeWidth={2} />,
          ...settingSlot('size', sizeEditor),
        },
      }}
    />
  );
  const hfSettings = wide ? (
    <div ref={hfSettingsRef} className="tk-side-settings">
      <div data-setting="header" className="tk-side-setting">{headerEditor}</div>
      <div data-setting="footer" className="tk-side-setting">{footerEditor}{numbersCheck}</div>
      <div data-setting="size" className="tk-side-setting"><span className="tk-side-label">{sizeLabel}</span>{sizeEditor}</div>
    </div>
  ) : undefined;

  const notice = status.error
    ? hfStatusNotice
    : fontMessage ? <Notice tone="error" id={noticeId} role="alert">{fontMessage}</Notice>
    : hasContent ? hfStatusNotice : (
      <Notice tone="pending" id={noticeId}>{t("pdf-advanced-tools.add.header.text.footer.text.or.page.0b0900")}</Notice>
    );

  const runLabel = (
    <>
      <FileCheck aria-hidden size={18} />
      <span>{t("pdf-advanced-tools.add.header.footer.532ade")}</span>
    </>
  );

  const progress = status.isProcessing ? (
    <ProgressLine
      label={status.message || t("pdf-advanced-tools.processing.on.this.device.83aab2")}
      percent={formatPercent(Math.max(0, Math.min(100, status.progress)))}
      value={status.progress}
    />
  ) : undefined;

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: formatBytes(file.size) }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={reset} disabled={status.isProcessing} />}
      kind="preview"
      bodyLabel={title}
      body={<HeaderFooterPreview file={file.file} name={file.name} options={options} onPages={setPageTotal} />}
      side={hfSettings}
      sentence={sentence}
      chips={wide ? undefined : numbersCheck}
      notice={notice}
      onRun={() => void handleApply()}
      runDisabled={!hasContent || Boolean(fontMessage) || status.isProcessing}
      runDescribedBy={hasContent && !fontMessage ? undefined : noticeId}
      runLabel={runLabel}
      progress={progress}
      toast={toast}
    />
  );
};

/** The same pages, in any order. */
const sameIndexes = (left: number[], right: number[]) =>
  left.length === right.length && left.every((index) => right.includes(index));

export const RemoveBlankPagesPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  // Two fingers on a page, or its eye, open it large (pass 5).
  const preview = usePagePreview(file?.file, file?.name);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [previews, setPreviews] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // The pages found blank (0-based), then what the person keeps or drops on the grid (path to 9, part 2).
  const [scan, setScan] = useState<{ current: number; total: number } | null>(null);
  const [found, setFound] = useState<number[] | null>(null);
  const [marked, setMarked] = useState<number[]>([]);
  const [caution, setCaution] = useState('');
  const [removedPages, setRemovedPages] = useState<number[]>([]);

  useEffect(() => {
    if (!file) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    getPdfPagePreviews(file.file, { scale: PREVIEW_SCALES[0], signal: controller.signal })
      .then((urls) => {
        if (cancelled) { revokeObjectUrls(urls); return; }
        setPreviews(urls);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(error);
        setPreviewError(pdfFailureMessage(error, t("pdf-advanced-tools.the.blank.pages.could.not.be.removed.e20ac8")));
      });
    findBlankPages(file.file, {
      signal: controller.signal,
      onProgress: (current, total) => { if (!cancelled) setScan({ current, total }); },
    })
      .then((pages) => {
        if (cancelled) return;
        const indices = pages.map((page) => page - 1);
        setFound(indices);
        setMarked(indices);
        setScan(null);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(error);
        setScan(null);
        setPreviewError(pdfFailureMessage(error, t("pdf-advanced-tools.the.blank.pages.could.not.be.removed.e20ac8")));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file]);

  useEffect(() => () => revokeObjectUrls(previews), [previews]);
  const onGridFit = useSharpPreviews(file?.file ?? null, previews, setPreviews, previews.length > 0 && !previewError);

  const reset = () => {
    setFile(null);
    setPreviews([]);
    setPreviewError(null);
    setScan(null);
    setFound(null);
    setMarked([]);
    setCaution('');
    setRemovedPages([]);
    setStatus(idleStatus());
  };

  const choose = (files: File[]) => {
    const next = toPdfFile(files);
    if (!next) {
      setStatus({ ...idleStatus(), error: t('pdf-advanced-tools.choose.a.pdf.file.c2a7df') });
      return;
    }
    reset();
    setFile(next);
  };

  const totalPages = previews.length;
  const toggle = (index: number) => {
    setCaution('');
    setMarked((current) => {
      if (current.includes(index)) return current.filter((item) => item !== index);
      if (totalPages > 0 && current.length >= totalPages - 1) {
        setCaution(t('delete-pages.at.least.one.page.must.remain.in.ba102e'));
        return current;
      }
      return [...current, index].sort((left, right) => left - right);
    });
  };

  const handleRemove = async () => {
    if (!file || marked.length === 0) return;
    setRemovedPages([]);
    setStatus({ isProcessing: true, progress: 40, message: t('pdf-advanced-tools.processing.pdf.3087fc') });
    try {
      const result = await removeBlankPagesFromPDF(file.file, { pages: marked.map((index) => index + 1) });
      setRemovedPages(result.removedPages);
      const outputName = toolOutputName('remove-blank-pages', file.name, 'pdf');
      downloadBlob(new Blob([result.bytes], { type: 'application/pdf' }), outputName);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: t('pdf-advanced-tools.removed.blank.page.created.ffb782', { v2: outputName, count: result.removedPages.length }),
      });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: pdfFailureMessage(error, t("pdf-advanced-tools.the.blank.pages.could.not.be.removed.e20ac8")) });
    }
  };

  const title = t('pdf-advanced-tools.remove.blank.pages.f85882');
  const statusNotice = useStatusNotice(status);
  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={choose} accept=".pdf,application/pdf" label={t('pdf-advanced-tools.choose.a.pdf.to.remove.blank.pages.56a840')} error={status.error} />
          </div>
        )}
      />
    );
  }

  const scanning = found === null && !previewError;
  const allMarked = totalPages > 0 && marked.length >= totalPages;
  const markedPages = marked.map((index) => index + 1);
  // One line, the first that applies: an error, the run's outcome, the scan, then what Save will drop.
  const notice = status.error || previewError
    ? <Notice tone="error" role="alert">{status.error || previewError}</Notice>
    : removedPages.length > 0 && !status.isProcessing
      ? <Notice tone="caution" role="status">{t('pdf-advanced-tools.message.42c8b18305', { v0: numberList(removedPages) })}</Notice>
      : scanning
        ? <Notice tone="pending" role="status">{scan ? t('pdf-advanced-tools.scanning.page.of.0f093b', { v0: scan.current, v1: scan.total }) : t('pdf-advanced-tools.scanning.pages.0ef4d2')}</Notice>
        : caution
          ? <Notice tone="caution" role="status">{caution}</Notice>
          : found && found.length > 0 && found.length >= totalPages && allMarked
            ? <Notice tone="caution" role="status">{t('pdf-document.all.pages.look.blank.no.output.was.7f5ae1')}</Notice>
            // Some found pages restored (or others added): say both counts, so the line never claims none were found (h4).
            : found && found.length > 0 && !sameIndexes(found, marked)
              ? <Notice role="status">{t('blankPages.foundSome', { count: found.length, v0: marked.length })}</Notice>
              : marked.length > 0
                ? <Notice role="status">{t('blankPages.marked', { v0: numberList(markedPages), count: marked.length })}</Notice>
                : <Notice role="status">{t('blankPages.none')}</Notice>;

  const body = (
    <>
      {preview.modal}
      <h2 id="blank-pages-heading" className="sr-only">{title}</h2>
      {previews.length === 0 && !previewError ? (
        <p role="status" className="tk-grid-state">{t('pdf-advanced-tools.scanning.pages.0ef4d2')}</p>
      ) : previewError ? (
        <div className="tk-grid-state tk-grid-error">
          <p className="font-semibold"><ErrorText text={previewError} file={file.file} /></p>
        </div>
      ) : (
        <PageGrid count={previews.length} onFit={onGridFit} gestureRef={preview.pinchRef}>
          {previews.map((url, index) => {
            const isMarked = marked.includes(index);
            return (
              <div key={index} className="tk-peekbox" data-peek-page={index}>
              <button
                type="button"
                onClick={() => toggle(index)}
                disabled={status.isProcessing || scanning}
                aria-pressed={isMarked}
                aria-label={t('delete-pages.page.893387', { v0: isMarked ? t('delete-pages.restore.a76e13') : t('delete-pages.mark.d7cda0'), v1: index + 1 })}
                data-marked={isMarked ? '' : undefined}
                className="tk-tile chef-pressable"
              >
                <span className="tk-tile-page">
                  <img src={url} alt={t('delete-pages.page.preview.7f7e5e', { v0: index + 1 })} loading="lazy" decoding="async" draggable={false} />
                  {isMarked && <span aria-hidden className="tk-tile-mark"><Trash2 size={22} /></span>}
                </span>
                <span className="tk-tile-label tabular">{t('delete-pages.message.c140ba4857', { v0: index + 1 })}</span>
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
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={reset} disabled={status.isProcessing} />}
      kind="grid"
      bodyLabelledBy="blank-pages-heading"
      body={body}
      sentence={<Sentence template="pdf-advanced-tools.nearly.empty.pages.count.as.blank.8e2727" groupLabel={t('sentence.groupLabel', { tool: title })} disabled={status.isProcessing} />}
      notice={status.error ? statusNotice : notice}
      onRun={() => void handleRemove()}
      runDisabled={status.isProcessing || scanning || marked.length === 0 || allMarked || Boolean(previewError)}
      runLabel={(
        <>
          <Trash2 aria-hidden size={18} />
          <span>{t('pdf-advanced-tools.remove.blank.pages.527c64')}</span>
        </>
      )}
      progress={status.isProcessing ? (
        <ProgressLine label={status.message} percent={formatPercent(status.progress)} value={status.progress} />
      ) : undefined}
    />
  );
};

export const ExtractImagesPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  useReleasePdfDocument(file?.file);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [images, setImages] = useState<EmbeddedPdfImageAsset[]>([]);
  // A finished scan that found nothing: the canvas says so, so a second scan visibly ran (review 2, item 19).
  const [foundNone, setFoundNone] = useState(false);
  const imageOperationIdRef = useRef<string | null>(null);
  const imageGrantRef = useRef<JobAccessGrant | null>(null);
  const { completeJob, runWithExportAccess } = useMonetization();

  useEffect(() => {
    return () => images.forEach((image) => URL.revokeObjectURL(image.objectUrl));
  }, [images]);

  const scanImages = async (selected: PDFFile) => {
    const operationId = uuidv4();
    imageOperationIdRef.current = operationId;
    imageGrantRef.current = null;
    setStatus({ isProcessing: true, progress: 10, message: t("pdf-advanced-tools.looking.for.pictures.inside.the.pdf.5e0e3e") });
    setFoundNone(false);
    try {
      // A document of its own (B-022): the shared one is also drawing the page preview, whose
      // cleanup drops page 1's decoded pictures while this scan still waits for them.
      const pdfDoc = await loadDisposablePDFDocument(selected.file);
      let extracted: EmbeddedPdfImageAsset[];
      try {
        extracted = await extractEmbeddedImagesFromPDF(pdfDoc, {
          onProgress: (current, total) => {
            setStatus({ isProcessing: true, progress: Math.round((current / total) * 90), message: t("pdf-advanced-tools.scanning.page.of.0f093b", { v0: current, v1: total }) });
          },
        });
      } finally {
        await pdfDoc.destroy();
      }
      setImages(extracted);
      const grant = await completeJob(operationId).catch(() => 'preview-only' as const);
      if (imageOperationIdRef.current !== operationId) return;
      imageGrantRef.current = grant;
      setFoundNone(extracted.length === 0);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: extracted.length > 0
          ? joinSentences(t("pdf-advanced-tools.found.embedded.image.11b935", { count: extracted.length }), sharedPictureNote(extracted))
          : t("pdf-advanced-tools.this.pdf.has.no.pictures.stored.in.fa5b86"),
      });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: pdfProblemMessage(error) ?? t("pdf-advanced-tools.the.pictures.could.not.be.saved.try.7b1ada") });
    }
  };

  const handleFilesSelected = (files: File[]) => {
    const next = toPdfFile(files);
    if (!next) {
      setStatus({ ...idleStatus(), error: t("pdf-advanced-tools.choose.a.pdf.file.c2a7df") });
      return;
    }
    images.forEach((image) => URL.revokeObjectURL(image.objectUrl));
    setImages([]);
    setFoundNone(false);
    imageOperationIdRef.current = null;
    imageGrantRef.current = null;
    setFile(next);
    setStatus(idleStatus());
    void scanImages(next);
  };

  const downloadAll = async () => {
    if (!file || images.length === 0) return;
    const operationId = imageOperationIdRef.current;
    if (!operationId) return;
    setStatus({ isProcessing: true, progress: 90, message: t("pdf-advanced-tools.packing.images.e1a3a2") });
    try {
      const zip = new (await loadJSZip())();
      images.forEach((image, index) => {
        zip.file(`image-${String(index + 1).padStart(2, '0')}-pages-${image.pageNumbers.join('-')}.png`, image.blob);
      });
      const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        setStatus({
          isProcessing: true,
          progress: 90 + Math.round(metadata.percent / 10),
          message: t("pdf-advanced-tools.packing.images.e1a3a2"),
        });
      });
      const outputName = toolOutputName('images', file.name, 'zip');
      const download = async () => {
        downloadBlob(blob, outputName, 'application/zip', { operationId });
      };
      if (imageGrantRef.current === 'preview-only') {
        try {
          const access = await runWithExportAccess(download);
          if (access.status === 'blocked') {
            setStatus({ isProcessing: false, progress: 100, message: t("pdf-advanced-tools.image.preview.ready.unlock.to.download.all.d120b3") });
            return;
          }
        } catch {
          setStatus({ isProcessing: false, progress: 100, message: t("pdf-advanced-tools.image.preview.ready.unlock.to.download.all.d120b3") });
          return;
        }
      } else {
        await download();
      }
      setStatus({
        isProcessing: false,
        progress: 100,
        message: joinSentences(t("pdf-advanced-tools.created.with.image.a61a29", { v0: outputName, count: images.length }), sharedPictureNote(images)),
      });
    } catch (error) {
      console.error(error);
      setStatus({ ...idleStatus(), error: t("pdf-advanced-tools.the.pictures.could.not.be.put.into.d67287") });
    }
  };

  return (
    <FileToolScreen
      title={t("pdf-advanced-tools.extract.images.6a8eaf")}
      statement="pdf-advanced-tools.embedded.images.are.exported.as.png.f1bce4"
      uploadLabel={t("pdf-advanced-tools.choose.a.pdf.to.extract.images.7201bd")}
      file={file}
      status={status}
      onFilesSelected={handleFilesSelected}
      onReset={() => {
        images.forEach((image) => URL.revokeObjectURL(image.objectUrl));
        setImages([]);
        setFoundNone(false);
        setFile(null);
        imageOperationIdRef.current = null;
        imageGrantRef.current = null;
        setStatus(idleStatus());
      }}
      actionLabel={images.length > 0 ? t("pdf-advanced-tools.download.all.images.c7daa4") : t("pdf-advanced-tools.scan.images.fc2418")}
      onAction={images.length > 0 ? downloadAll : () => file && scanImages(file)}
      outcome={images.length > 9 ? (
        <Notice>{t("pdf-advanced-tools.message.6e168770e3", { v0: images.length })}</Notice>
      ) : undefined}
      body={images.length > 0 ? (
        <div className="tk-pics">
          <p className="tk-cap">
            <Archive aria-hidden size={16} className="me-1.5 inline align-[-2px]" />{t("pdf-advanced-tools.message.ba0aedff09", { count: images.length })}
          </p>
          <PageGrid count={Math.min(images.length, 9)} aspect={0.75}>
            {images.slice(0, 9).map((image, index) => (
              <button
                key={image.id}
                type="button"
                onClick={() => {
                  const operationId = imageOperationIdRef.current;
                  if (!operationId) return;
                  const download = async () => {
                    downloadBlob(image.blob, `image-${index + 1}.png`, 'image/png', { operationId });
                  };
                  if (imageGrantRef.current !== 'preview-only') {
                    void download();
                    return;
                  }
                  void runWithExportAccess(download).then((access) => {
                    if (access.status === 'blocked') {
                      setStatus({ isProcessing: false, progress: 100, message: t("pdf-advanced-tools.image.preview.ready.unlock.to.download.this.ff4fa3") });
                    }
                  }).catch(() => {
                    setStatus({ isProcessing: false, progress: 100, message: t("pdf-advanced-tools.image.preview.ready.unlock.to.download.this.ff4fa3") });
                  });
                }}
                className="tk-tile tk-tile-pic chef-pressable"
              >
                <span className="tk-tile-page">
                  <img src={image.objectUrl} alt={t("pdf-advanced-tools.extracted.image.a40163", { v0: index + 1 })} draggable={false} />
                </span>
                <span className="tk-tile-label">{t("pdf-advanced-tools.message.1fac9292db", { v0: image.pageNumbers.join(', ') })}</span>
              </button>
            ))}
          </PageGrid>
        </div>
      ) : foundNone && file ? (
        <div className="tk-pics tk-pics-none">
          <p className="tk-cap">
            <Archive aria-hidden size={16} className="me-1.5 inline align-[-2px]" />{t('pdf-advanced-tools.noImagesFound')}
          </p>
          <FilePreview file={file.file} name={file.name} meta={formatBytes(file.size)} />
        </div>
      ) : undefined}
    />
  );
};
