import { formatPercent, formatNumber } from '../../services/i18n/core.ts';
import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { Plus, ArrowDown, ArrowUp, Download, GripVertical, Loader2, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { createPortal } from 'react-dom';
import { useDragReorder } from '../../hooks/useDragReorder';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { formatBytes, datedOutputName } from '../UI/format';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const MergePDF: React.FC = () => {
  useI18n();
  const [files, setFiles] = useState<PDFFile[]>([]);
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const [isPreflighting, setIsPreflighting] = useState(false);
  const activeMergeRef = useRef<AbortController | null>(null);
  const preflightActiveRef = useRef(false);
  const preflightGenerationRef = useRef(0);

  useEffect(() => () => {
    activeMergeRef.current?.abort();
    preflightGenerationRef.current += 1;
  }, []);

  const { activeId, dragHandlers, registerItem, overlayStyle } = useDragReorder<PDFFile>({
    items: files,
    onReorder: setFiles,
    keyExtractor: (file) => file.id,
  });

  const handleFilesSelected = async (newFiles: File[]) => {
    if (status.isProcessing || activeMergeRef.current || preflightActiveRef.current) return;
    const pdfs = newFiles.filter(isPdfFile);
    if (pdfs.length === 0) {
      setStatus({ ...idleStatus(), error: t("merge-pdf.choose.one.or.more.pdf.files.69411e") });
      return;
    }

    setStatus(idleStatus());
    const generation = preflightGenerationRef.current + 1;
    preflightGenerationRef.current = generation;
    preflightActiveRef.current = true;
    setIsPreflighting(true);
    try {
      const { getPDFPageCount } = await import('../../services/pdfDocument');
      const mappedFiles: PDFFile[] = [];
      for (let start = 0; start < pdfs.length; start += 2) {
        if (preflightGenerationRef.current !== generation) break;
        const batch = await Promise.all(
          pdfs.slice(start, start + 2).map(async (file) => {
            let pageCount: number | undefined;
            try {
              pageCount = await getPDFPageCount(file);
            } catch {
              // The merge processor will surface the useful document error. The queue can still show the file.
            }
            return {
              id: uuidv4(),
              file,
              name: file.name,
              size: file.size,
              pageCount,
            };
          }),
        );
        mappedFiles.push(...batch);
      }

      if (preflightGenerationRef.current === generation) {
        setFiles((current) => [...current, ...mappedFiles]);
      }
    } finally {
      preflightActiveRef.current = false;
      setIsPreflighting(false);
    }
  };

  const removeFile = (id: string) => {
    if (status.isProcessing) return;
    setFiles((current) => current.filter((file) => file.id !== id));
  };

  const clearFiles = () => {
    if (status.isProcessing) return;
    preflightGenerationRef.current += 1;
    setFiles([]);
    setStatus(idleStatus());
  };

  const moveFile = (index: number, direction: -1 | 1) => {
    if (status.isProcessing) return;
    setFiles((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const reordered = [...current];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(target, 0, moved);
      return reordered;
    });
  };

  const cancelMerge = () => {
    const controller = activeMergeRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setStatus((current) => ({
      ...current,
      isProcessing: true,
      message: t("merge-pdf.cancelling.merge.f2a550"),
    }));
  };

  const handleMerge = async () => {
    if (files.length < 2 || status.isProcessing || activeMergeRef.current || preflightActiveRef.current) {
      if (files.length < 2) {
        setStatus({ ...idleStatus(), error: t("merge-pdf.add.at.least.two.pdfs.before.merging.6daff4") });
      }
      return;
    }

    const controller = new AbortController();
    activeMergeRef.current = controller;
    const queuedFiles = [...files];
    setStatus({
      isProcessing: true,
      progress: 15,
      message: t("merge-pdf.combining.pdfs.on.this.device.5dd600", { v0: queuedFiles.length }),
    });

    try {
      const { mergePDFs } = await import('../../services/pdfDocument');
      const mergedPdfBytes = await mergePDFs(
        queuedFiles.map((file) => file.file),
        controller.signal,
      );
      if (controller.signal.aborted || activeMergeRef.current !== controller) return;

      setStatus({ isProcessing: true, progress: 95, message: t("merge-pdf.preparing.the.merged.pdf.b21792") });
      downloadBlob(
        new Blob([mergedPdfBytes], { type: 'application/pdf' }),
        datedOutputName(t("tool-catalog.merge.pdf.566bfc"), 'pdf'),
      );
      setStatus({
        isProcessing: false,
        progress: 100,
        message: t("merge-pdf.merged.pdfs.f1f5c3", { v0: queuedFiles.length }),
      });
    } catch (error) {
      if (activeMergeRef.current !== controller) return;
      if (controller.signal.aborted) {
        setStatus({ ...idleStatus(), message: t("merge-pdf.merge.cancelled.e6032c") });
        return;
      }
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error && error.message ? localizeError(error) : t("merge-pdf.merge.failed.b356f1"),
      });
    } finally {
      if (activeMergeRef.current === controller) {
        activeMergeRef.current = null;
      }
    }
  };

  const activeItem = files.find((file) => file.id === activeId);
  const remainingCount = Math.max(0, 2 - files.length);

  return (
    <ToolShell width="list" centered={files.length === 0} className="select-none">

      {/* The queue header and the action row both state the merge order; the
          title does not need to be the third place that says it. */}
      <ToolHeader title={t("merge-pdf.merge.pdf.566bfc")} />

      {!status.isProcessing && (
        files.length > 0 ? (
          <label className="chef-target chef-pressable flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-field)] border border-dashed border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--accent-text)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]">
            <Plus aria-hidden size={18} />{t("merge-pdf.add.pdfs.e2f591")}<input
              type="file"
              accept=".pdf"
              multiple
              disabled={isPreflighting}
              aria-label={t("merge-pdf.add.more.pdfs.to.merge.1b5087")}
              className="sr-only"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []) as File[];
                if (picked.length) handleFilesSelected(picked);
                event.target.value = '';
              }}
            />
          </label>
        ) : (
          <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" multiple label={t("merge-pdf.choose.pdfs.to.merge.4f5354")} />
        )
      )}

      <AnimatePresence>
        {files.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-3 space-y-2.5"
          >
            {/* The "add one more file" card is gone: this count is the live
                region that states what is still required, and the export
                button under it is disabled until the count is met. */}
            <div className="flex items-center justify-between gap-3 px-1 text-sm text-[var(--text-secondary)]">
              <p role="status" aria-live="polite" className="min-w-0">
                {remainingCount > 0
                  ? t("merge-pdf.of.2.required.more.5d8410", { v0: files.length, count: remainingCount })
                  : t("merge-pdf.files.in.merge.order.be289e", { v0: files.length })}
              </p>
              <button
                type="button"
                onClick={clearFiles}
                disabled={status.isProcessing}
                className="chef-hit-y min-h-11 shrink-0 rounded-[var(--radius-control)] px-3 font-medium text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-55 dark:hover:bg-rose-950/30"
              >{t("merge-pdf.clear.all.29a390")}</button>
            </div>

            {/* In flow, above the queue it acts on. A sticky bar here covered
                the last file card and fought the tab bar for the same strip. */}
            <button
              type="button"
              onClick={handleMerge}
              disabled={files.length < 2 || status.isProcessing || isPreflighting}
              className="chef-target chef-pressable flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-5 font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <Download aria-hidden size={18} />}
              <span>{t("merge-pdf.save.the.combined.pdf.b53124")}</span>
            </button>

            <div className="relative space-y-2" aria-label={t("merge-pdf.pdf.merge.order.a4787c")}>
              {files.map((file, index) => (
                <div
                  key={file.id}
                  ref={(element) => registerItem(file.id, element)}
                  className={`rounded-[var(--radius-row)] border bg-[var(--surface-raised)] p-2.5 transition-colors ${
                    activeId === file.id
                      ? 'border-[var(--accent-rest)] opacity-30'
                      : 'border-[var(--border-hairline)]'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    {/* The badge is the position; the duplicate file glyph beside
                        it carried no information the row did not already have. */}
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-blue-50 text-sm font-bold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                      {formatNumber(index + 1)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="chef-filename text-sm font-semibold text-[var(--text-body)]">{file.name}</p>
                      <p className="type-caption text-[var(--text-tertiary)]">
                        {file.pageCount == null ? t("merge-pdf.pages.unavailable.7909b1") : t("merge-pdf..24a420", { count: file.pageCount })} · {formatBytes(file.size)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onPointerDown={(event) => dragHandlers.onPointerDown(event, file.id)}
                      disabled={status.isProcessing}
                      aria-label={t("merge-pdf.drag.to.reorder.781049", { v0: file.name })}
                      className="chef-hit-y grid h-11 w-11 shrink-0 touch-none place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      <GripVertical aria-hidden size={18} />
                    </button>
                  </div>

                  <div className="mt-2 grid grid-cols-3 gap-2 border-t border-[var(--border-hairline)] pt-2">
                    <button
                      type="button"
                      onClick={() => moveFile(index, -1)}
                      disabled={status.isProcessing || index === 0}
                      aria-label={t("merge-pdf.move.up.6cabe2", { v0: file.name })}
                      className="chef-hit-y flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent-rest)] disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      <ArrowUp aria-hidden size={18} />{t("merge-pdf.up.7358d1")}</button>
                    <button
                      type="button"
                      onClick={() => moveFile(index, 1)}
                      disabled={status.isProcessing || index === files.length - 1}
                      aria-label={t("merge-pdf.move.down.ab5f2b", { v0: file.name })}
                      className="chef-hit-y flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent-rest)] disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      <ArrowDown aria-hidden size={18} />{t("merge-pdf.down.c7d31c")}</button>
                    <button
                      type="button"
                      onClick={() => removeFile(file.id)}
                      disabled={status.isProcessing}
                      aria-label={t("merge-pdf.remove.from.merge.e82fdf", { v0: file.name })}
                      className="chef-hit-y flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--status-danger-text)] px-2 text-sm font-medium text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)] disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      <X aria-hidden size={18} />{t("merge-pdf.remove.caa0ce")}</button>
                  </div>
                </div>
              ))}
            </div>

            {status.isProcessing && (
              <div role="status" aria-live="polite" className="rounded-[var(--radius-field)] border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
                <div className="flex items-center gap-3 text-blue-950 dark:text-blue-100">
                  <Loader2 aria-hidden className="animate-spin" size={22} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{t("merge-pdf.processing.your.pdf.b14adc")}</p>
                    <p className="truncate text-sm opacity-80">{status.message}</p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{formatPercent(status.progress)}</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950">
                  <div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${status.progress}%` }} />
                </div>
                <button
                  type="button"
                  onClick={cancelMerge}
                  disabled={activeMergeRef.current?.signal.aborted}
                  className="mt-3 min-h-11 w-full rounded-lg border border-blue-300 px-4 text-sm font-semibold text-blue-800 hover:bg-blue-100 dark:border-blue-800 dark:text-blue-200 dark:hover:bg-blue-950"
                >
                  {activeMergeRef.current?.signal.aborted ? t("merge-pdf.cancelling.7b2613") : t("merge-pdf.cancel.19766e")}
                </button>
              </div>
            )}

          </motion.div>
        )}
      </AnimatePresence>


      {activeId && activeItem && createPortal(
        <div
          className="pointer-events-none fixed z-50 flex items-center gap-3 rounded-[var(--radius-row)] border-2 border-[var(--accent-rest)] bg-[var(--surface-raised)] p-3 shadow-[var(--elevation-sheet)]"
          style={{
            top: overlayStyle.top,
            left: overlayStyle.left,
            width: overlayStyle.width,
            height: overlayStyle.height,
            transform: 'scale(1.02)',
          }}
        >
          <GripVertical aria-hidden className="text-[var(--text-tertiary)]" />
          <span className="truncate font-medium text-[var(--text-body)]">{activeItem.name}</span>
        </div>,
        document.body,
      )}

      <StatusToast status={status} />
    </ToolShell>
  );
};
