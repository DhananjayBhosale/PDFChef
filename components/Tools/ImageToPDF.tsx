import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';

import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { ProcessingStatus } from '../../types';
import { createPDFFromLayout, type PDFPageLayout } from '../../services/pdfLazy';
import { getContainedImageSize, preparePdfImageAsset, rotatePreparedPdfImageAsset } from '../../services/imageBrowser';
import { mapWithConcurrency } from '../../services/mapWithConcurrency';
import { imageProblemOf, skippedImagesMessage, type SkippedImage } from '../../services/imageIntake';
import { downloadBlob, revokeObjectUrls } from '../../services/pdfShared';
import { AlertTriangle, X, ArrowDown, Loader2, FileImage, Plus, Trash2, Move, RotateCw, ChevronLeft, ZoomIn } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';
import { ZoomControls } from '../UI/ZoomControls';
import { useZoom } from '../../hooks/useZoom';
import { usePdfPinchZoom } from '../../hooks/usePdfPinchZoom';
import { useDragReorder } from '../../hooks/useDragReorder';
import { useFileDrop } from '../../hooks/useFileDrop';
import { useConfirmDiscard } from '../../hooks/useConfirmDiscard';
import { useWorkInput } from '../UI/workSignature';
import { createPortal } from 'react-dom';
import { StatusToast } from '../UI/StatusToast';
import { ConfirmSheet, StatusLine } from '../UI/Primitives';
import { ToolScreen } from '../Tool/ToolScreen';
import { ResultSlot, useToolAnnounce } from '../Tool/parts';
import { Pop, openerProps, usePop } from '../Tool/Popover';
import { useWide } from '../../hooks/useMediaQuery';
import { photoOutputName } from '../UI/format';

const MAX_IMAGE_TO_PDF_FILES = 100;
const IMAGE_PREPARE_CONCURRENCY = 2;
/** The pages zoom to 400%, as in Edit PDF (fable-2 item 20). */
const I2P_MAX_ZOOM = 4;


// Data Model
interface ImageElement {
  id: string;
  file: File;
  previewUrl: string;
  x: number; // 0-1
  y: number; // 0-1
  width: number; // 0-1
  height: number; // 0-1 aspect ratio preserved by default
  aspectRatio: number;
}

interface PageData {
  id: string;
  elements: ImageElement[];
}

const createImageElement = async (
  file: File,
  maxFraction: number,
  position?: { x: number; y: number },
): Promise<ImageElement> => {
  const asset = await preparePdfImageAsset(file);
  const { width, height } = getContainedImageSize(asset.aspectRatio, maxFraction);

  return {
    id: uuidv4(),
    file: asset.file,
    previewUrl: asset.previewUrl,
    x: position ? position.x : (1 - width) / 2,
    y: position ? position.y : (1 - height) / 2,
    width,
    height,
    aspectRatio: asset.aspectRatio,
  };
};

/** Each picture on its own: one that cannot be opened is set aside by name, never the whole choice. */
const createImageElements = async (
  files: File[],
  maxFraction: number,
  position?: { x: number; y: number },
) => {
  const results = await mapWithConcurrency(files, IMAGE_PREPARE_CONCURRENCY, async (file) => {
    try {
      return { element: await createImageElement(file, maxFraction, position) };
    } catch (error) {
      return { skipped: { name: file.name, problem: imageProblemOf(error) } satisfies SkippedImage };
    }
  });
  return {
    elements: results.flatMap((result) => result.element ? [result.element] : []),
    skipped: results.flatMap((result) => result.skipped ? [result.skipped] : []),
  };
};

// --- SUB-COMPONENTS ---

