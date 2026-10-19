import { t, formatPercent } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import JSZip from 'jszip';
import { v4 as uuidv4 } from 'uuid';
import { Archive, Download, FileCheck, Loader2 } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import {
  addHeaderFooterToPDF,
  cropPDFMargins,
  removeBlankPagesFromPDF,
  removePDFAnnotations,
  removePDFMetadata,
  sanitizePDF,
} from '../../services/pdfDocument';
import { extractEmbeddedImagesFromPDF, loadPDFDocument, type EmbeddedPdfImageAsset } from '../../services/pdfBrowser';
import { downloadBlob } from '../../services/pdfShared';
import { formatBytes, toolOutputName } from '../UI/format';
import { useMonetization, type JobAccessGrant } from '../../hooks/useMonetization';
import { useReleasePdfDocument } from '../../hooks/useReleasePdfDocument';

interface ToolShellProps {
  title: string;
  /**
   * Only when the title and the button leave something out that would cost the
   * user work: what a vague verb actually deletes, an output format, a
   * detection caveat. Five of these seven routes need nothing.
   */
  description?: string;
  uploadLabel: string;
  file: PDFFile | null;
  status: ProcessingStatus;
  onFilesSelected: (files: File[]) => void;
  onReset: () => void;
  actionLabel: string;
  onAction: () => void;
  actionDisabled?: boolean;
  actionHint?: string;
  children?: React.ReactNode;
  selectedContent?: React.ReactNode;
}

