import { localizeError, pdfFailureNotice } from '../../services/i18n/errors.ts';
import { formatPercent, t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';

import React, { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { ErrorText } from '../UI/ErrorText';
import { FileUpload } from '../UI/FileUpload';
import { PDFLoadingProgress } from '../UI/PDFLoadingProgress';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPdfPagePreviews, reorderPDFPages, type PdfPreviewProgress } from '../../services/pdfLazy';
import { useWide } from '../../hooks/useMediaQuery';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Save, Undo2, Redo2, GripVertical, Eye, RotateCcw } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { createPortal } from 'react-dom';
import { PDFPreviewModal } from '../UI/PDFPreviewModal';
import { StatusToast } from '../UI/StatusToast';
import { formatBytes, toolOutputName } from '../UI/format';
import { useDragReorder } from '../../hooks/useDragReorder';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { ProgressLine } from '../Tool/parts';
import { PageGrid, usePageGridFit } from '../Tool/PageGrid';
import { useSharpPreviews, PREVIEW_SCALES } from '../Tool/useSharpPreviews';
import { useCanvasScroller } from '../Tool/useCanvasScroller';
import { usePinchToOpen } from '../Tool/PagePeek';

interface PageItem {
  id: string;
  index: number;
  originalIndex: number;
}