const DraggableResizableImage: React.FC<{ 
   element: ImageElement, 
   pageId: string,
   containerRef: React.RefObject<HTMLDivElement>,
   onUpdate: (u: Partial<ImageElement>) => void,
   onRemove: () => void,
   onRotate: () => void,
   onDragStart: (e: React.PointerEvent, pageId: string, element: ImageElement, containerRef: React.RefObject<HTMLDivElement>) => void,
   zoom: number,
   isDraggingGlobally: boolean
}> = ({ element, pageId, containerRef, onUpdate, onRemove, onRotate, onDragStart, zoom, isDraggingGlobally }) => {
  useI18n();
  const [resizingHandle, setResizingHandle] = useState<string | null>(null);
  const startRef = useRef({ pointerId: -1, x: 0, y: 0, ex: 0, ey: 0, w: 0, h: 0, element: { x: 0, y: 0, width: 0, height: 0 } });

  useLayoutEffect(() => {
    if (!resizingHandle) return;

    // The resize follows the finger that started it. A second finger is a pinch: the picture goes
    // back to its starting size and the resize ends, as the free drag does (s4-03).
    const handlePointerMove = (e: PointerEvent) => {
      if (!containerRef.current || e.pointerId !== startRef.current.pointerId) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pageWidth_px = rect.width;
      const pageHeight_px = rect.height;

      const dx = e.clientX - startRef.current.x;
      const initialH = startRef.current.h / pageHeight_px;
      const initialX = startRef.current.ex / pageWidth_px;
      const initialY = startRef.current.ey / pageHeight_px;

      let newW_px = resizingHandle.includes('right') 
        ? startRef.current.w + dx 
        : startRef.current.w - dx;
      
      const newW = newW_px / pageWidth_px;
      const newH_px = newW_px / element.aspectRatio;
      const newH = newH_px / pageHeight_px;
      
      let newX = resizingHandle.includes('right') 
        ? initialX 
        : (startRef.current.ex + dx) / pageWidth_px;
        
      let newY = resizingHandle.includes('top') 
        ? initialY - (newH - initialH) 
        : initialY;

      onUpdate({ 
         x: Math.max(0, newX), 
         y: Math.max(0, newY),
         width: Math.max(0.05, newW), 
         height: Math.max(0.05, newH) 
      });
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (e.pointerId !== startRef.current.pointerId) return;
      setResizingHandle(null);
    };

    const handleSecondFinger = (e: PointerEvent) => {
      if (e.pointerId === startRef.current.pointerId) return;
      onUpdate(startRef.current.element);
      setResizingHandle(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointerdown', handleSecondFinger, true);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointerdown', handleSecondFinger, true);
    };
  }, [resizingHandle, onUpdate, zoom, element.aspectRatio, element.height, element.x, element.y, containerRef]);

  const handleDown = (e: React.PointerEvent) => {
     e.stopPropagation();
     onDragStart(e, pageId, element, containerRef);
  };

  const handleResizeDown = (e: React.PointerEvent, handle: string) => {
     e.stopPropagation();
     setResizingHandle(handle);
     const rect = containerRef.current!.getBoundingClientRect();
     const pageWidth_px = rect.width;
     const pageHeight_px = rect.height;

     startRef.current = { 
        pointerId: e.pointerId,
        element: { x: element.x, y: element.y, width: element.width, height: element.height },
        x: e.clientX, y: e.clientY, 
        ex: element.x * pageWidth_px, ey: element.y * pageHeight_px,
        w: element.width * pageWidth_px, h: element.height * pageHeight_px
     };
  };

  return (
     <div
        onPointerDown={handleDown}
        className={`absolute group select-none transition-shadow ${!!resizingHandle ? 'ring-2 ring-blue-500 z-50 shadow-2xl' : 'hover:ring-1 hover:ring-blue-400 z-10'}`}
        style={{
           left: `${element.x * 100}%`,
           top: `${element.y * 100}%`,
           width: `${element.width * 100}%`,
           height: `${element.height * 100}%`,
           cursor: 'grab',
           opacity: isDraggingGlobally ? 0 : 1,
           pointerEvents: isDraggingGlobally ? 'none' : 'auto',
           touchAction: 'none'
        }}
     >
        <img src={element.previewUrl} alt={t("image-to-pdf.image.placed.on.pdf.page.74b8c9")} className="w-full h-full object-contain pointer-events-none" />
        
        {/* Controls */}
        <div className="tk-i2p-imgtools absolute z-20 flex">
           <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRotate(); }} aria-label={t("image-to-pdf.rotate.image.clockwise.f4d156")} className="tk-i2p-imgbtn chef-pressable">
              <RotateCw size={14}/>
           </button>
           <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRemove(); }} aria-label={t("image-to-pdf.remove.image.da7aca")} className="tk-i2p-imgbtn tk-i2p-imgbtn-danger chef-pressable">
              <X size={14}/>
           </button>
        </div>

        {/* Resize Handles - All Corners */}
        {[
          { pos: 'bottom-right', cursor: 'nwse-resize' },
          { pos: 'bottom-left', cursor: 'nesw-resize' },
          { pos: 'top-right', cursor: 'nesw-resize' },
          { pos: 'top-left', cursor: 'nwse-resize' }
        ].map((handle) => (
          <div 
             key={handle.pos}
             onPointerDown={(e) => handleResizeDown(e, handle.pos)}
             className={`absolute w-3 h-3 bg-white border-2 border-[var(--accent-rest)] rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-20 shadow-sm ${
               handle.pos === 'bottom-right' ? '-bottom-1.5 -right-1.5' : 
               handle.pos === 'bottom-left' ? '-bottom-1.5 -left-1.5' :
               handle.pos === 'top-right' ? '-top-1.5 -right-1.5' :
               '-top-1.5 -left-1.5'
             }`}
             style={{ cursor: handle.cursor }}
          />
        ))}
        
        {/* Visual feedback for dragging/resizing */}
        {(!!resizingHandle) && (
          <div className="absolute inset-0 bg-blue-500/10 pointer-events-none" />
        )}
     </div>
  );
};