const ToolShell: React.FC<ToolShellProps> = ({
  title,
  description,
  uploadLabel,
  file,
  status,
  onFilesSelected,
  onReset,
  actionLabel,
  onAction,
  actionDisabled = false,
  actionHint,
  children,
  selectedContent,
}) => {
  useI18n();
  const progress = Math.max(0, Math.min(100, status.progress));

  return (
    <div className={`chef-tool-shell mx-auto max-w-4xl px-4 py-4 sm:py-10 ${file ? '' : 'chef-tool-landing-centered'}`}>
      {/* Title and intro start at the page's own leading edge, the same as
          every other tool screen. The icon tile that had stood beside them
          indented both, so these seven routes were the only ones whose heading
          did not line up with the content under it. */}
      <div className="mb-3 sm:mb-6">
        <h1 className="text-2xl font-bold text-[var(--text-primary)] sm:text-3xl">{title}</h1>
        {description && <p className="mt-1 max-w-measure text-sm text-[var(--text-secondary)]">{description}</p>}
      </div>

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div key="upload" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <FileUpload onFilesSelected={onFilesSelected} accept=".pdf,application/pdf" label={uploadLabel} />
            {status.error && (
              <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-semibold text-rose-700 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200">
                {status.error}
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="selected"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            aria-busy={status.isProcessing}
            className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4"
          >
            <div className="flex items-center gap-2 border-b border-[var(--border-hairline)] pb-2.5">
              <FileCheck aria-hidden size={18} className="shrink-0 text-[var(--accent-on-quiet)]" />
              <p className="chef-filename min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">
                {file.name}
                <span className="ml-1 font-normal text-[var(--text-tertiary)]">{formatBytes(file.size)}</span>
              </p>
              <button
                type="button"
                onClick={onReset}
                disabled={status.isProcessing}
                className="chef-target chef-pressable shrink-0 rounded-xl px-3 text-sm font-semibold text-[var(--accent-text)] hover:bg-[var(--accent-quiet)] disabled:cursor-not-allowed disabled:opacity-55"
              >{t("pdf-advanced-tools.change.c0bf75")}</button>
            </div>

            {children && <div className="mt-3">{children}</div>}
            {selectedContent}

            {status.isProcessing && (
              <div role="status" aria-live="polite" className="mt-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3 py-2.5">
                <div className="flex items-start justify-between gap-3 text-sm font-semibold text-[var(--text-body)]">
                  <span>{status.message || t("pdf-advanced-tools.processing.on.this.device.83aab2")}</span>
                  <span className="shrink-0 tabular-nums">{formatPercent(progress)}</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={t("pdf-advanced-tools.progress.459332", { v0: title })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-canvas)]"
                >
                  <div className="h-full rounded-full bg-[var(--accent-rest)] transition-[width]" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={onAction}
              disabled={status.isProcessing || actionDisabled}
              className="chef-target chef-pressable mt-3 flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 text-sm font-bold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <Download aria-hidden size={18} />}
              {status.isProcessing ? status.message || 'Processing...' : actionLabel}
            </button>

            {!status.isProcessing && actionDisabled && actionHint && (
              <p className="type-footnote mt-2 text-[var(--text-secondary)]">{actionHint}</p>
            )}

            {status.error && (
              <div role="alert" className="mt-4 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-semibold text-rose-700 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200">
                {status.error}
              </div>
            )}

            {!status.isProcessing && !status.error && status.progress === 100 && status.message && (
              <div role="status" aria-live="polite" className="mt-3 flex items-start gap-2 rounded-[var(--radius-field)] border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-800 dark:border-emerald-400 dark:bg-emerald-500/10 dark:text-emerald-200">
                <FileCheck aria-hidden className="mt-0.5 shrink-0" size={18} />
                <span>{status.message}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
  description?: string;
  uploadLabel: string;
  actionLabel: string;
  outputPrefix: string;
  transform: (file: File) => Promise<Uint8Array>;
}

const SimpleTransformTool: React.FC<SimpleTransformToolProps> = ({
  title,
  description,
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
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("pdf-advanced-tools.this.pdf.could.not.be.changed.if.82905a") });
    }
  };

  return (
    <ToolShell
      title={title}
      description={description}
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

export const RemoveMetadataPDF: React.FC = () => { useI18n(); return (
  <SimpleTransformTool
    title={t("pdf-advanced-tools.remove.hidden.info.fa4793")}
    description={t("pdf-advanced-tools.clears.the.author.the.dates.and.the.3fc978")}
    uploadLabel={t("pdf-advanced-tools.choose.a.pdf.to.clean.e0a661")}
    actionLabel={t("pdf-advanced-tools.remove.hidden.info.fa4793")}
    outputPrefix="remove-hidden-info"
    transform={removePDFMetadata}
  />
); };

export const RemoveAnnotationsPDF: React.FC = () => { useI18n(); return (
  <SimpleTransformTool
    title={t("pdf-advanced-tools.remove.comments.0788e6")}
    description={t("pdf-advanced-tools.removes.comments.notes.highlights.and.links.form.e7de67")}
    uploadLabel={t("pdf-advanced-tools.choose.a.pdf.to.clean.e0a661")}
    actionLabel={t("pdf-advanced-tools.remove.comments.0788e6")}
    outputPrefix="remove-comments"
    transform={removePDFAnnotations}
  />
); };

export const SanitizePDF: React.FC = () => { useI18n(); return (
  <SimpleTransformTool
    title={t("pdf-advanced-tools.clean.up.pdf.33d903")}
    description={t("pdf-advanced-tools.removes.hidden.info.and.comments.in.one.732679")}
    uploadLabel={t("pdf-advanced-tools.choose.a.pdf.to.clean.e0a661")}
    actionLabel={t("pdf-advanced-tools.clean.up.pdf.0b4aaa")}
    outputPrefix="clean"
    transform={sanitizePDF}
  />
); };

export const CropPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [margins, setMargins] = useState({ top: 5, right: 5, bottom: 5, left: 5 });

  const setMargin = (key: keyof typeof margins, value: string) => {
    if (!status.isProcessing && (status.error || status.progress === 100)) setStatus(idleStatus());
    setMargins((current) => ({ ...current, [key]: Math.max(0, Math.min(40, Number(value) || 0)) }));
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
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("pdf-advanced-tools.this.pdf.could.not.be.cropped.try.b13377") });
    }
  };

  return (
    <ToolShell
      title={t("pdf-advanced-tools.crop.pdf.dc4bdb")}
      description={t("pdf-advanced-tools.trims.the.white.space.around.the.edges.27ed25")}
      uploadLabel={t("pdf-advanced-tools.choose.a.pdf.to.crop.35fb47")}
      file={file}
      status={status}
      onFilesSelected={(files) => {
        const next = toPdfFile(files);
        if (!next) {
          setStatus({ ...idleStatus(), error: t("pdf-advanced-tools.choose.a.pdf.file.c2a7df") });
          return;
        }
        setStatus(idleStatus());
        setFile(next);
      }}
      onReset={() => {
        setFile(null);
        setStatus(idleStatus());
      }}
      actionLabel={t("pdf-advanced-tools.crop.pdf.dc4bdb")}
      onAction={handleCrop}
      actionDisabled={Object.values(margins).every((value) => value === 0)}
      actionHint={t("pdf-advanced-tools.increase.at.least.one.margin.559863")}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(['top', 'right', 'bottom', 'left'] as const).map((key) => (
          <label key={key} className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-[0.16em] text-[var(--text-tertiary)]">{key}</span>
            <input
              type="number"
              min={0}
              max={40}
              value={margins[key]}
              onChange={(event) => setMargin(key, event.target.value)}
              disabled={status.isProcessing}
              inputMode="decimal"
              className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
            />
            <span className="mt-1 block text-xs text-[var(--text-tertiary)]">{t("pdf-advanced-tools.of.page.42a4a1")}</span>
          </label>
        ))}
      </div>
    </ToolShell>
  );
};

