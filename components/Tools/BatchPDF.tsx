import { formatPercent, formatNumber } from '../../services/i18n/core.ts';
import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { reserveArchiveName } from '../../services/pdfToolResults';
import { AlertTriangle, Plus, ArrowDown, ArrowUp, Files, Loader2, Trash2, XCircle } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { analyzePDF, compressPDFAdaptive, extractTextFromPDF, loadPDFDocument, releasePDFDocument, renderPageAsImage } from '../../services/pdfBrowser';
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
import { formatBytes, toolOutputName, datedOutputName } from '../UI/format';

type BatchAction = 'compress' | 'split' | 'pdf-to-image' | 'pdf-to-word' | 'rotate' | 'protect' | 'unlock' | 'metadata' | 'flatten' | 'extract-text' | 'watermark' | 'page-numbers' | 'repair';
type BatchItemPhase = 'queued' | 'processing' | 'completed' | 'failed' | 'canceled';

interface BatchItemStatus {
  phase: BatchItemPhase;
  progress: number;
  message?: string;
}

/** `detail` is set only where the label leaves out an output format or a consequence. */
const actions: Array<{ value: BatchAction; label: string; detail?: string }> = [
  { value: 'compress', get label() { return t("batch-pdf.compress.pdf.932c3c"); } },
  { value: 'split', get label() { return t("batch-pdf.split.pdf.4f1b84"); } },
  { value: 'pdf-to-image', get label() { return t("batch-pdf.pdf.to.image.185e0a"); }, get detail() { return t("batch-pdf.jpg.pages.in.one.zip.per.pdf.28ce0d"); } },
  { value: 'pdf-to-word', get label() { return t("batch-pdf.pdf.to.word.283553"); }, get detail() { return t("batch-pdf.one.word.file.per.pdf.49a461"); } },
  { value: 'rotate', get label() { return t("batch-pdf.rotate.pages.0cbe65"); } },
  { value: 'protect', get label() { return t("batch-pdf.protect.pdf.dae6c6"); }, get detail() { return t("batch-pdf.one.password.for.every.pdf.896d5c"); } },
  { value: 'unlock', get label() { return t("batch-pdf.unlock.pdf.893947"); }, get detail() { return t("batch-pdf.one.password.for.every.pdf.896d5c"); } },
  { value: 'metadata', get label() { return t("batch-pdf.remove.hidden.info.fa4793"); }, get detail() { return t("batch-pdf.author.dates.and.app.names.f6aef5"); } },
  { value: 'flatten', get label() { return t("batch-pdf.flatten.pdf.86c838"); }, get detail() { return t("batch-pdf.locks.filled.answers.e753dd"); } },
  { value: 'extract-text', get label() { return t("batch-pdf.extract.text.9ab592"); }, get detail() { return t("batch-pdf.one.plain.text.file.per.pdf.a7eb0d"); } },
  { value: 'watermark', get label() { return t("batch-pdf.watermark.pdf.903ce9"); } },
  { value: 'page-numbers', get label() { return t("batch-pdf.page.numbers.78c8fa"); } },
  { value: 'repair', get label() { return t("batch-pdf.repair.pdf.43faa0"); } },
];

const baseName = (name: string) => name.replace(/\.pdf$/i, '');
const bytesBlob = (bytes: Uint8Array, type = 'application/pdf') => new Blob([bytes], { type });
const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;
const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });
const clampProgress = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

class BatchCanceledError extends Error {
  constructor() {
    super(t("batch-pdf.batch.canceled.8d9616"));
    this.name = 'AbortError';
  }
}

const phaseLabel = (status: BatchItemStatus): string => {
  if (status.phase === 'processing') return `${formatPercent(status.progress)}`;
  if (status.phase === 'completed') return t("batch-pdf.completed.22a970");
  if (status.phase === 'failed') return t("batch-pdf.failed.031a8f");
  if (status.phase === 'canceled') return t("batch-pdf.canceled.13ca2e");
  return t('batch.queued');
};

const phaseClasses: Record<BatchItemPhase, string> = {
  queued: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
  processing: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-200',
  completed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200',
  failed: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-200',
  canceled: 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200',
};

