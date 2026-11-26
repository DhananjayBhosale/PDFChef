import { t } from '../../services/i18n/core.ts';
import { pdfProblemMessage } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { ToolScreen } from '../Tool/ToolScreen';
import { SharpPageLayer } from '../Tool/SharpPageLayer';
import { ActionRow, ResultSlot, useAnnouncer } from '../Tool/parts';
import {
  ChevronLeft,
  ChevronRight,
  Expand,
  Loader2,
  Plus,
  RotateCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { ChefSliderField } from '../UI/ChefSlider';
import { ZoomControls } from '../UI/ZoomControls';
import { Portal } from '../UI/Primitives';
import { PDFFile, ProcessingStatus } from '../../types';
import { MAX_ZOOM, useZoom } from '../../hooks/useZoom';
import { usePdfPinchZoom } from '../../hooks/usePdfPinchZoom';
import { useFileDrop } from '../../hooks/useFileDrop';
import { useDiscardPrompt, useLeaveGuarded } from '../../hooks/useConfirmDiscard';
import { ChangeFile } from '../Tool/ToolTop';
import { useWorkInput } from '../UI/workSignature';
import { applySignaturesToPDF, loadPDFDocument } from '../../services/pdfLazy';
import { getPdfRenderScale } from '../../services/pdfPageGeometry';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { normalizeImageFile } from '../../services/imageBrowser';
import { imageProblemOf } from '../../services/imageIntake';
import { planImageNormalization } from '../../services/imageNormalization';
import { SegmentedControl } from '../UI/Primitives';
import { StatusToast } from '../UI/StatusToast';
import { toolOutputName } from '../UI/format';
import { MQ_LG, useWide } from '../../hooks/useMediaQuery';

interface SignatureItem {
  localId: string;
  id: string;
  pageIndex: number;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  aspectRatio: number;
}

type EditMode = 'drag' | 'resize' | null;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const getPoint = (event: PointerEvent | React.PointerEvent) => ({ x: event.clientX, y: event.clientY });

/**
 * A signature prints a few centimetres wide. 2 MP keeps it sharp at any size it can be dragged
 * to, where a 50 MP photo kept whole froze the page and made a 100 MB PDF.
 */
const MAX_SIGNATURE_PIXELS = 2_000_000;

/** Decode the picked picture once, upright and at signature size, before anything else uses it. */
const shrinkSignatureImage = (file: File) => normalizeImageFile(file, { maxPixels: MAX_SIGNATURE_PIXELS });

const signaturePictureError = (error: unknown) => imageProblemOf(error) === 'too-large'
  ? t("image-intake.this.picture.is.too.large.to.open.c199e6")
  : t("sign-pdf.this.signature.picture.could.not.be.read.43b251");

const readDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(t("sign-pdf.unable.to.read.image.146e6e")));
  reader.onerror = () => reject(new Error(t("sign-pdf.unable.to.read.image.146e6e")));
  reader.readAsDataURL(blob);
});

const makeWhiteClear = (context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, threshold: number) => {
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const softness = 18;

  for (let index = 0; index < pixels.length; index += 4) {
    const brightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
    if (brightness >= threshold) {
      pixels[index + 3] = 0;
      continue;
    }

    if (brightness > threshold - softness) {
      const distance = threshold - brightness;
      pixels[index + 3] = Math.round((distance / softness) * pixels[index + 3]);
    }
  }

  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
};

/** The shrunk picture as a stamp, with its white paper made clear or kept as it is. */
const createSignatureStamp = async (source: File, transparent: boolean, threshold = 242) => {
  if (!transparent) return readDataUrl(source);
  const url = URL.createObjectURL(source);
  const image = new Image();
  image.decoding = 'async';

  const canvas = document.createElement('canvas');
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(t("sign-pdf.this.signature.picture.could.not.be.read.43b251")));
      image.src = url;
    });
    // Already shrunk; the cap here only guards a caller that forgot.
    const plan = planImageNormalization(image.naturalWidth, image.naturalHeight, 'image/png', MAX_SIGNATURE_PIXELS);
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t("sign-pdf.this.signature.picture.could.not.be.read.43b251"));
    context.drawImage(image, 0, 0, plan.width, plan.height);
    return makeWhiteClear(context, canvas, threshold);
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
};

