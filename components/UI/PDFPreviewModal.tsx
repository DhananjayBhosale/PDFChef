import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';

import React, { useEffect, useId, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, ArrowLeft, ArrowRight, Move } from 'lucide-react';
import { loadDisposablePDFDocument, renderPageAsImage } from '../../services/pdfBrowser';
import { motion, useReducedMotion } from 'framer-motion';
import { ZoomControls } from './ZoomControls';
import { useZoom } from '../../hooks/useZoom';

interface PDFPreviewModalProps {
  file: File;
  pageIndex: number; // 0-based index
  pageLabel: string; // e.g., "Page 1"
  onClose: () => void;
}

export const PDFPreviewModal: React.FC<PDFPreviewModalProps> = ({ file, pageIndex, pageLabel, onClose }) => {
  useI18n();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any | null>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(pageIndex);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const { zoom, zoomIn, zoomOut, resetZoom } = useZoom(1.0, 0.5, 5.0);
  const [error, setError] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const imageUrlRef = useRef<string | null>(null);
  const pdfDocRef = useRef<any | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const reduceMotion = useReducedMotion();
  const renderScale = zoom >= 2 ? 2.6 : 2.0;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = (): HTMLElement[] => {
      const panel = panelRef.current;
      if (!panel) return [];
      const items: HTMLElement[] = [];
      panel.querySelectorAll(selector).forEach((item) => {
        if (item instanceof HTMLElement && item.getClientRects().length > 0) items.push(item);
      });
      return items;
    };
    (focusables()[0] || panelRef.current)?.focus();

    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!panelRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleTab);
    return () => {
      document.removeEventListener('keydown', handleTab);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Close on ESC
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') setCurrentPageIndex((value) => Math.max(0, value - 1));
      if (e.key === 'ArrowRight') setCurrentPageIndex((value) => Math.min(Math.max(0, totalPages - 1), value + 1));
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose, totalPages]);

  useEffect(() => {
    setCurrentPageIndex(pageIndex);
  }, [pageIndex]);

  useEffect(() => {
    if (zoom <= 1) {
      setPan({ x: 0, y: 0 });
    }
  }, [zoom]);

  // Load document once
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setError(null);
        const doc = await loadDisposablePDFDocument(file);
        if (!active) {
          if (doc?.destroy) void doc.destroy();
          return;
        }
        pdfDocRef.current = doc;
        setPdfDoc(doc);
        setTotalPages(doc?.numPages ?? 0);
      } catch (err) {
        console.error(err);
        if (active) {
          setError(t("pdfpreview-modal.failed.to.load.pdf.bc21e7"));
        }
      }
    })();
    return () => {
      active = false;
      if (pdfDocRef.current?.destroy) {
        void pdfDocRef.current.destroy();
      }
      pdfDocRef.current = null;
    };
  }, [file]);

  // Load active page
  useEffect(() => {
    let active = true;
    if (!pdfDoc) return undefined;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const { objectUrl } = await renderPageAsImage(pdfDoc, currentPageIndex, {
          scale: renderScale,
          format: 'image/jpeg',
          quality: 0.92,
        });
        if (!active) {
          if (objectUrl.startsWith('blob:')) URL.revokeObjectURL(objectUrl);
          return;
        }
        if (imageUrlRef.current && imageUrlRef.current.startsWith('blob:')) {
          URL.revokeObjectURL(imageUrlRef.current);
        }
        imageUrlRef.current = objectUrl;
        setImageUrl(objectUrl);
      } catch (err) {
        console.error(err);
        if (active) {
          setError(t("pdfpreview-modal.failed.to.render.preview.aeade0"));
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [pdfDoc, currentPageIndex, renderScale]);

  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [currentPageIndex]);

  useEffect(() => {
    return () => {
      if (imageUrlRef.current && imageUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(imageUrlRef.current);
      }
      imageUrlRef.current = null;
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsPanning(true);
    const startX = e.clientX - pan.x;
    const startY = e.clientY - pan.y;

    const onMove = (moveEvent: PointerEvent) => {
      setPan({ x: moveEvent.clientX - startX, y: moveEvent.clientY - startY });
    };

    const onUp = (upEvent: PointerEvent) => {
      setIsPanning(false);
      e.currentTarget.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return createPortal(
    <motion.div 
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="chef-safe-x fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-[calc(0.5rem+env(safe-area-inset-top))] backdrop-blur-sm sm:px-4 sm:pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pt-[calc(1rem+env(safe-area-inset-top))]"
      onClick={onClose}
    >
      <div 
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-[92dvh] max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-paper-500 bg-slate-900 shadow-2xl sm:h-[90vh]"
        onClick={(e) => e.stopPropagation()} // Prevent closing when clicking content
      >
        {/* Header */}
        <div className="z-10 flex flex-col gap-2 border-b border-paper-600 bg-slate-900 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4">
          <div className="flex items-start justify-between gap-2">
            <h3 id={titleId} className="min-w-0 text-base font-bold text-white sm:text-lg">{t("pdfpreview-modal.message.c6b830d338", { v0: pageLabel, v1: currentPageIndex + 1, v2: totalPages > 0 ? t("pdfpreview-modal.of.42f297", { v0: totalPages }) : '' })}</h3>
            <button
              onClick={onClose}
              className="chef-pressable chef-target -me-1 grid shrink-0 place-items-center rounded-lg text-paper-300 hover:bg-slate-800 hover:text-white sm:hidden"
              aria-label={t("pdfpreview-modal.close.preview.7d8ab3")}
            >
              <X aria-hidden size={22} />
            </button>
          </div>
          <div className="flex items-center justify-between gap-1 sm:justify-end sm:gap-4">
            <button
              onClick={() => setCurrentPageIndex((value) => Math.max(0, value - 1))}
              disabled={currentPageIndex <= 0}
              className="chef-pressable chef-target grid place-items-center text-paper-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-55"
              aria-label={t("pdfpreview-modal.previous.page.1208ec")}
            >
              <ArrowLeft aria-hidden size={18} className="rtl:rotate-180" />
            </button>
            <button
              onClick={() => setCurrentPageIndex((value) => Math.min(Math.max(0, totalPages - 1), value + 1))}
              disabled={currentPageIndex >= Math.max(0, totalPages - 1)}
              className="chef-pressable chef-target grid place-items-center text-paper-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-55"
              aria-label={t("pdfpreview-modal.next.page.c08ac7")}
            >
              <ArrowRight aria-hidden size={18} className="rtl:rotate-180" />
            </button>
            <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} max={5} />
            <div className="mx-2 hidden h-6 w-px bg-paper-600 sm:block" />
            <button
              onClick={onClose}
              className="chef-pressable chef-target hidden place-items-center rounded-lg text-paper-300 transition-colors hover:bg-slate-800 hover:text-white sm:grid"
              aria-label={t("pdfpreview-modal.close.preview.7d8ab3")}
            >
              <X aria-hidden size={24} />
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div
          className={`relative flex flex-1 items-center justify-center overflow-hidden bg-black/50 p-4 ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onPointerDown={handlePointerDown}
        >
          {loading ? (
            <div className="flex flex-col items-center gap-3 text-paper-400">
              <Loader2 className="animate-spin" size={40} />
              <p>{t("pdfpreview-modal.rendering.high.quality.preview.916fc2")}</p>
            </div>
          ) : error ? (
            <div className="text-danger-300 font-medium bg-rose-900/20 px-6 py-4 rounded-xl border border-danger-500">
              {error}
            </div>
          ) : imageUrl ? (
            <div 
              style={{ 
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: 'center',
                transition: reduceMotion ? 'none' : 'transform 0.2s ease-out'
              }}
              className="flex max-h-full max-w-full items-center justify-center shadow-2xl"
            >
              <img 
                src={imageUrl} 
                alt={pageLabel} 
                className="block max-h-full max-w-full object-contain bg-white rounded-sm"
                draggable={false}
              />
            </div>
          ) : null}
          {zoom > 1 && isPanning && (
            <div className="absolute start-4 top-4 flex items-center gap-1 rounded-full bg-slate-950/80 px-2 py-1 text-xs text-white">
              <Move size={12} />{t("pdfpreview-modal.dragging.26d17c")}</div>
          )}
        </div>

      </div>
    </motion.div>,
    document.body
  );
};