export const HeaderFooterPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [headerText, setHeaderText] = useState('');
  const [footerText, setFooterText] = useState('Page {n} of {total}');
  const [fontSize, setFontSize] = useState(10);
  const [includePageNumbers, setIncludePageNumbers] = useState(true);
  const hasContent = Boolean(headerText.trim() || footerText.trim() || includePageNumbers);

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
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("pdf-advanced-tools.the.header.and.footer.could.not.be.90a336") });
    }
  };

  return (
    <ToolShell
      title={t("pdf-advanced-tools.header.footer.aaf783")}
      description={t("pdf-advanced-tools.puts.the.same.line.of.text.at.4718c1")}
      uploadLabel={t("pdf-advanced-tools.choose.a.pdf.for.header.and.footer.a944a3")}
      file={file}
      status={status}
      onFilesSelected={(files) => {
        const next = toPdfFile(files);
        if (!next) {
          setStatus({ ...idleStatus(), error: t("pdf-advanced-tools.choose.a.pdf.file.c2a7df") });
          return;
        }
        setStatus(idleStatus());
        setFile(next);
      }}
      onReset={() => {
        setFile(null);
        setStatus(idleStatus());
      }}
      actionLabel={t("pdf-advanced-tools.add.header.footer.532ade")}
      onAction={handleApply}
      actionDisabled={!hasContent}
      actionHint={t("pdf-advanced-tools.add.header.text.footer.text.or.page.0b0900")}
    >
      <div className="grid gap-2.5">
        <label>
          <span className="mb-1 block text-sm font-semibold text-[var(--text-secondary)]">{t("pdf-advanced-tools.header.text.a16987")}</span>
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
        <label>
          <span className="mb-1 block text-sm font-semibold text-[var(--text-secondary)]">{t("pdf-advanced-tools.footer.text.0b0272")}</span>
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
        <div className="grid gap-2.5 sm:grid-cols-[160px_1fr] sm:items-end">
          <label>
            <span className="mb-1 block text-sm font-semibold text-[var(--text-secondary)]">{t("pdf-advanced-tools.font.size.6d784d")}</span>
            <input
              type="number"
              min={8}
              max={48}
              value={fontSize}
              onChange={(event) => {
                clearTerminalStatus();
                setFontSize(Math.max(8, Math.min(48, Number(event.target.value) || 10)));
              }}
              disabled={status.isProcessing}
              inputMode="numeric"
              className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          <label className="chef-target flex items-center gap-2 rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] px-3 text-sm font-semibold text-[var(--text-body)]">
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
        </div>
      </div>
    </ToolShell>
  );
};

export const RemoveBlankPagesPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [removedPages, setRemovedPages] = useState<number[]>([]);

  const handleRemove = async () => {
    if (!file) return;
    setRemovedPages([]);
    setStatus({ isProcessing: true, progress: 5, message: t("pdf-advanced-tools.scanning.pages.0ef4d2") });
    try {
      const result = await removeBlankPagesFromPDF(file.file, {
        onProgress: (current, total) => {
          setStatus({ isProcessing: true, progress: Math.round((current / total) * 90), message: t("pdf-advanced-tools.scanning.page.of.0f093b", { v0: current, v1: total }) });
        },
      });
      setRemovedPages(result.removedPages);
      const outputName = toolOutputName('remove-blank-pages', file.name, 'pdf');
      downloadBlob(new Blob([result.bytes], { type: 'application/pdf' }), outputName);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: result.removedPages.length > 0
          ? t("pdf-advanced-tools.removed.blank.page.created.ffb782", { v2: outputName, count: result.removedPages.length })
          : t("pdf-advanced-tools.no.blank.pages.were.detected.created.without.2e7fdb", { v0: outputName }),
      });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("pdf-advanced-tools.the.blank.pages.could.not.be.removed.e20ac8") });
    }
  };

  return (
    <ToolShell
      title={t("pdf-advanced-tools.remove.blank.pages.f85882")}
      description={t("pdf-advanced-tools.nearly.empty.pages.count.as.blank.8e2727")}
      uploadLabel={t("pdf-advanced-tools.choose.a.pdf.to.remove.blank.pages.56a840")}
      file={file}
      status={status}
      onFilesSelected={(files) => {
        const next = toPdfFile(files);
        if (!next) {
          setStatus({ ...idleStatus(), error: t("pdf-advanced-tools.choose.a.pdf.file.c2a7df") });
          return;
        }
        setStatus(idleStatus());
        setRemovedPages([]);
        setFile(next);
      }}
      onReset={() => {
        setFile(null);
        setRemovedPages([]);
        setStatus(idleStatus());
      }}
      actionLabel={t("pdf-advanced-tools.remove.blank.pages.527c64")}
      onAction={handleRemove}
      selectedContent={
        removedPages.length > 0 ? (
          <p className="mt-3 rounded-[var(--radius-field)] bg-[var(--status-caution-quiet)] px-3 py-2.5 text-sm font-semibold text-[var(--status-caution-text)]">{t("pdf-advanced-tools.message.42c8b18305", { v0: removedPages.join(', ') })}</p>
        ) : null
      }
    />
  );
};