const rotateSignatureImage = async (dataUrl: string) => {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(t("sign-pdf.the.signature.could.not.be.turned.try.1d434d")));
    image.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.height;
  canvas.height = image.width;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(t("sign-pdf.the.signature.could.not.be.turned.try.1d434d"));
  context.translate(canvas.width, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(image, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png'), aspectRatio: canvas.width / canvas.height };
};

const typedSignatureImage = (text: string, color: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 280;
  const context = canvas.getContext('2d');
  if (!context) return '';
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = 'italic 118px "Cormorant Garamond", Georgia, serif';
  context.fillStyle = color;
  context.textBaseline = 'middle';
  context.fillText(text.trim(), 36, canvas.height / 2, canvas.width - 72);
  return canvas.toDataURL('image/png');
};

const SignatureOverlay: React.FC<{
  item: SignatureItem;
  containerRef: React.RefObject<HTMLDivElement | null>;
  isSelected: boolean;
  onSelect: () => void;
  onUpdate: (id: string, updates: Partial<SignatureItem>) => void;
  onDelete: (id: string) => void;
}> = ({ item, containerRef, isSelected, onSelect, onUpdate, onDelete }) => {
  useI18n();
  const [editing, setEditing] = useState(false);
  const modeRef = useRef<EditMode>(null);
  const originRef = useRef({
    pointerId: -1,
    clientX: 0,
    clientY: 0,
    x: item.x,
    y: item.y,
    width: item.width,
    aspectRatio: item.aspectRatio,
  });

  const startEdit = (event: React.PointerEvent, mode: Exclude<EditMode, null>) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    const point = getPoint(event);
    modeRef.current = mode;
    originRef.current = {
      pointerId: event.pointerId,
      clientX: point.x,
      clientY: point.y,
      x: item.x,
      y: item.y,
      width: item.width,
      aspectRatio: item.aspectRatio,
    };
    setEditing(true);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const rect = containerRef.current?.getBoundingClientRect();
    const pageAspect = rect && rect.height > 0 ? rect.width / rect.height : 1;
    const height = item.width * pageAspect / item.aspectRatio;
    const movement = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }[event.key];

    if (movement) {
      event.preventDefault();
      onSelect();
      onUpdate(item.localId, {
        x: clamp(item.x + movement.x, 0, 1 - item.width),
        y: clamp(item.y + movement.y, 0, 1 - height),
      });
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onDelete(item.localId);
    }
  };

  useEffect(() => {
    if (!editing) return;

    // The edit follows the finger that started it. A second finger is a pinch: the stamp goes back
    // to where it started and the edit ends (s4-03).
    const handleMove = (event: PointerEvent) => {
      if (!containerRef.current || !modeRef.current || event.pointerId !== originRef.current.pointerId) return;
      const point = getPoint(event);
      const dx = point.x - originRef.current.clientX;
      const dy = point.y - originRef.current.clientY;
      const rect = containerRef.current.getBoundingClientRect();

      if (modeRef.current === 'drag') {
        const nextX = clamp(originRef.current.x + dx / rect.width, 0, 1 - originRef.current.width);
        const nextY = clamp(
          originRef.current.y + dy / rect.height,
          0,
          1 - originRef.current.width * rect.width / (originRef.current.aspectRatio * rect.height),
        );
        onUpdate(item.localId, { x: nextX, y: nextY });
      } else if (modeRef.current === 'resize') {
        const rawWidth = originRef.current.width + dx / rect.width;
        const maxWidthByX = 1 - originRef.current.x;
        const maxWidthByY = (1 - originRef.current.y) * originRef.current.aspectRatio * rect.height / rect.width;
        const maxWidth = Math.min(1, maxWidthByX, maxWidthByY);
        const minWidth = Math.min(0.1, originRef.current.width, maxWidth);
        const nextWidth = clamp(rawWidth, minWidth, maxWidth);
        onUpdate(item.localId, { width: nextWidth });
      }
    };

    const handleUp = (event: PointerEvent) => {
      if (event.pointerId !== originRef.current.pointerId) return;
      modeRef.current = null;
      setEditing(false);
    };

    const handleSecondFinger = (event: PointerEvent) => {
      if (!modeRef.current || event.pointerId === originRef.current.pointerId) return;
      const { x, y, width } = originRef.current;
      onUpdate(item.localId, { x, y, width });
      modeRef.current = null;
      setEditing(false);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointerdown', handleSecondFinger, true);

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointerdown', handleSecondFinger, true);
    };
  }, [containerRef, editing, item.localId, onUpdate]);

  const box = {
    left: `${item.x * 100}%`,
    top: `${item.y * 100}%`,
    width: `${item.width * 100}%`,
    aspectRatio: item.aspectRatio,
  } as React.CSSProperties;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={t("sign-pdf.signature.stamp.drag.to.move.use.arrow.90b646")}
        data-stamp-id={item.localId}
        className={`absolute z-20 cursor-move touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-500 ${isSelected ? 'ring-2 ring-ink-500' : 'ring-ink-400 hover:ring-1'}`}
        style={box}
        onPointerDown={(event) => startEdit(event, 'drag')}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <img src={item.dataUrl} alt="" aria-hidden className="pointer-events-none h-full w-full object-contain" />
      </div>
      {isSelected && (
        // The handles sit beside the stamp, not inside it, in a box of the same size. A finger tap
        // goes to the nearest button it touches, and Chrome passes over a tappable element that
        // holds another (its touch adjustment), so with the handles inside, a tap on the start of
        // the name went to Remove (round 6, gpt-terra-01).
        <div className="pointer-events-none absolute z-[21]" style={box} onClick={(event) => event.stopPropagation()}>
          {/* Remove at the top-left corner, Resize at the bottom-right: on a small stamp their 48 px
              targets no longer sit on top of each other (round 5, mobile-07). Remove's target sits
              wholly outside the corner and grows away from it when zoomed out. */}
          <button
            type="button"
            aria-label={t("sign-pdf.remove.signature.stamp.54e28c")}
            className="tk-sign-handle tk-sign-remove group pointer-events-auto absolute bottom-full right-full grid h-12 w-12 place-items-end focus-visible:outline-none"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(item.localId);
            }}
          >
            <span className="grid h-7 w-7 place-items-center rounded-full bg-danger-600 text-paper-25 shadow group-focus-visible:ring-2 group-focus-visible:ring-danger-500 group-focus-visible:ring-offset-2">
              <X aria-hidden size={14} />
            </span>
          </button>
          <button
            type="button"
            aria-label={t("sign-pdf.resize.signature.stamp.b617b6")}
            className="tk-sign-handle pointer-events-auto absolute -bottom-6 -right-6 grid h-12 w-12 touch-none place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-500"
            onPointerDown={(event) => startEdit(event, 'resize')}
          >
            <span className="grid h-7 w-7 place-items-center rounded-full bg-ink-600 text-paper-25 shadow">
              <Expand aria-hidden size={14} />
            </span>
          </button>
        </div>
      )}
    </>
  );
};

const PDFPageCanvas: React.FC<{
  pdfDoc: any;
  pageIndex: number;
  zoom: number;
  signatures: SignatureItem[];
  selectedSignatureId: string | null;
  onSelectSignature: (id: string) => void;
  onUpdateSignature: (id: string, updates: Partial<SignatureItem>) => void;
  onDeleteSignature: (id: string) => void;
  onBackgroundClick: () => void;
}> = ({
  pdfDoc,
  pageIndex,
  zoom,
  signatures,
  selectedSignatureId,
  onSelectSignature,
  onUpdateSignature,
  onDeleteSignature,
  onBackgroundClick,
}) => {
  useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 600, height: 850 });

  useEffect(() => {
    setRendered(false);
  }, [pageIndex]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: '500px' },
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const render = async () => {
      if (!visible || rendered || !canvasRef.current || !pdfDoc) return;
      const page = await pdfDoc.getPage(pageIndex + 1);
      const scale = getPdfRenderScale(page);
      const viewport = page.getViewport({ scale });
      setDimensions({ width: viewport.width / scale, height: viewport.height / scale });

      // The page may have been replaced (a new file dropped) while getPage ran (B-034).
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d');
      if (!context) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      try {
        await page.render({ canvasContext: context, viewport }).promise;
      } finally {
        // The canvas holds the drawn page; the decoded images PDF.js kept to draw it can go.
        try {
          page.cleanup();
        } catch {
          // A page with nothing cached is already where this wants it.
        }
      }
      setRendered(true);
    };
    void render();
  }, [pageIndex, pdfDoc, rendered, visible]);

  return (
    <div
      className="relative mb-3 bg-white shadow-[var(--elevation-panel)]"
      style={{ width: dimensions.width * zoom, height: dimensions.height * zoom }}
    >
      <div
        ref={containerRef}
        dir="ltr"
        className="relative origin-top-left bg-white"
        // The handles read --sign-zoom to stay 48 px on screen when the page is drawn smaller (B-027).
        style={{ width: dimensions.width, height: dimensions.height, transform: `scale(${zoom})`, ['--sign-zoom' as string]: zoom } as React.CSSProperties}
        onClick={onBackgroundClick}
      >
        {!rendered && (
          <div className="absolute inset-0 flex items-center justify-center bg-paper-100 text-paper-600">
            <Loader2 className="animate-spin" />
          </div>
        )}
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
        <SharpPageLayer source={{ pdfDoc }} pageIndex={pageIndex} zoom={zoom} />
        {signatures.map((signature) => (
          <SignatureOverlay
            key={signature.localId}
            item={signature}
            containerRef={containerRef}
            isSelected={selectedSignatureId === signature.localId}
            onSelect={() => onSelectSignature(signature.localId)}
            onUpdate={onUpdateSignature}
            onDelete={onDeleteSignature}
          />
        ))}
      </div>
    </div>
  );
};

