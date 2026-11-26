import { formatNumber, formatPercent } from '../../services/i18n/core.ts';
import { classifyPdfError, localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { Plus, Download } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useDragReorder } from '../../hooks/useDragReorder';
import { useFileDrop } from '../../hooks/useFileDrop';
import { StatusToast } from '../UI/StatusToast';
import { ToolScreen } from '../Tool/ToolScreen';
import { Sentence } from '../Tool/Sentence';
import { useCloseEditor } from '../Tool/Popover';
import { Notice, ProgressLine } from '../Tool/parts';
import { QueueGhost, QueueRow } from '../Tool/QueueRow';
import { useCanvasScroller } from '../Tool/useCanvasScroller';
import { formatBytes, datedOutputName } from '../UI/format';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

/**
 * The files slot's card (owner decision 2026-11-24, Merge option 1): the files in merge order, each
 * with Up, Down and Remove in words. The list on the screen stays as it is.
 */
const MergeOrder: React.FC<{
  files: Array<{ id: string; name: string }>;
  busy: boolean;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
}> = ({ files, busy, onMove, onRemove }) => {
  const close = useCloseEditor();
  // A move to the first or last place disables the button just pressed: focus goes to the other one.
  const move = (event: React.MouseEvent<HTMLButtonElement>, index: number, direction: -1 | 1) => {
    const row = event.currentTarget.closest('li');
    const edge = direction < 0 ? index - 1 === 0 : index + 1 === files.length - 1;
    onMove(index, direction);
    if (edge) requestAnimationFrame(() => row?.querySelector<HTMLButtonElement>(`[data-move="${direction < 0 ? 'down' : 'up'}"]`)?.focus());
  };
  return (
    <ol className="tk-order" aria-label={t("merge-pdf.pdf.merge.order.a4787c")}>
      {files.map((file, index) => (
        <li key={file.id} className="tk-order-row">
          <span aria-hidden className="tk-order-pos tabular">{formatNumber(index + 1)}</span>
          <bdi className="tk-order-name" title={file.name}>{file.name}</bdi>
          <span className="tk-order-btns">
            <button type="button" data-move="up" onClick={(event) => move(event, index, -1)} disabled={busy || index === 0} aria-label={t("merge-pdf.move.up.6cabe2", { v0: file.name })} className="tk-btn chef-pressable">{t("merge-pdf.up.7358d1").trim()}</button>
            <button type="button" data-move="down" onClick={(event) => move(event, index, 1)} disabled={busy || index === files.length - 1} aria-label={t("merge-pdf.move.down.ab5f2b", { v0: file.name })} className="tk-btn chef-pressable">{t("merge-pdf.down.c7d31c").trim()}</button>
            <button
              type="button"
              onClick={() => {
                // Down to one file the sentence has no files slot: the card closes first.
                if (files.length <= 2) close?.();
                onRemove(file.id);
              }}
              disabled={busy}
              aria-label={t("merge-pdf.remove.from.merge.e82fdf", { v0: file.name })}
              className="tk-btn tk-btn-danger chef-pressable"
            >{t("merge-pdf.remove.caa0ce").trim()}</button>
          </span>
        </li>
      ))}
    </ol>
  );
};

/** A queued PDF; `locked` when it needs a password, found as it is added (pass 5, item 9). */
type MergeFile = PDFFile & { locked?: boolean };