export const ExtractImagesPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  useReleasePdfDocument(file?.file);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [images, setImages] = useState<EmbeddedPdfImageAsset[]>([]);
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
    try {
      const pdfDoc = await loadPDFDocument(selected.file);
      const extracted = await extractEmbeddedImagesFromPDF(pdfDoc, {
        onProgress: (current, total) => {
          setStatus({ isProcessing: true, progress: Math.round((current / total) * 90), message: t("pdf-advanced-tools.scanning.page.of.0f093b", { v0: current, v1: total }) });
        },
      });
      setImages(extracted);
      const grant = await completeJob(operationId).catch(() => 'preview-only' as const);
      if (imageOperationIdRef.current !== operationId) return;
      imageGrantRef.current = grant;
      setStatus({
        isProcessing: false,
        progress: 100,
        message: extracted.length > 0
          ? t("pdf-advanced-tools.found.embedded.image.11b935", { count: extracted.length })
          : t("pdf-advanced-tools.this.pdf.has.no.pictures.stored.in.fa5b86"),
      });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("pdf-advanced-tools.the.pictures.could.not.be.saved.try.7b1ada") });
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
      const zip = new JSZip();
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
        message: t("pdf-advanced-tools.created.with.image.a61a29", { v0: outputName, count: images.length }),
      });
    } catch (error) {
      console.error(error);
      setStatus({ ...idleStatus(), error: t("pdf-advanced-tools.the.pictures.could.not.be.put.into.d67287") });
    }
  };

  return (
    <ToolShell
      title={t("pdf-advanced-tools.extract.images.6a8eaf")}
      description={t("pdf-advanced-tools.embedded.images.are.exported.as.png.f1bce4")}
      uploadLabel={t("pdf-advanced-tools.choose.a.pdf.to.extract.images.7201bd")}
      file={file}
      status={status}
      onFilesSelected={handleFilesSelected}
      onReset={() => {
        images.forEach((image) => URL.revokeObjectURL(image.objectUrl));
        setImages([]);
        setFile(null);
        imageOperationIdRef.current = null;
        imageGrantRef.current = null;
        setStatus(idleStatus());
      }}
      actionLabel={images.length > 0 ? t("pdf-advanced-tools.download.all.images.c7daa4") : t("pdf-advanced-tools.scan.images.fc2418")}
      onAction={images.length > 0 ? downloadAll : () => file && scanImages(file)}
    >
      {images.length > 0 ? (
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.16em] text-[var(--text-secondary)]">
            <Archive aria-hidden size={18} />{t("pdf-advanced-tools.message.ba0aedff09", { count: images.length })}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
                className="group overflow-hidden rounded-[var(--radius-field)] border border-[var(--border-strong)] bg-[var(--surface-sunken)]"
              >
                <img src={image.objectUrl} alt={t("pdf-advanced-tools.extracted.image.a40163", { v0: index + 1 })} className="h-24 w-full object-contain p-2" />
                <div className="border-t border-[var(--border-hairline)] px-2 py-1.5 text-xs font-semibold text-[var(--text-secondary)]">{t("pdf-advanced-tools.message.1fac9292db", { v0: image.pageNumbers.join(', ') })}</div>
              </button>
            ))}
          </div>
          {images.length > 9 && (
            <p className="type-footnote mt-2 text-[var(--text-secondary)]">{t("pdf-advanced-tools.message.6e168770e3", { v0: images.length })}</p>
          )}
        </div>
      ) : null}
    </ToolShell>
  );
};