export const ReorderPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [items, setItems] = useState<PageItem[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [history, setHistory] = useState<PageItem[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<PdfPreviewProgress | null>(null);
  const [previewError, setPreviewError] = useState<{ title: string; detail?: string } | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });

  // Preview State (Isolated)
  const [previewTarget, setPreviewTarget] = useState<{ index: number; label: string } | null>(null);

  // --- INITIALIZATION ---

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

          const initialPages = urls.map((_, i) => ({
            id: `page-${i}`,
            index: i,
            originalIndex: i,
          }));
          setPreviewUrls(urls);
          setItems(initialPages);
          setHistory([initialPages]);
          setHistoryIndex(0);
          setLoadingPreviews(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error(error);
          setPreviewError(pdfFailureNotice(error, t("reorder-pdf.the.pages.could.not.be.shown.choose.9884e4")));
          setLoadingPreviews(false);
        });
    } else {
      setItems([]);
      setPreviewUrls([]);
      setHistory([]);
      setHistoryIndex(-1);
      setPreviewError(null);
    }

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file]);

  useEffect(() => {
    return () => {
      revokeObjectUrls(previewUrls);
    };
  }, [previewUrls]);

  // Items name a page; the picture is looked up, so a sharper redraw reaches the undo history too.
  const onGridFit = useSharpPreviews(file?.file ?? null, previewUrls, setPreviewUrls, !loadingPreviews && !previewError);
  const wide = useWide();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scroller = useCanvasScroller();
  // Phone grid fit (pass 4): the tiles shrink until every page of a short file and its Move up and
  // Move down sit above the foot sheet, and the fit is reported so the pictures are redrawn sharp.
  // 84 px is the label and move row under each picture; 100 px keeps each move button 48 px wide.
  // The count is 0 while the phone grid is not on screen, so it is measured again when it mounts.
  const phoneGridRef = useRef<HTMLDivElement>(null);
  const phoneFit = usePageGridFit(phoneGridRef, !wide && !loadingPreviews && !previewError ? items.length : 0, 0.75, { minTile: 100, labelHeight: 84 });
  useLayoutEffect(() => {
    if (phoneFit) onGridFit(phoneFit);
  }, [phoneFit, onGridFit]);
  // Where the last keyboard or button move put a page, for the status line (research r3, desktop-02).
  const [moved, setMoved] = useState('');
  // The control that moved a page keeps focus on that page after the grid reorders.
  const refocus = useRef<{ id: string; control: string } | null>(null);
  useLayoutEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (!target) return;
    const tile = document.querySelector(`[data-page-item="${target.id}"]`);
    const control = tile?.querySelector<HTMLButtonElement>(target.control === 'grip' ? '[data-grip]' : `[data-move="${target.control}"]`);
    // A page moved to an end: its button that way is now disabled, so the other one takes focus.
    const next = control && !control.disabled ? control : tile?.querySelector<HTMLButtonElement>('[data-move]:not(:disabled)');
    if (next && document.activeElement !== next) next.focus({ preventScroll: false });
  }, [items]);

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0) return;
    const f = files[0];
    if (!isPdfFile(f)) return;
    setFile({ id: uuidv4(), file: f, name: f.name, size: f.size });
  };

  // --- HISTORY MANAGEMENT ---

  const commitToHistory = useCallback((newItems: PageItem[]) => {
    const current = history[historyIndex];
    // Simple deep check to avoid duplicate states
    if (current && JSON.stringify(newItems.map(p => p.id)) === JSON.stringify(current.map(p => p.id))) return;
    
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push([...newItems]);
    if (newHistory.length > 50) newHistory.shift();
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  }, [history, historyIndex]);

  // While it saves, the order is locked: the saved PDF is the order on the screen (s3-07).
  const saving = status.isProcessing;

  const handleUndo = () => {
    if (saving) return;
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      setMoved('');
      setItems(history[prevIndex]);
      setHistoryIndex(prevIndex);
    }
  };

  const handleRedo = () => {
    if (saving) return;
    if (historyIndex < history.length - 1) {
      const nextIndex = historyIndex + 1;
      setMoved('');
      setItems(history[nextIndex]);
      setHistoryIndex(nextIndex);
    }
  };

  const moveItem = (fromIndex: number, toIndex: number) => {
    if (saving) return;
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length || fromIndex === toIndex) return;
    const next = [...items];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setItems(next);
    commitToHistory(next);
  };

  const resetOrder = () => {
    if (saving) return;
    const next = [...items].sort((left, right) => left.originalIndex - right.originalIndex);
    if (next.every((item, index) => item.id === items[index]?.id)) return;
    setMoved('');
    setItems(next);
    commitToHistory(next);
  };

  // --- DRAG & DROP ---

  // The shared hook scrolls the page while the finger is near an edge, so a page
  // can be carried past the rows on screen in one drag, as in Merge. One drag is
  // one undo step.
  const { activeId, dragHandlers, registerItem, overlayStyle } = useDragReorder<PageItem>({
    scrollContainerRef: scroller.ref,
    items,
    onReorder: setItems,
    keyExtractor: (item) => item.id,
    onDragEnd: commitToHistory,
  });

  // Two fingers spread on a page open it large, as on the other page grids (fable-2 item 7). It
  // starts only once two fingers are down, so one finger drags and scrolls as before, and a second
  // finger during a drag opens nothing.
  const draggingRef = useRef(false);
  draggingRef.current = activeId !== null;
  const pinchRef = usePinchToOpen((target) => {
    if (draggingRef.current) return;
    const index = Number(target?.closest('[data-peek-page]')?.getAttribute('data-peek-page'));
    if (Number.isInteger(index) && index >= 0) setPreviewTarget({ index, label: t("reorder-pdf.page.c140ba", { v0: index + 1 }) });
  });
  const attachBody = useCallback((node: HTMLDivElement | null) => {
    scroller.attach(node);
    pinchRef(node);
  }, [scroller.attach, pinchRef]);

  // --- RENDER HELPERS ---

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: t("reorder-pdf.reordering.pages.c557d2") });
    try {
      const newOrderIndices = items.map(p => p.originalIndex);
      const pdfBytes = await reorderPDFPages(file.file, newOrderIndices);
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        toolOutputName('reorder', file.name, 'pdf'),
      );
      setStatus({ isProcessing: false, progress: 100, message: t("reorder-pdf.reordered.pdf.ready.cef728") });
    } catch (error) {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? localizeError(error) : t("reorder-pdf.the.reordered.pdf.could.not.be.saved.cd973c"),
      });
    }
  };

  const activeItem = items.find(i => i.id === activeId);
  const hasOrderChanges = items.some((item, index) => item.originalIndex !== index);
  const urlOf = (item: PageItem) => previewUrls[item.originalIndex] ?? '';

  const title = t("reorder-pdf.reorder.pages.522c7c");
  const toast = <StatusToast status={status} />;

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("reorder-pdf.choose.a.pdf.to.reorder.df841c")} />
          </div>
        )}
        toast={toast}
      />
    );
  }

  const ready = !loadingPreviews && !previewError && items.length > 0;

  const sentence = ready ? (
    <Sentence
      template={hasOrderChanges ? 'sentence.reorder.changed' : 'sentence.reorder.same'}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
    />
  ) : undefined;

  const chips = ready ? (
    <div role="group" aria-label={t("reorder-pdf.order.history.928f4f")} className="tk-chipgroup">
      <button type="button" onClick={handleUndo} disabled={historyIndex <= 0 || saving} aria-label={t("reorder-pdf.undo.page.reorder.0459c0")} className="tk-chip chef-pressable">
        <Undo2 aria-hidden size={15} />{t("reorder-pdf.undo.a8283a")}
      </button>
      <button type="button" onClick={handleRedo} disabled={historyIndex >= history.length - 1 || saving} aria-label={t("reorder-pdf.redo.page.reorder.77e544")} className="tk-chip chef-pressable">
        <Redo2 aria-hidden size={15} />{t("reorder-pdf.redo.742739")}
      </button>
      <button type="button" onClick={resetOrder} disabled={!hasOrderChanges || saving} aria-label={t("reorder-pdf.reset.to.the.original.page.order.471087")} className="tk-chip chef-pressable">
        <RotateCcw aria-hidden size={15} />{t("reorder-pdf.reset.daee76")}
      </button>
    </div>
  ) : undefined;

  const runLabel = (
    <>
      <Save aria-hidden size={18} />
      <span>{t("reorder-pdf.save.reordered.pdf.b8306f")}</span>
    </>
  );

  const progress = status.isProcessing ? (
    <ProgressLine label={status.message} percent={formatPercent(status.progress)} value={status.progress} />
  ) : undefined;

  // The handle drags with a pointer and moves one place per arrow key: back is Up and the
  // reading-start arrow, forward is Down and the reading-end arrow.
  const gripButton = (item: PageItem, i: number) => (
    <button
      type="button"
      // No drag starts while it saves (s3-07).
      onPointerDownCapture={(e) => { if (saving) e.stopPropagation(); }}
      onPointerDown={(e) => { setSelectedId(item.id); dragHandlers.onPointerDown(e, item.id); }}
      onKeyDown={(e) => {
        const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
        const back = e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
        const forward = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
        if (!back && !forward) return;
        e.preventDefault();
        moveAndMark(item, i, back ? i - 1 : i + 1, 'grip');
      }}
      data-grip=""
      disabled={saving}
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
      className="tk-drag chef-pressable"
      style={{ touchAction: 'none' }}
      aria-label={t("reorder-pdf.drag.page.8b847a", { v0: item.originalIndex + 1 })}
    >
      <GripVertical aria-hidden size={18} />
    </button>
  );

  const previewButton = (item: PageItem, className: string, children: React.ReactNode) => (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()} // CRITICAL: Prevent Drag
      onClick={() => setPreviewTarget({ index: item.originalIndex, label: t("reorder-pdf.page.c140ba", { v0: item.originalIndex + 1 }) })}
      aria-label={t("reorder-pdf.preview.page.ffb7e0", { v0: item.originalIndex + 1 })}
      className={className}
    >
      {children}
    </button>
  );

  // A moved page stays marked, so the eye can follow it to its new place (research r1, H2-01).
  const moveAndMark = (item: PageItem, from: number, to: number, control: string) => {
    if (to < 0 || to >= items.length) return;
    moveItem(from, to);
    setSelectedId(item.id);
    setMoved(t('reorder.moved', { v0: item.originalIndex + 1, v1: to + 1, v2: items.length }));
    refocus.current = { id: item.id, control };
  };


  const moveButtons = (item: PageItem, i: number, grid: boolean) => {
    const Back = grid ? ChevronLeft : ChevronUp;
    const Forward = grid ? ChevronRight : ChevronDown;
    return [
      <button
        key="up"
        type="button"
        onClick={() => moveAndMark(item, i, i - 1, 'up')}
        disabled={i === 0 || saving}
        data-move="up"
        className="tk-move chef-pressable"
        aria-label={t("reorder-pdf.move.page.up.79624d", { v0: item.originalIndex + 1 })}
      >
        <Back aria-hidden size={18} className={grid ? 'rtl:rotate-180' : undefined} />
      </button>,
      <button
        key="down"
        type="button"
        onClick={() => moveAndMark(item, i, i + 1, 'down')}
        disabled={i === items.length - 1 || saving}
        data-move="down"
        className="tk-move chef-pressable"
        aria-label={t("reorder-pdf.move.page.down.9e61e2", { v0: item.originalIndex + 1 })}
      >
        <Forward aria-hidden size={18} className={grid ? 'rtl:rotate-180' : undefined} />
      </button>,
    ];
  };

  const pageError = previewError && (
    <div className="tk-grid-state tk-grid-error">
      <p className="font-semibold"><ErrorText text={previewError.title} file={file?.file} /></p>
      {previewError.detail && <p className="mt-1 text-sm text-[var(--text-secondary)]">{previewError.detail}</p>}
      <button type="button" onClick={() => setFile(null)} className="tk-btn chef-pressable mt-3">{t("reorder-pdf.choose.another.pdf.9434e3")}</button>
    </div>
  );

  // Desktop: a grid that fills the canvas.
  const list = wide ? (
    <PageGrid count={items.length} onFit={onGridFit} className="tk-reorder-grid" role="list">
      {items.map((item, i) => (
          <div
            key={item.id}
            ref={(element) => registerItem(item.id, element)}
            role="listitem"
            className="tk-rtile"
            data-page-item={item.id}
            data-peek-page={item.originalIndex}
            data-dragging={activeId === item.id ? '' : undefined}
            style={{ touchAction: 'pan-y' }}
          >
            <div className="tk-rtile-page">
              {previewButton(item, 'tk-rtile-open', <>
                <img src={urlOf(item)} alt="" draggable={false} />
                <span aria-hidden className="tk-rtile-eye"><Eye size={14} /></span>
              </>)}
              {gripButton(item, i)}
            </div>
            <div className="tk-rtile-foot">
              {moveButtons(item, i, true)[0]}
              <span className="tk-rtile-label tabular">{t("reorder-pdf.message.c140ba4857", { v0: item.originalIndex + 1 })}</span>
              {moveButtons(item, i, true)[1]}
            </div>
          </div>
      ))}
    </PageGrid>
  ) : (
    // Phone (T-03): three columns of page tiles. Each tile shows its Move up and Move down buttons
    // at rest, in a row under its label (research r1, H2-01: no tap first). A tap on a page marks
    // it, and a moved page stays marked. Every tile keeps its named controls (Drag, Preview, Move
    // up, Move down), so the list is still the list it was.
    // When every page fits above the foot sheet, the kit's grid fit sets the columns and tile width,
    // so a short file's pages are as large as the room allows and all their arrows stay in view
    // (pass 4); a longer file keeps three columns and scrolls.
    <div
      ref={phoneGridRef}
      className="tk-rgrid"
      role="list"
      data-fit={phoneFit?.fits ? 'fill' : undefined}
      style={phoneFit?.fits ? ({ '--grid-cols': String(phoneFit.columns), '--tile-w': `${phoneFit.tile}px`, '--grid-gap': `${phoneFit.gap}px` } as React.CSSProperties) : undefined}
    >
      {items.map((item, i) => {
        const selected = selectedId === item.id;
        return (
          <div
            key={item.id}
            ref={(element) => registerItem(item.id, element)}
            role="listitem"
            className="tk-rtile"
            data-page-item={item.id}
            data-peek-page={item.originalIndex}
            data-selected={selected ? '' : undefined}
            data-dragging={activeId === item.id ? '' : undefined}
            style={{ touchAction: 'pan-y' }}
          >
            <div className="tk-rtile-page" onClick={() => setSelectedId(selected ? null : item.id)}>
              <img src={urlOf(item)} alt="" draggable={false} className="tk-rtile-img" />
              {previewButton(item, 'tk-rtile-eyebtn chef-pressable', <Eye aria-hidden size={14} />)}
              {gripButton(item, i)}
            </div>
            <span className="tk-rtile-label tabular">{t("reorder-pdf.message.c140ba4857", { v0: item.originalIndex + 1 })}</span>
            <div className="tk-rtile-moves">{moveButtons(item, i, true)}</div>
          </div>
        );
      })}
    </div>
  );

  const body = (
    <div ref={attachBody} className="select-none">
      <h2 id="reorder-pages-heading" className="sr-only">{title}</h2>
      {/* The sentence shows the state; this line speaks today's count when it changes. */}
      <p className="sr-only" role="status" aria-live="polite">{moved || t(hasOrderChanges ? 'reorder.changed' : 'reorder.original', { count: items.length })}</p>
      {loadingPreviews ? <PDFLoadingProgress progress={previewProgress} /> : previewError ? pageError : list}
    </div>
  );

  return (
    <>
      <ToolScreen
        title={title}
        file={{ name: file.name, meta: <>{items.length > 0 && <>{t('format.pageCount', { count: items.length })} · </>}{formatBytes(file.size)}</> }}
        heavyJob={{ bytes: file.size }}
        change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={() => setFile(null)} disabled={status.isProcessing} />}
        kind="grid"
        bodyLabelledBy="reorder-pages-heading"
        body={body}
        sentence={sentence}
        chips={chips}
        onRun={() => void handleSave()}
        runDisabled={loadingPreviews || items.length === 0 || !hasOrderChanges || status.isProcessing}
        runLabel={runLabel}
        progress={progress}
        toast={toast}
      />

      {/* Drag Overlay Portal */}
      {activeId && activeItem && createPortal(
        <div
          className="fixed z-50 pointer-events-none"
          style={{
            top: overlayStyle.top,
            left: overlayStyle.left,
            width: overlayStyle.width,
          }}
        >
          {/* One tile overlay on every size now that phones use tiles too (T-03). */}
          {true ? (
            <div className="tk-rtile-overlay" style={{ height: overlayStyle.height }}>
              <img src={urlOf(activeItem)} alt="" draggable={false} />
              <span className="tk-rtile-label tabular">{t("reorder-pdf.message.c140ba4857", { v0: activeItem.originalIndex + 1 })}</span>
            </div>
          ) : (
            <div className="flex transform items-center gap-2 rounded-[var(--radius-row)] border-2 border-[var(--accent-rest)] bg-[var(--surface-raised)] p-1.5 opacity-95 shadow-[var(--elevation-sheet)] scale-[1.02]">
              <div className="text-[var(--accent-text)]"><GripVertical aria-hidden size={18} /></div>
              <div className="h-14 w-11 shrink-0 overflow-hidden rounded-[var(--radius-control)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)]">
                <img src={urlOf(activeItem)} alt="" className="w-full h-full object-contain" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--text-primary)]">{t("reorder-pdf.message.c140ba4857", { v0: activeItem.originalIndex + 1 })}</div>
              </div>
            </div>
          )}
        </div>,
        document.body
      )}

      {/* Preview Modal Portal */}
      <AnimatePresence>
        {previewTarget && file && (
          <PDFPreviewModal
            file={file.file}
            pageIndex={previewTarget.index}
            pageLabel={previewTarget.label}
            onClose={() => setPreviewTarget(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
};
