import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFLoadingProgress } from '../UI/PDFLoadingProgress';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPdfPagePreviews, type PdfPreviewProgress } from '../../services/pdfBrowser';
import { reorderPDFPages } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { ChevronDown, ChevronUp, Save, Undo2, Redo2, History, GripVertical, Eye, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { createPortal } from 'react-dom';
import { PDFPreviewModal } from '../UI/PDFPreviewModal';
import { StatusToast } from '../UI/StatusToast';
import { Button } from '../UI/Primitives';
import { ToolChoiceRow, ToolHeader, ToolPanel, ToolSelectionBar, ToolShell } from '../UI/ToolLayout';
import { toolOutputName } from '../UI/format';

interface PageItem {
  id: string;
  index: number;
  originalIndex: number;
  url: string;
}

interface Slot {
  id: string;
  top: number;
  bottom: number;
  midY: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const ReorderPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [items, setItems] = useState<PageItem[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [history, setHistory] = useState<PageItem[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<PdfPreviewProgress | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });

  // Drag State
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);
  
  // Preview State (Isolated)
  const [previewTarget, setPreviewTarget] = useState<{ index: number; label: string } | null>(null);
  
  // Refs for Frozen Logic
  const containerRef = useRef<HTMLDivElement>(null);
  const slotsRef = useRef<Slot[]>([]);
  const dragItemRef = useRef<PageItem | null>(null);
  const isDraggingRef = useRef(false);
  const pointerYRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastTargetIndexRef = useRef<number | null>(null);
  const dragOverlayRectRef = useRef({ left: 0, width: 0, height: 0 });
  const dragOffsetYRef = useRef(40);

  // --- INITIALIZATION ---

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setPreviewProgress(null);

    if (file) {
      setLoadingPreviews(true);
      setPreviewError(null);
      getPdfPagePreviews(file.file, {
        signal: controller.signal,
        onProgress: (progress) => { if (!cancelled) setPreviewProgress(progress); },
      })
        .then(urls => {
          if (cancelled) {
            revokeObjectUrls(urls);
            return;
          }

          const initialPages = urls.map((url, i) => ({
            id: `page-${i}`,
            index: i,
            originalIndex: i,
            url,
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
          setPreviewError(error instanceof Error ? localizeError(error) : t("reorder-pdf.the.pages.could.not.be.shown.choose.9884e4"));
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

  const handleUndo = () => {
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      setItems(history[prevIndex]);
      setHistoryIndex(prevIndex);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const nextIndex = historyIndex + 1;
      setItems(history[nextIndex]);
      setHistoryIndex(nextIndex);
    }
  };

  const moveItem = (fromIndex: number, toIndex: number) => {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length || fromIndex === toIndex) return;
    const next = [...items];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setItems(next);
    commitToHistory(next);
  };

  const resetOrder = () => {
    const next = [...items].sort((left, right) => left.originalIndex - right.originalIndex);
    if (next.every((item, index) => item.id === items[index]?.id)) return;
    setItems(next);
    commitToHistory(next);
  };

  // --- DRAG & DROP LOGIC (ISOLATED) ---

  const measureSlots = () => {
    if (!containerRef.current) return;
    
    const children = Array.from(containerRef.current.children) as HTMLElement[];
    // Filter out potential overlays or temp elements if any, focus on page items
    const pageElements = children.filter(el => el.dataset.pageid);

    const newSlots: Slot[] = pageElements.map(el => {
      const rect = el.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const bottom = rect.bottom + window.scrollY;
      return {
        id: el.dataset.pageid!,
        top,
        bottom,
        midY: (top + bottom) / 2
      };
    });

    // Sort strictly by Y to ensure linear logic works
    newSlots.sort((a, b) => a.top - b.top);
    slotsRef.current = newSlots;
    
    // DEBUG: Validate slots
    // console.log('Frozen Slots:', newSlots);
  };

  const handlePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return; // Only left click
    e.preventDefault();
    e.stopPropagation();

    const item = items.find(p => p.id === id);
    if (!item) return;
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-pageid="${id}"]`);
    if (!row) return;
    const rowRect = row.getBoundingClientRect();

    // 1. Freeze World
    measureSlots();
    
    // 2. Set State
    isDraggingRef.current = true;
    dragItemRef.current = item;
    setActiveId(id);
    pointerYRef.current = e.clientY;
    setDragY(e.clientY);
    lastTargetIndexRef.current = items.findIndex((entry) => entry.id === id);
    dragOverlayRectRef.current = {
      left: rowRect.left,
      width: rowRect.width,
      height: rowRect.height,
    };
    dragOffsetYRef.current = clamp(e.clientY - rowRect.top, 12, rowRect.height - 12);

    document.body.style.userSelect = 'none';
    document.body.style.touchAction = 'none';

    // 3. Attach Global Listeners
    window.addEventListener('pointermove', handleGlobalMove);
    window.addEventListener('pointerup', handleGlobalUp);

    const tick = () => {
      if (!isDraggingRef.current) return;
      const nextPointerY = pointerYRef.current;
      setDragY(nextPointerY);

      const docY = nextPointerY + window.scrollY;
      const slots = slotsRef.current;

      let targetIndex = slots.length;
      for (let i = 0; i < slots.length; i += 1) {
        if (docY < slots[i].midY) {
          targetIndex = i;
          break;
        }
      }

      if (lastTargetIndexRef.current !== targetIndex) {
        setItems((previous) => {
          const active = dragItemRef.current;
          if (!active) return previous;
          const currentIndex = previous.findIndex((entry) => entry.id === active.id);
          if (currentIndex === -1) return previous;

          let insertionIndex = targetIndex;
          if (targetIndex > currentIndex) insertionIndex -= 1;
          insertionIndex = clamp(insertionIndex, 0, previous.length - 1);

          if (currentIndex === insertionIndex) {
            lastTargetIndexRef.current = targetIndex;
            return previous;
          }

          const next = [...previous];
          const [moved] = next.splice(currentIndex, 1);
          next.splice(insertionIndex, 0, moved);
          lastTargetIndexRef.current = targetIndex;
          return next;
        });
      }

      rafRef.current = window.requestAnimationFrame(tick);
    };

    rafRef.current = window.requestAnimationFrame(tick);
  };

  const handleGlobalMove = useCallback((e: PointerEvent) => {
    if (!isDraggingRef.current) return;
    pointerYRef.current = e.clientY;
  }, []);

  const handleGlobalUp = useCallback(() => {
    isDraggingRef.current = false;
    dragItemRef.current = null;
    setActiveId(null);
    slotsRef.current = []; // Clear slots
    lastTargetIndexRef.current = null;
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    document.body.style.userSelect = '';
    document.body.style.touchAction = '';

    window.removeEventListener('pointermove', handleGlobalMove);
    window.removeEventListener('pointerup', handleGlobalUp);
    
    // Commit final state to history
    setItems(current => {
      commitToHistory(current);
      return current;
    });
  }, [commitToHistory, handleGlobalMove]);

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handleGlobalMove);
      window.removeEventListener('pointerup', handleGlobalUp);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
      document.body.style.userSelect = '';
      document.body.style.touchAction = '';
    };
  }, [handleGlobalMove, handleGlobalUp]);

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

  return (
    <ToolShell width="list" centered={!file} className="select-none">
      <ToolHeader title={t("reorder-pdf.reorder.pages.522c7c")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-xl mx-auto">
             <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("reorder-pdf.choose.a.pdf.to.reorder.df841c")} />
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-3">
            <ToolPanel className="flex flex-col gap-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  onClick={() => setFile(null)}
                  className="chef-pressable chef-target -ml-1 flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
                  aria-label={t("reorder-pdf.choose.another.pdf.9434e3")}
                >
                  <History aria-hidden size={18} />
                </button>
                <h2 className="chef-filename min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
              </div>

              <ToolChoiceRow
                label={t("reorder-pdf.order.history.928f4f")}
                choices={[
                  { key: 'undo', label: t("reorder-pdf.undo.a8283a"), ariaLabel: t("reorder-pdf.undo.page.reorder.0459c0"), icon: <Undo2 aria-hidden size={18} className="shrink-0" />, onClick: handleUndo, disabled: historyIndex <= 0 },
                  { key: 'redo', label: t("reorder-pdf.redo.742739"), ariaLabel: t("reorder-pdf.redo.page.reorder.77e544"), icon: <Redo2 aria-hidden size={18} className="shrink-0" />, onClick: handleRedo, disabled: historyIndex >= history.length - 1 },
                  { key: 'reset', label: t("reorder-pdf.reset.daee76"), ariaLabel: t("reorder-pdf.reset.to.the.original.page.order.471087"), icon: <RotateCcw aria-hidden size={18} className="shrink-0" />, onClick: resetOrder, disabled: !hasOrderChanges },
                ]}
              />

              <ToolSelectionBar
                summary={t(hasOrderChanges ? 'reorder.changed' : 'reorder.original', { count: items.length })}
                actions={[]}
              />
            </ToolPanel>
            {loadingPreviews && <PDFLoadingProgress progress={previewProgress} />}

            <Button
              tone="primary"
              block
              busy={status.isProcessing}
              disabled={loadingPreviews || items.length === 0 || !hasOrderChanges}
              icon={<Save aria-hidden size={18} />}
              onClick={() => void handleSave()}
            >{t("reorder-pdf.save.reordered.pdf.b8306f")}</Button>

            {/* List Container - Vertical Stack */}
            <div
              ref={containerRef}
              className="relative flex flex-col gap-2"
              role="list"
            >
               {loadingPreviews ? null : previewError ? (
                 <div className="flex flex-col items-center gap-2 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] px-4 py-4 text-center">
                   <p className="font-semibold text-[var(--status-danger-text)]">{t("reorder-pdf.the.pages.could.not.be.shown.choose.9884e4")}</p>
                   <p className="max-w-measure text-sm text-[var(--text-secondary)]">{previewError}</p>
                   <Button tone="secondary" onClick={() => setFile(null)}>{t("reorder-pdf.choose.another.pdf.9434e3")}</Button>
                 </div>
               ) : (
                 items.map((item, i) => (
                  <div
                     key={item.id}
                     data-pageid={item.id}
                     role="listitem"
                     className={`
                       relative flex items-center gap-1.5 rounded-[var(--radius-row)] border bg-[var(--surface-raised)] p-1.5 transition-colors
                       ${activeId === item.id ? 'opacity-0 border-[var(--border-hairline)]' : 'opacity-100 border-[var(--border-hairline)] hover:border-[var(--border-strong)]'}
                     `}
                     style={{ touchAction: 'pan-y' }}
                   >
                      <button
                        type="button"
                        onPointerDown={(e) => handlePointerDown(e, item.id)}
                        className="chef-target flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-sunken)] active:cursor-grabbing"
                        style={{ touchAction: 'none' }}
                        aria-label={t("reorder-pdf.drag.page.8b847a", { v0: item.originalIndex + 1 })}
                      >
                        <GripVertical aria-hidden size={18} />
                      </button>

                      {/* The thumbnail is the preview control. It carries the eye
                          glyph the separate button used to, which frees the width
                          the two move buttons need to be visible at 320px. */}
                      <button
                        type="button"
                        onPointerDown={(e) => e.stopPropagation()} // CRITICAL: Prevent Drag
                        onClick={() => setPreviewTarget({ index: item.originalIndex, label: t("reorder-pdf.page.c140ba", { v0: item.originalIndex + 1 }) })}
                        aria-label={t("reorder-pdf.preview.page.ffb7e0", { v0: item.originalIndex + 1 })}
                        className="relative h-14 w-11 shrink-0 overflow-hidden rounded-[var(--radius-control)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)]"
                      >
                        <img src={item.url} alt="" className="h-full w-full object-contain" />
                        <span aria-hidden className="absolute bottom-0 right-0 grid h-5 w-5 place-items-center rounded-tl-[var(--radius-control)] bg-[var(--surface-raised)]/90 text-[var(--text-secondary)]">
                          <Eye size={12} />
                        </span>
                      </button>

                      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text-primary)]">{t("reorder-pdf.message.c140ba4857", { v0: item.originalIndex + 1 })}</p>

                      <button
                        type="button"
                        onClick={() => moveItem(i, i - 1)}
                        disabled={i === 0}
                        className="chef-target flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:text-[var(--text-tertiary)] disabled:opacity-35"
                        aria-label={t("reorder-pdf.move.page.up.79624d", { v0: item.originalIndex + 1 })}
                      >
                        <ChevronUp aria-hidden size={18} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveItem(i, i + 1)}
                        disabled={i === items.length - 1}
                        className="chef-target flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:text-[var(--text-tertiary)] disabled:opacity-35"
                        aria-label={t("reorder-pdf.move.page.down.9e61e2", { v0: item.originalIndex + 1 })}
                      >
                        <ChevronDown aria-hidden size={18} />
                      </button>
                   </div>
                 ))
               )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Drag Overlay Portal */}
      {activeId && activeItem && createPortal(
        <div 
          className="fixed z-50 pointer-events-none"
          style={{
            top: dragY - dragOffsetYRef.current,
            left: dragOverlayRectRef.current.left,
            width: dragOverlayRectRef.current.width,
          }}
        >
          <div className="flex transform items-center gap-2 rounded-[var(--radius-row)] border-2 border-[var(--accent-rest)] bg-[var(--surface-raised)] p-1.5 opacity-95 shadow-[var(--elevation-sheet)] scale-[1.02]">
             <div className="text-[var(--accent-text)]"><GripVertical aria-hidden size={18} /></div>
             <div className="h-14 w-11 shrink-0 overflow-hidden rounded-[var(--radius-control)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)]">
                <img src={activeItem.url} alt="" className="w-full h-full object-contain" />
             </div>
             <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--text-primary)]">{t("reorder-pdf.message.c140ba4857", { v0: activeItem.originalIndex + 1 })}</div>
             </div>
          </div>
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
      <StatusToast status={status} />
    </ToolShell>
  );
};