export const SignPDF: React.FC = () => {
  useI18n();
  const wide = useWide();
  const dropBusy = useRef(false);
  const [file, setFile] = useState<PDFFile | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [signatures, setSignatures] = useState<SignatureItem[]>([]);
  const [savedSignatures, setSavedSignatures] = useState<SignatureItem[] | null>(null);
  const unsavedStamps = signatures.length > 0 && signatures !== savedSignatures;
  // Back, a link and "Choose another PDF" ask before placed stamps that were not exported are lost.
  const discardPrompt = useDiscardPrompt();
  useLeaveGuarded(unsavedStamps, discardPrompt.ask);
  const discardSheet = discardPrompt.sheet;
  // The placed signatures are the input of the result strip's file (workSignature.ts).
  useWorkInput(signatures);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [mobilePanel, setMobilePanel] = useState<'document' | 'stamps'>('document');

  const [showModal, setShowModal] = useState(false);

  const addSignatureRef = useRef<HTMLButtonElement>(null);

  const signatureDialogRef = useRef<HTMLDivElement>(null);
  const [signatureMode, setSignatureMode] = useState<'draw' | 'type' | 'upload'>('draw');
  const [inkColor, setInkColor] = useState('#111827');
  const [typedSignature, setTypedSignature] = useState('');
  const [uploadedSignatureSource, setUploadedSignatureSource] = useState<File | null>(null);
  const [uploadedSignature, setUploadedSignature] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [transparentUpload, setTransparentUpload] = useState(true);
  const [isPreparingUpload, setIsPreparingUpload] = useState(false);
  const [hasDrawnSignature, setHasDrawnSignature] = useState(false);
  const signatureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  // The drawing as it was when Draw was left (Type, Upload) or the pad was resized: drawn back
  // when Draw shows again, so a look at another tab keeps it (fable C5).
  const drawnSnapshotRef = useRef('');
  const hasDrawnRef = useRef(false);
  hasDrawnRef.current = hasDrawnSignature;

  // The zoom is held relative to the view the file opened at (owner decision, path to 9): fitted
  // to the width on a phone, 100% on a wider screen. That view reads 100%, as fit width does in the
  // other viewers (fable-2 item 15), and Reset returns to it. Its name is "Fit page" on every
  // screen (owner decision 2026-11-15). `zoom` is the page's drawn scale.
  const { zoom: view, zoomIn, zoomOut, setExactZoom } = useZoom(1, 0.5, MAX_ZOOM);
  const [startZoom, setStartZoom] = useState(1);
  const startZoomRef = useRef(1);
  const zoom = view * startZoom;
  const resetZoom = useCallback(() => setExactZoom(1), [setExactZoom]);
  const setPdfZoomViewport = usePdfPinchZoom({ zoom: view, setZoom: setExactZoom, max: MAX_ZOOM });
  // The page view is measured so the start zoom shows the whole page width at every size (final
  // fix, item 11: on a 768–834 px portrait tablet 100% cut the page off). It is measured again
  // whenever the page view changes size (a turned phone, a narrower window; fix round 2, item 9),
  // so Reset always lands on the fitted view, and every zoom keeps its share of the new fit.
  const zoomViewportRef = useRef<HTMLDivElement | null>(null);
  const firstPageWidthRef = useRef<number | null>(null);
  const fitToViewport = useCallback(() => {
    const width = firstPageWidthRef.current;
    const viewport = zoomViewportRef.current;
    if (!width || !viewport || !viewport.getClientRects().length) return;
    const style = window.getComputedStyle(viewport);
    const room = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2;
    if (room <= 0) return;
    const start = Math.max(0.5, Math.min(2, Math.min(1, room / width)));
    if (Math.abs(start - startZoomRef.current) < 0.001) return;
    startZoomRef.current = start;
    setStartZoom(start);
  }, []);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const setZoomViewport = useCallback((node: HTMLDivElement | null) => {
    zoomViewportRef.current = node;
    setPdfZoomViewport(node);
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (node && typeof ResizeObserver !== 'undefined') {
      resizeObserverRef.current = new ResizeObserver(() => fitToViewport());
      resizeObserverRef.current.observe(node);
    }
  }, [setPdfZoomViewport, fitToViewport]);
  useLayoutEffect(() => { if (pdfDoc) fitToViewport(); }, [pdfDoc, fitToViewport]);

  const pageCount = pdfDoc?.numPages || 0;
  // A page change is said to a screen reader (research r4, desktop-04).
  const [announcer, announce] = useAnnouncer();
  const announcedPage = useRef<number | null>(null);
  useEffect(() => {
    if (pageCount < 2) return;
    if (announcedPage.current !== null && announcedPage.current !== currentPageIndex) {
      announce(t("sign-pdf.message.61ebc290b6", { v0: currentPageIndex + 1, v1: pageCount }));
    }
    announcedPage.current = currentPageIndex;
  }, [announce, pageCount, currentPageIndex]);
  const selectedSignature = signatures.find((signature) => signature.localId === selectedSignatureId) || null;
  const pageSignatures = useMemo(
    () => signatures.filter((signature) => signature.pageIndex === currentPageIndex),
    [currentPageIndex, signatures],
  );

  useEffect(() => {
    if (!selectedSignatureId) return;
    if (!signatures.some((signature) => signature.localId === selectedSignatureId)) {
      setSelectedSignatureId(null);
    }
  }, [selectedSignatureId, signatures]);

  useEffect(() => {
    return () => {
      if (pdfDoc?.destroy) void pdfDoc.destroy();
    };
  }, [pdfDoc]);

  useEffect(() => {
    let cancelled = false;

    if (!uploadedSignatureSource) {
      setUploadedSignature('');
      setIsPreparingUpload(false);
      return undefined;
    }

    setIsPreparingUpload(true);

    // Always the shrunk, re-encoded copy: never the picked file, whichever way the toggle is set.
    void createSignatureStamp(uploadedSignatureSource, transparentUpload)
      .then((nextSignature) => {
        if (!cancelled) {
          setUploadedSignature(nextSignature);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUploadedSignature('');
          setUploadError(t("sign-pdf.this.signature.picture.could.not.be.read.43b251"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsPreparingUpload(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [transparentUpload, uploadedSignatureSource]);

  const selectSignature = (id: string | null) => {
    setSelectedSignatureId(id);
    if (!id) return;
    const target = signatures.find((signature) => signature.localId === id);
    if (target) setCurrentPageIndex(target.pageIndex);
  };

  // A stamp that was just added, or picked in the list, is scrolled into view: zoomed in, the
  // middle of the page where a stamp starts can be below the screen (round 6, desktop-03).
  const revealStampRef = useRef<string | null>(null);
  useEffect(() => {
    const id = revealStampRef.current;
    if (!id || id !== selectedSignatureId) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const stamp = document.querySelector<HTMLElement>(`[data-stamp-id="${id}"]`);
      if (!stamp) return;
      revealStampRef.current = null;
      stamp.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedSignatureId, signatures, currentPageIndex]);

  const updateSignature = (id: string, updates: Partial<SignatureItem>) => {
    setSignatures((previous) =>
      previous.map((signature) =>
        signature.localId === id
          ? {
              ...signature,
              ...updates,
            }
          : signature,
      ),
    );
  };

  const deleteSignature = (id: string) => {
    setSignatures((previous) => previous.filter((signature) => signature.localId !== id));
    announce(t('sign-pdf.stamp.removed'));
    if (selectedSignatureId === id) setSelectedSignatureId(null);
  };

  const jumpToPage = (nextIndex: number) => {
    if (!pageCount) return;
    setCurrentPageIndex(clamp(nextIndex, 0, pageCount - 1));
  };

  const updateSelectedSignaturePage = (nextIndex: number) => {
    if (!selectedSignature) return;
    const clampedIndex = clamp(nextIndex, 0, Math.max(0, pageCount - 1));
    updateSignature(selectedSignature.localId, { pageIndex: clampedIndex });
    setCurrentPageIndex(clampedIndex);
  };

  // The signature dialog is a real modal: focus moves in, Tab stays inside,
  // Escape closes it, and focus returns to the control that opened it.
  useEffect(() => {
    if (!showModal) return undefined;
    const opener = addSignatureRef.current;
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, canvas, [tabindex]:not([tabindex="-1"])';
    const focusables = (): HTMLElement[] =>
      signatureDialogRef.current ? Array.from(signatureDialogRef.current.querySelectorAll<HTMLElement>(selector)) : [];
    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowModal(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [showModal]);

  const handleFilesSelected = async (files: File[]) => {
    if (!files.length || !isPdfFile(files[0])) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("sign-pdf.choose.a.pdf.file.to.sign.7aad65") });
      return false;
    }
    const selected = files[0];
    setStatus({ isProcessing: true, progress: 5, message: t("sign-pdf.opening.pdf.3b7ab1") });

    try {
      const doc = await loadPDFDocument(selected);
      const firstWidth = (await doc.getPage(1)).getViewport({ scale: 1 }).width;
      firstPageWidthRef.current = firstWidth;
      setFile({ id: uuidv4(), file: selected, name: selected.name, size: selected.size });
      setPdfDoc(doc);
      // Images dropped before choosing a document are waiting for its first page.
      if (file) setSignatures([]);
      setSelectedSignatureId(null);
      setCurrentPageIndex(0);
      setMobilePanel('document');
      // Phones open the page fitted to the width (T-02), not at a fixed 50%. The page view's own
      // width replaces this estimate once it is drawn (the effect below).
      let start = 1;
      if (!window.matchMedia(MQ_LG).matches) {
        start = Math.min(1, (window.innerWidth - 24) / firstWidth);
      }
      // Never drawn below half size.
      start = Math.max(0.5, Math.min(2, start));
      startZoomRef.current = start;
      setStartZoom(start);
      setExactZoom(1);
      setStatus({ isProcessing: false, progress: 0, message: '' });
      return true;
    } catch (error) {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: pdfProblemMessage(error) ?? t("sign-pdf.unable.to.open.this.pdf.unlock.password.2ed9cf"),
      });
      return false;
    }
  };

  const addSignature = async (dataUrl: string, pageIndex = currentPageIndex) => {
    const nextSignature: SignatureItem = {
      localId: uuidv4(),
      id: uuidv4(),
      pageIndex,
      dataUrl,
      x: 0.35,
      y: 0.45,
      width: 0.28,
      aspectRatio: 2,
    };

    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(t("sign-pdf.unable.to.use.this.signature.image.148751")));
        image.src = dataUrl;
      });
      nextSignature.aspectRatio = image.width / Math.max(1, image.height);
      // A new stamp never lands exactly on an earlier one on the same page (round 5, mobile-06):
      // it steps down and to the right until the spot is free.
      setSignatures((previous) => {
        const taken = (x: number, y: number) => previous.some((item) => item.pageIndex === pageIndex
          && Math.abs(item.x - x) < 0.02 && Math.abs(item.y - y) < 0.02);
        for (let step = 0; step < 6 && taken(nextSignature.x, nextSignature.y); step += 1) {
          nextSignature.x = Math.min(nextSignature.x + 0.04, 1 - nextSignature.width);
          nextSignature.y += 0.04;
        }
        return [...previous, nextSignature];
      });
      revealStampRef.current = nextSignature.localId;
      setSelectedSignatureId(nextSignature.localId);
      setMobilePanel('document');
    } catch {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("sign-pdf.unable.to.use.this.signature.image.148751") });
    }
  };

  useFileDrop({
    accept: '.pdf,application/pdf,image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg',
    priority: 10,
    onFiles: async function takeDrop(files: File[], asked = false): Promise<void> {
      if (dropBusy.current || status.isProcessing) return;
      // A new PDF replaces the document and its stamps: unsaved stamps ask first, as Choose another
      // file does (s4-01). Cancel keeps both; Discard takes the drop. Stamps dropped before any PDF
      // wait for it, so they do not ask.
      if (!asked && file && unsavedStamps && files.some(isPdfFile)) {
        discardPrompt.ask(() => { void takeDrop(files, true); });
        return;
      }
      dropBusy.current = true;
      try {
        const pdf = files.find(isPdfFile);
        if (pdf && !await handleFilesSelected([pdf])) return;
        if (pdf) setSavedSignatures(null);
        for (const image of files.filter((item) => !isPdfFile(item))) {
          // The same shrunk, upright, re-encoded copy the picker makes, for preview and export alike.
          const stamp = await createSignatureStamp(await shrinkSignatureImage(image), transparentUpload);
          await addSignature(stamp, pdf ? 0 : currentPageIndex);
        }
        setShowModal(false);
      } catch (error) {
        setStatus({ isProcessing: false, progress: 0, message: '', error: signaturePictureError(error) });
      } finally {
        dropBusy.current = false;
      }
    },
  });

  // The header's "change the file" control, named as in Make Fillable (pass 5, item 9): Sign had
  // none, so the only way to another PDF was Tools and back.
  const chooseAnother = () => {
    const clear = () => {
      setFile(null);
      setPdfDoc(null);
      setSignatures([]);
      setSavedSignatures(null);
      setSelectedSignatureId(null);
      setCurrentPageIndex(0);
      setMobilePanel('document');
      setStatus({ isProcessing: false, progress: 0, message: '' });
    };
    if (unsavedStamps) discardPrompt.ask(clear);
    else clear();
  };

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: t("sign-pdf.applying.signatures.331407") });
    try {
      const bytes = await applySignaturesToPDF(file.file, signatures);
      const outputName = toolOutputName('sign', file.name, 'pdf');
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), outputName);
      setSavedSignatures(signatures);
      setStatus({ isProcessing: false, progress: 100, message: t("sign-pdf.signed.copy.ready.f2efbd", { v0: outputName }) });
    } catch {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("sign-pdf.the.signed.pdf.could.not.be.saved.0a4825") });
    }
  };

  const clearSignatureCanvas = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
    context.lineWidth = 2.6;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = inkColor;
    setHasDrawnSignature(false);
  };

  // Every opening starts on an empty Draw canvas (B-031): the resets run on their own, so a
  // dialog left in Type or Upload mode (no canvas mounted) still goes back to Draw.
  useEffect(() => {
    if (!showModal) return;
    setSignatureMode('draw');
    setTransparentUpload(true);
    setUploadedSignatureSource(null);
    setUploadedSignature('');
    setUploadError('');
    setTypedSignature('');
    drawnSnapshotRef.current = '';
  }, [showModal]);

  useEffect(() => {
    if (!showModal || signatureMode !== 'draw') return;
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let first = true;
    const initializeCanvas = () => {
      const keep = first ? drawnSnapshotRef.current : hasDrawnRef.current ? canvas.toDataURL('image/png') : '';
      first = false;
      drawnSnapshotRef.current = '';
      const dpr = window.devicePixelRatio || 1;
      const targetHeight = window.innerWidth < 640 ? 180 : 220;
      canvas.style.width = '100%';
      canvas.style.height = `${targetHeight}px`;

      const rect = canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, Math.floor(rect.width));
      const cssHeight = Math.max(1, Math.floor(rect.height));

      canvas.width = Math.floor(cssWidth * dpr);
      canvas.height = Math.floor(cssHeight * dpr);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.scale(dpr, dpr);
      clearSignatureCanvas();
      if (!keep) return;
      const image = new Image();
      image.onload = () => {
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(image, 0, 0);
        context.restore();
        setHasDrawnSignature(true);
      };
      image.src = keep;
    };

    const raf = window.requestAnimationFrame(initializeCanvas);
    window.addEventListener('resize', initializeCanvas);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', initializeCanvas);
      if (hasDrawnRef.current && !first) drawnSnapshotRef.current = canvas.toDataURL('image/png');
    };
  }, [showModal, signatureMode]);

  useEffect(() => {
    const context = signatureCanvasRef.current?.getContext('2d');
    if (context) context.strokeStyle = inkColor;
  }, [inkColor]);

  const getCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onDrawStart = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (signatureMode !== 'draw') return;
    event.preventDefault();
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    const point = getCanvasPoint(event);
    if (!context || !point) return;
    drawingRef.current = true;
    canvas.setPointerCapture(event.pointerId);
    context.beginPath();
    context.moveTo(point.x, point.y);
  };

  const onDrawMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || signatureMode !== 'draw') return;
    event.preventDefault();
    const context = signatureCanvasRef.current?.getContext('2d');
    const point = getCanvasPoint(event);
    if (!context || !point) return;
    context.lineTo(point.x, point.y);
    context.stroke();
    setHasDrawnSignature(true);
  };

  const onDrawEnd = (event?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    if (event && signatureCanvasRef.current?.hasPointerCapture(event.pointerId)) {
      signatureCanvasRef.current.releasePointerCapture(event.pointerId);
    }
    drawingRef.current = false;
  };

  const handleSignatureUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setUploadError('');
    setIsPreparingUpload(true);
    try {
      setUploadedSignatureSource(await shrinkSignatureImage(selected));
    } catch (error) {
      setUploadedSignatureSource(null);
      setUploadedSignature('');
      setIsPreparingUpload(false);
      setUploadError(signaturePictureError(error));
    }
  };

  const applySignatureFromModal = () => {
    const drawn = signatureCanvasRef.current?.toDataURL('image/png') || '';
    const selected = signatureMode === 'upload'
      ? uploadedSignature
      : signatureMode === 'type'
        ? typedSignatureImage(typedSignature, inkColor)
        : hasDrawnSignature ? drawn : '';
    if (!selected) return;
    addSignature(selected);
    setShowModal(false);
  };

  const rotateSelectedSignature = async () => {
    if (!selectedSignature || !pdfDoc) return;
    try {
      const [rotated, page] = await Promise.all([
        rotateSignatureImage(selectedSignature.dataUrl),
        pdfDoc.getPage(selectedSignature.pageIndex + 1),
      ]);
      const viewport = page.getViewport({ scale: 1 });
      const oldWidth = selectedSignature.width * viewport.width;
      const oldHeight = oldWidth / selectedSignature.aspectRatio;
      // A quarter turn swaps physical dimensions; keeping the old width would
      // enlarge a normal horizontal signature into a tall, clipped image.
      const fit = Math.min(1, viewport.width / oldHeight, viewport.height / oldWidth);
      const width = oldHeight * fit / viewport.width;
      const height = oldWidth * fit / viewport.height;
      const centerX = selectedSignature.x + selectedSignature.width / 2;
      const centerY = selectedSignature.y + oldHeight / viewport.height / 2;
      updateSignature(selectedSignature.localId, {
        ...rotated,
        width,
        x: clamp(centerX - width / 2, 0, 1 - width),
        y: clamp(centerY - height / 2, 0, 1 - height),
      });
    } catch {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("sign-pdf.the.signature.could.not.be.turned.try.1d434d") });
    }
  };

  const title = t("sign-pdf.sign.pdf.1bf93e");

  const addSignatureButton = (
      <button
        ref={addSignatureRef}
        type="button"
        onClick={() => setShowModal(true)}
        className="tk-btn chef-pressable"
      >
        <Plus aria-hidden size={18} />{t("sign-pdf.add.signature.5f9ca2")}</button>
  );
  const exportButton = (
      <button
        type="button"
        onClick={handleSave}
        disabled={status.isProcessing || signatures.length === 0}
        className="tk-primary tk-primary-inline chef-pressable"
      >
        {status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <Save aria-hidden size={18} />}{t("sign-pdf.export.366489")}</button>
  );
  const signButtons = <>{addSignatureButton}{exportButton}</>;
  const pager = (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => jumpToPage(currentPageIndex - 1)}
                    disabled={currentPageIndex <= 0}
                    aria-label={t("sign-pdf.previous.page.1208ec")}
                    className="chef-hit-y chef-pressable grid h-11 w-touch place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                  >
                    <ChevronLeft size={16} className="rtl:rotate-180" />
                  </button>
                  <div className="tabular rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-1 text-xs font-semibold text-[var(--text-body)]">{t("sign-pdf.message.61ebc290b6", { v0: currentPageIndex + 1, v1: Math.max(1, pageCount) })}</div>
                  <button
                    onClick={() => jumpToPage(currentPageIndex + 1)}
                    disabled={!pageCount || currentPageIndex >= pageCount - 1}
                    aria-label={t("sign-pdf.next.page.c08ac7")}
                    className="chef-hit-y chef-pressable grid h-11 w-touch place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                  >
                    <ChevronRight size={16} className="rtl:rotate-180" />
                  </button>
                </div>
  );
  const pageView = (
              <div
                ref={setZoomViewport}
                data-testid="pdf-zoom-viewport"
                data-pdf-zoom={zoom.toFixed(3)}
                className="chef-pdf-zoom-viewport custom-scrollbar flex-1 overflow-auto p-3 sm:p-6"
              >
                {pdfDoc ? (
                  <div className="flex flex-col items-center">
                    <PDFPageCanvas
                      key={currentPageIndex}
                      pdfDoc={pdfDoc}
                      pageIndex={currentPageIndex}
                      zoom={zoom}
                      signatures={pageSignatures}
                      selectedSignatureId={selectedSignatureId}
                      onSelectSignature={selectSignature}
                      onUpdateSignature={updateSignature}
                      onDeleteSignature={deleteSignature}
                      onBackgroundClick={() => selectSignature(null)}
                    />
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-[var(--text-secondary)]">
                    <Loader2 className="mr-2 animate-spin" />{t("sign-pdf.loading.pages.fdde04")}</div>
                )}
              </div>
  );
  const stampsPanel = (
            <aside className={`min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] ${wide || mobilePanel === 'stamps' ? 'flex' : 'hidden'}`}>
              <div className="border-b border-[var(--border-hairline)] px-3 py-2">
                <div className="text-sm font-semibold text-[var(--text-primary)]">{t("sign-pdf.signature.stamps.42bab6")}</div>
              </div>

              <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto p-3">
                {signatures.length === 0 ? (
                  <p className="type-footnote py-2 text-center text-[var(--text-secondary)]">{t("sign-pdf.no.stamps.yet.4a9062")}</p>
                ) : (
                  <div className="space-y-2">
                    {signatures.map((signature, index) => (
                      <button
                        key={signature.localId}
                        onClick={() => { revealStampRef.current = signature.localId; selectSignature(signature.localId); }}
                        className={`w-full rounded-xl border px-3 py-2 text-start ${
                          selectedSignatureId === signature.localId
                            ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
                            : 'border-[var(--border-strong)] text-[var(--text-body)] hover:border-[var(--accent-rest)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold">{t("sign-pdf.message.3da277c815", { v0: index + 1 })}</div>
                          <div className="text-xs opacity-70">{t("sign-pdf.message.c140ba4857", { v0: signature.pageIndex + 1 })}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {selectedSignature && (
                  <div className="space-y-2.5 rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] p-3">
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{t("sign-pdf.selected.stamp.e91765")}</div>

                    <div>
                      <label className="mb-1 block text-xs font-semibold text-[var(--text-secondary)]">{t("sign-pdf.page.0a30a8")}</label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label={t("sign-pdf.move.stamp.to.previous.page.dc0ebd")}
                          onClick={() => updateSelectedSignaturePage(selectedSignature.pageIndex - 1)}
                          disabled={selectedSignature.pageIndex <= 0}
                          className="chef-target chef-pressable grid shrink-0 place-items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] hover:border-[var(--accent-rest)] disabled:opacity-55"
                        >
                          <ChevronLeft aria-hidden size={18} className="rtl:rotate-180" />
                        </button>
                        <select
                          value={selectedSignature.pageIndex}
                          onChange={(event) => updateSelectedSignaturePage(Number(event.target.value))}
                          className="flex-1 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-rest)]"
                        >
                          {Array.from({ length: Math.max(1, pageCount) }, (_, index) => (
                            <option key={index} value={index}>{t("sign-pdf.message.c140ba4857", { v0: index + 1 })}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          aria-label={t("sign-pdf.move.stamp.to.next.page.ac969c")}
                          onClick={() => updateSelectedSignaturePage(selectedSignature.pageIndex + 1)}
                          disabled={!pageCount || selectedSignature.pageIndex >= pageCount - 1}
                          className="chef-target chef-pressable grid shrink-0 place-items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] hover:border-[var(--accent-rest)] disabled:opacity-55"
                        >
                          <ChevronRight aria-hidden size={18} className="rtl:rotate-180" />
                        </button>
                      </div>
                    </div>

                    <div>
                      {/* Whole percents: a dragged corner leaves any width, and "52.59 %"
                          is precision nobody asked for (r4 mobile-09). */}
                      <ChefSliderField
                        label={t("sign-pdf.stamp.width.b43467")}
                        suffix="%"
                        min={Math.min(10, Math.round(selectedSignature.width * 100))}
                        max={Math.max(80, Math.round(selectedSignature.width * 100))}
                        value={Math.round(selectedSignature.width * 100)}
                        onChange={(next) => updateSignature(selectedSignature.localId, { width: next / 100 })}
                        ariaLabel={t("sign-pdf.signature.width.d53c9c")}
                      />
                    </div>

                    <button
                      onClick={() => void rotateSelectedSignature()}
                      className="chef-pressable chef-hit-y flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--accent-quiet)] px-3 text-sm font-semibold text-[var(--accent-on-quiet)]"
                    >
                      <RotateCw aria-hidden size={18} />{t("sign-pdf.rotate.stamp.90.9d61f0")}</button>

                    <button
                      onClick={() => deleteSignature(selectedSignature.localId)}
                      className="chef-pressable chef-hit-y flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--status-danger-text)] px-3 text-sm font-semibold text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)]"
                    >
                      <Trash2 aria-hidden size={18} />{t("sign-pdf.remove.stamp.8c69ae")}</button>
                  </div>
                )}
              </div>

            </aside>
  );
  const workspace = !file ? (
    <div className="tk-empty">
      <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("sign-pdf.choose.a.pdf.to.sign.0d93e1")} />
      {signatures.length > 0 && <div className="mt-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] p-3">
        <p role="status">{t("sign-pdf.message.51b1112d1d", { count: signatures.length })}</p>
        <div className="mt-2 flex flex-wrap gap-2">{signatures.map((stamp, index) =>
          <img key={stamp.localId} src={stamp.dataUrl} alt={t("sign-pdf.pending.signature.stamp.275b7b", { v0: index + 1 })} className="h-16 max-w-40 object-contain" />,
        )}</div>
      </div>}
    </div>
  ) : wide ? (
    <div className="tk-editor tk-sign">
      {/* Desktop: the two actions sit at the page toolbar's end (B-029); the result strip keeps its row. */}
      <div className="tk-editor-bar">
        <ResultSlot className="tk-editor-result" />
      </div>
          <div className="grid min-h-0 flex-1 gap-2 md:grid-cols-[minmax(0,1fr)_320px]">
            <div className="relative flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)]">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-[var(--border-hairline)] bg-[var(--surface-raised)] px-3 py-2 sm:px-4">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => jumpToPage(currentPageIndex - 1)}
                    disabled={currentPageIndex <= 0}
                    aria-label={t("sign-pdf.previous.page.1208ec")}
                    className="chef-hit-y chef-pressable grid h-11 w-touch place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                  >
                    <ChevronLeft size={16} className="rtl:rotate-180" />
                  </button>
                  <div className="tabular rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-1 text-xs font-semibold text-[var(--text-body)]">{t("sign-pdf.message.61ebc290b6", { v0: currentPageIndex + 1, v1: Math.max(1, pageCount) })}</div>
                  <button
                    onClick={() => jumpToPage(currentPageIndex + 1)}
                    disabled={!pageCount || currentPageIndex >= pageCount - 1}
                    aria-label={t("sign-pdf.next.page.c08ac7")}
                    className="chef-hit-y chef-pressable grid h-11 w-touch place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                  >
                    <ChevronRight size={16} className="rtl:rotate-180" />
                  </button>
                </div>
                <ZoomControls
                  className="w-fit max-w-full"
                  zoom={view}
                  onZoomIn={zoomIn}
                  onZoomOut={zoomOut}
                  onReset={resetZoom}
                  max={MAX_ZOOM}
                  resetLabel={t('sign-pdf.fit.page')}
                />
                <div className="tk-sign-actions">{signButtons}</div>
              </div>
              {pageView}
            </div>
            {stampsPanel}
          </div>
    </div>
  ) : (
    // Phone (T-02): Document / Stamps as one segmented toolbar, the page fitted to the width with
    // its pager and zoom in one bar on the page, and Add signature and Export at the foot.
    <div className="tk-editor tk-sign tk-sign-phone">
      {/* First in the document so the actions come before the page, drawn at the foot (verify V-01). */}
      <div className="tk-footbar">
        <ResultSlot />
        <ActionRow>{addSignatureButton}{exportButton}</ActionRow>
      </div>
      <div className="tk-sign-toolbar">
        <SegmentedControl
          fit
          className="w-full"
          label={t("sign-pdf.sign.pdf.workspace.7eac1d")}
          value={mobilePanel}
          options={[
            { value: 'document', label: t("sign-pdf.document.d6bd8c") },
            { value: 'stamps', label: t("sign-pdf.stamps.18f974", { v0: signatures.length }) },
          ]}
          onChange={setMobilePanel}
        />
      </div>
      {mobilePanel === 'document' ? (
        <div className="tk-sign-doc">
          {pageView}
          {/* The page frame (T-13): zoom at the top end, outside the page at rest; the pager at the bottom centre. */}
          <ZoomControls className="tk-sign-zoom" zoom={view} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} max={MAX_ZOOM} resetLabel={t('sign-pdf.fit.page')} />
          <div className="tk-sign-pagebar">{pager}</div>
        </div>
      ) : stampsPanel}
    </div>
  );

  const modal = showModal && (
        <Portal>
        <div className="chef-safe-x fixed inset-0 z-[100] flex items-end justify-center bg-black/50 sm:items-center sm:p-4">
          <div
            role="dialog"
            aria-modal="true"
            ref={signatureDialogRef}
            aria-labelledby="create-signature-title"
            className="chef-scroller max-h-[calc(100dvh-env(safe-area-inset-top))] w-full max-w-2xl overflow-y-auto rounded-t-[var(--radius-sheet)] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[var(--elevation-sheet)] sm:max-h-[calc(100dvh-2rem)] sm:rounded-[var(--radius-sheet)] sm:p-5"
          >
            <h3 id="create-signature-title" className="mb-3 font-bold text-[var(--text-primary)]">{t("sign-pdf.create.signature.stamp.e32443")}</h3>

            <div className="mb-3">
              <SegmentedControl
                label={t("sign-pdf.signature.source.c6f4f2")}
                value={signatureMode}
                columns={3}
                options={[
                  { value: 'draw', label: t("sign-pdf.draw.61517c") },
                  { value: 'upload', label: t("sign-pdf.upload.865e89") },
                  { value: 'type', label: t("sign-pdf.type.baaddf") },
                ]}
                onChange={setSignatureMode}
              />
            </div>

            {signatureMode === 'draw' ? (
              <div className="mb-3">
                <canvas
                  ref={signatureCanvasRef}
                  onPointerDown={onDrawStart}
                  onPointerMove={onDrawMove}
                  onPointerUp={onDrawEnd}
                  onPointerLeave={onDrawEnd}
                  onPointerCancel={onDrawEnd}
                  className="h-[220px] w-full touch-none rounded-[var(--radius-field)] border border-[var(--border-strong)] bg-white"
                />
                <div className="mt-2 flex justify-end">
                  <label className="mr-auto inline-flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">{t("sign-pdf.ink.color.6ca8e0")}<input type="color" value={inkColor} onChange={(event) => setInkColor(event.target.value)} className="h-8 w-10 rounded border-0 bg-transparent" /></label>
                  <button
                    onClick={clearSignatureCanvas}
                    className="chef-hit-y rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)]"
                  >{t("sign-pdf.clear.83b12c")}</button>
                </div>
              </div>
            ) : signatureMode === 'type' ? (
              <div className="mb-3 space-y-2.5">
                <label className="block text-sm font-semibold text-[var(--text-secondary)]">{t("sign-pdf.signature.text.9e82cf")}<input value={typedSignature} onChange={(event) => setTypedSignature(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && typedSignature.trim()) { event.preventDefault(); void applySignatureFromModal(); } } /* Enter adds the stamp, as Add stamp does (round 6, desktop-11) */} placeholder={t("sign-pdf.your.name.2c6b2e")} className="chef-field mt-2 text-2xl italic" /></label>
                <label className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">{t("sign-pdf.ink.color.6ca8e0")}<input type="color" value={inkColor} onChange={(event) => setInkColor(event.target.value)} className="h-8 w-10 rounded border-0 bg-transparent" /></label>
                {typedSignature.trim() && <div className="rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-white p-3"><img src={typedSignatureImage(typedSignature, inkColor)} alt={t("sign-pdf.typed.signature.preview.450d64")} className="max-h-28" /></div>}
              </div>
            ) : (
              <div className="mb-3 space-y-2.5">
                <label className="chef-target block w-full cursor-pointer content-center rounded-[var(--radius-field)] border-2 border-dashed border-[var(--border-strong)] p-3 text-center text-sm text-[var(--text-secondary)] hover:border-[var(--accent-rest)]">{t("sign-pdf.choose.signature.image.070cdf")}<input type="file" accept="image/*" onChange={handleSignatureUpload} className="hidden" />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] px-3 py-2.5 text-sm text-[var(--text-secondary)]">
                  <span className="font-medium">{t("sign-pdf.transparent.background.0fcc9d")}</span>
                  <input
                    type="checkbox"
                    checked={transparentUpload}
                    onChange={(event) => setTransparentUpload(event.target.checked)}
                    className="h-5 w-5 rounded border-[var(--border-strong)]"
                  />
                </label>
                {uploadedSignature && (
                  <div
                    className="flex items-center justify-center rounded-[var(--radius-field)] border border-[var(--border-hairline)] p-3"
                    style={{
                      backgroundColor: '#f8fafc',
                      backgroundImage:
                        'linear-gradient(45deg, rgba(148,163,184,0.14) 25%, transparent 25%), linear-gradient(-45deg, rgba(148,163,184,0.14) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148,163,184,0.14) 75%), linear-gradient(-45deg, transparent 75%, rgba(148,163,184,0.14) 75%)',
                      backgroundSize: '18px 18px',
                      backgroundPosition: '0 0, 0 9px, 9px -9px, -9px 0px',
                    }}
                  >
                    <img src={uploadedSignature} alt={t("sign-pdf.uploaded.signature.6fe731")} className="max-h-28 object-contain" />
                  </div>
                )}
                {isPreparingUpload && (
                  <div className="flex items-center justify-center gap-2 text-sm text-[var(--text-secondary)]">
                    <Loader2 className="animate-spin" size={14} />{t("sign-pdf.preparing.transparent.preview.5149d8")}</div>
                )}
                {uploadError && !isPreparingUpload && (
                  <p role="alert" className="chef-filename text-sm font-medium text-[var(--status-danger-text)]">{uploadError}</p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowModal(false)} className="chef-target chef-pressable rounded-[var(--radius-control)] px-4 font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]">{t("sign-pdf.cancel.19766e")}</button>
              <button
                onClick={applySignatureFromModal}
                disabled={signatureMode === 'upload' ? !uploadedSignature || isPreparingUpload : signatureMode === 'type' ? !typedSignature.trim() : !hasDrawnSignature}
                className="chef-target chef-pressable rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 font-semibold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-55"
              >{t("sign-pdf.add.stamp.3f11eb")}</button>
            </div>
          </div>
        </div>
        </Portal>
  );

  return (
    <ToolScreen
      title={title}
      kind={file ? 'editor' : 'file'}
      file={file ? { name: file.name } : undefined}
      change={file ? <ChangeFile label={t('tool.chooseAnotherFile')} onClick={chooseAnother} disabled={status.isProcessing} /> : undefined}
      body={workspace}
      extra={(
        <>
          {modal}
          {discardSheet}
          {announcer}
        </>
      )}
      toast={<StatusToast status={status} />}
    />
  );
};