export const MergePDF: React.FC = () => {
  useI18n();
  const [files, setFiles] = useState<MergeFile[]>([]);
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const [isPreflighting, setIsPreflighting] = useState(false);
  const activeMergeRef = useRef<AbortController | null>(null);
  const preflightActiveRef = useRef(false);
  const preflightGenerationRef = useRef(0);

  useEffect(() => () => {
    activeMergeRef.current?.abort();
    preflightGenerationRef.current += 1;
  }, []);

  const scroller = useCanvasScroller();
  const { activeId, dragHandlers, registerItem, overlayStyle } = useDragReorder<MergeFile>({
    scrollContainerRef: scroller.ref,
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
      const mappedFiles: MergeFile[] = [];
      for (let start = 0; start < pdfs.length; start += 2) {
        if (preflightGenerationRef.current !== generation) break;
        const batch = await Promise.all(
          pdfs.slice(start, start + 2).map(async (file) => {
            let pageCount: number | undefined;
            let locked = false;
            try {
              pageCount = await getPDFPageCount(file);
            } catch (error) {
              // A locked file is said on its row and in the notice line now, not only after Merge is
              // pressed. Other problems: the merge surfaces the useful document error.
              locked = classifyPdfError(error) === 'locked';
            }
            return {
              id: uuidv4(),
              file,
              name: file.name,
              size: file.size,
              pageCount,
              locked,
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
  const lockedFile = files.find((file) => file.locked);
  const title = t("merge-pdf.merge.pdf.566bfc");
  const toast = <StatusToast status={status} />;

  // A file dropped on the loaded list joins it (research r3, desktop-01).
  useFileDrop({ accept: files.length ? '.pdf' : '', onFiles: handleFilesSelected });

  if (files.length === 0) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" multiple label={t("merge-pdf.choose.pdfs.to.merge.4f5354")} />
          </div>
        )}
        toast={toast}
      />
    );
  }

  // "N files" is a slot whose card lists the files in order (owner decision 2026-11-24). With a
  // locked file the sentence says what must happen first (review 2, item 8); the notice stays.
  const orderLabel = t("merge-pdf.pdf.merge.order.a4787c");
  const sentence = files.length < 2 ? (
    <Sentence template="sentence.merge.needMore" groupLabel={t('sentence.groupLabel', { tool: title })} />
  ) : (
    <Sentence
      template={lockedFile ? 'sentence.merge.locked' : 'sentence.merge.order'}
      values={{ count: files.length, ...(lockedFile ? { name: lockedFile.name } : {}) }}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      slots={{
        files: {
          label: orderLabel,
          text: t('sentence.merge.files', { count: files.length }),
          editor: <MergeOrder files={files} busy={status.isProcessing} onMove={moveFile} onRemove={removeFile} />,
        },
      }}
    />
  );

  const runLabel = (
    <>
      <Download aria-hidden size={18} />
      <span>{t("merge-pdf.save.the.combined.pdf.b53124")}</span>
    </>
  );

  // The one "Add PDFs" (B-004, T-12): a chip under the sentence, above the main action at the foot,
  // in reach of the thumb (owner, 26 Nov 2026). Not while a merge runs.
  const addPdfs = !status.isProcessing && (
    <label className="tk-chip tk-add-btn chef-pressable cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]">
      <Plus aria-hidden size={16} />{t("merge-pdf.add.pdfs.e2f591")}<input
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
  );

  const progress = status.isProcessing ? (
    <ProgressLine
      label={t("merge-pdf.processing.your.pdf.b14adc")}
      detail={status.message}
      percent={formatPercent(status.progress)}
      value={status.progress}
      cancel={(
        <button
          type="button"
          onClick={cancelMerge}
          disabled={activeMergeRef.current?.signal.aborted}
          className="tk-btn chef-pressable"
        >
          {activeMergeRef.current?.signal.aborted ? t("merge-pdf.cancelling.7b2613") : t("merge-pdf.cancel.19766e")}
        </button>
      )}
    />
  ) : undefined;

  const body = (
    <div ref={scroller.attach} className="tk-list select-none">
      <h2 id="merge-queue-heading" className="sr-only">{title}</h2>
      <div className="tk-listhead">
        {/* This count is a live region. It is the count only, so it shares one row with Clear all
            (review 2, item 9): the order is the sentence's, which is spoken too (pass 5, item 9). */}
        <p role="status" aria-live="polite" className="min-w-0">
          {t('format.pdfCount', { count: files.length })}
        </p>
        <div className="tk-listhead-actions">
          <button
            type="button"
            onClick={clearFiles}
            disabled={status.isProcessing}
            className="tk-btn tk-btn-danger chef-pressable"
          >{t("merge-pdf.clear.all.29a390")}</button>
        </div>
      </div>

      <ol className="tk-queue" aria-label={t("merge-pdf.pdf.merge.order.a4787c")}>
        {files.map((file, index) => (
          <QueueRow
            key={file.id}
            roomy={files.length <= 3}
            file={file.file}
            name={file.name}
            index={index}
            total={files.length}
            // One line, never "3 pages ·" over "1.5 kB" (review 2, item 9).
            meta={<span>{file.locked ? t('batch.unlock.locked') : file.pageCount == null ? t("merge-pdf.pages.unavailable.7909b1") : t("merge-pdf..24a420", { count: file.pageCount })} · {formatBytes(file.size)}</span>}
            busy={status.isProcessing}
            dragging={activeId === file.id}
            rowRef={(element) => registerItem(file.id, element)}
            onGrab={(event) => dragHandlers.onPointerDown(event, file.id)}
            onMove={(direction) => moveFile(index, direction)}
            onRemove={() => removeFile(file.id)}
            labels={{
              drag: t("merge-pdf.drag.to.reorder.781049", { v0: file.name }),
              up: t("merge-pdf.move.up.6cabe2", { v0: file.name }),
              down: t("merge-pdf.move.down.ab5f2b", { v0: file.name }),
              remove: t("merge-pdf.remove.from.merge.e82fdf", { v0: file.name }),
              upTip: t("merge-pdf.up.7358d1").trim(),
              downTip: t("merge-pdf.down.c7d31c").trim(),
              removeTip: t("merge-pdf.remove.caa0ce").trim(),
            }}
          />
        ))}
      </ol>
    </div>
  );

  return (
    <>
      <ToolScreen
        title={title}
        kind="list"
        heavyJob={{ bytes: files.reduce((sum, item) => sum + item.size, 0), files: files.length }}
        bodyLabelledBy="merge-queue-heading"
        body={body}
        sentence={sentence}
        // The reason the button is off, before it is pressed: the message the merge gave after.
        notice={lockedFile && !status.isProcessing
          ? <Notice tone="error" role="alert">{t('error.pdfLockedNamed', { v0: lockedFile.name })}</Notice>
          : undefined}
        chips={addPdfs || undefined}
        onRun={handleMerge}
        runDisabled={files.length < 2 || status.isProcessing || isPreflighting || Boolean(lockedFile)}
        runLabel={runLabel}
        progress={progress}
        toast={toast}
      />

      {activeId && activeItem && <QueueGhost name={activeItem.name} style={overlayStyle} />}
    </>
  );
};
