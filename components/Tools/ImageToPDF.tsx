import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';

import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { ProcessingStatus } from '../../types';
import { createPDFFromLayout, type PDFPageLayout } from '../../services/pdfDocument';
import { getContainedImageSize, preparePdfImageAsset, rotatePreparedPdfImageAsset } from '../../services/imageBrowser';
import { mapWithConcurrency } from '../../services/mapWithConcurrency';
import { imageProblemOf, skippedImagesMessage, type SkippedImage } from '../../services/imageIntake';
import { downloadBlob, revokeObjectUrls } from '../../services/pdfShared';
import { AlertTriangle, X, ArrowDown, Loader2, FileImage, Plus, Trash2, Move, RotateCw, Undo2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';
import { ZoomControls } from '../UI/ZoomControls';
import { useZoom } from '../../hooks/useZoom';
import { useDragReorder } from '../../hooks/useDragReorder';
import { useConfirmDiscard } from '../../hooks/useConfirmDiscard';
import { createPortal } from 'react-dom';
import { tools } from './toolCatalog';
import { ToolIdentity } from './ToolIdentity';
import { StatusToast } from '../UI/StatusToast';
import { StatusLine } from '../UI/Primitives';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { useImmersiveWorkspace } from '../Layout/AppShell';
import { datedOutputName } from '../UI/format';

const IMAGE_TO_PDF_TOOL = tools.find((tool) => tool.path === '/image-to-pdf');
const MAX_IMAGE_TO_PDF_FILES = 100;
const IMAGE_PREPARE_CONCURRENCY = 2;


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
  const startRef = useRef({ x: 0, y: 0, ex: 0, ey: 0, w: 0, h: 0 });

  useLayoutEffect(() => {
    if (!resizingHandle) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (!containerRef.current) return;
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

    const handlePointerUp = () => {
      setResizingHandle(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
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
        <div className="absolute right-1 top-1 z-20 flex gap-1 sm:-right-3 sm:-top-3 sm:hidden sm:group-hover:flex">
           <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRotate(); }} aria-label={t("image-to-pdf.rotate.image.clockwise.f4d156")} className="grid min-h-11 min-w-11 place-items-center rounded-full bg-[var(--accent-rest)] text-[var(--text-on-accent)] shadow-[var(--elevation-panel)] transition-colors hover:bg-[var(--accent-hover)] sm:min-h-0 sm:min-w-0 sm:p-1.5">
              <RotateCw size={14}/>
           </button>
           <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRemove(); }} aria-label={t("image-to-pdf.remove.image.da7aca")} className="grid min-h-11 min-w-11 place-items-center rounded-full bg-[var(--status-danger-text)] text-white shadow-[var(--elevation-panel)] transition-opacity hover:opacity-90 sm:min-h-0 sm:min-w-0 sm:p-1.5">
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
  const [savedPages, setSavedPages] = useState<PageData[] | null>(null);
  const discardSheet = useConfirmDiscard(pages.length > 0 && pages !== savedPages);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const { zoom, zoomIn, zoomOut, resetZoom } = useZoom(1.0, 0.5, 1.5, 0.25);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
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
      setActiveImageDrag(prev => prev ? { ...prev, clientX: e.clientX, clientY: e.clientY } : null);
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
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
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
    const { elements, skipped } = await createImageElements(acceptedImages, 0.8);
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
    setPages(prev => prev.filter(p => p.id !== id));
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
        datedOutputName(t("tool-catalog.image.to.pdf.966eba"), 'pdf'),
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
  useImmersiveWorkspace(pages.length > 0);

  const activePage = pages.find(p => p.id === activeId);
  const measuredCanvasWidth = canvasViewportWidth || (typeof window !== 'undefined' ? window.innerWidth : 794);
  const usableCanvasWidth = Math.max(240, measuredCanvasWidth - (measuredCanvasWidth < 640 ? 32 : 96));
  const basePageWidth = Math.min(794, usableCanvasWidth);
  const renderedPageWidth = basePageWidth * zoom;

  if (pages.length === 0) {
    return (
      <ToolShell centered>
        <ToolHeader title={t("image-to-pdf.image.to.pdf.966eba")} />
        <FileUpload onFilesSelected={handleFilesSelected} accept="image/*" multiple label={t("image-to-pdf.choose.images.for.your.pdf.58f369")} />
        {status.error && (
          <StatusLine tone="danger" icon={<AlertTriangle aria-hidden size={16} />}>
            {status.error}
          </StatusLine>
        )}
      </ToolShell>
    );
  }

  return (
    <div className="chef-safe-bottom flex h-[100dvh] min-h-[100dvh] w-full flex-col overflow-hidden bg-[var(--surface-canvas)]">

       {/* Header. An immersive route gets no shell chrome, so it consumes the
           status-bar inset itself rather than painting under the clock. */}
       <div className="chef-safe-top z-30 flex flex-shrink-0 flex-col gap-3 border-b border-[var(--border-hairline)] bg-[var(--surface-raised)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
         <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <Link to="/" aria-label={t("image-to-pdf.back.to.dashboard.b59e0c")} className="chef-target grid place-items-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-sunken)]">
               <Undo2 size={20} />
            </Link>
            <div className="flex min-w-0 items-center gap-2">
               {IMAGE_TO_PDF_TOOL && (
                 <ToolIdentity tool={IMAGE_TO_PDF_TOOL} size={20} assetSize={30} assetClassName="h-[30px] w-[30px] shrink-0 object-contain" />
               )}
               <div className="min-w-0">
                 <h1 className="break-words text-lg font-bold leading-none text-[var(--text-primary)]">{t("image-to-pdf.image.to.pdf.966eba")}</h1>
                 {pages.length > 0 && (
                   <p className="type-caption mt-1 text-[var(--text-tertiary)]">{t('format.pageCount', { count: pages.length })}</p>
                 )}
               </div>
            </div>
         </div>
         {pages.length > 0 && (
         <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:gap-3">
            <button type="button" onClick={() => { setPages([]); setStatus({ isProcessing: false, progress: 0, message: '' }); }} className="chef-target chef-pressable flex-1 rounded-[var(--radius-control)] px-3 text-sm font-bold text-[var(--status-danger-text)] transition-colors hover:bg-[var(--status-danger-quiet)] sm:flex-none">{t("image-to-pdf.clear.all.29a390")}</button>
            <button 
               onClick={handleConvert} 
               disabled={status.isProcessing || pages.length === 0}
               className="chef-target chef-pressable flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 font-bold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-55 sm:flex-none sm:px-6"
            >
               {status.isProcessing ? <Loader2 className="animate-spin" size={18}/> : <ArrowDown size={18}/>} 
               <span>{t("image-to-pdf.save.pdf.2462a8")}</span>
            </button>
         </div>
         )}
      </div>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
            {/* Sidebar Controls */}
            <div className="chef-scroller chef-edge-fade-y z-20 flex h-auto max-h-[min(60vh,max(46vh,20rem))] w-full flex-col overflow-y-auto border-b border-[var(--border-hairline)] bg-[var(--surface-raised)] lg:h-full lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
               <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto p-3">
                  <section>
                     <h3 className="type-caption mb-1.5 text-[var(--text-secondary)]">{t("image-to-pdf.document.actions.97fa07")}</h3>
                     <div className="grid grid-cols-2 gap-2">
                        <label className="chef-target chef-pressable flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] text-sm font-bold text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]">
                           <FileImage aria-hidden size={18}/>{t("image-to-pdf.add.pages.6a7668")}<input type="file" multiple accept="image/*" aria-label={t("image-to-pdf.add.new.pages.from.images.b8c579")} className="sr-only" onChange={e => e.target.files && handleFilesSelected(Array.from(e.target.files))} />
                        </label>
                        <button type="button" onClick={addEmptyPage} className="chef-target chef-pressable flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] text-sm font-bold text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)]">
                           <Plus aria-hidden size={18}/>{t("image-to-pdf.blank.page.81bf3a")}</button>
                     </div>
                  </section>

                  <section>
                     <h3 className="type-caption mb-1.5 text-[var(--text-secondary)]">{t("image-to-pdf.view.dcc839")}</h3>
                     <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
                  </section>

                  <section>
                     <h3 className="type-caption mb-1.5 text-[var(--text-secondary)]">{t("image-to-pdf.pages.9046da")}</h3>
                     <div className="space-y-2">
                        {pages.map((p, i) => (
                           <div 
                              key={p.id} 
                              className={`p-2 rounded-lg border text-xs font-medium flex items-center justify-between transition-colors ${activeId === p.id ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'border-[var(--border-hairline)] bg-[var(--surface-raised)] text-[var(--text-secondary)]'}`}
                           >
                              <span className="flex items-center gap-2">
                                 <Move size={12} className="opacity-40" />{t("image-to-pdf.message.c140ba4857", { v0: i + 1 })}</span>
                              <button onClick={() => removePage(p.id)} aria-label={t("image-to-pdf.remove.page.0a72af", { v0: i + 1 })} className="chef-target grid place-items-center text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)] rounded-[var(--radius-control)]"><Trash2 size={14}/></button>
                           </div>
                        ))}
                     </div>
                  </section>
               </div>
            </div>

            {/* Main Canvas Scroll Area */}
            <div
               ref={canvasViewportRef}
               className="chef-gesture-clear custom-scrollbar relative flex-1 overflow-auto bg-[var(--surface-sunken)] p-3 sm:p-6 lg:p-10"
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
                        className={`group relative ${activeId === page.id ? 'opacity-0' : 'opacity-100'}`}
                        style={{ width: renderedPageWidth }}
                     >
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
                           <div className="flex flex-wrap items-center gap-2">
                              <div 
                                 className="flex cursor-grab items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-1 text-xs font-bold text-[var(--text-secondary)] hover:text-[var(--accent-text)] active:cursor-grabbing"
                                 onPointerDown={(e) => dragHandlers.onPointerDown(e, page.id)}
                                 style={{ touchAction: 'none' }}
                              >
                                 <Move aria-hidden size={14} />{t("image-to-pdf.message.7647bcf3a2", { v0: i + 1 })}</div>
                              <label
                                 className="chef-target flex cursor-pointer items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-xs font-bold text-[var(--text-secondary)] transition-colors hover:text-[var(--accent-text)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]"
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
                                          const { elements: newElements, skipped } = await createImageElements(files, 0.4, { x: 0.1, y: 0.1 });
                                          setPages(prev => prev.map(p => p.id === page.id ? { ...p, elements: [...p.elements, ...newElements] } : p));
                                          if (skipped.length) setStatus({ isProcessing: false, progress: 0, message: '', error: skippedImagesMessage(skipped) });
                                       }
                                    }}
                                 />
                              </label>
                           </div>
                           <button type="button" onClick={() => removePage(page.id)} aria-label={t("image-to-pdf.remove.page.0a72af", { v0: i + 1 })} className="chef-target grid place-items-center rounded-full border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--status-danger-text)] transition-colors hover:bg-[var(--status-danger-quiet)]">
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
      <StatusToast status={status} />
      {discardSheet}
    </div>
  );
};
