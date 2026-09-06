import React, { useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { AlertTriangle, Plus, ArrowDown, ArrowUp, Files, Loader2, Trash2, XCircle } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { analyzePDF, compressPDFAdaptive, extractTextFromPDF, loadPDFDocument, renderPageAsImage } from '../../services/pdfBrowser';
import {
  addPageNumbersToPDF,
  addWatermarkToPDF,
  flattenPDF,
  protectPDF,
  removePDFMetadata,
  repairPDF,
  rotatePDF,
  splitPDFByPagesPerFile,
  unlockPDF,
} from '../../services/pdfDocument';
import { convertPDFToDocx } from '../../services/docxExport';
import { downloadBlob, revokeObjectUrl } from '../../services/pdfShared';
import { recordSavings, shouldWarnForFiles } from '../../services/workspace';
import type { ProcessingStatus } from '../../types';
import { formatBytes } from '../UI/format';

type BatchAction = 'compress' | 'split' | 'pdf-to-image' | 'pdf-to-word' | 'rotate' | 'protect' | 'unlock' | 'metadata' | 'flatten' | 'extract-text' | 'watermark' | 'page-numbers' | 'repair';
type BatchItemPhase = 'queued' | 'processing' | 'completed' | 'failed' | 'canceled';

interface BatchItemStatus {
  phase: BatchItemPhase;
  progress: number;
  message?: string;
}

/** `detail` is set only where the label leaves out an output format or a consequence. */
const actions: Array<{ value: BatchAction; label: string; detail?: string }> = [
  { value: 'compress', label: 'Compress PDF' },
  { value: 'split', label: 'Split PDF' },
  { value: 'pdf-to-image', label: 'PDF to Image', detail: 'JPG pages in one ZIP per PDF' },
  { value: 'pdf-to-word', label: 'PDF to Word', detail: 'DOCX' },
  { value: 'rotate', label: 'Rotate Pages' },
  { value: 'protect', label: 'Protect PDF', detail: 'One password for every PDF' },
  { value: 'unlock', label: 'Unlock PDF', detail: 'One password for every PDF' },
  { value: 'metadata', label: 'Clear Metadata' },
  { value: 'flatten', label: 'Flatten PDF' },
  { value: 'extract-text', label: 'Extract Text', detail: 'TXT' },
  { value: 'watermark', label: 'Watermark PDF' },
  { value: 'page-numbers', label: 'Page Numbers' },
  { value: 'repair', label: 'Repair PDF' },
];

const baseName = (name: string) => name.replace(/\.pdf$/i, '');
const bytesBlob = (bytes: Uint8Array, type = 'application/pdf') => new Blob([bytes], { type });
const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;
const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });
const clampProgress = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

class BatchCanceledError extends Error {
  constructor() {
    super('Batch canceled.');
    this.name = 'AbortError';
  }
}

const phaseLabel = (status: BatchItemStatus): string => {
  if (status.phase === 'processing') return `${status.progress}%`;
  if (status.phase === 'completed') return 'Completed';
  if (status.phase === 'failed') return 'Failed';
  if (status.phase === 'canceled') return 'Canceled';
  return 'Queued';
};

const phaseClasses: Record<BatchItemPhase, string> = {
  queued: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
  processing: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-200',
  completed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200',
  failed: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-200',
  canceled: 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200',
};