const CanvasPage: React.FC<{
  page: PageData,
  zoom: number,
  updateElement: (pageId: string, elementId: string, updates: Partial<ImageElement>) => void,
  removeElement: (pageId: string, elementId: string) => void,
  rotateElement: (pageId: string, element: ImageElement) => void,
  onImageDragStart: (e: React.PointerEvent, pageId: string, element: ImageElement, containerRef: React.RefObject<HTMLDivElement>) => void,
  activeImageDragId: string | null
}> = ({ page, zoom, updateElement, removeElement, rotateElement, onImageDragStart, activeImageDragId }) => {
  useI18n();
  const pageRef = useRef<HTMLDivElement>(null);

  return (
    <div 
      className="relative overflow-hidden bg-white shadow-[var(--elevation-panel)] ring-1 ring-paper-300"
      style={{ width: '100%', aspectRatio: '210/297' }} // A4 Ratio
      ref={pageRef}
      data-page-id={page.id}
    >
      {page.elements.map(el => (
         <DraggableResizableImage 
            key={el.id} 
            element={el} 
            pageId={page.id}
            containerRef={pageRef}
            onUpdate={(u) => updateElement(page.id, el.id, u)}
            onRemove={() => removeElement(page.id, el.id)}
            onRotate={() => rotateElement(page.id, el)}
            onDragStart={onImageDragStart}
            zoom={zoom}
            isDraggingGlobally={activeImageDragId === el.id}
         />
      ))}
    </div>
  );
};