export const BatchPDF: React.FC = () => {
  useI18n();
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
    if (!files.length) return t("batch-pdf.add.at.least.one.pdf.to.start.8ab537");
    if ((action === 'protect' || action === 'unlock') && password.length === 0) {
      return t("batch-pdf.enter.the.password.exactly.as.it.should.aae08d");
    }
    if (action === 'watermark' && watermark.trim().length === 0) return t("batch-pdf.enter.visible.watermark.text.7de701");
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
      setStatus({ ...idleStatus(), error: t("batch-pdf.choose.one.or.more.pdf.files.69411e") });
      return;
    }

    const merged = [...files, ...pdfs].filter((file, index, all) => (
      all.findIndex((candidate) => fileKey(candidate) === fileKey(file)) === index
    ));
    if (shouldWarnForFiles(merged) && !window.confirm(t("batch-pdf.these.pdfs.may.use.substantial.browser.memory.982c0c"))) return;

    const duplicateCount = pdfs.length - (merged.length - files.length);
    const noticeParts: string[] = [];
    if (skippedUnsupported > 0) noticeParts.push(t("batch-pdf.unsupported.file.skipped.8ac142", { count: skippedUnsupported }));
    if (duplicateCount > 0) noticeParts.push(t("batch-pdf.duplicate.skipped.90f0fe", { count: duplicateCount }));

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
        // Keep text selectable, as Compress PDF does by default.
        false,
        analysis.isTextHeavy,
      );
      checkCanceled();
      if (result.status !== 'success') throw new Error(t("batch-pdf.compression.was.blocked.by.the.readability.safety.99233a"));
      // Like Compress PDF: when the new copy is not smaller, the original is what is kept.
      if (result.data.length === 0 || result.data.length >= file.size) return { blob: file, filename: file.name };
      recordSavings(file.size, result.data.length);
      return { blob: bytesBlob(result.data), filename: toolOutputName('compress', file.name, 'pdf') };
    }
    if (action === 'split') {
      const result = finish(await splitPDFByPagesPerFile(file, pagesPerSplit));
      return { blob: result.blob, filename: toolOutputName('split', file.name, result.isArchive ? 'zip' : 'pdf') };
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
      return { blob: finish(blob), filename: toolOutputName('images', file.name, 'zip') };
    }
    if (action === 'pdf-to-word') return { blob: finish(await convertPDFToDocx(file)), filename: `${baseName(file.name)}.docx` };
    if (action === 'rotate') return { blob: bytesBlob(finish(await rotatePDF(file, rotation))), filename: toolOutputName('rotate', file.name, 'pdf') };
    if (action === 'protect') return { blob: bytesBlob(finish(await protectPDF(file, password))), filename: toolOutputName('protect', file.name, 'pdf') };
    if (action === 'unlock') return { blob: bytesBlob(finish(await unlockPDF(file, password))), filename: toolOutputName('unlock', file.name, 'pdf') };
    if (action === 'metadata') return { blob: bytesBlob(finish(await removePDFMetadata(file))), filename: toolOutputName('metadata', file.name, 'pdf') };
    if (action === 'flatten') return { blob: bytesBlob(finish(await flattenPDF(file))), filename: toolOutputName('flatten', file.name, 'pdf') };
    if (action === 'extract-text') return { blob: new Blob([finish(await extractTextFromPDF(file))], { type: 'text/plain' }), filename: `${baseName(file.name)}.txt` };
    if (action === 'watermark') {
      const bytes = finish(await addWatermarkToPDF(file, { text: watermark, size: 50, opacity: 0.3, rotation: -45, color: '#000000' }));
      return { blob: bytesBlob(bytes), filename: toolOutputName('watermark', file.name, 'pdf') };
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
        return { blob: bytesBlob(bytes), filename: toolOutputName('page-numbers', file.name, 'pdf') };
      } finally {
        if (numbered?.destroy) void numbered.destroy();
      }
    }
    return { blob: bytesBlob(finish(await repairPDF(file))), filename: toolOutputName('repair', file.name, 'pdf') };
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
    setStatus({ isProcessing: true, progress: 1, message: t("batch-pdf.starting.batch.ae96f9") });

    const zip = new JSZip();
    const archiveNames = new Set<string>(['failures.txt']);
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
              message: t("batch-pdf..192b74", { v0: selectedAction.label, v1: file.name, v2: index + 1, v3: files.length }),
            });
          }
        };

        updateProgress(0);
        try {
          const result = await processFile(file, updateProgress, () => cancelRequestedRef.current);
          if (cancelRequestedRef.current) throw new BatchCanceledError();
          zip.file(reserveArchiveName(result.filename, archiveNames), result.blob);
          completedCount += 1;
          setItemStatuses((current) => ({ ...current, [key]: { phase: 'completed', progress: 100 } }));
        } catch (error) {
          if (error instanceof BatchCanceledError || cancelRequestedRef.current) {
            setItemStatuses((current) => ({ ...current, [key]: { phase: 'canceled', progress: 0 } }));
            break;
          }
          const message = error instanceof Error ? localizeError(error) : t("batch-pdf.this.file.could.not.be.processed.skip.c11e2e");
          failures.push(`${file.name}: ${message}`);
          setItemStatuses((current) => ({ ...current, [key]: { phase: 'failed', progress: 0, message } }));
        } finally {
          // A finished file's PDF.js worker and bytes are released before the next file opens.
          await releasePDFDocument(file).catch(() => undefined);
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
          message: t("batch-pdf.canceled.after.of.files.no.zip.was.8f7cb1", { v0: completedCount, v1: files.length }),
        });
        return;
      }

      if (failures.length) zip.file('failures.txt', failures.join('\n'));
      if (failures.length === files.length) {
        setStatus({ ...idleStatus(), error: t("batch-pdf.all.files.failed.review.the.queue.for.943af6", { v0: files.length }) });
        return;
      }

      const archive = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        setStatus({ isProcessing: true, progress: 88 + Math.round(metadata.percent * 0.12), message: t("batch-pdf.packing.outputs.ae3157") });
      });
      if (cancelRequestedRef.current) {
        setStatus({
          isProcessing: false,
          progress: 0,
          message: t("batch-pdf.canceled.after.of.files.no.zip.was.8f7cb1", { v0: completedCount, v1: files.length }),
        });
        return;
      }
      const outputName = datedOutputName(t("tool-catalog.batch.processing.36bf5b"), 'zip');
      downloadBlob(archive, outputName, 'application/zip');
      setStatus({
        isProcessing: false,
        progress: 100,
        message: failures.length
          ? t("batch-pdf.created.with.outputs.and.failure.listed.in.44f091", { v0: outputName, v1: completedCount, count: failures.length })
          : t("batch-pdf.created.with.outputs.f2644b", { v0: outputName, v1: completedCount }),
      });
    } catch (error) {
      console.error(error);
      setStatus({ ...idleStatus(), error: t("batch-pdf.unable.to.create.the.batch.zip.review.146ef1") });
    } finally {
      setCancelPending(false);
    }
  };

  const cancelBatch = () => {
    if (!status.isProcessing || cancelPending) return;
    cancelRequestedRef.current = true;
    setCancelPending(true);
    setStatus((current) => ({ ...current, message: t("batch-pdf.canceling.after.the.current.file.step.52a454") }));
  };

  return (
    <ToolShell width="wide" centered={files.length === 0}>
      {/* Kept: the ZIP is the one thing the Operation control and the Process
          button do not say. */}
      <ToolHeader title={t("batch-pdf.batch.processing.36bf5b")} note={t("batch-pdf.every.result.is.returned.in.one.zip.5e9c36")} />

      <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
        <aside className="order-1 h-fit rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4 lg:order-1">
          {!status.isProcessing && (
            <div className="mb-3">
              {files.length > 0 ? (
                <label className="chef-target chef-pressable flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-field)] border border-dashed border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--accent-text)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]">
                  <Plus aria-hidden size={18} />{t("batch-pdf.add.pdfs.e2f591")}<input
                    type="file"
                    accept=".pdf,application/pdf"
                    multiple
                    aria-label={t("batch-pdf.add.pdfs.to.the.batch.c7745d")}
                    className="sr-only"
                    onChange={(event) => {
                      const picked = Array.from(event.target.files ?? []) as File[];
                      if (picked.length) addFiles(picked);
                      event.target.value = '';
                    }}
                  />
                </label>
              ) : (
                <FileUpload onFilesSelected={addFiles} accept=".pdf,application/pdf" multiple label={t("batch-pdf.add.pdfs.to.the.batch.c7745d")} />
              )}
            </div>
          )}
          <label className="block text-sm font-bold text-[var(--text-body)]">{t("batch-pdf.operation.0f044f")}<select
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
            <label className="mt-3 block text-sm font-bold text-[var(--text-body)]">{t("batch-pdf.pages.per.part.889bc1")}<input
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
            <label className="mt-3 block text-sm font-bold text-[var(--text-body)]">{t("batch-pdf.rotation.57b5e2")}<select
                value={rotation}
                onChange={(event) => {
                  clearRunFeedback();
                  setRotation(Number(event.target.value));
                }}
                disabled={status.isProcessing}
                className="chef-field mt-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value={90}>{t("batch-pdf.90.clockwise.999bed")}</option>
                <option value={180}>180°</option>
                <option value={270}>{t("batch-pdf.90.counter.clockwise.6e82c5")}</option>
              </select>
            </label>
          )}
          {(action === 'protect' || action === 'unlock') && (
            <label className="mt-3 block text-sm font-bold text-[var(--text-body)]">{t("batch-pdf.password.e7cf3e")}<input
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
              <span className="mt-1 block text-xs font-normal text-[var(--text-tertiary)]">{t("batch-pdf.spaces.are.preserved.exactly.876f4a")}</span>
            </label>
          )}
          {action === 'watermark' && (
            <label className="mt-3 block text-sm font-bold text-[var(--text-body)]">{t("batch-pdf.watermark.text.9429e8")}<input
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
                <span className="shrink-0 tabular-nums">{formatPercent(status.progress)}</span>
              </div>
              <div
                role="progressbar"
                aria-label={t("batch-pdf.batch.progress.17a0e5")}
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
            {status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <Files aria-hidden size={18} />}{t("batch-pdf.message.cc8a61d63f", { count: files.length })}</button>
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
              {cancelPending ? t("batch-pdf.canceling.7d0901") : t("batch-pdf.cancel.batch.db540a")}
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
                <h2 id="batch-queue-heading" className="text-sm font-bold text-[var(--text-primary)]">{t("batch-pdf.ordered.queue.0d6495")}</h2>
                <p className="type-footnote font-semibold text-[var(--text-secondary)]">{t("batch-pdf.message.ab18fb4c2c", { v2: formatBytes(totalSize), count: files.length })}</p>
              </div>
              <ol className="divide-y divide-[var(--border-hairline)] overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)]">
                {files.map((file, index) => {
                  const itemStatus: BatchItemStatus = itemStatuses[fileKey(file)] ?? { phase: 'queued', progress: 0 };
                  return (
                    <li key={fileKey(file)} className="p-2.5 sm:p-3">
                      <div className="flex items-start gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--accent-quiet)] text-sm font-bold text-[var(--accent-on-quiet)]">
                          {formatNumber(index + 1)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</p>
                          <p className="type-caption text-[var(--text-tertiary)]">{formatBytes(file.size)}</p>
                        </div>
                        <button
                          type="button"
                          aria-label={t("batch-pdf.remove.9fc927", { v0: file.name })}
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
                            aria-label={t("batch-pdf.move.up.6cabe2", { v0: file.name })}
                            title={t("batch-pdf.move.up.c66feb")}
                            onClick={() => moveFile(index, index - 1)}
                            disabled={status.isProcessing || index === 0}
                            className="chef-hit-y chef-pressable inline-flex h-11 w-touch items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-55"
                          >
                            <ArrowUp aria-hidden size={18} />
                          </button>
                          <button
                            type="button"
                            aria-label={t("batch-pdf.move.down.ab5f2b", { v0: file.name })}
                            title={t("batch-pdf.move.down.40bb50")}
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
                          aria-label={t("batch-pdf.progress.459332", { v0: file.name })}
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