export const BatchPDF: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [action, setAction] = useState<BatchAction>('compress');
  const [password, setPassword] = useState('');
  const [pagesPerSplit, setPagesPerSplit] = useState(1);
  const [rotation, setRotation] = useState(90);
  const [watermark, setWatermark] = useState('CONFIDENTIAL');
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus());
  const [itemStatuses, setItemStatuses] = useState<Record<string, BatchItemStatus>>({});
  const [selectionNotice, setSelectionNotice] = useState('');
  const [cancelPending, setCancelPending] = useState(false);
  const cancelRequestedRef = useRef(false);
  const selectedAction = useMemo(() => actions.find((item) => item.value === action)!, [action]);
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const validationMessage = useMemo(() => {
    if (!files.length) return 'Add at least one PDF to start.';
    if ((action === 'protect' || action === 'unlock') && password.length === 0) {
      return 'Enter the password exactly as it should be used.';
    }
    if (action === 'watermark' && watermark.trim().length === 0) return 'Enter visible watermark text.';
    return '';
  }, [action, files.length, password, watermark]);

  const clearRunFeedback = () => {
    if (status.isProcessing) return;
    setStatus(idleStatus());
    setItemStatuses({});
  };

  const addFiles = (selected: File[]) => {
    if (status.isProcessing) return;
    const pdfs = selected.filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
    const skippedUnsupported = selected.length - pdfs.length;
    if (!pdfs.length) {
      setSelectionNotice('');
      setStatus({ ...idleStatus(), error: 'Choose one or more PDF files.' });
      return;
    }

    const merged = [...files, ...pdfs].filter((file, index, all) => (
      all.findIndex((candidate) => fileKey(candidate) === fileKey(file)) === index
    ));
    if (shouldWarnForFiles(merged) && !window.confirm('These PDFs may use substantial browser memory. Continue adding them?')) return;

    const duplicateCount = pdfs.length - (merged.length - files.length);
    const noticeParts: string[] = [];
    if (skippedUnsupported > 0) noticeParts.push(`${skippedUnsupported} unsupported file${skippedUnsupported === 1 ? '' : 's'} skipped`);
    if (duplicateCount > 0) noticeParts.push(`${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'} skipped`);

    setFiles(merged);
    setItemStatuses({});
    setStatus(idleStatus());
    setSelectionNotice(noticeParts.length ? `${noticeParts.join(' · ')}.` : '');
  };

  const removeFile = (file: File) => {
    if (status.isProcessing) return;
    setFiles((current) => current.filter((item) => item !== file));
    setItemStatuses((current) => {
      const next = { ...current };
      delete next[fileKey(file)];
      return next;
    });
    setStatus(idleStatus());
  };

  const moveFile = (fromIndex: number, toIndex: number) => {
    if (status.isProcessing || toIndex < 0 || toIndex >= files.length) return;
    setFiles((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    clearRunFeedback();
  };

  const processFile = async (
    file: File,
    onProgress: (progress: number) => void,
    isCanceled: () => boolean,
  ): Promise<{ blob: Blob; filename: string }> => {
    const checkCanceled = () => {
      if (isCanceled()) throw new BatchCanceledError();
    };
    const finish = <T,>(result: T): T => {
      checkCanceled();
      return result;
    };

    checkCanceled();
    if (action === 'compress') {
      const analysis = await analyzePDF(file);
      checkCanceled();
      const result = await compressPDFAdaptive(
        file,
        'recommended',
        (progress) => onProgress(progress),
        false,
        undefined,
        true,
        analysis.isTextHeavy,
      );
      checkCanceled();
      if (result.status !== 'success') throw new Error('Compression was blocked by the readability safety limit.');
      recordSavings(file.size, result.data.length);
      return { blob: bytesBlob(result.data), filename: `${baseName(file.name)}-compressed.pdf` };
    }
    if (action === 'split') {
      const result = finish(await splitPDFByPagesPerFile(file, pagesPerSplit));
      return { blob: result.blob, filename: `${baseName(file.name)}-parts.${result.isArchive ? 'zip' : 'pdf'}` };
    }
    if (action === 'pdf-to-image') {
      const pdf = await loadPDFDocument(file);
      const zip = new JSZip();
      for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
        checkCanceled();
        const rendered = await renderPageAsImage(pdf, pageIndex, { format: 'image/jpeg', quality: 0.88, scale: 1.5 });
        try {
          zip.file(`page-${String(pageIndex + 1).padStart(3, '0')}.jpg`, rendered.blob);
        } finally {
          revokeObjectUrl(rendered.objectUrl);
        }
        onProgress(((pageIndex + 1) / pdf.numPages) * 90);
      }
      const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => onProgress(90 + metadata.percent / 10));
      return { blob: finish(blob), filename: `${baseName(file.name)}-images.zip` };
    }
    if (action === 'pdf-to-word') return { blob: finish(await convertPDFToDocx(file)), filename: `${baseName(file.name)}.docx` };
    if (action === 'rotate') return { blob: bytesBlob(finish(await rotatePDF(file, rotation))), filename: `${baseName(file.name)}-rotated.pdf` };
    if (action === 'protect') return { blob: bytesBlob(finish(await protectPDF(file, password))), filename: `${baseName(file.name)}-protected.pdf` };
    if (action === 'unlock') return { blob: bytesBlob(finish(await unlockPDF(file, password))), filename: `${baseName(file.name)}-unlocked.pdf` };
    if (action === 'metadata') return { blob: bytesBlob(finish(await removePDFMetadata(file))), filename: `${baseName(file.name)}-metadata-cleared.pdf` };
    if (action === 'flatten') return { blob: bytesBlob(finish(await flattenPDF(file))), filename: `${baseName(file.name)}-flattened.pdf` };
    if (action === 'extract-text') return { blob: new Blob([finish(await extractTextFromPDF(file))], { type: 'text/plain' }), filename: `${baseName(file.name)}.txt` };
    if (action === 'watermark') {
      const bytes = finish(await addWatermarkToPDF(file, { text: watermark, size: 50, opacity: 0.3, rotation: -45, color: '#000000' }));
      return { blob: bytesBlob(bytes), filename: `${baseName(file.name)}-watermarked.pdf` };
    }
    if (action === 'page-numbers') {
      const numbered = await loadPDFDocument(file);
      const lastPage = Math.max(1, Number(numbered?.numPages) || 1);
      try {
        const bytes = finish(
          await addPageNumbersToPDF(file, {
            format: 'Page {n}',
            fontSize: 10,
            xPercent: 0.5,
            yPercent: 0.045,
            startPage: 1,
            endPage: lastPage,
          }),
        );
        return { blob: bytesBlob(bytes), filename: `${baseName(file.name)}-numbered.pdf` };
      } finally {
        if (numbered?.destroy) void numbered.destroy();
      }
    }
    return { blob: bytesBlob(finish(await repairPDF(file))), filename: `${baseName(file.name)}-repaired.pdf` };
  };

  const runBatch = async () => {
    if (validationMessage) {
      setStatus({ ...idleStatus(), error: validationMessage });
      return;
    }

    cancelRequestedRef.current = false;
    setCancelPending(false);
    setSelectionNotice('');
    setItemStatuses(Object.fromEntries(files.map((file) => [
      fileKey(file),
      { phase: 'queued', progress: 0 } satisfies BatchItemStatus,
    ])));
    setStatus({ isProcessing: true, progress: 1, message: 'Starting batch…' });

    const zip = new JSZip();
    const failures: string[] = [];
    let completedCount = 0;

    try {
      for (let index = 0; index < files.length; index += 1) {
        if (cancelRequestedRef.current) break;
        const file = files[index];
        const key = fileKey(file);
        const updateProgress = (rawProgress: number) => {
          const progress = clampProgress(rawProgress);
          setItemStatuses((current) => ({ ...current, [key]: { phase: 'processing', progress } }));
          if (!cancelRequestedRef.current) {
            setStatus({
              isProcessing: true,
              progress: Math.max(1, Math.round(((index + progress / 100) / files.length) * 88)),
              message: `${selectedAction.label}: ${file.name} (${index + 1}/${files.length})`,
            });
          }
        };

        updateProgress(0);
        try {
          const result = await processFile(file, updateProgress, () => cancelRequestedRef.current);
          if (cancelRequestedRef.current) throw new BatchCanceledError();
          zip.file(result.filename, result.blob);
          completedCount += 1;
          setItemStatuses((current) => ({ ...current, [key]: { phase: 'completed', progress: 100 } }));
        } catch (error) {
          if (error instanceof BatchCanceledError || cancelRequestedRef.current) {
            setItemStatuses((current) => ({ ...current, [key]: { phase: 'canceled', progress: 0 } }));
            break;
          }
          const message = error instanceof Error ? error.message : 'Unable to process this file.';
          failures.push(`${file.name}: ${message}`);
          setItemStatuses((current) => ({ ...current, [key]: { phase: 'failed', progress: 0, message } }));
        }
      }

      if (cancelRequestedRef.current) {
        setItemStatuses((current) => {
          const next = { ...current };
          files.forEach((file) => {
            const key = fileKey(file);
            if (!next[key] || next[key].phase === 'queued' || next[key].phase === 'processing') {
              next[key] = { phase: 'canceled', progress: 0 };
            }
          });
          return next;
        });
        setStatus({
          isProcessing: false,
          progress: 0,
          message: `Canceled after ${completedCount} of ${files.length} files; no ZIP was created.`,
        });
        return;
      }

      if (failures.length) zip.file('failures.txt', failures.join('\n'));
      if (failures.length === files.length) {
        setStatus({ ...idleStatus(), error: `All ${files.length} files failed; review the queue for details.` });
        return;
      }

      const archive = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        setStatus({ isProcessing: true, progress: 88 + Math.round(metadata.percent * 0.12), message: 'Packing outputs…' });
      });
      if (cancelRequestedRef.current) {
        setStatus({
          isProcessing: false,
          progress: 0,
          message: `Canceled after ${completedCount} of ${files.length} files; no ZIP was created.`,
        });
        return;
      }
      const outputName = `pdf-chef-${action}-batch.zip`;
      downloadBlob(archive, outputName, 'application/zip');
      setStatus({
        isProcessing: false,
        progress: 100,
        message: failures.length
          ? `Created ${outputName} with ${completedCount} outputs and ${failures.length} failure${failures.length === 1 ? '' : 's'} listed in failures.txt.`
          : `Created ${outputName} with ${completedCount} outputs.`,
      });
    } catch (error) {
      console.error(error);
      setStatus({ ...idleStatus(), error: 'Unable to create the batch ZIP; review the queue and try again.' });
    } finally {
      setCancelPending(false);
    }
  };

  const cancelBatch = () => {
    if (!status.isProcessing || cancelPending) return;
    cancelRequestedRef.current = true;
    setCancelPending(true);
    setStatus((current) => ({ ...current, message: 'Canceling after the current file step…' }));
  };

  return (
    <ToolShell width="wide" centered={files.length === 0}>
      {/* Kept: the ZIP is the one thing the Operation control and the Process
          button do not say. */}
      <ToolHeader title="Batch Processing" note="Every result is returned in one ZIP." />

      <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
        <aside className="order-1 h-fit rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4 lg:order-1">
          {!status.isProcessing && (
            <div className="mb-3">
              {files.length > 0 ? (
                <label className="chef-target chef-pressable flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-field)] border border-dashed border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--accent-text)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]">
                  <Plus aria-hidden size={18} />
                  Add PDFs
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    multiple
                    aria-label="Add PDFs to the batch"
                    className="sr-only"
                    onChange={(event) => {
                      const picked = Array.from(event.target.files ?? []) as File[];
                      if (picked.length) addFiles(picked);
                      event.target.value = '';
                    }}
                  />
                </label>
              ) : (
                <FileUpload onFilesSelected={addFiles} accept=".pdf,application/pdf" multiple label="Add PDFs to the batch" />
              )}
            </div>
          )}
          <label className="block text-sm font-bold text-[var(--text-body)]">Operation
            <select
              value={action}
              onChange={(event) => {
                setAction(event.target.value as BatchAction);
                clearRunFeedback();
              }}
              disabled={status.isProcessing}
              className="chef-field mt-1 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {actions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          {selectedAction.detail && (
            <p className="type-footnote mt-1.5 text-[var(--text-secondary)]">{selectedAction.detail}</p>
          )}

          {action === 'split' && (
            <label className="mt-3 block text-sm font-bold text-[var(--text-body)]">Pages per part
              <input
                type="number"
                min={1}
                max={1000}
                inputMode="numeric"
                value={pagesPerSplit}
                onChange={(event) => {
                  clearRunFeedback();
                  setPagesPerSplit(Math.min(1000, Math.max(1, Number(event.target.value) || 1)));
                }}
                disabled={status.isProcessing}
                className="chef-field mt-2 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          )}
          {action === 'rotate' && (
            <label className="mt-3 block text-sm font-bold text-[var(--text-body)]">Rotation
              <select
                value={rotation}
                onChange={(event) => {
                  clearRunFeedback();
                  setRotation(Number(event.target.value));
                }}
                disabled={status.isProcessing}
                className="chef-field mt-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value={90}>90° clockwise</option>
                <option value={180}>180°</option>
                <option value={270}>90° counter-clockwise</option>
              </select>
            </label>
          )}
          {(action === 'protect' || action === 'unlock') && (
            <label className="mt-3 block text-sm font-bold text-[var(--text-body)]">Password
              <input
                type="password"
                value={password}
                onChange={(event) => {
                  clearRunFeedback();
                  setPassword(event.target.value);
                }}
                autoComplete="new-password"
                disabled={status.isProcessing}
                className="chef-field mt-2 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span className="mt-1 block text-xs font-normal text-[var(--text-tertiary)]">Spaces are preserved exactly.</span>
            </label>
          )}
          {action === 'watermark' && (
            <label className="mt-3 block text-sm font-bold text-[var(--text-body)]">Watermark text
              <input
                value={watermark}
                onChange={(event) => {
                  clearRunFeedback();
                  setWatermark(event.target.value);
                }}
                disabled={status.isProcessing}
                className="chef-field mt-2 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          )}

          {status.isProcessing && (
            <div role="status" aria-live="polite" className="mt-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3 py-2.5">
              <div className="flex items-start justify-between gap-3 text-sm font-semibold text-[var(--text-body)]">
                <span className="min-w-0 break-words">{status.message}</span>
                <span className="shrink-0 tabular-nums">{status.progress}%</span>
              </div>
              <div
                role="progressbar"
                aria-label="Batch progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={status.progress}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-canvas)]"
              >
                <div className="h-full rounded-full bg-[var(--accent-rest)] transition-[width]" style={{ width: `${clampProgress(status.progress)}%` }} />
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => void runBatch()}
            disabled={status.isProcessing || Boolean(validationMessage)}
            className="chef-target chef-pressable mt-3 inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-transparent bg-[var(--accent-rest)] px-4 text-sm font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:border-[var(--border-hairline)] disabled:bg-[var(--surface-sunken)] disabled:text-[var(--text-tertiary)] disabled:opacity-100"
          >
            {status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <Files aria-hidden size={18} />}
            Process {files.length} file{files.length === 1 ? '' : 's'}
          </button>
          {!status.isProcessing && validationMessage && files.length > 0 && (
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{validationMessage}</p>
          )}
          {status.isProcessing && (
            <button
              type="button"
              onClick={cancelBatch}
              disabled={cancelPending}
              className="chef-target chef-pressable mt-2 inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--accent-rest)] disabled:cursor-not-allowed disabled:opacity-55"
            >
              <XCircle aria-hidden size={18} />
              {cancelPending ? 'Canceling…' : 'Cancel batch'}
            </button>
          )}
        </aside>

        <div className="order-2 min-w-0 lg:order-2" aria-busy={status.isProcessing}>
          {selectionNotice && (
            <p role="status" className="flex items-start gap-2 rounded-[var(--radius-field)] bg-[var(--status-caution-quiet)] px-3 py-2 text-sm font-medium text-[var(--status-caution-text)]">
              <AlertTriangle aria-hidden className="mt-0.5 shrink-0" size={16} />
              <span>{selectionNotice}</span>
            </p>
          )}
          {files.length > 0 && (
            <section className="mt-3 lg:mt-0" aria-labelledby="batch-queue-heading">
              {/* "Files run from top to bottom" is what a numbered queue with
                  move-up and move-down controls already shows. */}
              <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
                <h2 id="batch-queue-heading" className="text-sm font-bold text-[var(--text-primary)]">Ordered queue</h2>
                <p className="type-footnote font-semibold text-[var(--text-secondary)]">
                  {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalSize)}
                </p>
              </div>
              <ol className="divide-y divide-[var(--border-hairline)] overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)]">
                {files.map((file, index) => {
                  const itemStatus: BatchItemStatus = itemStatuses[fileKey(file)] ?? { phase: 'queued', progress: 0 };
                  return (
                    <li key={fileKey(file)} className="p-2.5 sm:p-3">
                      <div className="flex items-start gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--accent-quiet)] text-sm font-bold text-[var(--accent-on-quiet)]">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</p>
                          <p className="type-caption text-[var(--text-tertiary)]">{formatBytes(file.size)}</p>
                        </div>
                        <button
                          type="button"
                          aria-label={`Remove ${file.name}`}
                          onClick={() => removeFile(file)}
                          disabled={status.isProcessing}
                          className="chef-target chef-pressable inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--status-danger-quiet)] hover:text-[var(--status-danger-text)] disabled:cursor-not-allowed disabled:opacity-55"
                        >
                          <Trash2 aria-hidden size={18} />
                        </button>
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 pl-10">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${phaseClasses[itemStatus.phase]}`} aria-live={itemStatus.phase === 'processing' ? 'polite' : undefined}>
                          {phaseLabel(itemStatus)}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label={`Move ${file.name} up`}
                            title="Move up"
                            onClick={() => moveFile(index, index - 1)}
                            disabled={status.isProcessing || index === 0}
                            className="chef-hit-y chef-pressable inline-flex h-11 w-touch items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-55"
                          >
                            <ArrowUp aria-hidden size={18} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${file.name} down`}
                            title="Move down"
                            onClick={() => moveFile(index, index + 1)}
                            disabled={status.isProcessing || index === files.length - 1}
                            className="chef-hit-y chef-pressable inline-flex h-11 w-touch items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-55"
                          >
                            <ArrowDown aria-hidden size={18} />
                          </button>
                        </div>
                      </div>

                      {itemStatus.phase === 'processing' && (
                        <div
                          role="progressbar"
                          aria-label={`${file.name} progress`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={itemStatus.progress}
                          className="ml-10 mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]"
                        >
                          <div className="h-full rounded-full bg-[var(--accent-rest)] transition-[width]" style={{ width: `${itemStatus.progress}%` }} />
                        </div>
                      )}
                      {itemStatus.phase === 'failed' && itemStatus.message && (
                        <p role="alert" className="ml-10 mt-1.5 break-words text-sm font-medium text-[var(--status-danger-text)]">{itemStatus.message}</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
        </div>
      </div>
      <StatusToast status={status} />
    </ToolShell>
  );
};
