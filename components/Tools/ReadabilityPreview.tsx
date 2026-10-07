import { formatPercent } from '../../services/i18n/core.ts';
import { formatBytes as formatSize } from '../UI/format';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useId, useState, useRef, useCallback, useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle,
  Eye,
  X,
  HardDrive,
  RotateCcw,
  Plus,
  Minus,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Portal } from '../UI/Primitives';
import { ChefSlider } from '../UI/ChefSlider';
import { type AdaptiveConfig, generatePreviewPair, getInterpolatedConfig } from '../../services/pdfBrowser';

interface Props {
  file: File;
  files?: Array<{ file: File; name: string }>;
  config: AdaptiveConfig;
  isTextHeavy: boolean;
  onClose: () => void;
  onConfirm: (config: AdaptiveConfig) => void;
}

type TouchGesture =
  | { kind: 'pan'; startX: number; startY: number; startPan: { x: number; y: number }; currentPan: { x: number; y: number } }
  | {
      kind: 'pinch';
      startDistance: number;
      startZoom: number;
      startPan: { x: number; y: number };
      startMidpoint: { x: number; y: number };
      paneCenter: { x: number; y: number };
      currentZoom: number;
      currentPan: { x: number; y: number };
    };

export const ReadabilityPreview: React.FC<Props> = ({ file, files, config: initialConfig, isTextHeavy, onClose, onConfirm }) => {
  useI18n();
  const [images, setImages] = useState<{ original: string; compressed: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const [sliderValue, setSliderValue] = useState(50);
  const [currentConfig, setCurrentConfig] = useState<AdaptiveConfig>(initialConfig);
  const [sizeEstimate, setSizeEstimate] = useState<{ estimatedSize: number; ratio: number } | null>(null);

  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [fileIndex, setFileIndex] = useState(0);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const wheelSurfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [bounds, setBounds] = useState({ w: 0, h: 0, cw: 0, ch: 0 });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const dragStartRef = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);
  const touchGestureRef = useRef<TouchGesture | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const reduceMotion = useReducedMotion();

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

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
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
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);

  const previewFiles = useMemo(() => {
    return files?.length ? files : [{ file, name: file.name }];
  }, [file, files]);
  const activeFileIndex = Math.min(fileIndex, previewFiles.length - 1);
  const activeFile = previewFiles[activeFileIndex];
  const isBatchPreview = previewFiles.length > 1;

  const clampPanToBounds = useCallback(
    (nextPan: { x: number; y: number }, targetZoom = zoom) => {
      const scaledW = bounds.w * targetZoom;
      const scaledH = bounds.h * targetZoom;
      const maxPanX = Math.max(0, (scaledW - bounds.cw) / 2);
      const maxPanY = Math.max(0, (scaledH - bounds.ch) / 2);

      return {
        x: Math.max(-maxPanX, Math.min(maxPanX, nextPan.x)),
        y: Math.max(-maxPanY, Math.min(maxPanY, nextPan.y)),
      };
    },
    [bounds, zoom],
  );

  const generate = useCallback(
    async (sourceFile: File, cfg: AdaptiveConfig, requestedPageIndex: number) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);

      try {
        const result = await generatePreviewPair(sourceFile, cfg, { pageIndex: requestedPageIndex });
        if (requestId !== requestIdRef.current) return;

        setImages({ original: result.original, compressed: result.compressed });
        setPageCount(result.pageCount);
        setPageIndex(result.pageIndex);
        setSizeEstimate({
          estimatedSize: result.metrics.estimatedTotalSize,
          ratio: result.metrics.estimatedTotalSize / sourceFile.size,
        });
      } catch (error) {
        console.error(error);
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const startDPI = initialConfig.projectedDPI;
    const approxSlider = Math.max(0, Math.min(100, ((startDPI - 43) / (300 - 43)) * 100));
    const normalizedSlider = Number(approxSlider.toFixed(1));
    setSliderValue(normalizedSlider);
    setCurrentConfig(initialConfig);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    void generate(activeFile.file, initialConfig, 0);
  }, [activeFile.file, generate, initialConfig]);

  useEffect(() => {
    if (fileIndex >= previewFiles.length) {
      setFileIndex(0);
    }
  }, [fileIndex, previewFiles.length]);

  useEffect(
    () => () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    },
    [],
  );

  const updateBounds = useCallback(() => {
    if (!containerRef.current || !imageRef.current) return;

    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    const nw = imageRef.current.naturalWidth;
    const nh = imageRef.current.naturalHeight;
    if (!nw || !nh || !cw || !ch) return;

    const containerRatio = cw / ch;
    const imageRatio = nw / nh;

    const renderedW = imageRatio > containerRatio ? cw : ch * imageRatio;
    const renderedH = imageRatio > containerRatio ? cw / imageRatio : ch;

    setBounds({ w: renderedW, h: renderedH, cw, ch });
  }, []);

  useEffect(() => {
    window.addEventListener('resize', updateBounds);
    return () => window.removeEventListener('resize', updateBounds);
  }, [updateBounds]);

  useEffect(() => {
    if (zoom <= 1) {
      setPan({ x: 0, y: 0 });
      return;
    }
    setPan((current) => clampPanToBounds(current));
  }, [bounds, clampPanToBounds, zoom]);

  const setZoomTo = useCallback(
    (nextZoom: number) => {
      setZoom((previousZoom) => {
        const clamped = Math.max(1, Math.min(10, Number(nextZoom.toFixed(2))));
        if (clamped === previousZoom) return previousZoom;

        setPan((currentPan) => (clamped <= 1 ? { x: 0, y: 0 } : clampPanToBounds(currentPan, clamped)));
        return clamped;
      });
    },
    [clampPanToBounds],
  );

  const setZoomByDelta = useCallback(
    (delta: number) => {
      setZoom((previousZoom) => {
        const clamped = Math.max(1, Math.min(10, Number((previousZoom + delta).toFixed(2))));
        if (clamped === previousZoom) return previousZoom;

        setPan((currentPan) => (clamped <= 1 ? { x: 0, y: 0 } : clampPanToBounds(currentPan, clamped)));
        return clamped;
      });
    },
    [clampPanToBounds],
  );

  const handleWheelZoom = useCallback(
    (event: WheelEvent) => {
      if (!images || event.deltaY === 0) return;

      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.2 : -0.2;
      setZoomByDelta(delta);
    },
    [images, setZoomByDelta],
  );

  useEffect(() => {
    const surface = wheelSurfaceRef.current;
    if (!surface) return undefined;
    surface.addEventListener('wheel', handleWheelZoom, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheelZoom);
  }, [handleWheelZoom]);

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || event.pointerType === 'touch') return;
    setIsPanning(true);
    dragStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  useEffect(() => {
    if (!isPanning || !dragStartRef.current) return;

    const onMove = (event: PointerEvent) => {
      const dragStart = dragStartRef.current;
      if (!dragStart) return;

      const dx = event.clientX - dragStart.clientX;
      const dy = event.clientY - dragStart.clientY;
      setPan(
        clampPanToBounds({
          x: dragStart.panX + dx,
          y: dragStart.panY + dy,
        }),
      );
    };

    const onUp = () => {
      setIsPanning(false);
      dragStartRef.current = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [clampPanToBounds, isPanning]);

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!images) return;
    if (event.touches.length === 2) {
      const [first, second] = [event.touches[0], event.touches[1]];
      const rect = event.currentTarget.getBoundingClientRect();
      touchGestureRef.current = {
        kind: 'pinch',
        startDistance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
        startZoom: zoom,
        startPan: pan,
        startMidpoint: { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 },
        paneCenter: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        currentZoom: zoom,
        currentPan: pan,
      };
      setIsPanning(true);
    } else if (event.touches.length === 1 && zoom > 1) {
      touchGestureRef.current = {
        kind: 'pan',
        startX: event.touches[0].clientX,
        startY: event.touches[0].clientY,
        startPan: pan,
        currentPan: pan,
      };
      setIsPanning(true);
    }
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = touchGestureRef.current;
    if (!gesture) return;
    if (gesture.kind === 'pinch' && event.touches.length === 2 && gesture.startDistance > 0) {
      const [first, second] = [event.touches[0], event.touches[1]];
      const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
      const nextZoom = Math.max(1, Math.min(10, gesture.startZoom * distance / gesture.startDistance));
      const midpoint = { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 };
      const scale = nextZoom / gesture.startZoom;
      const nextPan = clampPanToBounds({
        x: midpoint.x - gesture.paneCenter.x - (gesture.startMidpoint.x - gesture.paneCenter.x - gesture.startPan.x) * scale,
        y: midpoint.y - gesture.paneCenter.y - (gesture.startMidpoint.y - gesture.paneCenter.y - gesture.startPan.y) * scale,
      }, nextZoom);
      gesture.currentZoom = nextZoom;
      gesture.currentPan = nextPan;
      setZoom(nextZoom);
      setPan(nextPan);
    } else if (gesture.kind === 'pan' && event.touches.length === 1) {
      const nextPan = clampPanToBounds({
        x: gesture.startPan.x + event.touches[0].clientX - gesture.startX,
        y: gesture.startPan.y + event.touches[0].clientY - gesture.startY,
      });
      gesture.currentPan = nextPan;
      setPan(nextPan);
    }
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = touchGestureRef.current;
    if (event.touches.length === 1 && gesture?.kind === 'pinch' && gesture.currentZoom > 1) {
      touchGestureRef.current = {
        kind: 'pan',
        startX: event.touches[0].clientX,
        startY: event.touches[0].clientY,
        startPan: gesture.currentPan,
        currentPan: gesture.currentPan,
      };
      return;
    }
    touchGestureRef.current = null;
    setIsPanning(false);
  };

  const requestPage = (nextIndex: number) => {
    const clamped = Math.max(0, Math.min(pageCount - 1, nextIndex));
    setZoom(1);
    setPan({ x: 0, y: 0 });
    void generate(activeFile.file, currentConfig, clamped);
  };

  const requestFile = (nextIndex: number) => {
    const clamped = Math.max(0, Math.min(previewFiles.length - 1, nextIndex));
    if (clamped === activeFileIndex) return;

    setFileIndex(clamped);
    setPageIndex(0);
    setPageCount(1);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setImages(null);
  };

  const applyQualitySlider = (value: number, immediate = false) => {
    const normalized = Math.max(0, Math.min(100, value));
    setSliderValue(normalized);
    const nextConfig = getInterpolatedConfig(normalized, isTextHeavy);
    setCurrentConfig(nextConfig);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (immediate) {
      void generate(activeFile.file, nextConfig, pageIndex);
      return;
    }

    debounceRef.current = setTimeout(() => {
      void generate(activeFile.file, nextConfig, pageIndex);
    }, 180);
  };

  const dpi = currentConfig.projectedDPI;
  // Always-MB read "0.00 MB" for anything under about 5 KB, which is the size a
  // heavily compressed page most wants to show off.

  return (
    <Portal>
    <div className="chef-safe-x fixed inset-0 z-[100] flex items-center justify-center px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]">
      <div className="absolute inset-0 bg-black/90 backdrop-blur-sm" onClick={onClose} />

      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial={reduceMotion ? false : { scale: 0.98, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="relative z-10 flex h-[95vh] h-[95dvh] max-h-full w-full max-w-[95vw] flex-col overflow-hidden rounded-2xl border border-paper-600 bg-paper-950 shadow-2xl"
      >
        <div className="z-20 flex flex-col gap-3 border-b border-paper-600 bg-paper-950 px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-5 lg:py-4">
          <div className="min-w-0">
            {/* The file's own name is the title. "Readability check" said less
                than the two panes below it already show. */}
            <h3 id={titleId} className="flex items-center gap-2 truncate text-base font-bold text-paper-25 lg:max-w-[48vw]">
              <Eye aria-hidden size={18} className="shrink-0 text-ink-400" />
              <span className="truncate">{activeFile.name}</span>
            </h3>
          </div>

          <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:justify-end">
            {isBatchPreview && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => requestFile(activeFileIndex - 1)}
                  disabled={loading || activeFileIndex <= 0}
                  className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                  aria-label={t("readability-preview.previous.file.1db0d0")}
                >
                  <ChevronLeft size={18} className="rtl:rotate-180" />
                </button>
                <div className="rounded-lg bg-paper-800 px-3 py-2 text-xs font-semibold text-paper-200">{t("readability-preview.message.849db32933", { v0: activeFileIndex + 1, v1: previewFiles.length })}</div>
                <button
                  type="button"
                  onClick={() => requestFile(activeFileIndex + 1)}
                  disabled={loading || activeFileIndex >= previewFiles.length - 1}
                  className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                  aria-label={t("readability-preview.next.file.96a748")}
                >
                  <ChevronRight size={18} className="rtl:rotate-180" />
                </button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => requestPage(pageIndex - 1)}
                disabled={loading || pageIndex <= 0}
                className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                aria-label={t("readability-preview.previous.page.1208ec")}
              >
                <ChevronLeft size={18} className="rtl:rotate-180" />
              </button>
              <div className="rounded-lg bg-paper-800 px-3 py-2 text-xs font-semibold text-paper-200">{t("readability-preview.message.61ebc290b6", { v0: pageIndex + 1, v1: pageCount })}</div>
              <button
                type="button"
                onClick={() => requestPage(pageIndex + 1)}
                disabled={loading || pageIndex >= pageCount - 1}
                className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                aria-label={t("readability-preview.next.page.c08ac7")}
              >
                <ChevronRight size={18} className="rtl:rotate-180" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setZoomByDelta(-0.25)}
                disabled={zoom <= 1}
                className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                aria-label={t("readability-preview.zoom.out.bc7b63")}
              >
                <Minus size={16} />
              </button>
              <span className="tabular w-12 text-center text-sm font-bold text-paper-25">{formatPercent(Math.round(zoom * 100))}</span>
              <button
                type="button"
                onClick={() => setZoomByDelta(0.25)}
                disabled={zoom >= 10}
                className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                aria-label={t("readability-preview.zoom.in.0e47f0")}
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setZoomTo(1);
                  setPan({ x: 0, y: 0 });
                }}
                className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800"
                aria-label={t("readability-preview.reset.zoom.91a661")}
              >
                <RotateCcw size={16} />
              </button>
            </div>

            <button type="button" aria-label={t("readability-preview.close.readability.preview.af5860")} onClick={onClose} className="chef-pressable chef-target ml-auto grid place-items-center rounded-lg text-paper-400 transition hover:bg-paper-800 hover:text-paper-25 lg:ml-0">
              <X size={22} />
            </button>
          </div>
        </div>

        <div ref={wheelSurfaceRef} className="relative flex flex-1 flex-col divide-y divide-paper-600 overflow-hidden bg-black/60 md:flex-row md:divide-x md:divide-y-0">
          <div
            ref={containerRef}
            className={`relative flex flex-1 items-center justify-center overflow-hidden bg-paper-900/40 ${
              zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
            }`}
            onPointerDown={startPan}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            data-testid="compression-original-preview"
            data-preview-zoom={zoom}
            style={{ touchAction: 'none' }}
          >
            {images ? (
              <>
                <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-full border border-white/10 bg-black/65 px-3 py-1 text-xs font-bold text-paper-25">{t("readability-preview.original.88d759")}</div>
                <img
                  ref={imageRef}
                  src={images.original}
                  alt={t("readability-preview.original.88d759")}
                  onLoad={updateBounds}
                  className="h-auto max-h-full w-auto max-w-full select-none object-contain shadow-2xl will-change-transform"
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'center center',
                    transition: isPanning || reduceMotion ? 'none' : 'transform 160ms ease-out',
                  }}
                  draggable={false}
                />
              </>
            ) : (
              <div className="text-sm text-paper-400">{t("readability-preview.loading.ba3bbb")}</div>
            )}
          </div>

          <div
            className={`relative flex flex-1 items-center justify-center overflow-hidden bg-paper-900/40 ${
              zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
            }`}
            onPointerDown={startPan}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            data-testid="compression-compressed-preview"
            data-preview-zoom={zoom}
            style={{ touchAction: 'none' }}
          >
            {images ? (
              <>
                <div className="pointer-events-none absolute left-4 top-4 z-10 flex gap-2">
                  <div className="rounded-full bg-ink-600 px-3 py-1 text-xs font-bold text-paper-25">{t("readability-preview.compressed.e2d1ca")}</div>
                  <div
                    className={`rounded-full border border-white/10 px-3 py-1 text-xs font-bold text-paper-25 shadow-lg ${
                      dpi < 100 ? 'bg-danger-600' : 'bg-black/65'
                    }`}
                  >
                    {dpi < 100 ? t("readability-preview.low.detail.09e3c5") : dpi < 175 ? t("readability-preview.medium.detail.1c7539") : t("readability-preview.high.detail.b6a390")}
                  </div>
                </div>
                <img
                  src={images.compressed}
                  alt={t("readability-preview.compressed.e2d1ca")}
                  className={`h-auto max-h-full w-auto max-w-full select-none object-contain shadow-2xl ${
                    loading ? 'opacity-60 blur-[1px]' : 'opacity-100'
                  } will-change-transform`}
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'center center',
                    transition: isPanning || reduceMotion ? 'none' : 'transform 160ms ease-out',
                  }}
                  draggable={false}
                />
              </>
            ) : (
              <div className="text-sm text-paper-400">{t("readability-preview.loading.ba3bbb")}</div>
            )}
          </div>
        </div>

        <div className="z-20 flex flex-col gap-3 border-t border-paper-600 bg-paper-950 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          {/* The slider's two ends are named; nothing else about it needs
              saying, and the scale and JPEG quality behind it are numbers the
              two panes above already show the effect of. */}
          <div className="flex w-full items-center gap-3 lg:w-[52%]">
            <span className="text-xs font-medium text-paper-400">{t("readability-preview.low.f793de")}</span>
            <ChefSlider
              min={0}
              max={100}
              step={0.1}
              value={sliderValue}
              onChange={applyQualitySlider}
              ariaLabel={t("readability-preview.compression.quality.4038b0")}
              className="flex-1"
            />
            <span className="text-xs font-medium text-paper-400">{t("readability-preview.high.c4ebc6")}</span>
          </div>

          {dpi < 100 && (
            <p role="status" className="w-full text-sm font-medium text-caution-300">{t("readability-preview.at.this.setting.small.print.may.be.669b7a")}</p>
          )}

          <div className="flex w-full flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-end">
            {sizeEstimate && (
              <div className={`text-end ${loading ? 'opacity-60' : 'opacity-100'}`}>
                <div className="tabular flex items-center justify-end gap-2 text-xl font-bold text-paper-25">
                  <HardDrive aria-hidden size={18} className="text-paper-400" />~{formatSize(sizeEstimate.estimatedSize)}
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-bold ${
                      sizeEstimate.ratio >= 1 ? 'bg-caution-900 text-caution-300' : 'bg-success-900 text-success-300'
                    }`}
                  >
                    {sizeEstimate.ratio >= 1 ? t("readability-preview.not.smaller.0b2dbd") : t("readability-preview.smaller.c2af4b", { v0: Math.round((1 - sizeEstimate.ratio) * 100) })}
                  </span>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => onConfirm(currentConfig)}
              className="chef-target chef-pressable flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-ink-500 px-6 font-bold text-paper-25 transition hover:bg-ink-400 sm:w-auto"
            >
              {/* Below 100 DPI the output can be hard to read, which is the one
                  thing the two panes might not make obvious at a glance. */}
              {dpi < 100 && <AlertTriangle aria-hidden size={18} />}{t("readability-preview.compress.033fc0")}</button>
          </div>
        </div>
      </motion.div>
    </div>
    </Portal>
  );
};
