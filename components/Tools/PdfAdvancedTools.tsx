import React, { useEffect, useState } from 'react';
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
import { formatBytes } from '../UI/format';

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
              >
                Change
              </button>
            </div>

            {children && <div className="mt-3">{children}</div>}
            {selectedContent}

            {status.isProcessing && (
              <div role="status" aria-live="polite" className="mt-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3 py-2.5">
                <div className="flex items-start justify-between gap-3 text-sm font-semibold text-[var(--text-body)]">
                  <span>{status.message || 'Processing on this device…'}</span>
                  <span className="shrink-0 tabular-nums">{progress}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${title} progress`}
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
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });

  const handleFilesSelected = (files: File[]) => {
    const next = toPdfFile(files);
    if (!next) {
      setStatus({ ...idleStatus(), error: 'Choose a PDF file.' });
      return;
    }
    setStatus(idleStatus());
    setFile(next);
  };

  const handleTransform = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 20, message: 'Processing PDF...' });
    try {
      const bytes = await transform(file.file);
      const outputName = `${outputPrefix}-${file.name}`;
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), outputName);
      setStatus({ isProcessing: false, progress: 100, message: `Created ${outputName}.` });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Unable to process this PDF.' });
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

export const RemoveMetadataPDF: React.FC = () => (
  <SimpleTransformTool
    title="Remove Metadata"
    uploadLabel="Choose a PDF to remove metadata"
    actionLabel="Remove metadata"
    outputPrefix="metadata-cleaned"
    transform={removePDFMetadata}
  />
);

export const RemoveAnnotationsPDF: React.FC = () => (
  <SimpleTransformTool
    title="Remove Annotations"
    description="Comments, markup and page actions are dropped."
    uploadLabel="Choose a PDF to remove annotations"
    actionLabel="Remove annotations"
    outputPrefix="annotations-removed"
    transform={removePDFAnnotations}
  />
);

export const SanitizePDF: React.FC = () => (
  <SimpleTransformTool
    title="Sanitize PDF"
    description="Metadata and annotations are dropped."
    uploadLabel="Choose a PDF to sanitize"
    actionLabel="Sanitize PDF"
    outputPrefix="sanitized"
    transform={sanitizePDF}
  />
);

export const CropPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [margins, setMargins] = useState({ top: 5, right: 5, bottom: 5, left: 5 });

  const setMargin = (key: keyof typeof margins, value: string) => {
    if (!status.isProcessing && (status.error || status.progress === 100)) setStatus(idleStatus());
    setMargins((current) => ({ ...current, [key]: Math.max(0, Math.min(40, Number(value) || 0)) }));
  };

  const handleCrop = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 20, message: 'Applying crop box...' });
    try {
      const bytes = await cropPDFMargins(file.file, margins);
      const outputName = `cropped-${file.name}`;
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), outputName);
      setStatus({ isProcessing: false, progress: 100, message: `Created ${outputName}.` });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Unable to crop this PDF.' });
    }
  };

  return (
    <ToolShell
      title="Crop PDF"
      uploadLabel="Choose a PDF to crop"
      file={file}
      status={status}
      onFilesSelected={(files) => {
        const next = toPdfFile(files);
        if (!next) {
          setStatus({ ...idleStatus(), error: 'Choose a PDF file.' });
          return;
        }
        setStatus(idleStatus());
        setFile(next);
      }}
      onReset={() => {
        setFile(null);
        setStatus(idleStatus());
      }}
      actionLabel="Crop PDF"
      onAction={handleCrop}
      actionDisabled={Object.values(margins).every((value) => value === 0)}
      actionHint="Increase at least one margin."
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
            <span className="mt-1 block text-xs text-[var(--text-tertiary)]">% of page</span>
          </label>
        ))}
      </div>
    </ToolShell>
  );
};

export const HeaderFooterPDF: React.FC = () => {
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
      setStatus({ ...idleStatus(), error: 'Add header text, footer text, or page numbers.' });
      return;
    }
    setStatus({ isProcessing: true, progress: 20, message: 'Adding header and footer...' });
    try {
      const bytes = await addHeaderFooterToPDF(file.file, { headerText, footerText, fontSize, includePageNumbers });
      const outputName = `header-footer-${file.name}`;
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), outputName);
      setStatus({ isProcessing: false, progress: 100, message: `Created ${outputName}.` });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Unable to add header or footer.' });
    }
  };

  return (
    <ToolShell
      title="Header & Footer"
      uploadLabel="Choose a PDF for header and footer"
      file={file}
      status={status}
      onFilesSelected={(files) => {
        const next = toPdfFile(files);
        if (!next) {
          setStatus({ ...idleStatus(), error: 'Choose a PDF file.' });
          return;
        }
        setStatus(idleStatus());
        setFile(next);
      }}
      onReset={() => {
        setFile(null);
        setStatus(idleStatus());
      }}
      actionLabel="Add header/footer"
      onAction={handleApply}
      actionDisabled={!hasContent}
      actionHint="Add header text, footer text, or page numbers."
    >
      <div className="grid gap-2.5">
        <label>
          <span className="mb-1 block text-sm font-semibold text-[var(--text-secondary)]">Header text</span>
          <input
            value={headerText}
            onChange={(event) => {
              clearTerminalStatus();
              setHeaderText(event.target.value);
            }}
            placeholder="Optional header"
            disabled={status.isProcessing}
            className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <label>
          <span className="mb-1 block text-sm font-semibold text-[var(--text-secondary)]">Footer text</span>
          <input
            value={footerText}
            onChange={(event) => {
              clearTerminalStatus();
              setFooterText(event.target.value);
            }}
            placeholder="Page {n} of {total}"
            disabled={status.isProcessing}
            className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <div className="grid gap-2.5 sm:grid-cols-[160px_1fr] sm:items-end">
          <label>
            <span className="mb-1 block text-sm font-semibold text-[var(--text-secondary)]">Font size</span>
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
            />
            Use page numbers if footer is blank
          </label>
        </div>
      </div>
    </ToolShell>
  );
};

export const RemoveBlankPagesPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [removedPages, setRemovedPages] = useState<number[]>([]);

  const handleRemove = async () => {
    if (!file) return;
    setRemovedPages([]);
    setStatus({ isProcessing: true, progress: 5, message: 'Scanning pages...' });
    try {
      const result = await removeBlankPagesFromPDF(file.file, {
        onProgress: (current, total) => {
          setStatus({ isProcessing: true, progress: Math.round((current / total) * 90), message: `Scanning page ${current} of ${total}` });
        },
      });
      setRemovedPages(result.removedPages);
      const outputName = `blank-pages-removed-${file.name}`;
      downloadBlob(new Blob([result.bytes], { type: 'application/pdf' }), outputName);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: result.removedPages.length > 0
          ? `Removed ${result.removedPages.length} blank page${result.removedPages.length === 1 ? '' : 's'}. Created ${outputName}.`
          : `No blank pages were detected. Created ${outputName} without removing pages.`,
      });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Unable to remove blank pages.' });
    }
  };

  return (
    <ToolShell
      title="Remove Blank Pages"
      description="Nearly empty pages count as blank."
      uploadLabel="Choose a PDF to remove blank pages"
      file={file}
      status={status}
      onFilesSelected={(files) => {
        const next = toPdfFile(files);
        if (!next) {
          setStatus({ ...idleStatus(), error: 'Choose a PDF file.' });
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
      actionLabel="Remove blank pages"
      onAction={handleRemove}
      selectedContent={
        removedPages.length > 0 ? (
          <p className="mt-3 rounded-[var(--radius-field)] bg-[var(--status-caution-quiet)] px-3 py-2.5 text-sm font-semibold text-[var(--status-caution-text)]">
            Removed pages: {removedPages.join(', ')}
          </p>
        ) : null
      }
    />
  );
};

export const ExtractImagesPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [images, setImages] = useState<EmbeddedPdfImageAsset[]>([]);

  useEffect(() => {
    return () => images.forEach((image) => URL.revokeObjectURL(image.objectUrl));
  }, [images]);

  const scanImages = async (selected: PDFFile) => {
    setStatus({ isProcessing: true, progress: 10, message: 'Scanning embedded images...' });
    try {
      const pdfDoc = await loadPDFDocument(selected.file);
      const extracted = await extractEmbeddedImagesFromPDF(pdfDoc, {
        onProgress: (current, total) => {
          setStatus({ isProcessing: true, progress: Math.round((current / total) * 90), message: `Scanning page ${current} of ${total}` });
        },
      });
      setImages(extracted);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: extracted.length > 0
          ? `Found ${extracted.length} embedded image${extracted.length === 1 ? '' : 's'}.`
          : 'No embedded images were found in this PDF.',
      });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Unable to extract images from this PDF.' });
    }
  };

  const handleFilesSelected = (files: File[]) => {
    const next = toPdfFile(files);
    if (!next) {
      setStatus({ ...idleStatus(), error: 'Choose a PDF file.' });
      return;
    }
    images.forEach((image) => URL.revokeObjectURL(image.objectUrl));
    setImages([]);
    setFile(next);
    setStatus(idleStatus());
    void scanImages(next);
  };

  const downloadAll = async () => {
    if (!file || images.length === 0) return;
    setStatus({ isProcessing: true, progress: 90, message: 'Packing images...' });
    try {
      const zip = new JSZip();
      images.forEach((image, index) => {
        zip.file(`image-${String(index + 1).padStart(2, '0')}-pages-${image.pageNumbers.join('-')}.png`, image.blob);
      });
      const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        setStatus({
          isProcessing: true,
          progress: 90 + Math.round(metadata.percent / 10),
          message: 'Packing images...',
        });
      });
      const outputName = `extracted-images-${file.name.replace(/\.pdf$/i, '')}.zip`;
      downloadBlob(blob, outputName, 'application/zip');
      setStatus({
        isProcessing: false,
        progress: 100,
        message: `Created ${outputName} with ${images.length} image${images.length === 1 ? '' : 's'}.`,
      });
    } catch (error) {
      console.error(error);
      setStatus({ ...idleStatus(), error: 'Unable to package the extracted images.' });
    }
  };

  return (
    <ToolShell
      title="Extract Images"
      description="Embedded images are exported as PNG."
      uploadLabel="Choose a PDF to extract images"
      file={file}
      status={status}
      onFilesSelected={handleFilesSelected}
      onReset={() => {
        images.forEach((image) => URL.revokeObjectURL(image.objectUrl));
        setImages([]);
        setFile(null);
        setStatus(idleStatus());
      }}
      actionLabel={images.length > 0 ? 'Download all images' : 'Scan images'}
      onAction={images.length > 0 ? downloadAll : () => file && scanImages(file)}
    >
      {images.length > 0 ? (
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.16em] text-[var(--text-secondary)]">
            <Archive aria-hidden size={18} />
            {images.length} image{images.length === 1 ? '' : 's'} found
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {images.slice(0, 9).map((image, index) => (
              <a
                key={image.id}
                href={image.objectUrl}
                download={`image-${index + 1}.png`}
                className="group overflow-hidden rounded-[var(--radius-field)] border border-[var(--border-strong)] bg-[var(--surface-sunken)]"
              >
                <img src={image.objectUrl} alt={`Extracted image ${index + 1}`} className="h-24 w-full object-contain p-2" />
                <div className="border-t border-[var(--border-hairline)] px-2 py-1.5 text-xs font-semibold text-[var(--text-secondary)]">
                  Pages {image.pageNumbers.join(', ')}
                </div>
              </a>
            ))}
          </div>
          {images.length > 9 && (
            <p className="type-footnote mt-2 text-[var(--text-secondary)]">
              First 9 shown · Download all includes {images.length}.
            </p>
          )}
        </div>
      ) : null}
    </ToolShell>
  );
};
