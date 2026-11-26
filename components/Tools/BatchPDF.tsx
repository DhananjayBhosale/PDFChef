import { formatPercent } from '../../services/i18n/core.ts';
import { pdfFailureMessage } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { reserveArchiveName } from '../../services/pdfToolResults';
import { Plus, Files, XCircle } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { StatusToast } from '../UI/StatusToast';
import { ClampedNumberInput } from '../UI/ClampedNumberInput';
import { ToolScreen } from '../Tool/ToolScreen';
import { Sentence, type SlotDef } from '../Tool/Sentence';
import { Notice, ProgressLine } from '../Tool/parts';
import { QueueGhost, QueueRow } from '../Tool/QueueRow';
import { useCanvasScroller } from '../Tool/useCanvasScroller';
import { useDragReorder } from '../../hooks/useDragReorder';
import { useFileDrop } from '../../hooks/useFileDrop';
import { quoted, clipLength } from '../Tool/values';
import { useWide } from '../../hooks/useMediaQuery';
import { addPageNumbersToPDF, addWatermarkToPDF, analyzePDF, compressPDFAdaptive, convertPDFToDocx, extractTextFromPDF, flattenPDF, loadJSZip, loadPDFDocument, needsOpenPassword, pdfFileProblem, protectPDF, releasePDFDocument, removePDFMetadata, renderPageAsImage, repairPDF, rotatePDF, splitPDFByPagesPerFile, unlockPDF } from '../../services/pdfLazy';
import { downloadBlob, revokeObjectUrl } from '../../services/pdfShared';
import { recordSavings } from '../../services/workspace';
import type { ProcessingStatus } from '../../types';
import { formatBytes, keptPdfName, toolOutputName, datedOutputName } from '../UI/format';
import { useRemembered } from '../Tool/useRemembered';

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
  const wide = useWide();
  const [files, setFiles] = useState<File[]>([]);
  const [action, setAction] = useRemembered<BatchAction>('operation', 'compress', (value) => actions.some((item) => item.value === value));
  const [password, setPassword] = useState('');
  const [pagesPerSplit, setPagesPerSplit] = useRemembered<number>('pagesPerPart', 1, (value) => Number.isSafeInteger(value) && value >= 1);
  const [rotation, setRotation] = useRemembered<number>('rotation', 90, (value) => value === 90 || value === 180 || value === 270);
  const [watermark, setWatermark] = useRemembered<string>('watermarkText', 'CONFIDENTIAL');
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus());
  const [itemStatuses, setItemStatuses] = useState<Record<string, BatchItemStatus>>({});
  const [selectionNotice, setSelectionNotice] = useState('');
  const operationRef = useRef<HTMLSelectElement>(null);
  const optionInputRef = useRef<HTMLInputElement>(null);
  const optionSelectRef = useRef<HTMLSelectElement>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const cancelRequestedRef = useRef(false);
  // Leaving the tool discards the files, as its question says, so a running job stops with it
  // (no result arrives after the person has left).
  useEffect(() => () => { cancelRequestedRef.current = true; }, []);
  // Unlock: which files ask for a password (true), open without one (false), or cannot be read
  // (null), so the sentence and each row say so (path to 9, part 2). Asked once per file.
  const [locks, setLocks] = useState<Record<string, boolean | null>>({});
  useEffect(() => {
    if (action !== 'unlock') return undefined;
    let stale = false;
    for (const file of files) {
      const key = fileKey(file);
      if (key in locks) continue;
      void needsOpenPassword(file).then((locked) => {
        if (!stale) setLocks((current) => (key in current ? current : { ...current, [key]: locked }));
      });
    }
    return () => { stale = true; };
    // `locks` is read, not watched: a new answer must not ask again for the files still pending.
  }, [action, files]);
  const unlockChecked = action === 'unlock' && files.length > 0 && files.every((file) => fileKey(file) in locks);
  // Every file opens without a password: Unlock only lifts their limits, and asks for no password.
  const noneLocked = unlockChecked && files.every((file) => locks[fileKey(file)] === false);
  // Some files are locked and some are not: the password is for the locked ones only.
  const lockedCount = files.filter((file) => locks[fileKey(file)] === true).length;
  const someLocked = unlockChecked && lockedCount > 0 && lockedCount < files.length;
  // Page counts come from the row thumbnails, as each first page is drawn.
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
  const selectedAction = useMemo(() => actions.find((item) => item.value === action)!, [action]);
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const validationMessage = useMemo(() => {
    if (!files.length) return t("batch-pdf.add.at.least.one.pdf.to.start.8ab537");
    if ((action === 'protect' || (action === 'unlock' && !noneLocked)) && password.length === 0) {
      return t("batch-pdf.enter.the.password.exactly.as.it.should.aae08d");
    }
    // Protect PDF's own rules and words (s3-05): a password it would refuse fails every file here.
    if (action === 'protect' && !/\S/.test(password)) return t("security-pdf.password.is.required.to.protect.a.pdf.5153a4");
    if (action === 'protect' && password.length < 4) return t("security-pdf.at.least.4.characters.with.spaces.preserved.e0bf40");
    if (action === 'watermark' && watermark.trim().length === 0) return t("batch-pdf.enter.visible.watermark.text.7de701");
    // Whole pages only: 1.5 would split into one-page parts (s3-04). The existing Split wording.
    if (action === 'split' && !(Number.isSafeInteger(pagesPerSplit) && pagesPerSplit >= 1)) return t("split-pdf.pages.per.file.must.be.a.positive.85ff63");
    return '';
  }, [action, files.length, noneLocked, pagesPerSplit, password, watermark]);

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

  const scroller = useCanvasScroller();
  const { activeId, dragHandlers, registerItem, overlayStyle } = useDragReorder<File>({
    scrollContainerRef: scroller.ref,
    items: files,
    onReorder: (next) => {
      if (status.isProcessing) return;
      setFiles(next);
      clearRunFeedback();
    },
    keyExtractor: fileKey,
  });
  const draggedFile = files.find((file) => fileKey(file) === activeId);

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
      if (result.data.length === 0 || result.data.length >= file.size) return { blob: file, filename: keptPdfName(file.name) };
      recordSavings(file.size, result.data.length);
      return { blob: bytesBlob(result.data), filename: toolOutputName('compress', file.name, 'pdf') };
    }
    if (action === 'split') {
      const result = finish(await splitPDFByPagesPerFile(file, pagesPerSplit));
      return { blob: result.blob, filename: toolOutputName('split', file.name, result.isArchive ? 'zip' : 'pdf') };
    }
    if (action === 'pdf-to-image') {
      const pdf = await loadPDFDocument(file);
      const zip = new (await loadJSZip())();
      for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
        checkCanceled();
        const rendered = await renderPageAsImage(pdf, pageIndex, { format: 'image/jpeg', quality: 0.88, scale: 1.5 }, { fullSize: true });
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
    // A file that opens without a password only has its limits lifted, as Unlock PDF does.
    if (action === 'unlock') return { blob: bytesBlob(finish(await unlockPDF(file, locks[fileKey(file)] === false ? '' : password))), filename: toolOutputName('unlock', file.name, 'pdf') };
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

    const zip = new (await loadJSZip())();
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
          // A file problem in words (locked, not a PDF, unreadable), this app's own message, or the
          // queue's fallback: never the PDF engine's raw error text (round 6, desktop-02).
          // A job that fails on a locked file (Protect PDF on one, h4 F4) is told to unlock it, not
          // to run Repair PDF, which would only say the same.
          const message = await pdfFileProblem(file, error).catch(() => null)
            ?? pdfFailureMessage(error, t("batch-pdf.this.file.could.not.be.processed.skip.c11e2e"));
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

  const title = t("batch-pdf.batch.processing.36bf5b");
  const toast = <StatusToast status={status} />;
  const queueEmpty = files.length === 0;
  const hasOption = action === 'split' || action === 'rotate' || action === 'protect' || action === 'unlock' || action === 'watermark';
  const rotationText = rotation === 180 ? '180°' : rotation === 270 ? t("batch-pdf.90.counter.clockwise.6e82c5") : t("batch-pdf.90.clockwise.999bed");

  // Today's Operation select and its option field, on the screen at rest (owner decision 1,
  // B-013): under the sentence in the foot sheet on phones, in the band on desktop. The
  // sentence reads the choice back in plain words. The detail line and the
  // password rule are visible again (decision 4, B-014).
  const operationControl = (
    <>
      <label className="tk-field">
        <span>{t("batch-pdf.operation.0f044f")}</span>
        <select
          ref={operationRef}
          value={action}
          onChange={(event) => {
            setAction(event.target.value as BatchAction);
            clearRunFeedback();
          }}
          disabled={status.isProcessing}
          aria-describedby={selectedAction.detail ? 'batch-operation-detail' : undefined}
          className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
        >
          {actions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      {selectedAction.detail && <p id="batch-operation-detail" className="tk-caution tk-batch-detail">{selectedAction.detail}</p>}
    </>
  );

  const optionControl = action === 'split' ? (
    <label className="tk-field">
      <span>{t("batch-pdf.pages.per.part.889bc1")}</span>
      <ClampedNumberInput
        ref={optionInputRef}
        min={1}
        max={1000}
        inputMode="numeric"
        value={pagesPerSplit}
        onCommit={(next) => {
          clearRunFeedback();
          setPagesPerSplit(next);
        }}
        disabled={status.isProcessing}
        className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  ) : action === 'rotate' ? (
    <label className="tk-field">
      <span>{t("batch-pdf.rotation.57b5e2")}</span>
      <select
        ref={optionSelectRef}
        value={rotation}
        onChange={(event) => {
          clearRunFeedback();
          setRotation(Number(event.target.value));
        }}
        disabled={status.isProcessing}
        className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value={90}>{t("batch-pdf.90.clockwise.999bed")}</option>
        <option value={180}>180°</option>
        <option value={270}>{t("batch-pdf.90.counter.clockwise.6e82c5")}</option>
      </select>
    </label>
  ) : (action === 'protect' || action === 'unlock') ? (
    <label className="tk-field">
      <span>{t("batch-pdf.password.e7cf3e")}</span>
      <input
        ref={optionInputRef}
        type="password"
        value={password}
        onChange={(event) => {
          clearRunFeedback();
          setPassword(event.target.value);
        }}
        autoComplete="new-password"
        aria-describedby="batch-password-hint"
        disabled={status.isProcessing}
        className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span id="batch-password-hint" className="tk-caution">{t("batch-pdf.spaces.are.preserved.exactly.876f4a")}</span>
    </label>
  ) : action === 'watermark' ? (
    <label className="tk-field">
      <span>{t("batch-pdf.watermark.text.9429e8")}</span>
      <input
        ref={optionInputRef}
        value={watermark}
        onChange={(event) => {
          clearRunFeedback();
          setWatermark(event.target.value);
        }}
        disabled={status.isProcessing}
        className="chef-field disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  ) : null;

  // The option's value in the sentence (the password is never shown). Desktop: plain words, like
  // the operation; the field itself is on screen under the sentence, the one place to change it.
  // Phone: the value opens a card that holds the field, so the setting shows once (owner decision
  // 2026-11-15, item 1).
  const optionSlot = (): SlotDef | null => {
    if (!optionControl) return null;
    const base: Partial<SlotDef> = wide ? { static: true } : { editor: optionControl, showTitle: false };
    if (action === 'split') return { ...base, label: t("batch-pdf.pages.per.part.889bc1"), text: t('sentence.batch.option.split', { count: pagesPerSplit }) };
    if (action === 'rotate') return { ...base, label: t("batch-pdf.rotation.57b5e2"), text: rotationText };
    // No file here needs a password: the sentence does not say "with a password".
    if (action === 'unlock' && noneLocked) return null;
    if (action === 'watermark') {
      const empty = watermark.trim().length === 0;
      return {
        ...base,
        label: t("batch-pdf.watermark.text.9429e8"),
        text: empty ? t('sentence.batch.option.watermark.unset') : quoted(watermark.trim(), clipLength(wide)),
        tone: empty ? 'error' : undefined,
      };
    }
    const empty = password.length === 0;
    return {
      ...base,
      label: t("batch-pdf.password.e7cf3e"),
      text: empty
        ? t('sentence.batch.option.password.unset')
        : someLocked
          ? t('sentence.batch.option.password.forLocked', { count: lockedCount })
          : t('sentence.batch.option.password.set'),
      tone: empty ? 'error' : undefined,
    };
  };

  // Desktop: the sentence reads the choice back as plain words; the Operation select under it is
  // the one place it is chosen (polish item 5). Phone: the operation opens a card with the select
  // (and the option's field when the sentence has no slot for it).
  const option = optionSlot();
  const operationSlot: SlotDef = {
    label: t("batch-pdf.operation.0f044f"),
    text: selectedAction.label,
    ...(wide ? { static: true } : {
      editor: (
        <div className="tk-batch-settings">
          <div className="tk-batch-setting">{operationControl}</div>
          {optionControl && !(option && !queueEmpty) && <div className="tk-batch-setting">{optionControl}</div>}
        </div>
      ),
      showTitle: false,
    }),
  };
  const settings = (
    <div className="tk-batch-settings" data-option={hasOption ? '' : undefined}>
      <div className="tk-batch-setting">{operationControl}</div>
      {optionControl && <div className="tk-batch-setting">{optionControl}</div>}
    </div>
  );

  const sentence = (
    <Sentence
      // A turn reads as one ("…, turning each 90° clockwise."), not "with 90° clockwise" (review 2, item 17).
      template={queueEmpty ? 'sentence.batch.empty' : option ? (action === 'rotate' ? 'sentence.batch.rotate' : 'sentence.batch.withOption') : 'sentence.batch.plain'}
      values={{ files: t('sentence.batch.files', { count: files.length || 1 }) }}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      slots={queueEmpty || !option ? { operation: operationSlot } : { operation: operationSlot, option }}
    />
  );

  // One line, the first that applies (D10): a failed run, a canceled run (no ZIP, so no
  // result strip to carry it), today's validation, the skipped-files line, the ZIP line.
  // A finished run's summary is the result strip's line (owner decision 2).
  const notice = !status.isProcessing && status.error
    ? <Notice tone="error" role="alert">{status.error}</Notice>
    : !status.isProcessing && status.message && status.progress !== 100
      ? <Notice tone="caution" role="status">{status.message}</Notice>
    : !status.isProcessing && validationMessage && files.length > 0
    // Today shows the skipped-files line and the validation together; keep both.
    ? <Notice tone="caution">{validationMessage}{selectionNotice && <><br />{selectionNotice}</>}</Notice>
    : selectionNotice
      ? <Notice tone="caution" role="status">{selectionNotice}</Notice>
      : <Notice>{t("batch-pdf.every.result.is.returned.in.one.zip.5e9c36")}</Notice>;

  const runLabel = (
    <>
      <Files aria-hidden size={18} />
      <span>{t("batch-pdf.message.cc8a61d63f", { count: files.length })}</span>
    </>
  );

  const progress = status.isProcessing ? (
    <ProgressLine
      label={status.message}
      percent={formatPercent(status.progress)}
      value={clampProgress(status.progress)}
      cancel={(
        <button
          type="button"
          onClick={cancelBatch}
          disabled={cancelPending}
          className="tk-btn chef-pressable"
        >
          <XCircle aria-hidden size={16} />
          {cancelPending ? t("batch-pdf.canceling.7d0901") : t("batch-pdf.cancel.batch.db540a")}
        </button>
      )}
    />
  ) : undefined;

  // A file dropped on the loaded list joins it (research r3, desktop-01).
  useFileDrop({ accept: queueEmpty ? '' : '.pdf,application/pdf', onFiles: addFiles });

  if (queueEmpty) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={addFiles} accept=".pdf,application/pdf" multiple label={t("batch-pdf.add.pdfs.to.the.batch.c7745d")} />
          </div>
        )}
        sentence={sentence}
        chips={wide ? settings : undefined}
        notice={notice}
        onRun={() => void runBatch()}
        runDisabled={status.isProcessing || Boolean(validationMessage)}
        runLabel={runLabel}
        toast={toast}
      />
    );
  }

  const body = (
    <div ref={scroller.attach} aria-busy={status.isProcessing} className="select-none">
      <section aria-labelledby="batch-queue-heading">
        {/* "Files run from top to bottom" is what a numbered queue with
            move-up and move-down controls already shows. */}
        <div className="tk-listhead tk-listhead-batch mb-2 flex-wrap">
          <div className="min-w-0">
            <h2 id="batch-queue-heading" className="text-sm font-bold text-[var(--text-primary)]">{t("batch-pdf.ordered.queue.0d6495")}</h2>
            <p className="type-footnote font-semibold text-[var(--text-secondary)]">{t("batch-pdf.message.ab18fb4c2c", { v2: formatBytes(totalSize), count: files.length })}</p>
          </div>
          {/* The one "Add PDFs": the head of the queue stays at the top however long it is (B-015, T-12). */}
          {!status.isProcessing && (
            <label className="tk-btn tk-add-btn chef-pressable cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]">
              <Plus aria-hidden size={16} />{t("batch-pdf.add.pdfs.e2f591")}<input
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
          )}
        </div>
        <ol className="tk-queue" aria-labelledby="batch-queue-heading">
          {files.map((file, index) => {
            const key = fileKey(file);
            const itemStatus: BatchItemStatus = itemStatuses[key] ?? { phase: 'queued', progress: 0 };
            const pages = pageCounts[key];
            return (
              <QueueRow
                key={key}
                roomy={files.length <= 3}
                file={file}
                name={file.name}
                index={index}
                total={files.length}
                meta={(
                  <>
                    {pages ? <span>{t("merge-pdf..24a420", { count: pages })} ·</span> : null}
                    <span>{formatBytes(file.size)}</span>
                    {/* Unlock: whether this file asks for a password at all. */}
                    {action === 'unlock' && typeof locks[key] === 'boolean' && (
                      <span className={`tk-qrow-phase ${phaseClasses.queued}`}>{locks[key] ? t('batch.unlock.locked') : t('batch.unlock.noPassword')}</span>
                    )}
                    {/* At rest every file waits, which the queue already says; the phase shows once a run starts. */}
                    {(itemStatus.phase !== 'queued' || status.isProcessing) && (
                      <span className={`tk-qrow-phase ${phaseClasses[itemStatus.phase]}`} aria-live={itemStatus.phase === 'processing' ? 'polite' : undefined}>
                        {phaseLabel(itemStatus)}
                      </span>
                    )}
                  </>
                )}
                busy={status.isProcessing}
                dragging={activeId === key}
                rowRef={(element) => registerItem(key, element)}
                onGrab={(event) => dragHandlers.onPointerDown(event, key)}
                onMove={(direction) => moveFile(index, index + direction)}
                onRemove={() => removeFile(file)}
                onPages={(count) => setPageCounts((current) => (current[key] === count ? current : { ...current, [key]: count }))}
                labels={{
                  drag: t("merge-pdf.drag.to.reorder.781049", { v0: file.name }),
                  up: t("batch-pdf.move.up.6cabe2", { v0: file.name }),
                  down: t("batch-pdf.move.down.ab5f2b", { v0: file.name }),
                  remove: t("batch-pdf.remove.9fc927", { v0: file.name }),
                  upTip: t("batch-pdf.move.up.c66feb"),
                  downTip: t("batch-pdf.move.down.40bb50"),
                  removeTip: t("merge-pdf.remove.caa0ce").trim(),
                }}
              >
                {itemStatus.phase === 'processing' && (
                  <div
                    role="progressbar"
                    aria-label={t("batch-pdf.progress.459332", { v0: file.name })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={itemStatus.progress}
                    className="tk-qrow-below h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]"
                  >
                    <div className="h-full rounded-full bg-[var(--accent-rest)] transition-[width]" style={{ width: `${itemStatus.progress}%` }} />
                  </div>
                )}
                {itemStatus.phase === 'failed' && itemStatus.message && (
                  <p role="alert" className="tk-qrow-below break-words text-sm font-medium text-[var(--status-danger-text)]">{itemStatus.message}</p>
                )}
              </QueueRow>
            );
          })}
        </ol>
      </section>
    </div>
  );

  return (
    <>
      <ToolScreen
        title={title}
        kind="list"
        heavyJob={{ bytes: files.reduce((sum, item) => sum + item.size, 0), files: files.length }}
        body={body}
        sentence={sentence}
        chips={wide ? settings : undefined}
        notice={notice}
        onRun={() => void runBatch()}
        runDisabled={status.isProcessing || Boolean(validationMessage)}
        runLabel={runLabel}
        progress={progress}
        toast={toast}
      />
      {draggedFile && <QueueGhost name={draggedFile.name} style={overlayStyle} />}
    </>
  );
};
