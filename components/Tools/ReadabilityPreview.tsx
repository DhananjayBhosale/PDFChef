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

export const ReadabilityPreview: React.FC<Props> = ({ file, files, config: initialConfig, isTextHeavy, onClose, onConfirm }) => {
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
  const imageRef = useRef<HTMLImageElement>(null);
  const [bounds, setBounds] = useState({ w: 0, h: 0, cw: 0, ch: 0 });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const dragStartRef = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);
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
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!images) return;

      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.2 : -0.2;
      setZoomByDelta(delta);
    },
    [images, setZoomByDelta],
  );

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1) return;
    setIsPanning(true);
    dragStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  useEffect(() => {
    if (!isPanning) return;

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
  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${Math.round(bytes)} B`;
  };

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
                  aria-label="Previous file"
                >
                  <ChevronLeft size={18} />
                </button>
                <div className="rounded-lg bg-paper-800 px-3 py-2 text-xs font-semibold text-paper-200">
                  File {activeFileIndex + 1} / {previewFiles.length}
                </div>
                <button
                  type="button"
                  onClick={() => requestFile(activeFileIndex + 1)}
                  disabled={loading || activeFileIndex >= previewFiles.length - 1}
                  className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                  aria-label="Next file"
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => requestPage(pageIndex - 1)}
                disabled={loading || pageIndex <= 0}
                className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                aria-label="Previous page"
              >
                <ChevronLeft size={18} />
              </button>
              <div className="rounded-lg bg-paper-800 px-3 py-2 text-xs font-semibold text-paper-200">
                Page {pageIndex + 1} / {pageCount}
              </div>
              <button
                type="button"
                onClick={() => requestPage(pageIndex + 1)}
                disabled={loading || pageIndex >= pageCount - 1}
                className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                aria-label="Next page"
              >
                <ChevronRight size={18} />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setZoomByDelta(-0.25)}
                disabled={zoom <= 1}
                className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                aria-label="Zoom out"
              >
                <Minus size={16} />
              </button>
              <span className="tabular w-12 text-center text-sm font-bold text-paper-25">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setZoomByDelta(0.25)}
                disabled={zoom >= 10}
                className="chef-pressable chef-target grid place-items-center rounded-md text-paper-300 transition hover:bg-paper-800 disabled:opacity-55"
                aria-label="Zoom in"
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
                aria-label="Reset zoom"
              >
                <RotateCcw size={16} />
              </button>
            </div>

            <button type="button" aria-label="Close readability preview" onClick={onClose} className="chef-pressable chef-target ml-auto grid place-items-center rounded-lg text-paper-400 transition hover:bg-paper-800 hover:text-paper-25 lg:ml-0">
              <X size={22} />
            </button>
          </div>
        </div>

        <div className="relative flex flex-1 flex-col divide-y divide-paper-600 overflow-hidden bg-black/60 md:flex-row md:divide-x md:divide-y-0">
          <div
            ref={containerRef}
            className={`relative flex flex-1 items-center justify-center overflow-hidden bg-paper-900/40 ${
              zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
            }`}
            onPointerDown={startPan}
            onWheel={handleWheelZoom}
            style={{ touchAction: zoom > 1 ? 'none' : 'auto' }}
          >
            {images ? (
              <>
                <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-full border border-white/10 bg-black/65 px-3 py-1 text-xs font-bold text-paper-25">
                  Original
                </div>
                <img
                  ref={imageRef}
                  src={images.original}
                  alt="Original"
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
              <div className="text-sm text-paper-400">Loading…</div>
            )}
          </div>

          <div
            className={`relative flex flex-1 items-center justify-center overflow-hidden bg-paper-900/40 ${
              zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
            }`}
            onPointerDown={startPan}
            onWheel={handleWheelZoom}
            style={{ touchAction: zoom > 1 ? 'none' : 'auto' }}
          >
            {images ? (
              <>
                <div className="pointer-events-none absolute left-4 top-4 z-10 flex gap-2">
                  <div className="rounded-full bg-ink-600 px-3 py-1 text-xs font-bold text-paper-25">Compressed</div>
                  <div
                    className={`rounded-full border border-white/10 px-3 py-1 text-xs font-bold text-paper-25 shadow-lg ${
                      dpi < 100 ? 'bg-danger-600' : 'bg-black/65'
                    }`}
                  >
                    {dpi < 100 ? 'Low detail' : dpi < 175 ? 'Medium detail' : 'High detail'}
                  </div>
                </div>
                <img
                  src={images.compressed}
                  alt="Compressed"
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
              <div className="text-sm text-paper-400">Loading…</div>
            )}
          </div>
        </div>

        <div className="z-20 flex flex-col gap-3 border-t border-paper-600 bg-paper-950 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          {/* The slider's two ends are named; nothing else about it needs
              saying, and the scale and JPEG quality behind it are numbers the
              two panes above already show the effect of. */}
          <div className="flex w-full items-center gap-3 lg:w-[52%]">
            <span className="text-xs font-medium text-paper-400">Low</span>
            <ChefSlider
              min={0}
              max={100}
              step={0.1}
              value={sliderValue}
              onChange={applyQualitySlider}
              ariaLabel="Compression quality"
              className="flex-1"
            />
            <span className="text-xs font-medium text-paper-400">High</span>
          </div>

          {dpi < 100 && (
            <p role="status" className="w-full text-sm font-medium text-caution-300">
              At this setting small print may be hard to read. Drag the slider towards High for more detail.
            </p>
          )}

          <div className="flex w-full flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-end">
            {sizeEstimate && (
              <div className={`text-right ${loading ? 'opacity-60' : 'opacity-100'}`}>
                <div className="tabular flex items-center justify-end gap-2 text-xl font-bold text-paper-25">
                  <HardDrive aria-hidden size={18} className="text-paper-400" />~{formatSize(sizeEstimate.estimatedSize)}
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-bold ${
                      sizeEstimate.ratio >= 1 ? 'bg-caution-900 text-caution-300' : 'bg-success-900 text-success-300'
                    }`}
                  >
                    {sizeEstimate.ratio >= 1 ? 'Not smaller' : `${Math.round((1 - sizeEstimate.ratio) * 100)}% smaller`}
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
              {dpi < 100 && <AlertTriangle aria-hidden size={18} />}
              Compress
            </button>
          </div>
        </div>
      </motion.div>
    </div>
    </Portal>
  );
};