export const ImageToPDF: React.FC = () => {
  useI18n();
  const [pages, setPages] = useState<PageData[]>([]);
  const announce = useToolAnnounce();
  const [savedPages, setSavedPages] = useState<PageData[] | null>(null);
  const discardSheet = useConfirmDiscard(pages.length > 0 && pages !== savedPages);
  // The pages are the input of the result strip's file (workSignature.ts).
  useWorkInput(pages);
  // Clear all asks first, as Create PDF's does (round 5, mobile-05): it empties the whole document.
  const [confirmClear, setConfirmClear] = useState(false);
  // After the first photos arrive the picker that had focus is gone: Save PDF takes it, so the next
  // key press is not a walk through every page's buttons (round 5, desktop-06: 19 Tabs to Save).
  const saveRef = useRef<HTMLButtonElement>(null);
  const focusSaveOnLoad = useRef(false);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  // Decoding a handful of camera photos takes seconds on a phone; say so instead of looking stuck.
  // A count, because the empty screen and a page's own picker can each add images at once.
  const [imagesBeingAdded, setImagesBeingAdded] = useState(0);
  const addingImages = imagesBeingAdded > 0;
  const { zoom, zoomIn, zoomOut, resetZoom, setExactZoom } = useZoom(1.0, 0.5, I2P_MAX_ZOOM, 0.25);
  const wide = useWide();
  const viewPop = usePop();
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  // Two fingers (or Ctrl+wheel) on the pages zoom them too, as in Read PDF; View keeps − and + (pass 5).
  const setPinchViewport = usePdfPinchZoom({ zoom, setZoom: setExactZoom, min: 0.5, max: I2P_MAX_ZOOM });
  const setCanvasViewport = useCallback((node: HTMLDivElement | null) => {
    canvasViewportRef.current = node;
    setPinchViewport(node);
  }, [setPinchViewport]);
  const [canvasViewportWidth, setCanvasViewportWidth] = useState(0);
  
  // Reorder Engine for Pages
  const { activeId, dragHandlers, registerItem, overlayStyle } = useDragReorder<PageData>({
    items: pages,
    onReorder: setPages,
    keyExtractor: p => p.id,
    scrollContainerRef: canvasViewportRef,
  });

  // Free Drag State for Images
  const [activeImageDrag, setActiveImageDrag] = useState<{
    pageId: string;
    element: ImageElement;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const previewUrlsRef = useRef<Set<string>>(new Set());

  const handleImageDragStart = useCallback((e: React.PointerEvent, pageId: string, element: ImageElement, containerRef: React.RefObject<HTMLDivElement>) => {
    e.stopPropagation();
    const rect = containerRef.current!.getBoundingClientRect();
    const width = rect.width * element.width;
    const height = rect.height * element.height;
    const elementLeft = rect.left + rect.width * element.x;
    const elementTop = rect.top + rect.height * element.y;
    
    setActiveImageDrag({
      pageId,
      element,
      offsetX: e.clientX - elementLeft,
      offsetY: e.clientY - elementTop,
      width,
      height,
      clientX: e.clientX,
      clientY: e.clientY
    });
  }, []);

  useLayoutEffect(() => {
    if (!activeImageDrag) return;

    const handleMove = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      setActiveImageDrag(prev => prev ? { ...prev, clientX: e.clientX, clientY: e.clientY } : null);
    };
    // A second finger is a pinch: the picture stays where it was.
    const handleSecondFinger = (e: PointerEvent) => {
      if (!e.isPrimary) setActiveImageDrag(null);
    };

    const handleUp = (e: PointerEvent) => {
      setActiveImageDrag(prev => {
        if (!prev) return null;

        const elements = document.elementsFromPoint(e.clientX, e.clientY);
        const pageNode = elements.find(el => el.hasAttribute('data-page-id'));
        
        if (pageNode) {
          const targetPageId = pageNode.getAttribute('data-page-id')!;
          const rect = pageNode.getBoundingClientRect();
          
          const dropX = e.clientX - prev.offsetX;
          const dropY = e.clientY - prev.offsetY;
          
          const newX = (dropX - rect.left) / rect.width;
          const newY = (dropY - rect.top) / rect.height;
          const newWidth = prev.width / rect.width;
          const newHeight = prev.height / rect.height;

          setPages(prevPages => {
            let newPages = [...prevPages];
            
            // Remove from old page
            newPages = newPages.map(p => {
              if (p.id === prev.pageId) {
                return { ...p, elements: p.elements.filter(el => el.id !== prev.element.id) };
              }
              return p;
            });
            
            // Add to new page
            newPages = newPages.map(p => {
              if (p.id === targetPageId) {
                return { 
                  ...p, 
                  elements: [...p.elements, { 
                    ...prev.element, 
                    x: newX, 
                    y: newY,
                    width: newWidth,
                    height: newHeight
                  }] 
                };
              }
              return p;
            });
            
            return newPages;
          });
        }
        
        return null;
      });
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointerdown', handleSecondFinger, true);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointerdown', handleSecondFinger, true);
    };
  }, [activeImageDrag ? true : false]);

  useEffect(() => {
    const nextUrls = new Set(
      pages.flatMap((page) => page.elements.map((element) => element.previewUrl)),
    );

    for (const url of previewUrlsRef.current) {
      if (!nextUrls.has(url)) {
        revokeObjectUrls([url]);
      }
    }

    previewUrlsRef.current = nextUrls;
  }, [pages]);

  useEffect(() => {
    return () => {
      revokeObjectUrls(previewUrlsRef.current);
    };
  }, []);

  useEffect(() => {
    const node = canvasViewportRef.current;
    if (!node) return;

    const updateWidth = () => {
      setCanvasViewportWidth(node.clientWidth);
    };

    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(node);
    return () => observer.disconnect();
  }, [pages.length]);

  // Initialize with pages if files dropped
  const handleFilesSelected = async (newFiles: File[]) => {
    const images = newFiles.filter(f => f.type.startsWith('image/'));
    if (images.length === 0) return;
    const currentImageCount = pages.reduce((total, page) => total + page.elements.length, 0);
    const availableSlots = Math.max(0, MAX_IMAGE_TO_PDF_FILES - currentImageCount);
    const acceptedImages = images.slice(0, availableSlots);
    if (acceptedImages.length === 0) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("image-to-pdf.image.to.pdf.supports.up.to.images.f8e117", { v0: MAX_IMAGE_TO_PDF_FILES }) });
      return;
    }
    
    // Create a new page for each image by default (standard flow)
    setImagesBeingAdded(count => count + 1);
    let prepared: Awaited<ReturnType<typeof createImageElements>>;
    try {
      prepared = await createImageElements(acceptedImages, 0.8);
    } finally {
      setImagesBeingAdded(count => count - 1);
    }
    const { elements, skipped } = prepared;
    setPages(prev => [...prev, ...elements.map((element) => ({ id: uuidv4(), elements: [element] }))]);
    const limitNotice = acceptedImages.length < images.length
      ? t("image-to-pdf.added.images.the.image.limit.has.been.83b23e", { count: elements.length, v1: MAX_IMAGE_TO_PDF_FILES })
      : '';
    setStatus({
      isProcessing: false,
      progress: 0,
      message: limitNotice,
      // A picture that cannot be opened is left out by name; the rest of the choice is kept.
      error: skipped.length ? [skippedImagesMessage(skipped), limitNotice].filter(Boolean).join(' ') : undefined,
    });
  };

  const addEmptyPage = () => {
    setPages(prev => [...prev, { id: uuidv4(), elements: [] }]);
  };

  const removePage = (id: string) => {
    const index = pages.findIndex(p => p.id === id);
    setPages(prev => prev.filter(p => p.id !== id));
    if (index >= 0) announce(t('tool.removed', { v0: t('page-thumbnail.page.c140ba', { v0: index + 1 }) }));
  };

  const removeElement = (pageId: string, elementId: string) => {
    setPages(prev => prev.map(p => {
       if (p.id !== pageId) return p;
       return { ...p, elements: p.elements.filter(e => e.id !== elementId) };
    }));
  };

  const updateElement = useCallback((pageId: string, elementId: string, updates: Partial<ImageElement>) => {
    setPages(prev => prev.map(p => {
       if (p.id !== pageId) return p;
       return { ...p, elements: p.elements.map(e => e.id === elementId ? { ...e, ...updates } : e) };
    }));
  }, []);

  const rotateElement = useCallback(async (pageId: string, element: ImageElement) => {
    try {
      const asset = await rotatePreparedPdfImageAsset(element.file, 90);
      const maxFraction = Math.max(element.width, element.height);
      const size = getContainedImageSize(asset.aspectRatio, maxFraction);
      const centerX = element.x + element.width / 2;
      const centerY = element.y + element.height / 2;
      updateElement(pageId, element.id, {
        file: asset.file,
        previewUrl: asset.previewUrl,
        aspectRatio: asset.aspectRatio,
        width: size.width,
        height: size.height,
        x: Math.max(0, Math.min(1 - size.width, centerX - size.width / 2)),
        y: Math.max(0, Math.min(1 - size.height, centerY - size.height / 2)),
      });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("image-to-pdf.this.picture.could.not.be.turned.try.2c4843") });
    }
  }, [updateElement]);

  const handleConvert = async () => {
    if (pages.length === 0) return;
    setStatus({ isProcessing: true, progress: 10, message: t("image-to-pdf.building.pdf.7b0776") });
    try {
      const layout: PDFPageLayout[] = pages.map(p => ({
         width: 595.28,
         height: 841.89,
         elements: p.elements.map(e => ({
            file: e.file,
            x: e.x,
            y: e.y,
            width: e.width,
            height: e.height
         }))
      }));
      
      const pdfBytes = await createPDFFromLayout(layout);
      setStatus({ isProcessing: true, progress: 90, message: t("image-to-pdf.preparing.pdf.cbcaaa") });
      const firstImage = pages.flatMap((page) => page.elements)[0];
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        photoOutputName(firstImage?.file.name, t("tool-catalog.image.to.pdf.966eba")),
        'application/pdf',
      );
      setSavedPages(pages);
      setStatus({ isProcessing: false, progress: 100, message: t("image-to-pdf.pdf.is.ready.34a5a8") });
    } catch (e) {
      console.error(e);
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("image-to-pdf.the.pdf.could.not.be.created.from.b4534e") });
    }
  };

  // The page builder earns the whole screen; a drop zone does not. Until the
  // first image lands this is an ordinary tool screen, with the shell's Tools
  // navigation above it and the tab bar below it.

  const activePage = pages.find(p => p.id === activeId);
  const measuredCanvasWidth = canvasViewportWidth || (typeof window !== 'undefined' ? window.innerWidth : 794);
  const usableCanvasWidth = Math.max(240, measuredCanvasWidth - (measuredCanvasWidth < 640 ? 32 : 96));
  const basePageWidth = Math.min(794, usableCanvasWidth);
  const renderedPageWidth = basePageWidth * zoom;

  const title = t("image-to-pdf.image.to.pdf.966eba");
  const toast = <StatusToast status={status} />;

  // A picture dropped on the loaded editor becomes a new page (research r3, desktop-06).
  useFileDrop({ accept: pages.length ? 'image/*' : '', onFiles: handleFilesSelected });

  const hasPages = pages.length > 0;
  useLayoutEffect(() => {
    if (!hasPages) {
      focusSaveOnLoad.current = true;
      return;
    }
    if (!focusSaveOnLoad.current || addingImages) return;
    focusSaveOnLoad.current = false;
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || !active.isConnected || active.id === 'main') saveRef.current?.focus({ preventScroll: true });
  }, [hasPages, addingImages]);

  if (pages.length === 0) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept="image/*" multiple label={t("image-to-pdf.choose.images.for.your.pdf.58f369")} error={status.error} />
            <div role="status" aria-live="polite">
              {addingImages && (
                <StatusLine tone="info" icon={<Loader2 className="animate-spin" size={16} />}>
                  {t("image-to-pdf.adding.images.8a4d34")}
                </StatusLine>
              )}
            </div>
          </div>
        )}
        toast={toast}
      />
    );
  }

  const saveButton = (
    <button
      ref={saveRef}
      type="button"
      onClick={handleConvert}
      disabled={status.isProcessing || pages.length === 0 || addingImages}
      className="tk-primary tk-primary-inline chef-pressable"
    >
      {status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <ArrowDown aria-hidden size={18} />}
      <span>{t("image-to-pdf.save.pdf.2462a8")}</span>
    </button>
  );

  const backToDashboard = (
    // The kit's back chevron (T-16): the undo arrow read as "undo the last change".
    <Link to="/" aria-label={t("image-to-pdf.back.to.dashboard.b59e0c")} title={t("image-to-pdf.back.to.dashboard.b59e0c")} className="tk-back chef-pressable">
      <ChevronLeft aria-hidden size={22} strokeWidth={1.75} className="rtl:rotate-180" />
    </Link>
  );

  const addPagesControl = (className: string, iconSize: number) => (
    <label className={`${className} tk-i2p-add chef-pressable`}>
      {addingImages ? <Loader2 aria-hidden className="animate-spin" size={iconSize}/> : <FileImage aria-hidden size={iconSize}/>}<span>{addingImages ? t("image-to-pdf.adding.images.8a4d34") : t("image-to-pdf.add.pages.6a7668")}</span><input type="file" multiple accept="image/*" aria-disabled={addingImages || undefined} aria-label={t("image-to-pdf.add.new.pages.from.images.b8c579")} className="sr-only" onClick={e => { if (addingImages) e.preventDefault(); }} onChange={e => e.target.files && handleFilesSelected(Array.from(e.target.files))} />
    </label>
  );
  const clearAll = () => setConfirmClear(true);
  const pageLabel = (i: number) => t("image-to-pdf.message.c140ba4857", { v0: i + 1 });
  // The page's own row (its name, Add image, Remove) leads it, so a tapped page starts at the top of
  // the canvas: centred, a page taller than the canvas had that row cut off (research r1, mobile-07).
  const showPage = (id: string) => canvasViewportRef.current?.querySelector(`[data-page-id="${id}"]`)?.closest<HTMLElement>('.tk-i2p-pagebox')?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  const body = (
    <div className={`tk-i2p${wide ? '' : ' tk-i2p-phone'}`}>
      {wide && <ResultSlot className="tk-editor-result" />}
      {/* Phone (T-02): first in the document so Save PDF comes before the pages, drawn at the foot
          (verify V-01). The page tools are one row of tabs, as in Edit PDF; zoom is a foot sheet. */}
      {!wide && (
        <div className="tk-footbar">
          <ResultSlot />
          <div className="tk-foot-tabs">
            {addPagesControl('tk-foot-tab', 20)}
            <button type="button" onClick={addEmptyPage} className="tk-foot-tab chef-pressable"><Plus aria-hidden size={20}/><span>{t("image-to-pdf.blank.page.81bf3a")}</span></button>
            <button {...openerProps(viewPop, 'i2p-view', 'view')} className="tk-foot-tab chef-pressable"><ZoomIn aria-hidden size={20}/><span>{t("image-to-pdf.view.dcc839")}</span></button>
            <button type="button" onClick={clearAll} disabled={addingImages} className="tk-foot-tab tk-foot-tab-danger chef-pressable"><Trash2 aria-hidden size={20}/><span>{t("image-to-pdf.clear.all.29a390")}</span></button>
          </div>
          <span role="status" aria-live="polite" className="sr-only">{addingImages ? t("image-to-pdf.adding.images.8a4d34") : ''}</span>
          <div className="tk-actions">{saveButton}</div>
          <Pop pop={viewPop} id="i2p-view" title={t("image-to-pdf.view.dcc839")}>
            <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} max={I2P_MAX_ZOOM} />
          </Pop>
        </div>
      )}
      {/* Phone: the pages as one filmstrip over the canvas; a tap shows that page. */}
      {!wide && (
        <div className="tk-i2p-strip chef-scroller" role="list" aria-label={t("image-to-pdf.pages.9046da")}>
          {pages.map((p, i) => (
            <div key={p.id} role="listitem" className="tk-i2p-film" data-active={activeId === p.id ? '' : undefined}>
              <button type="button" onClick={() => showPage(p.id)} className="tk-i2p-film-page chef-pressable">
                <span aria-hidden className="tk-i2p-film-thumb">
                  {p.elements.slice(0, 4).map(el => <img key={el.id} src={el.previewUrl} alt="" style={{ left: `${el.x * 100}%`, top: `${el.y * 100}%`, width: `${el.width * 100}%`, height: `${el.height * 100}%` }} />)}
                </span>
                <span className="tabular">{pageLabel(i)}</span>
              </button>
              <button type="button" onClick={() => removePage(p.id)} aria-label={t("image-to-pdf.remove.page.0a72af", { v0: i + 1 })} className="tk-iconbtn tk-iconbtn-danger chef-pressable"><Trash2 aria-hidden size={16}/></button>
            </div>
          ))}
        </div>
      )}
      <div className="tk-i2p-main">
            {/* Desktop: today's side panel. */}
            {wide && <div className="tk-i2p-side chef-scroller chef-edge-fade-y">
               <div className="tk-i2p-side-inner custom-scrollbar">
                  <section>
                     <div className="tk-i2p-sechead">
                       <h3 className="tk-i2p-cap">{t("image-to-pdf.document.actions.97fa07")}</h3>
                       <span className="tk-i2p-count tabular">{t('format.pageCount', { count: pages.length })}</span>
                     </div>
                     <div className="tk-i2p-actions">
                        {addPagesControl('tk-btn', 18)}
                        <button type="button" onClick={addEmptyPage} className="tk-btn chef-pressable">
                           <Plus aria-hidden size={18}/>{t("image-to-pdf.blank.page.81bf3a")}</button>
                        <button type="button" onClick={clearAll} disabled={addingImages} className="tk-btn tk-btn-danger chef-pressable">{t("image-to-pdf.clear.all.29a390")}</button>
                     </div>
                     <span role="status" aria-live="polite" className="sr-only">{addingImages ? t("image-to-pdf.adding.images.8a4d34") : ''}</span>
                  </section>

                  <section>
                     <h3 className="tk-i2p-cap">{t("image-to-pdf.view.dcc839")}</h3>
                     <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} max={I2P_MAX_ZOOM} />
                  </section>

                  <section>
                     <h3 className="tk-i2p-cap">{t("image-to-pdf.pages.9046da")}</h3>
                     <div className="tk-i2p-pages">
                        {pages.map((p, i) => (
                           <div 
                              key={p.id} 
                              className="tk-i2p-pagerow"
                              data-active={activeId === p.id ? '' : undefined}
                           >
                              <span className="flex items-center gap-2">{pageLabel(i)}</span>
                              <button type="button" onClick={() => removePage(p.id)} aria-label={t("image-to-pdf.remove.page.0a72af", { v0: i + 1 })} className="tk-iconbtn tk-iconbtn-danger chef-pressable"><Trash2 aria-hidden size={16}/></button>
                           </div>
                        ))}
                     </div>
                  </section>
               </div>
            </div>}

            {/* Main Canvas Scroll Area */}
            <div
               ref={setCanvasViewport}
               className="tk-i2p-canvas chef-gesture-clear custom-scrollbar"
            >
               <div 
                  className="mx-auto flex flex-col items-center gap-4 transition-all duration-200" 
                  style={{ 
                    width: renderedPageWidth,
                    minHeight: '100%'
                  }}
               >
                  {pages.map((page, i) => (
                     <div 
                        key={page.id}
                        ref={(el) => registerItem(page.id, el)}
                        className={`tk-i2p-pagebox group relative ${activeId === page.id ? 'opacity-0' : 'opacity-100'}`}
                        style={{ width: renderedPageWidth }}
                     >
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
                           <div className="flex flex-wrap items-center gap-2">
                              <div 
                                 className="tk-i2p-pill tk-i2p-grab"
                                 onPointerDown={(e) => dragHandlers.onPointerDown(e, page.id)}
                                 style={{ touchAction: 'none' }}
                              >
                                 <Move aria-hidden size={14} />{t("image-to-pdf.message.7647bcf3a2", { v0: i + 1 })}</div>
                              <label
                                 className="tk-i2p-pill tk-i2p-pill-btn chef-pressable"
                              >
                                 <Plus aria-hidden size={14} />{t("image-to-pdf.add.image.29139e")}<input
                                    type="file" 
                                    multiple 
                                    accept="image/*" 
                                    aria-label={t("image-to-pdf.add.an.image.to.this.page.20871a")}
                                    className="sr-only" 
                                    onChange={async e => {
                                       if (e.target.files) {
                                         const files = Array.from(e.target.files) as File[];
                                          setImagesBeingAdded(count => count + 1);
                                          let prepared: Awaited<ReturnType<typeof createImageElements>>;
                                          try {
                                            prepared = await createImageElements(files, 0.4, { x: 0.1, y: 0.1 });
                                          } finally {
                                            setImagesBeingAdded(count => count - 1);
                                          }
                                          const { elements: newElements, skipped } = prepared;
                                          setPages(prev => prev.map(p => p.id === page.id ? { ...p, elements: [...p.elements, ...newElements] } : p));
                                          if (skipped.length) setStatus({ isProcessing: false, progress: 0, message: '', error: skippedImagesMessage(skipped) });
                                       }
                                    }}
                                 />
                              </label>
                           </div>
                           <button type="button" onClick={() => removePage(page.id)} aria-label={t("image-to-pdf.remove.page.0a72af", { v0: i + 1 })} className="tk-iconbtn tk-iconbtn-danger tk-i2p-pageremove chef-pressable">
                              <Trash2 size={16}/>
                           </button>
                        </div>

                         <CanvasPage
                            page={page}
                            zoom={zoom}
                            updateElement={updateElement}
                            removeElement={removeElement}
                            rotateElement={rotateElement}
                            onImageDragStart={handleImageDragStart}
                            activeImageDragId={activeImageDrag?.element.id || null}
                         />
                     </div>
                  ))}
               </div>
            </div>
      </div>

      {/* Page Drag Overlay */}
      {activeId && activePage && createPortal(
         <div 
            className="pointer-events-none fixed z-50 bg-white opacity-90 shadow-[var(--elevation-sheet)] ring-2 ring-ink-500"
            style={{ 
               top: overlayStyle.top, 
               left: overlayStyle.left,
               width: overlayStyle.width,
               height: overlayStyle.height
            }}
         >
             {/* Simplified preview for performance */}
             <div className="flex h-full w-full items-center justify-center border border-dashed border-paper-400 bg-paper-50 text-xl font-bold text-paper-600">{t("image-to-pdf.moving.page.bd8dad")}</div>
         </div>,
         document.body
      )}

      {/* Image Drag Overlay */}
      {activeImageDrag && createPortal(
         <div 
            className="pointer-events-none fixed z-[60] opacity-90 shadow-[var(--elevation-sheet)] ring-2 ring-ink-500"
            style={{ 
               top: activeImageDrag.clientY - activeImageDrag.offsetY, 
               left: activeImageDrag.clientX - activeImageDrag.offsetX,
               width: activeImageDrag.width,
               height: activeImageDrag.height,
               cursor: 'grabbing'
            }}
         >
            <img src={activeImageDrag.element.previewUrl} className="w-full h-full object-contain pointer-events-none" />
         </div>,
         document.body
      )}
    </div>
  );

  return (
    <ToolScreen
      title={title}
      kind="editor"
      // Desktop keeps "Back to dashboard" at the start; on phones the tool's mark and name are that
      // link, as on every tool (owner decision D-1), with the same name.
      leading={wide ? backToDashboard : undefined}
      homeLabel={t("image-to-pdf.back.to.dashboard.b59e0c")}
      file={{ name: t('format.pageCount', { count: pages.length }) }}
      change={wide ? saveButton : undefined}
      body={body}
      extra={(
        <>
          {discardSheet}
          <ConfirmSheet
            open={confirmClear}
            title={t("make-pdf.remove.every.page.6c477e")}
            description={t("make-pdf.photos.on.your.device.and.any.pdf.f3658c")}
            confirmLabel={t("make-pdf.remove.all.ef7b7e")}
            onCancel={() => setConfirmClear(false)}
            onConfirm={() => {
              setConfirmClear(false);
              setPages([]);
              setStatus({ isProcessing: false, progress: 0, message: '' });
            }}
          />
        </>
      )}
      toast={toast}
    />
  );
};
